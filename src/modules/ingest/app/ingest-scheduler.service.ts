import type { Queue } from 'bullmq';
import { inject, injectable } from 'inversify';
import { logger } from '@/core/logger';
import { QueueDeps } from '@/infra/queue/queue.dep';
import { IngestDeps } from '../domain/dep/ingest.dep';
import type { IngestJobPayload } from '../domain/dto/ingest-job.dto';
import { INGEST_JOB_NAME } from '../domain/ingest.constants';
import type { Source } from '../domain/port/source.interface';
import type { SourceRegistry } from './source.registry';

@injectable()
export class IngestSchedulerService {
  constructor(
    @inject(QueueDeps.IngestQueue)
    private readonly queue: Queue<IngestJobPayload>,
    @inject(IngestDeps.SourceRegistry)
    private readonly sourceRegistry: SourceRegistry,
  ) {}

  public async scheduleJobs(): Promise<void> {
    const sources = this.sourceRegistry.list();
    logger.debug({ sourceCount: sources.length }, 'Scheduling ingest jobs');
    for (const source of sources) {
      await this.scheduleSource(source);
    }
  }

  public async stop(): Promise<void> {
    try {
      await this.queue.close();
      logger.debug('Ingest queue closed');
    } catch (error) {
      logger.warn({ error }, 'Failed to close ingest queue');
    }
  }

  private async scheduleSource(source: Source): Promise<void> {
    if (source.pollIntervalSec <= 0) {
      logger.warn({ sourceId: source.sourceId }, 'Invalid poll interval, skipping');
      return;
    }

    const repeatEveryMs = source.pollIntervalSec * 1000;
    const schedulerId = `${INGEST_JOB_NAME}:${source.sourceId}`;

    logger.debug({ sourceId: source.sourceId, schedulerId }, 'Registering ingest scheduler');
    await this.queue.upsertJobScheduler(
      schedulerId,
      { every: repeatEveryMs },
      {
        name: INGEST_JOB_NAME,
        data: { sourceId: source.sourceId },
        opts: {
          attempts: 2,
          backoff: { type: 'exponential', delay: 4000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      },
    );

    logger.info({ sourceId: source.sourceId, everyMs: repeatEveryMs }, 'Scheduled ingest job');
  }
}
