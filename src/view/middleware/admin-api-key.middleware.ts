import { bearerAuth } from 'hono/bearer-auth';
import { env } from '@/core/env';

export const adminApiKeyMiddleware = bearerAuth({
  token: env.ADMIN_API_KEY,
});
