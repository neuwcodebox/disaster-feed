import type { Source } from '../domain/port/source.interface';
import { DisasterSmsSource } from './sources/disaster-sms.source';

export const sourceList: Source[] = [new DisasterSmsSource()];
