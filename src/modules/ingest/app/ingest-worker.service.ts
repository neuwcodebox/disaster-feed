import type { Job, Worker } from 'bullmq';
import { inject, injectable } from 'inversify';
import { logger } from '@/core/logger';
import { createUuidV7 } from '@/core/uuid';
import { createIngestWorker } from '@/infra/queue/worker';
import { EventDeps } from '@/modules/events/domain/dep/event.dep';
import type { IEventWriterService } from '@/modules/events/domain/port/event-writer-service.interface';
import { IngestDeps } from '../domain/dep/ingest.dep';
import type { IngestJobPayload } from '../domain/dto/ingest-job.dto';
import type { SourceEvent } from '../domain/port/source.interface';
import type { SourceRegistry } from './source.registry';

@injectable()
export class IngestWorkerService {
  private worker: Worker<IngestJobPayload> | null = null;

  constructor(
    @inject(IngestDeps.SourceRegistry)
    private readonly sourceRegistry: SourceRegistry,
    @inject(EventDeps.EventWriterService)
    private readonly eventWriter: IEventWriterService,
  ) {}

  public start(): void {
    if (this.worker) {
      return;
    }

    this.worker = createIngestWorker(this.processJob.bind(this));
    logger.debug('Ingest worker started');
    this.worker.on('failed', (job, error) => {
      logger.error({ error, jobId: job?.id }, 'Ingest job failed');
    });
  }

  private async processJob(job: Job<IngestJobPayload>): Promise<void> {
    const sourceId = job.data.sourceId;
    const source = this.sourceRegistry.get(sourceId);
    if (!source) {
      logger.warn({ sourceId }, 'Source not found for ingest job');
      return;
    }

    logger.debug({ sourceId, jobId: job.id }, 'Running ingest job');
    const fetchedAt = new Date().toISOString();
    const events = await source.run();

    for (const event of events) {
      await this.insertEvent(sourceId, fetchedAt, event);
    }

    logger.debug({ sourceId, jobId: job.id, eventCount: events.length }, 'Completed ingest job');
  }

  private async insertEvent(sourceId: string, fetchedAt: string, event: SourceEvent): Promise<void> {
    try {
      await this.eventWriter.appendEvent({
        id: createUuidV7(),
        source: sourceId,
        kind: event.kind,
        title: event.title,
        body: event.body ?? null,
        fetchedAt,
        occurredAt: event.occurredAt ?? null,
        regionText: event.regionText ?? null,
        level: event.level,
        link: event.link ?? null,
        payload: event.payload ?? null,
      });
    } catch (error) {
      logger.error({ error, sourceId }, 'Failed to append event');
    }
  }
}
