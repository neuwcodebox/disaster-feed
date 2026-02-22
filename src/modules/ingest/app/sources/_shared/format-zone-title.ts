import { normalizeText } from './normalize';

export function formatZoneTitle(zones: string[], region?: string): string | null {
  const normalizedRegion = normalizeText(region);
  const regionLabel = normalizedRegion ? normalizedRegion.replace(/\s*권역$/, '').trim() : null;
  const normalizedZones: string[] = [];
  let hasSameAsRegionZone = false;

  for (const zone of zones) {
    const normalized = normalizeText(zone);
    if (!normalized) {
      continue;
    }

    const withoutSuffix = normalized.replace(/\s*권역$/, '').trim();
    const zoneLabel = withoutSuffix.length > 0 ? withoutSuffix : normalized;
    if (regionLabel && zoneLabel === regionLabel) {
      hasSameAsRegionZone = true;
      continue;
    }

    if (!normalizedZones.includes(zoneLabel)) {
      normalizedZones.push(zoneLabel);
    }
  }

  if (normalizedZones.length === 0) {
    if (hasSameAsRegionZone) {
      return '권역';
    }

    return null;
  }

  return `${normalizedZones.join(', ')} 권역`;
}
