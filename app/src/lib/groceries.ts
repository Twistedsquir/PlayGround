// Weekly grocery aggregation (SPEC section 8).
// Pipeline: planned meals -> scaled needs -> combine duplicates (safe units only)
// -> subtract pantry (safe matches only) -> merge into checklist without
// touching custom items or checkmarks.
//
// Honesty rules: weight<->weight and volume<->volume only. Anything else
// (cup vs grams, "a pinch", unknown units) stays as separate lines with a note.
import { db, LOCAL_HOUSEHOLD } from './db';
import { listMealsForWeek } from './meals';
import { canonicalName, formatAmount, normalizeUnit } from './scaling';
import { newId, nowIso, type GroceryItem, type GroceryList } from './types';

const WEIGHT_G: Record<string, number> = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };
const VOLUME_ML: Record<string, number> = {
  ml: 1, L: 1000, tsp: 4.92892, tbsp: 14.7868, 'fl oz': 29.5735,
  cup: 236.588, pint: 473.176, quart: 946.353, gallon: 3785.41,
};

type Bucket = 'weight' | 'volume' | 'other';

function bucketOf(unit: string | null): Bucket {
  if (!unit) return 'other';
  if (unit in WEIGHT_G) return 'weight';
  if (unit in VOLUME_ML) return 'volume';
  return 'other';
}

function toBase(qty: number, unit: string | null): { baseQty: number; baseUnit: 'g' | 'ml' | null } {
  if (!unit) return { baseQty: qty, baseUnit: null };
  if (unit in WEIGHT_G) return { baseQty: qty * WEIGHT_G[unit], baseUnit: 'g' };
  if (unit in VOLUME_ML) return { baseQty: qty * VOLUME_ML[unit], baseUnit: 'ml' };
  return { baseQty: qty, baseUnit: null };
}

// One scaled need from a single meal's ingredient.
export interface Need {
  name_canonical: string;
  display_name: string; // original raw name, first seen
  qty_amount: number | null; // scaled, in ORIGINAL unit (null = uncertain)
  unit_canonical: string | null;
  certain: boolean;
  source: string; // e.g. "Pasta ×6"
}

export interface Aggregated {
  stable_key: string;
  display_name: string;
  name_canonical: string;
  qty_amount: number | null; // in display_unit (null = uncertain)
  display_unit: string | null;
  certain: boolean;
  source_summary: string;
  mealCount: number;
}

function displayWeight(g: number): { qty: number; unit: string } {
  if (g >= 1000) return { qty: Math.round((g / 1000) * 100) / 100, unit: 'kg' };
  return { qty: Math.round(g * 10) / 10, unit: 'g' };
}

function displayVolume(ml: number): { qty: number; unit: string } {
  if (ml >= 1000) return { qty: Math.round((ml / 1000) * 100) / 100, unit: 'L' };
  // Prefer readable US cups when the total lands near an eighth-cup.
  const cups = ml / VOLUME_ML.cup;
  if (cups >= 0.24) {
    const r8 = Math.round(cups * 8) / 8;
    if (Math.abs(r8 - cups) / cups < 0.03) return { qty: r8, unit: 'cup' };
  }
  return { qty: Math.round(ml * 10) / 10, unit: 'ml' };
}

export function formatQty(qty: number | null, unit: string | null): string {
  if (qty == null) return 'qty as needed';
  if (unit === 'cup') return `${formatAmount(qty)} ${qty === 1 ? 'cup' : 'cups'}`;
  return `${formatAmount(qty)}${unit ? ` ${unit}` : ''}`;
}

// Pure aggregation — unit-tested, no database.
export function aggregateNeeds(needs: Need[]): Aggregated[] {
  const groups = new Map<string, Need[]>();
  for (const n of needs) {
    const b = bucketOf(n.unit_canonical);
    const base = n.unit_canonical && b !== 'other' ? (b === 'weight' ? 'g' : 'ml') : (n.unit_canonical ?? '∅');
    const key = `auto|${n.name_canonical}|${base}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(n);
  }
  const out: Aggregated[] = [];
  for (const [key, items] of groups) {
    const first = items[0];
    const certainItems = items.filter((i) => i.certain && i.qty_amount != null);
    const uncertain = certainItems.length !== items.length;
    const base = key.split('|')[2];
    let qty: number | null = null;
    let unit: string | null = null;
    if (certainItems.length > 0) {
      if (base === 'g' || base === 'ml') {
        let totalBase = 0;
        for (const i of certainItems) {
          const conv = toBase(i.qty_amount as number, i.unit_canonical);
          totalBase += conv.baseQty;
        }
        const d = base === 'g' ? displayWeight(totalBase) : displayVolume(totalBase);
        qty = d.qty;
        unit = d.unit;
      } else {
        // Same non-convertible unit (e.g. "can", "clove") — plain sum.
        qty = Math.round(certainItems.reduce((s, i) => s + (i.qty_amount as number), 0) * 100) / 100;
        unit = base === '∅' ? null : base;
      }
    }
    out.push({
      stable_key: key,
      display_name: first.display_name,
      name_canonical: first.name_canonical,
      qty_amount: qty,
      display_unit: unit,
      certain: !uncertain,
      source_summary: items.map((i) => i.source).join(' + '),
      mealCount: new Set(items.map((i) => i.source)).size,
    });
  }
  out.sort((a, b) => a.display_name.localeCompare(b.display_name));
  return out;
}

// Build scaled needs for a week from the plan.
export async function buildNeedsForWeek(weekStartSun: string): Promise<Need[]> {
  const meals = await listMealsForWeek(weekStartSun);
  const needs: Need[] = [];
  // Recipe names for source labels.
  const recipes = await db.recipes.toArray();
  const rname = new Map(recipes.map((r) => [r.id, r.name]));
  const servingsOrig = new Map(recipes.map((r) => [r.id, r.servings_original]));
  for (const m of meals) {
    const label = m.recipe_id ? (rname.get(m.recipe_id) ?? 'recipe') : (m.title_override ?? 'meal');
    if (!m.recipe_id) continue; // custom-title meals have no ingredients
    const orig = servingsOrig.get(m.recipe_id) ?? 0;
    const ings = await db.recipeIngredients.where('recipe_id').equals(m.recipe_id).toArray();
    for (const ing of ings) {
      const factor = orig > 0 ? m.servings_planned / orig : NaN;
      const certain = ing.qty_amount != null && Number.isFinite(factor);
      needs.push({
        name_canonical: ing.name_canonical || canonicalName(ing.name_raw),
        display_name: ing.name_raw,
        qty_amount: certain ? (ing.qty_amount as number) * factor : null,
        unit_canonical: ing.unit_canonical ?? normalizeUnit(ing.unit_raw),
        certain,
        source: `${label} ×${m.servings_planned}`,
      });
    }
  }
  return needs;
}

// Subtract pantry where name + bucket match safely. Returns reduced list +
// count of fully-covered items (shown, not silently hidden — user sees the note).
export async function applyPantry(items: Aggregated[]): Promise<{ items: Aggregated[]; covered: string[] }> {
  const pantry = await db.pantry.toArray();
  const covered: string[] = [];
  const out: Aggregated[] = [];
  for (const it of items) {
    if (it.qty_amount == null) {
      out.push(it); // uncertain — never subtract blindly
      continue;
    }
    const match = pantry.find(
      (p) =>
        p.name_canonical === it.name_canonical &&
        p.qty_on_hand != null &&
        bucketOf(p.unit_canonical) === bucketOf(it.display_unit),
    );
    if (!match || match.qty_on_hand == null) {
      out.push(it);
      continue;
    }
    const needBase = toBase(it.qty_amount, it.display_unit);
    const haveBase = toBase(match.qty_on_hand, match.unit_canonical);
    if (needBase.baseUnit !== haveBase.baseUnit) {
      out.push(it);
      continue;
    }
    const rest = needBase.baseQty - haveBase.baseQty;
    if (rest <= 0) {
      covered.push(it.display_name);
      continue;
    }
    const d = needBase.baseUnit === 'g' ? displayWeight(rest)
      : needBase.baseUnit === 'ml' ? displayVolume(rest)
      : { qty: Math.round(rest * 100) / 100, unit: it.display_unit as string };
    out.push({
      ...it,
      qty_amount: d.qty,
      display_unit: d.unit,
      source_summary: `${it.source_summary} (−${match.qty_on_hand}${match.unit_canonical ? ` ${match.unit_canonical}` : ''} pantry)`,
    });
  }
  return { items: out, covered };
}

export async function getOrCreateList(weekStartSun: string): Promise<GroceryList> {
  const existing = await db.groceryLists.where('week_start_sun').equals(weekStartSun).first();
  if (existing) return existing;
  const now = nowIso();
  const row: GroceryList = {
    id: newId(), household_id: LOCAL_HOUSEHOLD, created_at: now, updated_at: now,
    deleted_at: null, version: 1, updated_by: null,
    week_start_sun: weekStartSun, status: 'active',
  };
  await db.groceryLists.add(row);
  return row;
}

export interface RecalcReport { added: number; updated: number; removed: number; coveredByPantry: string[] }

// Recalculate WITHOUT touching custom items or checkmarks.
// - auto item with a fresh key: update qty/unit/sources (keep is_checked)
// - new key: add unchecked
// - stale auto key: delete only if unchecked; keep checked ones (user bought them)
export async function recalculateWeek(weekStartSun: string): Promise<RecalcReport> {
  const list = await getOrCreateList(weekStartSun);
  const needs = await buildNeedsForWeek(weekStartSun);
  const aggregated = aggregateNeeds(needs);
  const { items, covered } = await applyPantry(aggregated);
  const fresh = new Map(items.map((i) => [i.stable_key, i]));
  const current = await db.groceryItems.where('list_id').equals(list.id).toArray();
  const now = nowIso();
  let added = 0, updated = 0, removed = 0;
  await db.transaction('rw', db.groceryItems, db.groceryLists, async () => {
    for (const it of items) {
      const row = current.find((c) => c.stable_key === it.stable_key && !c.is_custom);
      if (!row) {
        const item: GroceryItem = {
          id: newId(), household_id: LOCAL_HOUSEHOLD, created_at: now, updated_at: now,
          deleted_at: null, version: 1, updated_by: null,
          list_id: list.id, stable_key: it.stable_key, display_name: it.display_name,
          name_canonical: it.name_canonical, qty_amount: it.qty_amount,
          unit_canonical: it.display_unit,
          is_estimate_uncertain: !it.certain,
          source_summary: it.source_summary, is_custom: false,
          is_checked: false, checked_at: null, custom_note: null,
        };
        await db.groceryItems.add(item);
        added++;
      } else if (
        row.qty_amount !== it.qty_amount || row.unit_canonical !== it.display_unit ||
        row.source_summary !== it.source_summary || row.display_name !== it.display_name ||
        row.is_estimate_uncertain === it.certain
      ) {
        await db.groceryItems.update(row.id, {
          qty_amount: it.qty_amount, unit_canonical: it.display_unit,
          source_summary: it.source_summary, display_name: it.display_name,
          is_estimate_uncertain: !it.certain,
          updated_at: now, version: row.version + 1,
        });
        updated++;
      }
    }
    for (const row of current) {
      if (!row.is_custom && !fresh.has(row.stable_key) && !row.is_checked) {
        await db.groceryItems.delete(row.id);
        removed++;
      }
    }
    await db.groceryLists.update(list.id, { updated_at: now });
  });
  return { added, updated, removed, coveredByPantry: covered };
}

export async function toggleCheck(id: string): Promise<void> {
  const it = await db.groceryItems.get(id);
  if (!it) return;
  await db.groceryItems.update(id, {
    is_checked: !it.is_checked,
    checked_at: !it.is_checked ? nowIso() : null,
    updated_at: nowIso(), version: it.version + 1,
  });
}

export async function addCustomItem(listId: string, name: string, qty: number | null, unit: string | null, note: string | null): Promise<void> {
  if (!name.trim()) throw new Error('Give the item a name.');
  const now = nowIso();
  await db.groceryItems.add({
    id: newId(), household_id: LOCAL_HOUSEHOLD, created_at: now, updated_at: now,
    deleted_at: null, version: 1, updated_by: null,
    list_id: listId, stable_key: `custom|${newId()}`,
    display_name: name.trim(), name_canonical: canonicalName(name),
    qty_amount: qty, unit_canonical: unit?.trim() || null,
    is_estimate_uncertain: false, source_summary: 'added by you',
    is_custom: true, is_checked: false, checked_at: null, custom_note: note?.trim() || null,
  });
}

// Editing an auto item converts it to custom so recalc never overwrites your fix.
export async function editItem(id: string, patch: { display_name: string; qty_amount: number | null; unit_canonical: string | null; custom_note: string | null }): Promise<void> {
  const it = await db.groceryItems.get(id);
  if (!it) return;
  if (!patch.display_name.trim()) throw new Error('Give the item a name.');
  await db.groceryItems.update(id, {
    display_name: patch.display_name.trim(),
    name_canonical: canonicalName(patch.display_name),
    qty_amount: patch.qty_amount,
    unit_canonical: patch.unit_canonical?.trim() || null,
    custom_note: patch.custom_note?.trim() || null,
    is_custom: true, // your edit wins over future recalculations
    updated_at: nowIso(), version: it.version + 1,
  });
}

export async function deleteItem(id: string): Promise<void> {
  await db.groceryItems.delete(id);
}

export async function archiveBought(listId: string): Promise<number> {
  const bought = await db.groceryItems.where('list_id').equals(listId).toArray();
  const ids = bought.filter((b) => b.is_checked).map((b) => b.id);
  await db.groceryItems.bulkDelete(ids);
  return ids.length;
}

// Add checked-off quantities to pantry. Unknown qty ("as needed") is skipped —
// we never inflate your pantry with a guess.
export async function addBoughtToPantry(listId: string): Promise<{ added: number; skipped: number }> {
  const items = await db.groceryItems.where('list_id').equals(listId).toArray();
  const bought = items.filter((i) => i.is_checked);
  const pantry = await db.pantry.toArray();
  let added = 0, skipped = 0;
  const now = nowIso();
  await db.transaction('rw', db.pantry, async () => {
    for (const b of bought) {
      if (b.qty_amount == null) {
        skipped++;
        continue;
      }
      const match = pantry.find(
        (p) => p.name_canonical === b.name_canonical && bucketOf(p.unit_canonical) === bucketOf(b.unit_canonical),
      );
      if (match && match.qty_on_hand != null && b.unit_canonical && match.unit_canonical) {
        const a = toBase(match.qty_on_hand, match.unit_canonical);
        const c = toBase(b.qty_amount, b.unit_canonical);
        if (a.baseUnit === c.baseUnit && a.baseUnit) {
          const back = a.baseUnit === 'g' ? displayWeight(a.baseQty + c.baseQty) : displayVolume(a.baseQty + c.baseQty);
          await db.pantry.update(match.id, { qty_on_hand: back.qty, unit_canonical: back.unit, updated_at: now, version: match.version + 1 });
          added++;
          continue;
        }
      }
      await db.pantry.add({
        id: newId(), household_id: LOCAL_HOUSEHOLD, created_at: now, updated_at: now,
        deleted_at: null, version: 1, updated_by: null,
        name_canonical: b.name_canonical, display_name: b.display_name,
        qty_on_hand: b.qty_amount, unit_canonical: b.unit_canonical,
        category: null, expires_on: null, unit_cost_cents: null, notes: '',
      });
      added++;
    }
  });
  return { added, skipped };
}
