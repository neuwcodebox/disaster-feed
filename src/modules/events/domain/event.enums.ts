/*
새 항목은 마지막에 추가할 것
기존 항목의 숫자는 변경하지 말 것
*/

export enum EventKinds {
  Other = 1, // 기타
  Quake = 2, // 지진
  Ai = 3, // AI(조류인플루엔자)
  Drought = 4, // 가뭄
  Livestock = 5, // 가축질병
  Wind = 6, // 강풍
  Dry = 7, // 건조
  Transport = 8, // 교통
  TrafficCrash = 9, // 교통사고
  TrafficCtrl = 10, // 교통통제
  Finance = 11, // 금융
  Snow = 12, // 대설
  FineDust = 13, // 미세먼지
  CivDef = 14, // 민방공
  Collapse = 15, // 붕괴
  Wildfire = 16, // 산불
  Landslide = 17, // 산사태
  Water = 18, // 수도
  Fog = 19, // 안개
  Energy = 20, // 에너지
  Epidemic = 21, // 전염병
  Blackout = 22, // 정전
  Tsunami = 23, // 지진해일
  Typhoon = 24, // 태풍
  Terror = 25, // 테러
  Telecom = 26, // 통신
  Explosion = 27, // 폭발
  Heat = 28, // 폭염
  HighSeas = 29, // 풍랑
  Cold = 30, // 한파
  Rain = 31, // 호우
  Flood = 32, // 홍수
  Fire = 33, // 화재
  Pollution = 34, // 환경오염사고
  YellowDust = 35, // 황사
  O3 = 36, // 오존
}

export enum EventLevels {
  Info = 1, // 상황 인지용 정보 / 알고만 있으면 됨 / 몰라도 무방
  Minor = 2, // 지역·국소적 문제 / 주의만 기울일 것 / 대비 권장
  Moderate = 3, // 명확한 위험, 주의 필요 / 행동 권장 / 대비 필요
  Severe = 4, // 광범위 영향, 즉각 대응 / 행동 필요 / 신속한 대비
  Critical = 5, // 생명 위협·대규모 재난 / 즉시 행동 / 최우선 대응
}

export enum EventSources {
  SafekoreaSms = 1,
  KmaMicroEarthquake = 2,
  KmaPewsEarthquake = 3,
  NfdsFireDispatch = 4,
  KmaWeatherWarning = 5,
  UticTrafficIncident = 6,
  AirkoreaPmWarning = 7,
  AirkoreaO3Warning = 8,
  ForestFireInfo = 9,
}
