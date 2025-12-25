# disaster-feed

재난/안전 관련 여러 데이터 소스를 주기적으로 수집해 공통 형태의 "이벤트"로 정리하고,
최신 정보를 API와 실시간 스트림(SSE)으로 제공하는 백엔드 서비스입니다.
프로토타입 단계에서 "수집 → 저장 → 조회/실시간" 파이프라인이 실제로 동작함을 증명하는 것이 목적입니다.

## 주요 기능

- 다양한 소스에서 재난/안전 정보를 폴링 수집
- 이벤트 형태로 정형화해 DB에 저장
- 최신 이벤트 목록을 HTTP API로 제공
- 실시간 UX를 위한 SSE 스트림 제공

## 데이터 흐름(요약)

1) BullMQ 반복 잡으로 소스별 폴링
2) 소스가 원본 fetch 후 이벤트로 정형화
3) 이벤트를 DB에 저장하고, Pub/Sub으로 새 이벤트 ID 발행
4) 각 인스턴스가 메시지를 수신해 SSE로 브로드캐스트
5) SSE 재연결 시 누락분을 DB에서 보낸 뒤 live 전환

## 사용 기술

- Node.js / TypeScript
- Hono, Kysely
- Postgres, Redis, BullMQ

## 로컬 실행

1) Postgres/Redis 실행

```bash
docker-compose up -d
```

1) 앱 실행

```bash
npm install
npm run dev
```

1) 주요 엔드포인트

- GET /events
- GET /events/stream
