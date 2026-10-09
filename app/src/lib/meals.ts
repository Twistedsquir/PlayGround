// Meal planning helpers — Sunday-start weeks (SPEC section 7).
// A meal = date + meal slot + recipe (or custom title) + its own servings.
import { db, LOCAL_HOUSEHOLD } from './db';
import { newId, nowIso, type MealType, type PlannedMeal } from './types';

export const MEAL_TYPES: { id: MealType; label: string }[] = [
  { id: 'breakfast', label: 'Breakfast' },
  { id: 'lunch', label: 'Lunch' },
  { id: 'dinner', label: 'Dinner' },
  { id: 'snack', label: 'Snacks' },
];

export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function todayISO(): string {
  return toISODate(new Date());
}

// Weeks begin on Sunday. E.g. Wed 2026-08-12 -> Sun 2026-08-09.
export function startOfWeekSunday(d: Date): string {
  const c = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  c.setDate(c.getDate() - c.getDay()); // getDay: 0 = Sunday
  return toISODate(c);
}

export function addDays(iso: string, n: number): string {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

export function weekDays(weekStartSun: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStartSun, i));
}

export function prettyDay(iso: string): string {
  return parseISODate(iso).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

export interface MonthCell { date: string; inMonth: boolean; }

// Sunday-start month grid (always whole weeks, leading/trailing days included).
export function monthGrid(year: number, month0: number): MonthCell[] {
  const first = new Date(year, month0, 1);
  const start = new Date(first);
  start.setDate(start.getDate() - start.getDay());
  const end = new Date(year, month0 + 1, 0); // last day of month
  const cells: MonthCell[] = [];
  const c = new Date(start);
  while (true) {
    cells.push({ date: toISODate(c), inMonth: c.getMonth() === month0 });
    if (c.getTime() >= end.getTime() && c.getDay() === 6) break;
    c.setDate(c.getDate() + 1);
  }
  return cells;
}

export interface MealDraft {
  date: string;
  meal_type: MealType;
  recipe_id: string | null;
  title_override: string | null;
  servings_planned: number;
  is_leftovers: boolean;
  notes: string;
}

export function validateMeal(d: MealDraft): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return 'Pick a valid date.';
  if (!MEAL_TYPES.some((m) => m.id === d.meal_type)) return 'Pick a meal slot.';
  if (!d.recipe_id && !d.title_override?.trim()) return 'Choose a recipe or type a meal name.';
  if (!Number.isFinite(d.servings_planned) || d.servings_planned < 1 || d.servings_planned > 99)
    return 'Servings must be between 1 and 99.';
  return null;
}

export async function createMeal(d: MealDraft): Promise<string> {
  const err = validateMeal(d);
  if (err) throw new Error(err);
  const now = nowIso();
  const id = newId();
  const row: PlannedMeal = {
    id, household_id: LOCAL_HOUSEHOLD, created_at: now, updated_at: now,
    deleted_at: null, version: 1, updated_by: null,
    date: d.date, meal_type: d.meal_type, recipe_id: d.recipe_id,
    title_override: d.title_override?.trim() || null,
    servings_planned: Math.round(d.servings_planned),
    is_leftovers: d.is_leftovers, notes: d.notes.trim(),
  };
  await db.plannedMeals.add(row);
  return id;
}

export async function updateMeal(id: string, patch: Partial<MealDraft>): Promise<void> {
  const existing = await db.plannedMeals.get(id);
  if (!existing) throw new Error('Meal not found.');
  const merged: MealDraft = {
    date: patch.date ?? existing.date,
    meal_type: patch.meal_type ?? existing.meal_type,
    recipe_id: patch.recipe_id !== undefined ? patch.recipe_id : existing.recipe_id,
    title_override: patch.title_override !== undefined ? patch.title_override : existing.title_override,
    servings_planned: patch.servings_planned ?? existing.servings_planned,
    is_leftovers: patch.is_leftovers ?? existing.is_leftovers,
    notes: patch.notes ?? existing.notes,
  };
  const err = validateMeal(merged);
  if (err) throw new Error(err);
  await db.plannedMeals.update(id, { ...merged, updated_at: nowIso(), version: existing.version + 1 });
}

export async function deleteMeal(id: string): Promise<void> {
  await db.plannedMeals.delete(id);
}

// Move to another day/slot. Copy duplicates. Repeat clones onto several dates.
export async function moveMeal(id: string, date: string, meal_type: MealType): Promise<void> {
  await updateMeal(id, { date, meal_type });
}

export async function copyMeal(id: string, date: string, meal_type: MealType): Promise<string> {
  const m = await db.plannedMeals.get(id);
  if (!m) throw new Error('Meal not found.');
  return createMeal({
    date, meal_type, recipe_id: m.recipe_id, title_override: m.title_override,
    servings_planned: m.servings_planned, is_leftovers: m.is_leftovers, notes: m.notes,
  });
}

export async function repeatMeal(id: string, dates: { date: string; meal_type: MealType }[]): Promise<void> {
  for (const t of dates) await copyMeal(id, t.date, t.meal_type);
}

// Swap two meals' day+slot (recipes, servings, notes travel with each meal).
export async function swapMeals(aId: string, bId: string): Promise<void> {
  const a = await db.plannedMeals.get(aId);
  const b = await db.plannedMeals.get(bId);
  if (!a || !b) throw new Error('Meal not found.');
  const now = nowIso();
  await db.transaction('rw', db.plannedMeals, async () => {
    await db.plannedMeals.update(aId, { date: b.date, meal_type: b.meal_type, updated_at: now, version: a.version + 1 });
    await db.plannedMeals.update(bId, { date: a.date, meal_type: a.meal_type, updated_at: now, version: b.version + 1 });
  });
}

export async function listMealsForWeek(weekStartSun: string): Promise<PlannedMeal[]> {
  const days = new Set(weekDays(weekStartSun));
  return (await db.plannedMeals.toArray()).filter((m) => days.has(m.date));
}

export async function listMealsForDay(date: string): Promise<PlannedMeal[]> {
  return db.plannedMeals.where('date').equals(date).toArray();
}

export async function listMealsForMonth(year: number, month0: number): Promise<PlannedMeal[]> {
  const cells = new Set(monthGrid(year, month0).map((c) => c.date));
  return (await db.plannedMeals.toArray()).filter((m) => cells.has(m.date));
}
