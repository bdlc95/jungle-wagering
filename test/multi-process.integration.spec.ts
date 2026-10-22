import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';

interface WalletView {
  id: string;
  playerId: string;
  balance: { amount: string };
}
interface TransactionView {
  status: string;
  idempotentReplay: boolean;
}
interface ReconciliationView {
  consistent: boolean;
  storedBalance: { amount: string };
}

describe('three independent API processes', () => {
  const ports = [43101, 43102, 43103];
  const processes: ChildProcess[] = [];

  beforeAll(async () => {
    for (const port of ports) {
      processes.push(
        spawn(process.execPath, ['src/main.ts'], {
          cwd: process.cwd(),
          env: { ...process.env, PORT: String(port), WORKERS_ENABLED: 'false' },
          stdio: 'ignore',
          windowsHide: true,
        }),
      );
    }
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      const states = await Promise.all(
        ports.map(async (port) => {
          try {
            return (await fetch(`http://127.0.0.1:${port}/health/live`)).ok;
          } catch {
            return false;
          }
        }),
      );
      if (states.every(Boolean)) return;
      await Bun.sleep(100);
    }
    throw new Error('THREE_PROCESSES_DID_NOT_START');
  }, 20000);

  afterAll(() => {
    for (const child of processes) child.kill();
  });

  async function post<T>(
    port: number,
    path: string,
    body: unknown,
    key?: string,
  ): Promise<{ status: number; body: T }> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as T,
    };
  }

  async function wallet(port: number) {
    const response = await post<WalletView>(port, '/wallets', {
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    expect(response.status).toBe(201);
    return response.body;
  }

  it('deduplicates and serializes bets across all three processes', async () => {
    const firstWallet = await wallet(ports[0]);
    const id = crypto.randomUUID();
    const body = {
      providerId: 'multi-process',
      externalTransactionId: id,
      playerId: firstWallet.playerId,
      walletId: firstWallet.id,
      roundId: 'round-multi',
      gameId: 'game-multi',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        post<TransactionView>(
          ports[index % 3],
          '/wagering/transactions',
          body,
          `multi-process:${id}`,
        ),
      ),
    );
    expect(
      responses.every((response) => response.body.status === 'PROCESSED'),
    ).toBe(true);
    expect(
      responses.filter((response) => response.body.idempotentReplay === false),
    ).toHaveLength(1);
    const state = (await (
      await fetch(`http://127.0.0.1:${ports[1]}/wallets/${firstWallet.id}`)
    ).json()) as WalletView;
    expect(state.balance.amount).toBe('75.00');

    const secondWallet = await wallet(ports[1]);
    const bets = await Promise.all(
      [0, 1].map((index) => {
        const betId = crypto.randomUUID();
        return post<TransactionView>(
          ports[index],
          '/wagering/transactions',
          {
            ...body,
            externalTransactionId: betId,
            playerId: secondWallet.playerId,
            walletId: secondWallet.id,
            money: { amount: '80.00', currency: 'BRL' },
          },
          `multi-process:${betId}`,
        );
      }),
    );
    expect(bets.map((item) => item.body.status).sort()).toEqual([
      'PROCESSED',
      'REJECTED',
    ]);
    const reconciliation = await post<ReconciliationView>(
      ports[2],
      `/wallets/${secondWallet.id}/reconciliation`,
      {},
    );
    expect(reconciliation.body.consistent).toBe(true);
    expect(reconciliation.body.storedBalance.amount).toBe('20.00');
  }, 20000);
});
