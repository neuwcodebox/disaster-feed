import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventKinds, EventLevels } from '@/modules/events/domain/event.enums';
import type { IRegionRepository, RegionCenter } from '../../domain/port/region-repo.interface';
import type { LlmLabelClassifierService } from '../llm-label-classifier.service';
import { DisasterSmsSource } from './disaster-sms.source';

type RegionRepositoryMocks = {
  findCodeByNamePrefix: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
  findCodeByNamePostfix: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
  findCentersByCodes: ReturnType<typeof vi.fn<() => Promise<Map<string, RegionCenter>>>>;
};

type LabelClassifierMocks = Pick<LlmLabelClassifierService, 'isEnabled' | 'classifyBatch'> & {
  isEnabled: ReturnType<typeof vi.fn<() => boolean>>;
  classifyBatch: ReturnType<typeof vi.fn<() => Promise<Map<string, string> | null>>>;
};

const createRegionRepository = (): RegionRepositoryMocks & IRegionRepository => ({
  findCodeByNamePrefix: vi.fn<() => Promise<string | null>>(),
  findCodeByNamePostfix: vi.fn<() => Promise<string | null>>(),
  findCentersByCodes: vi.fn<() => Promise<Map<string, RegionCenter>>>(),
});

const createLabelClassifier = (): LabelClassifierMocks => ({
  isEnabled: vi.fn(() => false),
  classifyBatch: vi.fn(() => Promise.resolve(null)),
});

describe('DisasterSmsSource', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should map disaster kinds and resolve region codes for new messages', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T00:00:00.000Z'));

    const responseBody = {
      disasterSmsList: [
        {
          DSSTR_SE_NM: '호우',
          CREAT_DT: '2025/01/01 10:00:00',
          RCV_AREA_NM: '전국',
          MD101_SN: 100,
          DSSTR_SE_ID: '1',
          MSG_CN: '테스트 메시지 [행정안전부]',
          EMRGNCY_STEP_NM: '안전안내',
        },
        {
          DSSTR_SE_NM: '호우',
          CREAT_DT: '2025/01/02 12:00:00',
          RCV_AREA_NM: '전국, 서울특별시',
          MD101_SN: 101,
          DSSTR_SE_ID: '1',
          MSG_CN: '호우 주의 바랍니다. [서울특별시]',
          EMRGNCY_STEP_NM: '안전안내',
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

    const regionRepository = createRegionRepository();
    regionRepository.findCodeByNamePrefix.mockResolvedValue('1100000000');

    const labelClassifier = createLabelClassifier();
    const source = new DisasterSmsSource(labelClassifier, regionRepository);
    const result = await source.run('100');

    expect(labelClassifier.isEnabled).toHaveBeenCalled();
    expect(labelClassifier.classifyBatch).not.toHaveBeenCalled();

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('서울특별시 호우 안전안내');
    expect(result.events[0].occurredAt).toBe('2025-01-02T03:00:00.000Z');
    expect(result.events[0].level).toBe(EventLevels.Minor);
    expect(result.events[0].kind).toBe(EventKinds.Rain);
    expect(result.events[0].regionText).toBe('전국, 서울특별시');
    expect(result.events[0].regionCodes).toEqual(['0000000000', '1100000000']);
    expect(result.nextState).toBe('101');
  });

  it('should raise safety evacuation messages to moderate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-02-01T00:00:00.000Z'));

    const responseBody = {
      disasterSmsList: [
        {
          DSSTR_SE_NM: '호우',
          CREAT_DT: '2025/02/01 10:00:00',
          RCV_AREA_NM: '전국',
          MD101_SN: 200,
          DSSTR_SE_ID: '1',
          MSG_CN: '(사전 대피권고) 하천 범람 위험 시 안전한 곳으로 이동 바랍니다.',
          EMRGNCY_STEP_NM: '안전안내',
        },
        {
          DSSTR_SE_NM: '호우',
          CREAT_DT: '2025/02/01 11:00:00',
          RCV_AREA_NM: '전국',
          MD101_SN: 201,
          DSSTR_SE_ID: '1',
          MSG_CN: '(대피명령 해제) 하천 범람 위험 해소로 대피명령 해제되었습니다.',
          EMRGNCY_STEP_NM: '안전안내',
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

    const regionRepository = createRegionRepository();
    const labelClassifier = createLabelClassifier();
    const source = new DisasterSmsSource(labelClassifier, regionRepository);
    const result = await source.run(null);

    expect(result.events).toHaveLength(2);
    expect(result.events[0].level).toBe(EventLevels.Moderate);
    expect(result.events[1].level).toBe(EventLevels.Minor);
  });

  it('should downgrade safety messages to info when both forecast and symbol keywords exist', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-02-02T00:00:00.000Z'));

    const responseBody = {
      disasterSmsList: [
        {
          DSSTR_SE_NM: '호우',
          CREAT_DT: '2025/02/02 09:00:00',
          RCV_AREA_NM: '전국',
          MD101_SN: 210,
          DSSTR_SE_ID: '1',
          MSG_CN: '내일 집중호우 예상 ▲ 저지대 접근을 자제해 주세요.',
          EMRGNCY_STEP_NM: '안전안내',
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

    const regionRepository = createRegionRepository();
    const labelClassifier = createLabelClassifier();
    labelClassifier.isEnabled.mockReturnValue(true);
    const source = new DisasterSmsSource(labelClassifier, regionRepository);
    const result = await source.run(null);

    expect(labelClassifier.classifyBatch).not.toHaveBeenCalled();
    expect(result.events).toHaveLength(1);
    expect(result.events[0].level).toBe(EventLevels.Info);
  });

  it('should downgrade safety messages to info when forecast and auxiliary keywords exist', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-02-02T00:00:00.000Z'));

    const responseBody = {
      disasterSmsList: [
        {
          DSSTR_SE_NM: '산불',
          CREAT_DT: '2025/02/02 09:00:00',
          RCV_AREA_NM: '전국',
          MD101_SN: 212,
          DSSTR_SE_ID: '1',
          MSG_CN: '건조한 날씨로 산불 불씨 우려, 야외 소각을 자제해 주세요.',
          EMRGNCY_STEP_NM: '안전안내',
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

    const regionRepository = createRegionRepository();
    const labelClassifier = createLabelClassifier();
    labelClassifier.isEnabled.mockReturnValue(true);
    const source = new DisasterSmsSource(labelClassifier, regionRepository);
    const result = await source.run(null);

    expect(labelClassifier.classifyBatch).not.toHaveBeenCalled();
    expect(result.events).toHaveLength(1);
    expect(result.events[0].level).toBe(EventLevels.Info);
  });

  it('should exclude safety keyword logic when excluded keywords exist', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-02-02T00:00:00.000Z'));

    const responseBody = {
      disasterSmsList: [
        {
          DSSTR_SE_NM: '호우',
          CREAT_DT: '2025/02/02 09:00:00',
          RCV_AREA_NM: '전국',
          MD101_SN: 211,
          DSSTR_SE_ID: '1',
          MSG_CN: '[기상청] 호우 우려 지역 행동요령 ▲ 저지대 접근을 자제해 주세요.',
          EMRGNCY_STEP_NM: '안전안내',
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

    const regionRepository = createRegionRepository();
    const labelClassifier = createLabelClassifier();
    labelClassifier.isEnabled.mockReturnValue(true);
    const source = new DisasterSmsSource(labelClassifier, regionRepository);
    const result = await source.run(null);

    expect(labelClassifier.classifyBatch).not.toHaveBeenCalled();
    expect(result.events).toHaveLength(1);
    expect(result.events[0].level).toBe(EventLevels.Minor);
  });

  it('should classify partial safety keyword matches with llm for final level', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-02-03T00:00:00.000Z'));

    const responseBody = {
      disasterSmsList: [
        {
          DSSTR_SE_NM: '호우',
          CREAT_DT: '2025/02/03 09:00:00',
          RCV_AREA_NM: '전국',
          MD101_SN: 220,
          DSSTR_SE_ID: '1',
          MSG_CN: '호우 예방을 위한 배수로 점검 안내입니다.',
          EMRGNCY_STEP_NM: '안전안내',
        },
        {
          DSSTR_SE_NM: '호우',
          CREAT_DT: '2025/02/03 10:00:00',
          RCV_AREA_NM: '전국',
          MD101_SN: 221,
          DSSTR_SE_ID: '1',
          MSG_CN: '하천 수위 상승 가능성 ▲ 인근 주민은 상황을 주시하세요.',
          EMRGNCY_STEP_NM: '안전안내',
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

    const regionRepository = createRegionRepository();
    const labelClassifier = createLabelClassifier();
    labelClassifier.isEnabled.mockReturnValue(true);
    labelClassifier.classifyBatch.mockResolvedValue(
      new Map([
        ['220', '예방안내'],
        ['221', '사건발생'],
      ]),
    );

    const source = new DisasterSmsSource(labelClassifier, regionRepository);
    const result = await source.run(null);

    expect(labelClassifier.classifyBatch).toHaveBeenCalledTimes(1);
    expect(labelClassifier.classifyBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: ['사건발생', '예방안내', '기타'],
      }),
    );
    expect(result.events).toHaveLength(2);
    expect(result.events[0].level).toBe(EventLevels.Info);
    expect(result.events[1].level).toBe(EventLevels.Minor);
  });

  it('should keep level as minor when safety keyword match is classified as 기타', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-02-04T00:00:00.000Z'));

    const responseBody = {
      disasterSmsList: [
        {
          DSSTR_SE_NM: '호우',
          CREAT_DT: '2025/02/04 09:00:00',
          RCV_AREA_NM: '전국',
          MD101_SN: 222,
          DSSTR_SE_ID: '1',
          MSG_CN: '하천 인근 주민은 △ 상황을 살피고 대비해 주세요.',
          EMRGNCY_STEP_NM: '안전안내',
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

    const regionRepository = createRegionRepository();
    const labelClassifier = createLabelClassifier();
    labelClassifier.isEnabled.mockReturnValue(true);
    labelClassifier.classifyBatch.mockResolvedValue(new Map([['222', '기타']]));

    const source = new DisasterSmsSource(labelClassifier, regionRepository);
    const result = await source.run(null);

    expect(labelClassifier.classifyBatch).toHaveBeenCalledTimes(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].level).toBe(EventLevels.Minor);
  });

  it('should classify when DSSTR_SE_NM is null and classifier is enabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-01T00:00:00.000Z'));

    const responseBody = {
      disasterSmsList: [
        {
          DSSTR_SE_NM: null,
          CREAT_DT: '2025/03/01 09:30:00',
          RCV_AREA_NM: '서울특별시',
          MD101_SN: 300,
          DSSTR_SE_ID: '1',
          MSG_CN: '한파 대비 안내드립니다.',
          EMRGNCY_STEP_NM: '안전안내',
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

    const regionRepository = createRegionRepository();
    regionRepository.findCodeByNamePrefix.mockResolvedValue('1100000000');

    const labelClassifier = createLabelClassifier();
    labelClassifier.isEnabled.mockReturnValue(true);
    labelClassifier.classifyBatch.mockResolvedValue(new Map([['300', '한파']]));

    const source = new DisasterSmsSource(labelClassifier, regionRepository);
    const result = await source.run(null);

    expect(labelClassifier.isEnabled).toHaveBeenCalled();
    expect(labelClassifier.classifyBatch).toHaveBeenCalled();
    expect(result.events).toHaveLength(1);
    expect(result.events[0].kind).toBe(EventKinds.Cold);
    expect(result.events[0].title).toBe('서울특별시 기타 안전안내');
  });

  it('should fallback to other when DSSTR_SE_NM is null and classifier is disabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-02T00:00:00.000Z'));

    const responseBody = {
      disasterSmsList: [
        {
          DSSTR_SE_NM: null,
          CREAT_DT: '2025/03/02 08:00:00',
          RCV_AREA_NM: '전국',
          MD101_SN: 301,
          DSSTR_SE_ID: '1',
          MSG_CN: '재난 문자 테스트입니다.',
          EMRGNCY_STEP_NM: '안전안내',
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

    const regionRepository = createRegionRepository();
    const labelClassifier = createLabelClassifier();

    const source = new DisasterSmsSource(labelClassifier, regionRepository);
    const result = await source.run(null);

    expect(labelClassifier.isEnabled).toHaveBeenCalled();
    expect(labelClassifier.classifyBatch).not.toHaveBeenCalled();
    expect(result.events).toHaveLength(1);
    expect(result.events[0].kind).toBe(EventKinds.Other);
    expect(result.events[0].title).toBe('전국 기타 안전안내');
  });

  it('should classify multiple other events with distinct kinds in one batch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-03T00:00:00.000Z'));

    const responseBody = {
      disasterSmsList: [
        {
          DSSTR_SE_NM: null,
          CREAT_DT: '2025/03/03 08:00:00',
          RCV_AREA_NM: '전국',
          MD101_SN: 310,
          DSSTR_SE_ID: '1',
          MSG_CN: '호우 대비 안내입니다.',
          EMRGNCY_STEP_NM: '안전안내',
        },
        {
          DSSTR_SE_NM: null,
          CREAT_DT: '2025/03/03 09:00:00',
          RCV_AREA_NM: '전국',
          MD101_SN: 311,
          DSSTR_SE_ID: '1',
          MSG_CN: '한파 대비 안내입니다.',
          EMRGNCY_STEP_NM: '안전안내',
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

    const regionRepository = createRegionRepository();
    const labelClassifier = createLabelClassifier();
    labelClassifier.isEnabled.mockReturnValue(true);
    labelClassifier.classifyBatch.mockResolvedValue(
      new Map([
        ['310', '호우'],
        ['311', '한파'],
      ]),
    );

    const source = new DisasterSmsSource(labelClassifier, regionRepository);
    const result = await source.run(null);

    expect(labelClassifier.isEnabled).toHaveBeenCalled();
    expect(labelClassifier.classifyBatch).toHaveBeenCalled();
    expect(result.events).toHaveLength(2);
    expect(result.events[0].kind).toBe(EventKinds.Rain);
    expect(result.events[1].kind).toBe(EventKinds.Cold);
  });

  it('should fallback when classifier throws timeout-like errors', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-04T00:00:00.000Z'));

    const responseBody = {
      disasterSmsList: [
        {
          DSSTR_SE_NM: null,
          CREAT_DT: '2025/03/04 08:00:00',
          RCV_AREA_NM: '전국',
          MD101_SN: 320,
          DSSTR_SE_ID: '1',
          MSG_CN: '호우 예방을 위한 행동요령 안내입니다.',
          EMRGNCY_STEP_NM: '안전안내',
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

    const regionRepository = createRegionRepository();
    const labelClassifier = createLabelClassifier();
    labelClassifier.isEnabled.mockReturnValue(true);
    labelClassifier.classifyBatch.mockRejectedValue(new Error('timeout'));

    const source = new DisasterSmsSource(labelClassifier, regionRepository);
    const result = await source.run(null);

    expect(labelClassifier.classifyBatch).toHaveBeenCalledTimes(2);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].kind).toBe(EventKinds.Other);
    expect(result.events[0].level).toBe(EventLevels.Minor);
  });
});
