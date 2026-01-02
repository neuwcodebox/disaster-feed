import { inject, injectable } from 'inversify';
import type { Kysely } from 'kysely';
import { DbDeps } from '@/infra/db/db.dep';
import type { DatabaseScheme } from '@/infra/db/db-scheme';
import type { IRegionRepository } from '../domain/port/region-repo.interface';

@injectable()
export class RegionRepository implements IRegionRepository {
  constructor(
    @inject(DbDeps.Database)
    private readonly db: Kysely<DatabaseScheme>,
  ) {}

  public async findCodeByNamePrefix(namePrefix: string): Promise<string | null> {
    if (!namePrefix) {
      return null;
    }

    const row = await this.db
      .selectFrom('regions')
      .select('code')
      .where('name', 'like', `${namePrefix}%`)
      .where('abolished', '=', false)
      .orderBy('code', 'asc')
      .limit(1)
      .executeTakeFirst();

    return row?.code ?? null;
  }
}
