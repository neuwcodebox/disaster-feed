import type { IRegionRepository } from '@/modules/ingest/domain/port/region-repo.interface';
import { normalizeText } from './normalize';

const REGION_PREFIX_ALIASES: Record<string, string> = {
  충북: '충청북도',
  충남: '충청남도',
  전북: '전라북도',
  전남: '전라남도',
  경북: '경상북도',
  경남: '경상남도',
};

export const normalizeRegionNamePrefix = (regionText: string | null): string | null => {
  const normalized = normalizeText(regionText);
  if (!normalized) {
    return null;
  }

  return REGION_PREFIX_ALIASES[normalized] ?? normalized;
};

export const resolveRegionCodeByPrefix = async (
  regionText: string | null,
  regionRepository: IRegionRepository,
  cache: Map<string, string | null>,
): Promise<string | null> => {
  const prefix = normalizeRegionNamePrefix(regionText);
  if (!prefix) {
    return null;
  }

  if (cache.has(prefix)) {
    return cache.get(prefix) ?? null;
  }

  const code = await regionRepository.findCodeByNamePrefix(prefix);
  cache.set(prefix, code ?? null);
  return code ?? null;
};
