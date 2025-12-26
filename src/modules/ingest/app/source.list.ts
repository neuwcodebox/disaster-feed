import type { Source } from '../domain/port/source.interface';
import { AirkoreaPmWarningSource } from './sources/airkorea-pm-warning.source';
import { DisasterSmsSource } from './sources/disaster-sms.source';
import { KmaMicroEarthquakeSource } from './sources/kma-micro-earthquake.source';
import { KmaPewsEarthquakeSource } from './sources/kma-pews-earthquake.source';
import { KmaWeatherWarningSource } from './sources/kma-weather-warning.source';
import { NfdsFireDispatchSource } from './sources/nfds-fire-dispatch.source';
import { UticTrafficIncidentSource } from './sources/utic-traffic-incident.source';

export const sourceList: Source[] = [
  new DisasterSmsSource(),
  new KmaWeatherWarningSource(),
  new KmaMicroEarthquakeSource(),
  new KmaPewsEarthquakeSource(),
  new NfdsFireDispatchSource(),
  new UticTrafficIncidentSource(),
  new AirkoreaPmWarningSource(),
];
