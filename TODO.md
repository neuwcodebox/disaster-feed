# TODO.md

## 0. 기본 준비

- [x] hono-template 기반으로 프로젝트 시작
- [x] npm 기준 스크립트 정리(dev/start/lint 등)
- [x] docker-compose: postgres, redis
- [x] .env.example 작성(DATABASE_URL, REDIS_URL 등)
- [x] init-sql.db(또는 init SQL 파일) 추가: events 테이블 + 인덱스

## 1. Infra 구성

- [x] Postgres 연결(Kysely) 세팅
- [x] Redis 연결 세팅
- [x] BullMQ queue/worker 세팅(단일 앱 내에서 같이 구동)
- [x] Redis Pub/Sub publish/subscribe 세팅

## 2. 이벤트 저장/조회

- [x] UUID 기반 이벤트 id 생성 유틸
- [x] events insert/list repo(또는 서비스) 구현
- [x] GET /events 구현(최신 목록, limit/kind/source 정도)
- [x] events 스키마 본문/level 타입 변경 및 enum 정리
- [x] events 테이블 link 컬럼 제거

## 3. SSE(멀티 인스턴스 포함)

- [x] 로컬 SSE 클라이언트 관리(Set 등) 구현
- [x] GET /events/stream 구현
  - [x] (선택) since 파라미터로 DB에서 먼저 보내고 live 전환
- [x] 새 이벤트 fanout:
  - [x] 이벤트 insert 성공 후 Pub/Sub로 eventId publish
  - [x] subscribe 측에서 eventId 수신 → DB 조회 → 로컬 SSE broadcast

## 4. Ingest(소스 실행)

- [x] "소스 클래스" 인터페이스/형식 정리(sourceId, pollIntervalSec, run())
- [x] 소스 registry 작성(활성화된 소스 목록)
- [x] 앱 부팅 시 repeatable job 등록(소스별 주기)
- [x] worker에서 sourceId로 소스 run() 실행 → events insert → publish
- [x] INGEST_ENABLED 플래그로 수집 역할 분리
- [x] DB 체크포인트(소스별 state) 저장/조회

## 5. 실제 소스 어댑터 구현 전 사전 파악(중요)

- [ ] 사람과 함께 각 소스별로 수집 방식 파악(정적 HTML / 내부 JSON / RSS / 인증/쿠키 필요 여부)
- [ ] 폴링 주기/변경 빈도 대략 파악(너무 잦은 요청 방지)
- [ ] 파싱에 필요한 최소 필드 합의(title, occurred_at, region_text, payload 후보)
- [ ] 실패 케이스 파악(요청 차단, 응답 포맷 변경, 빈 목록 등) 및 최소 대응(로그/타임아웃)

## 6. 실제 소스 어댑터 구현

- [x] 재난문자(DisasterSmsList) 엔드포인트 확인 및 요청 파라미터 정리
- [x] 재난문자 필드 매핑 합의(title/occurred_at/region_text/level/payload)
- [x] 재난문자 폴링 주기 초안 결정
- [x] 재난문자 실패 케이스 최소 대응(타임아웃/빈 목록/포맷 변경)
- [x] 재난문자 제목에 발송 주체 반영
- [x] 재난문자 region 콤마 공백 정규화
- [x] EventKinds 재난 종류 확장
- [x] 재난문자 DSSTR_SE_NM kind 매핑 확장
- [x] 기상청 미소지진(HTML) 엔드포인트 확인 및 응답 파싱 규칙 정리
- [x] 기상청 미소지진 필드 매핑 합의(title/occurred_at/region_text/level/payload)
- [x] 기상청 미소지진 폴링 주기 초안 결정
- [x] 기상청 미소지진 실패 케이스 최소 대응(타임아웃/빈 목록/포맷 변경)

## 7. 운영 최소

- [ ] /healthz, /readyz
- [ ] graceful shutdown(서버/redis/worker/db)
- [ ] 로그 정리(잡 실패/파싱 실패 구분)
- [x] 디버그 로그 보강
- [x] health 모듈 ping API 단순화 및 health 테이블 제거

## 8. 문서

- [x] README 프로젝트 소개 문서 작성
