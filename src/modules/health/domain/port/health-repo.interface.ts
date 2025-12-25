import type { HealthEntity, NewHealth } from '../entity/health.entity';

export interface IHealthRepository {
  createHealth(data: NewHealth): Promise<HealthEntity>;
}
