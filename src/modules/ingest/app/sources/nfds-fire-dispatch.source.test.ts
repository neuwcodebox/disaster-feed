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

  it.each([
    ['구지면', '380', '2771038021', '2771038000'],
    ['구지읍', '268', '2771026821', '2771026800'],
  ])('should preserve a supplied %s ri code when using its parent for coordinates', async (name, dong, code, parent) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T01:00:00Z'));
    const addr = `대구광역시 달성군 ${name} 창리`;
    const { Response, fetch } = await import('undici');
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          nowDate: '2026-11-24 10:00:00',
          defail: [
            {
              sidoOvrNum: 'ZZ123',
              progressStat: 'A',
              progressNm: '화재접수',
              overDate: '10:00',
              addr,
              lawSidoCd: '27',
              lawGunguCd: '710',
              lawDongCd: dong,
              lawRiCd: '21',
            },
          ],
        }),
      ),
    );
    const repository = createRegionRepository();
    repository.findCentersByCodes.mockResolvedValue(
      new Map([[parent, { code: parent, centerLat: 35.657, centerLng: 128.403 }]]),
    );
    const result = await new NfdsFireDispatchSource(repository).run(null);
    expect(repository.findCentersByCodes).toHaveBeenCalledWith([code, parent, '2771000000']);
    expect(result.events[0]).toMatchObject({
      regionText: addr,
      regionCodes: [code],
      geo: { lat: 35.657, lng: 128.403 },
    });
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

  it('should accept incidents without sidoNm', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-02T12:00:00.000Z'));

    const responseBody = {
      nowDate: '2026-07-02 21:00:00',
      defail: [
        {
          sidoOvrNum: '1U1212261110',
          progressStat: 'A',
          progressNm: '화재접수',
          cntrNm: '무안소방서',
          overDate: '21:00',
          addr: '전남광주통합특별시 무안군 일로읍 광암리',
          lawSidoCd: '12',
          lawGunguCd: '840',
          lawDongCd: '250',
          lawRiCd: '21',
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
    expect(result.events[0].title).toBe('무안소방서 화재접수');
    expect(result.events[0].regionText).toBe('전남광주통합특별시 무안군 일로읍 광암리');
    expect(result.events[0].payload).toMatchObject({ sidoNm: null });
  });
});
