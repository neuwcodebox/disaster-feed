import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventLevels } from '@/modules/events/domain/event.enums';

describe('OpenSkyEmergencySquawkSource', () => {
  afterEach(() => {
    delete process.env.OPENSKY_CLIENT_ID;
    delete process.env.OPENSKY_CLIENT_SECRET;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should emit emergency squawk events only after the code persists for 10 minutes', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-02-05T00:00:00.000Z');
    vi.setSystemTime(now);

    process.env.OPENSKY_CLIENT_ID = 'test-client';
    process.env.OPENSKY_CLIENT_SECRET = 'test-secret';
    vi.resetModules();
    const { OpenSkyEmergencySquawkSource } = await import('./opensky-emergency-squawk.source');

    const currentSquawk = '7700';
    const fetchMock = createOpenSkyFetchMock({
      resolveStates() {
        return [buildOpenSkyState(currentSquawk)];
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const source = new OpenSkyEmergencySquawkSource();

    const firstRun = await source.run(null);
    expect(firstRun.events).toHaveLength(0);

    vi.setSystemTime(new Date(now.getTime() + 9 * 60 * 1000));
    const secondRun = await source.run(firstRun.nextState);
    expect(secondRun.events).toHaveLength(0);

    vi.setSystemTime(new Date(now.getTime() + 10 * 60 * 1000));
    const thirdRun = await source.run(secondRun.nextState);
    expect(thirdRun.events).toHaveLength(1);
    expect(thirdRun.events[0].title).toBe('한국 상공 SIA7436편 7700(비상사태) 선언');
    expect(thirdRun.events[0].body).toBe(
      [
        '국적: Singapore',
        '고도: 기압고도 6248m / 지오고도 6256m (공중)',
        '비행: 속도 197 m/s, 진로 5°, 상승률 -7.1 m/s',
      ].join('\n'),
    );
    expect(thirdRun.events[0].level).toBe(EventLevels.Moderate);
    const payload = thirdRun.events[0].payload as { squawk?: string };
    expect(payload.squawk).toBe('7700');
    expect(thirdRun.nextState).not.toContain('token-1');

    vi.setSystemTime(new Date(now.getTime() + 15 * 60 * 1000));
    const fourthRun = await source.run(thirdRun.nextState);
    expect(fourthRun.events).toHaveLength(0);
  });

  it('should reset pending state when squawk changes before confirmation', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-02-05T00:00:00.000Z');
    vi.setSystemTime(now);

    process.env.OPENSKY_CLIENT_ID = 'test-client';
    process.env.OPENSKY_CLIENT_SECRET = 'test-secret';
    vi.resetModules();
    const { OpenSkyEmergencySquawkSource } = await import('./opensky-emergency-squawk.source');

    let currentSquawk = '7700';
    const fetchMock = createOpenSkyFetchMock({
      resolveStates() {
        return [buildOpenSkyState(currentSquawk)];
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const source = new OpenSkyEmergencySquawkSource();

    const firstRun = await source.run(null);
    expect(firstRun.events).toHaveLength(0);

    vi.setSystemTime(new Date(now.getTime() + 4 * 60 * 1000));
    currentSquawk = '7600';
    const secondRun = await source.run(firstRun.nextState);
    expect(secondRun.events).toHaveLength(0);

    vi.setSystemTime(new Date(now.getTime() + 13 * 60 * 1000));
    const thirdRun = await source.run(secondRun.nextState);
    expect(thirdRun.events).toHaveLength(0);

    vi.setSystemTime(new Date(now.getTime() + 14 * 60 * 1000));
    const fourthRun = await source.run(thirdRun.nextState);
    expect(fourthRun.events).toHaveLength(1);
    expect(fourthRun.events[0].title).toBe('한국 상공 SIA7436편 7600(통신장애) 선언');
    expect(fourthRun.events[0].level).toBe(EventLevels.Minor);
  });

  it('should refresh token on unauthorized response', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-02-05T00:00:00.000Z');
    vi.setSystemTime(now);

    process.env.OPENSKY_CLIENT_ID = 'test-client';
    process.env.OPENSKY_CLIENT_SECRET = 'test-secret';
    vi.resetModules();
    const { OpenSkyEmergencySquawkSource } = await import('./opensky-emergency-squawk.source');

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
        const responseTime = Math.floor(Date.now() / 1000);
        return Promise.resolve(
          new Response(JSON.stringify({ time: responseTime, states: [buildOpenSkyState('7500', responseTime)] }), {
            status: 200,
          }),
        );
      }
      return Promise.resolve(new Response('', { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const source = new OpenSkyEmergencySquawkSource();
    const checkpointState = JSON.stringify({
      tracked: {
        '769104': {
          squawk: '7500',
          firstObservedAt: new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
          emittedAt: null,
        },
      },
    });

    const result = await source.run(checkpointState);

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

function createOpenSkyFetchMock(options: { resolveStates: () => unknown[][] }): ReturnType<typeof vi.fn> {
  let tokenCalls = 0;

  return vi.fn().mockImplementation((url: RequestInfo) => {
    const urlText = String(url);
    if (urlText.includes('openid-connect/token')) {
      tokenCalls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: `token-${tokenCalls}`, expires_in: 1800 }), { status: 200 }),
      );
    }
    if (urlText.includes('/api/states/all')) {
      const responseTime = Math.floor(Date.now() / 1000);
      return Promise.resolve(
        new Response(JSON.stringify({ time: responseTime, states: options.resolveStates() }), { status: 200 }),
      );
    }
    return Promise.resolve(new Response('', { status: 404 }));
  });
}

function buildOpenSkyState(squawk: string, responseTime = Math.floor(Date.now() / 1000)): unknown[] {
  return [
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
    squawk,
    false,
    0,
    2,
  ];
}
