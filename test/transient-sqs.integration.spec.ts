import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { SqsTransport } from '../src/messaging/sqs.transport';
import { OutboxRecord } from '../src/persistence/entities';
import request from 'supertest';

describe('temporary event queue unavailability', () => {
  let app: INestApplication<App>;
  let em: EntityManager;
  let sqs: SqsTransport;

  beforeAll(async () => {
    const suffix = crypto.randomUUID();
    process.env.SQS_TRANSACTIONS_QUEUE_NAME = `temporary-input-${suffix}.fifo`;
    process.env.SQS_TRANSACTIONS_DLQ_NAME = `temporary-dlq-${suffix}.fifo`;
    process.env.SQS_EVENTS_QUEUE_NAME = `temporary-events-${suffix}.fifo`;
    process.env.WORKERS_ENABLED = 'true';
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    em = module.get(EntityManager);
    sqs = module.get(SqsTransport);
  });

  afterAll(async () => {
    await app.close();
  }, 15000);

  it('keeps a committed event and publishes it after the queue is available', async () => {
    expect(await sqs.ready()).toBe(false);
    expect(
      (await request(app.getHttpServer()).get('/health/ready')).status,
    ).toBe(503);
    const id = crypto.randomUUID();
    await em.fork().persistAndFlush(
      Object.assign(new OutboxRecord(), {
        id,
        aggregateId: crypto.randomUUID(),
        eventType: 'TestEvent',
        payload: { eventId: id, eventType: 'TestEvent', version: 1 },
        occurredAt: new Date(0),
        attempts: 0,
      }),
    );
    const untilRetry = Date.now() + 8000;
    let row = await em.fork().findOneOrFail(OutboxRecord, { id });
    while (row.attempts === 0 && Date.now() < untilRetry) {
      await Bun.sleep(100);
      row = await em.fork().findOneOrFail(OutboxRecord, { id });
    }
    expect(row.attempts).toBeGreaterThan(0);
    expect(row.publishedAt).toBeFalsy();

    await sqs.setupQueues();
    expect(await sqs.ready()).toBe(true);
    expect(
      (await request(app.getHttpServer()).get('/health/ready')).status,
    ).toBe(200);
    const untilPublished = Date.now() + 12000;
    while (!row.publishedAt && Date.now() < untilPublished) {
      await Bun.sleep(100);
      row = await em.fork().findOneOrFail(OutboxRecord, { id });
    }
    expect(row.publishedAt).toBeTruthy();
  }, 20000);
});
