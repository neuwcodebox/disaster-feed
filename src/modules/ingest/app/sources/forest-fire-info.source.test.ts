import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventLevels } from '@/modules/events/domain/event.enums';
import { ForestFireInfoSource } from './forest-fire-info.source';

describe('ForestFireInfoSource', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should emit fire event with step-based level', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T00:00:00.000Z'));

    const responseBody = {
      fireShowInfoList: [
        {
          frfrInfoId: 'fire-1',
          frfrPrgrsStcdNm: '진화중',
          frfrStepIssuNm: '2단계',
          frfrSttmnAddr: '강원도 속초시',
          frfrSttmnAddrDe: '강원도 속초시 대포동 산1',
          frfrFrngDtm: '2025-01-02 06:00:00',
          frfrLctnXcrd: '128.6',
          frfrLctnYcrd: '38.2',
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

    const source = new ForestFireInfoSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toContain('산불');
    expect(result.events[0].title).toContain('강원도 속초시');
    expect(result.events[0].level).toBe(EventLevels.Severe);
    expect(result.events[0].occurredAt).toBe('2025-01-01T21:00:00.000Z');
    expect(result.events[0].regionText).toBe('강원도 속초시 대포동 산1');
    expect(result.events[0].geo).toEqual({ lat: 38.2, lng: 128.6 });
  });

  it('should use server time when fire already emitted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T00:00:00.000Z'));

    const responseBody = {
      fireShowInfoList: [
        {
          frfrInfoId: 'fire-1',
          frfrPrgrsStcdNm: '진화중',
          frfrStepIssuNm: '2단계',
          frfrSttmnAddr: '강원도 속초시',
          frfrSttmnAddrDe: '강원도 속초시 대포동 산1',
          frfrFrngDtm: '2025-01-01 06:00:00',
          frfrLctnXcrd: '128.6',
          frfrLctnYcrd: '38.2',
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

    const state = JSON.stringify({
      seen: {
        'fire-1|reported|unknown': '2025-01-01T23:00:00.000Z',
      },
      highLevelSent: {},
    });

    const source = new ForestFireInfoSource();
    const result = await source.run(state);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].occurredAt).toBe('2025-01-02T00:00:00.000Z');
  });

  it('should prefer detailed address and map initial step name to minor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-19T06:00:00.000Z'));

    const responseBody = {
      fireShowInfoList: [
        {
          frfrInfoId: 'fire-2',
          frfrPrgrsStcdNm: '진화중',
          frfrStepIssuNm: '초기 대응',
          frfrSttmnAddr: '대전광역시 대덕구 삼정동',
          frfrSttmnAddrDe: '대전광역시 대덕구 삼정동 산17-1임',
          frfrFrngDtm: '2026-02-19 11:10:49',
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

    const source = new ForestFireInfoSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].level).toBe(EventLevels.Minor);
    expect(result.events[0].regionText).toBe('대전광역시 대덕구 삼정동 산17-1임');
    expect(result.events[0].body).toContain('주소: 대전광역시 대덕구 삼정동 산17-1임');
    expect(result.events[0].body).toContain('대응 단계: 초기 대응');
  });

  it('should fallback occurredAt and geo to statement fields', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-19T06:00:00.000Z'));

    const responseBody = {
      fireShowInfoList: [
        {
          frfrInfoId: 'fire-3',
          frfrPrgrsStcdNm: '진화중',
          frfrStepIssuNm: '2단계',
          frfrSttmnAddrDe: '대전광역시 유성구 대정동 산55-35 임',
          frfrSttmnDt: '20260219',
          frfrSttmnHms: '133252',
          frfrSttmnLctnXcrd: '127.30520218650074',
          frfrSttmnLctnYcrd: '36.31466400509357',
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

    const source = new ForestFireInfoSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].occurredAt).toBe('2026-02-19T04:32:52.000Z');
    expect(result.events[0].geo).toEqual({
      lat: 36.31466400509357,
      lng: 127.30520218650074,
    });
  });

  it('should use completed time as occurredAt when progress is completed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-19T06:00:00.000Z'));

    const responseBody = {
      fireShowInfoList: [
        {
          frfrInfoId: 'fire-4',
          frfrPrgrsStcdNm: '진화완료',
          frfrStepIssuNm: '초기 대응',
          frfrSttmnAddrDe: '대전광역시 대덕구 삼정동 산17-1임',
          frfrFrngDtm: '2026-02-19 11:10:49',
          potfrCmpleDtm: '2026-02-19 11:43:00',
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

    const source = new ForestFireInfoSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].occurredAt).toBe('2026-02-19T02:43:00.000Z');
    expect(result.events[0].level).toBe(EventLevels.Info);
  });

  it('should map progress and step labels from codes when names are missing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-19T06:00:00.000Z'));

    const responseBody = {
      fireShowInfoList: [
        {
          frfrInfoId: 'fire-5',
          frfrPrgrsStcd: '02',
          frfrStepIssuCd: '02',
          frfrSttmnAddrDe: '충청남도 아산시 영인면 신현리 168-4임',
          frfrFrngDtm: '2026-02-19 13:18:04',
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

    const source = new ForestFireInfoSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].level).toBe(EventLevels.Severe);
    expect(result.events[0].title).toContain('진화중');
    expect(result.events[0].body).toContain('진행 상태: 진화중');
    expect(result.events[0].body).toContain('대응 단계: 산불 2단계');
  });

  it('should use completed progress code to pick completed time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-19T06:00:00.000Z'));

    const responseBody = {
      fireShowInfoList: [
        {
          frfrInfoId: 'fire-6',
          frfrPrgrsStcd: '03',
          frfrStepIssuCd: '01',
          frfrSttmnAddrDe: '대전광역시 대덕구 삼정동 산17-1임',
          frfrFrngDtm: '2026-02-19 11:10:49',
          potfrCmpleDtm: '2026-02-19 11:43:00',
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

    const source = new ForestFireInfoSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].occurredAt).toBe('2026-02-19T02:43:00.000Z');
    expect(result.events[0].level).toBe(EventLevels.Info);
    expect(result.events[0].body).toContain('진행 상태: 진화완료');
  });
});
