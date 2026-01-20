import { describe, expect, it } from 'vitest';
import { resolveDateOnlyWithServerTime } from './resolve-date-only-with-server-time';

describe('resolveDateOnlyWithServerTime', () => {
  it('should apply server time when the date matches today', () => {
    const now = new Date('2026-01-15T01:02:03.004Z');

    const result = resolveDateOnlyWithServerTime({ year: 2026, month: 1, day: 15 }, now);

    expect(result).toBe(now.toISOString());
  });

  it('should return end-of-day for past dates', () => {
    const now = new Date('2026-01-15T01:02:03.004Z');

    const result = resolveDateOnlyWithServerTime({ year: 2026, month: 1, day: 14 }, now);

    expect(result).toBe(new Date('2026-01-14T23:59:59.999+09:00').toISOString());
  });

  it('should return start-of-day for future dates', () => {
    const now = new Date('2026-01-15T01:02:03.004Z');

    const result = resolveDateOnlyWithServerTime({ year: 2026, month: 1, day: 16 }, now);

    expect(result).toBe(new Date('2026-01-16T00:00:00.000+09:00').toISOString());
  });
});
