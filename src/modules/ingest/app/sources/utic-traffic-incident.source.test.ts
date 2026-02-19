import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventKinds } from '@/modules/events/domain/event.enums';

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    fetch: vi.fn(),
  };
});

describe('UticTrafficIncidentSource', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should parse incidents and emit events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T00:00:00.000Z'));

    const html = `
      <div class="data-box">
        <ul>
          <li>
            <div class="result_box">
              <p class="date">
                <a href="javascript:gotoMapIncident('INC1','A','127.1','37.5')">지도</a>
                2025/01/02 09:00
              </p>
              <p>&lt;사고&gt; 서초구 사고 - 1차로 통제</p>
            </div>
          </li>
        </ul>
      </div>
    `;

    const { Response, fetch } = await import('undici');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(Buffer.from(html, 'utf-8'), {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      ),
    );

    const { UticTrafficIncidentSource } = await import('./utic-traffic-incident.source');
    const source = new UticTrafficIncidentSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(3);
    expect(result.events[0].kind).toBe(EventKinds.TrafficCrash);
    expect(result.events[0].title).toBe('<사고> 서초구 사고');
    expect(result.events[0].geo).toEqual({ lat: 37.5, lng: 127.1 });
  });
});
