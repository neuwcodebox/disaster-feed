import { describe, expect, it, vi } from 'vitest';
import type { IRegionRepository, RegionCenter } from '@/modules/ingest/domain/port/region-repo.interface';
import { normalizeRegionName, resolveRegionCodeByPrefix } from './resolve-region-code';

type RegionRepositoryMocks = {
  findCodeByNamePrefix: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
  findCodeByNamePostfix: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
  findCentersByCodes: ReturnType<typeof vi.fn<() => Promise<Map<string, RegionCenter>>>>;
};

const createRegionRepository = (): RegionRepositoryMocks & IRegionRepository => ({
  findCodeByNamePrefix: vi.fn<() => Promise<string | null>>(),
  findCodeByNamePostfix: vi.fn<() => Promise<string | null>>(),
  findCentersByCodes: vi.fn<() => Promise<Map<string, RegionCenter>>>(),
});

describe('normalizeRegionName', () => {
  it('should normalize aliases and prefix matches without changing their era', () => {
    expect(normalizeRegionName('충북')).toBe('충청북도');
    expect(normalizeRegionName('충북 청주시')).toBe('충청북도 청주시');
    expect(normalizeRegionName('전남 신안군')).toBe('전라남도 신안군');
    expect(normalizeRegionName('서울특별시')).toBe('서울특별시');
  });

  it('should keep full province names intact', () => {
    expect(normalizeRegionName('전북특별자치도')).toBe('전북특별자치도');
    expect(normalizeRegionName('전남광주통합특별시')).toBe('전남광주통합특별시');
  });

  it('should return null for blank values', () => {
    expect(normalizeRegionName('   ')).toBeNull();
    expect(normalizeRegionName(null)).toBeNull();
  });
});

describe('resolveRegionCodeByPrefix', () => {
  it('should short-circuit when region text is empty', async () => {
    const repository = createRegionRepository();
    const cache = new Map<string, string | null>();

    const result = await resolveRegionCodeByPrefix(null, repository, cache);

    expect(result).toBeNull();
    expect(repository.findCodeByNamePrefix).not.toHaveBeenCalled();
    expect(repository.findCodeByNamePostfix).not.toHaveBeenCalled();
  });

  it('should resolve prefix code and cache result', async () => {
    const repository = createRegionRepository();
    repository.findCodeByNamePrefix.mockResolvedValue('1100000000');

    const cache = new Map<string, string | null>();
    const result = await resolveRegionCodeByPrefix('서울', repository, cache);

    expect(result).toBe('1100000000');
    expect(repository.findCodeByNamePrefix).toHaveBeenCalledTimes(1);
    expect(repository.findCodeByNamePostfix).not.toHaveBeenCalled();

    const cached = await resolveRegionCodeByPrefix('서울', repository, cache);
    expect(cached).toBe('1100000000');
    expect(repository.findCodeByNamePrefix).toHaveBeenCalledTimes(1);
  });

  it('should fall back to postfix when prefix misses', async () => {
    const repository = createRegionRepository();
    repository.findCodeByNamePrefix.mockResolvedValue(null);
    repository.findCodeByNamePostfix.mockResolvedValue('3100000000');

    const cache = new Map<string, string | null>();
    const result = await resolveRegionCodeByPrefix('경기 수원시', repository, cache);

    expect(result).toBe('3100000000');
    expect(repository.findCodeByNamePrefix).toHaveBeenCalledTimes(1);
    expect(repository.findCodeByNamePostfix).toHaveBeenCalledTimes(1);
  });

  it('should cache null results to avoid repeated lookups', async () => {
    const repository = createRegionRepository();
    repository.findCodeByNamePrefix.mockResolvedValue(null);
    repository.findCodeByNamePostfix.mockResolvedValue(null);

    const cache = new Map<string, string | null>();
    const first = await resolveRegionCodeByPrefix('제주도', repository, cache);
    const second = await resolveRegionCodeByPrefix('제주도', repository, cache);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(repository.findCodeByNamePrefix).toHaveBeenCalledTimes(1);
    expect(repository.findCodeByNamePostfix).toHaveBeenCalledTimes(1);
  });
});
