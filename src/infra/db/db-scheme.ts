import type { EventsTable } from '@/infra/db/events.table';

export interface DatabaseScheme {
  events: EventsTable;
}
