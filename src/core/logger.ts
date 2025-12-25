import pino from 'pino';
import { env } from './env';

const logger = pino({ name: 'app', level: env.NODE_ENV === 'development' ? 'debug' : 'info' });
export { logger };
