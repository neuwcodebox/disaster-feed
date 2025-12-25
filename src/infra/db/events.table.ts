import type { Insertable, JSONColumnType, Selectable } from 'kysely';

export interface EventsTable {
  id: string;
  source: string;
  kind: number;
  title: string;
  fetched_at: string;
  occurred_at: string | null;
  region_text: string | null;
  level: string | null;
  link: string | null;
  payload: JSONColumnType<Record<string, unknown> | null>;
}

export type EventRow = Selectable<EventsTable>;
export type NewEventRow = Insertable<EventsTable>;
