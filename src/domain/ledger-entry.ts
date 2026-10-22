import { Money } from './money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private readonly createdAtTimestamp: number;

  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    createdAt: Date,
  ) {
    this.createdAtTimestamp = createdAt.getTime();
  }

  get createdAt(): Date {
    return new Date(this.createdAtTimestamp);
  }

  static create(state: LedgerEntryState): WalletLedgerEntry {
    if (!state.money.isPositive()) throw new Error('INVALID_LEDGER_AMOUNT');
    const entry = WalletLedgerEntry.rehydrate(state);
    if (!entry.isBalanced()) throw new Error('UNBALANCED_LEDGER_ENTRY');
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    const calculated =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return calculated.equals(this.balanceAfter);
  }
}
