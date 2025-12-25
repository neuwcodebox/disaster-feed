# AGENTS.md

## 프로젝트 개요

실시간 재난/안전 데이터 소스들을 주기적으로 수집하여, 공통 형태의 "이벤트"로 정형화해서 Postgres에 저장하고,
HTTP API 및 SSE로 최신 이벤트 목록을 제공한다.

- 프로토타입 목표: "수집 → 저장 → 조회/SSE" 파이프라인이 실제로 동작하는지 증명
- 단일 백엔드 앱이 모든 역할 수행(수집 잡 실행, API, SSE)
- 백엔드 앱은 여러 인스턴스로 실행될 수 있음(Scale-out)

## 작업 흐름

어떤 작업을 할 때마다 아래 단계를 충실히 따릅니다.

1. 요청 사항 및 AGENTS.md, SPEC.md, TODO.md 검토
2. 필요한 새 하위 작업들을 TODO.md에 추가
3. 요청에 맞는 작업 수행
4. 타입/린트 오류 검사 및 수정
5. 작업 완료 후 TODO.md 체크 업데이트
6. 필요한 경우 AGENTS.md, SPEC.md 업데이트
7. 결과 보고 및 커밋 메시지 추천

## 범위

### 이번 단계에서 하는 것

- 소스별 폴링(잡) 실행 및 이벤트 저장(append-only)
- 이벤트 목록 조회 API
- SSE 스트림(다중 인스턴스에서도 동작)
- 소스별 장애가 전체를 멈추지 않게 실패 격리

### 이번 단계에서 하지 않는 것

- 사건 병합/클러스터링(중복 통합)
- 진행/종료 같은 상태 전이
- 정교한 지오코딩/좌표 처리(문자열 지역만 있으면 충분)
- LLM 후처리

## 핵심 원칙

- DB(Postgres)가 단일 진실 공급원(SoT)
- SSE는 실시간 UX용. 놓친 이벤트는 DB 기반 catch-up으로 커버
- 소스 추가는 "파일 추가 + 등록" 정도로 끝나야 함
- 소스별 구현은 클래스(또는 객체) 하나가 fetch+정형화를 함께 수행한다(collector/normalizer 분리 없음)

## 이벤트 모델(프로토타입 최소)

- id: ULID (텍스트)
- source: 문자열 식별자 (예: "safekorea_sms")
- kind: 숫자 enum (앱에서 관리; DB에는 enum 제약 없음)
- title: 한 줄
- fetched_at: timestamptz (필수)
- 선택: occurred_at, region_text, level, link, payload(jsonb)

## 다중 인스턴스 SSE

- 이벤트 insert 성공 후 Redis Pub/Sub 채널로 eventId publish
- 모든 인스턴스가 채널을 subscribe
- 메시지를 받으면 DB에서 이벤트를 읽어와 그 인스턴스에 붙어있는 SSE 클라이언트에 전송
- SSE 재연결 시 DB에서 누락분을 보내고 live로 전환

## 개발/실행

- npm 사용
- docker-compose로 Postgres + Redis 제공
- DB 스키마는 마이그레이션 대신 init-sql.db(= init SQL 파일)에 최신 전체 스키마를 유지한다

## Code style

- 보기 좋은 코드를 작성합니다.
- Type Safe를 준수합니다. `any` 사용을 금지하며 꼭 필요하다면 `unknown`을 사용합니다.
- Biome을 사용하여 코드 스타일을 강제합니다.
- `forEach` 대신 `for` 문을 사용합니다.
- `then` 대신 `async/await`를 사용합니다.
- 주석은 남용하지 말고 코드만 봐서 이해하기 어려운 부분에만 한국어로 작성합니다.
- Code smells를 피합니다. (예: 중복 코드, 긴 함수, 긴 매개변수 목록 등)

## Git commit style

- Conventional Commits 규칙을 따릅니다.
- 서로 다른 변경을 한 커밋에 묶지 않습니다.

## Tech stack

- **Runtime/Language**: Node.js, TypeScript
- **Web Framework**: Hono
- **ORM/Database**: Kysely, PostgreSQL
- **Queue/Worker**: BullMQ
- **Pub/Sub**: Redis
- **DI/Architecture**: Inversify
- **Environment Variables**: dotenv
- **API Documentation**: Swagger UI, zod-openapi
- **Logging**: pino
- **Testing**: Vitest
- **Build/Dev Tools**: tsup, tsx, Vite
- **Code Quality/Formatter**: Biome, lint-staged, Husky

## Architecture

This project follows a layered architecture at both the top-level and within each module:

- **Top-level layers:**
  - `core`: Core logic and shared dependencies
  - `infra`: External infrastructure (e.g., database)
  - `view`: HTTP API routes and middleware
  - `modules`: Feature modules, each with its own layers

- **Module structure:**
  - `app`: Business logic such as services
  - `infra`: External infrastructure (e.g., DB repositories)
  - `view`: HTTP API route definitions
  - `domain`: Shared dependencies, DTOs, entities, interfaces, etc. (referenced by other modules)
