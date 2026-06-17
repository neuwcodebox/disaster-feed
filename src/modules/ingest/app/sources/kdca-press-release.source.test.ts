import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventKinds } from '@/modules/events/domain/event.enums';
import { KdcaPressReleaseSource } from './kdca-press-release.source';

function buildRss(items: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>${items}</channel></rss>`;
}

function buildItem(options: {
  title: string;
  link: string;
  pubDate: string;
  author: string;
  description: string;
}): string {
  return `
  <item>
    <title><![CDATA[ ${options.title} ]]></title>
    <link><![CDATA[ ${options.link} ]]></link>
    <pubDate>${options.pubDate}</pubDate>
    <author>${options.author}</author>
    <description><![CDATA[ ${options.description} ]]></description>
  </item>
`;
}

describe('KdcaPressReleaseSource', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should filter by keywords and resolve relative links', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-03T01:00:00.000Z'));

    const xml = buildRss(
      [
        buildItem({
          title: '전염병 경보 발령',
          link: '/bbs/kdca/41/309981/artclView.do?layout=unknown',
          pubDate: '2026-02-03 08:50:00.0',
          author: '대변인실',
          description: '전염병 경보 발령 안내',
        }),
        buildItem({
          title: '전염병 경보 유지',
          link: '/bbs/kdca/41/309982/artclView.do?layout=unknown',
          pubDate: '2026-02-03 08:40:00.0',
          author: '대변인실',
          description: '전염병 경보 유지 안내',
        }),
        buildItem({
          title: '일반 보도자료',
          link: '/bbs/kdca/41/309983/artclView.do?layout=unknown',
          pubDate: '2026-02-03 08:30:00.0',
          author: '대변인실',
          description: '일반 보도자료',
        }),
      ].join(''),
    );

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(xml, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const source = new KdcaPressReleaseSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('전염병 경보 발령');
    expect(result.events[0].kind).toBe(EventKinds.Epidemic);
    expect(result.events[0].body).toBe('전염병 경보 발령 안내');
    expect(result.events[0].occurredAt).toBe('2026-02-02T23:50:00.000Z');

    const payload = result.events[0].payload as { link?: string };
    expect(payload.link).toBe('https://www.kdca.go.kr/bbs/kdca/41/309981/artclView.do?layout=unknown');
  });

  it('should fallback to title when id extraction fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-03T01:00:00.000Z'));

    const xml = buildRss(
      buildItem({
        title: '전염병 경보 상향',
        link: '/bbs/kdca/41/INVALID/artclView.do?layout=unknown',
        pubDate: '2026-02-03 08:50:00.0',
        author: '대변인실',
        description: '전염병 경보 상향 안내',
      }),
    );

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(xml, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const source = new KdcaPressReleaseSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    const payload = result.events[0].payload as { id?: string };
    expect(payload.id).toBe('전염병 경보 상향');
  });

  it('should decode escaped html entities and remove trailing title artifact', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T06:00:00.000Z'));

    const xml = buildRss(
      buildItem({
        title: '일본뇌염 바이러스 검출, 전국 경보 발령(6.17.수)}',
        link: '/bbs/kdca/41/311453/artclView.do?layout=unknown',
        pubDate: '2026-06-17 14:00:00.0',
        author: '대변인',
        description:
          '일본뇌염 경보 발령 [ 일본뇌염 주의보 및 경보 기준 ] (일본뇌염 주의보)&amp;#9312; 일본뇌염 매개모기 최초 채집 시',
      }),
    );

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(xml, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const source = new KdcaPressReleaseSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('일본뇌염 바이러스 검출, 전국 경보 발령(6.17.수)');
    expect(result.events[0].body).toBe(
      '일본뇌염 경보 발령 [ 일본뇌염 주의보 및 경보 기준 ] (일본뇌염 주의보)① 일본뇌염 매개모기 최초 채집 시',
    );
  });
});
