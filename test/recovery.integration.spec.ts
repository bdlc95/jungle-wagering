import { afterAll, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { SqsTransport } from '../src/messaging/sqs.transport';
import { OutboxRecord } from '../src/persistence/entities';

describe('outbox recovery with concurrent publishers', () => {
  const apps: INestApplication<App>[] = [];

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
  }, 20000);

  async function createApp(): Promise<{
    app: INestApplication<App>;
    em: EntityManager;
    sqs: SqsTransport;
  }> {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = module.createNestApplication<INestApplication<App>>();
    await app.init();
    apps.push(app);
    return {
      app,
      em: module.get(EntityManager),
      sqs: module.get(SqsTransport),
    };
  }

  it('publishes committed events after restart with two publishers', async () => {
    const suffix = crypto.randomUUID();
    process.env.SQS_TRANSACTIONS_QUEUE_NAME = `recovery-input-${suffix}.fifo`;
    process.env.SQS_TRANSACTIONS_DLQ_NAME = `recovery-dlq-${suffix}.fifo`;
    process.env.SQS_EVENTS_QUEUE_NAME = `recovery-events-${suffix}.fifo`;
    process.env.WORKERS_ENABLED = 'false';
    const first = await createApp();
    await first.sqs.setupQueues();
    const walletResponse = await request(first.app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
    expect(walletResponse.status).toBe(201);
    const wallet = walletResponse.body as { id: string; playerId: string };
    const externalId = crypto.randomUUID();
    const wager = await request(first.app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `recovery:${externalId}`)
      .send({
        providerId: 'recovery',
        externalTransactionId: externalId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-recovery',
        gameId: 'game-recovery',
        kind: 'BET',
        money: { amount: '20.00', currency: 'BRL' },
      });
    expect(wager.status).toBe(201);
    const pending = await first.em
      .fork()
      .find(OutboxRecord, { aggregateId: wallet.id, publishedAt: null });
    expect(pending).toHaveLength(4);
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);

    process.env.WORKERS_ENABLED = 'true';
    const [second, third] = await Promise.all([createApp(), createApp()]);
    const until = Date.now() + 12000;
    let published: OutboxRecord[] = [];
    while (Date.now() < until) {
      published = await second.em
        .fork()
        .find(OutboxRecord, { aggregateId: wallet.id });
      if (
        published.length === 4 &&
        published.every((event) => event.publishedAt)
      )
        break;
      await Bun.sleep(100);
    }
    expect(published).toHaveLength(4);
    expect(published.every((event) => event.publishedAt)).toBe(true);
    const reconciliation = await request(second.app.getHttpServer()).post(
      `/wallets/${wallet.id}/reconciliation`,
    );
    const state = reconciliation.body as {
      consistent: boolean;
      storedBalance: { amount: string };
    };
    expect(state.consistent).toBe(true);
    expect(state.storedBalance.amount).toBe('80.00');
    expect(await second.sqs.ready()).toBe(true);
    expect(await third.sqs.ready()).toBe(true);
  }, 20000);
});
