import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';

const BATCH_SIZE = 500;

const REGION_DATA_FILES = [
  { fileName: 'SIG.json', codeKey: 'SIG_CD' },
  { fileName: 'EMD.json', codeKey: 'EMD_CD' },
  { fileName: 'LI.json', codeKey: 'LI_CD' },
];

const schemaPosition = z.tuple([z.number(), z.number()]);
const schemaLinearRing = z.array(schemaPosition);
const schemaPolygonCoordinates = z.array(schemaLinearRing);
const schemaMultiPolygonCoordinates = z.array(schemaPolygonCoordinates);
const schemaGeometry = z.union([
  z.object({
    type: z.literal('Polygon'),
    coordinates: schemaPolygonCoordinates,
  }),
  z.object({
    type: z.literal('MultiPolygon'),
    coordinates: schemaMultiPolygonCoordinates,
  }),
]);
const schemaFeature = z.object({
  type: z.literal('Feature'),
  geometry: schemaGeometry,
  properties: z.record(z.string(), z.unknown()),
});
const schemaCodeValue = z.union([z.string(), z.number()]);

type PolygonCoordinates = z.infer<typeof schemaPolygonCoordinates>;
type MultiPolygonCoordinates = z.infer<typeof schemaMultiPolygonCoordinates>;
type Geometry = z.infer<typeof schemaGeometry>;

type RegionCenterRow = {
  code: string;
  centerLat: number;
  centerLng: number;
};

type PointAccumulator = {
  count: number;
  sumLat: number;
  sumLng: number;
};

class NoCoordinatesError extends Error {
  constructor() {
    super('geometry has no coordinates');
    this.name = 'NoCoordinatesError';
  }
}

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

function computeGeometryCentroid(
  geometry: Geometry,
  fileName: string,
  index: number,
): { lat: number; lng: number } | null {
  let result: { lat: number; lng: number };
  try {
    result =
      geometry.type === 'Polygon'
        ? computePolygonCentroid(geometry.coordinates)
        : computeMultiPolygonCentroid(geometry.coordinates);
  } catch (error) {
    if (error instanceof NoCoordinatesError) {
      return null;
    }
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`${fileName} centroid calculation failed at index ${index}: ${message}`);
  }

  if (!Number.isFinite(result.lat) || !Number.isFinite(result.lng)) {
    throw new Error(`${fileName} centroid calculation failed at index ${index}`);
  }

  return result;
}

function computeMultiPolygonCentroid(coordinates: MultiPolygonCoordinates): { lat: number; lng: number } {
  const fallback = createPointAccumulator();
  let areaSum = 0;
  let weightedLat = 0;
  let weightedLng = 0;

  for (const polygon of coordinates) {
    appendPolygonPoints(fallback, polygon);
    const polygonResult = computePolygonCentroidWithArea(polygon);
    if (polygonResult.area === 0) {
      continue;
    }

    areaSum += polygonResult.area;
    weightedLat += polygonResult.lat * polygonResult.area;
    weightedLng += polygonResult.lng * polygonResult.area;
  }

  if (areaSum !== 0) {
    return {
      lat: weightedLat / areaSum,
      lng: weightedLng / areaSum,
    };
  }

  return computeAveragePoint(fallback);
}

function computePolygonCentroid(coordinates: PolygonCoordinates): { lat: number; lng: number } {
  const result = computePolygonCentroidWithArea(coordinates);
  return { lat: result.lat, lng: result.lng };
}

function computePolygonCentroidWithArea(coordinates: PolygonCoordinates): { area: number; lat: number; lng: number } {
  const fallback = createPointAccumulator();
  let areaSum = 0;
  let weightedLat = 0;
  let weightedLng = 0;

  for (let ringIndex = 0; ringIndex < coordinates.length; ringIndex += 1) {
    const ring = coordinates[ringIndex];
    appendRingPoints(fallback, ring);
    const ringResult = computeRingCentroid(ring);
    if (ringResult.area === 0) {
      continue;
    }

    const ringArea = ringIndex === 0 ? Math.abs(ringResult.area) : -Math.abs(ringResult.area);
    areaSum += ringArea;
    weightedLat += ringResult.lat * ringArea;
    weightedLng += ringResult.lng * ringArea;
  }

  if (areaSum !== 0) {
    return {
      area: areaSum,
      lat: weightedLat / areaSum,
      lng: weightedLng / areaSum,
    };
  }

  const fallbackPoint = computeAveragePoint(fallback);
  return { area: 0, ...fallbackPoint };
}

function computeRingCentroid(ring: z.infer<typeof schemaLinearRing>): { area: number; lat: number; lng: number } {
  if (ring.length < 3) {
    return { area: 0, lat: 0, lng: 0 };
  }

  let area2 = 0;
  let centerLat = 0;
  let centerLng = 0;

  for (let i = 0; i < ring.length; i += 1) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    const cross = x0 * y1 - x1 * y0;
    area2 += cross;
    centerLng += (x0 + x1) * cross;
    centerLat += (y0 + y1) * cross;
  }

  if (area2 === 0) {
    return { area: 0, lat: 0, lng: 0 };
  }

  const divisor = 3 * area2;
  return {
    area: area2 / 2,
    lat: centerLat / divisor,
    lng: centerLng / divisor,
  };
}

function createPointAccumulator(): PointAccumulator {
  return { count: 0, sumLat: 0, sumLng: 0 };
}

function appendPolygonPoints(accumulator: PointAccumulator, polygon: PolygonCoordinates): void {
  for (const ring of polygon) {
    appendRingPoints(accumulator, ring);
  }
}

function appendRingPoints(accumulator: PointAccumulator, ring: z.infer<typeof schemaLinearRing>): void {
  for (const position of ring) {
    accumulator.sumLng += position[0];
    accumulator.sumLat += position[1];
    accumulator.count += 1;
  }
}

function computeAveragePoint(accumulator: PointAccumulator): { lat: number; lng: number } {
  if (accumulator.count === 0) {
    throw new NoCoordinatesError();
  }

  return {
    lat: accumulator.sumLat / accumulator.count,
    lng: accumulator.sumLng / accumulator.count,
  };
}

async function* readGeoJsonFeatureObjects(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  let started = false;
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let current = '';

  for await (const chunk of stream) {
    for (let i = 0; i < chunk.length; i += 1) {
      const char = chunk[i];

      if (!started) {
        if (char === '[') {
          started = true;
        }
        continue;
      }

      if (depth === 0) {
        if (char === '{') {
          depth = 1;
          current = '{';
        } else if (char === ']') {
          return;
        }
        continue;
      }

      current += char;

      if (inString) {
        if (escapeNext) {
          escapeNext = false;
          continue;
        }
        if (char === '\\') {
          escapeNext = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{') {
        depth += 1;
        continue;
      }

      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          yield current;
          current = '';
        }
      }
    }
  }

  if (depth !== 0 || inString) {
    throw new Error(`${path.basename(filePath)} parse failed: unexpected end of file.`);
  }
}
