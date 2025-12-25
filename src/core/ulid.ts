import { ulid } from 'ulid';

export function createUlid(): string {
  return ulid();
}
