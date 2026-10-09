import { describe, expect, it } from 'vitest';
import { sameContent } from './sync';

describe('sameContent', () => {
  it('ignores updated_by drift', () => {
    expect(sameContent(
      { id: '1', name: 'Pasta', version: 2, updated_at: 'a', updated_by: 'u1' },
      { id: '1', name: 'Pasta', version: 2, updated_at: 'a', updated_by: 'u2' },
    )).toBe(true);
  });
  it('detects real edits', () => {
    expect(sameContent({ name: 'Pasta' }, { name: 'Rice' })).toBe(false);
  });
  it('treats missing and null as equal', () => {
    expect(sameContent({ a: null }, {})).toBe(true);
  });
});
