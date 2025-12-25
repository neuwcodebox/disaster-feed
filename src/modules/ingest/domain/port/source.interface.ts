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

export type SourceRunResult = {
  events: SourceEvent[];
  nextState: string | null;
};

export interface Source {
  sourceId: EventSources;
  pollIntervalSec: number;
  run(state: string | null): Promise<SourceRunResult>;
}
