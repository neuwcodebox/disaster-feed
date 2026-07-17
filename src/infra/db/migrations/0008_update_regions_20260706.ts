import { createReadStream, existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Kysely } from 'kysely';
import { z } from 'zod';

const BATCH_SIZE = 500;
const REGION_CODE_PATTERN = /^\d{10}$/;
const REGION_HEADERS = ['법정동코드', '법정동명', '폐지여부'] as const;

const schemaRegionRow = z.object({
  code: z.string().regex(REGION_CODE_PATTERN),
  name: z.string().min(1),
  abolished: z.boolean(),
});
const schemaLegacyRegionRows = z.array(schemaRegionRow);

export type RegionMigrationRow = z.infer<typeof schemaRegionRow>;
type RegionDatabase = { regions: RegionMigrationRow };

export async function up(db: Kysely<unknown>): Promise<void> {
  const dataPath = resolveDataPath('regions20260706.txt');
  const typedDb = db as Kysely<RegionDatabase>;
  const batch: RegionMigrationRow[] = [];

  for await (const row of readRegionRows(dataPath)) {
    batch.push(row);
    if (batch.length >= BATCH_SIZE) {
      await upsertBatch(typedDb, batch);
      batch.length = 0;
    }
  }

  if (batch.length > 0) {
    await upsertBatch(typedDb, batch);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const typedDb = db as Kysely<RegionDatabase>;
  const legacyRows = await readLegacyRegionRows(resolveDataPath('regions.json'));
  const legacyCodes = new Set(legacyRows.map((row) => row.code));
  const addedCodes: string[] = [];

  for await (const row of readRegionRows(resolveDataPath('regions20260706.txt'))) {
    if (legacyCodes.has(row.code)) {
      continue;
    }

    addedCodes.push(row.code);
    if (addedCodes.length >= BATCH_SIZE) {
      await deleteBatch(typedDb, addedCodes);
      addedCodes.length = 0;
    }
  }

  if (addedCodes.length > 0) {
    await deleteBatch(typedDb, addedCodes);
  }

  for (let index = 0; index < legacyRows.length; index += BATCH_SIZE) {
    await upsertBatch(typedDb, legacyRows.slice(index, index + BATCH_SIZE));
  }
}

export async function* readRegionRows(filePath: string): AsyncGenerator<RegionMigrationRow> {
  let headerParsed = false;
  let lineNumber = 0;

  for await (const line of readTextLines(filePath)) {
    lineNumber += 1;
    if (!line.trim()) {
      continue;
    }

    if (!headerParsed) {
      parseRegionHeader(line, lineNumber);
      headerParsed = true;
      continue;
    }

    yield parseRegionLine(line, lineNumber);
  }

  if (!headerParsed) {
    throw new Error('regions20260706.txt header not found.');
  }
}

async function* readTextLines(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  let buffer = '';

  for await (const chunk of stream) {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');

    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      yield line;
      newlineIndex = buffer.indexOf('\n');
    }
  }

  if (buffer.length > 0) {
    yield buffer.replace(/\r$/, '');
  }
}

export function parseRegionLine(line: string, lineNumber: number): RegionMigrationRow {
  const columns = line.split('\t').map((column) => column.trim());
  if (columns.length !== REGION_HEADERS.length) {
    throw new Error(`regions20260706.txt column count mismatch at line ${lineNumber}`);
  }

  const [code, name, status] = columns;
  if (status !== '존재' && status !== '폐지') {
    throw new Error(`regions20260706.txt invalid 폐지여부 at line ${lineNumber}: ${status}`);
  }

  const result = schemaRegionRow.safeParse({ code, name, abolished: status === '폐지' });
  if (!result.success) {
    throw new Error(`regions20260706.txt validation failed at line ${lineNumber}: ${result.error.message}`);
  }

  return result.data;
}

function parseRegionHeader(line: string, lineNumber: number): void {
  const columns = line
    .replace(/^\uFEFF/, '')
    .split('\t')
    .map((column) => column.trim());

  if (columns.length !== REGION_HEADERS.length || columns.some((column, index) => column !== REGION_HEADERS[index])) {
    throw new Error(`regions20260706.txt header mismatch at line ${lineNumber}`);
  }
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

async function readLegacyRegionRows(filePath: string): Promise<RegionMigrationRow[]> {
  const jsonText = await fs.readFile(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`regions.json parse failed: ${message}`);
  }

  const result = schemaLegacyRegionRows.safeParse(parsed);
  if (!result.success) {
    throw new Error(`regions.json validation failed: ${result.error.message}`);
  }
  return result.data;
}

async function upsertBatch(db: Kysely<RegionDatabase>, rows: RegionMigrationRow[]): Promise<void> {
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
}

async function deleteBatch(db: Kysely<RegionDatabase>, codes: string[]): Promise<void> {
  await db.deleteFrom('regions').where('code', 'in', codes).execute();
}
