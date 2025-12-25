import { inject, injectable } from 'inversify';
import type { Kysely } from 'kysely';
import { DbDeps } from '@/infra/db/db.dep';
import type { DatabaseScheme } from '@/infra/db/db-scheme';
import type { EventRow, NewEventRow } from '@/infra/db/events.table';
import type { Event, NewEvent } from '../domain/entity/event.entity';
import type { IEventRepository, ListEventsParams, ListEventsSinceParams } from '../domain/port/event-repo.interface';

@injectable()
export class EventRepository implements IEventRepository {
  constructor(
    @inject(DbDeps.Database)
    private readonly db: Kysely<DatabaseScheme>,
  ) {}

  public async insertEvent(data: NewEvent): Promise<Event> {
    const row = await this.db.insertInto('events').values(toEventRow(data)).returningAll().executeTakeFirstOrThrow();
    return toEvent(row);
  }

  public async getEventById(id: string): Promise<Event | undefined> {
    const row = await this.db.selectFrom('events').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) {
      return undefined;
    }
    return toEvent(row);
  }

  public async listEvents(params: ListEventsParams): Promise<Event[]> {
    const limit = params.limit ?? 50;

    let query = this.db.selectFrom('events').selectAll().orderBy('fetched_at', 'desc').limit(limit);

    if (params.kind !== undefined) {
      query = query.where('kind', '=', params.kind);
    }

    if (params.source) {
      query = query.where('source', '=', params.source);
    }

    const rows = await query.execute();
    return rows.map((row) => toEvent(row));
  }

  public async listEventsSince(params: ListEventsSinceParams): Promise<Event[]> {
    const limit = params.limit ?? 500;

    const rows = await this.db
      .selectFrom('events')
      .selectAll()
      .where('fetched_at', '>', params.since)
      .orderBy('fetched_at', 'asc')
      .limit(limit)
      .execute();

    return rows.map((row) => toEvent(row));
  }
}

function toEventRow(data: NewEvent): NewEventRow {
  return {
    id: data.id,
    source: data.source,
    kind: data.kind,
    title: data.title,
    body: data.body ?? null,
    fetched_at: data.fetchedAt,
    occurred_at: data.occurredAt ?? null,
    region_text: data.regionText ?? null,
    level: data.level,
    payload: data.payload ?? null,
  };
}

function normalizeTimestamp(value: string | Date | null): string | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

function toEvent(row: EventRow): Event {
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    title: row.title,
    body: row.body ?? null,
    fetchedAt: normalizeTimestamp(row.fetched_at) ?? row.fetched_at,
    occurredAt: normalizeTimestamp(row.occurred_at),
    regionText: row.region_text ?? null,
    level: row.level,
    payload: row.payload ?? null,
  };
}
