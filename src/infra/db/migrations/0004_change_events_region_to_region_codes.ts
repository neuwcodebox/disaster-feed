import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('events').addColumn('region_codes', sql`varchar(10)[]`).execute();
  await sql`update events set region_codes = array[region] where region is not null`.execute(db);
  await db.schema.alterTable('events').dropColumn('region').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('events').addColumn('region', 'varchar(10)').execute();
  await sql`update events set region = region_codes[1] where region_codes is not null`.execute(db);
  await db.schema.alterTable('events').dropColumn('region_codes').execute();
}
