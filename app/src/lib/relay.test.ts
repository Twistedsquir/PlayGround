import { describe, expect, it } from 'vitest';
import { CODE_ALPHABET, newPairCode, normalizeCode, roomTopic } from './relay';

describe('pairing codes', () => {
  it('generates 6 unambiguous characters', () => {
    for (let i = 0; i < 50; i++) {
      const c = newPairCode();
      expect(c).toHaveLength(6);
      expect([...c].every((ch) => CODE_ALPHABET.includes(ch))).toBe(true);
    }
  });
  it('normalizes typos and lookalikes', () => {
    expect(normalizeCode(' ab-cd12 ')).toBe('ABCD2');
    expect(normalizeCode('0ol1')).toBe('QQL');
  });
  it('namespaces relay topics per app version', () => {
    expect(roomTopic('ABCDEF')).toBe('family-meals-v1-ABCDEF');
    expect(roomTopic('abcdef')).toBe('family-meals-v1-ABCDEF');
  });
});
