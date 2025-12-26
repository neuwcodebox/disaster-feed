import dotenv from 'dotenv';
import { z } from 'zod';

if (process.env.NODE_ENV === 'test') {
  dotenv.config({ path: '.env.test' });
} else {
  dotenv.config();
}

export const env = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    HOST: z.string().default('localhost'),
    PORT: z.coerce.number().default(3000),
    CORS: z.coerce.number().default(0),
    SWAGGER: z.coerce.number().default(1),
    INGEST_ENABLED: z.coerce.number().default(0),
    DATABASE_URL: z.url(),
    REDIS_URL: z.url(),
    KMA_API_KEY: z.string().optional(),
  })
  .parse(process.env);
