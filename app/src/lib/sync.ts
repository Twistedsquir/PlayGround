// Two-way sync engine (SPEC sections 12–13).
// Plain language: each phone remembers what the cloud looked like last time
// (the "base snapshot"). A record is pushed only if the cloud hasn't changed
// since that snapshot; pulled only if this phone hasn't changed it. If BOTH
// changed, nobody wins silently — a conflict card is stored for you to pick.
//
// Retries are idempotent: every record has a stable id, so pushing twice
// never duplicates. Deletes travel as tombstones (deleted_at), so a delete
// on one phone doesn't resurrect from the other.
import Dexie, { type Table } from 'dexie';
import { db, LOCAL_HOUSEHOLD } from './db';
import { getSupabase } from './supabase';

// ---------- local bookkeeping ----------

interface BaseSnap {
  key: string; // "table:id"
  version: number;
  updated_at: string;
  deleted_at: string | null;
}

export interface Conflict {
  key: string; // "table:recordId"
  table: string;
  recordId: string;
  mine: Record<string, unknown> | null; // null = I deleted it
  theirs: Record<string, unknown> | null;
  at: string;
}

class SyncDb extends Dexie {
  base!: Table<BaseSnap, string>;
  conflicts!: Table<Conflict, string>;
  constructor() {
    super('family-meals-sync');
    this.version(1).stores({ base: 'key', conflicts: 'key' });
  }
}

export const syncDb = new SyncDb();

export function lastSyncAt(): string | null {
  return localStorage.getItem('fm.lastSync');
}

// ---------- table mapping (local Dexie -> Supabase) ----------

interface SyncTable {
  key: string;
  remote: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  local: () => Table<any, any>;
  numerics: string[]; // numeric columns PostgREST returns as strings
  householdField: boolean; // false only for recipe_steps (derived from parent)
}

const TABLES: SyncTable[] = [
  { key: 'recipes', remote: 'recipes', local: () => db.recipes, numerics: ['qty_amount', 'qty_min', 'qty_max'], householdField: true },
  { key: 'recipeIngredients', remote: 'recipe_ingredients', local: () => db.recipeIngredients, numerics: ['qty_amount', 'qty_min', 'qty_max'], householdField: true },
  { key: 'recipeSteps', remote: 'recipe_steps', local: () => db.recipeSteps, numerics: [], householdField: false },
  { key: 'plannedMeals', remote: 'planned_meals', local: () => db.plannedMeals, numerics: [], householdField: true },
  { key: 'groceryLists', remote: 'grocery_lists', local: () => db.groceryLists, numerics: [], householdField: true },
  { key: 'groceryItems', remote: 'grocery_items', local: () => db.groceryItems, numerics: ['qty_amount'], householdField: true },
  { key: 'pantry', remote: 'pantry_items', local: () => db.pantry, numerics: ['qty_on_hand', 'unit_cost_cents'], householdField: true },
  { key: 'spending', remote: 'spending_records', local: () => db.spending, numerics: ['amount_cents'], householdField: true },
  { key: 'prices', remote: 'price_estimates', local: () => db.prices, numerics: ['price_cents_per_unit'], householdField: true },
  { key: 'budgets', remote: 'budget_settings', local: () => db.budgets, numerics: ['amount_cents'], householdField: true },
];

function coerceNumerics(row: Record<string, unknown>, numerics: string[]): Record<string, unknown> {
  const out = { ...row };
  for (const f of numerics) {
    if (out[f] != null && typeof out[f] !== 'number') {
      const n = Number(out[f]);
      out[f] = Number.isFinite(n) ? n : null;
    }
  }
  return out;
}

// Compare the synced content of two rows (ignores bookkeeping drift).
export function sameContent(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (k === 'updated_by') continue;
    const va = a[k] ?? null;
    const vb = b[k] ?? null;
    if (JSON.stringify(va) !== JSON.stringify(vb)) return false;
  }
  return true;
}

function sameSnap(row: { version: number; updated_at: string }, base: BaseSnap): boolean {
  return row.version === base.version && row.updated_at === base.updated_at;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  conflicts: number;
  error: string | null;
}

// ---------- the sync ----------

export async function syncNow(householdId: string, userId: string | null): Promise<SyncResult> {
  const supabase = getSupabase();
  const res: SyncResult = { pushed: 0, pulled: 0, conflicts: 0, error: null };

  // Cache recipes' households for recipe_steps rows missing it.
  const recipes = (await db.recipes.toArray()) as unknown as Record<string, unknown>[];
  const recipeHouse = new Map(recipes.map((r) => [r.id as string, (r.household_id as string) ?? LOCAL_HOUSEHOLD]));

  for (const t of TABLES) {
    let remoteRows: Record<string, unknown>[];
    try {
      const { data, error } = await supabase.from(t.remote).select('*').eq('household_id', householdId);
      if (error) throw new Error(error.message);
      remoteRows = (data ?? []) as Record<string, unknown>[];
    } catch (e) {
      res.error = e instanceof Error ? `Could not reach the cloud (${t.remote}): ${e.message}` : 'Could not reach the cloud.';
      return res; // stop: never record a half-sync as success
    }
    const remoteById = new Map(remoteRows.map((r) => [r.id as string, coerceNumerics(r, t.numerics)]));

    // ---- PULL ----
    for (const raw of remoteById.values()) {
      const r = raw;
      const id = r.id as string;
      const base = await syncDb.base.get(`${t.key}:${id}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const local = (await (t.local() as Table<any, any>).get(id)) as Record<string, unknown> | undefined;

      if ((r.deleted_at as string | null) != null) {
        // Tombstone from the other phone.
        if (local) {
          const changed = !base || !sameSnap(local as { version: number; updated_at: string }, base);
          if (!changed) {
            await t.local().delete(id); // we didn't touch it — accept the delete
            res.pulled++;
          } else {
            // We edited it, they deleted it → conflict, keep ours pending.
            await syncDb.conflicts.put({
              key: `${t.key}:${id}`, table: t.key, recordId: id,
              mine: local, theirs: null, at: new Date().toISOString(),
            });
            res.conflicts++;
            continue;
          }
        }
        await syncDb.base.put({ key: `${t.key}:${id}`, version: r.version as number, updated_at: r.updated_at as string, deleted_at: r.deleted_at as string });
        continue;
      }

      if (!local) {
        await t.local().put(r);
        await syncDb.base.put({ key: `${t.key}:${id}`, version: r.version as number, updated_at: r.updated_at as string, deleted_at: null });
        res.pulled++;
      } else if (!base) {
        // Same id, never synced — adopt if identical, else conflict.
        if (sameContent(local, r)) {
          await syncDb.base.put({ key: `${t.key}:${id}`, version: r.version as number, updated_at: r.updated_at as string, deleted_at: null });
        } else {
          await syncDb.conflicts.put({
            key: `${t.key}:${id}`, table: t.key, recordId: id,
            mine: local, theirs: r, at: new Date().toISOString(),
          });
          res.conflicts++;
        }
      } else if (sameSnap(local as { version: number; updated_at: string }, base)) {
        await t.local().put(r); // we didn't change it — take theirs
        await syncDb.base.put({ key: `${t.key}:${id}`, version: r.version as number, updated_at: r.updated_at as string, deleted_at: null });
        res.pulled++;
      } else {
        // We changed it. Did they?
        if ((r.version as number) === base.version && (r.updated_at as string) === base.updated_at) {
          // No — push phase will send ours.
        } else {
          await syncDb.conflicts.put({
            key: `${t.key}:${id}`, table: t.key, recordId: id,
            mine: local, theirs: r, at: new Date().toISOString(),
          });
          res.conflicts++;
        }
      }
    }

    // ---- PUSH (re-read locals: pull may have updated them) ----
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const locals = (await t.local().toArray()) as Record<string, unknown>[];
    for (const L0 of locals) {
      const id = L0.id as string;
      // Skip rows already in conflict — the user decides those explicitly.
      if (await syncDb.conflicts.get(`${t.key}:${id}`)) continue;
      const base = await syncDb.base.get(`${t.key}:${id}`);
      if (base && sameSnap(L0 as { version: number; updated_at: string }, base)) continue; // unchanged

      const L: Record<string, unknown> = { ...L0 };
      // Fill household scope for local-only rows and derived step rows.
      if (!L.household_id || L.household_id === LOCAL_HOUSEHOLD) L.household_id = householdId;
      if (t.key === 'recipeSteps' && !L.household_id) {
        L.household_id = recipeHouse.get(L.recipe_id as string) ?? householdId;
      }
      if (userId) L.updated_by = userId;

      const remote = remoteById.get(id);
      try {
        if (!base && !remote) {
          const { error } = await supabase.from(t.remote).insert(L);
          if (error) throw new Error(error.message);
        } else if (!base && remote && !(remote.deleted_at as string | null)) {
          if (sameContent(L, remote)) {
            // converged independently — adopt snapshot
          } else {
            await syncDb.conflicts.put({
              key: `${t.key}:${id}`, table: t.key, recordId: id,
              mine: L, theirs: remote, at: new Date().toISOString(),
            });
            res.conflicts++;
            continue;
          }
        } else if (!remote || (remote.deleted_at as string | null) != null) {
          if (base && remote && (remote.deleted_at as string | null) != null &&
              ((remote.version as number) !== base.version || (remote.updated_at as string) !== base.updated_at)) {
            // They deleted, we edited → conflict (already stored in pull). Skip.
            continue;
          }
          const { error } = await supabase.from(t.remote).upsert(L);
          if (error) throw new Error(error.message);
        } else if ((remote.version as number) === base!.version && (remote.updated_at as string) === base!.updated_at) {
          const { error } = await supabase.from(t.remote).update(L).eq('id', id);
          if (error) throw new Error(error.message);
        } else {
          // Remote moved since our base and we also changed it → conflict.
          await syncDb.conflicts.put({
            key: `${t.key}:${id}`, table: t.key, recordId: id,
            mine: L, theirs: remote, at: new Date().toISOString(),
          });
          res.conflicts++;
          continue;
        }
        res.pushed++;
        await t.local().put(L); // keep stamped household/updated_by
        await syncDb.base.put({
          key: `${t.key}:${id}`, version: L.version as number,
          updated_at: L.updated_at as string, deleted_at: (L.deleted_at as string | null) ?? null,
        });
      } catch (e) {
        res.error = e instanceof Error ? `Cloud rejected ${t.remote}: ${e.message}` : 'Cloud write failed.';
        return res;
      }
    }

    // ---- local deletes (in base, gone locally, alive remotely) ----
    const localIds = new Set(locals.map((l) => l.id as string));
    const bases = await syncDb.base.where('key').startsWith(`${t.key}:`).toArray();
    for (const b of bases) {
      const id = b.key.slice(t.key.length + 1);
      if (localIds.has(id)) continue;
      if (await syncDb.conflicts.get(b.key)) continue;
      const remote = remoteById.get(id);
      if (!remote || (remote.deleted_at as string | null) != null) {
        await syncDb.base.delete(b.key); // both gone — forget
        continue;
      }
      if ((remote.version as number) === b.version && (remote.updated_at as string) === b.updated_at) {
        // We deleted, they didn't touch → push tombstone.
        try {
          const { error } = await supabase.from(t.remote)
            .update({ deleted_at: new Date().toISOString(), version: b.version + 1, updated_by: userId })
            .eq('id', id);
          if (error) throw new Error(error.message);
          res.pushed++;
          await syncDb.base.delete(b.key);
        } catch (e) {
          res.error = e instanceof Error ? e.message : 'Cloud write failed.';
          return res;
        }
      }
      // Else: they edited after our base while we deleted → conflict already stored in pull.
    }
  }

  if (!res.error) localStorage.setItem('fm.lastSync', new Date().toISOString());
  return res;
}

// How many local changes are waiting to upload (for the status pill).
export async function pendingCount(): Promise<number> {
  let n = 0;
  for (const t of TABLES) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const locals = (await t.local().toArray()) as Record<string, unknown>[];
    for (const L of locals) {
      const base = await syncDb.base.get(`${t.key}:${L.id as string}`);
      if (!base) {
        n++;
      } else if (
        (L.version as number) !== base.version || (L.updated_at as string) !== base.updated_at
      ) {
        if (!(await syncDb.conflicts.get(`${t.key}:${L.id as string}`))) n++;
      }
    }
    const bases = await syncDb.base.where('key').startsWith(`${t.key}:`).toArray();
    const ids = new Set(locals.map((l) => l.id as string));
    for (const b of bases) {
      if (!ids.has(b.key.slice(t.key.length + 1)) && !(await syncDb.conflicts.get(b.key))) n++;
    }
  }
  return n;
}

// ---------- conflict resolution ----------

function tableOf(key: string): SyncTable {
  const t = TABLES.find((x) => x.key === key);
  if (!t) throw new Error(`Unknown table ${key}`);
  return t;
}

export async function resolveKeepMine(key: string, userId: string | null): Promise<void> {
  const c = await syncDb.conflicts.get(key);
  if (!c) return;
  const t = tableOf(c.table);
  const supabase = getSupabase();
  const hid = localStorage.getItem('fm.householdId');
  if (c.mine == null) {
    // We deleted: push tombstone.
    const { error } = await supabase.from(t.remote)
      .update({ deleted_at: new Date().toISOString(), updated_by: userId })
      .eq('id', c.recordId);
    if (error) throw new Error(error.message);
    await syncDb.base.delete(key);
  } else {
    const row = { ...c.mine, household_id: hid, updated_by: userId, updated_at: new Date().toISOString(), version: ((c.mine.version as number) ?? 1) + 1, deleted_at: null };
    const { error } = await supabase.from(t.remote).upsert(row);
    if (error) throw new Error(error.message);
    await t.local().put(coerceNumerics(row, t.numerics));
    await syncDb.base.put({ key, version: row.version as number, updated_at: row.updated_at as string, deleted_at: null });
  }
  await syncDb.conflicts.delete(key);
  localStorage.setItem('fm.lastSync', new Date().toISOString());
}

export async function resolveKeepTheirs(key: string): Promise<void> {
  const c = await syncDb.conflicts.get(key);
  if (!c) return;
  const t = tableOf(c.table);
  if (c.theirs == null || (c.theirs.deleted_at as string | null) != null) {
    await t.local().delete(c.recordId); // accept the delete
    await syncDb.base.delete(key);
  } else {
    await t.local().put(coerceNumerics(c.theirs, t.numerics));
    await syncDb.base.put({
      key, version: c.theirs.version as number,
      updated_at: c.theirs.updated_at as string, deleted_at: null,
    });
  }
  await syncDb.conflicts.delete(key);
  localStorage.setItem('fm.lastSync', new Date().toISOString());
}
