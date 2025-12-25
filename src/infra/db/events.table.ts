import type { Insertable, Selectable } from 'kysely';

export interface EventsTable {
  id: string;
  source: number;
  kind: number;
  title: string;
  body: string | null;
  fetched_at: string;
  occurred_at: string | null;
  region_text: string | null;
  level: number;
  payload: Record<string, unknown> | null;
}

export type EventRow = Selectable<EventsTable>;
export type NewEventRow = Insertable<EventsTable>;
