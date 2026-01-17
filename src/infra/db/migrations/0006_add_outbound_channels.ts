import type { Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('outbound_channels')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('kind', 'smallint', (col) => col.notNull())
    .addColumn('min_level', 'smallint', (col) => col.notNull())
    .addColumn('target', 'text', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('outbound_channels').execute();
}
