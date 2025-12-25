import type { EventsTable } from '@/infra/db/events.table';
import type { HealthTable } from '@/modules/health/domain/entity/health.entity';

export interface DatabaseScheme {
  events: EventsTable;
  health: HealthTable;
}
