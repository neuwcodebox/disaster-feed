import type { Insertable, Selectable } from 'kysely';

export interface IngestCheckpointsTable {
  source_id: number;
  state: string | null;
  updated_at: string;
}

export type IngestCheckpointRow = Selectable<IngestCheckpointsTable>;
export type NewIngestCheckpointRow = Insertable<IngestCheckpointsTable>;
