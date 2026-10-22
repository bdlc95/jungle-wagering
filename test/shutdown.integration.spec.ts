import { describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import { AppModule } from '../src/app.module';
import { SqsTransport } from '../src/messaging/sqs.transport';
import {
  InboxRecord,
  LedgerRecord,
  WagerRecord,
} from '../src/persistence/entities';
import { ormConfig } from '../src/persistence/orm.config';
import { WageringService } from '../src/wagering/wagering.service';
import { LedgerDirection } from '../src/domain/ledger-entry';
import { WagerTransactionStatus } from '../src/domain/wager-transaction';

describe('graceful worker shutdown', () => {
  it('waits for a committed message to be acknowledged', async () => {
    const suffix = crypto.randomUUID();
    process.env.SQS_TRANSACTIONS_QUEUE_NAME = `shutdown-input-${suffix}.fifo`;
    process.env.SQS_TRANSACTIONS_DLQ_NAME = `shutdown-dlq-${suffix}.fifo`;
    process.env.SQS_EVENTS_QUEUE_NAME = `shutdown-events-${suffix}.fifo`;
    process.env.WORKERS_ENABLED = 'true';
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = module.createNestApplication();
    const sqs = module.get(SqsTransport);
    await sqs.setupQueues();
    await app.init();

    let release!: () => void;
    let markCommitted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const committed = new Promise<void>((resolve) => {
      markCommitted = resolve;
    });
    let closePromise: Promise<void> | undefined;
    const wagering = module.get(WageringService);
    const originalProcess = wagering.process.bind(wagering);
    wagering.process = async (
      ...args: Parameters<WageringService['process']>
    ) => {
      const result = await originalProcess(...args);
      markCommitted();
      await gate;
      return result;
    };
    const wallet = await wagering.openWallet(crypto.randomUUID(), {
      amount: '100.00',
      currency: 'BRL',
    });
    const externalId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    try {
      await sqs.sendTransaction(
        {
          messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            providerId: 'shutdown',
            externalTransactionId: externalId,
            idempotencyKey: `shutdown:${externalId}`,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: 'round-shutdown',
            gameId: 'game-shutdown',
            kind: 'BET',
            money: { amount: '25.00', currency: 'BRL' },
          },
        },
        wallet.id,
        crypto.randomUUID(),
      );
      await Promise.race([
        committed,
        Bun.sleep(10000).then(() => {
          throw new Error('MESSAGE_NOT_COMMITTED');
        }),
      ]);
      let closed = false;
      closePromise = app.close().then(() => {
        closed = true;
      });
      await Bun.sleep(100);
      expect(closed).toBe(false);
    } finally {
      release();
      await (closePromise ?? app.close());
    }

    const orm = await MikroORM.init(ormConfig);
    try {
      const inbox = await orm.em.fork().find(InboxRecord, { messageId });
      const wager = await orm.em.fork().findOneOrFail(WagerRecord, {
        providerId: 'shutdown',
        externalTransactionId: externalId,
      });
      const debit = await orm.em.fork().find(LedgerRecord, {
        walletId: wallet.id,
        direction: LedgerDirection.Debit,
      });
      expect(inbox).toHaveLength(1);
      expect(wager.status).toBe(WagerTransactionStatus.Processed);
      expect(debit).toHaveLength(1);
    } finally {
      await orm.close(true);
    }
    const inspect = new SqsTransport();
    try {
      expect(await inspect.receive(1)).toHaveLength(0);
    } finally {
      inspect.onApplicationShutdown();
    }
  }, 20000);
});
