import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventKinds, EventLevels } from '@/modules/events/domain/event.enums';
import { MoisPressReleaseSource } from './mois-press-release.source';

function buildRss(items: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>${items}</channel></rss>`;
}

function buildItem(options: { title: string; link: string; pubDate: string; author: string }): string {
  return `
  <item>
    <title><![CDATA[ ${options.title} ]]></title>
    <link><![CDATA[ ${options.link} ]]></link>
    <pubDate>${options.pubDate}</pubDate>
    <author>${options.author}</author>
  </item>
`;
}

describe('MoisPressReleaseSource', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should filter crisis alerts and map kinds from title', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T04:00:00.000Z'));

    const xml = buildRss(
      [
        buildItem({
          title: '폭염 위기경보 심각 단계 격상',
          link: 'https://www.mois.go.kr/frt/bbs/type010/commonSelectBoardArticle.do?bbsId=BBSMSTR_000000000008&nttId=123186',
          pubDate: 'THU, 15 JAN 2026 12:00:00 KST',
          author: '재난안전관리본부',
        }),
        buildItem({
          title: '폭염 위기경보 주의 단계 유지',
          link: 'https://www.mois.go.kr/frt/bbs/type010/commonSelectBoardArticle.do?bbsId=BBSMSTR_000000000008&nttId=123000',
          pubDate: 'TUE, 13 JAN 2026 12:00:00 KST',
          author: '재난안전관리본부',
        }),
        buildItem({
          title: '일반 보도자료',
          link: 'https://www.mois.go.kr/frt/bbs/type010/commonSelectBoardArticle.do?bbsId=BBSMSTR_000000000008&nttId=122999',
          pubDate: 'THU, 15 JAN 2026 10:00:00 KST',
          author: '재난안전관리본부',
        }),
      ].join(''),
    );

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(xml, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const source = new MoisPressReleaseSource({
      isEnabled: () => false,
      classifyBatch: async (_input) => new Map<string, string>(),
    });
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('폭염 위기경보 심각 단계 격상');
    expect(result.events[0].kind).toBe(EventKinds.Heat);
    expect(result.events[0].level).toBe(EventLevels.Severe);
    expect(result.events[0].body).toBe('재난안전관리본부');
    expect(result.events[0].occurredAt).toBe('2026-01-15T03:00:00.000Z');
  });

  it('should pick the last level keyword in title', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T04:00:00.000Z'));

    const xml = buildRss(
      buildItem({
        title: "행정정보시스템 재난 위기경보 '심각'→'경계' 하향",
        link: 'https://www.mois.go.kr/frt/bbs/type010/commonSelectBoardArticle.do?bbsId=BBSMSTR_000000000008&nttId=123200',
        pubDate: 'THU, 15 JAN 2026 12:00:00 KST',
        author: '디지털정부기획과',
      }),
    );

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(xml, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const source = new MoisPressReleaseSource({
      isEnabled: () => false,
      classifyBatch: async (_input) => new Map<string, string>(),
    });
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].level).toBe(EventLevels.Moderate);
  });

  it('should skip seen items within TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T04:00:00.000Z'));

    const xml = buildRss(
      buildItem({
        title: '폭염 위기경보 심각 단계 격상',
        link: 'https://www.mois.go.kr/frt/bbs/type010/commonSelectBoardArticle.do?bbsId=BBSMSTR_000000000008&nttId=123186',
        pubDate: 'THU, 15 JAN 2026 12:00:00 KST',
        author: '재난안전관리본부',
      }),
    );

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(xml, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const source = new MoisPressReleaseSource({
      isEnabled: () => false,
      classifyBatch: async (_input) => new Map<string, string>(),
    });

    const previousState = JSON.stringify({
      seen: { '123186': '2026-01-15T03:30:00.000Z' },
    });

    const result = await source.run(previousState);

    expect(result.events).toHaveLength(0);
    expect(result.nextState).toContain('"123186"');
  });

  it('should fallback to other when classifier throws', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T04:00:00.000Z'));

    const xml = buildRss(
      buildItem({
        title: '행정정보시스템 위기경보 경계 단계 발령',
        link: 'https://www.mois.go.kr/frt/bbs/type010/commonSelectBoardArticle.do?bbsId=BBSMSTR_000000000008&nttId=123300',
        pubDate: 'THU, 15 JAN 2026 12:00:00 KST',
        author: '재난안전관리본부',
      }),
    );

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(xml, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const source = new MoisPressReleaseSource({
      isEnabled: () => true,
      classifyBatch: async () => {
        throw new Error('timeout');
      },
    });
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].kind).toBe(EventKinds.Other);
  });
});
