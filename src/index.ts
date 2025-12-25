import { serve } from '@hono/node-server';
import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono } from '@hono/zod-openapi';
import { env } from '@/core/env';
import { logger } from '@/core/logger';
import { DependencyContainer } from './core/dep';
import { registerDbDeps } from './infra/db/db-conn';
import { registerHealthDeps, registerHealthRoutes } from './modules/health/health.registry';
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
registerHealthDeps(dep);

// Middleware
//

if (env.CORS === 1) {
  app.use(corsMiddleware);
}

// Routes
//

app.get('/', (c) => c.text('Running'));
registerHealthRoutes(app, dep);

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

// Shutdown
//

const onCloseSignal = () => {
  logger.info('sigint received, shutting down');

  // Force shutdown after timeout
  setTimeout(() => process.exit(1), 10000).unref();

  // Graceful shutdown
  server.close(() => process.exit(0));
};

process.on('SIGINT', onCloseSignal);
process.on('SIGTERM', onCloseSignal);
