import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');

  return {
    ...actual,
    fetch: vi.fn(async () => new actual.Response('ok', { status: 200 })),
  };
});

import { fetchWithTimeout } from './fetch-with-timeout';

describe('fetchWithTimeout', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
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

  it('should return response on non-ok responses when allowNonOk is true', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('no', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithTimeout({ url: 'https://example.com', allowNonOk: true });

    expect(response).not.toBeNull();
    expect(response?.status).toBe(404);
  });

  it('should return null on fetch errors', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network'));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithTimeout({ url: 'https://example.com' });

    expect(response).toBeNull();
  });

  it('should use undici fetch and dispatcher when useInsecureTls is true', async () => {
    const globalFetchMock = vi.fn();
    vi.stubGlobal('fetch', globalFetchMock);

    const { fetch: undiciFetch } = await import('undici');

    const response = await fetchWithTimeout({ url: 'https://example.com', useInsecureTls: true });

    expect(response).not.toBeNull();
    expect(globalFetchMock).not.toHaveBeenCalled();
    expect(undiciFetch).toHaveBeenCalledOnce();

    const mockedFetch = vi.mocked(undiciFetch);
    const init = mockedFetch.mock.calls[0]?.[1];
    expect(init).toBeDefined();
    expect(init && 'dispatcher' in init).toBe(true);
  });
});
