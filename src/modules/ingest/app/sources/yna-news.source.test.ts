import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventKinds } from '@/modules/events/domain/event.enums';
import type { LlmLabelClassifierService } from '../llm-label-classifier.service';

type MockClassifier = Pick<LlmLabelClassifierService, 'isEnabled' | 'classifyBatch'>;

describe('YnaNewsSource', () => {
  afterEach(() => {
    delete process.env.YNA_SERVICE_KEY;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should initialize checkpoint and not emit events on first run', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T03:00:00.000Z'));

    process.env.YNA_SERVICE_KEY = 'test-key';
    vi.resetModules();
    const { YnaNewsSource } = await import('./yna-news.source');

    const responseBody = {
      header: { resultCode: '00', resultMsg: 'OK' },
      numOfRows: 1,
      pageNo: 1,
      totalCount: 1,
      body: [
        {
          YNA_NO: 123,
          YNA_TTL: '호우로 인한 침수 발생',
          YNA_CN: '침수 피해가 보고되었습니다.',
          YNA_YMD: '20250102',
          CRT_DT: '2025-01-02 11:00:00',
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

    const classifier: MockClassifier = {
      isEnabled: vi.fn(() => true),
      classifyBatch: vi.fn(() => Promise.resolve(new Map([['123', '호우']]))),
    };

    const source = new YnaNewsSource(classifier);
    const result = await source.run(null);

    expect(result.events).toHaveLength(0);
    expect(classifier.classifyBatch).not.toHaveBeenCalled();

    const parsedState = JSON.parse(result.nextState ?? '{}') as {
      version?: number;
      seen?: Record<string, string>;
    };
    expect(parsedState.version).toBe(2);
    expect(parsedState.seen?.['호우로 인한 침수 발생']).toBe('2025-01-02T03:00:00.000Z');
  });

  it('should classify and emit news events when state is initialized', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T03:00:00.000Z'));

    process.env.YNA_SERVICE_KEY = 'test-key';
    vi.resetModules();
    const { YnaNewsSource } = await import('./yna-news.source');

    const responseBody = {
      header: { resultCode: '00', resultMsg: 'OK' },
      numOfRows: 1,
      pageNo: 1,
      totalCount: 1,
      body: [
        {
          YNA_NO: 123,
          YNA_TTL: '호우로 인한 침수 발생',
          YNA_CN: '침수 피해가 보고되었습니다.',
          YNA_YMD: '20250102',
          CRT_DT: '2025-01-02 11:00:00',
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

    const classifier: MockClassifier = {
      isEnabled: vi.fn(() => true),
      classifyBatch: vi.fn(() => Promise.resolve(new Map([['123', '호우']]))),
    };

    const source = new YnaNewsSource(classifier);
    const result = await source.run(JSON.stringify({ version: 2, seen: {} }));

    expect(result.events).toHaveLength(1);
    expect(result.events[0].kind).toBe(EventKinds.Rain);
    expect(result.events[0].title).toBe('호우로 인한 침수 발생');
  });

  it('should include concise waterworks guidance in news classification prompt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T03:00:00.000Z'));

    process.env.YNA_SERVICE_KEY = 'test-key';
    vi.resetModules();
    const { YnaNewsSource } = await import('./yna-news.source');

    const responseBody = {
      header: { resultCode: '00', resultMsg: 'OK' },
      numOfRows: 1,
      pageNo: 1,
      totalCount: 1,
      body: [
        {
          YNA_NO: 125,
          YNA_TTL: '전북 익산시 신흥동 상수도관 파열…일대 단수로 주민 불편',
          YNA_CN: '상수도관 파열로 단수가 발생했습니다.',
          YNA_YMD: '20250102',
          CRT_DT: '2025-01-02 11:00:00',
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

    const classifier: MockClassifier = {
      isEnabled: vi.fn(() => true),
      classifyBatch: vi.fn(() => Promise.resolve(new Map([['125', '수도']]))),
    };

    const source = new YnaNewsSource(classifier);
    const result = await source.run(JSON.stringify({ version: 2, seen: {} }));

    expect(classifier.classifyBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.stringContaining(
          '"수도" means water-supply infrastructure incidents such as water pipe damage',
        ),
      }),
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0].kind).toBe(EventKinds.Water);
  });

  it('should throw when classification is unavailable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T03:00:00.000Z'));

    process.env.YNA_SERVICE_KEY = 'test-key';
    vi.resetModules();
    const { YnaNewsSource } = await import('./yna-news.source');

    const responseBody = {
      header: { resultCode: '00', resultMsg: 'OK' },
      numOfRows: 1,
      pageNo: 1,
      totalCount: 1,
      body: [
        {
          YNA_NO: 124,
          YNA_TTL: '호우로 인한 침수 발생',
          YNA_CN: '침수 피해가 보고되었습니다.',
          YNA_YMD: '20250102',
          CRT_DT: '2025-01-02 11:00:00',
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

    const classifier: MockClassifier = {
      isEnabled: vi.fn(() => true),
      classifyBatch: vi.fn(() => Promise.resolve(null)),
    };

    const source = new YnaNewsSource(classifier);
    await expect(source.run(JSON.stringify({ version: 2, seen: {} }))).rejects.toThrow(
      'LLM label classification failed',
    );
  });

  it('should not emit duplicate title news across runs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T03:00:00.000Z'));

    process.env.YNA_SERVICE_KEY = 'test-key';
    vi.resetModules();
    const { YnaNewsSource } = await import('./yna-news.source');

    const firstResponseBody = {
      header: { resultCode: '00', resultMsg: 'OK' },
      numOfRows: 1,
      pageNo: 1,
      totalCount: 1,
      body: [
        {
          YNA_NO: 200,
          YNA_TTL: '산불 대응 작업 진행',
          YNA_CN: '첫 번째 본문',
          YNA_YMD: '20250102',
          CRT_DT: '2025-01-02 12:00:00',
        },
      ],
    };

    const secondResponseBody = {
      header: { resultCode: '00', resultMsg: 'OK' },
      numOfRows: 1,
      pageNo: 1,
      totalCount: 1,
      body: [
        {
          YNA_NO: 201,
          YNA_TTL: '산불 대응 작업 진행',
          YNA_CN: '두 번째 본문',
          YNA_YMD: '20250102',
          CRT_DT: '2025-01-02 12:10:00',
        },
      ],
    };

    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(JSON.stringify(firstResponseBody), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(JSON.stringify(secondResponseBody), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const classifier: MockClassifier = {
      isEnabled: vi.fn(() => true),
      classifyBatch: vi.fn((request: { items: Array<{ id: string }> }) => {
        const entries: Array<[string, string]> = [];
        for (const item of request.items) {
          entries.push([item.id, '산불']);
        }
        return Promise.resolve(new Map(entries));
      }),
    };

    const source = new YnaNewsSource(classifier);
    const firstResult = await source.run(JSON.stringify({ version: 2, seen: {} }));
    expect(firstResult.events).toHaveLength(1);
    expect(firstResult.events[0].title).toBe('산불 대응 작업 진행');

    const secondResult = await source.run(firstResult.nextState);
    expect(secondResult.events).toHaveLength(0);
    expect(classifier.classifyBatch).toHaveBeenCalledTimes(1);
  });

  it('should treat legacy state as first run and skip emission', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T03:00:00.000Z'));

    process.env.YNA_SERVICE_KEY = 'test-key';
    vi.resetModules();
    const { YnaNewsSource } = await import('./yna-news.source');

    const responseBody = {
      header: { resultCode: '00', resultMsg: 'OK' },
      numOfRows: 1,
      pageNo: 1,
      totalCount: 1,
      body: [
        {
          YNA_NO: 301,
          YNA_TTL: '호우로 인한 침수 발생',
          YNA_CN: '본문',
          YNA_YMD: '20250102',
          CRT_DT: '2025-01-02 11:00:00',
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

    const classifier: MockClassifier = {
      isEnabled: vi.fn(() => true),
      classifyBatch: vi.fn(() => Promise.resolve(new Map([['301', '호우']]))),
    };

    const source = new YnaNewsSource(classifier);
    const legacyState = JSON.stringify({
      seen: {
        300: '2025-01-02T02:30:00.000Z',
      },
    });

    const result = await source.run(legacyState);
    expect(result.events).toHaveLength(0);
    expect(classifier.classifyBatch).not.toHaveBeenCalled();

    const parsedState = JSON.parse(result.nextState ?? '{}') as {
      version?: number;
      seen?: Record<string, string>;
    };

    expect(parsedState.version).toBe(2);
    expect(parsedState.seen).toBeDefined();
    expect(parsedState.seen?.['호우로 인한 침수 발생']).toBe('2025-01-02T03:00:00.000Z');
  });
});
