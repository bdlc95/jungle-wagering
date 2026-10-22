import { LedgerDirection } from './ledger-entry';
import { Money } from './money';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export type FailureCode =
  | 'INSUFFICIENT_FUNDS'
  | 'REVERSAL_INSUFFICIENT_FUNDS'
  | 'REFERENCE_NOT_FOUND'
  | 'INVALID_REFERENCE'
  | 'REFERENCE_NOT_PROCESSED'
  | 'ALREADY_REVERSED'
  | 'CURRENCY_MISMATCH'
  | 'WALLET_MISMATCH'
  | 'INFRASTRUCTURE_FAILURE';

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(private readonly state: WagerTransactionState) {}

  static create(
    props: Omit<
      WagerTransactionState,
      'status' | 'referenceTransactionId' | 'failureCode' | 'processedAt'
    >,
  ): WagerTransaction {
    if (!props.money.isPositive()) throw new Error('INVALID_MOVEMENT_AMOUNT');
    if (props.kind === WagerTransactionKind.Opening)
      throw new Error('OPENING_INTERNAL_ONLY');
    if (
      (props.kind === WagerTransactionKind.Refund ||
        props.kind === WagerTransactionKind.Rollback) &&
      !props.referenceExternalTransactionId
    ) {
      throw new Error('REFERENCE_REQUIRED');
    }
    return new WagerTransaction({
      ...props,
      status: WagerTransactionStatus.Pending,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get id(): string {
    return this.state.id;
  }
  get status(): WagerTransactionStatus {
    return this.state.status;
  }
  get failureCode(): FailureCode | undefined {
    return this.state.failureCode;
  }
  get referenceTransactionId(): string | undefined {
    return this.state.referenceTransactionId;
  }
  get processedAt(): Date | undefined {
    return this.state.processedAt;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertOpen();
    this.state.status = WagerTransactionStatus.Processed;
    this.state.referenceTransactionId = referenceTransactionId;
    this.state.processedAt = at;
  }

  markPendingReference(): void {
    this.assertOpen();
    this.state.status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertOpen();
    this.state.status = WagerTransactionStatus.Rejected;
    this.state.failureCode = code;
    this.state.processedAt = new Date();
  }

  fail(code: FailureCode): void {
    this.assertOpen();
    this.state.status = WagerTransactionStatus.Failed;
    this.state.failureCode = code;
    this.state.processedAt = new Date();
  }

  isTerminal(): boolean {
    return [
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
    ].includes(this.status);
  }

  affectsBalance(): boolean {
    return this.state.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.state.kind === WagerTransactionKind.Refund ||
      this.state.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(hash: string): boolean {
    return this.state.payloadHash === hash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.state.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) throw new Error('REFERENCE_REQUIRED');
        return reference.state.kind === WagerTransactionKind.Bet
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      default:
        throw new Error('NO_LEDGER_DIRECTION');
    }
  }

  private assertOpen(): void {
    if (this.isTerminal()) throw new Error('INVALID_TRANSACTION_STATE');
  }
}
