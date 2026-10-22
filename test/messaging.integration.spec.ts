import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { SqsTransport } from '../src/messaging/sqs.transport';
import { InboxRecord, OutboxRecord } from '../src/persistence/entities';

interface TransactionView {
  transactionId: string;
  status: string;
  balance: { amount: string };
}
interface LedgerView {
  items: { direction: string }[];
}
interface ReconciliationView {
  consistent: boolean;
  storedBalance: { amount: string };
}

describe('SQS and outbox with LocalStack', () => {
  let app: INestApplication<App>;
  let module: TestingModule;
  let sqs: SqsTransport;
  let em: EntityManager;

  beforeAll(async () => {
    const suffix = crypto.randomUUID();
    process.env.SQS_TRANSACTIONS_QUEUE_NAME = `messaging-input-${suffix}.fifo`;
    process.env.SQS_TRANSACTIONS_DLQ_NAME = `messaging-dlq-${suffix}.fifo`;
    process.env.SQS_EVENTS_QUEUE_NAME = `messaging-events-${suffix}.fifo`;
    process.env.WORKERS_ENABLED = 'true';
    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    await app.init();
    sqs = module.get(SqsTransport);
    em = module.get(EntityManager);
    await sqs.setupQueues();
  });

  afterAll(async () => {
    await app.close();
  }, 15000);

  async function waitFor<T>(
    read: () => Promise<T | undefined>,
    timeout = 12000,
  ): Promise<T> {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const value = await read();
      if (value) return value;
      await Bun.sleep(100);
    }
    throw new Error('TIMED_OUT_WAITING_FOR_WORKER');
  }

  it('consumes, deduplicates inbox, and publishes committed events', async () => {
    const walletResponse = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
    expect(walletResponse.status).toBe(201);
    const wallet = walletResponse.body as { id: string; playerId: string };
    const externalId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const envelope = {
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-sqs',
        externalTransactionId: externalId,
        idempotencyKey: `provider-sqs:${externalId}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-sqs',
        gameId: 'game-sqs',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      },
    };
    await sqs.sendTransaction(envelope, wallet.id, crypto.randomUUID());
    const transaction = await waitFor(async () => {
      const response = await request(app.getHttpServer()).get(
        `/providers/provider-sqs/wagering/transactions/${externalId}`,
      );
      const body = response.body as TransactionView;
      return response.status === 200 && body.status === 'PROCESSED'
        ? body
        : undefined;
    });
    expect(transaction.balance.amount).toBe('75.00');
    await sqs.sendTransaction(envelope, wallet.id, crypto.randomUUID());
    await waitFor(async () => {
      const inbox = await em.fork().find(InboxRecord, { messageId });
      return inbox.length === 1 ? inbox : undefined;
    });
    const ledger = await request(app.getHttpServer()).get(
      `/wallets/${wallet.id}/ledger`,
    );
    expect(
      (ledger.body as LedgerView).items.filter(
        (entry) => entry.direction === 'DEBIT',
      ),
    ).toHaveLength(1);
    await waitFor(async () => {
      const events = await em
        .fork()
        .find(OutboxRecord, { aggregateId: wallet.id });
      return events.length >= 4 && events.every((event) => event.publishedAt)
        ? events
        : undefined;
    });
  }, 20000);

  it('retries a refund that arrives before its bet', async () => {
    const walletResponse = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
    expect(walletResponse.status).toBe(201);
    const wallet = walletResponse.body as { id: string; playerId: string };
    const betId = crypto.randomUUID();
    const refundId = crypto.randomUUID();
    const refund = {
      providerId: 'provider-ordered',
      externalTransactionId: refundId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-ordered',
      gameId: 'game-ordered',
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: betId,
    };
    const pending = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-ordered:${refundId}`)
      .send(refund);
    expect(pending.status).toBe(202);
    const pendingBody = pending.body as TransactionView;
    expect(pendingBody.status).toBe('PENDING_REFERENCE');
    const bet = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-ordered:${betId}`)
      .send({
        ...refund,
        externalTransactionId: betId,
        kind: 'BET',
        referenceExternalTransactionId: undefined,
      });
    expect(bet.status).toBe(201);
    await waitFor(async () => {
      const response = await request(app.getHttpServer()).get(
        `/wagering/transactions/${pendingBody.transactionId}`,
      );
      const body = response.body as TransactionView;
      return body.status === 'PROCESSED' ? body : undefined;
    });
    const reconciliation = await request(app.getHttpServer()).post(
      `/wallets/${wallet.id}/reconciliation`,
    );
    const reconciliationBody = reconciliation.body as ReconciliationView;
    expect(reconciliationBody.consistent).toBe(true);
    expect(reconciliationBody.storedBalance.amount).toBe('100.00');
  }, 20000);
});
