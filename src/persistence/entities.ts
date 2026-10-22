import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { LedgerDirection } from '../domain/ledger-entry';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction';

@Entity({ tableName: 'wallets' })
@Unique({ properties: ['playerId', 'currency'] })
export class WalletRecord {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property() playerId!: string;
  @Property({ length: 3 }) currency!: string;
  @Property({ type: 'decimal', columnType: 'numeric(20,2)' }) balance!: string;
  @Property() version!: number;
  @Property({ columnType: 'timestamptz' }) createdAt!: Date;
  @Property({ columnType: 'timestamptz' }) updatedAt!: Date;
}

@Entity({ tableName: 'wager_transactions' })
@Unique({ properties: ['providerId', 'externalTransactionId'] })
export class WagerRecord {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property() providerId!: string;
  @Property() externalTransactionId!: string;
  @Property({ unique: true }) idempotencyKey!: string;
  @Property({ length: 64 }) payloadHash!: string;
  @Property({ type: 'uuid' }) walletId!: string;
  @Property() playerId!: string;
  @Property() roundId!: string;
  @Property() gameId!: string;
  @Property({ type: 'string' }) kind!: WagerTransactionKind;
  @Property({ type: 'decimal', columnType: 'numeric(20,2)' }) amount!: string;
  @Property({ length: 3 }) currency!: string;
  @Property({ nullable: true }) referenceExternalTransactionId?: string;
  @Property({ type: 'uuid', nullable: true }) referenceTransactionId?: string;
  @Property({ type: 'string' }) status!: WagerTransactionStatus;
  @Property({ nullable: true }) failureCode?: string;
  @Property({ type: 'decimal', columnType: 'numeric(20,2)', nullable: true })
  resultBalance?: string;
  @Property({ columnType: 'timestamptz' }) createdAt!: Date;
  @Property({ columnType: 'timestamptz', nullable: true }) processedAt?: Date;
  @Property({ default: 0 }) referenceAttempts = 0;
  @Property({ columnType: 'timestamptz', nullable: true })
  nextReferenceAttemptAt?: Date;
}

@Entity({ tableName: 'wallet_ledger' })
@Unique({ properties: ['walletId', 'transactionId'] })
export class LedgerRecord {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property({ type: 'uuid' }) walletId!: string;
  @Property({ type: 'uuid' }) transactionId!: string;
  @Property({ type: 'string' }) direction!: LedgerDirection;
  @Property({ type: 'decimal', columnType: 'numeric(20,2)' }) amount!: string;
  @Property({ length: 3 }) currency!: string;
  @Property({ type: 'decimal', columnType: 'numeric(20,2)' })
  balanceBefore!: string;
  @Property({ type: 'decimal', columnType: 'numeric(20,2)' })
  balanceAfter!: string;
  @Property({ columnType: 'timestamptz' }) createdAt!: Date;
}

@Entity({ tableName: 'inbox_messages' })
@Unique({ properties: ['consumerName', 'messageId'] })
export class InboxRecord {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property() consumerName!: string;
  @Property() messageId!: string;
  @Property({ length: 64 }) payloadHash!: string;
  @Property({ columnType: 'timestamptz' }) receivedAt!: Date;
  @Property({ columnType: 'timestamptz', nullable: true }) processedAt?: Date;
}

@Entity({ tableName: 'outbox_messages' })
export class OutboxRecord {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property({ type: 'uuid' }) aggregateId!: string;
  @Property() eventType!: string;
  @Property({ type: 'json' }) payload!: Record<string, unknown>;
  @Property({ columnType: 'timestamptz' }) occurredAt!: Date;
  @Property({ default: 0 }) attempts = 0;
  @Property({ columnType: 'timestamptz', nullable: true }) nextAttemptAt?: Date;
  @Property({ columnType: 'timestamptz', nullable: true }) publishedAt?: Date;
}
