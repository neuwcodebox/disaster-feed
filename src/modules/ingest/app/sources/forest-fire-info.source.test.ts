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
      frfrInfoList: [
        {
          frfr_info_id: 'fire-1',
          frfr_prgrs_stcd_str: '진화중',
          frfr_step_issu_cd: '2단계',
          frfr_sttmn_addr: '강원도 속초시',
          frfr_frng_dtm: '2025-01-02 06:00:00',
          frfr_lctn_xcrd: '128.6',
          frfr_lctn_ycrd: '38.2',
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
    expect(result.events[0].level).toBe(EventLevels.Severe);
    expect(result.events[0].occurredAt).toBe('2025-01-01T21:00:00.000Z');
    expect(result.events[0].geo).toEqual({ lat: 38.2, lng: 128.6 });
  });

  it('should use server time when fire already emitted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T00:00:00.000Z'));

    const responseBody = {
      frfrInfoList: [
        {
          frfr_info_id: 'fire-1',
          frfr_prgrs_stcd_str: '진화중',
          frfr_step_issu_cd: '2단계',
          frfr_sttmn_addr: '강원도 속초시',
          frfr_frng_dtm: '2025-01-01 06:00:00',
          frfr_lctn_xcrd: '128.6',
          frfr_lctn_ycrd: '38.2',
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
});
