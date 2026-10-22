import { IntegrationEvent } from './events';

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: Omit<InboxMessageState, 'processedAt'>): InboxMessage {
    if (
      !props.messageId ||
      props.messageId.length > 255 ||
      !props.consumerName ||
      props.consumerName.length > 255 ||
      !/^[a-f0-9]{64}$/.test(props.payloadHash)
    ) {
      throw new Error('INVALID_INBOX_MESSAGE');
    }
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) throw new Error('INBOX_ALREADY_PROCESSED');
    this._processedAt = at;
  }
}

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON(),
      event.occurredAt,
      0,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }
  isDue(now: Date): boolean {
    return (
      this.isPending() && (!this._nextAttemptAt || this._nextAttemptAt <= now)
    );
  }

  markPublished(at: Date): void {
    if (!this.isPending()) throw new Error('OUTBOX_ALREADY_PUBLISHED');
    this._publishedAt = at;
  }

  scheduleRetry(now: Date): void {
    if (!this.isPending()) throw new Error('OUTBOX_ALREADY_PUBLISHED');
    this._attempts += 1;
    this._nextAttemptAt = new Date(
      now.getTime() + Math.min(2 ** this._attempts * 1000, 60_000),
    );
  }
}
