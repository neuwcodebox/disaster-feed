import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { inject } from 'inversify';
import { z } from 'zod';
import type { IRoute } from '@/view/route.interface';
import type { EventStreamService } from '../app/event-stream.service';
import { EventDeps } from '../domain/dep/event.dep';
import { schemaGetEventParams } from '../domain/dto/get-event-params.dto';
import { schemaGetEventResBody } from '../domain/dto/get-event-res-body.dto';
import { schemaGetEventsQuery } from '../domain/dto/get-events-query.dto';
import { schemaGetEventsResBody } from '../domain/dto/get-events-res-body.dto';
import { schemaGetEventsStreamClientsResBody } from '../domain/dto/get-events-stream-clients-res-body.dto';
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
        const afterId = query.afterId ?? c.req.header('last-event-id') ?? undefined;
        const response = streamSSE(c, async (stream) => {
          eventStreamService.addClient(stream);
          await eventStreamService.sendCatchUp(stream, afterId);
          while (!stream.aborted && !stream.closed) {
            await stream.writeSSE({ event: 'ping', data: 'keep-alive' });
            await stream.sleep(15000);
          }
        });
        response.headers.set('Content-Type', 'text/event-stream; charset=utf-8');
        return response;
      },
    );

    this.app.openapi(
      createRoute({
        tags: ['Events'],
        method: 'get',
        path: '/stream/clients',
        summary: 'Get SSE client count',
        responses: {
          200: {
            content: {
              'application/json': {
                schema: schemaGetEventsStreamClientsResBody,
              },
            },
            description: 'SSE client count',
          },
        },
      }),
      async (c) => {
        const total = await eventStreamService.getApproxClientCount();
        return c.json({ total });
      },
    );

    this.app.openapi(
      createRoute({
        tags: ['Events'],
        method: 'get',
        path: '/:id',
        summary: 'Get an event by id',
        request: {
          params: schemaGetEventParams,
        },
        responses: {
          200: {
            content: {
              'application/json': {
                schema: schemaGetEventResBody,
              },
            },
            description: 'Event detail',
          },
          404: {
            content: {
              'application/json': {
                schema: schemaErrorResponse,
              },
            },
            description: 'Event not found',
          },
        },
      }),
      async (c) => {
        const params = c.req.valid('param');
        const event = await eventService.getEventById(params);
        if (!event) {
          return c.json({ message: 'Event not found' } as const, 404);
        }

        return c.json(event, 200);
      },
    );
  }

  private readonly app = new OpenAPIHono();

  public getApp(): OpenAPIHono {
    return this.app;
  }
}

const schemaErrorResponse = z.object({
  message: z.string(),
});
