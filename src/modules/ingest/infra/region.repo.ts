import { inject, injectable } from 'inversify';
import type { Kysely } from 'kysely';
import { DbDeps } from '@/infra/db/db.dep';
import type { DatabaseScheme } from '@/infra/db/db-scheme';
import type { IRegionRepository, RegionCenter } from '../domain/port/region-repo.interface';

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

  public async findCodeByNamePostfix(namePostfix: string): Promise<string | null> {
    if (!namePostfix) {
      return null;
    }

    const row = await this.db
      .selectFrom('regions')
      .select('code')
      .where('name', 'like', `%${namePostfix}`)
      .where('abolished', '=', false)
      .orderBy('code', 'asc')
      .limit(1)
      .executeTakeFirst();

    return row?.code ?? null;
  }

  public async findCentersByCodes(codes: string[]): Promise<Map<string, RegionCenter>> {
    if (codes.length === 0) {
      return new Map();
    }

    const uniqueCodes = Array.from(new Set(codes));
    const rows = await this.db
      .selectFrom('regions')
      .select(['code', 'center_lat', 'center_lng'])
      .where('code', 'in', uniqueCodes)
      .where('abolished', '=', false)
      .execute();

    const result = new Map<string, RegionCenter>();
    for (const row of rows) {
      result.set(row.code, {
        code: row.code,
        centerLat: row.center_lat,
        centerLng: row.center_lng,
      });
    }

    return result;
  }
}
