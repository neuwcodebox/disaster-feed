import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventLevels } from '@/modules/events/domain/event.enums';
import { ForestFireInfoSource } from './forest-fire-info.source';

type ForestFireStateStatus = 'in_progress' | 'completed' | 'unknown';

type ForestFireSeenEntry = {
  status: ForestFireStateStatus;
  step: string | null;
  seenAt: string;
};

type ForestFireCheckpointState = {
  seen: Record<string, ForestFireSeenEntry>;
};

describe('ForestFireInfoSource', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should rebuild checkpoint without emitting events when state is null', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-19T06:00:00.000Z'));

    stubFetchSequence([
      {
        fireShowInfoList: [
          {
            frfrInfoId: 'fire-1',
            frfrPrgrsStcdNm: '진화중',
            frfrStepIssuNm: '2단계',
            frfrSttmnAddrDe: '강원도 속초시 대포동 산1',
            frfrFrngDtm: '2026-02-19 11:10:49',
            frfrLctnXcrd: '128.6',
            frfrLctnYcrd: '38.2',
          },
        ],
      },
    ]);

    const source = new ForestFireInfoSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(0);
    const nextState = readState(result.nextState);
    expect(nextState.seen['fire-1']).toEqual({
      status: 'in_progress',
      step: '2단계',
      seenAt: '2026-02-19T06:00:00.000Z',
    });
  });

  it('should rebuild checkpoint without emitting events when state parsing fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-19T06:00:00.000Z'));

    stubFetchSequence([
      {
        fireShowInfoList: [
          {
            frfrInfoId: 'fire-2',
            frfrPrgrsStcdNm: '진화중',
            frfrStepIssuNm: '초기 대응',
            frfrSttmnAddrDe: '대전광역시 대덕구 삼정동 산17-1임',
            frfrFrngDtm: '2026-02-19 11:10:49',
          },
        ],
      },
    ]);

    const source = new ForestFireInfoSource();
    const result = await source.run('{"seen":"invalid"}');

    expect(result.events).toHaveLength(0);
    const nextState = readState(result.nextState);
    expect(nextState.seen['fire-2']).toEqual({
      status: 'in_progress',
      step: '초기 대응',
      seenAt: '2026-02-19T06:00:00.000Z',
    });
  });

  it('should not emit when status and step are unchanged', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-19T06:00:00.000Z'));

    stubFetchSequence([
      {
        fireShowInfoList: [
          {
            frfrInfoId: 'fire-3',
            frfrPrgrsStcd: '02',
            frfrStepIssuCd: '02',
            frfrFrngDtm: '2026-02-19 13:18:04',
          },
        ],
      },
    ]);

    const source = new ForestFireInfoSource();
    const state = buildState({
      'fire-3': {
        status: 'in_progress',
        step: '산불 2단계',
        seenAt: '2026-02-19T05:00:00.000Z',
      },
    });
    const result = await source.run(state);

    expect(result.events).toHaveLength(0);
    const nextState = readState(result.nextState);
    expect(nextState.seen['fire-3']).toEqual({
      status: 'in_progress',
      step: '산불 2단계',
      seenAt: '2026-02-19T06:00:00.000Z',
    });
  });

  it('should emit with server time and base level when step changes during in-progress', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-19T06:00:00.000Z'));

    stubFetchSequence([
      {
        fireShowInfoList: [
          {
            frfrInfoId: 'fire-4',
            frfrPrgrsStcdNm: '진화중',
            frfrStepIssuNm: '산불 3단계',
            frfrSttmnAddrDe: '충청남도 아산시 영인면 신현리 168-4임',
            frfrFrngDtm: '2026-02-19 13:18:04',
          },
        ],
      },
    ]);

    const source = new ForestFireInfoSource();
    const state = buildState({
      'fire-4': {
        status: 'in_progress',
        step: '산불 1단계',
        seenAt: '2026-02-19T05:00:00.000Z',
      },
    });
    const result = await source.run(state);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].occurredAt).toBe('2026-02-19T06:00:00.000Z');
    expect(result.events[0].level).toBe(EventLevels.Critical);
  });

  it('should emit every transition for completed to in-progress to completed sequence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-19T06:00:00.000Z'));

    stubFetchSequence([
      {
        fireShowInfoList: [
          {
            frfrInfoId: 'fire-5',
            frfrPrgrsStcdNm: '진화중',
            frfrStepIssuNm: '산불 2단계',
            frfrSttmnAddrDe: '강원도 속초시 대포동 산1',
            frfrFrngDtm: '2026-02-19 11:10:49',
          },
        ],
      },
      {
        fireShowInfoList: [
          {
            frfrInfoId: 'fire-5',
            frfrPrgrsStcdNm: '진화완료',
            frfrStepIssuNm: '초기 대응',
            frfrSttmnAddrDe: '강원도 속초시 대포동 산1',
            frfrFrngDtm: '2026-02-19 11:10:49',
            potfrCmpleDtm: '2026-02-19 11:43:00',
          },
        ],
      },
    ]);

    const source = new ForestFireInfoSource();
    const firstState = buildState({
      'fire-5': {
        status: 'completed',
        step: '초기 대응',
        seenAt: '2026-02-19T05:00:00.000Z',
      },
    });
    const reigniteResult = await source.run(firstState);

    expect(reigniteResult.events).toHaveLength(1);
    expect(reigniteResult.events[0].occurredAt).toBe('2026-02-19T06:00:00.000Z');
    expect(reigniteResult.events[0].level).toBe(EventLevels.Severe);

    const completedResult = await source.run(reigniteResult.nextState);
    expect(completedResult.events).toHaveLength(1);
    expect(completedResult.events[0].occurredAt).toBe('2026-02-19T02:43:00.000Z');
    expect(completedResult.events[0].level).toBe(EventLevels.Info);
  });

  it('should use fire time for first in-progress event and fallback to now when missing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-19T06:00:00.000Z'));

    stubFetchSequence([
      {
        fireShowInfoList: [
          {
            frfrInfoId: 'fire-6',
            frfrPrgrsStcdNm: '진화중',
            frfrStepIssuCd: '02',
            frfrSttmnAddrDe: '대전광역시 유성구 대정동 산55-35 임',
            frfrFrngDtm: '2026-02-19 13:18:04',
          },
          {
            frfrInfoId: 'fire-7',
            frfrPrgrsStcdNm: '진화중',
            frfrStepIssuNm: '초기 대응',
            frfrSttmnAddrDe: '대전광역시 대덕구 삼정동 산17-1임',
          },
        ],
      },
    ]);

    const source = new ForestFireInfoSource();
    const state = buildState({
      'another-fire': {
        status: 'unknown',
        step: null,
        seenAt: '2026-02-19T05:00:00.000Z',
      },
    });
    const result = await source.run(state);

    expect(result.events).toHaveLength(2);
    expect(result.events[0].occurredAt).toBe('2026-02-19T04:18:04.000Z');
    expect(result.events[0].level).toBe(EventLevels.Severe);
    expect(result.events[1].occurredAt).toBe('2026-02-19T06:00:00.000Z');
  });

  it('should use server time when completed time is missing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-19T06:00:00.000Z'));

    stubFetchSequence([
      {
        fireShowInfoList: [
          {
            frfrInfoId: 'fire-8',
            frfrPrgrsStcdNm: '산불외종료',
            frfrStepIssuNm: '초기 대응',
            frfrSttmnAddrDe: '대전광역시 대덕구 삼정동 산17-1임',
          },
        ],
      },
    ]);

    const source = new ForestFireInfoSource();
    const state = buildState({
      'fire-8': {
        status: 'in_progress',
        step: '초기 대응',
        seenAt: '2026-02-19T05:00:00.000Z',
      },
    });
    const result = await source.run(state);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].occurredAt).toBe('2026-02-19T06:00:00.000Z');
    expect(result.events[0].level).toBe(EventLevels.Info);
  });
});

function stubFetchSequence(bodies: unknown[]): void {
  const fetchMock = vi.fn();
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
  vi.stubGlobal('fetch', fetchMock);
}

function buildState(seen: Record<string, ForestFireSeenEntry>): string {
  return JSON.stringify({ seen });
}

function readState(state: string | null): ForestFireCheckpointState {
  if (!state) {
    throw new Error('Checkpoint state is missing');
  }
  return JSON.parse(state) as ForestFireCheckpointState;
}
