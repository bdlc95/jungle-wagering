import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import {
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { SqsTransport } from '../src/messaging/sqs.transport';

describe('permanent SQS failure', () => {
  let app: INestApplication<App>;
  let sqs: SqsTransport;
  let client: SQSClient;
  let dlqName: string;

  beforeAll(async () => {
    const suffix = crypto.randomUUID();
    process.env.SQS_TRANSACTIONS_QUEUE_NAME = `invalid-input-${suffix}.fifo`;
    dlqName = `invalid-dlq-${suffix}.fifo`;
    process.env.SQS_TRANSACTIONS_DLQ_NAME = dlqName;
    process.env.SQS_EVENTS_QUEUE_NAME = `invalid-events-${suffix}.fifo`;
    process.env.WORKERS_ENABLED = 'true';
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    sqs = module.get(SqsTransport);
    await sqs.setupQueues();
    client = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
  }, 15000);

  afterAll(async () => {
    client.destroy();
    await app.close();
  }, 15000);

  it('routes a malformed envelope to the DLQ', async () => {
    await sqs.sendTransaction(
      { type: 'invalid', messageId: crypto.randomUUID() },
      'invalid-group',
      crypto.randomUUID(),
    );
    const url = (
      await client.send(new GetQueueUrlCommand({ QueueName: dlqName }))
    ).QueueUrl!;
    const until = Date.now() + 10000;
    let body: { reason?: string } | undefined;
    while (Date.now() < until) {
      const result = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: url,
          WaitTimeSeconds: 1,
          MaxNumberOfMessages: 1,
        }),
      );
      if (result.Messages?.[0]?.Body) {
        body = JSON.parse(result.Messages[0].Body) as { reason?: string };
        break;
      }
    }
    expect(body?.reason).toBe('INVALID_ENVELOPE');
  }, 15000);
});
