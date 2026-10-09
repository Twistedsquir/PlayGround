import { describe, expect, it } from 'vitest';
import { computeMonthlyActual, dollarsToCents, estimateItems } from './budget';
import { expiryStatus, validatePantry } from './pantry';
import type { SpendingRecord } from './types';

function rec(partial: Partial<SpendingRecord>): SpendingRecord {
  return {
    id: Math.random().toString(), household_id: 'h', created_at: '', updated_at: '',
    deleted_at: null, version: 1, updated_by: null,
    date: '2026-08-10', store: null, amount_cents: 0, kind: 'trip_total',
    grocery_list_id: null, memo: null, ...partial,
  } as SpendingRecord;
}

describe('computeMonthlyActual', () => {
  it('does not double-count item prices covered by a trip total', () => {
    const out = computeMonthlyActual([
      rec({ kind: 'trip_total', amount_cents: 8000, grocery_list_id: 'L1' }),
      rec({ kind: 'item', amount_cents: 300, grocery_list_id: 'L1' }),
      rec({ kind: 'item', amount_cents: 500, grocery_list_id: null }),
    ]);
    expect(out.total_cents).toBe(8500); // 8000 trip + 500 loose
    expect(out.excluded_cents).toBe(300);
  });
  it('counts item prices when there is no trip total', () => {
    const out = computeMonthlyActual([
      rec({ kind: 'item', amount_cents: 300, grocery_list_id: 'L9' }),
    ]);
    expect(out.total_cents).toBe(300);
  });
});

describe('estimateItems', () => {
  it('prices pasta at $2/kg across units', () => {
    const out = estimateItems(
      [{ name_canonical: 'pasta', qty_amount: 500, unit_canonical: 'g' }],
      [{ id: 'p', household_id: 'h', created_at: '', updated_at: '', deleted_at: null, version: 1, updated_by: null,
         name_canonical: 'pasta', unit_canonical: 'kg', price_cents_per_unit: 200 }],
    );
    expect(out.total_cents).toBe(100); // 0.5kg × $2
    expect(out.unpriced).toBe(0);
  });
  it('counts unpriced and quantity-less items without guessing', () => {
    const out = estimateItems(
      [
        { name_canonical: 'saffron', qty_amount: 1, unit_canonical: 'g' },
        { name_canonical: 'salt', qty_amount: null, unit_canonical: null },
      ],
      [],
    );
    expect(out.total_cents).toBe(0);
    expect(out.unpriced).toBe(2);
  });
});

describe('pantry validation + expiry', () => {
  it('requires a name, rejects negative qty', () => {
    expect(validatePantry({ display_name: ' ', qty_on_hand: 1, unit_canonical: null, category: null, expires_on: null, unit_cost_cents: null, notes: '' })).toMatch(/name/i);
    expect(validatePantry({ display_name: 'Rice', qty_on_hand: -1, unit_canonical: null, category: null, expires_on: null, unit_cost_cents: null, notes: '' })).toMatch(/negative/i);
  });
  it('flags past and soon expiries', () => {
    expect(expiryStatus('2026-01-01', '2026-08-09')).toBe('past');
    expect(expiryStatus('2026-08-11', '2026-08-09')).toBe('soon');
    expect(expiryStatus('2026-12-01', '2026-08-09')).toBe('ok');
    expect(expiryStatus(null, '2026-08-09')).toBe('ok');
  });
});

describe('dollarsToCents', () => {
  it('parses amounts', () => {
    expect(dollarsToCents('12.50')).toBe(1250);
    expect(dollarsToCents('$3')).toBe(300);
    expect(dollarsToCents('abc')).toBe(null);
    expect(dollarsToCents('-5')).toBe(null);
  });
});
