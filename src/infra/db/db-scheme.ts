import type { HealthTable } from '@/modules/health/domain/entity/health.entity';

export interface DatabaseScheme {
  health: HealthTable;
}
