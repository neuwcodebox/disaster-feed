import { inject, injectable } from 'inversify';
import type { Kysely } from 'kysely';
import { DbDeps } from '@/infra/db/db.dep';
import type { DatabaseScheme } from '@/infra/db/db-scheme';
import type { IStationRepository, StationInfo } from '../domain/port/station-repo.interface';

@injectable()
export class StationRepository implements IStationRepository {
  constructor(
    @inject(DbDeps.Database)
    private readonly db: Kysely<DatabaseScheme>,
  ) {}

  public async findByCode(code: number): Promise<StationInfo | null> {
    const row = await this.db
      .selectFrom('stations')
      .select([
        'code',
        'start_date',
        'end_date',
        'name',
        'address',
        'office',
        'lat',
        'lng',
        'altitude_m',
        'barometer_m',
        'thermometer_m',
        'anemometer_m',
        'rain_gauge_m',
      ])
      .where('code', '=', code)
      .limit(1)
      .executeTakeFirst();

    if (!row) {
      return null;
    }

    return {
      code: row.code,
      startDate: row.start_date,
      endDate: row.end_date,
      name: row.name,
      address: row.address,
      office: row.office,
      lat: row.lat,
      lng: row.lng,
      altitudeM: row.altitude_m,
      barometerM: row.barometer_m,
      thermometerM: row.thermometer_m,
      anemometerM: row.anemometer_m,
      rainGaugeM: row.rain_gauge_m,
    };
  }
}
