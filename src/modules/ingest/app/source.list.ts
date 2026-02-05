import type { IRegionRepository } from '../domain/port/region-repo.interface';
import type { Source } from '../domain/port/source.interface';
import type { IStationRepository } from '../domain/port/station-repo.interface';
import type { LlmLabelClassifierService } from './llm-label-classifier.service';
import { AirkoreaO3WarningSource } from './sources/airkorea-o3-warning.source';
import { AirkoreaPmWarningSource } from './sources/airkorea-pm-warning.source';
import { DisasterSmsSource } from './sources/disaster-sms.source';
import { FloodAlertSource } from './sources/flood-alert.source';
import { ForestFireInfoSource } from './sources/forest-fire-info.source';
import { ForestFireWarningSource } from './sources/forest-fire-warning.source';
import { KasaSpaceWeatherCrisisAlertSource } from './sources/kasa-space-weather-crisis-alert.source';
import { KasaSpaceWeatherWarningSource } from './sources/kasa-space-weather-warning.source';
import { KdcaPressReleaseSource } from './sources/kdca-press-release.source';
import { KmaAwsObservationSource } from './sources/kma-aws-observation.source';
import { KmaMicroEarthquakeSource } from './sources/kma-micro-earthquake.source';
import { KmaOverseasEarthquakeSource } from './sources/kma-overseas-earthquake.source';
import { KmaPewsEarthquakeSource } from './sources/kma-pews-earthquake.source';
import { KmaWeatherWarningSource } from './sources/kma-weather-warning.source';
import { KpxPowerSupplySource } from './sources/kpx-power-supply.source';
import { LandslideForecastSource } from './sources/landslide-forecast.source';
import { MoisPressReleaseSource } from './sources/mois-press-release.source';
import { MsitPressReleaseSource } from './sources/msit-press-release.source';
import { NcscCyberCrisisSource } from './sources/ncsc-cyber-crisis.source';
import { NctcTerrorAlertSource } from './sources/nctc-terror-alert.source';
import { NfdsFireDispatchSource } from './sources/nfds-fire-dispatch.source';
import { OpenSkyEmergencySquawkSource } from './sources/opensky-emergency-squawk.source';
import { UticTrafficIncidentSource } from './sources/utic-traffic-incident.source';
import { YnaNewsSource } from './sources/yna-news.source';

export function buildSourceList(
  llmLabelClassifier: LlmLabelClassifierService,
  regionRepository: IRegionRepository,
  stationRepository: IStationRepository,
): Source[] {
  return [
    new DisasterSmsSource(llmLabelClassifier, regionRepository),
    new FloodAlertSource(),
    new KmaWeatherWarningSource(),
    new KmaAwsObservationSource(stationRepository),
    new KmaMicroEarthquakeSource(),
    new KmaPewsEarthquakeSource(),
    new KmaOverseasEarthquakeSource(),
    new NfdsFireDispatchSource(regionRepository),
    new ForestFireInfoSource(),
    new ForestFireWarningSource(),
    new LandslideForecastSource(),
    new UticTrafficIncidentSource(),
    new YnaNewsSource(llmLabelClassifier),
    new MoisPressReleaseSource(llmLabelClassifier),
    new MsitPressReleaseSource(llmLabelClassifier),
    new KdcaPressReleaseSource(),
    new AirkoreaPmWarningSource(regionRepository),
    new AirkoreaO3WarningSource(regionRepository),
    new NcscCyberCrisisSource(),
    new NctcTerrorAlertSource(),
    new KpxPowerSupplySource(),
    new KasaSpaceWeatherWarningSource(),
    new KasaSpaceWeatherCrisisAlertSource(),
    new OpenSkyEmergencySquawkSource(),
  ];
}
