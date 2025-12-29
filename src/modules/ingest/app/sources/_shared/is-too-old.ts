export const isTooOld = (occurredAt: string | null, nowMs: number, maxAgeMs: number): boolean => {
  if (!occurredAt) {
    return false;
  }

  const parsed = Date.parse(occurredAt);
  if (!Number.isFinite(parsed)) {
    return false;
  }

  return nowMs - parsed > maxAgeMs;
};
