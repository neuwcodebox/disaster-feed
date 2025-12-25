import type { DependencyContainer } from '@/core/dep';
import { env } from '@/core/env';
import { logger } from '@/core/logger';
import { IngestSchedulerService } from './app/ingest-scheduler.service';
import { IngestWorkerService } from './app/ingest-worker.service';
import { SourceRegistry } from './app/source.registry';
import { IngestDeps } from './domain/dep/ingest.dep';
import { IngestCheckpointRepository } from './infra/ingest-checkpoint.repo';

export function registerIngestDeps(dep: DependencyContainer) {
  dep.add(IngestDeps.SourceRegistry, SourceRegistry);
  dep.add(IngestDeps.IngestSchedulerService, IngestSchedulerService);
  dep.add(IngestDeps.IngestWorkerService, IngestWorkerService);
  dep.add(IngestDeps.IngestCheckpointRepository, IngestCheckpointRepository);
}

export async function startIngest(dep: DependencyContainer): Promise<void> {
  if (env.INGEST_ENABLED !== 1) {
    logger.info({ ingestEnabled: env.INGEST_ENABLED }, 'Ingest disabled');
    return;
  }

  const scheduler = dep.get<IngestSchedulerService>(IngestDeps.IngestSchedulerService);
  const worker = dep.get<IngestWorkerService>(IngestDeps.IngestWorkerService);

  try {
    await scheduler.scheduleRepeatableJobs();
  } catch (error) {
    logger.error({ error }, 'Failed to schedule ingest jobs');
  }

  worker.start();
}
