// Pantry helpers (SPEC section 9). Offline-first, errors are plain-language.
import { db, LOCAL_HOUSEHOLD } from './db';
import { canonicalName } from './scaling';
import { newId, nowIso, type PantryItem } from './types';

export interface PantryDraft {
  display_name: string;
  qty_on_hand: number | null;
  unit_canonical: string | null;
  category: string | null;
  expires_on: string | null; // YYYY-MM-DD
  unit_cost_cents: number | null;
  notes: string;
}

export function validatePantry(d: PantryDraft): string | null {
  if (!d.display_name.trim()) return 'Give the pantry item a name.';
  if (d.qty_on_hand != null && (!Number.isFinite(d.qty_on_hand) || d.qty_on_hand < 0))
    return 'Quantity cannot be negative.';
  if (d.expires_on && !/^\d{4}-\d{2}-\d{2}$/.test(d.expires_on)) return 'Expiry must be a valid date.';
  return null;
}

export async function createPantryItem(d: PantryDraft): Promise<string> {
  const err = validatePantry(d);
  if (err) throw new Error(err);
  const now = nowIso();
  const id = newId();
  await db.pantry.add({
    id, household_id: LOCAL_HOUSEHOLD, created_at: now, updated_at: now,
    deleted_at: null, version: 1, updated_by: null,
    name_canonical: canonicalName(d.display_name),
    display_name: d.display_name.trim(),
    qty_on_hand: d.qty_on_hand, unit_canonical: d.unit_canonical?.trim() || null,
    category: d.category?.trim() || null, expires_on: d.expires_on || null,
    unit_cost_cents: d.unit_cost_cents, notes: d.notes.trim(),
  });
  return id;
}

export async function updatePantryItem(id: string, d: PantryDraft): Promise<void> {
  const err = validatePantry(d);
  if (err) throw new Error(err);
  const existing = await db.pantry.get(id);
  if (!existing) throw new Error('Pantry item not found.');
  await db.pantry.update(id, {
    name_canonical: canonicalName(d.display_name),
    display_name: d.display_name.trim(),
    qty_on_hand: d.qty_on_hand, unit_canonical: d.unit_canonical?.trim() || null,
    category: d.category?.trim() || null, expires_on: d.expires_on || null,
    unit_cost_cents: d.unit_cost_cents, notes: d.notes.trim(),
    updated_at: nowIso(), version: existing.version + 1,
  });
}

// Quick +/- stepper. Floor at 0 — stock never goes negative.
export async function adjustPantry(id: string, delta: number): Promise<void> {
  const p = await db.pantry.get(id);
  if (!p) return;
  const base = p.qty_on_hand ?? 0;
  await db.pantry.update(id, {
    qty_on_hand: Math.max(0, Math.round((base + delta) * 100) / 100),
    updated_at: nowIso(), version: p.version + 1,
  });
}

export async function deletePantryItem(id: string): Promise<void> {
  await db.pantry.delete(id);
}

export async function listPantry(search = ''): Promise<PantryItem[]> {
  const all = await db.pantry.orderBy('display_name').toArray();
  const q = search.trim().toLowerCase();
  return q ? all.filter((p) => p.display_name.toLowerCase().includes(q)) : all;
}

export function expiryStatus(expires_on: string | null, today: string): 'ok' | 'soon' | 'past' {
  if (!expires_on) return 'ok';
  if (expires_on < today) return 'past';
  // "soon" = within 5 days (string compare works for YYYY-MM-DD).
  const d = new Date(expires_on + 'T12:00');
  d.setDate(d.getDate() - 5);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}` <= today ? 'soon' : 'ok';
}
