import { inject, injectable } from 'inversify';
import type { Kysely } from 'kysely';
import { DbDeps } from '@/infra/db/db.dep';
import type { DatabaseScheme } from '@/infra/db/db-scheme';
import type { IngestCheckpointRow } from '@/infra/db/ingest-checkpoints.table';
import type { EventSources } from '@/modules/events/domain/event.enums';
import type { IIngestCheckpointRepository, IngestCheckpoint } from '../domain/port/ingest-checkpoint-repo.interface';

@injectable()
export class IngestCheckpointRepository implements IIngestCheckpointRepository {
  constructor(
    @inject(DbDeps.Database)
    private readonly db: Kysely<DatabaseScheme>,
  ) {}

  public async getCheckpoint(sourceId: EventSources): Promise<IngestCheckpoint | null> {
    const row = await this.db
      .selectFrom('ingest_checkpoints')
      .selectAll()
      .where('source_id', '=', sourceId)
      .executeTakeFirst();

    if (!row) {
      return null;
    }

    return toCheckpoint(row);
  }

  public async upsertCheckpoint(sourceId: EventSources, state: string | null): Promise<void> {
    const updatedAt = new Date().toISOString();

    await this.db
      .insertInto('ingest_checkpoints')
      .values({
        source_id: sourceId,
        state,
        updated_at: updatedAt,
      })
      .onConflict((oc) =>
        oc.column('source_id').doUpdateSet({
          state,
          updated_at: updatedAt,
        }),
      )
      .execute();
  }
}

const toCheckpoint = (row: IngestCheckpointRow): IngestCheckpoint => {
  return {
    sourceId: row.source_id as EventSources,
    state: row.state ?? null,
    updatedAt: row.updated_at,
  };
};
