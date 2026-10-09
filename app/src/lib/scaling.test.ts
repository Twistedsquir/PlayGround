import { describe, expect, it } from 'vitest';
import { canCombineUnits, formatAmount, normalizeUnit, scaleQuantity } from './scaling';

describe('formatAmount', () => {
  it('keeps whole numbers', () => expect(formatAmount(2)).toBe('2'));
  it('formats halves/quarters', () => {
    expect(formatAmount(0.5)).toBe('½');
    expect(formatAmount(0.75)).toBe('¾');
    expect(formatAmount(1.5)).toBe('1 ½');
  });
  it('rounds to eighths', () => expect(formatAmount(0.33)).toBe('3/8'));
});

describe('scaleQuantity', () => {
  it('scales 4 -> 6 servings (x1.5): 1/2 cup -> 3/4 cup', () => {
    const r = scaleQuantity({ qty_amount: 0.5, unit_raw: 'cup' }, 4, 6);
    expect(r.scaled).toBe(true);
    expect(r.display).toContain('¾');
  });
  it('flags missing quantities instead of inventing', () => {
    const r = scaleQuantity({ qty_amount: null }, 4, 6);
    expect(r.scaled).toBe(false);
    expect(r.display).toMatch(/to taste/i);
  });
  it('scales ranges keeping shape', () => {
    const r = scaleQuantity({ qty_amount: null, qty_min: 2, qty_max: 3, unit_raw: 'cloves' }, 2, 4);
    expect(r.display).toContain('4');
    expect(r.display).toContain('6');
  });
  it('refuses to scale without original servings', () => {
    const r = scaleQuantity({ qty_amount: 1 }, 0, 4);
    expect(r.scaled).toBe(false);
  });
});

describe('units', () => {
  it('normalizes synonyms', () => {
    expect(normalizeUnit('Teaspoons')).toBe('tsp');
    expect(normalizeUnit('a pinch')).toBe(null);
  });
  it('combines weight-weight and volume-volume only', () => {
    expect(canCombineUnits('g', 'oz')).toBe(true);
    expect(canCombineUnits('cup', 'ml')).toBe(true);
    expect(canCombineUnits('cup', 'g')).toBe(false); // needs density — keep separate
    expect(canCombineUnits(null, 'g')).toBe(false);
  });
});
