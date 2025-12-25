import type { EventPayload } from '@/modules/events/domain/entity/event.entity';
import type { EventKind, EventLevel } from '@/modules/events/domain/event.enums';

export type SourceEvent = {
  kind: EventKind;
  title: string;
  body?: string | null;
  occurredAt?: string | null;
  regionText?: string | null;
  level: EventLevel;
  link?: string | null;
  payload?: EventPayload | null;
};

export interface Source {
  sourceId: string;
  pollIntervalSec: number;
  run(): Promise<SourceEvent[]>;
}
