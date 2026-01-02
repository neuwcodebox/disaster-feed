import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';

const BATCH_SIZE = 500;

const schemaRegionRow = z.object({
  code: z.string(),
  name: z.string(),
  abolished: z.boolean(),
});

type RegionRow = z.infer<typeof schemaRegionRow>;
type RegionDatabase = { regions: RegionRow };

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('regions')
    .ifNotExists()
    .addColumn('code', 'varchar(10)', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('abolished', 'boolean', (col) => col.notNull())
    .execute();

  await sql`create extension if not exists pg_trgm`.execute(db);
  await sql`create index if not exists idx_regions_name_trgm on regions using gin (name gin_trgm_ops)`.execute(db);

  const dataPath = resolveRegionsDataPath();
  const typedDb = db as Kysely<RegionDatabase>;
  const batch: RegionRow[] = [];

  for await (const row of readRegionRows(dataPath)) {
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
  await db.schema.dropIndex('idx_regions_name_trgm').ifExists().execute();
  await db.schema.dropTable('regions').ifExists().execute();
}

function resolveRegionsDataPath(): string {
  const currentDir = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [path.join(process.cwd(), 'data', 'regions.json'), path.join(currentDir, 'data', 'regions.json')];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('regions.json file was not found for migrations.');
}

async function insertBatch(db: Kysely<RegionDatabase>, rows: RegionRow[]): Promise<void> {
  await db
    .insertInto('regions')
    .values(rows)
    .onConflict((oc) => oc.column('code').doNothing())
    .execute();
}

async function* readRegionRows(filePath: string): AsyncGenerator<RegionRow> {
  let index = 0;
  for await (const jsonText of readJsonArrayObjects(filePath)) {
    yield parseRegionRow(jsonText, index);
    index += 1;
  }
}

function parseRegionRow(jsonText: string, index: number): RegionRow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`regions.json parse failed at index ${index}: ${message}`);
  }

  const result = schemaRegionRow.safeParse(parsed);
  if (!result.success) {
    throw new Error(`regions.json validation failed at index ${index}: ${result.error.message}`);
  }

  return result.data;
}

async function* readJsonArrayObjects(filePath: string): AsyncGenerator<string> {
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
    throw new Error('regions.json parse failed: unexpected end of file.');
  }
}
