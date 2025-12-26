import type { Source } from '../domain/port/source.interface';
import { DisasterSmsSource } from './sources/disaster-sms.source';
import { KmaMicroEarthquakeSource } from './sources/kma-micro-earthquake.source';
import { KmaPewsEarthquakeSource } from './sources/kma-pews-earthquake.source';
import { KmaWeatherWarningSource } from './sources/kma-weather-warning.source';
import { NfdsFireDispatchSource } from './sources/nfds-fire-dispatch.source';

export const sourceList: Source[] = [
  new DisasterSmsSource(),
  new KmaWeatherWarningSource(),
  new KmaMicroEarthquakeSource(),
  new KmaPewsEarthquakeSource(),
  new NfdsFireDispatchSource(),
];
