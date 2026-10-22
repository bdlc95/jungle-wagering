import {
  BadRequestException,
  ConflictException,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import type { Message } from '@aws-sdk/client-sqs';
import { OutboxRecord, WagerRecord } from '../persistence/entities';
import { WageringService, type WagerInput } from '../wagering/wagering.service';
import { SqsTransport } from './sqs.transport';
import { MetricsService } from '../observability/metrics.service';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import { OutboxMessage } from '../domain/messages';

interface RequestedMessage {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: WagerInput & { idempotencyKey: string };
}

@Injectable()
export class WorkersService implements OnModuleInit, OnModuleDestroy {
  private stopping = false;
  private tasks: Promise<void>[] = [];

  constructor(
    private readonly em: EntityManager,
    private readonly wagering: WageringService,
    private readonly sqs: SqsTransport,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (process.env.WORKERS_ENABLED === 'false') return;
    this.tasks = [
      this.loop('sqs-consumer', () => this.consume()),
      this.loop('outbox-publisher', () => this.publishOutbox()),
      this.loop('pending-reference', () => this.retryReferences()),
    ];
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled(this.tasks);
  }

  private async loop(name: string, work: () => Promise<void>): Promise<void> {
    while (!this.stopping) {
      try {
        await work();
      } catch (error) {
        this.log('worker_error', {
          worker: name,
          error: error instanceof Error ? error.name : 'Unknown',
        });
        await this.pause(1000);
      }
    }
  }

  private async consume(): Promise<void> {
    const messages = await this.sqs.receive();
    for (const message of messages) {
      if (this.stopping) {
        if (message.ReceiptHandle)
          await this.sqs.release(message.ReceiptHandle);
        continue;
      }
      await this.consumeOne(message);
    }
  }

  private async consumeOne(message: Message): Promise<void> {
    if (!message.ReceiptHandle) return;
    const receiveCount = Number(
      message.Attributes?.ApproximateReceiveCount ?? 1,
    );
    let envelope: RequestedMessage;
    try {
      envelope = JSON.parse(message.Body ?? '') as RequestedMessage;
      if (
        envelope.type !== 'WagerTransactionRequested' ||
        typeof envelope.messageId !== 'string' ||
        envelope.messageId.length === 0 ||
        envelope.messageId.length > 255 ||
        typeof envelope.occurredAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
          envelope.occurredAt,
        ) ||
        Number.isNaN(Date.parse(envelope.occurredAt)) ||
        !envelope.data ||
        typeof envelope.data.idempotencyKey !== 'string'
      )
        throw new Error('INVALID_ENVELOPE');
    } catch {
      await this.sqs.deadLetter(message, 'INVALID_ENVELOPE');
      this.metrics.increment('dlq');
      this.log('message_dlq', {
        messageId: message.MessageId,
        reason: 'INVALID_ENVELOPE',
      });
      return;
    }
    try {
      const result = await this.wagering.process(
        envelope.data,
        envelope.data.idempotencyKey,
        {
          messageId: envelope.messageId,
          consumerName: 'wager-transactions',
        },
      );
      // The financial transaction and inbox are committed before this ack.
      await this.sqs.ack(message.ReceiptHandle);
      this.log('message_processed', {
        messageId: envelope.messageId,
        transactionId: result.transactionId,
        walletId: envelope.data.walletId,
        providerId: envelope.data.providerId,
        status: result.status,
      });
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException
      ) {
        await this.sqs.deadLetter(message, error.message);
        this.metrics.increment('dlq');
        this.log('message_dlq', {
          messageId: envelope.messageId,
          reason: error.message,
        });
        return;
      }
      if (receiveCount >= 5) {
        try {
          const result = await this.wagering.recordPermanentFailure(
            envelope.data,
            envelope.data.idempotencyKey,
            {
              messageId: envelope.messageId,
              consumerName: 'wager-transactions',
            },
          );
          await this.sqs.ack(message.ReceiptHandle);
          this.log('message_failed', {
            messageId: envelope.messageId,
            transactionId: result.transactionId,
            walletId: envelope.data.walletId,
            providerId: envelope.data.providerId,
            status: result.status,
          });
          return;
        } catch (auditError) {
          this.log('failure_audit_retry', {
            messageId: envelope.messageId,
            error: auditError instanceof Error ? auditError.name : 'Unknown',
          });
        }
      }
      this.log('message_retry', {
        messageId: envelope.messageId,
        attempts: receiveCount,
        error: error instanceof Error ? error.name : 'Unknown',
      });
      this.metrics.increment('retry');
      await this.sqs.retry(message.ReceiptHandle, receiveCount);
    }
  }

  private async publishOutbox(): Promise<void> {
    const count = await this.em.fork().transactional(async (tx) => {
      const due = await tx.find(
        OutboxRecord,
        {
          publishedAt: null,
          $or: [
            { nextAttemptAt: null },
            { nextAttemptAt: { $lte: new Date() } },
          ],
        },
        {
          lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
          orderBy: { occurredAt: 'ASC' },
          limit: 10,
        },
      );
      for (const row of due) {
        const message = OutboxMessage.rehydrate({
          id: row.id,
          aggregateId: row.aggregateId,
          eventType: row.eventType,
          payload: row.payload,
          occurredAt: row.occurredAt,
          attempts: row.attempts,
          nextAttemptAt: row.nextAttemptAt ?? undefined,
          publishedAt: row.publishedAt ?? undefined,
        });
        try {
          await this.sqs.publishEvent(
            message.id,
            message.aggregateId,
            message.payload,
          );
          message.markPublished(new Date());
          row.publishedAt = message.publishedAt;
        } catch (error) {
          message.scheduleRetry(new Date());
          row.attempts = message.attempts;
          this.metrics.increment('retry');
          row.nextAttemptAt = message.nextAttemptAt;
          this.log('outbox_retry', {
            eventId: row.id,
            eventType: row.eventType,
            attempts: row.attempts,
            error: error instanceof Error ? error.name : 'Unknown',
          });
        }
      }
      return due.length;
    });
    if (count === 0) await this.pause(500);
  }

  private async retryReferences(): Promise<void> {
    const due = await this.em.fork().find(
      WagerRecord,
      {
        status: WagerTransactionStatus.PendingReference,
        nextReferenceAttemptAt: { $lte: new Date() },
      },
      { fields: ['id'], limit: 20 },
    );
    for (const row of due) {
      if (this.stopping) return;
      await this.wagering.retryPending(row.id);
    }
    await this.pause(1000);
  }

  private async pause(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private log(event: string, data: Record<string, unknown>): void {
    process.stdout.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        event,
        correlationId: null,
        messageId: null,
        transactionId: null,
        walletId: null,
        providerId: null,
        ...data,
      })}\n`,
    );
  }
}
