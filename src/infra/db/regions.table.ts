import type { Insertable, Selectable } from 'kysely';

export interface RegionsTable {
  code: string;
  name: string;
  abolished: boolean;
  center_lat: number | null;
  center_lng: number | null;
}

export type RegionRow = Selectable<RegionsTable>;
export type NewRegionRow = Insertable<RegionsTable>;
