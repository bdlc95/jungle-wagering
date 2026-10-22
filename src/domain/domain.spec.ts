import { describe, expect, it } from 'bun:test';
import { Money } from './money';
import { Wallet } from './wallet';
import { InboxMessage, OutboxMessage } from './messages';
import { IntegrationEvent } from './events';
import { createHash } from 'node:crypto';
import { LedgerDirection } from './ledger-entry';
import { hashWagerPayload, matchesWagerPayloadHash } from './payload-hash';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';

class TestEvent extends IntegrationEvent<{ ok: boolean }> {
  readonly eventType = 'TestEvent';
  readonly version = 1;
  static create() {
    return new TestEvent({
      aggregateId: crypto.randomUUID(),
      context: { correlationId: crypto.randomUUID() },
      data: { ok: true },
    });
  }
}

describe('financial domain', () => {
  it('uses exact decimal arithmetic and rejects unsafe input', () => {
    const sum = Money.from({ amount: '0.10', currency: 'BRL' }).add(
      Money.from({ amount: '0.20', currency: 'BRL' }),
    );
    expect(sum.toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
    for (const amount of [
      '1.999',
      'NaN',
      'Infinity',
      '1e3',
      '',
      '01.00',
      '1',
      '-1.00',
      '-0.00',
    ]) {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(
        'INVALID_MONEY',
      );
    }
    expect(() =>
      sum.add(Money.from({ amount: '1.00', currency: 'USD' })),
    ).toThrow('CURRENCY_MISMATCH');
  });

  it('keeps wallet nonnegative and creates a balanced immutable ledger entry', () => {
    const wallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId: crypto.randomUUID(),
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    const entry = wallet.debit(
      crypto.randomUUID(),
      Money.from({ amount: '80.00', currency: 'BRL' }),
    );
    expect(entry.isBalanced()).toBe(true);
    const timestamp = entry.createdAt.getTime();
    entry.createdAt.setTime(0);
    expect(entry.createdAt.getTime()).toBe(timestamp);
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(() =>
      wallet.debit(
        crypto.randomUUID(),
        Money.from({ amount: '80.00', currency: 'BRL' }),
      ),
    ).toThrow('INSUFFICIENT_FUNDS');
    expect(wallet.version).toBe(2);
  });

  it('keeps terminal transactions terminal', () => {
    const transaction = WagerTransaction.create({
      id: crypto.randomUUID(),
      providerId: 'provider',
      externalTransactionId: 'external',
      idempotencyKey: 'key',
      payloadHash: 'hash',
      walletId: crypto.randomUUID(),
      playerId: crypto.randomUUID(),
      roundId: 'round',
      gameId: 'game',
      kind: WagerTransactionKind.Loss,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      createdAt: new Date(),
    });
    transaction.markProcessed(undefined, new Date());
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(() => transaction.reject('INVALID_REFERENCE')).toThrow(
      'INVALID_TRANSACTION_STATE',
    );
  });

  it('tracks inbox processing and outbox retry timing', () => {
    const inbox = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wager-transactions',
      payloadHash: 'a'.repeat(64),
      receivedAt: new Date(0),
    });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(new Date(1000));
    expect(inbox.isProcessed()).toBe(true);
    expect(() => inbox.markProcessed(new Date(2000))).toThrow(
      'INBOX_ALREADY_PROCESSED',
    );

    const outbox = OutboxMessage.enqueue(TestEvent.create());
    expect(outbox.isDue(new Date())).toBe(true);
    outbox.scheduleRetry(new Date(0));
    expect(outbox.attempts).toBe(1);
    expect(outbox.isDue(new Date(1999))).toBe(false);
    expect(outbox.isDue(new Date(2000))).toBe(true);
    outbox.markPublished(new Date(3000));
    expect(outbox.isPending()).toBe(false);
  });

  it('defines the monetary effect of every wagering operation', () => {
    const props = {
      id: crypto.randomUUID(),
      providerId: 'provider',
      externalTransactionId: 'external',
      idempotencyKey: 'key',
      payloadHash: 'hash',
      walletId: crypto.randomUUID(),
      playerId: crypto.randomUUID(),
      roundId: 'round',
      gameId: 'game',
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      createdAt: new Date(),
    };
    const make = (kind: WagerTransactionKind) =>
      WagerTransaction.create({
        ...props,
        kind,
        referenceExternalTransactionId: [
          WagerTransactionKind.Refund,
          WagerTransactionKind.Rollback,
        ].includes(kind)
          ? 'original'
          : undefined,
      });
    const bet = make(WagerTransactionKind.Bet);
    const win = make(WagerTransactionKind.Win);
    const loss = make(WagerTransactionKind.Loss);
    const refund = make(WagerTransactionKind.Refund);
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(loss.affectsBalance()).toBe(false);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(make(WagerTransactionKind.Rollback).ledgerDirectionFor(bet)).toBe(
      LedgerDirection.Credit,
    );
    expect(make(WagerTransactionKind.Rollback).ledgerDirectionFor(win)).toBe(
      LedgerDirection.Debit,
    );
  });

  it('hashes canonical business data and detects a changed amount', () => {
    const input = {
      providerId: 'provider',
      externalTransactionId: 'external',
      playerId: crypto.randomUUID(),
      walletId: crypto.randomUUID(),
      roundId: 'round',
      gameId: 'game',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };
    const amount = Money.from(input.money);
    const reordered = Object.fromEntries(
      Object.entries(input).reverse(),
    ) as typeof input;
    expect(hashWagerPayload(input, amount)).toBe(
      hashWagerPayload(reordered, amount),
    );
    expect(hashWagerPayload(input, amount)).not.toBe(
      hashWagerPayload(input, Money.from({ amount: '11.00', currency: 'BRL' })),
    );
    const legacyHash = createHash('sha256')
      .update(
        JSON.stringify({
          ...input,
          referenceExternalTransactionId: null,
        }),
      )
      .digest('hex');
    expect(matchesWagerPayloadHash(legacyHash, input, amount)).toBe(true);
    expect(
      matchesWagerPayloadHash(
        legacyHash,
        input,
        Money.from({ amount: '11.00', currency: 'BRL' }),
      ),
    ).toBe(false);
  });
});
