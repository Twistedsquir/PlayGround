import { describe, expect, it } from 'vitest';
import { addDays, monthGrid, startOfWeekSunday, validateMeal, weekDays } from './meals';

describe('Sunday-start weeks', () => {
  it('Wednesday maps back to Sunday', () => {
    // 2026-08-12 is a Wednesday
    expect(startOfWeekSunday(new Date(2026, 7, 12))).toBe('2026-08-09');
  });
  it('Sunday maps to itself', () => {
    expect(startOfWeekSunday(new Date(2026, 7, 9))).toBe('2026-08-09');
  });
  it('week spans month boundary', () => {
    expect(weekDays('2026-08-30')).toContain('2026-09-05');
  });
  it('addDays crosses months', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
  });
});

describe('monthGrid', () => {
  it('starts on Sunday and ends on Saturday', () => {
    const cells = monthGrid(2026, 0); // January 2026
    expect(new Date(cells[0].date + 'T12:00').getDay()).toBe(0);
    expect(new Date(cells[cells.length - 1].date + 'T12:00').getDay()).toBe(6);
    expect(cells.some((c) => c.date === '2026-01-31' && c.inMonth)).toBe(true);
  });
});

describe('validateMeal', () => {
  it('needs a recipe or a name', () => {
    expect(validateMeal({
      date: '2026-08-09', meal_type: 'dinner', recipe_id: null,
      title_override: '  ', servings_planned: 2, is_leftovers: false, notes: '',
    })).toMatch(/recipe or/i);
  });
  it('accepts a custom title meal', () => {
    expect(validateMeal({
      date: '2026-08-09', meal_type: 'dinner', recipe_id: null,
      title_override: 'Leftovers', servings_planned: 2, is_leftovers: true, notes: '',
    })).toBe(null);
  });
});
