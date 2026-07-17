import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  computeGeometryCentroid,
  readGeoJsonFeatureObjects,
  schemaGeoJsonGeometry,
} from '../migration-utils/geojson-centroid';

const BATCH_SIZE = 500;

const REGION_DATA_FILES = [
  { fileName: 'SIG.json', codeKey: 'SIG_CD' },
  { fileName: 'EMD.json', codeKey: 'EMD_CD' },
  { fileName: 'LI.json', codeKey: 'LI_CD' },
];

const schemaFeature = z.object({
  type: z.literal('Feature'),
  geometry: schemaGeoJsonGeometry,
  properties: z.record(z.string(), z.unknown()),
});
const schemaCodeValue = z.union([z.string(), z.number()]);

type RegionCenterRow = {
  code: string;
  centerLat: number;
  centerLng: number;
};

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table regions add column if not exists center_lat double precision`.execute(db);
  await sql`alter table regions add column if not exists center_lng double precision`.execute(db);

  const batch: RegionCenterRow[] = [];

  for await (const row of readRegionCenterRows()) {
    batch.push(row);
    if (batch.length >= BATCH_SIZE) {
      await updateRegionCenters(db, batch);
      batch.length = 0;
    }
  }

  if (batch.length > 0) {
    await updateRegionCenters(db, batch);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table regions drop column if exists center_lng`.execute(db);
  await sql`alter table regions drop column if exists center_lat`.execute(db);
}

async function updateRegionCenters(db: Kysely<unknown>, rows: RegionCenterRow[]): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  const values = rows.map((row) => sql`(${row.code}, ${row.centerLat}, ${row.centerLng})`);
  const valuesSql = sql.join(values, sql`,`);

  await sql`
    update regions as r
    set center_lat = v.center_lat::double precision,
        center_lng = v.center_lng::double precision
    from (values ${valuesSql}) as v(code, center_lat, center_lng)
    where r.code = v.code
  `.execute(db);
}

async function* readRegionCenterRows(): AsyncGenerator<RegionCenterRow> {
  for (const regionFile of REGION_DATA_FILES) {
    const filePath = resolveGeoJsonDataPath(regionFile.fileName);
    let index = 0;
    for await (const jsonText of readGeoJsonFeatureObjects(filePath)) {
      const row = parseRegionCenterRow(jsonText, regionFile.codeKey, regionFile.fileName, index);
      if (row) {
        yield row;
      }
      index += 1;
    }
  }
}

function resolveGeoJsonDataPath(fileName: string): string {
  const currentDir = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [path.join(process.cwd(), 'data', fileName), path.join(currentDir, 'data', fileName)];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`${fileName} file was not found for migrations.`);
}

function parseRegionCenterRow(
  jsonText: string,
  codeKey: string,
  fileName: string,
  index: number,
): RegionCenterRow | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`${fileName} parse failed at index ${index}: ${message}`);
  }

  const result = schemaFeature.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${fileName} validation failed at index ${index}: ${result.error.message}`);
  }

  const code = parseRegionCode(result.data.properties[codeKey], codeKey, fileName, index);
  const center = computeGeometryCentroid(result.data.geometry, fileName, index);
  if (!center) {
    return null;
  }

  return {
    code,
    centerLat: center.lat,
    centerLng: center.lng,
  };
}

function parseRegionCode(value: unknown, codeKey: string, fileName: string, index: number): string {
  const result = schemaCodeValue.safeParse(value);
  if (!result.success) {
    throw new Error(`${fileName} ${codeKey} is invalid at index ${index}`);
  }

  const codeText = String(result.data).trim();
  if (!/^\d+$/.test(codeText)) {
    throw new Error(`${fileName} ${codeKey} must be numeric at index ${index}`);
  }

  if (codeText.length > 10) {
    throw new Error(`${fileName} ${codeKey} is longer than 10 digits at index ${index}`);
  }

  return codeText.padEnd(10, '0');
}
