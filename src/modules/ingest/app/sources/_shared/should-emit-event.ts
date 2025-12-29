export const shouldEmitEvent = (lastSeen: string | undefined, nowMs: number, ttlMs: number): boolean => {
  if (!lastSeen) {
    return true;
  }

  const parsed = Date.parse(lastSeen);
  if (!Number.isFinite(parsed)) {
    return true;
  }

  return nowMs - parsed > ttlMs;
};
