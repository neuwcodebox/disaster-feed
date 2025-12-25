import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DependencyContainer } from '@/core/dep';
import { env } from '@/core/env';
import { DbDeps } from './db.dep';
import type { DatabaseScheme } from './db-scheme';

function createDbConnection(): Kysely<DatabaseScheme> {
  const dialect = new PostgresDialect({
    pool: new Pool({
      connectionString: env.DATABASE_URL,
    }),
  });

  const db = new Kysely<DatabaseScheme>({
    dialect,
  });

  return db;
}

export function registerDbDeps(dep: DependencyContainer) {
  dep.addDynamic(DbDeps.Database, createDbConnection);
}
