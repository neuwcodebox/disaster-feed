import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventKinds } from '@/modules/events/domain/event.enums';
import { MsitPressReleaseSource } from './msit-press-release.source';

function buildRss(items: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>${items}</channel></rss>`;
}

function buildItem(options: { title: string; link: string; pubDate: string }): string {
  return `
  <item>
    <title><![CDATA[ ${options.title} ]]></title>
    <link><![CDATA[ ${options.link} ]]></link>
    <pubDate><![CDATA[ ${options.pubDate} ]]></pubDate>
  </item>
`;
}

describe('MsitPressReleaseSource', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should filter by required keywords and set body to null', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T01:00:00.000Z'));

    const xml = buildRss(
      [
        buildItem({
          title: '산불 확산에 따른 방송통신재난 위기경보 주의 발령',
          link: 'https://www.msit.go.kr/bbs/view.do?sCode=user&bbsSeqNo=94&nttSeqNo=3186765',
          pubDate: '2026.01.15',
        }),
        buildItem({
          title: '과기정통부, 민간분야 사이버위기 경보 단계 관심에서 주의 로 상향',
          link: 'https://www.msit.go.kr/bbs/view.do?sCode=user&bbsSeqNo=94&nttSeqNo=3186766',
          pubDate: '2026.01.15',
        }),
        buildItem({
          title: '한-미 간 우주전파 예·경보기술 협력 강화',
          link: 'https://www.msit.go.kr/bbs/view.do?sCode=user&bbsSeqNo=94&nttSeqNo=3186767',
          pubDate: '2026.01.15',
        }),
      ].join(''),
    );

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(xml, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const source = new MsitPressReleaseSource({
      isEnabled: () => false,
      classifyBatch: async (_input) => new Map<string, string>(),
    });
    const result = await source.run(null);

    expect(result.events).toHaveLength(2);
    expect(result.events[0].kind).toBe(EventKinds.Wildfire);
    expect(result.events[0].body).toBeNull();
  });

  it('should apply server time when pubDate is today', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T04:30:45.000Z'));

    const xml = buildRss(
      buildItem({
        title: '사이버위기 경보 단계 관심 상향',
        link: 'https://www.msit.go.kr/bbs/view.do?sCode=user&bbsSeqNo=94&nttSeqNo=3186768',
        pubDate: '2026.01.15',
      }),
    );

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(xml, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const source = new MsitPressReleaseSource({
      isEnabled: () => false,
      classifyBatch: async (_input) => new Map<string, string>(),
    });
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].occurredAt).toBe('2026-01-15T04:30:45.000Z');
  });

  it('should parse date-only pubDate when it is not today', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-14T15:00:00.000Z'));

    const xml = buildRss(
      buildItem({
        title: '사이버위기 경보 단계 관심 상향',
        link: 'https://www.msit.go.kr/bbs/view.do?sCode=user&bbsSeqNo=94&nttSeqNo=3186769',
        pubDate: '2026.01.16',
      }),
    );

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(xml, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const source = new MsitPressReleaseSource({
      isEnabled: () => false,
      classifyBatch: async (_input) => new Map<string, string>(),
    });
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].occurredAt).toBe('2026-01-15T15:00:00.000Z');
  });
});
