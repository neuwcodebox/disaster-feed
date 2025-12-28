import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('events')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('source', 'smallint', (col) => col.notNull())
    .addColumn('kind', 'smallint', (col) => col.notNull())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('body', 'text')
    .addColumn('fetched_at', 'timestamptz', (col) => col.notNull())
    .addColumn('occurred_at', 'timestamptz')
    .addColumn('region_text', 'text')
    .addColumn('level', 'smallint', (col) => col.notNull())
    .addColumn('payload', 'jsonb')
    .execute();

  await db.schema.createIndex('idx_events_fetched_at').ifNotExists().on('events').column('fetched_at desc').execute();

  await db.schema
    .createIndex('idx_events_kind_fetched_at')
    .ifNotExists()
    .on('events')
    .columns(['kind', 'fetched_at desc'])
    .execute();

  await db.schema
    .createIndex('idx_events_source_fetched_at')
    .ifNotExists()
    .on('events')
    .columns(['source', 'fetched_at desc'])
    .execute();

  await db.schema
    .createTable('ingest_checkpoints')
    .ifNotExists()
    .addColumn('source_id', 'integer', (col) => col.primaryKey())
    .addColumn('state', 'text')
    .addColumn('updated_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('idx_events_source_fetched_at').ifExists().execute();
  await db.schema.dropIndex('idx_events_kind_fetched_at').ifExists().execute();
  await db.schema.dropIndex('idx_events_fetched_at').ifExists().execute();
  await db.schema.dropTable('ingest_checkpoints').ifExists().execute();
  await db.schema.dropTable('events').ifExists().execute();
}
