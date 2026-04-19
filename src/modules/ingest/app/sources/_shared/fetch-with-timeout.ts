import { Agent, type RequestInit as UndiciRequestInit, fetch as undiciFetch } from 'undici';
import { logger } from '@/core/logger';

const INSECURE_DISPATCHER = new Agent({ connect: { rejectUnauthorized: false } });

type FetchHeaders = Record<string, string>;

type FetchInit = {
  method?: string;
  headers?: HeadersInit;
  body?: string;
  signal?: AbortSignal;
};

export type FetchResponseHeaders = Pick<Headers, 'get'>;

export type FetchResponse = {
  ok: boolean;
  status: number;
  headers: FetchResponseHeaders;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
};

type FetchWithTimeoutOptions = {
  url: string;
  init?: FetchInit;
  timeoutMs?: number;
  allowNonOk?: boolean;
  useInsecureTls?: boolean;
};

export const fetchWithTimeout = async (options: FetchWithTimeoutOptions): Promise<FetchResponse | null> => {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 10000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const initWithSignal: FetchInit = options.init
    ? { ...options.init, signal: controller.signal }
    : { signal: controller.signal };
  const headers = new Headers(initWithSignal.headers);
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', 'Mozilla/5.0');
  }
  const normalizedHeaders = buildHeaders(headers);
  initWithSignal.headers = normalizedHeaders;

  try {
    const response = options.useInsecureTls
      ? await undiciFetch(options.url, {
          ...initWithSignal,
          headers: normalizedHeaders,
          dispatcher: INSECURE_DISPATCHER,
        } satisfies UndiciRequestInit)
      : await fetch(options.url, initWithSignal);

    const allowNonOk = options.allowNonOk ?? false;
    if (!response.ok) {
      if (!allowNonOk) {
        logger.warn({ status: response.status, url: options.url }, 'Fetch request failed');
        return null;
      }
      return response;
    }

    return response;
  } catch (error) {
    logger.warn(error, 'Fetch request error');
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

function buildHeaders(headers: Headers): FetchHeaders {
  const nextHeaders: FetchHeaders = {};

  for (const [key, value] of headers.entries()) {
    nextHeaders[key] = value;
  }

  return nextHeaders;
}
