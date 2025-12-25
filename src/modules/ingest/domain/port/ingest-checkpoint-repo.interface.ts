import type { EventSources } from '@/modules/events/domain/event.enums';

export type IngestCheckpoint = {
  sourceId: EventSources;
  state: string | null;
  updatedAt: string;
};

export interface IIngestCheckpointRepository {
  getCheckpoint(sourceId: EventSources): Promise<IngestCheckpoint | null>;
  upsertCheckpoint(sourceId: EventSources, state: string | null): Promise<void>;
}
