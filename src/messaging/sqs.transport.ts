import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';

@Injectable()
export class SqsTransport implements OnApplicationShutdown {
  private readonly client = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
  private readonly transactionQueue =
    process.env.SQS_TRANSACTIONS_QUEUE_NAME ?? 'wager-transactions.fifo';
  private readonly dlq =
    process.env.SQS_TRANSACTIONS_DLQ_NAME ?? 'wager-transactions-dlq.fifo';
  private readonly eventsQueue =
    process.env.SQS_EVENTS_QUEUE_NAME ?? 'wager-events.fifo';
  private readonly batchSize = (() => {
    const configured = Number(process.env.SQS_BATCH_SIZE ?? '10');
    return Number.isInteger(configured) && configured >= 1 && configured <= 10
      ? configured
      : 10;
  })();
  private readonly urls = new Map<string, string>();

  async setupQueues(): Promise<void> {
    const dlqUrl = (
      await this.client.send(
        new CreateQueueCommand({
          QueueName: this.dlq,
          Attributes: { FifoQueue: 'true' },
        }),
      )
    ).QueueUrl!;
    const arn = (
      await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: dlqUrl,
          AttributeNames: ['QueueArn'],
        }),
      )
    ).Attributes?.QueueArn;
    if (!arn) throw new Error('DLQ_ARN_MISSING');
    const transactionsUrl = (
      await this.client.send(
        new CreateQueueCommand({
          QueueName: this.transactionQueue,
          Attributes: {
            FifoQueue: 'true',
            VisibilityTimeout: '30',
            RedrivePolicy: JSON.stringify({
              deadLetterTargetArn: arn,
              maxReceiveCount: 5,
            }),
          },
        }),
      )
    ).QueueUrl!;
    const eventsUrl = (
      await this.client.send(
        new CreateQueueCommand({
          QueueName: this.eventsQueue,
          Attributes: { FifoQueue: 'true' },
        }),
      )
    ).QueueUrl!;
    this.urls.set(this.transactionQueue, transactionsUrl);
    this.urls.set(this.dlq, dlqUrl);
    this.urls.set(this.eventsQueue, eventsUrl);
  }

  async ready(): Promise<boolean> {
    try {
      const urls = await Promise.all([
        this.queueUrl(this.transactionQueue),
        this.queueUrl(this.dlq),
        this.queueUrl(this.eventsQueue),
      ]);
      await Promise.all(
        urls.map((url) =>
          this.client.send(
            new GetQueueAttributesCommand({
              QueueUrl: url,
              AttributeNames: ['QueueArn'],
            }),
          ),
        ),
      );
      return true;
    } catch {
      return false;
    }
  }

  async dlqDepth(): Promise<number> {
    const dlq = await this.queueUrl(this.dlq);
    const attributes = (
      await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: dlq,
          AttributeNames: ['ApproximateNumberOfMessages'],
        }),
      )
    ).Attributes;
    return Number(attributes?.ApproximateNumberOfMessages ?? '0');
  }

  async receive(visibilityTimeout = 30): Promise<Message[]> {
    const transactions = await this.queueUrl(this.transactionQueue);
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: transactions,
        MaxNumberOfMessages: this.batchSize,
        WaitTimeSeconds: 5,
        VisibilityTimeout: visibilityTimeout,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    return response.Messages ?? [];
  }

  async ack(receiptHandle: string): Promise<void> {
    const transactions = await this.queueUrl(this.transactionQueue);
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: transactions,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  async retry(receiptHandle: string, attempts: number): Promise<void> {
    const transactions = await this.queueUrl(this.transactionQueue);
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: transactions,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: Math.min(2 ** attempts, 60),
      }),
    );
  }

  async release(receiptHandle: string): Promise<void> {
    const transactions = await this.queueUrl(this.transactionQueue);
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: transactions,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: 0,
      }),
    );
  }

  async deadLetter(message: Message, reason: string): Promise<void> {
    const dlq = await this.queueUrl(this.dlq);
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: dlq,
        MessageBody: JSON.stringify({
          reason,
          originalMessageId: message.MessageId,
          body: message.Body,
        }),
        MessageGroupId: 'invalid-wager',
        MessageDeduplicationId: message.MessageId ?? crypto.randomUUID(),
      }),
    );
    if (message.ReceiptHandle) await this.ack(message.ReceiptHandle);
  }

  async publishEvent(
    id: string,
    aggregateId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const events = await this.queueUrl(this.eventsQueue);
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: events,
        MessageBody: JSON.stringify(payload),
        MessageGroupId: aggregateId,
        MessageDeduplicationId: id,
      }),
    );
  }

  async sendTransaction(
    body: Record<string, unknown>,
    walletId: string,
    messageId: string,
  ): Promise<void> {
    const transactions = await this.queueUrl(this.transactionQueue);
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: transactions,
        MessageBody: JSON.stringify(body),
        MessageGroupId: walletId,
        MessageDeduplicationId: messageId,
      }),
    );
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }

  private async queueUrl(name: string): Promise<string> {
    const cached = this.urls.get(name);
    if (cached) return cached;
    const url = (
      await this.client.send(new GetQueueUrlCommand({ QueueName: name }))
    ).QueueUrl;
    if (!url) throw new Error(`QUEUE_NOT_FOUND:${name}`);
    this.urls.set(name, url);
    return url;
  }
}
