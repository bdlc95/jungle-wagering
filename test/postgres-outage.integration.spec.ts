import { describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { SqsTransport } from '../src/messaging/sqs.transport';
import { MetricsService } from '../src/observability/metrics.service';
import { ormConfig } from '../src/persistence/orm.config';

describe('temporary PostgreSQL unavailability', () => {
  it('retries a queued bet and keeps the ledger consistent after recovery', async () => {
    const stage = (value: string) =>
      process.stdout.write(`[postgres-outage] ${value}\n`);
    const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
    const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
    if (!/^[a-z0-9_]+_test$/.test(databaseName)) {
      throw new Error('OUTAGE_TEST_REQUIRES_AN_ISOLATED_TEST_DATABASE');
    }
    const suffix = crypto.randomUUID();
    process.env.SQS_TRANSACTIONS_QUEUE_NAME = `pg-outage-input-${suffix}.fifo`;
    process.env.SQS_TRANSACTIONS_DLQ_NAME = `pg-outage-dlq-${suffix}.fifo`;
    process.env.SQS_EVENTS_QUEUE_NAME = `pg-outage-events-${suffix}.fifo`;
    process.env.WORKERS_ENABLED = 'true';
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = module.createNestApplication<INestApplication<App>>();
    const sqs = module.get(SqsTransport);
    await sqs.setupQueues();
    await app.init();
    const metrics = module.get(MetricsService);
    const adminUrl = new URL(databaseUrl);
    adminUrl.pathname = '/postgres';
    const admin = await MikroORM.init({
      ...ormConfig,
      clientUrl: adminUrl.toString(),
    });
    stage('initialized');
    let connectionsBlocked = false;
    try {
      const playerId = crypto.randomUUID();
      const opened = await request(app.getHttpServer())
        .post('/wallets')
        .send({
          playerId,
          initialBalance: { amount: '100.00', currency: 'BRL' },
        });
      expect(opened.status).toBe(201);
      stage('wallet opened');
      const wallet = opened.body as { id: string };
      const externalId = crypto.randomUUID();

      await admin.em.execute(
        `alter database "${databaseName}" with allow_connections false`,
      );
      connectionsBlocked = true;
      stage('connections blocked');
      await admin.em.execute(
        'select pg_terminate_backend(pid) from pg_stat_activity where datname = ?',
        [databaseName],
      );
      stage('backends terminated');
      const unavailable = await request(app.getHttpServer()).get(
        '/health/ready',
      );
      stage('readiness checked');
      expect(unavailable.status).toBe(503);
      const unavailablePost = await request(app.getHttpServer())
        .post('/wagering/transactions')
        .set('Idempotency-Key', `pg-outage:${externalId}`)
        .send({
          providerId: 'pg-outage',
          externalTransactionId: externalId,
          playerId,
          walletId: wallet.id,
          roundId: 'round-outage',
          gameId: 'game-outage',
          kind: 'BET',
          money: { amount: '25.00', currency: 'BRL' },
        });
      expect(unavailablePost.status).toBe(503);
      await sqs.sendTransaction(
        {
          messageId: crypto.randomUUID(),
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            providerId: 'pg-outage',
            externalTransactionId: externalId,
            idempotencyKey: `pg-outage:${externalId}`,
            playerId,
            walletId: wallet.id,
            roundId: 'round-outage',
            gameId: 'game-outage',
            kind: 'BET',
            money: { amount: '25.00', currency: 'BRL' },
          },
        },
        wallet.id,
        crypto.randomUUID(),
      );
      stage('transaction queued');
      const retryDeadline = Date.now() + 8000;
      while (
        !metrics.render(0).includes('wagering_retries_total 1') &&
        Date.now() < retryDeadline
      ) {
        await Bun.sleep(100);
      }
      expect(metrics.render(0)).toContain('wagering_retries_total 1');
      stage('retry observed');

      await admin.em.execute(
        `alter database "${databaseName}" with allow_connections true`,
      );
      connectionsBlocked = false;
      stage('connections restored');
      const deadline = Date.now() + 15000;
      let processed = false;
      while (!processed && Date.now() < deadline) {
        const response = await request(app.getHttpServer()).get(
          `/providers/pg-outage/wagering/transactions/${externalId}`,
        );
        processed =
          response.status === 200 &&
          (response.body as { status?: string }).status === 'PROCESSED';
        if (!processed) await Bun.sleep(100);
      }
      expect(processed).toBe(true);
      stage('transaction processed');
      const reconciliation = await request(app.getHttpServer()).post(
        `/wallets/${wallet.id}/reconciliation`,
      );
      const result = reconciliation.body as {
        consistent: boolean;
        storedBalance: { amount: string };
        checkedEntries: number;
      };
      expect(result.consistent).toBe(true);
      expect(result.storedBalance.amount).toBe('75.00');
      expect(result.checkedEntries).toBe(2); // OPENING and the single BET
    } finally {
      stage('cleanup started');
      if (connectionsBlocked) {
        await admin.em.execute(
          `alter database "${databaseName}" with allow_connections true`,
        );
      }
      await admin.close(true);
      await app.close();
      stage('cleanup done');
    }
  }, 30000);
});
