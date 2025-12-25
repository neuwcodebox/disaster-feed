import { type Expression, type OperationNode, sql } from 'kysely';

export class JsonValue<T extends object> implements Expression<T> {
  public value: T;

  constructor(value: T) {
    this.value = value;
  }

  public get expressionType(): T | undefined {
    return undefined;
  }

  public toOperationNode(): OperationNode {
    const json = JSON.stringify(this.value);
    return sql`CAST(${json} AS JSONB)`.toOperationNode();
  }

  public static create<T extends object>(value: T): JsonValue<T>;
  public static create<T extends object>(value: T | null): JsonValue<T> | null;
  public static create<T extends object>(value: T | undefined): JsonValue<T> | undefined;
  public static create<T extends object>(value: T | null | undefined): JsonValue<T> | null | undefined {
    if (value) {
      return new JsonValue(value);
    }
    return value;
  }
}
