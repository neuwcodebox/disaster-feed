import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventLevels } from '@/modules/events/domain/event.enums';

describe('OpenSkyEmergencySquawkSource', () => {
  afterEach(() => {
    delete process.env.OPENSKY_CLIENT_ID;
    delete process.env.OPENSKY_CLIENT_SECRET;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should fetch token and emit emergency squawk events', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-02-05T00:00:00.000Z');
    vi.setSystemTime(now);

    process.env.OPENSKY_CLIENT_ID = 'test-client';
    process.env.OPENSKY_CLIENT_SECRET = 'test-secret';
    vi.resetModules();
    const { OpenSkyEmergencySquawkSource } = await import('./opensky-emergency-squawk.source');

    const responseTime = Math.floor(now.getTime() / 1000);
    const states = [
      [
        '769104',
        'SIA7436 ',
        'Singapore',
        responseTime,
        responseTime,
        126.9869,
        36.2345,
        6248.4,
        false,
        196.74,
        4.95,
        -7.15,
        null,
        6256.02,
        '7700',
        false,
        0,
        2,
      ],
      [
        '782160',
        'CSN652  ',
        'China',
        responseTime,
        responseTime,
        125.2541,
        37.3973,
        7802.88,
        false,
        192.46,
        268.62,
        0,
        null,
        7757.16,
        '1200',
        false,
        0,
        2,
      ],
    ];

    const fetchMock = vi.fn().mockImplementation((url: RequestInfo) => {
      const urlText = String(url);
      if (urlText.includes('openid-connect/token')) {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: 'token-1', expires_in: 1800 }), { status: 200 }),
        );
      }
      if (urlText.includes('/api/states/all')) {
        return Promise.resolve(new Response(JSON.stringify({ time: responseTime, states }), { status: 200 }));
      }
      return Promise.resolve(new Response('', { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const source = new OpenSkyEmergencySquawkSource();
    const result = await source.run(null);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const stateCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/states/all'));
    const authHeader = new Headers(stateCalls[0]?.[1]?.headers as HeadersInit).get('Authorization');
    expect(authHeader).toBe('Bearer token-1');

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('한국 상공 SIA7436편 7700(비상사태) 선언');
    expect(result.events[0].body).toBe(
      [
        '국적: Singapore',
        '고도: 기압고도 6248m / 지오고도 6256m (공중)',
        '비행: 속도 197 m/s, 진로 5°, 상승률 -7.1 m/s',
      ].join('\n'),
    );
    expect(result.events[0].level).toBe(EventLevels.Moderate);
    const payload = result.events[0].payload as { squawk?: string };
    expect(payload.squawk).toBe('7700');
    expect(result.nextState).not.toContain('token-1');
  });

  it('should refresh token on unauthorized response', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-02-05T00:00:00.000Z');
    vi.setSystemTime(now);

    process.env.OPENSKY_CLIENT_ID = 'test-client';
    process.env.OPENSKY_CLIENT_SECRET = 'test-secret';
    vi.resetModules();
    const { OpenSkyEmergencySquawkSource } = await import('./opensky-emergency-squawk.source');

    const responseTime = Math.floor(now.getTime() / 1000);
    const states = [
      [
        '769104',
        'SIA7436 ',
        'Singapore',
        responseTime,
        responseTime,
        126.9869,
        36.2345,
        6248.4,
        false,
        196.74,
        4.95,
        -7.15,
        null,
        6256.02,
        '7500',
        false,
        0,
        2,
      ],
    ];

    let tokenCalls = 0;
    let stateCalls = 0;
    const fetchMock = vi.fn().mockImplementation((url: RequestInfo) => {
      const urlText = String(url);
      if (urlText.includes('openid-connect/token')) {
        tokenCalls += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: `token-${tokenCalls}`, expires_in: 1800 }), { status: 200 }),
        );
      }
      if (urlText.includes('/api/states/all')) {
        stateCalls += 1;
        if (stateCalls === 1) {
          return Promise.resolve(new Response('', { status: 401 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ time: responseTime, states }), { status: 200 }));
      }
      return Promise.resolve(new Response('', { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const source = new OpenSkyEmergencySquawkSource();
    const result = await source.run(null);

    expect(tokenCalls).toBe(2);
    expect(stateCalls).toBe(2);
    const stateRequests = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/states/all'));
    const authHeaders = stateRequests.map(([, init]) => new Headers(init?.headers as HeadersInit).get('Authorization'));
    expect(authHeaders).toEqual(['Bearer token-1', 'Bearer token-2']);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('한국 상공 SIA7436편 7500(하이재킹) 선언');
    expect(result.events[0].body).toBe(
      [
        '국적: Singapore',
        '고도: 기압고도 6248m / 지오고도 6256m (공중)',
        '비행: 속도 197 m/s, 진로 5°, 상승률 -7.1 m/s',
      ].join('\n'),
    );
    expect(result.events[0].level).toBe(EventLevels.Severe);
    expect(result.nextState).not.toContain('token-2');
  });
});
