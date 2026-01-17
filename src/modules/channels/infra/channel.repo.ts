import { inject, injectable } from 'inversify';
import type { Kysely } from 'kysely';
import { DbDeps } from '@/infra/db/db.dep';
import type { DatabaseScheme } from '@/infra/db/db-scheme';
import type {
  NewOutboundChannelRow,
  OutboundChannelRow,
  OutboundChannelUpdateRow,
} from '@/infra/db/outbound-channels.table';
import type { NewOutboundChannel, OutboundChannel } from '../domain/entity/outbound-channel.entity';
import type { IOutboundChannelRepository } from '../domain/port/channel-repo.interface';

@injectable()
export class OutboundChannelRepository implements IOutboundChannelRepository {
  constructor(
    @inject(DbDeps.Database)
    private readonly db: Kysely<DatabaseScheme>,
  ) {}

  public async listChannels(): Promise<OutboundChannel[]> {
    const rows = await this.db.selectFrom('outbound_channels').selectAll().orderBy('id', 'asc').execute();
    return rows.map((row) => toOutboundChannel(row));
  }

  public async getChannelById(id: string): Promise<OutboundChannel | undefined> {
    const row = await this.db.selectFrom('outbound_channels').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? toOutboundChannel(row) : undefined;
  }

  public async insertChannel(data: NewOutboundChannel, id: string): Promise<OutboundChannel> {
    const row = await this.db
      .insertInto('outbound_channels')
      .values(toOutboundChannelRow(data, id))
      .returningAll()
      .executeTakeFirstOrThrow();
    return toOutboundChannel(row);
  }

  public async updateChannel(id: string, data: NewOutboundChannel): Promise<OutboundChannel | undefined> {
    const row = await this.db
      .updateTable('outbound_channels')
      .set(toOutboundChannelUpdateRow(data))
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    return row ? toOutboundChannel(row) : undefined;
  }

  public async deleteChannel(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom('outbound_channels').where('id', '=', id).executeTakeFirst();
    return result.numDeletedRows > 0;
  }
}

function toOutboundChannelRow(data: NewOutboundChannel, id: string): NewOutboundChannelRow {
  return {
    id,
    kind: data.kind,
    min_level: data.minLevel,
    target: data.target,
  };
}

function toOutboundChannelUpdateRow(data: NewOutboundChannel): OutboundChannelUpdateRow {
  return {
    kind: data.kind,
    min_level: data.minLevel,
    target: data.target,
  };
}

function toOutboundChannel(row: OutboundChannelRow): OutboundChannel {
  return {
    id: row.id,
    kind: row.kind,
    minLevel: row.min_level,
    target: row.target,
  };
}
