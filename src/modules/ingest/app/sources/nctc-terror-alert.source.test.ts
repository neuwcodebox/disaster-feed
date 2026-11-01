import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { EventLevels } from '@/modules/events/domain/event.enums';
import { NctcTerrorAlertSource } from './nctc-terror-alert.source';

const listFixture = readFileSync(new URL('./__fixtures__/nctc-board-list.html', import.meta.url), 'utf8');
const listUrl = 'http://www.nctc.go.kr/base/board/list?boardManagementNo=20&menuLevel=3&menuNo=4';
const titlePatterns = z
  .array(
    z.object({
      id: z.string(),
      title: z.string(),
      expectedStage: z.number().int().min(1).max(4).nullable(),
    }),
  )
  .parse(JSON.parse(readFileSync(new URL('./__fixtures__/nctc-title-patterns.json', import.meta.url), 'utf8')));

function makeList(title: string, date = '2026.11.01', boardNo = '17986', rowNumber = '76'): string {
  const escapedTitle = title.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<table class="board_list"><thead><tr><th>구분</th><th>제목</th><th>첨부파일</th><th>등록일</th><th>조회수</th></tr></thead>
    <tbody><tr><td class="num">${rowNumber}</td><td class="tit"><a href="/base/board/read?boardManagementNo=20&amp;boardNo=${boardNo}&amp;menuLevel=3&amp;menuNo=4">${escapedTitle}</a></td>
    <td class="file"></td><td class="date">${date}</td><td class="hits">627</td></tr></tbody></table>`;
}

function mockList(html: string, status = 200) {
  const mock = vi.fn(() => Promise.resolve(new Response(html, { status })));
  vi.stubGlobal('fetch', mock);
  return mock;
}

function setNow(iso = '2026-11-01T03:00:00.000Z'): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

describe('NctcTerrorAlertSource', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(titlePatterns)('should classify archived board $id: $title', async ({ id, title, expectedStage }) => {
    setNow();
    mockList(makeList(title, '2026.11.01', id));
    const result = await new NctcTerrorAlertSource().run(null);
    expect(result.events[0].payload?.stage).toBe(expectedStage);
  });

  it('should parse the current five-column board using boardNo and title only', async () => {
    setNow('2026-09-09T03:00:00.000Z');
    const fetchMock = mockList(`${listFixture}<div class="editor_view">9.17.부터 관심 단계로 환원</div>`);
    const result = await new NctcTerrorAlertSource().run(null);
    expect(result.events).toHaveLength(2);
    expect(result.events[0].payload).toMatchObject({
      alertId: '17986',
      stage: 3,
      stageLabel: '경계',
      registeredAt: '2026.09.09',
      issuedAt: null,
    });
    expect(result.events[0].level).toBe(EventLevels.Moderate);
    expect(result.events[1].payload).toMatchObject({ alertId: '17985', stage: 2, stageLabel: '주의' });
    expect(result.events[0].occurredAt).toBe('2026-09-09T03:00:00.000Z');
    expect(result.events[0].body).toBeNull();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(listUrl, expect.any(Object));
  });

  it('should use registration date with the shared date-only convention', async () => {
    setNow('2026-09-10T03:00:00.000Z');
    mockList(listFixture);
    const result = await new NctcTerrorAlertSource().run(null);
    expect(result.events[0].occurredAt).toBe('2026-09-09T14:59:59.999Z');
    expect(result.events[0].payload?.registeredAt).toBe('2026.09.09');
  });

  it('should not re-emit the old September notices on migration in November', async () => {
    setNow();
    const fetchMock = mockList(listFixture);
    const result = await new NctcTerrorAlertSource().run(null);
    expect(result.events).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['상향(관심에서 주의) 조정', 2, 'raise'],
    ['상향(관심-주의) 조정', 2, 'raise'],
    ['상향(관심→주의) 조정', 2, 'raise'],
    ['상향(주의->경계) 조정', 3, 'raise'],
    ['(주의→심각) 상향 조정', 4, 'raise'],
    ['일부 환원(경계→ 주의) 조정 안내', 2, 'lower'],
    ['환원(심각→관심) 조정 안내', 1, 'lower'],
    ['(주의->관심) 단계로 하향 조정', 1, 'lower'],
    ["'주의' 경보 발령", 2, null],
    ['단계 상향 조정(경계)', 3, 'raise'],
    ['단계 하향 조정', null, 'lower'],
    ['상향 조정(강원)', null, 'raise'],
    ['대비태세 강화', null, null],
    ['상향(관심→주의), 상향(주의→경계)', null, 'raise'],
  ])('should interpret the destination and direction in title %s', async (suffix, stage, change) => {
    setNow();
    mockList(makeList(`테러경보 ${suffix}`));
    const result = await new NctcTerrorAlertSource().run(null);
    expect(result.events[0].payload).toMatchObject({ stage, change });
    if (stage === null) {
      expect(result.events[0].payload?.stageLabel).toBeNull();
    }
  });

  it('should retain both previous and current stage for a partial reduction', async () => {
    setNow();
    mockList(makeList('테러 경보 등급 일부 환원(경계→주의) 조정 안내'));
    const result = await new NctcTerrorAlertSource().run(null);
    expect(result.events[0].payload).toMatchObject({ previousStage: 3, stage: 2, stageLabel: '주의', change: 'lower' });
    expect(result.events[0].level).toBe(EventLevels.Minor);
  });

  it('should deduplicate by boardNo even when the displayed row number changes', async () => {
    setNow();
    const fetchMock = mockList(makeList('테러경보 상향 조정(경계)'));
    const source = new NctcTerrorAlertSource();
    const first = await source.run(null);
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(makeList('테러경보 상향 조정(경계)', '2026.11.01', '17986', '77'))),
    );
    expect((await source.run(first.nextState)).events).toEqual([]);
    expect(JSON.parse(first.nextState).seen['17986']).toBe('2026-11-01T03:00:00.000Z');
  });

  it.each([
    '<html>서비스 점검 중</html>',
    '<table class="board_list"><tbody></tbody></table>',
    makeList('테러경보 상향(주의)', 'not a date'),
    makeList('테러경보 상향(주의)', '2026.02.31'),
    makeList('테러경보 상향(주의)', '2026.11.01', ''),
    makeList('테러경보 상향(주의)').replace('/base/board/read?', 'https://example.com/base/board/read?'),
  ])('should fail malformed responses instead of checkpointing a successful empty poll', async (html) => {
    setNow();
    mockList(html);
    await expect(new NctcTerrorAlertSource().run(null)).rejects.toThrow();
  });

  it('should fail HTTP errors', async () => {
    setNow();
    mockList('Unavailable', 503);
    await expect(new NctcTerrorAlertSource().run(null)).rejects.toThrow('NCTC terror alert list request failed');
  });
});
