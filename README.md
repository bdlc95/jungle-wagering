# Jungle Wagering

Processador financeiro de apostas da Jungle Gaming. Bun, NestJS, PostgreSQL, MikroORM e SQS via LocalStack. O saldo da wallet, a transação, o lançamento no ledger, a inbox e os eventos da outbox são confirmados na mesma transação SQL.

## Requisitos

- Bun 1.x
- Docker Desktop com Compose

## Iniciar

```sh
bun install
bun run infra:up
bun run db:migrate
bun run infra:setup
bun run start:dev
```

A API escuta em `http://localhost:3000`. Inicie o Docker Desktop antes de `bun run infra:up`. O arquivo `.env.example` contém os valores locais padrão. Copie para `.env` se quiser alterá-los. O banco e as filas são persistidos pelos containers; reiniciar a aplicação não apaga transações.

No **Git Bash** (terminal mostrado na captura), abra outro terminal enquanto a API roda e execute:

```sh
curl -s http://localhost:3000/health/ready
bun run smoke
```

O health check deve retornar `{"status":"ok","postgres":true,"sqs":true}`. O smoke cria uma wallet de `100.00 BRL`, aposta `25.00`, repete a requisição e confere saldo `75.00`, ledger e reconciliação. `Invoke-RestMethod` só funciona no PowerShell, não no Git Bash.

Para reverter a última migration em um banco descartável: `bun run db:rollback`. Para parar os containers: `bun run infra:down`.

## API

| Método | Caminho | Uso |
| --- | --- | --- |
| POST | `/wallets` | Abre wallet; saldo inicial positivo gera `OPENING` e crédito no ledger |
| GET | `/wallets/:walletId` | Consulta saldo e versão |
| GET | `/wallets/:walletId/ledger?limit=50&cursor=...` | Ledger com cursor opaco |
| POST | `/wallets/:walletId/reconciliation` | Compara saldo salvo e soma do ledger |
| POST | `/wagering/transactions` | Envia operação; exige header `Idempotency-Key` |
| GET | `/wagering/transactions/:transactionId` | Consulta transação interna |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pela referência do provedor |
| GET | `/health/live` | Processo ativo |
| GET | `/health/ready` | PostgreSQL e SQS disponíveis |
| GET | `/metrics` | Métricas no formato Prometheus |

Exemplo de abertura (a API local aceita `BRL` para novas wallets):

```json
{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}
```

Exemplo de `POST /wagering/transactions` com header `Idempotency-Key: provider-a:transaction-123`:

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "<id retornado por POST /wallets>",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

`BET` debita; `WIN` credita e pode referenciar uma `BET` da mesma rodada; `LOSS` registra sem mover saldo; `REFUND` credita uma `BET`; `ROLLBACK` inverte uma `BET`, `WIN` ou `REFUND`. `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId` e valor integral igual ao original.

Status HTTP: `201` operação nova processada, `200` replay processado, `202` aguardando referência, `422` rejeição de negócio (inclusive replay rejeitado), `400` entrada inválida, `409` conflito, `503` falha do banco ou readiness indisponível. A resposta de uma transação inclui `transactionId`, `status`, `balance`, `idempotentReplay` e, quando rejeitada, `failureCode`.

## Fila de entrada

`wager-transactions.fifo` recebe um envelope JSON como abaixo. Use `MessageGroupId = walletId`. A inbox usa `messageId` do envelope. O serviço confirma a mensagem no SQS somente após o commit.

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-20T00:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<id da wallet>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

O publisher envia a outbox para `wager-events.fifo`. Mensagens inválidas vão para `wager-transactions-dlq.fifo`; erros transitórios usam visibilidade e a política de redrive da fila. Se cinco tentativas de uma mensagem válida falharem e o banco estiver acessível, o worker registra `FAILED` com `INFRASTRUCTURE_FAILURE` antes do ack. `WORKERS_ENABLED=false` desliga consumidores e publishers, útil ao executar somente a API.

## Testes

Com os containers ativos:

```sh
bun run test
bun run test:integration
bun run test:e2e
bun run typecheck
bun run build
bun run lint
```

`bun run test:integration` cria e migra automaticamente o banco separado `jungle_wagering_test`, usa filas próprias por cenário e executa os arquivos em sequência. Também aplica, reverte e reaplica a migration em um banco descartável. Os testes usam PostgreSQL e LocalStack reais e cobrem concorrência, três processos, idempotência, inbox/outbox, referências fora de ordem, DLQ, desligamento e recuperação após falhas temporárias de PostgreSQL e SQS.

O [workflow de verificação](./.github/workflows/verify.yml) repete esses testes, lint, build e smoke em um ambiente limpo do GitHub Actions a cada push e pull request.

## Arquitetura

Veja [ARCHITECTURE.md](./ARCHITECTURE.md) para invariantes, idempotência, esquema, falhas e limitações conhecidas, e [DELIVERY_AUDIT.md](./DELIVERY_AUDIT.md) para a conferência item a item do enunciado.
