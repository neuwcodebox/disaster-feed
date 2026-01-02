import type { Insertable, Selectable } from 'kysely';

export interface RegionsTable {
  code: string;
  name: string;
  abolished: boolean;
}

export type RegionRow = Selectable<RegionsTable>;
export type NewRegionRow = Insertable<RegionsTable>;
