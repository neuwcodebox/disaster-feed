import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely';
import { env } from '@/core/env';
import { logger } from '@/core/logger';
import type { DatabaseScheme } from './db-scheme';

const resolveMigrationFolder = (): string => {
  if (env.MIGRATIONS_DIR) {
    if (path.isAbsolute(env.MIGRATIONS_DIR)) {
      return env.MIGRATIONS_DIR;
    }
    return path.join(process.cwd(), env.MIGRATIONS_DIR);
  }

  const candidates = [
    path.join(process.cwd(), 'dist/infra/db/migrations'),
    path.join(process.cwd(), 'src/infra/db/migrations'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[1];
};

export const runDbMigrations = async (db: Kysely<DatabaseScheme>): Promise<void> => {
  if (env.MIGRATIONS_ENABLED !== 1) {
    logger.info('DB migrations are disabled');
    return;
  }

  const migrationFolder = resolveMigrationFolder();
  logger.info({ migrationFolder }, 'Running DB migrations');

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder,
    }),
  });

  const { error, results } = await migrator.migrateToLatest();

  for (const result of results ?? []) {
    if (result.status === 'Success') {
      logger.info({ name: result.migrationName }, 'Migration executed');
    } else if (result.status === 'Error') {
      logger.error({ name: result.migrationName }, 'Migration failed');
    } else if (result.status === 'NotExecuted') {
      logger.debug({ name: result.migrationName }, 'Migration skipped');
    }
  }

  if (error) {
    logger.error({ error }, 'DB migration failed');
    throw error;
  }

  logger.info('DB migrations completed');
};
