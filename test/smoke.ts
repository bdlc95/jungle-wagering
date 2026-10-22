const baseUrl = process.env.API_URL ?? 'http://localhost:3000';

interface WalletView {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
}

interface TransactionView {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
}

function check(condition: boolean, description: string): void {
  if (!condition) throw new Error(description);
}

async function read<T>(path: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: (await response.json()) as T };
}

async function post<T>(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function main(): Promise<void> {
  const ready = await read<{ status: string; postgres: boolean; sqs: boolean }>(
    '/health/ready',
  );
  check(
    ready.status === 200 && ready.body.postgres && ready.body.sqs,
    'PostgreSQL ou SQS não está pronto',
  );

  const playerId = crypto.randomUUID();
  const opened = await post<WalletView>('/wallets', {
    playerId,
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  check(
    opened.status === 201 && opened.body.balance.amount === '100.00',
    'Abertura da wallet falhou',
  );

  const externalTransactionId = crypto.randomUUID();
  const key = `smoke:${externalTransactionId}`;
  const request = {
    providerId: 'smoke',
    externalTransactionId,
    playerId,
    walletId: opened.body.id,
    roundId: 'round-smoke',
    gameId: 'game-smoke',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };
  const headers = { 'Idempotency-Key': key };
  const first = await post<TransactionView>(
    '/wagering/transactions',
    request,
    headers,
  );
  check(
    first.status === 201 &&
      first.body.status === 'PROCESSED' &&
      first.body.balance.amount === '75.00' &&
      !first.body.idempotentReplay,
    'A aposta não foi processada corretamente',
  );
  const replay = await post<TransactionView>(
    '/wagering/transactions',
    request,
    headers,
  );
  check(
    replay.status === 200 &&
      replay.body.idempotentReplay &&
      replay.body.transactionId === first.body.transactionId &&
      replay.body.balance.amount === '75.00',
    'Replay idempotente falhou',
  );

  const wallet = await read<WalletView>(`/wallets/${opened.body.id}`);
  const ledger = await read<{ items: unknown[] }>(
    `/wallets/${opened.body.id}/ledger`,
  );
  const reconciliation = await post<{
    consistent: boolean;
    storedBalance: { amount: string };
    checkedEntries: number;
  }>(`/wallets/${opened.body.id}/reconciliation`, {});
  check(
    wallet.body.balance.amount === '75.00' &&
      ledger.body.items.length === 2 &&
      reconciliation.body.consistent &&
      reconciliation.body.checkedEntries === 2,
    'Saldo e ledger divergiram',
  );

  process.stdout.write(
    `OK: 100.00 -> BET 25.00 -> ${wallet.body.balance.amount} BRL; ` +
      `replay sem débito extra; ledger ${ledger.body.items.length}; reconciliação consistente.\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Smoke falhou: ${error instanceof Error ? error.message : 'erro desconhecido'}\n`,
  );
  process.exitCode = 1;
});
