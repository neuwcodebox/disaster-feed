import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventLevels } from '@/modules/events/domain/event.enums';

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    fetch: vi.fn(),
  };
});

describe('KasaSpaceWeatherCrisisAlertSource', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should parse table rows and apply server time for same-day alerts', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-01-20T03:04:05.678Z');
    vi.setSystemTime(now);

    const html = `
      <div id="content">
        <table>
          <tr>
            <td>13</td>
            <td class="alignLeft">
              <a href="#" onclick="fnDetail('54673')">우주전파재난 주의 위기경보 발령 알림</a>
            </td>
            <td></td>
            <td>2026-01-20</td>
          </tr>
        </table>
      </div>
    `;

    const { Response, fetch } = await import('undici');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(() => Promise.resolve(new Response(html, { status: 200 })));

    const { KasaSpaceWeatherCrisisAlertSource } = await import('./kasa-space-weather-crisis-alert.source');
    const source = new KasaSpaceWeatherCrisisAlertSource();
    const previousState = JSON.stringify({ seen: { older: '2026-01-19T00:00:00.000Z' } });
    const result = await source.run(previousState);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('우주전파재난 주의 위기경보 발령 알림');
    expect(result.events[0].level).toBe(EventLevels.Minor);
    const expectedOccurredAt = new Date(
      2026,
      0,
      20,
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
      now.getMilliseconds(),
    ).toISOString();
    expect(result.events[0].occurredAt).toBe(expectedOccurredAt);
  });

  it('should use end-of-day time and lowest level for release notices', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-21T01:02:03.004Z'));

    const html = `
      <div id="content">
        <table>
          <tr>
            <td>12</td>
            <td class="alignLeft">
              <a href="#" onclick="fnDetail('54674')">우주전파재난 심각 위기경보 발령 해제 알림</a>
            </td>
            <td></td>
            <td>2026-01-20</td>
          </tr>
        </table>
      </div>
    `;

    const { Response, fetch } = await import('undici');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(() => Promise.resolve(new Response(html, { status: 200 })));

    const { KasaSpaceWeatherCrisisAlertSource } = await import('./kasa-space-weather-crisis-alert.source');
    const source = new KasaSpaceWeatherCrisisAlertSource();
    const previousState = JSON.stringify({ seen: { older: '2026-01-19T00:00:00.000Z' } });
    const result = await source.run(previousState);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].level).toBe(EventLevels.Info);
    const expectedOccurredAt = new Date('2026-01-20T23:59:59.999+09:00').toISOString();
    expect(result.events[0].occurredAt).toBe(expectedOccurredAt);
  });

  it('should ignore mock or training alerts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-20T03:04:05.678Z'));

    const html = `
      <div id="content">
        <table>
          <tr>
            <td>11</td>
            <td class="alignLeft">
              <a href="#" onclick="fnDetail('54675')">우주전파재난 주의 위기경보 발령 모의 훈련</a>
            </td>
            <td></td>
            <td>2026-01-20</td>
          </tr>
        </table>
      </div>
    `;

    const { Response, fetch } = await import('undici');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(() => Promise.resolve(new Response(html, { status: 200 })));

    const { KasaSpaceWeatherCrisisAlertSource } = await import('./kasa-space-weather-crisis-alert.source');
    const source = new KasaSpaceWeatherCrisisAlertSource();
    const previousState = JSON.stringify({ seen: { older: '2026-01-19T00:00:00.000Z' } });
    const result = await source.run(previousState);

    expect(result.events).toHaveLength(0);
  });

  it('should only update state on first run', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-01-20T03:04:05.678Z');
    vi.setSystemTime(now);

    const html = `
      <div id="content">
        <table>
          <tr>
            <td>13</td>
            <td class="alignLeft">
              <a href="#" onclick="fnDetail('54673')">우주전파재난 주의 위기경보 발령 알림</a>
            </td>
            <td></td>
            <td>2026-01-20</td>
          </tr>
        </table>
      </div>
    `;

    const { Response, fetch } = await import('undici');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(() => Promise.resolve(new Response(html, { status: 200 })));

    const { KasaSpaceWeatherCrisisAlertSource } = await import('./kasa-space-weather-crisis-alert.source');
    const source = new KasaSpaceWeatherCrisisAlertSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(0);
    const nextState = JSON.parse(result.nextState ?? '{}') as { seen?: Record<string, string> };
    expect(nextState.seen?.['54673']).toBe(now.toISOString());
  });
});
