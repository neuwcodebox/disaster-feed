import type { Source } from '../domain/port/source.interface';
import { DisasterSmsSource } from './sources/disaster-sms.source';
import { KmaMicroEarthquakeSource } from './sources/kma-micro-earthquake.source';

export const sourceList: Source[] = [new DisasterSmsSource(), new KmaMicroEarthquakeSource()];
