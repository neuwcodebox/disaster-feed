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

type DisasterSmsFixture = {
  serial: number;
  disasterType: string | null;
  sentAt: string | null;
  regionText: string | null;
  message: string;
  emergencyStep: string | null;
  href?: string;
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

function createHtmlResponse(rows: DisasterSmsFixture[], options?: { includeList?: boolean }): Response {
  return new Response(buildDisasterSmsHtml(rows, options), {
    status: 200,
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
}

function buildDisasterSmsHtml(rows: DisasterSmsFixture[], options?: { includeList?: boolean }): string {
  if (options?.includeList === false) {
    return '<!doctype html><html><body><div id="content_area"></div></body></html>';
  }

  const body = rows.map((row) => buildDisasterSmsRowHtml(row)).join('');

  return `<!doctype html>
<html>
  <body>
    <div id="content_area">
      <div class="cont-area">
        <div class="brd-listarea">
          <ul class="brd-list">${body}</ul>
        </div>
      </div>
    </div>
  </body>
</html>`;
}

function buildDisasterSmsRowHtml(row: DisasterSmsFixture): string {
  const href = row.href ?? `javascript:onSubmit('${row.serial}');`;

  return `<li>
    <div class="brd-num">
      <span>${row.serial}</span>
    </div>
    <div class="brd-context">
      <h3 class="title-text"><a href="${escapeHtml(href)}">${escapeHtml(row.message)}</a></h3>
      <div class="brd-infolist">
        <p><span>재해구분 : </span>${escapeHtml(row.disasterType ?? '')}</p>
        <p><span>긴급단계 : </span>${escapeHtml(row.emergencyStep ?? '')}</p>
        <p><span>송출지역 : </span>${escapeHtml(row.regionText ?? '')}</p>
        <p><span>발송일시 : </span>${escapeHtml(row.sentAt ?? '')}</p>
      </div>
    </div>
  </li>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

describe('DisasterSmsSource', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should map disaster kinds and resolve region codes for new messages', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T00:00:00.000Z'));

    const rows: DisasterSmsFixture[] = [
      {
        disasterType: '호우',
        sentAt: '2025/01/01 10:00:00',
        regionText: '전국',
        serial: 100,
        message: '테스트 메시지 [행정안전부]',
        emergencyStep: '안전안내',
      },
      {
        disasterType: '호우',
        sentAt: '2025/01/02 12:00:00',
        regionText: '전국, 서울특별시',
        serial: 101,
        message: '호우 주의 바랍니다. [서울특별시]',
        emergencyStep: '안전안내',
      },
    ];

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(createHtmlResponse(rows)));
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
    expect(result.events[0].payload).toEqual({
      serial: 101,
      disasterType: '호우',
      message: '호우 주의 바랍니다. [서울특별시]',
      sentAt: '2025/01/02 12:00:00',
      sentAtIso: '2025-01-02T03:00:00.000Z',
      emergencyStep: '안전안내',
      regionText: '전국, 서울특별시',
    });
    expect(result.nextState).toBe('101');
  });

  it('should raise safety evacuation messages to moderate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-02-01T00:00:00.000Z'));

    const rows: DisasterSmsFixture[] = [
      {
        disasterType: '호우',
        sentAt: '2025/02/01 10:00:00',
        regionText: '전국',
        serial: 200,
        message: '(사전 대피권고) 하천 범람 위험 시 안전한 곳으로 이동 바랍니다.',
        emergencyStep: '안전안내',
      },
      {
        disasterType: '호우',
        sentAt: '2025/02/01 11:00:00',
        regionText: '전국',
        serial: 201,
        message: '(대피명령 해제) 하천 범람 위험 해소로 대피명령 해제되었습니다.',
        emergencyStep: '안전안내',
      },
      {
        disasterType: '산불',
        sentAt: '2025/02/01 12:00:00',
        regionText: '경상북도 봉화군',
        serial: 202,
        message:
          '오늘17:51경 춘양면 석현리 산 187인근 산불발생. 주민과 등산객은 석현2리 노인회관으로 즉시 대피. Evacuation, Forest fire [봉화군]',
        emergencyStep: '안전안내',
      },
    ];

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(createHtmlResponse(rows)));
    vi.stubGlobal('fetch', fetchMock);

    const regionRepository = createRegionRepository();
    const labelClassifier = createLabelClassifier();
    const source = new DisasterSmsSource(labelClassifier, regionRepository);
    const result = await source.run(null);

    expect(result.events).toHaveLength(3);
    expect(result.events[0].level).toBe(EventLevels.Moderate);
    expect(result.events[1].level).toBe(EventLevels.Minor);
    expect(result.events[2].level).toBe(EventLevels.Moderate);
  });

  it('should downgrade safety messages to info when precaution and symbol keywords exist', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-02-02T00:00:00.000Z'));

    const rows: DisasterSmsFixture[] = [
      {
        disasterType: '호우',
        sentAt: '2025/02/02 09:00:00',
        regionText: '전국',
        serial: 210,
        message: '내일 집중호우 예상 ▲ 저지대 접근을 자제해 주세요.',
        emergencyStep: '안전안내',
      },
    ];

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(createHtmlResponse(rows)));
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

  it('should classify when incident keywords exist with multiple safety keywords', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-02-02T00:00:00.000Z'));

    const rows: DisasterSmsFixture[] = [
      {
        disasterType: '호우',
        sentAt: '2025/02/02 09:00:00',
        regionText: '전국',
        serial: 213,
        message:
          '2월 7일 봉화읍 가금농가에서 고병원성조류인플루엔자 발생 이동제한 집중방역 중 ▶가금농가 축산시설 방문 자제 ▶폐사체 발견 시 즉시 신고 해제까지 협조',
        emergencyStep: '안전안내',
      },
    ];

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(createHtmlResponse(rows)));
    vi.stubGlobal('fetch', fetchMock);

    const regionRepository = createRegionRepository();
    const labelClassifier = createLabelClassifier();
    labelClassifier.isEnabled.mockReturnValue(true);
    labelClassifier.classifyBatch.mockResolvedValue(new Map([['213', '사건발생']]));

    const source = new DisasterSmsSource(labelClassifier, regionRepository);
    const result = await source.run(null);

    expect(labelClassifier.classifyBatch).toHaveBeenCalledTimes(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].level).toBe(EventLevels.Minor);
  });

  it('should classify when only direct keywords exist', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-02-02T00:00:00.000Z'));

    const rows: DisasterSmsFixture[] = [
      {
        disasterType: '산불',
        sentAt: '2025/02/02 09:00:00',
        regionText: '전국',
        serial: 212,
        message: '산불 불씨를 확인하고 화기 사용 상태를 점검해 주세요.',
        emergencyStep: '안전안내',
      },
    ];

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(createHtmlResponse(rows)));
    vi.stubGlobal('fetch', fetchMock);

    const regionRepository = createRegionRepository();
    const labelClassifier = createLabelClassifier();
    labelClassifier.isEnabled.mockReturnValue(true);
    labelClassifier.classifyBatch.mockResolvedValue(new Map([['212', '예방안내']]));
    const source = new DisasterSmsSource(labelClassifier, regionRepository);
    const result = await source.run(null);

    expect(labelClassifier.classifyBatch).toHaveBeenCalledTimes(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].level).toBe(EventLevels.Info);
  });

  it('should exclude safety keyword logic when excluded keywords exist', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-02-02T00:00:00.000Z'));

    const rows: DisasterSmsFixture[] = [
      {
        disasterType: '호우',
        sentAt: '2025/02/02 09:00:00',
        regionText: '전국',
        serial: 211,
        message: '[기상청] 호우 우려 지역 행동요령 ▲ 저지대 접근을 자제해 주세요.',
        emergencyStep: '안전안내',
      },
    ];

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(createHtmlResponse(rows)));
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

    const rows: DisasterSmsFixture[] = [
      {
        disasterType: '호우',
        sentAt: '2025/02/03 09:00:00',
        regionText: '전국',
        serial: 220,
        message: '호우 예방을 위한 배수로 점검 안내입니다.',
        emergencyStep: '안전안내',
      },
      {
        disasterType: '호우',
        sentAt: '2025/02/03 10:00:00',
        regionText: '전국',
        serial: 221,
        message: '하천 수위 상승 우려, 인근 주민은 상황을 주시하세요.',
        emergencyStep: '안전안내',
      },
    ];

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(createHtmlResponse(rows)));
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

    const rows: DisasterSmsFixture[] = [
      {
        disasterType: '호우',
        sentAt: '2025/02/04 09:00:00',
        regionText: '전국',
        serial: 222,
        message: '하천 인근 주민은 △ 상황을 살피고 대비해 주세요.',
        emergencyStep: '안전안내',
      },
    ];

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(createHtmlResponse(rows)));
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

  it('should classify when disaster type is missing and classifier is enabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-01T00:00:00.000Z'));

    const rows: DisasterSmsFixture[] = [
      {
        disasterType: null,
        sentAt: '2025/03/01 09:30:00',
        regionText: '서울특별시',
        serial: 300,
        message: '한파 대비 안내드립니다.',
        emergencyStep: '안전안내',
      },
    ];

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(createHtmlResponse(rows)));
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

  it('should fallback to other when disaster type is missing and classifier is disabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-02T00:00:00.000Z'));

    const rows: DisasterSmsFixture[] = [
      {
        disasterType: null,
        sentAt: '2025/03/02 08:00:00',
        regionText: '전국',
        serial: 301,
        message: '재난 문자 테스트입니다.',
        emergencyStep: '안전안내',
      },
    ];

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(createHtmlResponse(rows)));
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

    const rows: DisasterSmsFixture[] = [
      {
        disasterType: null,
        sentAt: '2025/03/03 08:00:00',
        regionText: '전국',
        serial: 310,
        message: '호우 대비 안내입니다.',
        emergencyStep: '안전안내',
      },
      {
        disasterType: null,
        sentAt: '2025/03/03 09:00:00',
        regionText: '전국',
        serial: 311,
        message: '한파 대비 안내입니다.',
        emergencyStep: '안전안내',
      },
    ];

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(createHtmlResponse(rows)));
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

    const rows: DisasterSmsFixture[] = [
      {
        disasterType: null,
        sentAt: '2025/03/04 08:00:00',
        regionText: '전국',
        serial: 320,
        message: '호우 예방을 위한 행동요령 안내입니다.',
        emergencyStep: '안전안내',
      },
    ];

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(createHtmlResponse(rows)));
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

  it('should throw when a row has invalid serial href', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-05T00:00:00.000Z'));

    const rows: DisasterSmsFixture[] = [
      {
        disasterType: '화재',
        sentAt: '2025/03/05 08:00:00',
        regionText: '경기도 남양주시',
        serial: 400,
        message: '화재 발생 안내입니다.',
        emergencyStep: '안전안내',
        href: 'javascript:void(0);',
      },
      {
        disasterType: '산불',
        sentAt: '2025/03/05 08:10:00',
        regionText: '경상북도 영양군',
        serial: 401,
        message: '산불 발생 안내입니다. [영양군]',
        emergencyStep: '안전안내',
      },
    ];

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(createHtmlResponse(rows)));
    vi.stubGlobal('fetch', fetchMock);

    const regionRepository = createRegionRepository();
    const labelClassifier = createLabelClassifier();
    const source = new DisasterSmsSource(labelClassifier, regionRepository);

    await expect(source.run(null)).rejects.toThrow('Failed to parse disaster SMS row');
  });

  it('should throw when disaster SMS list is missing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-06T00:00:00.000Z'));

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(createHtmlResponse([], { includeList: false })));
    vi.stubGlobal('fetch', fetchMock);

    const regionRepository = createRegionRepository();
    const labelClassifier = createLabelClassifier();
    const source = new DisasterSmsSource(labelClassifier, regionRepository);

    await expect(source.run(null)).rejects.toThrow('Failed to find disaster SMS list');
  });
});
