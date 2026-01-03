import type { IRegionRepository } from '../domain/port/region-repo.interface';
import type { Source } from '../domain/port/source.interface';
import type { LlmLabelClassifierService } from './llm-label-classifier.service';
import { AirkoreaO3WarningSource } from './sources/airkorea-o3-warning.source';
import { AirkoreaPmWarningSource } from './sources/airkorea-pm-warning.source';
import { DisasterSmsSource } from './sources/disaster-sms.source';
import { ForestFireInfoSource } from './sources/forest-fire-info.source';
import { KmaMicroEarthquakeSource } from './sources/kma-micro-earthquake.source';
import { KmaPewsEarthquakeSource } from './sources/kma-pews-earthquake.source';
import { KmaWeatherWarningSource } from './sources/kma-weather-warning.source';
import { NfdsFireDispatchSource } from './sources/nfds-fire-dispatch.source';
import { UticTrafficIncidentSource } from './sources/utic-traffic-incident.source';
import { YnaNewsSource } from './sources/yna-news.source';

export function buildSourceList(
  llmLabelClassifier: LlmLabelClassifierService,
  regionRepository: IRegionRepository,
): Source[] {
  return [
    new DisasterSmsSource(llmLabelClassifier, regionRepository),
    new KmaWeatherWarningSource(),
    new KmaMicroEarthquakeSource(),
    new KmaPewsEarthquakeSource(),
    new NfdsFireDispatchSource(regionRepository),
    new ForestFireInfoSource(),
    new UticTrafficIncidentSource(),
    new YnaNewsSource(llmLabelClassifier),
    new AirkoreaPmWarningSource(regionRepository),
    new AirkoreaO3WarningSource(regionRepository),
  ];
}
