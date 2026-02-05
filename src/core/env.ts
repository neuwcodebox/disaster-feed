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
    MIGRATIONS_ENABLED: z.coerce.number().default(1),
    MIGRATIONS_DIR: z.string().optional(),
    DATABASE_URL: z.url(),
    REDIS_URL: z.url(),
    ADMIN_API_KEY: z.string().min(1),
    KMA_API_KEY: z.string().optional(),
    YNA_SERVICE_KEY: z.string().optional(),
    OPENSKY_CLIENT_ID: z.string().optional(),
    OPENSKY_CLIENT_SECRET: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
  })
  .parse(process.env);
