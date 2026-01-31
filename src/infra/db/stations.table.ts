import type { Insertable, Selectable } from 'kysely';

export interface StationsTable {
  code: number;
  start_date: string;
  end_date: string | null;
  name: string;
  address: string | null;
  office: string | null;
  lat: number | null;
  lng: number | null;
  altitude_m: number | null;
  barometer_m: number | null;
  thermometer_m: number | null;
  anemometer_m: number | null;
  rain_gauge_m: number | null;
}

export type StationRow = Selectable<StationsTable>;
export type NewStationRow = Insertable<StationsTable>;
