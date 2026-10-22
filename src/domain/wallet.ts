import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    at?: Date;
  }): Wallet {
    if (props.initialBalance.isNegative()) throw new Error('NEGATIVE_BALANCE');
    const at = props.at ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      at,
      at,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(
    transactionId: string,
    money: Money,
    at = new Date(),
  ): WalletLedgerEntry {
    this.assertMovement(money);
    if (this._balance.isLessThan(money)) throw new Error('INSUFFICIENT_FUNDS');
    return this.apply(transactionId, money, LedgerDirection.Debit, at);
  }

  credit(
    transactionId: string,
    money: Money,
    at = new Date(),
  ): WalletLedgerEntry {
    this.assertMovement(money);
    return this.apply(transactionId, money, LedgerDirection.Credit, at);
  }

  private assertMovement(money: Money): void {
    if (money.currency !== this.currency) throw new Error('CURRENCY_MISMATCH');
    if (!money.isPositive()) throw new Error('INVALID_MOVEMENT_AMOUNT');
  }

  private apply(
    transactionId: string,
    money: Money,
    direction: LedgerDirection,
    at: Date,
  ): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? balanceBefore.add(money)
        : balanceBefore.subtract(money);
    const entry = WalletLedgerEntry.create({
      id: crypto.randomUUID(),
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      createdAt: at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;
    return entry;
  }
}
