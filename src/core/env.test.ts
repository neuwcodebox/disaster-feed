import { describe, expect, it } from 'vitest';
import { env } from '@/core/env';

describe('env', () => {
  it('should have NODE_ENV set to test in test environment', () => {
    expect(env.NODE_ENV).toBe('test');
  });
});
