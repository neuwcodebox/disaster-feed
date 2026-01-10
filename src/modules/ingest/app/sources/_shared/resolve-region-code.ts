import type { IRegionRepository } from '@/modules/ingest/domain/port/region-repo.interface';

const REGION_ALIASES: Record<string, string> = {
  충북: '충청북도',
  충남: '충청남도',
  전북: '전북특별자치도',
  전라북도: '전북특별자치도',
  전남: '전라남도',
  경북: '경상북도',
  경남: '경상남도',
  제주도: '제주특별자치도',
  강원도: '강원특별자치도',
};

export function normalizeRegionName(regionText: string | null): string | null {
  const normalized = regionText?.trim();
  if (!normalized) {
    return null;
  }

  for (const [alias, fullName] of Object.entries(REGION_ALIASES)) {
    if (normalized === alias) {
      return fullName;
    }
    if (normalized.startsWith(`${alias} `)) {
      return `${fullName}${normalized.slice(alias.length)}`;
    }
  }

  return normalized;
}

export const resolveRegionCodeByPrefix = async (
  regionText: string | null,
  regionRepository: IRegionRepository,
  cache: Map<string, string | null>,
): Promise<string | null> => {
  const regionName = normalizeRegionName(regionText);
  if (!regionName) {
    return null;
  }

  if (cache.has(regionName)) {
    return cache.get(regionName) ?? null;
  }

  const prefixCode = await regionRepository.findCodeByNamePrefix(regionName);
  if (prefixCode) {
    cache.set(regionName, prefixCode);
    return prefixCode;
  }

  const postfixCode = await regionRepository.findCodeByNamePostfix(regionName);
  cache.set(regionName, postfixCode ?? null);
  return postfixCode ?? null;
};
