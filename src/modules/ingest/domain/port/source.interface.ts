import type { EventPayload } from '@/modules/events/domain/entity/event.entity';
import type { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';

export type SourceEvent = {
  kind: EventKinds;
  title: string;
  body?: string | null;
  occurredAt?: string | null;
  regionText?: string | null;
  level: EventLevels;
  link?: string | null;
  payload?: EventPayload | null;
};

export interface Source {
  sourceKey: EventSources;
  sourceId: string;
  pollIntervalSec: number;
  run(): Promise<SourceEvent[]>;
}
