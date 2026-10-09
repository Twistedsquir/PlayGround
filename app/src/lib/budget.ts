// Budget math (SPEC section 10). Money in integer cents.
// Golden rule: estimated costs and actual spending are separate worlds.
// A trip total and item prices for the same list are NEVER added together.
import { db, LOCAL_HOUSEHOLD } from './db';
import { startOfWeekSunday, todayISO } from './meals';
import { newId, nowIso, type GroceryItem, type PriceEstimate, type SpendingRecord } from './types';

const WEIGHT_G: Record<string, number> = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };
const VOLUME_ML: Record<string, number> = {
  ml: 1, L: 1000, tsp: 4.92892, tbsp: 14.7868, 'fl oz': 29.5735,
  cup: 236.588, pint: 473.176, quart: 946.353, gallon: 3785.41,
};

function toBaseQty(qty: number, unit: string | null): { q: number; base: string } {
  if (unit && unit in WEIGHT_G) return { q: qty * WEIGHT_G[unit], base: 'g' };
  if (unit && unit in VOLUME_ML) return { q: qty * VOLUME_ML[unit], base: 'ml' };
  return { q: qty, base: `u:${unit ?? '∅'}` };
}

export function dollarsToCents(s: string): number | null {
  const t = s.trim().replace(/^\$/, '');
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function cents(n: number | null | undefined): string {
  if (n == null) return '—';
  return `$${(n / 100).toFixed(2)}`;
}

export function monthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Estimated cost of grocery items given price guesses.
// Items without a matching price are counted, not guessed.
export function estimateItems(
  items: Pick<GroceryItem, 'name_canonical' | 'qty_amount' | 'unit_canonical'>[],
  prices: PriceEstimate[],
): { total_cents: number; priced: number; unpriced: number } {
  let total = 0, priced = 0, unpriced = 0;
  for (const it of items) {
    if (it.qty_amount == null) {
      unpriced++;
      continue;
    }
    const need = toBaseQty(it.qty_amount, it.unit_canonical);
    const match = prices.find((p) => {
      if (p.name_canonical !== it.name_canonical) return false;
      const pe = toBaseQty(1, p.unit_canonical);
      return pe.base === need.base;
    });
    if (!match) {
      unpriced++;
      continue;
    }
    const pe = toBaseQty(1, match.unit_canonical);
    const qtyInEstUnit = need.q / pe.q;
    total += Math.round(qtyInEstUnit * match.price_cents_per_unit);
    priced++;
  }
  return { total_cents: total, priced, unpriced };
}

// Monthly actual: trip totals + loose item records. An item linked to a list
// that already has a trip total is EXCLUDED (no double-count) — pure + tested.
export function computeMonthlyActual(records: SpendingRecord[]): { total_cents: number; excluded_cents: number } {
  const trips = records.filter((r) => r.kind === 'trip_total');
  const tripLists = new Set(trips.map((t) => t.grocery_list_id).filter((x): x is string => !!x));
  let total = 0, excluded = 0;
  for (const r of records) {
    if (r.kind === 'trip_total') {
      total += r.amount_cents;
    } else if (r.grocery_list_id && tripLists.has(r.grocery_list_id)) {
      excluded += r.amount_cents;
    } else {
      total += r.amount_cents;
    }
  }
  return { total_cents: total, excluded_cents: excluded };
}

export interface SpendingDraft {
  date: string;
  store: string | null;
  amount_cents: number;
  kind: 'trip_total' | 'item';
  grocery_list_id: string | null;
  memo: string | null;
}

export async function addSpending(d: SpendingDraft): Promise<string> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) throw new Error('Pick a valid date.');
  if (!Number.isInteger(d.amount_cents) || d.amount_cents <= 0) throw new Error('Enter an amount above $0.00.');
  const now = nowIso();
  const id = newId();
  await db.spending.add({
    id, household_id: LOCAL_HOUSEHOLD, created_at: now, updated_at: now,
    deleted_at: null, version: 1, updated_by: null,
    date: d.date, store: d.store?.trim() || null, amount_cents: d.amount_cents,
    kind: d.kind, grocery_list_id: d.grocery_list_id, memo: d.memo?.trim() || null,
  });
  return id;
}

export async function deleteSpending(id: string): Promise<void> {
  await db.spending.delete(id);
}

export async function setBudget(month: string, amount_cents: number): Promise<void> {
  if (!Number.isInteger(amount_cents) || amount_cents < 0) throw new Error('Budget cannot be negative.');
  const now = nowIso();
  const existing = await db.budgets.get(month);
  if (existing) {
    await db.budgets.update(month, { amount_cents, updated_at: now, version: existing.version + 1 });
  } else {
    await db.budgets.add({
      id: month, household_id: LOCAL_HOUSEHOLD, created_at: now, updated_at: now,
      deleted_at: null, version: 1, updated_by: null, month, amount_cents,
    });
  }
}

export async function setPrice(name_canonical: string, unit_canonical: string | null, price_cents_per_unit: number): Promise<void> {
  if (!Number.isInteger(price_cents_per_unit) || price_cents_per_unit < 0) throw new Error('Price cannot be negative.');
  const now = nowIso();
  const existing = await db.prices.where('name_canonical').equals(name_canonical).toArray();
  const row = existing.find((e) => (e.unit_canonical ?? null) === (unit_canonical ?? null));
  if (row) {
    await db.prices.update(row.id, { price_cents_per_unit, updated_at: now, version: row.version + 1 });
  } else {
    await db.prices.add({
      id: newId(), household_id: LOCAL_HOUSEHOLD, created_at: now, updated_at: now,
      deleted_at: null, version: 1, updated_by: null,
      name_canonical, unit_canonical, price_cents_per_unit,
    });
  }
}

// Weeks (Sun starts) of a month for the spending-by-week chart.
export function weeksOfMonth(month: string): string[] {
  const [y, m] = month.split('-').map(Number);
  const out: string[] = [];
  let cur = startOfWeekSunday(new Date(y, m - 1, 1));
  const lastDay = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  while (cur <= lastDay) {
    out.push(cur);
    const d = new Date(cur + 'T12:00');
    d.setDate(d.getDate() + 7);
    cur = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (out.length > 6) break;
  }
  return out;
}

export function spendingByWeek(records: SpendingRecord[], weekStarts: string[]): { week: string; total_cents: number }[] {
  return weekStarts.map((w) => {
    const end = new Date(w + 'T12:00');
    end.setDate(end.getDate() + 6);
    const endStr = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
    const inWeek = records.filter((r) => r.date >= w && r.date <= endStr);
    return { week: w, total_cents: computeMonthlyActual(inWeek).total_cents };
  });
}

export { todayISO };
