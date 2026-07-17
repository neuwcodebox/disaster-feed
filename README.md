# disaster-feed

재난/안전 관련 여러 데이터 소스를 주기적으로 수집해 공통된 형태의 이벤트 스트림으로 제공하는 서비스입니다.

![Demo Screenshot](./docs/demo.png)

## 주요 기능

- 다양한 소스에서 재난/안전 정보를 폴링 수집
- 지리/행정 구역 매핑
- 이벤트 형태로 정형화해 DB에 저장
- 최신 이벤트 목록을 HTTP API로 제공
- 실시간 SSE 스트림 제공
- AI 기반 분류
- 디스코드 웹훅 발송

## 제공 데이터

- [x] 재난문자
- [x] 국내외 지진
- [ ] 지진해일
- [ ] 화산
- [x] 화재출동
- [x] 산불현황
- [x] 기상 특보
- [x] 대기질 (PM, O3)
- [x] 교통 돌발정보
- [x] 산사태 예보
- [x] 사이버위기경보
- [x] 테러경보
- [x] 산불경보
- [x] 홍수특보
- [x] 전력수급현황
- [x] 재난 뉴스
- [x] 행안부 보도자료
- [x] 과기정통부 보도자료
- [x] 질병관리청 보도자료
- [x] 우주환경/전파재난 경보
- [x] 방재기상관측(AWS)
- [x] OpenSky
- [ ] SNS 이슈

## 데이터 흐름

1) BullMQ 반복 잡으로 소스별 폴링
2) 소스가 원본 fetch 후 이벤트로 정형화
3) 이벤트를 DB에 저장하고, Pub/Sub으로 새 이벤트 ID 발행
4) 각 인스턴스가 메시지를 수신해 SSE로 브로드캐스트
5) SSE 재연결 시 누락분을 DB에서 보낸 뒤 live 전환

## 사용 기술

- Node.js / TypeScript
- Hono, Kysely
- Postgres, Redis, BullMQ

## 데이터 출처 및 라이선스

### 행정동 경계

`data/HangJeongDong_ver20260701.geojson`은 통계청 통계지리정보서비스(SGIS)의 행정동 경계를 바탕으로
[vuski/admdongkor](https://github.com/vuski/admdongkor)에서 수정·보정하고 시계열로 확장한 데이터를 사용합니다.

- 원천 데이터: [통계청 통계지리정보서비스(SGIS)](https://sgis.kostat.go.kr)
- 원천 데이터 이용조건: [공공누리 제1유형(출처표시)](https://www.kogl.or.kr/info/licenseType1.do)
- 가공물 제공: [vuski/admdongkor](https://github.com/vuski/admdongkor)
- 가공물 라이선스: [CC BY 4.0 및 LICENSE-DATA](https://github.com/vuski/admdongkor/blob/master/LICENSE-DATA)

SGIS 데이터의 출처표시 의무는 수정·가공·재배포 여부와 관계없이 유지됩니다.
행정동 경계와 이를 이용해 계산한 중심점은 실제 이용 목적에 맞는지 공식 자료와 함께 확인해야 합니다.

## 면책 조항

이 프로젝트는 개인 학습 및 실험 목적으로 개발된 비상업적 오픈소스 소프트웨어입니다.
제공되는 데이터의 정확성, 완전성, 신뢰성에 대해 어떠한 보증도 하지 않으며,
이 소프트웨어의 사용으로 인해 발생하는 모든 종류의 손해에 대해 책임을 지지 않습니다.
실제 재난/안전 상황에서는 공식 채널과 기관의 정보를 반드시 확인하시기 바랍니다.
