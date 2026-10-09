import { describe, expect, it } from 'vitest';
import { decide } from './peerSync';

const row = (v: number, extra: Record<string, unknown> = {}) =>
  ({ id: 'r1', version: v, updated_at: `t${v}`, deleted_at: null, ...extra });
const base = (v: number) => ({ version: v, updated_at: `t${v}` });

describe('decide', () => {
  it('takes new rows the peer has', () => {
    expect(decide(undefined, undefined, row(1), undefined)).toBe('take-remote');
  });
  it('takes their edits when I did not touch it', () => {
    expect(decide(row(1), base(1), row(2), undefined)).toBe('take-remote');
  });
  it('keeps mine when the peer did not touch it', () => {
    expect(decide(row(2), base(1), row(1), undefined)).toBe('keep-local');
  });
  it('conflicts when both edited', () => {
    expect(decide(row(2, { name: 'A' }), base(1), row(2, { name: 'B' }), undefined)).toBe('conflict');
  });
  it('accepts their delete when I did not touch it', () => {
    expect(decide(row(1), base(1), row(1, { deleted_at: 't' }), undefined)).toBe('take-remote');
  });
  it('conflicts when I edited what they deleted', () => {
    expect(decide(row(2), base(1), row(1, { deleted_at: 't' }), undefined)).toBe('conflict');
  });
  it('does not silently resurrect what I deleted', () => {
    const tomb = { version: 5, updated_at: 't5', deleted_at: 't5' };
    expect(decide(undefined, tomb, row(6), undefined)).toBe('conflict');
    expect(decide(undefined, tomb, row(4), undefined)).toBe('adopt-new');
  });
  it('adopts their keep-theirs resolution at a bumped version', () => {
    const conflict = { mine: row(2, { name: 'A' }), theirs: row(2, { name: 'B' }) };
    expect(decide(row(2, { name: 'A' }), base(1), row(3, { name: 'B' }), conflict)).toBe('take-remote');
  });
  it('notices when the peer yields to us', () => {
    const conflict = { mine: row(2, { name: 'A' }), theirs: row(2, { name: 'B' }) };
    expect(decide(row(2, { name: 'A' }), base(1), row(3, { name: 'A' }), conflict)).toBe('take-remote');
  });
  it('refreshes (not clears) a stored conflict when the peer repeats their side', () => {
    const conflict = { mine: row(2, { name: 'A' }), theirs: row(2, { name: 'B' }) };
    expect(decide(row(2, { name: 'A' }), base(1), row(2, { name: 'B' }), conflict)).toBe('conflict');
  });
  it('conflicts on genuinely new peer edits, not resolutions', () => {
    const conflict = { mine: row(2, { name: 'A' }), theirs: row(2, { name: 'B' }) };
    expect(decide(row(2, { name: 'A' }), base(1), row(3, { name: 'C' }), conflict)).toBe('conflict');
  });
});
