import { afterAll, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { SqsTransport } from '../src/messaging/sqs.transport';
import { InboxRecord, LedgerRecord } from '../src/persistence/entities';
import {
  WageringService,
  type WagerInput,
} from '../src/wagering/wagering.service';
import { MetricsService } from '../src/observability/metrics.service';
import { LedgerDirection } from '../src/domain/ledger-entry';

describe('crash window after commit and before SQS ack', () => {
  const apps: INestApplication<App>[] = [];

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
  }, 15000);

  async function createApp() {
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
      wagering: module.get(WageringService),
      metrics: module.get(MetricsService),
    };
  }

  it('redelivers without a second debit', async () => {
    const suffix = crypto.randomUUID();
    process.env.SQS_TRANSACTIONS_QUEUE_NAME = `crash-input-${suffix}.fifo`;
    process.env.SQS_TRANSACTIONS_DLQ_NAME = `crash-dlq-${suffix}.fifo`;
    process.env.SQS_EVENTS_QUEUE_NAME = `crash-events-${suffix}.fifo`;
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
    const messageId = crypto.randomUUID();
    const key = `crash:${externalId}`;
    const data = {
      providerId: 'crash',
      externalTransactionId: externalId,
      idempotencyKey: key,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-crash',
      gameId: 'game-crash',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };
    await first.sqs.sendTransaction(
      {
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data,
      },
      wallet.id,
      crypto.randomUUID(),
    );
    const [delivery] = await first.sqs.receive(2);
    expect(delivery).toBeDefined();
    const result = await first.wagering.process(data as WagerInput, key, {
      messageId,
      consumerName: 'wager-transactions',
    });
    expect(result.status).toBe('PROCESSED');
    // Simulate worker death at the commit/ack boundary: close without DeleteMessage.
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);

    process.env.WORKERS_ENABLED = 'true';
    const second = await createApp();
    const until = Date.now() + 12000;
    let inbox: InboxRecord[] = [];
    let ledger: LedgerRecord[] = [];
    while (Date.now() < until) {
      inbox = await second.em.fork().find(InboxRecord, { messageId });
      ledger = await second.em.fork().find(LedgerRecord, {
        walletId: wallet.id,
        direction: LedgerDirection.Debit,
      });
      const state = await request(second.app.getHttpServer()).get(
        `/wallets/${wallet.id}`,
      );
      if (
        second.metrics.render(0).includes('wagering_duplicates_total 1') &&
        inbox.length === 1 &&
        ledger.length === 1 &&
        (state.body as { balance: { amount: string } }).balance.amount ===
          '75.00'
      )
        break;
      await Bun.sleep(100);
    }
    expect(inbox).toHaveLength(1);
    expect(ledger).toHaveLength(1);
    const reconciliation = await request(second.app.getHttpServer()).post(
      `/wallets/${wallet.id}/reconciliation`,
    );
    expect((reconciliation.body as { consistent: boolean }).consistent).toBe(
      true,
    );
  }, 20000);
});
