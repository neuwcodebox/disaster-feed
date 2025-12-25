import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

export interface HealthTable {
  id: ColumnType<number, never, never>;
  message: string | null;
  createdAt: Generated<string>;
}

export type HealthEntity = Selectable<HealthTable>;
export type NewHealth = Insertable<HealthTable>;
export type HealthUpdate = Updateable<HealthTable>;
