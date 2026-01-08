import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithTimeout } from './fetch-with-timeout';

describe('fetchWithTimeout', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should return response and set default user agent header', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('User-Agent')).toBe('Mozilla/5.0');
      return Promise.resolve(new Response('ok', { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithTimeout({ url: 'https://example.com' });

    expect(response).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('should return null on non-ok responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('no', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithTimeout({ url: 'https://example.com' });

    expect(response).toBeNull();
  });

  it('should return null on fetch errors', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network'));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithTimeout({ url: 'https://example.com' });

    expect(response).toBeNull();
  });
});
