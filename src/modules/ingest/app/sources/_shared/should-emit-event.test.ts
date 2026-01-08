import { describe, expect, it } from 'vitest';
import { shouldEmitEvent } from './should-emit-event';

describe('shouldEmitEvent', () => {
  it('should return true when no previous timestamp exists', () => {
    expect(shouldEmitEvent(undefined, Date.now(), 1000)).toBe(true);
  });

  it('should return true for invalid timestamps', () => {
    expect(shouldEmitEvent('invalid', Date.now(), 1000)).toBe(true);
  });

  it('should respect ttl for valid timestamps', () => {
    const nowMs = Date.parse('2025-01-02T00:00:00.000Z');
    const recent = '2025-01-01T23:59:30.000Z';
    const old = '2025-01-01T22:00:00.000Z';

    expect(shouldEmitEvent(recent, nowMs, 1000 * 60)).toBe(false);
    expect(shouldEmitEvent(old, nowMs, 1000 * 60)).toBe(true);
  });
});
