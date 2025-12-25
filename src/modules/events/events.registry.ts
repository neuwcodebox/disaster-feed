import type { OpenAPIHono } from '@hono/zod-openapi';
import type { DependencyContainer } from '@/core/dep';
import type { IRoute } from '@/view/route.interface';
import { EventService } from './app/event.service';
import { EventStreamService } from './app/event-stream.service';
import { EventWriterService } from './app/event-writer.service';
import { EventDeps } from './domain/dep/event.dep';
import { EventRepository } from './infra/event.repo';
import { EventRoute } from './view/event.route';

export function registerEventDeps(dep: DependencyContainer) {
  dep.add(EventDeps.EventRepo, EventRepository);
  dep.add(EventDeps.EventService, EventService);
  dep.add(EventDeps.EventWriterService, EventWriterService);
  dep.add(EventDeps.EventStreamService, EventStreamService);
  dep.add(EventDeps.EventRoute, EventRoute);
}

export function registerEventRoutes(app: OpenAPIHono, dep: DependencyContainer) {
  app.route('/events', dep.get<IRoute>(EventDeps.EventRoute).getApp());
}

export function startEventStream(dep: DependencyContainer) {
  void dep.get<EventStreamService>(EventDeps.EventStreamService).start();
}
