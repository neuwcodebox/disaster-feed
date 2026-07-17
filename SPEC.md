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

1) BullMQ Job Scheduler로 소스별 폴링 잡을 주기 실행
2) 잡 실행 시 해당 소스 클래스가:
   - 원본 fetch
   - 이벤트로 정형화
   - DB insert(append-only)
   - 체크포인트 state 저장(소스별 문자열 상태)
3) insert 성공 시 Redis Pub/Sub로 eventId publish
4) 아웃바운드 큐에 eventId를 넣고 워커가 채널 송출 수행
5) 각 인스턴스는 Pub/Sub 메시지를 받아 DB 조회 후 로컬 SSE로 브로드캐스트
6) SSE 재연결 시 DB에서 누락분 catch-up 후 live 전환

## 4. 이벤트 스키마(논리)

- id: UUID v7
- source: number (앱에서 enum 관리)
- kind: number (앱에서 enum 관리)
- title: string
- body?: text
- fetched_at: timestamptz
- occurred_at?: timestamptz
- region_text?: text
- geo?: { lat: number; lng: number }
- region_codes?: string(10)[]
- level: number
- payload?: jsonb

## 5. DB 스키마(최소)

- Kysely Migrator로 마이그레이션을 실행한다.
- init-db.sql(또는 init SQL 파일)은 최신 전체 스키마를 확인하기 위한 문서로 유지한다.
- init-db.sql은 마이그레이션 실행에 사용하지 않는다.

- outbound_channels
  - id: uuid
  - kind: smallint
  - min_level: smallint
  - target: text

## 6. BullMQ

- queue: "ingest"
- job: "poll-source"
- payload: { sourceId: number }
- 스케줄 등록: Job Scheduler(upsertJobScheduler)
- 재시도/백오프는 무난한 수준으로만(에이전트가 합리적으로 선택)

## 7. Redis Pub/Sub

- channel: "events:new"
- message: { eventId: string } (최소)

## 8. API

### GET /api/events

- 최신 이벤트 목록 반환
- 필터(옵션): limit, kind, source, since

### GET /api/events/stream (SSE)

- 연결 시 (옵션) afterId 쿼리 파라미터 또는 Last-Event-ID 헤더로 DB catch-up 후 live
- 둘 다 있으면 afterId가 우선한다.
- live 전송은 event(JSON)을 SSE data로 보낸다.

### Admin: /api/admin/channels

- Authorization: `Bearer ${ADMIN_API_KEY}`
- GET /api/admin/channels: 채널 목록
- POST /api/admin/channels: 채널 생성
- GET /api/admin/channels/:id: 채널 상세
- PUT /api/admin/channels/:id: 채널 수정
- DELETE /api/admin/channels/:id: 채널 삭제

## 9. 소스 구현(클래스 단위)

각 소스는 "하나의 클래스/객체"가 fetch+정형화를 함께 책임진다.

- sourceId (EventSources enum 숫자값)
- pollIntervalSec
- run(state: string | null): Promise<{ events: Event[]; nextState: string | null }>  // 내부에서 fetch + normalize + state 갱신

소스 추가는:

- 소스 클래스 파일 추가
- registry에 등록
  으로 끝나게 한다.

## 10. 행정구역 코드 표준

대한민국 행정구역 코드는 최대 10자리 숫자로 구성되며, 2자리(시/도) + 3자리(시/군/구) + 3자리(읍/면/동) + 2자리(리) 순서로 계층적인 구조를 가집니다.

시/도 (2자리): 서울(11), 부산(21), 경기(31) 등 광역자치단체를 나타냅니다.
시/군/구 (3자리): 시, 군, 구 단위의 기초자치단체를 나타냅니다.
읍/면/동 (3자리): 읍, 면, 동 단위의 행정구역을 나타냅니다.
리 (2자리): 리 또는 통 단위의 하위 행정구역을 나타냅니다.

하위 행정구역 코드를 포함하지 않는 경우, 해당 부분은 '00'으로 채워지거나 생략될 수 있습니다.

- 법정동 코드 기준 데이터는 `data/regions20260706.txt` 스냅샷을 사용한다.
- 신·구 법정동 코드를 함께 보관하며 이벤트의 기존 코드를 현행 코드로 자동 변환하지 않는다.
- 명칭 조회는 현존 코드를 우선하고, 일치하는 현존 코드가 없으면 폐지 코드를 사용한다.
- 데이터 소스가 이전 명칭이나 코드를 제공하면 해당 시점의 코드로 저장하고 `region_text`에 원문을 보존한다.
- 신규 코드 중심점은 `data/HangJeongDong_ver20260701.geojson`의 행정동 경계를 사용한다. 코드와 명칭이 일치하는 신규 읍·면·동은 해당 도형의 중심점을 사용하고, 신규 시·군·구 및 시·도는 하위 행정동 도형을 면적 가중 집계한다.
- 신·구 코드 사이에서 좌표를 추정해 승계하지 않는다.
- 행정동 명칭 변경·분동은 법정동 코드와 별도로 취급하며, 법정동 코드 스냅샷에 포함된 변경만 이 테이블에 반영한다.

## 11. 데이터 보존

- 이벤트는 기본 30일 보관하며, 주기적으로 오래된 데이터를 배치 삭제한다.
- 삭제는 성능 영향을 줄이기 위해 일정 간격/배치 크기로 제한한다.
