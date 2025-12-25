import type { EventPayload } from '@/modules/events/domain/entity/event.entity';

export type SourceEvent = {
  kind: number;
  title: string;
  occurredAt?: string | null;
  regionText?: string | null;
  level?: string | null;
  link?: string | null;
  payload?: EventPayload | null;
};

export interface Source {
  sourceId: string;
  pollIntervalSec: number;
  run(): Promise<SourceEvent[]>;
}
