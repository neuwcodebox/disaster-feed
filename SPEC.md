# SPEC.md

## 1. 목적

재난/안전 데이터 소스를 주기적으로 폴링하여 이벤트로 정형화하고,
Postgres에 저장하며, HTTP API 및 SSE로 최신 이벤트 목록을 제공한다.

## 2. 구성

- 단일 백엔드 앱(하지만 여러 인스턴스로 실행 가능)
- 외부 의존:
  - Postgres
  - Redis (BullMQ + Pub/Sub)

## 3. 데이터 흐름(요약)

1) BullMQ repeatable job으로 소스별 폴링 잡을 주기 실행
2) 잡 실행 시 해당 소스 클래스가:
   - 원본 fetch
   - 이벤트로 정형화
   - DB insert(append-only)
3) insert 성공 시 Redis Pub/Sub로 eventId publish
4) 각 인스턴스는 Pub/Sub 메시지를 받아 DB 조회 후 로컬 SSE로 브로드캐스트
5) SSE 재연결 시 DB에서 누락분 catch-up 후 live 전환

## 4. 이벤트 스키마(논리)

- id: string (ULID)
- source: number (앱에서 enum 관리)
- kind: number (앱에서 enum 관리)
- title: string
- body?: text
- fetched_at: timestamptz
- occurred_at?: timestamptz
- region_text?: text
- level: number
- link?: text
- payload?: jsonb

## 5. DB 스키마(최소)

- 마이그레이션 도구는 쓰지 않는다.
- init-sql.db(또는 init SQL 파일)에 "최신 전체 스키마"를 유지한다.

예시(대략):

```sql
create table if not exists events (
  id           text primary key,
  source       integer not null,
  kind         integer not null,
  title        text not null,
  body         text null,
  fetched_at   timestamptz not null,
  occurred_at  timestamptz null,
  region_text  text null,
  level        integer not null,
  link         text null,
  payload      jsonb null
);

create index if not exists idx_events_fetched_at on events (fetched_at desc);
create index if not exists idx_events_kind_fetched_at on events (kind, fetched_at desc);
create index if not exists idx_events_source_fetched_at on events (source, fetched_at desc);
````

## 6. BullMQ

- queue: "ingest"
- job: "poll-source"
- payload: { sourceId: string }
- 재시도/백오프는 무난한 수준으로만(에이전트가 합리적으로 선택)

## 7. Redis Pub/Sub

- channel: "events:new"
- message: { eventId: string } (최소)

## 8. API

### GET /events

- 최신 이벤트 목록 반환
- 필터(옵션): limit, kind, source

### GET /events/stream (SSE)

- 연결 시 (옵션) since 파라미터로 DB catch-up 후 live
- live 전송은 event(JSON)을 SSE data로 보낸다.

## 9. 소스 구현(클래스 단위)

각 소스는 "하나의 클래스/객체"가 fetch+정형화를 함께 책임진다.

- sourceId
- pollIntervalSec
- run(): Promise<Event[]>  // 내부에서 fetch + normalize

소스 추가는:

- 소스 클래스 파일 추가
- registry에 등록
  으로 끝나게 한다.
