import {
  Controller,
  Get,
  Header,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { OutboxRecord } from '../persistence/entities';
import { SqsTransport } from '../messaging/sqs.transport';
import { MetricsService } from './metrics.service';

@Controller()
export class HealthController {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsTransport,
    private readonly metrics: MetricsService,
  ) {}

  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready() {
    let postgres = false;
    try {
      await this.em.fork().getConnection().execute('select 1');
      postgres = true;
    } catch {
      /* checked below */
    }
    const sqs = await this.sqs.ready();
    if (!postgres || !sqs)
      throw new ServiceUnavailableException({
        status: 'unavailable',
        postgres,
        sqs,
      });
    return { status: 'ok', postgres, sqs };
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async scrape(): Promise<string> {
    const [oldest, dlqDepth] = await Promise.all([
      this.em
        .fork()
        .findOne(
          OutboxRecord,
          { publishedAt: null },
          { orderBy: { occurredAt: 'ASC' } },
        ),
      this.sqs.dlqDepth().catch(() => NaN),
    ]);
    const lag = oldest
      ? Math.max(0, (Date.now() - oldest.occurredAt.getTime()) / 1000)
      : 0;
    return this.metrics.render(lag, dlqDepth);
  }
}
