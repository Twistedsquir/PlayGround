import { describe, expect, it } from 'vitest';
import { emptyDraft, validateDraft } from './recipes';

describe('validateDraft', () => {
  it('requires a name', () => {
    const d = emptyDraft();
    expect(validateDraft(d)).toMatch(/name/i);
  });
  it('requires servings in range', () => {
    const d = emptyDraft();
    d.name = 'Soup';
    d.servings_original = 0;
    expect(validateDraft(d)).toMatch(/servings/i);
  });
  it('accepts a minimal valid recipe', () => {
    const d = emptyDraft();
    d.name = 'Pasta';
    d.ingredients = [{ name_raw: 'Pasta', qty_amount: 500, unit_raw: 'g', preparation: null }];
    d.steps = ['Boil water.'];
    expect(validateDraft(d)).toBe(null);
  });
});
