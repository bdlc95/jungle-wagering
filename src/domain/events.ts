import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { Wallet } from './wallet';

export interface EventContext {
  correlationId: string;
  causationId?: string;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: {
    aggregateId: string;
    context: EventContext;
    data: T;
    occurredAt?: Date;
  }) {
    this.eventId = crypto.randomUUID();
    this.aggregateId = props.aggregateId;
    this.correlationId = props.context.correlationId;
    this.causationId = props.context.causationId;
    this.occurredAt = props.occurredAt ?? new Date();
    this.data = props.data;
  }

  toJSON(): Record<string, unknown> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

export class WagerTransactionProcessed extends IntegrationEvent<{
  transactionId: string;
  status: 'PROCESSED';
}> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  static from(transactionId: string, walletId: string, context: EventContext) {
    return new WagerTransactionProcessed({
      aggregateId: walletId,
      context,
      data: { transactionId, status: 'PROCESSED' },
    });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<{
  transactionId: string;
  failureCode: string;
}> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  static from(
    transactionId: string,
    walletId: string,
    failureCode: string,
    context: EventContext,
  ) {
    return new WagerTransactionRejected({
      aggregateId: walletId,
      context,
      data: { transactionId, failureCode },
    });
  }
}

export class WagerTransactionFailed extends IntegrationEvent<{
  transactionId: string;
  failureCode: string;
}> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;
  static from(
    transactionId: string,
    walletId: string,
    failureCode: string,
    context: EventContext,
  ) {
    return new WagerTransactionFailed({
      aggregateId: walletId,
      context,
      data: { transactionId, failureCode },
    });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<{
  transactionId: string;
  referenceExternalTransactionId: string;
}> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  static from(
    transactionId: string,
    walletId: string,
    referenceExternalTransactionId: string,
    context: EventContext,
  ) {
    return new WagerTransactionPendingReference({
      aggregateId: walletId,
      context,
      data: { transactionId, referenceExternalTransactionId },
    });
  }
}

export class WalletBalanceChanged extends IntegrationEvent<{
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: ReturnType<WalletLedgerEntry['money']['toJSON']>;
  balanceBefore: ReturnType<WalletLedgerEntry['balanceBefore']['toJSON']>;
  balanceAfter: ReturnType<WalletLedgerEntry['balanceAfter']['toJSON']>;
  walletVersion: number;
}> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  static from(wallet: Wallet, entry: WalletLedgerEntry, context: EventContext) {
    return new WalletBalanceChanged({
      aggregateId: wallet.id,
      context,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
