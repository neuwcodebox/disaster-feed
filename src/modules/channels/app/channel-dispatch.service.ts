import { inject, injectable } from 'inversify';
import { logger } from '@/core/logger';
import { EventKinds, EventSources } from '@/modules/events/domain/event.enums';
import { ChannelKinds } from '../domain/channel.enums';
import { ChannelDeps } from '../domain/dep/channel.dep';
import type { OutboundChannel, OutboundDispatchEvent } from '../domain/entity/outbound-channel.entity';
import type { IOutboundChannelDispatcher } from '../domain/port/channel-dispatcher.interface';
import type { IOutboundChannelRepository } from '../domain/port/channel-repo.interface';

const DISCORD_EMBED_TITLE_LIMIT = 256;
const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096;
const DISPATCH_BATCH_SIZE = 5;

type DiscordEmbed = {
  title?: string;
  description?: string;
  color?: number;
  timestamp?: string;
  footer?: {
    text: string;
  };
};

type DiscordWebhookPayload = {
  embeds: DiscordEmbed[];
  allowed_mentions: {
    parse: string[];
  };
};

@injectable()
export class OutboundChannelDispatchService implements IOutboundChannelDispatcher {
  constructor(
    @inject(ChannelDeps.ChannelRepo)
    private readonly channelRepository: IOutboundChannelRepository,
  ) {}

  public async dispatchEvent(event: OutboundDispatchEvent): Promise<void> {
    let channels: OutboundChannel[];
    try {
      channels = await this.channelRepository.listChannels();
    } catch (error) {
      logger.error({ error }, 'Failed to load outbound channels');
      return;
    }

    const targets = channels.filter((channel) => event.level >= channel.minLevel);

    for (let index = 0; index < targets.length; index += DISPATCH_BATCH_SIZE) {
      const batch = targets.slice(index, index + DISPATCH_BATCH_SIZE);
      const tasks = batch.map((channel) => this.dispatchToChannel(channel, event));
      await Promise.all(tasks);
    }
  }

  private async dispatchToChannel(channel: OutboundChannel, event: OutboundDispatchEvent): Promise<void> {
    try {
      await this.sendToChannel(channel, event);
    } catch (error) {
      logger.warn({ error, channelId: channel.id }, 'Failed to dispatch outbound event');
    }
  }

  private async sendToChannel(channel: OutboundChannel, event: OutboundDispatchEvent): Promise<void> {
    switch (channel.kind) {
      case ChannelKinds.Discord:
        await this.sendDiscordWebhook(channel, event);
        return;
      default:
        logger.warn({ channelId: channel.id, kind: channel.kind }, 'Unsupported outbound channel kind');
    }
  }

  private async sendDiscordWebhook(channel: OutboundChannel, event: OutboundDispatchEvent): Promise<void> {
    const payload = buildDiscordPayload(event);
    const response = await fetch(channel.target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      return;
    }

    let responseBody: string | null = null;
    try {
      responseBody = await response.text();
    } catch (error) {
      logger.debug({ error, channelId: channel.id }, 'Failed to read Discord webhook response body');
    }

    logger.warn(
      {
        channelId: channel.id,
        status: response.status,
        responseBody,
      },
      'Discord webhook request failed',
    );
  }
}

function buildDiscordPayload(event: OutboundDispatchEvent): DiscordWebhookPayload {
  const levelLabel = resolveLevelLabel(event.level);
  const kindLabel = EVENT_KIND_LABELS[event.kind as EventKinds] ?? String(event.kind);
  const title = clampText(`[${kindLabel}·${levelLabel}] ${event.title}`, DISCORD_EMBED_TITLE_LIMIT);
  const description = clampText(event.body ?? '', DISCORD_EMBED_DESCRIPTION_LIMIT);
  const timestamp = event.occurredAt ?? undefined;
  const footerText = buildFooterText(event);

  return {
    embeds: [
      {
        title,
        description: description.length > 0 ? description : undefined,
        color: resolveLevelColor(event.level),
        timestamp,
        footer: {
          text: footerText,
        },
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

function clampText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit - 3)}...`;
}

function resolveLevelColor(level: number): number {
  switch (level) {
    case 1:
      return 0x2d9cdb;
    case 2:
      return 0x27ae60;
    case 3:
      return 0xf2c94c;
    case 4:
      return 0xf2994a;
    case 5:
      return 0xeb5757;
    default:
      return 0x95a5a6;
  }
}

function resolveLevelLabel(level: number): string {
  switch (level) {
    case 1:
      return '참고';
    case 2:
      return '관심';
    case 3:
      return '우려';
    case 4:
      return '중대';
    case 5:
      return '치명';
    default:
      return '알 수 없음';
  }
}

function buildFooterText(event: OutboundDispatchEvent): string {
  const sourceLabel = EVENT_SOURCE_LABELS[event.source as EventSources] ?? String(event.source);
  return sourceLabel;
}

const EVENT_SOURCE_LABELS: Record<EventSources, string> = {
  [EventSources.SafekoreaSms]: '행안부',
  [EventSources.MoisPressRelease]: '행안부',
  [EventSources.MsitPressRelease]: '과기정통부',
  [EventSources.KdcaPressRelease]: '질병청',
  [EventSources.KmaMicroEarthquake]: '기상청',
  [EventSources.KmaPewsEarthquake]: '기상청',
  [EventSources.KmaOverseasEarthquake]: '기상청',
  [EventSources.NfdsFireDispatch]: '소방청',
  [EventSources.KmaWeatherWarning]: '기상청',
  [EventSources.KmaAwsObservation]: '기상청',
  [EventSources.UticTrafficIncident]: '경찰청',
  [EventSources.AirkoreaPmWarning]: '기후부',
  [EventSources.AirkoreaO3Warning]: '기후부',
  [EventSources.FloodAlert]: '기후부',
  [EventSources.ForestFireInfo]: '산림청',
  [EventSources.ForestFireWarning]: '산림청',
  [EventSources.LandslideForecast]: '산림청',
  [EventSources.NcscCyberCrisis]: '국정원',
  [EventSources.NctcTerrorAlert]: '국조실',
  [EventSources.KpxPowerSupply]: '산업부',
  [EventSources.YnaNews]: '연합뉴스',
  [EventSources.KasaSpaceWeatherWarning]: '우주청',
  [EventSources.KasaSpaceWeatherCrisisAlert]: '우주청',
  [EventSources.OpenSkyEmergencySquawk]: 'OpenSky',
};

const EVENT_KIND_LABELS: Record<EventKinds, string> = {
  [EventKinds.Other]: '기타',
  [EventKinds.Quake]: '지진',
  [EventKinds.Ai]: 'AI',
  [EventKinds.Drought]: '가뭄',
  [EventKinds.Livestock]: '가축질병',
  [EventKinds.Wind]: '강풍',
  [EventKinds.Dry]: '건조',
  [EventKinds.Transport]: '교통',
  [EventKinds.TrafficCrash]: '교통사고',
  [EventKinds.TrafficCtrl]: '교통통제',
  [EventKinds.Finance]: '금융',
  [EventKinds.Snow]: '대설',
  [EventKinds.FineDust]: '미세먼지',
  [EventKinds.CivDef]: '민방공',
  [EventKinds.Collapse]: '붕괴',
  [EventKinds.Wildfire]: '산불',
  [EventKinds.Landslide]: '산사태',
  [EventKinds.Water]: '수도',
  [EventKinds.Fog]: '안개',
  [EventKinds.Energy]: '에너지',
  [EventKinds.Epidemic]: '전염병',
  [EventKinds.Blackout]: '정전',
  [EventKinds.Tsunami]: '지진해일',
  [EventKinds.Typhoon]: '태풍',
  [EventKinds.Terror]: '테러',
  [EventKinds.Telecom]: '통신',
  [EventKinds.Explosion]: '폭발',
  [EventKinds.Heat]: '폭염',
  [EventKinds.HighSeas]: '풍랑',
  [EventKinds.Cold]: '한파',
  [EventKinds.Rain]: '호우',
  [EventKinds.Flood]: '홍수',
  [EventKinds.Fire]: '화재',
  [EventKinds.Pollution]: '오염',
  [EventKinds.YellowDust]: '황사',
  [EventKinds.O3]: '오존',
  [EventKinds.CrowdDensity]: '인파',
  [EventKinds.WildAnimal]: '야생동물',
  [EventKinds.Cyber]: '사이버',
  [EventKinds.SpaceWeather]: '우주환경',
};
