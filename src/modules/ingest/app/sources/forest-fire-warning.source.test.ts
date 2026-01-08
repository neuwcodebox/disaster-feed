import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventLevels } from '@/modules/events/domain/event.enums';
import { ForestFireWarningSource } from './forest-fire-warning.source';

describe('ForestFireWarningSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should emit event when national warning changes', async () => {
    const responseBody = {
      fireWarningList: [
        {
          frfr_wrnng_step_cd: '경계',
          frfr_wrnng_issu_dtm: '2025-01-02 12:00:00',
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
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('전국 산불경보 경계 단계 발령');
    expect(result.events[0].level).toBe(EventLevels.Moderate);
    expect(result.events[0].occurredAt).toBe('2025-01-02T03:00:00.000Z');
    expect(result.nextState).not.toBeNull();

    const repeated = await source.run(result.nextState);
    expect(repeated.events).toHaveLength(0);
  });
});
