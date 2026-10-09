import { describe, expect, it } from 'vitest';
import { planCsv, recipesCsv, spendingCsv, validateBackup } from './export';

describe('validateBackup', () => {
  it('rejects wrong app files', () => {
    expect(validateBackup({ app: 'other' }).ok).toBe(false);
  });
  it('rejects newer versions', () => {
    const r = validateBackup({ app: 'family-meals', version: 999 });
    expect(r.ok).toBe(false);
  });
  it('rejects missing tables', () => {
    const partial = {
      app: 'family-meals', version: 1, recipes: [], recipeIngredients: [],
    };
    expect(validateBackup(partial).ok).toBe(false);
  });
});

describe('CSV builders', () => {
  it('quotes commas and quotes', () => {
    const csv = spendingCsv([
      { date: '2026-08-10', store: 'Trader "Joe\'s", Main', amount_cents: 8240, kind: 'trip_total', memo: null },
    ]);
    expect(csv).toContain('"Trader ""Joe\'s"", Main"');
    expect(csv).toContain('82.40');
  });
  it('flattens recipes with numbered steps', () => {
    const csv = recipesCsv([{
      name: 'Pasta', servings_original: 4, tags: ['quick'],
      ingredients: [{ name_raw: 'Pasta', qty_amount: 500, unit_raw: 'g' }],
      steps: [{ text: 'Boil.' }, { text: 'Serve.' }],
      source_url: null,
    }]);
    expect(csv).toContain('1. Boil. | 2. Serve.');
    expect(csv).toContain('500 g Pasta');
  });
  it('marks leftovers in plan CSV', () => {
    const csv = planCsv([{ date: '2026-08-09', meal_type: 'dinner', title: 'Soup', servings: 2, leftovers: true, notes: '' }]);
    expect(csv).toContain(',yes,');
  });
});
