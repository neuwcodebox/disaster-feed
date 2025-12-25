import SQLite from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import type { DependencyContainer } from '@/core/dep';
import { DbDeps } from './db.dep';
import type { DatabaseScheme } from './db-scheme';

function createDbConnection(): Kysely<DatabaseScheme> {
  const dialect = new SqliteDialect({
    database: new SQLite('sqlite.db'),
  });

  const db = new Kysely<DatabaseScheme>({
    dialect,
  });

  return db;
}

export function registerDbDeps(dep: DependencyContainer) {
  dep.addDynamic(DbDeps.Database, createDbConnection);
}
