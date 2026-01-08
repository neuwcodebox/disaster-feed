import { describe, expect, it } from 'vitest';
import { isTooOld } from './is-too-old';

describe('isTooOld', () => {
  it('should return false for missing or invalid timestamps', () => {
    expect(isTooOld(null, Date.now(), 1000)).toBe(false);
    expect(isTooOld('not-a-date', Date.now(), 1000)).toBe(false);
  });

  it('should return true when the timestamp exceeds max age', () => {
    const nowMs = Date.parse('2025-01-02T00:00:00.000Z');
    const occurredAt = '2025-01-01T00:00:00.000Z';

    expect(isTooOld(occurredAt, nowMs, 1000 * 60 * 60)).toBe(true);
    expect(isTooOld(occurredAt, nowMs, 1000 * 60 * 60 * 24)).toBe(false);
  });
});
