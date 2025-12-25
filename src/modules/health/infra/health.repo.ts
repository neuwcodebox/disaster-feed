import { inject, injectable } from 'inversify';
import type { Kysely } from 'kysely';
import { DbDeps } from '@/infra/db/db.dep';
import type { DatabaseScheme } from '@/infra/db/db-scheme';
import type { HealthEntity, HealthUpdate, NewHealth } from '../domain/entity/health.entity';
import type { IHealthRepository } from '../domain/port/health-repo.interface';

@injectable()
export class HealthRepository implements IHealthRepository {
  constructor(
    @inject(DbDeps.Database)
    private readonly db: Kysely<DatabaseScheme>,
  ) {}

  public async createHealth(data: NewHealth): Promise<HealthEntity> {
    return await this.db.insertInto('health').values(data).returningAll().executeTakeFirstOrThrow();
  }

  public async getHealthById(id: number): Promise<HealthEntity | undefined> {
    return await this.db.selectFrom('health').selectAll().where('id', '=', id).executeTakeFirst();
  }

  public async updateHealth(id: number, data: HealthUpdate): Promise<HealthEntity | undefined> {
    return await this.db.updateTable('health').set(data).where('id', '=', id).returningAll().executeTakeFirst();
  }

  public async deleteHealth(id: number): Promise<boolean> {
    const res = await this.db.deleteFrom('health').where('id', '=', id).executeTakeFirst();
    return res.numDeletedRows > 0;
  }
}
