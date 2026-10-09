// Direct-sync merge (no cloud). Both phones swap FULL snapshots and run the
// SAME merge rules, so they converge without either side silently winning.
//
// Per record, with `base` = what both sides agreed on last session:
// - only they changed it → take theirs
// - only I changed it → keep mine (my snapshot already carries it to them)
// - both changed it → conflict card, nothing overwritten
// - a resolution (bumped version) arrives → the higher version wins and the
//   conflict clears itself on both phones next session
import { coerceNumerics, sameContent, syncDb, SYNC_TABLES } from './sync';
import { nowIso } from './types';

export type Dump = Record<string, Record<string, unknown>[]>;

export async function buildDump(): Promise<Dump> {
  const dump: Dump = {};
  for (const t of SYNC_TABLES) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = ((await t.local().toArray()) as Record<string, unknown>[]).map((r) => ({ ...r }));
    // Propagate my deletions: a base entry with no local row becomes a
    // tombstone in my snapshot (unless it's already an unseen conflict).
    // Rows created AND deleted between sessions have no base and were never
    // seen by the peer — correctly omitted.
    const ids = new Set(rows.map((r) => r.id as string));
    const bases = await syncDb.base.where('key').startsWith(`${t.key}:`).toArray();
    for (const b of bases) {
      const id = b.key.slice(t.key.length + 1);
      if (ids.has(id)) continue;
      if (await syncDb.conflicts.get(b.key)) continue;
      rows.push({
        id, household_id: 'peer', version: b.version,
        updated_at: b.updated_at, deleted_at: b.deleted_at ?? nowIso(),
      });
    }
    dump[t.key] = rows;
  }
  return dump;
}

export interface MergeReport {
  applied: number;
  already: number;
  conflicts: number;
}

// Content compare ignoring bookkeeping (ids, versions, timestamps).
// Used to recognize resolutions: same human content at a newer version.
const META = new Set(['id', 'version', 'updated_at', 'updated_by', 'created_at', 'household_id', 'deleted_at']);
function contentSame(a: Record<string, unknown> | null, b: Record<string, unknown> | null): boolean {
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => !META.has(k)));
  for (const k of keys) {
    if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) return false;
  }
  return true;
}
export function decide(
  local: Record<string, unknown> | undefined,
  base: { version: number; updated_at: string; deleted_at?: string | null } | undefined,
  remote: Record<string, unknown>,
  conflict: { mine: Record<string, unknown> | null; theirs: Record<string, unknown> | null } | undefined,
): 'take-remote' | 'keep-local' | 'conflict' | 'adopt-new' {
  const rDeleted = (remote.deleted_at as string | null) != null;
  if (rDeleted) {
    if (!local) return 'adopt-new'; // record the tombstone snapshot
    if (!base) return 'conflict';
    if ((local.version as number) === base.version && (local.updated_at as string) === base.updated_at)
      return 'take-remote'; // we didn't touch it — accept the delete
    return 'conflict'; // we edited what they deleted
  }
  if (!local) {
    if (base && (base.deleted_at as string | null) != null) {
      // I deleted this (or accepted its delete). A peer version newer than
      // my tombstone means they explicitly kept/edited it after I deleted —
      // that needs my eyes, not a silent resurrection.
      if ((remote.version as number) > base.version)
        return 'conflict'; // stored as mine=null vs theirs=remote
      return 'adopt-new';
    }
    return 'take-remote';
  }
  if (!base) return sameContent(local, remote) ? 'adopt-new' : 'conflict';
  const unchanged =
    (local.version as number) === base.version && (local.updated_at as string) === base.updated_at;

  if (conflict) {
    // A stored conflict: only move on a real resolution, never silently.
    if (contentSame(remote, conflict.mine)) return 'take-remote'; // they yielded to us
    const tv = ((conflict.theirs?.version as number | undefined) ?? 0);
    if (conflict.theirs && contentSame(remote, conflict.theirs) && (remote.version as number) > tv)
      return 'take-remote'; // they resolved keep-theirs (bumped version)
    if (!unchanged) return 'conflict'; // I still differ — a human decides (refresh theirs)
    return 'take-remote'; // I'm pristine — their state flows in, stale conflict clears
  }

  if (unchanged) return 'take-remote'; // we didn't change it — take theirs
  // We changed it. Did they?
  if ((remote.version as number) === base.version && (remote.updated_at as string) === base.updated_at)
    return 'keep-local'; // peer unchanged — our snapshot carries ours to them
  return 'conflict';
}

export async function applyDump(dump: Dump): Promise<MergeReport> {
  const report: MergeReport = { applied: 0, already: 0, conflicts: 0 };
  for (const t of SYNC_TABLES) {
    const rows = (dump[t.key] ?? []).map((r) => coerceNumerics(r, t.numerics));
    for (const r of rows) {
      const id = r.id as string;
      const key = `${t.key}:${id}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const local = (await (t.local() as any).get(id)) as Record<string, unknown> | undefined;
      const base = await syncDb.base.get(key);
      const conflict = (await syncDb.conflicts.get(key)) ?? undefined;
      const action = decide(local, base ?? undefined, r, conflict ?? undefined);

      if (action === 'keep-local') {
        report.already++;
        // Refresh a stored conflict's "theirs" if the peer moved on.
        if (conflict && conflict.theirs && !sameContent(r, conflict.theirs)) {
          // peer sent something newer but we still differ → keep conflict, refresh theirs
          await syncDb.conflicts.put({ ...conflict, theirs: r, at: nowIso() });
        }
        continue;
      }
      if (action === 'adopt-new') {
        await syncDb.base.put({
          key,
          version: (local?.version as number) ?? (r.version as number),
          updated_at: (local?.updated_at as string) ?? (r.updated_at as string),
          deleted_at: (r.deleted_at as string | null) ?? null,
        });
        report.already++;
        continue;
      }
      if (action === 'take-remote') {
        if ((r.deleted_at as string | null) != null) {
          if (local) await t.local().delete(id);
        } else {
          await t.local().put(r);
        }
        // A resolution or plain update clears any stored conflict.
        if (conflict) await syncDb.conflicts.delete(key);
        await syncDb.base.put({
          key, version: r.version as number,
          updated_at: r.updated_at as string, deleted_at: (r.deleted_at as string | null) ?? null,
        });
        report.applied++;
        continue;
      }
      // conflict — store both sides, touch nothing
      await syncDb.conflicts.put({
        key, table: t.key, recordId: id,
        mine: local ?? null, theirs: (r.deleted_at as string | null) != null ? null : r,
        at: nowIso(),
      });
      report.conflicts++;
    }
  }
  localStorage.setItem('fm.lastSync', new Date().toISOString());
  return report;
}

// Resolving here bumps the version so the OTHER phone adopts it next session
// (higher version wins over a stored conflict — see decide()).
export async function resolvePeerKeepMine(key: string): Promise<void> {
  const c = await syncDb.conflicts.get(key);
  if (!c) return;
  const t = SYNC_TABLES.find((x) => x.key === c.table);
  if (!t) return;
  if (c.mine == null) {
    // We deleted: record a local tombstone. Tombstones need a row to ride
    // on, so stash one in the conflict-free base as deleted.
    await syncDb.base.put({
      key, version: ((c.theirs?.version as number | undefined) ?? 0) + 1,
      updated_at: nowIso(), deleted_at: nowIso(),
    });
  } else {
    const row = { ...c.mine, version: ((c.mine.version as number) ?? 0) + 1, updated_at: nowIso(), deleted_at: null };
    await t.local().put(row);
  }
  await syncDb.conflicts.delete(key);
  localStorage.setItem('fm.lastSync', new Date().toISOString());
}

export async function resolvePeerKeepTheirs(key: string): Promise<void> {
  const c = await syncDb.conflicts.get(key);
  if (!c) return;
  const t = SYNC_TABLES.find((x) => x.key === c.table);
  if (!t) return;
  if (c.theirs == null) {
    if (c.mine) await t.local().delete(c.recordId);
    await syncDb.base.delete(key);
  } else {
    await t.local().put(c.theirs);
    await syncDb.base.put({
      key, version: c.theirs.version as number,
      updated_at: c.theirs.updated_at as string, deleted_at: null,
    });
  }
  await syncDb.conflicts.delete(key);
  localStorage.setItem('fm.lastSync', new Date().toISOString());
}
