import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { WalletRecord } from '../src/persistence/entities';

describe('independent wallet concurrency', () => {
  let app: INestApplication<App>;
  let em: EntityManager;

  beforeAll(async () => {
    process.env.WORKERS_ENABLED = 'false';
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    em = module.get(EntityManager);
  });

  afterAll(async () => {
    await app.close();
  });

  async function openWallet() {
    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
    expect(response.status).toBe(201);
    return response.body as { id: string; playerId: string };
  }

  function submitBet(wallet: { id: string; playerId: string }) {
    const externalId = crypto.randomUUID();
    return request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `parallel:${externalId}`)
      .send({
        providerId: 'parallel',
        externalTransactionId: externalId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round',
        gameId: 'game',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      });
  }

  it('processes another wallet while the first row is locked', async () => {
    const blockedWallet = await openWallet();
    const freeWallet = await openWallet();
    let release!: () => void;
    let markAcquired!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    const holdLock = em.fork().transactional(async (tx) => {
      await tx.findOneOrFail(
        WalletRecord,
        { id: blockedWallet.id },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      markAcquired();
      await released;
    });
    await acquired;
    let blockedFinished = false;
    const blockedBet = submitBet(blockedWallet).then((response) => {
      blockedFinished = true;
      return response;
    });
    try {
      const freeBet = await Promise.race([
        submitBet(freeWallet),
        Bun.sleep(3000).then(() => {
          throw new Error('UNRELATED_WALLET_WAS_BLOCKED');
        }),
      ]);
      expect(freeBet.status).toBe(201);
      expect(blockedFinished).toBe(false);
    } finally {
      release();
      await holdLock;
    }
    expect((await blockedBet).status).toBe(201);
    for (const wallet of [blockedWallet, freeWallet]) {
      const result = await request(app.getHttpServer()).post(
        `/wallets/${wallet.id}/reconciliation`,
      );
      expect((result.body as { consistent: boolean }).consistent).toBe(true);
    }
  }, 10000);
});
