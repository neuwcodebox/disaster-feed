import type { Job, Worker } from 'bullmq';
import { inject, injectable } from 'inversify';
import { logger } from '@/core/logger';
import { createUuidV7 } from '@/core/uuid';
import { createIngestWorker } from '@/infra/queue/worker';
import { EventDeps } from '@/modules/events/domain/dep/event.dep';
import type { EventSources } from '@/modules/events/domain/event.enums';
import type { IEventWriterService } from '@/modules/events/domain/port/event-writer-service.interface';
import { IngestDeps } from '../domain/dep/ingest.dep';
import type { IngestJobPayload } from '../domain/dto/ingest-job.dto';
import type { IIngestCheckpointRepository } from '../domain/port/ingest-checkpoint-repo.interface';
import type { SourceEvent } from '../domain/port/source.interface';
import type { SourceRegistry } from './source.registry';

@injectable()
export class IngestWorkerService {
  private worker: Worker<IngestJobPayload> | null = null;
  private readonly runningSourceIds = new Set<EventSources>();

  constructor(
    @inject(IngestDeps.SourceRegistry)
    private readonly sourceRegistry: SourceRegistry,
    @inject(EventDeps.EventWriterService)
    private readonly eventWriter: IEventWriterService,
    @inject(IngestDeps.IngestCheckpointRepository)
    private readonly ingestCheckpointRepository: IIngestCheckpointRepository,
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

  public async stop(): Promise<void> {
    if (!this.worker) {
      return;
    }

    try {
      await this.worker.close();
      logger.debug('Ingest worker stopped');
    } catch (error) {
      logger.warn({ error }, 'Failed to stop ingest worker');
    } finally {
      this.worker = null;
    }
  }

  private async processJob(job: Job<IngestJobPayload>): Promise<void> {
    const sourceId = job.data.sourceId;
    const source = this.sourceRegistry.get(sourceId);
    if (!source) {
      logger.warn({ sourceId }, 'Source not found for ingest job');
      return;
    }

    if (this.runningSourceIds.has(sourceId)) {
      logger.warn({ sourceId, jobId: job.id }, 'Skipping ingest job due to running source');
      return;
    }

    this.runningSourceIds.add(sourceId);

    try {
      const checkpoint = await this.ingestCheckpointRepository.getCheckpoint(sourceId);
      const checkpointState = checkpoint?.state ?? null;

      logger.debug({ sourceId, jobId: job.id }, 'Running ingest job');
      const fetchedAt = new Date().toISOString();
      const { events, nextState } = await source.run(checkpointState);
      let allInserted = true;

      for (const event of events) {
        const inserted = await this.insertEvent(source.sourceId, fetchedAt, event);
        if (!inserted) {
          allInserted = false;
        }
      }

      if (allInserted) {
        await this.ingestCheckpointRepository.upsertCheckpoint(sourceId, nextState);
      } else {
        logger.warn({ sourceId, jobId: job.id }, 'Skipping checkpoint update due to insert failures');
      }

      logger.debug({ sourceId, jobId: job.id, eventCount: events.length }, 'Completed ingest job');
    } finally {
      this.runningSourceIds.delete(sourceId);
    }
  }

  private async insertEvent(sourceId: EventSources, fetchedAt: string, event: SourceEvent): Promise<boolean> {
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
        payload: event.payload ?? null,
      });
      return true;
    } catch (error) {
      logger.error({ error, sourceId }, 'Failed to append event');
      return false;
    }
  }
}
