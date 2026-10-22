import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { MetricsService } from '../src/observability/metrics.service';

describe('reconciliation diagnostics', () => {
  let app: INestApplication<App>;
  let em: EntityManager;
  let metrics: MetricsService;

  beforeAll(async () => {
    process.env.WORKERS_ENABLED = 'false';
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    em = module.get(EntityManager);
    metrics = module.get(MetricsService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('signals a mismatch without changing the stored balance', async () => {
    const opened = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
    expect(opened.status).toBe(201);
    const wallet = opened.body as { id: string };
    // Emulates an out-of-band database write on this isolated test wallet.
    await em
      .fork()
      .execute('update wallets set balance = 90 where id = ?', [wallet.id]);
    const response = await request(app.getHttpServer()).post(
      `/wallets/${wallet.id}/reconciliation`,
    );
    const result = response.body as {
      consistent: boolean;
      storedBalance: { amount: string };
      calculatedBalance: { amount: string };
      difference: { amount: string };
      checkedEntries: number;
    };
    expect(response.status).toBe(200);
    expect(result.consistent).toBe(false);
    expect(result.storedBalance.amount).toBe('90.00');
    expect(result.calculatedBalance.amount).toBe('100.00');
    expect(result.difference.amount).toBe('-10.00');
    expect(result.checkedEntries).toBe(1);
    expect(metrics.render(0)).toContain(
      'wagering_reconciliation_divergences_total 1',
    );
    const stillStored = await request(app.getHttpServer()).get(
      `/wallets/${wallet.id}`,
    );
    expect(
      (stillStored.body as { balance: { amount: string } }).balance.amount,
    ).toBe('90.00');
  });
});
