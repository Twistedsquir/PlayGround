import { describe, expect, it } from 'vitest';
import { aggregateNeeds, formatQty, type Need } from './groceries';

function need(name: string, qty: number | null, unit: string | null, source: string): Need {
  return {
    name_canonical: name.toLowerCase(), display_name: name,
    qty_amount: qty, unit_canonical: unit, certain: qty != null, source,
  };
}

describe('aggregateNeeds', () => {
  it('combines 500g + 750g pasta into 1.25 kg', () => {
    const [p] = aggregateNeeds([
      need('Pasta', 500, 'g', 'Pasta ×2'),
      need('Pasta', 750, 'g', 'Pasta ×3'),
    ]);
    expect(p.qty_amount).toBe(1.25);
    expect(p.display_unit).toBe('kg');
  });
  it('combines 1 cup + 250ml milk into cups', () => {
    const [m] = aggregateNeeds([
      need('Milk', 1, 'cup', 'Pancakes ×2'),
      need('Milk', 250, 'ml', 'Latte ×1'),
    ]);
    expect(m.display_unit).toBe('cup');
    expect(m.qty_amount).toBeCloseTo(2, 0);
  });
  it('keeps 1 cup flour and 200g flour as separate lines', () => {
    const out = aggregateNeeds([
      need('Flour', 1, 'cup', 'Cake ×4'),
      need('Flour', 200, 'g', 'Bread ×2'),
    ]);
    expect(out).toHaveLength(2);
  });
  it('flags missing quantities instead of inventing', () => {
    const [s] = aggregateNeeds([need('Salt', null, null, 'Soup ×4')]);
    expect(s.qty_amount).toBe(null);
    expect(s.certain).toBe(false);
    expect(formatQty(s.qty_amount, s.display_unit)).toMatch(/as needed/);
  });
  it('sums same countable units', () => {
    const [e] = aggregateNeeds([
      need('Eggs', 2, null, 'Omelette ×1'),
      need('Eggs', 4, null, 'Cake ×4'),
    ]);
    expect(e.qty_amount).toBe(6);
  });
});
