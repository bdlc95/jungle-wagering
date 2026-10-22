import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  WalletBalanceChanged,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionFailed,
  type EventContext,
  type IntegrationEvent,
} from '../domain/events';
import { LedgerDirection, WalletLedgerEntry } from '../domain/ledger-entry';
import { Money, type MoneyProps } from '../domain/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type FailureCode,
} from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import {
  InboxRecord,
  LedgerRecord,
  OutboxRecord,
  WagerRecord,
  WalletRecord,
} from '../persistence/entities';
import { MetricsService } from '../observability/metrics.service';
import { InboxMessage, OutboxMessage } from '../domain/messages';
import {
  hashWagerPayload,
  matchesWagerPayloadHash,
} from '../domain/payload-hash';

export interface WagerInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface WagerResult {
  transactionId: string;
  status: string;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: string;
}

@Injectable()
export class WageringService {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsService,
  ) {}

  async openWallet(playerId: string, initialBalance: MoneyProps) {
    if (!this.validUuid(playerId))
      throw new BadRequestException('INVALID_PLAYER_ID');
    const money = this.parseMoney(initialBalance);
    if (money.currency !== 'BRL')
      throw new BadRequestException('UNSUPPORTED_CURRENCY');
    if (money.isNegative()) throw new BadRequestException('NEGATIVE_BALANCE');
    const wallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId,
      initialBalance: money,
    });

    try {
      await this.em.fork().transactional(async (tx) => {
        const row = Object.assign(new WalletRecord(), {
          id: wallet.id,
          playerId,
          currency: wallet.currency,
          balance: wallet.balance.toJSON().amount,
          version: wallet.version,
          createdAt: wallet.createdAt,
          updatedAt: wallet.updatedAt,
        });
        tx.persist(row);
        await tx.flush();
        if (money.isPositive()) {
          const transactionId = crypto.randomUUID();
          tx.persist(
            Object.assign(new WagerRecord(), {
              id: transactionId,
              providerId: '__internal__',
              externalTransactionId: wallet.id,
              idempotencyKey: `opening:${wallet.id}`,
              payloadHash: '0'.repeat(64),
              walletId: wallet.id,
              playerId,
              roundId: 'OPENING',
              gameId: 'OPENING',
              kind: WagerTransactionKind.Opening,
              amount: money.toJSON().amount,
              currency: money.currency,
              status: WagerTransactionStatus.Processed,
              resultBalance: money.toJSON().amount,
              createdAt: wallet.createdAt,
              processedAt: wallet.createdAt,
            }),
          );
          await tx.flush();
          const entry = WalletLedgerEntry.create({
            id: crypto.randomUUID(),
            walletId: wallet.id,
            transactionId,
            direction: LedgerDirection.Credit,
            money,
            balanceBefore: Money.zero(money.currency),
            balanceAfter: money,
            createdAt: wallet.createdAt,
          });
          this.persistEntry(tx, entry);
          this.persistEvent(
            tx,
            WagerTransactionProcessed.from(transactionId, wallet.id, {
              correlationId: transactionId,
            }),
          );
          this.persistEvent(
            tx,
            WalletBalanceChanged.from(wallet, entry, {
              correlationId: transactionId,
            }),
          );
        }
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException)
        throw new ConflictException('WALLET_ALREADY_EXISTS');
      throw error;
    }
    return this.walletResult(wallet);
  }

  async process(
    input: WagerInput,
    idempotencyKey: string,
    message?: { messageId: string; consumerName: string },
  ): Promise<WagerResult> {
    const started = performance.now();
    const money = this.validateInput(input, idempotencyKey);
    const hash = hashWagerPayload(input, money);
    try {
      const result = await this.em.fork().transactional(async (tx) => {
        const walletRow = await tx.findOne(
          WalletRecord,
          { id: input.walletId },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );
        if (!walletRow) throw new NotFoundException('WALLET_NOT_FOUND');
        if (message) {
          const inbox = await tx.findOne(InboxRecord, {
            consumerName: message.consumerName,
            messageId: message.messageId,
          });
          if (inbox) {
            if (!matchesWagerPayloadHash(inbox.payloadHash, input, money))
              throw new ConflictException('MESSAGE_ID_CONFLICT');
            const original = await tx.findOne(WagerRecord, { idempotencyKey });
            if (
              !original ||
              !matchesWagerPayloadHash(original.payloadHash, input, money)
            )
              throw new ConflictException('MESSAGE_ID_CONFLICT');
            return this.result(original, true);
          }
        }
        const existing = await tx.findOne(WagerRecord, { idempotencyKey });
        if (existing) {
          if (!matchesWagerPayloadHash(existing.payloadHash, input, money))
            throw new ConflictException('IDEMPOTENCY_KEY_CONFLICT');
          if (message) this.persistInbox(tx, message, hash);
          return this.result(existing, true);
        }
        if (
          await tx.findOne(WagerRecord, {
            providerId: input.providerId,
            externalTransactionId: input.externalTransactionId,
          })
        ) {
          throw new ConflictException('EXTERNAL_TRANSACTION_ID_CONFLICT');
        }
        const wallet = this.rehydrateWallet(walletRow);
        const transactionId = crypto.randomUUID();
        WagerTransaction.create({
          id: transactionId,
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
          idempotencyKey,
          payloadHash: hash,
          walletId: input.walletId,
          playerId: input.playerId,
          roundId: input.roundId,
          gameId: input.gameId,
          kind: input.kind,
          money,
          referenceExternalTransactionId: input.referenceExternalTransactionId,
          createdAt: new Date(),
        });
        const record = Object.assign(new WagerRecord(), {
          id: transactionId,
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
          idempotencyKey,
          payloadHash: hash,
          walletId: input.walletId,
          playerId: input.playerId,
          roundId: input.roundId,
          gameId: input.gameId,
          kind: input.kind,
          amount: money.toJSON().amount,
          currency: money.currency,
          referenceExternalTransactionId: input.referenceExternalTransactionId,
          status: WagerTransactionStatus.Pending,
          createdAt: new Date(),
          referenceAttempts: 0,
        });
        tx.persist(record);
        await tx.flush();
        if (message) this.persistInbox(tx, message, hash);
        await this.apply(tx, walletRow, wallet, record);
        return this.result(record, false);
      });
      this.metrics.transaction(
        result.status,
        (performance.now() - started) / 1000,
      );
      if (result.idempotentReplay) this.metrics.increment('duplicate');
      process.stdout.write(
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          event: 'wager_result',
          correlationId: result.transactionId,
          messageId: message?.messageId ?? null,
          transactionId: result.transactionId,
          walletId: input.walletId,
          providerId: input.providerId,
          status: result.status,
          idempotentReplay: result.idempotentReplay,
        })}\n`,
      );
      return result;
    } catch (error) {
      if (error instanceof Error && /Lock|Deadlock/.test(error.name))
        this.metrics.increment('lock_conflict');
      if (error instanceof UniqueConstraintViolationException)
        throw new ConflictException('DUPLICATE_TRANSACTION');
      throw error;
    }
  }

  async recordPermanentFailure(
    input: WagerInput,
    idempotencyKey: string,
    message: { messageId: string; consumerName: string },
  ): Promise<WagerResult> {
    const started = performance.now();
    const money = this.validateInput(input, idempotencyKey);
    const hash = hashWagerPayload(input, money);
    try {
      const result = await this.em.fork().transactional(async (tx) => {
        const wallet = await tx.findOne(
          WalletRecord,
          { id: input.walletId },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );
        if (!wallet) throw new NotFoundException('WALLET_NOT_FOUND');
        const existing = await tx.findOne(WagerRecord, { idempotencyKey });
        if (existing) {
          if (!matchesWagerPayloadHash(existing.payloadHash, input, money))
            throw new ConflictException('IDEMPOTENCY_KEY_CONFLICT');
          const inbox = await tx.findOne(InboxRecord, {
            consumerName: message.consumerName,
            messageId: message.messageId,
          });
          if (!inbox) this.persistInbox(tx, message, hash);
          return this.result(existing, true);
        }
        if (
          await tx.findOne(WagerRecord, {
            providerId: input.providerId,
            externalTransactionId: input.externalTransactionId,
          })
        )
          throw new ConflictException('EXTERNAL_TRANSACTION_ID_CONFLICT');

        const id = crypto.randomUUID();
        const transaction = WagerTransaction.create({
          id,
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
          idempotencyKey,
          payloadHash: hash,
          walletId: input.walletId,
          playerId: input.playerId,
          roundId: input.roundId,
          gameId: input.gameId,
          kind: input.kind,
          money,
          referenceExternalTransactionId: input.referenceExternalTransactionId,
          createdAt: new Date(),
        });
        transaction.fail('INFRASTRUCTURE_FAILURE');
        const row = Object.assign(new WagerRecord(), {
          id,
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
          idempotencyKey,
          payloadHash: hash,
          walletId: input.walletId,
          playerId: input.playerId,
          roundId: input.roundId,
          gameId: input.gameId,
          kind: input.kind,
          amount: money.toJSON().amount,
          currency: money.currency,
          referenceExternalTransactionId: input.referenceExternalTransactionId,
          status: transaction.status,
          failureCode: transaction.failureCode,
          resultBalance: wallet.balance,
          createdAt: new Date(),
          processedAt: transaction.processedAt,
          referenceAttempts: 0,
        });
        tx.persist(row);
        await tx.flush();
        this.persistInbox(tx, message, hash);
        this.persistEvent(
          tx,
          WagerTransactionFailed.from(id, wallet.id, transaction.failureCode!, {
            correlationId: id,
            causationId: message.messageId,
          }),
        );
        return this.result(row, false);
      });
      this.metrics.transaction(
        result.status,
        (performance.now() - started) / 1000,
      );
      return result;
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException)
        throw new ConflictException('DUPLICATE_TRANSACTION');
      throw error;
    }
  }

  async retryPending(id: string): Promise<WagerResult | undefined> {
    const started = performance.now();
    const result = await this.em.fork().transactional(async (tx) => {
      const initial = await tx.findOne(WagerRecord, { id });
      if (
        !initial ||
        initial.status !== WagerTransactionStatus.PendingReference
      )
        return undefined;
      const walletRow = await tx.findOne(
        WalletRecord,
        { id: initial.walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!walletRow) throw new NotFoundException('WALLET_NOT_FOUND');
      const record = await tx.findOneOrFail(
        WagerRecord,
        { id },
        { refresh: true },
      );
      if (
        record.status !== WagerTransactionStatus.PendingReference ||
        (record.nextReferenceAttemptAt &&
          record.nextReferenceAttemptAt > new Date())
      )
        return undefined;
      await this.apply(tx, walletRow, this.rehydrateWallet(walletRow), record);
      return this.result(record, false);
    });
    if (result)
      this.metrics.transaction(
        result.status,
        (performance.now() - started) / 1000,
      );
    return result;
  }

  async getWallet(id: string) {
    this.assertUuid(id);
    const row = await this.em.fork().findOne(WalletRecord, { id });
    if (!row) throw new NotFoundException('WALLET_NOT_FOUND');
    return {
      id: row.id,
      playerId: row.playerId,
      balance: { amount: row.balance, currency: row.currency },
      version: row.version,
    };
  }

  async getTransaction(id: string) {
    this.assertUuid(id);
    const row = await this.em.fork().findOne(WagerRecord, { id });
    if (!row) throw new NotFoundException('TRANSACTION_NOT_FOUND');
    return this.transactionDetails(row);
  }

  async getProviderTransaction(
    providerId: string,
    externalTransactionId: string,
  ) {
    const row = await this.em
      .fork()
      .findOne(WagerRecord, { providerId, externalTransactionId });
    if (!row) throw new NotFoundException('TRANSACTION_NOT_FOUND');
    return this.transactionDetails(row);
  }

  async getLedger(walletId: string, cursor?: string, limit = 50) {
    this.assertUuid(walletId);
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const wallet = await this.em.fork().findOne(WalletRecord, { id: walletId });
    if (!wallet) throw new NotFoundException('WALLET_NOT_FOUND');
    let before: { createdAt: Date; id: string } | undefined;
    if (cursor) {
      try {
        const value = JSON.parse(
          Buffer.from(cursor, 'base64url').toString('utf8'),
        ) as { createdAt: string; id: string };
        if (!value.createdAt || !this.validUuid(value.id)) throw new Error();
        before = { createdAt: new Date(value.createdAt), id: value.id };
        if (Number.isNaN(before.createdAt.getTime())) throw new Error();
      } catch {
        throw new BadRequestException('INVALID_CURSOR');
      }
    }
    const rows = await this.em.fork().find(
      LedgerRecord,
      {
        walletId,
        ...(before
          ? {
              $or: [
                { createdAt: { $lt: before.createdAt } },
                { createdAt: before.createdAt, id: { $lt: before.id } },
              ],
            }
          : {}),
      },
      { orderBy: { createdAt: 'DESC', id: 'DESC' }, limit: safeLimit + 1 },
    );
    const page = rows.slice(0, safeLimit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        transactionId: row.transactionId,
        direction: row.direction,
        money: { amount: row.amount, currency: row.currency },
        balanceBefore: { amount: row.balanceBefore, currency: row.currency },
        balanceAfter: { amount: row.balanceAfter, currency: row.currency },
        createdAt: row.createdAt,
      })),
      nextCursor:
        rows.length > safeLimit && last
          ? Buffer.from(
              JSON.stringify({
                createdAt: last.createdAt.toISOString(),
                id: last.id,
              }),
            ).toString('base64url')
          : null,
    };
  }

  async reconcile(walletId: string) {
    this.assertUuid(walletId);
    const result = await this.em.fork().transactional(async (tx) => {
      const wallet = await tx.findOne(
        WalletRecord,
        { id: walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!wallet) throw new NotFoundException('WALLET_NOT_FOUND');
      const entries = await tx.find(
        LedgerRecord,
        { walletId },
        { orderBy: { createdAt: 'ASC', id: 'ASC' } },
      );
      const stored = Money.from({
        amount: wallet.balance,
        currency: wallet.currency,
      });
      const calculated = entries.reduce((sum, entry) => {
        const amount = Money.from({
          amount: entry.amount,
          currency: entry.currency,
        });
        return entry.direction === LedgerDirection.Credit
          ? sum.add(amount)
          : sum.subtract(amount);
      }, Money.zero(wallet.currency));
      const difference = stored.subtract(calculated);
      return {
        walletId,
        storedBalance: stored.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: entries.length,
      };
    });
    if (!result.consistent) {
      this.metrics.increment('reconciliation_divergence');
      process.stdout.write(
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          event: 'reconciliation_divergence',
          correlationId: null,
          messageId: null,
          transactionId: null,
          walletId,
          providerId: null,
        })}\n`,
      );
    }
    return result;
  }

  private async apply(
    tx: EntityManager,
    walletRow: WalletRecord,
    wallet: Wallet,
    record: WagerRecord,
  ): Promise<void> {
    const money = Money.from({
      amount: record.amount,
      currency: record.currency,
    });
    const transaction = this.rehydrateTransaction(record);
    const context: EventContext = { correlationId: record.id };
    const reject = (code: FailureCode) => {
      transaction.reject(code);
      record.status = transaction.status;
      record.failureCode = transaction.failureCode;
      record.resultBalance = wallet.balance.toJSON().amount;
      record.processedAt = transaction.processedAt;
      record.nextReferenceAttemptAt = undefined;
      this.persistEvent(
        tx,
        WagerTransactionRejected.from(record.id, wallet.id, code, context),
      );
    };
    if (record.playerId !== wallet.playerId) return reject('WALLET_MISMATCH');
    if (money.currency !== wallet.currency) return reject('CURRENCY_MISMATCH');

    let reference: WagerRecord | null = null;
    if (
      record.kind === WagerTransactionKind.Refund ||
      record.kind === WagerTransactionKind.Rollback ||
      (record.kind === WagerTransactionKind.Win &&
        Boolean(record.referenceExternalTransactionId))
    ) {
      reference = await tx.findOne(WagerRecord, {
        providerId: record.providerId,
        externalTransactionId: record.referenceExternalTransactionId!,
      });
      if (
        !reference ||
        reference.status === WagerTransactionStatus.PendingReference ||
        reference.status === WagerTransactionStatus.Pending
      ) {
        const firstPending =
          record.status !== WagerTransactionStatus.PendingReference;
        transaction.markPendingReference();
        record.status = transaction.status;
        record.referenceAttempts += 1;
        if (record.referenceAttempts >= 8) return reject('REFERENCE_NOT_FOUND');
        record.nextReferenceAttemptAt = new Date(
          Date.now() + Math.min(2 ** record.referenceAttempts * 1000, 60000),
        );
        record.resultBalance = wallet.balance.toJSON().amount;
        if (firstPending)
          this.persistEvent(
            tx,
            WagerTransactionPendingReference.from(
              record.id,
              wallet.id,
              record.referenceExternalTransactionId!,
              context,
            ),
          );
        return;
      }
      if (reference.status !== WagerTransactionStatus.Processed)
        return reject('REFERENCE_NOT_PROCESSED');
      if (
        reference.walletId !== record.walletId ||
        reference.playerId !== record.playerId ||
        reference.roundId !== record.roundId ||
        reference.currency !== record.currency ||
        ((record.kind === WagerTransactionKind.Refund ||
          record.kind === WagerTransactionKind.Rollback) &&
          reference.amount !== record.amount) ||
        (record.kind === WagerTransactionKind.Win &&
          reference.kind !== WagerTransactionKind.Bet) ||
        (record.kind === WagerTransactionKind.Refund &&
          reference.kind !== WagerTransactionKind.Bet) ||
        (record.kind === WagerTransactionKind.Rollback &&
          ![
            WagerTransactionKind.Bet,
            WagerTransactionKind.Win,
            WagerTransactionKind.Refund,
          ].includes(reference.kind))
      ) {
        return reject('INVALID_REFERENCE');
      }
      if (
        record.kind === WagerTransactionKind.Refund ||
        record.kind === WagerTransactionKind.Rollback
      ) {
        const reversed = await tx.findOne(WagerRecord, {
          referenceTransactionId: reference.id,
          kind: record.kind,
          status: WagerTransactionStatus.Processed,
        });
        if (reversed && reversed.id !== record.id)
          return reject('ALREADY_REVERSED');
      }
      record.referenceTransactionId = reference.id;
    }

    let entry: WalletLedgerEntry | undefined;
    if (record.kind !== WagerTransactionKind.Loss) {
      const refDomain = reference
        ? this.rehydrateTransaction(reference)
        : undefined;
      const direction = transaction.ledgerDirectionFor(refDomain);
      if (
        direction === LedgerDirection.Debit &&
        wallet.balance.isLessThan(money)
      ) {
        return reject(
          record.kind === WagerTransactionKind.Bet
            ? 'INSUFFICIENT_FUNDS'
            : 'REVERSAL_INSUFFICIENT_FUNDS',
        );
      }
      entry =
        direction === LedgerDirection.Debit
          ? wallet.debit(record.id, money)
          : wallet.credit(record.id, money);
      this.persistEntry(tx, entry);
      walletRow.balance = wallet.balance.toJSON().amount;
      walletRow.version = wallet.version;
      walletRow.updatedAt = wallet.updatedAt;
    }
    transaction.markProcessed(reference?.id, new Date());
    record.status = transaction.status;
    record.referenceTransactionId = transaction.referenceTransactionId;
    record.failureCode = undefined;
    record.resultBalance = wallet.balance.toJSON().amount;
    record.processedAt = transaction.processedAt;
    record.nextReferenceAttemptAt = undefined;
    this.persistEvent(
      tx,
      WagerTransactionProcessed.from(record.id, wallet.id, context),
    );
    if (entry)
      this.persistEvent(tx, WalletBalanceChanged.from(wallet, entry, context));
  }

  private rehydrateTransaction(row: WagerRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.providerId,
      externalTransactionId: row.externalTransactionId,
      idempotencyKey: row.idempotencyKey,
      payloadHash: row.payloadHash,
      walletId: row.walletId,
      playerId: row.playerId,
      roundId: row.roundId,
      gameId: row.gameId,
      kind: row.kind,
      money: Money.from({ amount: row.amount, currency: row.currency }),
      referenceExternalTransactionId: row.referenceExternalTransactionId,
      createdAt: row.createdAt,
      status: row.status,
    });
  }

  private persistEntry(tx: EntityManager, entry: WalletLedgerEntry): void {
    tx.persist(
      Object.assign(new LedgerRecord(), {
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        amount: entry.money.toJSON().amount,
        currency: entry.money.currency,
        balanceBefore: entry.balanceBefore.toJSON().amount,
        balanceAfter: entry.balanceAfter.toJSON().amount,
        createdAt: entry.createdAt,
      }),
    );
  }

  private persistEvent(
    tx: EntityManager,
    event: IntegrationEvent<unknown>,
  ): void {
    const message = OutboxMessage.enqueue(event);
    tx.persist(
      Object.assign(new OutboxRecord(), {
        id: message.id,
        aggregateId: message.aggregateId,
        eventType: message.eventType,
        payload: message.payload,
        occurredAt: message.occurredAt,
        attempts: message.attempts,
      }),
    );
  }

  private persistInbox(
    tx: EntityManager,
    message: { messageId: string; consumerName: string },
    hash: string,
  ): void {
    const receivedAt = new Date();
    const inbox = InboxMessage.receive({
      messageId: message.messageId,
      consumerName: message.consumerName,
      payloadHash: hash,
      receivedAt,
    });
    inbox.markProcessed(new Date());
    tx.persist(
      Object.assign(new InboxRecord(), {
        id: crypto.randomUUID(),
        messageId: inbox.messageId,
        consumerName: inbox.consumerName,
        payloadHash: inbox.payloadHash,
        receivedAt: inbox.receivedAt,
        processedAt: inbox.processedAt,
      }),
    );
  }

  private rehydrateWallet(row: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: row.id,
      playerId: row.playerId,
      currency: row.currency,
      balance: Money.from({ amount: row.balance, currency: row.currency }),
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  private walletResult(wallet: Wallet) {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  private result(row: WagerRecord, replay: boolean): WagerResult {
    return {
      transactionId: row.id,
      status: row.status,
      balance: { amount: row.resultBalance ?? '0.00', currency: row.currency },
      idempotentReplay: replay,
      ...(row.failureCode ? { failureCode: row.failureCode } : {}),
    };
  }

  private transactionDetails(row: WagerRecord) {
    return {
      ...this.result(row, false),
      providerId: row.providerId,
      externalTransactionId: row.externalTransactionId,
      walletId: row.walletId,
      playerId: row.playerId,
      roundId: row.roundId,
      gameId: row.gameId,
      kind: row.kind,
      money: { amount: row.amount, currency: row.currency },
      referenceExternalTransactionId: row.referenceExternalTransactionId,
      createdAt: row.createdAt,
      processedAt: row.processedAt,
    };
  }

  private parseMoney(input: MoneyProps): Money {
    try {
      return Money.from(input);
    } catch {
      throw new BadRequestException('INVALID_MONEY');
    }
  }

  private validateInput(input: WagerInput, key: string): Money {
    if (
      !input ||
      !this.validText(key) ||
      ![
        input.providerId,
        input.externalTransactionId,
        input.playerId,
        input.walletId,
        input.roundId,
        input.gameId,
      ].every((value) => this.validText(value)) ||
      !this.validUuid(input.playerId) ||
      !this.validUuid(input.walletId) ||
      !(
        [
          WagerTransactionKind.Bet,
          WagerTransactionKind.Win,
          WagerTransactionKind.Loss,
          WagerTransactionKind.Refund,
          WagerTransactionKind.Rollback,
        ] as string[]
      ).includes(input.kind) ||
      ((input.kind === WagerTransactionKind.Refund ||
        input.kind === WagerTransactionKind.Rollback) &&
        !this.validText(input.referenceExternalTransactionId))
    ) {
      throw new BadRequestException('INVALID_WAGER_REQUEST');
    }
    const money = this.parseMoney(input.money);
    if (!money.isPositive())
      throw new BadRequestException('INVALID_MOVEMENT_AMOUNT');
    return money;
  }

  private validText(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 255 &&
      value.trim() === value
    );
  }

  private validUuid(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        value,
      )
    );
  }

  private assertUuid(value: unknown): asserts value is string {
    if (!this.validUuid(value)) throw new BadRequestException('INVALID_UUID');
  }
}
