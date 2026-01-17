import type { EventsTable } from '@/infra/db/events.table';
import type { IngestCheckpointsTable } from '@/infra/db/ingest-checkpoints.table';
import type { OutboundChannelsTable } from '@/infra/db/outbound-channels.table';
import type { RegionsTable } from '@/infra/db/regions.table';

export interface DatabaseScheme {
  events: EventsTable;
  ingest_checkpoints: IngestCheckpointsTable;
  outbound_channels: OutboundChannelsTable;
  regions: RegionsTable;
}
