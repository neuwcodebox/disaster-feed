import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('events')
    .addColumn('geo_lat', 'double precision')
    .addColumn('geo_lng', 'double precision')
    .addColumn('region', 'varchar(10)')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('events').dropColumn('region').dropColumn('geo_lng').dropColumn('geo_lat').execute();
}
