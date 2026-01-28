import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventLevels } from '@/modules/events/domain/event.enums';
import { ForestFireWarningSource } from './forest-fire-warning.source';

describe('ForestFireWarningSource', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-28T03:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should only update state when there is no previous state', async () => {
    const responseBody = {
      fireWarningList: [
        {
          frfr_wrnng_id: '260',
          frfr_wrnng_step_cd: '주의',
          frfr_wrnng_rgstn_dtm: '2026-01-28 10:54:36',
          frfr_wrnng_issu_dtm: '2026-01-27 17:00',
          lgdng_ctprv_cd: '52',
          lgdng_nm: '전북특별자치도',
          lgdng_sgng_cd: '000',
        },
        {
          frfr_wrnng_id: '200',
          frfr_wrnng_step_cd: '주의',
          frfr_wrnng_rgstn_dtm: '2026-01-26 00:00:00',
          frfr_wrnng_issu_dtm: '2026-01-25 17:00',
          lgdng_ctprv_cd: '51',
          lgdng_nm: '강원특별자치도',
          lgdng_sgng_cd: '000',
        },
      ],
    };

    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const source = new ForestFireWarningSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(0);

    const state = JSON.parse(result.nextState ?? '{}') as { seen?: Record<string, string> };
    expect(state.seen?.['260']).toBeDefined();
    expect(state.seen?.['200']).toBeUndefined();
  });

  it('should group new warnings by province and step label', async () => {
    const responseBody = {
      fireWarningList: [
        {
          frfr_wrnng_id: '260',
          frfr_wrnng_step_cd: '주의',
          frfr_wrnng_rgstn_dtm: '2026-01-28 10:54:36',
          frfr_wrnng_issu_dtm: '2026-01-27 17:00',
          lgdng_ctprv_cd: '52',
          lgdng_nm: '전북특별자치도',
          loest_ara_nm: '전북특별자치도',
          lgdng_sgng_cd: '000',
        },
        {
          frfr_wrnng_id: '261',
          frfr_wrnng_step_cd: '주의',
          frfr_wrnng_rgstn_dtm: '2026-01-28 10:54:36',
          frfr_wrnng_issu_dtm: '2026-01-27 17:00',
          lgdng_ctprv_cd: '52',
          lgdng_nm: '전북특별자치도 전주시',
          loest_ara_nm: '전주시',
          lgdng_sgng_cd: '100',
        },
        {
          frfr_wrnng_id: '258',
          frfr_wrnng_step_cd: '주의',
          frfr_wrnng_rgstn_dtm: '2026-01-28 10:54:36',
          frfr_wrnng_issu_dtm: '2026-01-27 17:00',
          lgdng_ctprv_cd: '51',
          lgdng_nm: '강원특별자치도 양구군',
          loest_ara_nm: '양구군',
          lgdng_sgng_cd: '800',
        },
      ],
    };

    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const source = new ForestFireWarningSource();
    const previousState = JSON.stringify({
      seen: {
        '258': '2026-01-28T02:00:00.000Z',
      },
    });

    const result = await source.run(previousState);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('전북특별자치도 산불경보 주의 단계 발령');
    expect(result.events[0].level).toBe(EventLevels.Minor);
    expect(result.events[0].occurredAt).toBe('2026-01-28T01:54:36.000Z');
    expect(result.events[0].body).toBe('발령 시각: 2026-01-27 17:00\n대상 지역: 전북특별자치도, 전주시');
    const payload = result.events[0].payload as { items?: unknown[] } | null;
    expect(payload?.items).toHaveLength(2);
  });

  it('should split groups when issued or occurred times differ', async () => {
    const responseBody = {
      fireWarningList: [
        {
          frfr_wrnng_id: '301',
          frfr_wrnng_step_cd: '경계',
          frfr_wrnng_rgstn_dtm: '2026-01-28 10:00:00',
          frfr_wrnng_issu_dtm: '2026-01-28 09:00',
          lgdng_ctprv_cd: '52',
          lgdng_nm: '전북특별자치도',
          loest_ara_nm: '전북특별자치도',
          lgdng_sgng_cd: '000',
        },
        {
          frfr_wrnng_id: '302',
          frfr_wrnng_step_cd: '경계',
          frfr_wrnng_rgstn_dtm: '2026-01-28 10:00:00',
          frfr_wrnng_issu_dtm: '2026-01-28 09:30',
          lgdng_ctprv_cd: '52',
          lgdng_nm: '전북특별자치도 전주시',
          loest_ara_nm: '전주시',
          lgdng_sgng_cd: '100',
        },
        {
          frfr_wrnng_id: '303',
          frfr_wrnng_step_cd: '경계',
          frfr_wrnng_rgstn_dtm: '2026-01-28 11:00:00',
          frfr_wrnng_issu_dtm: '2026-01-28 09:00',
          lgdng_ctprv_cd: '52',
          lgdng_nm: '전북특별자치도 익산시',
          loest_ara_nm: '익산시',
          lgdng_sgng_cd: '300',
        },
      ],
    };

    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const source = new ForestFireWarningSource();
    const previousState = JSON.stringify({
      seen: {},
    });

    const result = await source.run(previousState);

    expect(result.events).toHaveLength(3);
    const titles = result.events.map((event) => event.title).sort();
    expect(titles).toEqual([
      '전북특별자치도 산불경보 경계 단계 발령',
      '전북특별자치도 산불경보 경계 단계 발령',
      '전북특별자치도 산불경보 경계 단계 발령',
    ]);
    const bodies = result.events.map((event) => event.body).sort();
    expect(bodies).toEqual([
      '발령 시각: 2026-01-28 09:00\n대상 지역: 익산시',
      '발령 시각: 2026-01-28 09:00\n대상 지역: 전북특별자치도',
      '발령 시각: 2026-01-28 09:30\n대상 지역: 전주시',
    ]);
  });

  it('should strip province prefix when loest_ara_nm is missing', async () => {
    const responseBody = {
      fireWarningList: [
        {
          frfr_wrnng_id: '401',
          frfr_wrnng_step_cd: '주의',
          frfr_wrnng_rgstn_dtm: '2026-01-28 12:00:00',
          frfr_wrnng_issu_dtm: '2026-01-28 11:00',
          lgdng_ctprv_cd: '26',
          lgdng_nm: '부산광역시',
          lgdng_sgng_cd: '000',
        },
        {
          frfr_wrnng_id: '402',
          frfr_wrnng_step_cd: '주의',
          frfr_wrnng_rgstn_dtm: '2026-01-28 12:00:00',
          frfr_wrnng_issu_dtm: '2026-01-28 11:00',
          lgdng_ctprv_cd: '26',
          lgdng_nm: '부산광역시 사하구',
          lgdng_sgng_cd: '290',
        },
        {
          frfr_wrnng_id: '403',
          frfr_wrnng_step_cd: '주의',
          frfr_wrnng_rgstn_dtm: '2026-01-28 12:00:00',
          frfr_wrnng_issu_dtm: '2026-01-28 11:00',
          lgdng_ctprv_cd: '26',
          lgdng_nm: '부산광역시 해운대구',
          lgdng_sgng_cd: '300',
        },
      ],
    };

    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const source = new ForestFireWarningSource();
    const previousState = JSON.stringify({
      seen: {},
    });

    const result = await source.run(previousState);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('부산광역시 산불경보 주의 단계 발령');
    expect(result.events[0].body).toBe('발령 시각: 2026-01-28 11:00\n대상 지역: 부산광역시, 사하구, 해운대구');
  });

  it('should emit national warning without grouping', async () => {
    const responseBody = {
      fireWarningList: [
        {
          frfr_wrnng_id: '225',
          frfr_wrnng_step_cd: '관심',
          frfr_wrnng_rgstn_dtm: '2026-01-28 09:00:00',
          frfr_wrnng_issu_dtm: '2026-01-28 08:30',
          lgdng_cd: '전국',
        },
      ],
    };

    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const source = new ForestFireWarningSource();
    const previousState = JSON.stringify({
      seen: {},
    });

    const result = await source.run(previousState);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('전국 산불경보 관심 단계 발령');
    expect(result.events[0].body).toBe('발령 시각: 2026-01-28 08:30');
    expect(result.events[0].regionText).toBe('전국');
  });
});
