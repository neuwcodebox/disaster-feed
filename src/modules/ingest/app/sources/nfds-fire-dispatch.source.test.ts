import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventKinds } from '@/modules/events/domain/event.enums';
import type { IRegionRepository, RegionCenter } from '../../domain/port/region-repo.interface';
import { NfdsFireDispatchSource } from './nfds-fire-dispatch.source';

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    fetch: vi.fn(),
  };
});

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

describe('NfdsFireDispatchSource', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should emit fire dispatch events for notable first incidents', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T00:00:00.000Z'));

    const responseBody = {
      nowDate: '2025-01-02 09:00:00',
      defail: [
        {
          sidoOvrNum: 'ZZ123',
          progressStat: 'A',
          progressNm: '화재접수',
          cntrNm: '중앙소방서',
          overDate: '09:00',
          addr: '서울특별시 강남구',
          sidoNm: '서울',
          lawSidoCd: '11',
          lawGunguCd: '680',
          lawDongCd: '103',
          lawRiCd: '00',
        },
      ],
    };

    const { Response, fetch } = await import('undici');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const regionRepository = createRegionRepository();
    regionRepository.findCentersByCodes.mockResolvedValue(new Map());

    const source = new NfdsFireDispatchSource(regionRepository);
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].kind).toBe(EventKinds.Fire);
    expect(result.events[0].title).toBe('중앙소방서 화재접수');
    expect(result.events[0].regionCodes).toEqual(['1168010300']);
  });
});
