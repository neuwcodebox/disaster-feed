import { inject, injectable } from 'inversify';
import type { Kysely } from 'kysely';
import { DbDeps } from '@/infra/db/db.dep';
import type { DatabaseScheme } from '@/infra/db/db-scheme';
import type { EventRow, NewEventRow } from '@/infra/db/events.table';
import type { Event, EventGeo, EventMetric, NewEvent } from '../domain/entity/event.entity';
import type { EventSources } from '../domain/event.enums';
import type {
  IEventRepository,
  LatestFetchedAtBySource,
  ListEventsAfterIdParams,
  ListEventsParams,
} from '../domain/port/event-repo.interface';

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

    if (params.minLevel !== undefined) {
      query = query.where('level', '>=', params.minLevel);
    }

    if (params.since !== undefined) {
      query = query.where('fetched_at', '>=', params.since);
    }

    const rows = await query.execute();
    return rows.map((row) => toEvent(row));
  }

  public async listEventMetrics(params: ListEventsParams): Promise<EventMetric[]> {
    const limit = params.limit ?? 50;

    let query = this.db
      .selectFrom('events')
      .select(['id', 'source', 'kind', 'occurred_at', 'level'])
      .orderBy('fetched_at', 'desc')
      .limit(limit);

    if (params.kind !== undefined) {
      query = query.where('kind', '=', params.kind);
    }

    if (params.source) {
      query = query.where('source', '=', params.source);
    }

    if (params.since !== undefined) {
      query = query.where('fetched_at', '>=', params.since);
    }

    const rows = await query.execute();
    return rows.map((row) => toEventMetric(row));
  }

  public async listEventsAfterId(params: ListEventsAfterIdParams): Promise<Event[]> {
    const limit = params.limit ?? 500;

    const baseRow = await this.db
      .selectFrom('events')
      .select('fetched_at')
      .where('id', '=', params.afterId)
      .executeTakeFirst();

    if (!baseRow) {
      return [];
    }

    if (!baseRow.fetched_at) {
      const rows = await this.db
        .selectFrom('events')
        .selectAll()
        .where('id', '>', params.afterId)
        .orderBy('id', 'asc')
        .limit(limit)
        .execute();

      return rows.map((row) => toEvent(row));
    }

    const rows = await this.db
      .selectFrom('events')
      .selectAll()
      .where('fetched_at', '>=', baseRow.fetched_at)
      .orderBy('fetched_at', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();

    return rows.map((row) => toEvent(row));
  }

  public async listLatestFetchedAtBySources(sourceIds: EventSources[]): Promise<LatestFetchedAtBySource[]> {
    if (sourceIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .selectFrom('events')
      .select(['source', this.db.fn.max('fetched_at').as('latest_fetched_at')])
      .where('source', 'in', sourceIds)
      .groupBy('source')
      .execute();

    const results: LatestFetchedAtBySource[] = [];
    for (const row of rows) {
      if (!row.latest_fetched_at) {
        continue;
      }

      results.push({
        sourceId: row.source as EventSources,
        fetchedAt: row.latest_fetched_at,
      });
    }

    return results;
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
    geo_lat: data.geo?.lat ?? null,
    geo_lng: data.geo?.lng ?? null,
    region_codes: data.regionCodes ?? null,
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
    geo: toGeo(row.geo_lat, row.geo_lng),
    regionCodes: row.region_codes ?? null,
    level: row.level,
    payload: row.payload ?? null,
  };
}

type EventMetricRow = Pick<EventRow, 'id' | 'source' | 'kind' | 'occurred_at' | 'level'>;

function toEventMetric(row: EventMetricRow): EventMetric {
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    occurredAt: normalizeTimestamp(row.occurred_at),
    level: row.level,
  };
}

function toGeo(lat: number | null, lng: number | null): EventGeo | null {
  if (lat === null || lng === null) {
    return null;
  }
  return { lat, lng };
}
