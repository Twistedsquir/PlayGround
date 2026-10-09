// Shared data model — mirrors SPEC sections 6/7/17.
// Every synced record: stable UUID id, household_id, created/updated_at,
// deleted_at tombstone (null = alive), version for conflict detection.
// Money is integer cents. Quantities are nullable: null = "unknown / to taste".

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export interface SyncMeta {
  id: string; // UUID generated on the phone
  household_id: string;
  created_at: string; // ISO
  updated_at: string; // ISO, server ordering
  deleted_at: string | null; // tombstone
  version: number;
  updated_by: string | null;
}

export interface Recipe extends SyncMeta {
  name: string;
  description: string;
  notes: string;
  servings_original: number;
  time_prep_min: number | null;
  time_cook_min: number | null;
  categories: string[];
  tags: string[];
  image_path: string | null;
  source_url: string | null;
  import_source: 'manual' | 'url' | 'photo' | 'ai';
  import_status: string | null;
  cost_estimate_cents: number | null;
  favorite: boolean;
}

export interface RecipeIngredient {
  id: string;
  recipe_id: string;
  household_id: string;
  position: number;
  name_raw: string; // exactly as on the recipe card
  name_canonical: string; // lowercased, trimmed, synonym-mapped
  qty_amount: number | null;
  qty_min: number | null; // for ranges like "2-3 cloves"
  qty_max: number | null;
  unit_raw: string | null;
  unit_canonical: string | null; // allowlist or null
  is_scalable: boolean;
  scaling_note: string | null;
  preparation: string | null; // e.g. "diced"
}

export interface RecipeStep {
  id: string;
  recipe_id: string;
  position: number;
  text: string;
}

export interface PlannedMeal extends SyncMeta {
  date: string; // YYYY-MM-DD
  meal_type: MealType;
  recipe_id: string | null;
  title_override: string | null;
  servings_planned: number; // per-meal servings, SPEC section 6
  is_leftovers: boolean;
  notes: string;
}

export interface GroceryList extends SyncMeta {
  week_start_sun: string; // YYYY-MM-DD of Sunday
  status: 'active' | 'archived';
}

export interface GroceryItem extends SyncMeta {
  list_id: string;
  stable_key: string; // canonical_name|unit|origin — survives recalc
  display_name: string;
  name_canonical: string;
  qty_amount: number | null;
  unit_canonical: string | null;
  is_estimate_uncertain: boolean;
  source_summary: string | null;
  is_custom: boolean;
  is_checked: boolean;
  checked_at: string | null;
  custom_note: string | null;
}

export interface PantryItem extends SyncMeta {
  name_canonical: string;
  display_name: string;
  qty_on_hand: number | null;
  unit_canonical: string | null;
  category: string | null;
  expires_on: string | null;
  unit_cost_cents: number | null;
  notes: string;
}

export interface SpendingRecord extends SyncMeta {
  date: string;
  store: string | null;
  amount_cents: number;
  kind: 'trip_total' | 'item';
  grocery_list_id: string | null;
  memo: string | null;
}

// Editable price guess per ingredient+unit (estimates are never actuals).
export interface PriceEstimate extends SyncMeta {
  name_canonical: string;
  unit_canonical: string | null;
  price_cents_per_unit: number;
}

// Monthly budget, id = "YYYY-MM".
export interface BudgetSetting extends SyncMeta {
  month: string;
  amount_cents: number;
}

// Local-only outbox entry (never synced as a table itself).
export interface OutboxOp {
  op_id: string;
  table: string;
  record_id: string;
  base_version: number;
  patch: Record<string, unknown>;
  created_at: string;
}

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
