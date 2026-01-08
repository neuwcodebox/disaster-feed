import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventLevels } from '@/modules/events/domain/event.enums';
import { FloodAlertSource } from './flood-alert.source';

describe('FloodAlertSource', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should build flood alert events with levels and geo', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T01:00:00.000Z'));

    const baseTimeResponse = '202501020900';
    const listResponse = [
      {
        id: 'alert-1',
        obsnm: '한강',
        rvnm: '한강',
        addr: '서울특별시',
        ancdt: '202501020900',
        kind: '1',
        wl: '3.2',
        wrnwl: '2.5',
        almwl: '4.0',
        lat: '37.5',
        lon: '126.9',
      },
    ];

    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(new Response(baseTimeResponse, { status: 200 })))
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(JSON.stringify(listResponse), { status: 200, headers: { Accept: 'application/json' } }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const source = new FloodAlertSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('한강 한강 홍수 경보 발령');
    expect(result.events[0].level).toBe(EventLevels.Severe);
    expect(result.events[0].geo).toEqual({ lat: 37.5, lng: 126.9 });
    expect(result.events[0].occurredAt).toBe('2025-01-02T00:00:00.000Z');
    expect(result.nextState).not.toBeNull();
  });
});
