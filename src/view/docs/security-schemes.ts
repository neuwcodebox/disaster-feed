import type { OpenAPIHono } from '@hono/zod-openapi';

export function setSecuritySchemes(app: OpenAPIHono): void {
  app.openAPIRegistry.registerComponent('securitySchemes', 'AccessToken', {
    type: 'http',
    scheme: 'bearer',
  });
  app.openAPIRegistry.registerComponent('securitySchemes', 'RefreshToken', {
    type: 'http',
    scheme: 'bearer',
  });
  app.openAPIRegistry.registerComponent('securitySchemes', 'ApiKey', {
    type: 'http',
    scheme: 'bearer',
  });
}

export const securitySchemes = {
  accessToken: { AccessToken: [] },
  refreshToken: { RefreshToken: [] },
  apiKey: { ApiKey: [] },
};
