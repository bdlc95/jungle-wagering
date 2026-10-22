import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { WageringService } from '../src/wagering/wagering.service';
import { WagerTransactionKind } from '../src/domain/wager-transaction';

interface TransactionView {
  status: string;
  failureCode?: string;
  balance: { amount: string };
  idempotentReplay: boolean;
}

interface LedgerView {
  items: { id: string; direction: string }[];
}

describe('wagering with PostgreSQL', () => {
  let app: INestApplication<App>;
  let wagering: WageringService;

  beforeAll(async () => {
    process.env.WORKERS_ENABLED = 'false';
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    wagering = module.get(WageringService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function open(amount = '100.00') {
    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: crypto.randomUUID(),
        initialBalance: { amount, currency: 'BRL' },
      });
    expect(response.status).toBe(201);
    return response.body as { id: string; playerId: string };
  }

  function bet(
    wallet: { id: string; playerId: string },
    externalTransactionId: string,
    amount = '80.00',
  ) {
    return {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    };
  }

  it('rejects duplicate wallets and unsupported opening currencies', async () => {
    const body = {
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '10.00', currency: 'BRL' },
    };
    expect(
      (await request(app.getHttpServer()).post('/wallets').send(body)).status,
    ).toBe(201);
    expect(
      (await request(app.getHttpServer()).post('/wallets').send(body)).status,
    ).toBe(409);
    expect(
      (
        await request(app.getHttpServer())
          .post('/wallets')
          .send({
            playerId: crypto.randomUUID(),
            initialBalance: { amount: '10.00', currency: 'USD' },
          })
      ).status,
    ).toBe(400);
  });

  it('serializes two competing bets and keeps ledger consistent', async () => {
    const wallet = await open();
    const first = bet(wallet, crypto.randomUUID());
    const second = bet(wallet, crypto.randomUUID());
    const results = await Promise.all(
      [first, second].map((body) =>
        request(app.getHttpServer())
          .post('/wagering/transactions')
          .set('Idempotency-Key', `provider-a:${body.externalTransactionId}`)
          .send(body),
      ),
    );
    const views = results.map((item) => item.body as TransactionView);
    expect(views.map((item) => item.status).sort()).toEqual([
      'PROCESSED',
      'REJECTED',
    ]);
    expect(views.find((item) => item.status === 'REJECTED')?.failureCode).toBe(
      'INSUFFICIENT_FUNDS',
    );
    const state = await request(app.getHttpServer()).get(
      `/wallets/${wallet.id}`,
    );
    expect((state.body as { balance: { amount: string } }).balance.amount).toBe(
      '20.00',
    );
    const ledger = await request(app.getHttpServer()).get(
      `/wallets/${wallet.id}/ledger`,
    );
    expect(
      (ledger.body as LedgerView).items.filter(
        (item) => item.direction === 'DEBIT',
      ),
    ).toHaveLength(1);
    const reconciliation = await request(app.getHttpServer()).post(
      `/wallets/${wallet.id}/reconciliation`,
    );
    expect((reconciliation.body as { consistent: boolean }).consistent).toBe(
      true,
    );
  });

  it('deduplicates 50 simultaneous deliveries and replays the original balance', async () => {
    const wallet = await open();
    const body = bet(wallet, crypto.randomUUID(), '25.00');
    const key = `provider-a:${body.externalTransactionId}`;
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        request(app.getHttpServer())
          .post('/wagering/transactions')
          .set('Idempotency-Key', key)
          .send(body),
      ),
    );
    const views = results.map((item) => item.body as TransactionView);
    expect(views.every((item) => item.status === 'PROCESSED')).toBe(true);
    expect(
      views.filter((item) => item.idempotentReplay === false),
    ).toHaveLength(1);
    expect(views.every((item) => item.balance.amount === '75.00')).toBe(true);
    const ledger = await request(app.getHttpServer()).get(
      `/wallets/${wallet.id}/ledger`,
    );
    expect(
      (ledger.body as LedgerView).items.filter(
        (item) => item.direction === 'DEBIT',
      ),
    ).toHaveLength(1);
    const winId = crypto.randomUUID();
    const win = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-a:${winId}`)
      .send({ ...bet(wallet, winId, '10.00'), kind: 'WIN' });
    expect((win.body as TransactionView).balance.amount).toBe('85.00');
    const replay = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(body);
    expect((replay.body as TransactionView).balance.amount).toBe('75.00');
    const conflict = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send({ ...body, money: { amount: '26.00', currency: 'BRL' } });
    expect(conflict.status).toBe(409);
  });

  it('applies win, loss, refund and rollback while preserving the ledger', async () => {
    const wallet = await open();
    const send = async (
      kind: string,
      amount: string,
      referenceExternalTransactionId?: string,
    ) => {
      const externalTransactionId = crypto.randomUUID();
      const response = await request(app.getHttpServer())
        .post('/wagering/transactions')
        .set('Idempotency-Key', `provider-a:${externalTransactionId}`)
        .send({
          ...bet(wallet, externalTransactionId, amount),
          kind,
          referenceExternalTransactionId,
        });
      return {
        externalTransactionId,
        response,
        body: response.body as TransactionView,
      };
    };
    const betResult = await send('BET', '30.00');
    expect(betResult.body.balance.amount).toBe('70.00');
    const win = await send('WIN', '50.00', betResult.externalTransactionId);
    expect(win.body.balance.amount).toBe('120.00');
    const loss = await send('LOSS', '10.00');
    expect(loss.body.balance.amount).toBe('120.00');
    const rollbackWin = await send(
      'ROLLBACK',
      '50.00',
      win.externalTransactionId,
    );
    expect(rollbackWin.body.balance.amount).toBe('70.00');
    const refund = await send(
      'REFUND',
      '30.00',
      betResult.externalTransactionId,
    );
    expect(refund.body.balance.amount).toBe('100.00');
    const duplicateRefund = await send(
      'REFUND',
      '30.00',
      betResult.externalTransactionId,
    );
    expect(duplicateRefund.response.status).toBe(422);
    expect(duplicateRefund.body.failureCode).toBe('ALREADY_REVERSED');
    const ledgerResponse = await request(app.getHttpServer()).get(
      `/wallets/${wallet.id}/ledger`,
    );
    const ledger = ledgerResponse.body as LedgerView;
    expect(ledger.items).toHaveLength(5); // OPENING, BET, WIN, ROLLBACK, REFUND
    const reconciliation = await request(app.getHttpServer()).post(
      `/wallets/${wallet.id}/reconciliation`,
    );
    expect((reconciliation.body as { consistent: boolean }).consistent).toBe(
      true,
    );
  });

  it('rejects a rollback that would make the balance negative', async () => {
    const wallet = await open('0.00');
    const winId = crypto.randomUUID();
    const win = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-a:${winId}`)
      .send({ ...bet(wallet, winId, '10.00'), kind: 'WIN' });
    expect(win.status).toBe(201);
    const betId = crypto.randomUUID();
    const betResponse = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-a:${betId}`)
      .send(bet(wallet, betId, '10.00'));
    expect(betResponse.status).toBe(201);
    const rollbackId = crypto.randomUUID();
    const rollback = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-a:${rollbackId}`)
      .send({
        ...bet(wallet, rollbackId, '10.00'),
        kind: 'ROLLBACK',
        referenceExternalTransactionId: winId,
      });
    expect(rollback.status).toBe(422);
    expect((rollback.body as TransactionView).failureCode).toBe(
      'REVERSAL_INSUFFICIENT_FUNDS',
    );
    const reconciliation = await request(app.getHttpServer()).post(
      `/wallets/${wallet.id}/reconciliation`,
    );
    expect((reconciliation.body as { consistent: boolean }).consistent).toBe(
      true,
    );
  });

  it('paginates the ledger with a stable cursor', async () => {
    const wallet = await open();
    const externalId = crypto.randomUUID();
    const wager = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-a:${externalId}`)
      .send(bet(wallet, externalId, '25.00'));
    expect(wager.status).toBe(201);
    const first = await request(app.getHttpServer()).get(
      `/wallets/${wallet.id}/ledger?limit=1`,
    );
    const firstPage = first.body as LedgerView & { nextCursor: string };
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTruthy();
    const second = await request(app.getHttpServer()).get(
      `/wallets/${wallet.id}/ledger?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
    );
    const secondPage = second.body as LedgerView;
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0].id).not.toBe(firstPage.items[0].id);
    expect(
      (
        await request(app.getHttpServer()).get(
          `/wallets/${wallet.id}/ledger?cursor=invalid`,
        )
      ).status,
    ).toBe(400);
  });

  it('audits terminal infrastructure failure without moving money', async () => {
    const wallet = await open();
    const externalId = crypto.randomUUID();
    const key = `provider-a:${externalId}`;
    const input = {
      ...bet(wallet, externalId, '25.00'),
      kind: WagerTransactionKind.Bet,
    };
    const failed = await wagering.recordPermanentFailure(input, key, {
      messageId: crypto.randomUUID(),
      consumerName: 'wager-transactions',
    });
    expect(failed.status).toBe('FAILED');
    expect(failed.failureCode).toBe('INFRASTRUCTURE_FAILURE');
    expect(failed.balance.amount).toBe('100.00');
    const ledger = await request(app.getHttpServer()).get(
      `/wallets/${wallet.id}/ledger`,
    );
    expect((ledger.body as LedgerView).items).toHaveLength(1); // OPENING only
    const replay = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(input);
    expect((replay.body as TransactionView).status).toBe('FAILED');
    expect((replay.body as TransactionView).idempotentReplay).toBe(true);
  });
});
