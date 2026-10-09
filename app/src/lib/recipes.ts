// Recipe CRUD helpers — local-only in Phase 4 (cloud sync is Phase 9/10).
// Plain language: one recipe = header row + ingredient rows + step rows.
import { db, LOCAL_HOUSEHOLD } from './db';
import { canonicalName, normalizeUnit } from './scaling';
import { newId, nowIso, type Recipe, type RecipeIngredient, type RecipeStep } from './types';

export interface IngredientDraft {
  name_raw: string;
  qty_amount: number | null; // null = "to taste / unknown"
  unit_raw: string | null;
  preparation: string | null;
}

export interface RecipeDraft {
  name: string;
  description: string;
  notes: string;
  servings_original: number;
  time_prep_min: number | null;
  time_cook_min: number | null;
  tags: string[];
  source_url: string | null;
  image_path: string | null; // downscaled dataURL for now
  favorite: boolean;
  ingredients: IngredientDraft[];
  steps: string[];
}

export function emptyDraft(): RecipeDraft {
  return {
    name: '', description: '', notes: '', servings_original: 4,
    time_prep_min: null, time_cook_min: null, tags: [],
    source_url: null, image_path: null, favorite: false,
    ingredients: [{ name_raw: '', qty_amount: null, unit_raw: null, preparation: null }],
    steps: [''],
  };
}

export function validateDraft(d: RecipeDraft): string | null {
  if (!d.name.trim()) return 'Give the recipe a name.';
  if (!Number.isFinite(d.servings_original) || d.servings_original < 1 || d.servings_original > 99)
    return 'Servings must be between 1 and 99.';
  const hasIngredient = d.ingredients.some((i) => i.name_raw.trim());
  if (!hasIngredient) return 'Add at least one ingredient.';
  const hasStep = d.steps.some((s) => s.trim());
  if (!hasStep) return 'Add at least one instruction step.';
  return null;
}

function toIngredientRows(recipeId: string, drafts: IngredientDraft[]): RecipeIngredient[] {
  return drafts
    .filter((d) => d.name_raw.trim())
    .map((d, i) => ({
      id: newId(),
      recipe_id: recipeId,
      household_id: LOCAL_HOUSEHOLD,
      position: i,
      name_raw: d.name_raw.trim(),
      name_canonical: canonicalName(d.name_raw),
      qty_amount: d.qty_amount,
      qty_min: null,
      qty_max: null,
      unit_raw: d.unit_raw?.trim() || null,
      unit_canonical: normalizeUnit(d.unit_raw),
      // Unknown quantities are kept honest: not scalable, flagged in UI.
      is_scalable: d.qty_amount != null,
      scaling_note: d.qty_amount == null ? 'No quantity given — adjust to taste' : null,
      preparation: d.preparation?.trim() || null,
    }));
}

function toStepRows(recipeId: string, steps: string[]): RecipeStep[] {
  return steps
    .filter((s) => s.trim())
    .map((text, i) => ({ id: newId(), recipe_id: recipeId, position: i, text: text.trim() }));
}

export async function createRecipe(d: RecipeDraft): Promise<string> {
  const err = validateDraft(d);
  if (err) throw new Error(err);
  const id = newId();
  const now = nowIso();
  const recipe: Recipe = {
    id, household_id: LOCAL_HOUSEHOLD, created_at: now, updated_at: now,
    deleted_at: null, version: 1, updated_by: null,
    name: d.name.trim(), description: d.description.trim(), notes: d.notes.trim(),
    servings_original: Math.round(d.servings_original),
    time_prep_min: d.time_prep_min, time_cook_min: d.time_cook_min,
    categories: [], tags: d.tags.map((t) => t.trim()).filter(Boolean),
    image_path: d.image_path, source_url: d.source_url?.trim() || null,
    import_source: 'manual', import_status: null,
    cost_estimate_cents: null, favorite: d.favorite,
  };
  await db.transaction('rw', db.recipes, db.recipeIngredients, db.recipeSteps, async () => {
    await db.recipes.add(recipe);
    await db.recipeIngredients.bulkAdd(toIngredientRows(id, d.ingredients));
    await db.recipeSteps.bulkAdd(toStepRows(id, d.steps));
  });
  return id;
}

export async function updateRecipe(id: string, d: RecipeDraft): Promise<void> {
  const err = validateDraft(d);
  if (err) throw new Error(err);
  const existing = await db.recipes.get(id);
  if (!existing) throw new Error('Recipe not found.');
  const now = nowIso();
  await db.transaction('rw', db.recipes, db.recipeIngredients, db.recipeSteps, async () => {
    await db.recipes.update(id, {
      name: d.name.trim(), description: d.description.trim(), notes: d.notes.trim(),
      servings_original: Math.round(d.servings_original),
      time_prep_min: d.time_prep_min, time_cook_min: d.time_cook_min,
      tags: d.tags.map((t) => t.trim()).filter(Boolean),
      image_path: d.image_path, source_url: d.source_url?.trim() || null,
      favorite: d.favorite, updated_at: now, version: existing.version + 1,
    });
    await db.recipeIngredients.where('recipe_id').equals(id).delete();
    await db.recipeSteps.where('recipe_id').equals(id).delete();
    await db.recipeIngredients.bulkAdd(toIngredientRows(id, d.ingredients));
    await db.recipeSteps.bulkAdd(toStepRows(id, d.steps));
  });
}

export async function deleteRecipe(id: string): Promise<void> {
  await db.transaction('rw', db.recipes, db.recipeIngredients, db.recipeSteps, async () => {
    await db.recipes.delete(id);
    await db.recipeIngredients.where('recipe_id').equals(id).delete();
    await db.recipeSteps.where('recipe_id').equals(id).delete();
  });
}

export async function toggleFavorite(id: string): Promise<void> {
  const r = await db.recipes.get(id);
  if (!r) return;
  await db.recipes.update(id, { favorite: !r.favorite, updated_at: nowIso(), version: r.version + 1 });
}

export interface RecipeWithChildren {
  recipe: Recipe;
  ingredients: RecipeIngredient[];
  steps: RecipeStep[];
}

export async function getRecipe(id: string): Promise<RecipeWithChildren | null> {
  const recipe = await db.recipes.get(id);
  if (!recipe) return null;
  const ingredients = await db.recipeIngredients.where('recipe_id').equals(id).sortBy('position');
  const steps = await db.recipeSteps.where('recipe_id').equals(id).sortBy('position');
  return { recipe, ingredients, steps };
}

export async function listRecipes(opts: { search?: string; favoritesOnly?: boolean }): Promise<Recipe[]> {
  let all = await db.recipes.orderBy('updated_at').reverse().toArray();
  const q = (opts.search ?? '').trim().toLowerCase();
  if (opts.favoritesOnly) all = all.filter((r) => r.favorite);
  if (q) {
    all = all.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        r.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }
  return all;
}

export function draftFromRecipe(full: RecipeWithChildren): RecipeDraft {
  const { recipe, ingredients, steps } = full;
  return {
    name: recipe.name, description: recipe.description, notes: recipe.notes,
    servings_original: recipe.servings_original,
    time_prep_min: recipe.time_prep_min, time_cook_min: recipe.time_cook_min,
    tags: [...recipe.tags], source_url: recipe.source_url, image_path: recipe.image_path,
    favorite: recipe.favorite,
    ingredients: ingredients.length
      ? ingredients.map((i) => ({
          name_raw: i.name_raw, qty_amount: i.qty_amount,
          unit_raw: i.unit_raw, preparation: i.preparation,
        }))
      : [{ name_raw: '', qty_amount: null, unit_raw: null, preparation: null }],
    steps: steps.length ? steps.map((s) => s.text) : [''],
  };
}
