export function normalizeText(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0 || normalized === '-') {
    return null;
  }
  return normalized;
}

export function normalizeNumber(value: number | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  return Number.isFinite(value) ? value : null;
}
