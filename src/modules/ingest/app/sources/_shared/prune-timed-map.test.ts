import { describe, expect, it } from 'vitest';
import { pruneTimedMap } from './prune-timed-map';

describe('pruneTimedMap', () => {
  it('should drop expired or invalid timestamps', () => {
    const nowMs = Date.parse('2025-01-02T00:00:00.000Z');
    const map = new Map<string, string>([
      ['fresh', '2025-01-01T23:59:30.000Z'],
      ['expired', '2025-01-01T22:00:00.000Z'],
      ['invalid', 'not-a-date'],
    ]);

    pruneTimedMap(map, nowMs, 1000 * 60);

    expect(map.has('fresh')).toBe(true);
    expect(map.has('expired')).toBe(false);
    expect(map.has('invalid')).toBe(false);
  });
});
