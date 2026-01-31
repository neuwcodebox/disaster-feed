import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Kysely } from 'kysely';
import { z } from 'zod';

const BATCH_SIZE = 500;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const STATION_HEADERS = {
  code: '지점',
  startDate: '시작일',
  endDate: '종료일',
  name: '지점명',
  address: '지점주소',
  office: '관리관서',
  lat: '위도',
  lng: '경도',
  altitude: '노장해발고도(m)',
  barometer: '기압계(관측장비지상높이(m))',
  thermometer: '기온계(관측장비지상높이(m))',
  anemometer: '풍속계(관측장비지상높이(m))',
  rainGauge: '강우계(관측장비지상높이(m))',
} as const;

type StationHeaderKey = keyof typeof STATION_HEADERS;
type HeaderMap = Record<StationHeaderKey, number>;

const schemaStationRow = z.object({
  code: z.number().int().nonnegative(),
  start_date: z.string().regex(DATE_PATTERN),
  end_date: z.string().regex(DATE_PATTERN).nullable(),
  name: z.string().min(1),
  address: z.string().nullable(),
  office: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  altitude_m: z.number().nullable(),
  barometer_m: z.number().nullable(),
  thermometer_m: z.number().nullable(),
  anemometer_m: z.number().nullable(),
  rain_gauge_m: z.number().nullable(),
});

type StationRow = z.infer<typeof schemaStationRow>;
type StationDatabase = { stations: StationRow };

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('stations')
    .ifNotExists()
    .addColumn('code', 'integer', (col) => col.primaryKey())
    .addColumn('start_date', 'date', (col) => col.notNull())
    .addColumn('end_date', 'date')
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('address', 'text')
    .addColumn('office', 'text')
    .addColumn('lat', 'double precision')
    .addColumn('lng', 'double precision')
    .addColumn('altitude_m', 'double precision')
    .addColumn('barometer_m', 'double precision')
    .addColumn('thermometer_m', 'double precision')
    .addColumn('anemometer_m', 'double precision')
    .addColumn('rain_gauge_m', 'double precision')
    .execute();

  const dataPath = resolveStationsDataPath();
  const typedDb = db as Kysely<StationDatabase>;
  const batch: StationRow[] = [];

  for await (const row of readStationRows(dataPath)) {
    batch.push(row);
    if (batch.length >= BATCH_SIZE) {
      await insertBatch(typedDb, batch);
      batch.length = 0;
    }
  }

  if (batch.length > 0) {
    await insertBatch(typedDb, batch);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('stations').ifExists().execute();
}

function resolveStationsDataPath(): string {
  const currentDir = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [path.join(process.cwd(), 'data', 'stations.csv'), path.join(currentDir, 'data', 'stations.csv')];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('stations.csv file was not found for migrations.');
}

async function insertBatch(db: Kysely<StationDatabase>, rows: StationRow[]): Promise<void> {
  const dedupedRows = dedupeRows(rows);
  await db
    .insertInto('stations')
    .values(dedupedRows)
    .onConflict((oc) =>
      oc
        .column('code')
        .doUpdateSet((eb) => ({
          start_date: eb.ref('excluded.start_date'),
          end_date: eb.ref('excluded.end_date'),
          name: eb.ref('excluded.name'),
          address: eb.ref('excluded.address'),
          office: eb.ref('excluded.office'),
          lat: eb.ref('excluded.lat'),
          lng: eb.ref('excluded.lng'),
          altitude_m: eb.ref('excluded.altitude_m'),
          barometer_m: eb.ref('excluded.barometer_m'),
          thermometer_m: eb.ref('excluded.thermometer_m'),
          anemometer_m: eb.ref('excluded.anemometer_m'),
          rain_gauge_m: eb.ref('excluded.rain_gauge_m'),
        }))
        .whereRef('excluded.start_date', '>', 'stations.start_date'),
    )
    .execute();
}

function dedupeRows(rows: StationRow[]): StationRow[] {
  const byCode = new Map<number, StationRow>();

  for (const row of rows) {
    const existing = byCode.get(row.code);
    if (!existing) {
      byCode.set(row.code, row);
      continue;
    }

    if (row.start_date > existing.start_date) {
      byCode.set(row.code, row);
      continue;
    }

    if (row.start_date === existing.start_date) {
      byCode.set(row.code, row);
    }
  }

  return Array.from(byCode.values());
}

async function* readStationRows(filePath: string): AsyncGenerator<StationRow> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let headerMap: HeaderMap | null = null;
  let lineNumber = 0;

  for await (const line of rl) {
    lineNumber += 1;
    if (!line.trim()) {
      continue;
    }

    const columns = parseCsvLine(line);

    if (!headerMap) {
      headerMap = parseHeader(columns, lineNumber);
      continue;
    }

    yield parseStationRow(columns, headerMap, lineNumber);
  }

  if (!headerMap) {
    throw new Error('stations.csv header not found.');
  }
}

function parseHeader(columns: string[], lineNumber: number): HeaderMap {
  const normalized = columns.map((column) => column.trim());
  if (normalized.length > 0) {
    normalized[0] = normalized[0].replace(/^\uFEFF/, '');
  }

  const headerMap = {} as HeaderMap;
  for (const [key, label] of Object.entries(STATION_HEADERS) as Array<[StationHeaderKey, string]>) {
    const index = normalized.indexOf(label);
    if (index === -1) {
      throw new Error(`stations.csv header mismatch at line ${lineNumber}: ${label}`);
    }
    headerMap[key] = index;
  }

  return headerMap;
}

function parseStationRow(columns: string[], headerMap: HeaderMap, lineNumber: number): StationRow {
  const row = {
    code: parseRequiredInt(getValue(columns, headerMap, 'code'), '지점', lineNumber),
    start_date: parseRequiredDate(getValue(columns, headerMap, 'startDate'), '시작일', lineNumber),
    end_date: parseOptionalDate(getValue(columns, headerMap, 'endDate'), '종료일', lineNumber),
    name: parseRequiredText(getValue(columns, headerMap, 'name'), '지점명', lineNumber),
    address: parseOptionalText(getValue(columns, headerMap, 'address')),
    office: parseOptionalText(getValue(columns, headerMap, 'office')),
    lat: parseOptionalNumber(getValue(columns, headerMap, 'lat'), '위도', lineNumber),
    lng: parseOptionalNumber(getValue(columns, headerMap, 'lng'), '경도', lineNumber),
    altitude_m: parseOptionalNumber(getValue(columns, headerMap, 'altitude'), '노장해발고도(m)', lineNumber),
    barometer_m: parseOptionalNumber(
      getValue(columns, headerMap, 'barometer'),
      '기압계(관측장비지상높이(m))',
      lineNumber,
    ),
    thermometer_m: parseOptionalNumber(
      getValue(columns, headerMap, 'thermometer'),
      '기온계(관측장비지상높이(m))',
      lineNumber,
    ),
    anemometer_m: parseOptionalNumber(
      getValue(columns, headerMap, 'anemometer'),
      '풍속계(관측장비지상높이(m))',
      lineNumber,
    ),
    rain_gauge_m: parseOptionalNumber(
      getValue(columns, headerMap, 'rainGauge'),
      '강우계(관측장비지상높이(m))',
      lineNumber,
    ),
  };

  const result = schemaStationRow.safeParse(row);
  if (!result.success) {
    throw new Error(`stations.csv validation failed at line ${lineNumber}: ${result.error.message}`);
  }

  return result.data;
}

function getValue(columns: string[], headerMap: HeaderMap, key: StationHeaderKey): string {
  return columns[headerMap[key]] ?? '';
}

function parseRequiredInt(value: string, fieldName: string, lineNumber: number): number {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`stations.csv missing ${fieldName} at line ${lineNumber}`);
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`stations.csv invalid ${fieldName} at line ${lineNumber}: ${value}`);
  }

  return parsed;
}

function parseRequiredDate(value: string, fieldName: string, lineNumber: number): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`stations.csv missing ${fieldName} at line ${lineNumber}`);
  }

  if (!DATE_PATTERN.test(trimmed)) {
    throw new Error(`stations.csv invalid ${fieldName} at line ${lineNumber}: ${value}`);
  }

  return trimmed;
}

function parseOptionalDate(value: string, fieldName: string, lineNumber: number): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (!DATE_PATTERN.test(trimmed)) {
    throw new Error(`stations.csv invalid ${fieldName} at line ${lineNumber}: ${value}`);
  }

  return trimmed;
}

function parseRequiredText(value: string, fieldName: string, lineNumber: number): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`stations.csv missing ${fieldName} at line ${lineNumber}`);
  }

  return trimmed;
}

function parseOptionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseOptionalNumber(value: string, fieldName: string, lineNumber: number): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number.parseFloat(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(`stations.csv invalid ${fieldName} at line ${lineNumber}: ${value}`);
  }

  return parsed;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ',') {
      values.push(current);
      current = '';
      continue;
    }

    if (char === '\r') {
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}
