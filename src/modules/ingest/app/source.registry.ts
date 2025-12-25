import { injectable } from 'inversify';
import type { Source } from '../domain/port/source.interface';
import { sourceList } from './source.list';

@injectable()
export class SourceRegistry {
  private readonly sources = new Map<EventSources, Source>();

  constructor() {
    for (const source of sourceList) {
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
