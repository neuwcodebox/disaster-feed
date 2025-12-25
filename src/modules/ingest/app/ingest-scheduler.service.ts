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

  public async scheduleRepeatableJobs(): Promise<void> {
    const sources = this.sourceRegistry.list();
    logger.debug({ sourceCount: sources.length }, 'Scheduling ingest jobs');
    for (const source of sources) {
      await this.scheduleSource(source);
    }
  }

  private async scheduleSource(source: Source): Promise<void> {
    if (source.pollIntervalSec <= 0) {
      logger.warn({ sourceId: source.sourceId }, 'Invalid poll interval, skipping');
      return;
    }

    const repeatEveryMs = source.pollIntervalSec * 1000;
    const jobId = `${INGEST_JOB_NAME}:${source.sourceId}`;

    logger.debug({ sourceId: source.sourceId, jobId }, 'Registering ingest job');
    await this.queue.add(
      INGEST_JOB_NAME,
      { sourceId: source.sourceId },
      {
        jobId,
        repeat: { every: repeatEveryMs },
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    logger.info({ sourceId: source.sourceId, everyMs: repeatEveryMs }, 'Scheduled ingest job');
  }
}
