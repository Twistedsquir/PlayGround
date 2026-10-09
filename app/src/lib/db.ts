// Durable local database via IndexedDB/Dexie (SPEC section 12).
// Everything is written here FIRST, then synced to Supabase when online.
// If the network fails, data is safe here and sync retries later.
import Dexie, { type Table } from 'dexie';
import type {
  BudgetSetting, GroceryItem, GroceryList, PantryItem, PlannedMeal, PriceEstimate, Recipe,
  RecipeIngredient, RecipeStep, SpendingRecord,
} from './types';

export const LOCAL_HOUSEHOLD = 'local-household';

class MealsDb extends Dexie {
  recipes!: Table<Recipe, string>;
  recipeIngredients!: Table<RecipeIngredient, string>;
  recipeSteps!: Table<RecipeStep, string>;
  plannedMeals!: Table<PlannedMeal, string>;
  groceryLists!: Table<GroceryList, string>;
  groceryItems!: Table<GroceryItem, string>;
  pantry!: Table<PantryItem, string>;
  spending!: Table<SpendingRecord, string>;
  prices!: Table<PriceEstimate, string>;
  budgets!: Table<BudgetSetting, string>;

  constructor() {
    super('family-meals');
    this.version(1).stores({
      recipes: 'id, household_id, updated_at, favorite',
      recipeIngredients: 'id, recipe_id, position',
      recipeSteps: 'id, recipe_id, position',
      plannedMeals: 'id, household_id, date, updated_at',
      groceryLists: 'id, household_id, week_start_sun',
      groceryItems: 'id, list_id, stable_key, is_checked',
      pantry: 'id, household_id, name_canonical',
      spending: 'id, household_id, date',
    });
    // Phase 7/8: price estimates + monthly budgets (new tables only, no data loss).
    this.version(2).stores({
      prices: 'id, household_id, name_canonical',
      budgets: 'id, month',
    });
  }
}

export const db = new MealsDb();

// Ask iOS to treat our data as persistent (best-effort eviction defense).
export async function requestPersistence(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
    return false;
  } catch {
    return false;
  }
}
