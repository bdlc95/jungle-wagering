import { describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { SqsTransport } from '../src/messaging/sqs.transport';
import { WageringService } from '../src/wagering/wagering.service';

describe('two SQS workers on the same wallet', () => {
  it('allows one of two competing bets and keeps one debit', async () => {
    const suffix = crypto.randomUUID();
    process.env.SQS_TRANSACTIONS_QUEUE_NAME = `workers-input-${suffix}.fifo`;
    process.env.SQS_TRANSACTIONS_DLQ_NAME = `workers-dlq-${suffix}.fifo`;
    process.env.SQS_EVENTS_QUEUE_NAME = `workers-events-${suffix}.fifo`;
    process.env.SQS_BATCH_SIZE = '1';
    process.env.WORKERS_ENABLED = 'true';
    const [firstModule, secondModule] = await Promise.all([
      Test.createTestingModule({ imports: [AppModule] }).compile(),
      Test.createTestingModule({ imports: [AppModule] }).compile(),
    ]);
    const firstApp = firstModule.createNestApplication<INestApplication<App>>();
    const secondApp =
      secondModule.createNestApplication<INestApplication<App>>();
    const sqs = firstModule.get(SqsTransport);
    await sqs.setupQueues();
    const first = firstModule.get(WageringService);
    const second = secondModule.get(WageringService);
    let release!: () => void;
    let markBoth!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bothStarted = new Promise<void>((resolve) => {
      markBoth = resolve;
    });
    const started = [false, false];
    const wrap = (service: WageringService, index: number) => {
      const original = service.process.bind(service);
      service.process = async (
        ...args: Parameters<WageringService['process']>
      ) => {
        started[index] = true;
        if (started.every(Boolean)) markBoth();
        await gate;
        return original(...args);
      };
    };
    wrap(first, 0);
    wrap(second, 1);
    await Promise.all([firstApp.init(), secondApp.init()]);
    try {
      const wallet = await first.openWallet(crypto.randomUUID(), {
        amount: '100.00',
        currency: 'BRL',
      });
      const externalIds = [crypto.randomUUID(), crypto.randomUUID()];
      for (const externalId of externalIds) {
        await sqs.sendTransaction(
          {
            messageId: crypto.randomUUID(),
            type: 'WagerTransactionRequested',
            occurredAt: new Date().toISOString(),
            data: {
              providerId: 'multi-worker',
              externalTransactionId: externalId,
              idempotencyKey: `multi-worker:${externalId}`,
              playerId: wallet.playerId,
              walletId: wallet.id,
              roundId: 'round',
              gameId: 'game',
              kind: 'BET',
              money: { amount: '80.00', currency: 'BRL' },
            },
          },
          crypto.randomUUID(),
          crypto.randomUUID(),
        );
      }
      await Promise.race([
        bothStarted,
        Bun.sleep(10000).then(() => {
          throw new Error('BOTH_WORKERS_DID_NOT_RECEIVE');
        }),
      ]);
      expect(started).toEqual([true, true]);
      release();
      const deadline = Date.now() + 10000;
      let statuses: string[] = [];
      while (Date.now() < deadline) {
        const results = await Promise.all(
          externalIds.map((id) =>
            request(firstApp.getHttpServer()).get(
              `/providers/multi-worker/wagering/transactions/${id}`,
            ),
          ),
        );
        statuses = results.map((result) =>
          result.status === 200
            ? (result.body as { status: string }).status
            : 'MISSING',
        );
        if (statuses.every((status) => status !== 'MISSING')) break;
        await Bun.sleep(100);
      }
      expect(statuses.sort()).toEqual(['PROCESSED', 'REJECTED']);
      const ledger = await request(firstApp.getHttpServer()).get(
        `/wallets/${wallet.id}/ledger`,
      );
      const debits = (
        ledger.body as { items: { direction: string }[] }
      ).items.filter((item) => item.direction === 'DEBIT');
      expect(debits).toHaveLength(1);
      const reconciliation = await request(firstApp.getHttpServer()).post(
        `/wallets/${wallet.id}/reconciliation`,
      );
      const result = reconciliation.body as {
        consistent: boolean;
        storedBalance: { amount: string };
      };
      expect(result.consistent).toBe(true);
      expect(result.storedBalance.amount).toBe('20.00');
    } finally {
      release();
      await Promise.all([firstApp.close(), secondApp.close()]);
    }
  }, 25000);
});
