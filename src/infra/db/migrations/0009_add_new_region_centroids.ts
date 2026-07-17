import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';
import { computeGeometryAreaCentroid, readGeoJsonFeatureObjects } from '../migration-utils/geojson-centroid';
import { readRegionRows } from './0008_update_regions_20260706';

const BATCH_SIZE = 500;
const GEOJSON_FILE_NAME = 'HangJeongDong_ver20260701.geojson';

const schemaPosition = z.tuple([z.number(), z.number()]);
const schemaLinearRing = z.array(schemaPosition);
const schemaPolygonCoordinates = z.array(schemaLinearRing);
const schemaMultiPolygonCoordinates = z.array(schemaPolygonCoordinates);
const schemaGeometry = z.union([
  z.object({ type: z.literal('Polygon'), coordinates: schemaPolygonCoordinates }),
  z.object({ type: z.literal('MultiPolygon'), coordinates: schemaMultiPolygonCoordinates }),
]);
const schemaFeature = z.object({
  type: z.literal('Feature'),
  properties: z.object({
    adm_nm: z.string().min(1),
    adm_cd2: z.string().regex(/^\d{10}$/),
    sgg: z.string().regex(/^\d{5}$/),
    sido: z.string().regex(/^\d{2}$/),
  }),
  geometry: schemaGeometry,
});
const schemaLegacyRegions = z.array(z.object({ code: z.string().regex(/^\d{10}$/) }).passthrough());

export type NewRegionCenterRow = {
  code: string;
  centerLat: number;
  centerLng: number;
};

type WeightedCenter = {
  area: number;
  weightedLat: number;
  weightedLng: number;
};

export async function up(db: Kysely<unknown>): Promise<void> {
  const rows = await buildNewRegionCenters();
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    await updateRegionCenters(db, rows.slice(index, index + BATCH_SIZE));
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const rows = await buildNewRegionCenters();
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    await clearRegionCenters(
      db,
      rows.slice(index, index + BATCH_SIZE).map((row) => row.code),
    );
  }
}

export async function buildNewRegionCenters(): Promise<NewRegionCenterRow[]> {
  const legacyCodes = await readLegacyRegionCodes(resolveDataPath('regions.json'));
  const newRegionNames = await readNewRegionNames(legacyCodes);
  const directCenters = new Map<string, NewRegionCenterRow>();
  const aggregatedCenters = new Map<string, WeightedCenter>();
  const geoJsonPath = resolveDataPath(GEOJSON_FILE_NAME);
  let index = 0;

  for await (const jsonText of readGeoJsonFeatureObjects(geoJsonPath)) {
    const feature = parseFeature(jsonText, index);
    const center = computeGeometryAreaCentroid(feature.geometry, GEOJSON_FILE_NAME, index);
    index += 1;
    if (!center) {
      continue;
    }

    const properties = feature.properties;
    const directRegionName = newRegionNames.get(properties.adm_cd2);
    if (directRegionName && normalizeName(directRegionName) === normalizeName(properties.adm_nm)) {
      directCenters.set(properties.adm_cd2, {
        code: properties.adm_cd2,
        centerLat: center.lat,
        centerLng: center.lng,
      });
    }

    appendAggregatedCenter(aggregatedCenters, `${properties.sgg}00000`, center, newRegionNames);
    appendAggregatedCenter(aggregatedCenters, `${properties.sido}00000000`, center, newRegionNames);
  }

  const result = new Map(directCenters);
  for (const [code, center] of aggregatedCenters) {
    if (center.area === 0) {
      continue;
    }
    result.set(code, {
      code,
      centerLat: center.weightedLat / center.area,
      centerLng: center.weightedLng / center.area,
    });
  }

  return Array.from(result.values()).sort((left, right) => left.code.localeCompare(right.code));
}

function parseFeature(jsonText: string, index: number): z.infer<typeof schemaFeature> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`${GEOJSON_FILE_NAME} parse failed at index ${index}: ${message}`);
  }

  const result = schemaFeature.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${GEOJSON_FILE_NAME} validation failed at index ${index}: ${result.error.message}`);
  }
  return result.data;
}

function appendAggregatedCenter(
  centers: Map<string, WeightedCenter>,
  code: string,
  center: { area: number; lat: number; lng: number },
  newRegionNames: Map<string, string>,
): void {
  if (!newRegionNames.has(code) || center.area <= 0) {
    return;
  }

  const accumulated = centers.get(code) ?? { area: 0, weightedLat: 0, weightedLng: 0 };
  accumulated.area += center.area;
  accumulated.weightedLat += center.lat * center.area;
  accumulated.weightedLng += center.lng * center.area;
  centers.set(code, accumulated);
}

async function readLegacyRegionCodes(filePath: string): Promise<Set<string>> {
  const jsonText = await fs.readFile(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`regions.json parse failed: ${message}`);
  }

  const result = schemaLegacyRegions.safeParse(parsed);
  if (!result.success) {
    throw new Error(`regions.json validation failed: ${result.error.message}`);
  }
  return new Set(result.data.map((row) => row.code));
}

async function readNewRegionNames(legacyCodes: Set<string>): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for await (const row of readRegionRows(resolveDataPath('regions20260706.txt'))) {
    if (!legacyCodes.has(row.code)) {
      result.set(row.code, row.name);
    }
  }
  return result;
}

function resolveDataPath(fileName: string): string {
  const currentDir = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [path.join(process.cwd(), 'data', fileName), path.join(currentDir, 'data', fileName)];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`${fileName} file was not found for migrations.`);
}

function normalizeName(value: string): string {
  return value.replace(/\s/g, '');
}

async function updateRegionCenters(db: Kysely<unknown>, rows: NewRegionCenterRow[]): Promise<void> {
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
      and (r.center_lat is null or r.center_lng is null)
  `.execute(db);
}

async function clearRegionCenters(db: Kysely<unknown>, codes: string[]): Promise<void> {
  if (codes.length === 0) {
    return;
  }

  await sql`
    update regions
    set center_lat = null,
        center_lng = null
    where code in (${sql.join(
      codes.map((code) => sql`${code}`),
      sql`,`,
    )})
  `.execute(db);
}
