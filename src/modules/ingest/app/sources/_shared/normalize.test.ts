import { describe, expect, it } from 'vitest';
import { normalizeNumber, normalizeText } from './normalize';

describe('normalizeText', () => {
  it('should trim whitespace and collapse spaces', () => {
    expect(normalizeText('  서울  특별시  ')).toBe('서울 특별시');
  });

  it('should return null for empty or dash values', () => {
    expect(normalizeText('   ')).toBeNull();
    expect(normalizeText('-')).toBeNull();
    expect(normalizeText(null)).toBeNull();
    expect(normalizeText(undefined)).toBeNull();
  });
});

describe('normalizeNumber', () => {
  it('should return null when value is undefined', () => {
    expect(normalizeNumber(undefined)).toBeNull();
  });

  it('should return null for non-finite values', () => {
    expect(normalizeNumber(Number.NaN)).toBeNull();
    expect(normalizeNumber(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('should return the value for finite numbers', () => {
    expect(normalizeNumber(0)).toBe(0);
    expect(normalizeNumber(3.5)).toBe(3.5);
  });
});
