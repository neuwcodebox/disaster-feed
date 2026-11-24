import type { Kysely } from 'kysely';
import type { DatabaseScheme } from '../db-scheme';
import { readRegionRows, resolveDataPath } from './0008_update_regions_20260706';

const DELTA_FILE = 'regions20261111-delta.txt';
// 2026-10-01 행정동 경계에서 코드와 명칭이 일치하는 구지읍 도형의 면적 중심점.
const GUJI_EUP_CENTER = { center_lat: 35.657151872460666, center_lng: 128.40253953291437 };

export async function up(db: Kysely<DatabaseScheme>): Promise<void> {
  const rows = await Array.fromAsync(readRegionRows(resolveDataPath(DELTA_FILE)));
  await db
    .insertInto('regions')
    .values(rows)
    .onConflict((oc) =>
      oc.column('code').doUpdateSet((eb) => ({
        name: eb.ref('excluded.name'),
        abolished: eb.ref('excluded.abolished'),
      })),
    )
    .execute();
  await db.updateTable('regions').set(GUJI_EUP_CENTER).where('code', '=', '2771026800').execute();
}

export async function down(db: Kysely<DatabaseScheme>): Promise<void> {
  const rows = await Array.fromAsync(readRegionRows(resolveDataPath(DELTA_FILE)));
  const newCodes = rows.filter((row) => !row.abolished).map((row) => row.code);
  const oldCodes = rows.filter((row) => row.abolished).map((row) => row.code);
  await db.deleteFrom('regions').where('code', 'in', newCodes).execute();
  await db.updateTable('regions').set({ abolished: false }).where('code', 'in', oldCodes).execute();
}
