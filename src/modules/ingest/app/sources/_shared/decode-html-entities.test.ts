import { describe, expect, it } from 'vitest';
import { decodeHtmlEntities } from './decode-html-entities';

describe('decodeHtmlEntities', () => {
  it('should decode named, decimal, and hexadecimal entities', () => {
    expect(decodeHtmlEntities('&lt;경보&nbsp;&#9312;&#x2461;&gt;')).toBe('<경보 ①②>');
  });

  it('should decode escaped entities up to max passes', () => {
    expect(decodeHtmlEntities('&amp;#9312;')).toBe('&#9312;');
    expect(decodeHtmlEntities('&amp;#9312;', { maxPasses: 2 })).toBe('①');
  });

  it('should keep unknown and invalid entities unchanged', () => {
    expect(decodeHtmlEntities('&unknown; &#9999999999;')).toBe('&unknown; &#9999999999;');
  });
});
