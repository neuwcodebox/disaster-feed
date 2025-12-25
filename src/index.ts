import { serve } from '@hono/node-server';
import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { env } from '@/core/env';
import { logger } from '@/core/logger';
import { DependencyContainer } from './core/dep';
import { DbDeps } from './infra/db/db.dep';
import { registerDbDeps } from './infra/db/db-conn';
import type { DatabaseScheme } from './infra/db/db-scheme';
import { registerQueueDeps } from './infra/queue/queue';
import { RedisDeps } from './infra/redis/redis.dep';
import { registerRedisDeps } from './infra/redis/redis-conn';
import {
  registerEventDeps,
  registerEventRoutes,
  startEventStream,
  stopEventStream,
} from './modules/events/events.registry';
import { registerHealthDeps, registerHealthRoutes } from './modules/health/health.registry';
import { registerIngestDeps, startIngest, stopIngest } from './modules/ingest/ingest.registry';
import { setSecuritySchemes } from './view/docs/security-schemes';
import { corsMiddleware } from './view/middleware/cors.middleware';

// Init
//

logger.info(`Starting up in ${env.NODE_ENV} mode`);

const dep = new DependencyContainer();
const app = new OpenAPIHono();

// Dependencies
//

registerDbDeps(dep);
registerRedisDeps(dep);
registerQueueDeps(dep);
registerHealthDeps(dep);
registerEventDeps(dep);
registerIngestDeps(dep);

// Middleware
//

if (env.CORS === 1) {
  app.use(corsMiddleware);
}

// Routes
//

app.get('/', (c) => c.text('Running'));
registerHealthRoutes(app, dep);
registerEventRoutes(app, dep);

// Swagger
//

if (env.SWAGGER === 1) {
  setSecuritySchemes(app);
  app.doc('/api/docs', {
    openapi: '3.0.0',
    info: {
      version: '1.0.0',
      title: 'API',
    },
  });
  app.get('/api-docs', swaggerUI({ url: '/api/docs' }));
}

// Server
//

const server = serve(
  {
    fetch: app.fetch,
    hostname: env.HOST,
    port: env.PORT,
  },
  (info) => {
    logger.info(`Server is running at http://${env.HOST}:${info.port}`);
  },
);

// Background Services
//

startEventStream(dep);
void startIngest(dep);

// Shutdown
//

let isShuttingDown = false;

const closeRedisClient = async (redis: Redis, name: string): Promise<void> => {
  try {
    await redis.quit();
    logger.debug({ name }, 'Redis client closed');
  } catch (error) {
    logger.warn({ error, name }, 'Failed to close Redis client');
    try {
      redis.disconnect();
    } catch (disconnectError) {
      logger.warn({ error: disconnectError, name }, 'Failed to disconnect Redis client');
    }
  }
};

const closeServer = async (): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  logger.debug('HTTP server closed');
};

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  logger.info({ signal }, 'Signal received, shutting down');

  const forceTimer = setTimeout(() => process.exit(1), 10000).unref();

  try {
    await closeServer();
  } catch (error) {
    logger.warn({ error }, 'Failed to close HTTP server');
  }

  try {
    await stopEventStream(dep);
  } catch (error) {
    logger.warn({ error }, 'Failed to stop event stream');
  }

  try {
    await stopIngest(dep);
  } catch (error) {
    logger.warn({ error }, 'Failed to stop ingest');
  }

  try {
    const redisClient = dep.get<Redis>(RedisDeps.Client);
    const redisSubscriber = dep.get<Redis>(RedisDeps.Subscriber);
    await closeRedisClient(redisSubscriber, 'subscriber');
    await closeRedisClient(redisClient, 'client');
  } catch (error) {
    logger.warn({ error }, 'Failed to close Redis clients');
  }

  try {
    const db = dep.get<Kysely<DatabaseScheme>>(DbDeps.Database);
    await db.destroy();
    logger.debug('Database pool closed');
  } catch (error) {
    logger.warn({ error }, 'Failed to close database pool');
  }

  clearTimeout(forceTimer);
  process.exit(0);
};

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
