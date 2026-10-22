import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { LedgerRecord } from '../src/persistence/entities';
import { WageringService } from '../src/wagering/wagering.service';

describe('versioned PostgreSQL schema', () => {
  let app: INestApplication<App>;
  let em: EntityManager;
  let wagering: WageringService;

  beforeAll(async () => {
    process.env.WORKERS_ENABLED = 'false';
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    em = module.get(EntityManager);
    wagering = module.get(WageringService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('applies the migration and enforces financial constraints', async () => {
    const migrations = await em
      .fork()
      .execute<{ name: string }[]>(
        'select name from mikro_orm_migrations where name = ?',
        ['Migration202610200001'],
      );
    expect(migrations).toHaveLength(1);

    const wallet = await wagering.openWallet(crypto.randomUUID(), {
      amount: '100.00',
      currency: 'BRL',
    });
    const entry = await em
      .fork()
      .findOneOrFail(LedgerRecord, { walletId: wallet.id });
    let negativeError: unknown;
    try {
      await em
        .fork()
        .transactional(async (tx) =>
          tx.execute('update wallets set balance = -1 where id = ?', [
            wallet.id,
          ]),
        );
    } catch (error) {
      negativeError = error;
    }
    expect(negativeError).toBeInstanceOf(Error);
    let mutationError: unknown;
    try {
      await em
        .fork()
        .transactional(async (tx) =>
          tx.execute('update wallet_ledger set amount = 1 where id = ?', [
            entry.id,
          ]),
        );
    } catch (error) {
      mutationError = error;
    }
    expect(mutationError).toBeInstanceOf(Error);
    expect((mutationError as Error).message).toContain(
      'wallet_ledger is append only',
    );
  });
});
