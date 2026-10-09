// Backup, export, restore (SPEC section 15).
// JSON backup = full-fidelity restore source (everything links preserved).
// CSV = spreadsheet-friendly, human-readable, NOT a full restore source
// (images and meal<->recipe links flatten to names).
// Rule: import MERGES by id — it never deletes what is already on the phone.
import { db } from './db';

export const BACKUP_VERSION = 1;

export interface Backup {
  app: 'family-meals';
  version: number;
  exportedAt: string;
  recipes: unknown[];
  recipeIngredients: unknown[];
  recipeSteps: unknown[];
  plannedMeals: unknown[];
  groceryLists: unknown[];
  groceryItems: unknown[];
  pantry: unknown[];
  spending: unknown[];
  prices: unknown[];
  budgets: unknown[];
}

const TABLES = [
  'recipes', 'recipeIngredients', 'recipeSteps', 'plannedMeals',
  'groceryLists', 'groceryItems', 'pantry', 'spending', 'prices', 'budgets',
] as const;

export async function buildBackup(): Promise<Backup> {
  const [recipes, recipeIngredients, recipeSteps, plannedMeals, groceryLists,
    groceryItems, pantry, spending, prices, budgets] = await Promise.all([
    db.recipes.toArray(), db.recipeIngredients.toArray(), db.recipeSteps.toArray(),
    db.plannedMeals.toArray(), db.groceryLists.toArray(), db.groceryItems.toArray(),
    db.pantry.toArray(), db.spending.toArray(), db.prices.toArray(), db.budgets.toArray(),
  ]);
  return {
    app: 'family-meals', version: BACKUP_VERSION, exportedAt: new Date().toISOString(),
    recipes, recipeIngredients, recipeSteps, plannedMeals, groceryLists,
    groceryItems, pantry, spending, prices, budgets,
  };
}

export function validateBackup(b: unknown): { ok: true; data: Backup } | { ok: false; error: string } {
  if (typeof b !== 'object' || b === null) return { ok: false, error: 'Not a backup file.' };
  const o = b as Record<string, unknown>;
  if (o.app !== 'family-meals') return { ok: false, error: 'This file is not a Family Meals backup.' };
  if (typeof o.version !== 'number' || o.version > BACKUP_VERSION)
    return { ok: false, error: `Backup version ${String(o.version)} is newer than this app understands.` };
  for (const t of TABLES) {
    if (!Array.isArray(o[t])) return { ok: false, error: `Backup is missing “${t}”.` };
  }
  return { ok: true, data: o as unknown as Backup };
}

export interface ImportReport { added: Record<string, number>; skipped: Record<string, number> }

// Merge: inserts rows whose id is new, skips rows already present.
export async function importBackup(data: Backup): Promise<ImportReport> {
  const added: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  await db.transaction(
    'rw',
    [db.recipes, db.recipeIngredients, db.recipeSteps, db.plannedMeals,
      db.groceryLists, db.groceryItems, db.pantry, db.spending, db.prices, db.budgets],
    async () => {
      const pairs: [keyof Backup & string, { get: (id: string) => Promise<unknown>; add: (o: never) => Promise<unknown> }][] = [
        ['recipes', db.recipes as never], ['recipeIngredients', db.recipeIngredients as never],
        ['recipeSteps', db.recipeSteps as never], ['plannedMeals', db.plannedMeals as never],
        ['groceryLists', db.groceryLists as never], ['groceryItems', db.groceryItems as never],
        ['pantry', db.pantry as never], ['spending', db.spending as never],
        ['prices', db.prices as never], ['budgets', db.budgets as never],
      ];
      for (const [key, table] of pairs) {
        const rows = (data[key] ?? []) as { id: string }[];
        added[key] = 0;
        skipped[key] = 0;
        for (const row of rows) {
          if (!row || typeof row.id !== 'string') {
            skipped[key]++;
            continue;
          }
          const exists = await (table.get as (id: string) => Promise<unknown>)(row.id);
          if (exists) {
            skipped[key]++;
          } else {
            await (table.add as (o: never) => Promise<unknown>)(row as never);
            added[key]++;
          }
        }
      }
    },
  );
  return { added, skipped };
}

export async function eraseAllLocal(): Promise<void> {
  await db.transaction(
    'rw',
    [db.recipes, db.recipeIngredients, db.recipeSteps, db.plannedMeals,
      db.groceryLists, db.groceryItems, db.pantry, db.spending, db.prices, db.budgets],
    async () => {
      await Promise.all([
        db.recipes.clear(), db.recipeIngredients.clear(), db.recipeSteps.clear(),
        db.plannedMeals.clear(), db.groceryLists.clear(), db.groceryItems.clear(),
        db.pantry.clear(), db.spending.clear(), db.prices.clear(), db.budgets.clear(),
      ]);
    },
  );
}

// ---------- CSV (human-readable, not full-fidelity) ----------

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

export function spendingCsv(records: { date: string; store: string | null; amount_cents: number; kind: string; memo: string | null }[]): string {
  return toCsv(
    ['date', 'store', 'amount_usd', 'kind', 'memo'],
    records.map((r) => [r.date, r.store ?? '', (r.amount_cents / 100).toFixed(2), r.kind, r.memo ?? '']),
  );
}

export function recipesCsv(rows: {
  name: string; servings_original: number; tags: string[];
  ingredients: { name_raw: string; qty_amount: number | null; unit_raw: string | null }[];
  steps: { text: string }[]; source_url: string | null;
}[]): string {
  return toCsv(
    ['name', 'servings', 'tags', 'ingredients', 'steps', 'source_url'],
    rows.map((r) => [
      r.name,
      r.servings_original,
      r.tags.join('; '),
      r.ingredients.map((i) => `${i.qty_amount ?? ''} ${i.unit_raw ?? ''} ${i.name_raw}`.trim()).join(' | '),
      r.steps.map((s, k) => `${k + 1}. ${s.text}`).join(' | '),
      r.source_url ?? '',
    ]),
  );
}

export function planCsv(rows: { date: string; meal_type: string; title: string; servings: number; leftovers: boolean; notes: string }[]): string {
  return toCsv(
    ['date', 'meal', 'title', 'servings', 'leftovers', 'notes'],
    rows.map((r) => [r.date, r.meal_type, r.title, r.servings, r.leftovers ? 'yes' : 'no', r.notes]),
  );
}

// ---------- file download ----------

export function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
