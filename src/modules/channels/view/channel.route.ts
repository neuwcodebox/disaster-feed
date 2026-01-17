import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { inject } from 'inversify';
import { z } from 'zod';
import { securitySchemes } from '@/view/docs/security-schemes';
import { adminApiKeyMiddleware } from '@/view/middleware/admin-api-key.middleware';
import type { IRoute } from '@/view/route.interface';
import { ChannelDeps } from '../domain/dep/channel.dep';
import { schemaCreateChannelBody } from '../domain/dto/create-channel-body.dto';
import { schemaDeleteChannelResBody } from '../domain/dto/delete-channel-res-body.dto';
import { schemaGetChannelParams } from '../domain/dto/get-channel-params.dto';
import { schemaGetChannelResBody } from '../domain/dto/get-channel-res-body.dto';
import { schemaGetChannelsResBody } from '../domain/dto/get-channels-res-body.dto';
import { schemaUpdateChannelBody } from '../domain/dto/update-channel-body.dto';
import type { IOutboundChannelService } from '../domain/port/channel-service.interface';

export class ChannelRoute implements IRoute {
  constructor(
    @inject(ChannelDeps.ChannelService)
    channelService: IOutboundChannelService,
  ) {
    this.app.use('*', adminApiKeyMiddleware);

    this.app.openapi(
      createRoute({
        tags: ['Channels'],
        method: 'get',
        path: '/',
        summary: 'List outbound channels',
        security: [securitySchemes.apiKey],
        responses: {
          200: {
            content: {
              'application/json': {
                schema: schemaGetChannelsResBody,
              },
            },
            description: 'Outbound channels list',
          },
          401: {
            content: {
              'application/json': {
                schema: schemaErrorResponse,
              },
            },
            description: 'Unauthorized',
          },
        },
      }),
      async (c) => {
        const result = await channelService.listChannels();
        return c.json(result, 200);
      },
    );

    this.app.openapi(
      createRoute({
        tags: ['Channels'],
        method: 'post',
        path: '/',
        summary: 'Create outbound channel',
        security: [securitySchemes.apiKey],
        request: {
          body: {
            content: {
              'application/json': {
                schema: schemaCreateChannelBody,
              },
            },
          },
        },
        responses: {
          201: {
            content: {
              'application/json': {
                schema: schemaGetChannelResBody,
              },
            },
            description: 'Outbound channel created',
          },
          401: {
            content: {
              'application/json': {
                schema: schemaErrorResponse,
              },
            },
            description: 'Unauthorized',
          },
        },
      }),
      async (c) => {
        const body = c.req.valid('json');
        const result = await channelService.createChannel(body);
        return c.json(result, 201);
      },
    );

    this.app.openapi(
      createRoute({
        tags: ['Channels'],
        method: 'get',
        path: '/:id',
        summary: 'Get outbound channel by id',
        security: [securitySchemes.apiKey],
        request: {
          params: schemaGetChannelParams,
        },
        responses: {
          200: {
            content: {
              'application/json': {
                schema: schemaGetChannelResBody,
              },
            },
            description: 'Outbound channel detail',
          },
          401: {
            content: {
              'application/json': {
                schema: schemaErrorResponse,
              },
            },
            description: 'Unauthorized',
          },
          404: {
            content: {
              'application/json': {
                schema: schemaErrorResponse,
              },
            },
            description: 'Outbound channel not found',
          },
        },
      }),
      async (c) => {
        const params = c.req.valid('param');
        const result = await channelService.getChannelById(params.id);
        if (!result) {
          return c.json({ message: 'Channel not found' } as const, 404);
        }
        return c.json(result, 200);
      },
    );

    this.app.openapi(
      createRoute({
        tags: ['Channels'],
        method: 'put',
        path: '/:id',
        summary: 'Update outbound channel',
        security: [securitySchemes.apiKey],
        request: {
          params: schemaGetChannelParams,
          body: {
            content: {
              'application/json': {
                schema: schemaUpdateChannelBody,
              },
            },
          },
        },
        responses: {
          200: {
            content: {
              'application/json': {
                schema: schemaGetChannelResBody,
              },
            },
            description: 'Outbound channel updated',
          },
          401: {
            content: {
              'application/json': {
                schema: schemaErrorResponse,
              },
            },
            description: 'Unauthorized',
          },
          404: {
            content: {
              'application/json': {
                schema: schemaErrorResponse,
              },
            },
            description: 'Outbound channel not found',
          },
        },
      }),
      async (c) => {
        const params = c.req.valid('param');
        const body = c.req.valid('json');
        const result = await channelService.updateChannel(params.id, body);
        if (!result) {
          return c.json({ message: 'Channel not found' } as const, 404);
        }
        return c.json(result, 200);
      },
    );

    this.app.openapi(
      createRoute({
        tags: ['Channels'],
        method: 'delete',
        path: '/:id',
        summary: 'Delete outbound channel',
        security: [securitySchemes.apiKey],
        request: {
          params: schemaGetChannelParams,
        },
        responses: {
          200: {
            content: {
              'application/json': {
                schema: schemaDeleteChannelResBody,
              },
            },
            description: 'Outbound channel deleted',
          },
          401: {
            content: {
              'application/json': {
                schema: schemaErrorResponse,
              },
            },
            description: 'Unauthorized',
          },
          404: {
            content: {
              'application/json': {
                schema: schemaErrorResponse,
              },
            },
            description: 'Outbound channel not found',
          },
        },
      }),
      async (c) => {
        const params = c.req.valid('param');
        const deleted = await channelService.deleteChannel(params.id);
        if (!deleted) {
          return c.json({ message: 'Channel not found' } as const, 404);
        }
        return c.json({ deleted }, 200);
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
