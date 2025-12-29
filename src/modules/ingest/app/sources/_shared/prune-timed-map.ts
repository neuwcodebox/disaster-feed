export const pruneTimedMap = (items: Map<string, string>, nowMs: number, ttlMs: number): void => {
  for (const [key, value] of items) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || nowMs - parsed > ttlMs) {
      items.delete(key);
    }
  }
};
