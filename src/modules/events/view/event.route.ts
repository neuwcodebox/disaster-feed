import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { inject } from 'inversify';
import { z } from 'zod';
import type { IRoute } from '@/view/route.interface';
import type { EventStreamService } from '../app/event-stream.service';
import { EventDeps } from '../domain/dep/event.dep';
import { schemaGetEventsQuery } from '../domain/dto/get-events-query.dto';
import { schemaGetEventsResBody } from '../domain/dto/get-events-res-body.dto';
import { schemaGetEventsStreamQuery } from '../domain/dto/get-events-stream-query.dto';
import type { IEventService } from '../domain/port/event-service.interface';

export class EventRoute implements IRoute {
  constructor(
    @inject(EventDeps.EventService)
    eventService: IEventService,
    @inject(EventDeps.EventStreamService)
    eventStreamService: EventStreamService,
  ) {
    this.app.openapi(
      createRoute({
        tags: ['Events'],
        method: 'get',
        path: '/',
        summary: 'List events',
        request: {
          query: schemaGetEventsQuery,
        },
        responses: {
          200: {
            content: {
              'application/json': {
                schema: schemaGetEventsResBody,
              },
            },
            description: 'Event list',
          },
        },
      }),
      async (c) => {
        const query = c.req.valid('query');
        const result = await eventService.listEvents(query);
        return c.json(result);
      },
    );

    this.app.openapi(
      createRoute({
        tags: ['Events'],
        method: 'get',
        path: '/stream',
        summary: 'Stream events',
        request: {
          query: schemaGetEventsStreamQuery,
        },
        responses: {
          200: {
            content: {
              'text/event-stream': {
                schema: z.string(),
              },
            },
            description: 'SSE stream',
          },
        },
      }),
      async (c) => {
        const query = c.req.valid('query');
        return streamSSE(c, async (stream) => {
          eventStreamService.addClient(stream);
          await eventStreamService.sendCatchUp(stream, query.since);
          while (!stream.aborted && !stream.closed) {
            await stream.writeSSE({ event: 'ping', data: 'keep-alive' });
            await stream.sleep(15000);
          }
        });
      },
    );
  }

  private readonly app = new OpenAPIHono();

  public getApp(): OpenAPIHono {
    return this.app;
  }
}
