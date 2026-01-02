import { inject, injectable } from 'inversify';
import { IngestDeps } from '../domain/dep/ingest.dep';
import type { IRegionRepository } from '../domain/port/region-repo.interface';
import type { Source } from '../domain/port/source.interface';
import type { LlmLabelClassifierService } from './llm-label-classifier.service';
import { buildSourceList } from './source.list';

@injectable()
export class SourceRegistry {
  private readonly sources = new Map<EventSources, Source>();

  constructor(
    @inject(IngestDeps.LlmLabelClassifierService)
    private readonly llmLabelClassifier: LlmLabelClassifierService,
    @inject(IngestDeps.RegionRepository)
    private readonly regionRepository: IRegionRepository,
  ) {
    for (const source of buildSourceList(this.llmLabelClassifier, this.regionRepository)) {
      this.sources.set(source.sourceId, source);
    }
  }

  public list(): Source[] {
    return Array.from(this.sources.values());
  }

  public get(sourceId: EventSources): Source | undefined {
    return this.sources.get(sourceId);
  }
}

import type { EventSources } from '@/modules/events/domain/event.enums';
