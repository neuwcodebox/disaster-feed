import type { EventsTable } from '@/infra/db/events.table';
import type { IngestCheckpointsTable } from '@/infra/db/ingest-checkpoints.table';
import type { RegionsTable } from '@/infra/db/regions.table';

export interface DatabaseScheme {
  events: EventsTable;
  ingest_checkpoints: IngestCheckpointsTable;
  regions: RegionsTable;
}
