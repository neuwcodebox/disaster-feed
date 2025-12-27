import type { Source } from '../domain/port/source.interface';
import { AirkoreaO3WarningSource } from './sources/airkorea-o3-warning.source';
import { AirkoreaPmWarningSource } from './sources/airkorea-pm-warning.source';
import { DisasterSmsSource } from './sources/disaster-sms.source';
import { ForestFireInfoSource } from './sources/forest-fire-info.source';
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
  new ForestFireInfoSource(),
  new UticTrafficIncidentSource(),
  new AirkoreaPmWarningSource(),
  new AirkoreaO3WarningSource(),
];
