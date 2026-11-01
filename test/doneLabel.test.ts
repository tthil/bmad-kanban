import { describe, expect, it } from 'vitest';
import { doneLabel } from '../web/grouping.js';

describe('doneLabel', () => {
  const now = new Date(2026, 10, 1, 12, 0);
  it('leaves out the year in the current year', () => {
    expect(doneLabel(new Date(2026, 9, 28, 14, 5).toISOString(), now)).toBe('28 Oct, 14:05');
  });
  it('adds the year for another year', () => {
    expect(doneLabel(new Date(2025, 9, 28, 14, 5).toISOString(), now)).toBe('28 Oct 2025, 14:05');
  });
  it('returns null for an invalid date', () => {
    expect(doneLabel('not a date', now)).toBeNull();
  });
});
