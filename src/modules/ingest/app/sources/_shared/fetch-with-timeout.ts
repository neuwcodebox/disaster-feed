import { logger } from '@/core/logger';

type FetchWithTimeoutOptions = {
  url: string;
  init?: RequestInit;
  timeoutMs?: number;
};

export const fetchWithTimeout = async (options: FetchWithTimeoutOptions): Promise<Response | null> => {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 10000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const initWithSignal = options.init ? { ...options.init, signal: controller.signal } : { signal: controller.signal };
  const headers = new Headers(initWithSignal.headers);
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', 'Mozilla/5.0');
  }
  initWithSignal.headers = headers;

  try {
    const response = await fetch(options.url, initWithSignal);
    if (!response.ok) {
      logger.warn({ status: response.status, url: options.url }, 'Fetch request failed');
      return null;
    }

    return response;
  } catch (error) {
    logger.warn({ error, url: options.url }, 'Fetch request error');
    return null;
  } finally {
    clearTimeout(timeout);
  }
};
