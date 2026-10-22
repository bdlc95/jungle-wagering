# Conferência do desafio Jungle Gaming

Esta conferência segue as seções 1–14 do enunciado enviado. **OK** indica implementação e evidência no repositório; **decisão permitida** indica uma escolha expressamente aceita pelo enunciado; **limite** identifica uma responsabilidade externa ou melhoria opcional.

## 1–5. Objetivo, autenticação, stack e restrições

| Exigência do enunciado | Estado | Evidência |
| --- | --- | --- |
| Processar operações de múltiplos provedores e rodadas | OK | [Caso de uso](./src/wagering/wagering.service.ts), [API](./src/wagering/wagering.controller.ts) |
| Mensagens duplicadas, fora de ordem e simultâneas | OK | [Idempotência e referência](./src/wagering/wagering.service.ts), [testes da fila](./test/messaging.integration.spec.ts) |
| Saldo não negativo, sem débito ou crédito duplicado | OK | [Wallet](./src/domain/wallet.ts), [constraints](./src/persistence/migrations/Migration202610200001.ts), [concorrência](./test/multi-process.integration.spec.ts) |
| Autenticação com IdP externo ou omissão documentada | Decisão permitida | [Guard de extensão](./src/auth/provider-identity.guard.ts), [decisão](./ARCHITECTURE.md) |
| Health aberto; identidade do provedor validada no domínio | OK | [Health](./src/observability/health.controller.ts), [validação e referências](./src/wagering/wagering.service.ts) |
| Bun 1.x, TypeScript estrito, NestJS | OK | [Configuração](./package.json), [TypeScript](./tsconfig.json), [módulo](./src/app.module.ts) |
| PostgreSQL, SQS/LocalStack e Docker Compose | OK | [Compose](./compose.yaml), [MikroORM](./src/persistence/orm.config.ts), [SQS](./src/messaging/sqs.transport.ts) |
| MikroORM ou TypeORM; não usar Prisma | OK | [Dependências](./package.json), [decisão](./ARCHITECTURE.md) |
| Migrations versionadas e reversíveis | OK | [Migration](./src/persistence/migrations/Migration202610200001.ts), [verificação `up → down → up`](./test/run-integration.ts) |
| Dinheiro sem `number`, `float` ou `double` | OK | [Money com Decimal](./src/domain/money.ts), colunas `numeric(20,2)` na [migration](./src/persistence/migrations/Migration202610200001.ts) |
| Idempotência persistente; FIFO não é garantia final | OK | Chaves únicas, inbox e locks em [persistência](./src/persistence/migrations/Migration202610200001.ts) e [caso de uso](./src/wagering/wagering.service.ts) |
| Evento somente após commit financeiro | OK | [Outbox transacional](./src/wagering/wagering.service.ts) e [publisher](./src/messaging/workers.service.ts) |
| Ledger sem sobrescrita/exclusão; sem lock global | OK | Trigger na [migration](./src/persistence/migrations/Migration202610200001.ts); `FOR UPDATE` por wallet no [caso de uso](./src/wagering/wagering.service.ts) |
| Unicidade, imutabilidade e não-negatividade no schema | OK | [Constraints e trigger](./src/persistence/migrations/Migration202610200001.ts), [teste real](./test/schema.integration.spec.ts) |

## 6. Modelo de domínio

| Exigência | Estado | Evidência |
| --- | --- | --- |
| Construtores encapsulados e factories `create/from/rehydrate` | OK | [Money](./src/domain/money.ts), [Wallet](./src/domain/wallet.ts), [Transação](./src/domain/wager-transaction.ts), [Ledger](./src/domain/ledger-entry.ts), [Inbox/Outbox](./src/domain/messages.ts) |
| Reidratação sem repetir regras de transição | OK | Factories `rehydrate` nos mesmos tipos de domínio |
| Money imutável, decimal string com duas casas e operações exatas | OK | [Money](./src/domain/money.ts), [teste unitário](./src/domain/domain.spec.ts) |
| Rejeitar NaN, Infinity, notação científica, escala inválida e entrada negativa | OK | [Validação](./src/domain/money.ts), [casos de teste](./src/domain/domain.spec.ts) |
| Moedas distintas causam erro; API pode usar somente BRL | OK | [Money](./src/domain/money.ts), [abertura de wallet](./src/wagering/wagering.service.ts), [teste](./test/wagering.integration.spec.ts) |
| Wallet única por player/moeda, saldo não negativo, versão inicial 1 | OK | [Wallet](./src/domain/wallet.ts), [constraint](./src/persistence/migrations/Migration202610200001.ts), [teste](./test/wagering.integration.spec.ts) |
| Versão só aumenta quando o saldo muda; cada movimento gera ledger | OK | [Wallet](./src/domain/wallet.ts), [LOSS e movimentos](./src/wagering/wagering.service.ts), [teste](./test/wagering.integration.spec.ts) |
| `OPENING` interno, idempotency key conflitante, estados terminais | OK | [Transação](./src/domain/wager-transaction.ts), [API/caso de uso](./src/wagering/wagering.service.ts), [testes](./src/domain/domain.spec.ts) |
| Ledger imutável, balanceado, no máximo uma entrada por transação/wallet | OK | [Ledger](./src/domain/ledger-entry.ts), [schema](./src/persistence/migrations/Migration202610200001.ts), [teste](./test/schema.integration.spec.ts) |
| `LOSS` e `REJECTED` não geram ledger | OK | [Processamento](./src/wagering/wagering.service.ts), [teste de operações](./test/wagering.integration.spec.ts) |
| Inbox/Outbox com estado e transições explícitas | OK | [Classes](./src/domain/messages.ts), [integração](./src/messaging/workers.service.ts), [teste](./src/domain/domain.spec.ts) |
| Inbox, finanças, ledger e outbox na mesma transação SQL | OK | [Caso de uso](./src/wagering/wagering.service.ts), [teste de redelivery](./test/messaging.integration.spec.ts) |

## 7–8. Regras, idempotência e concorrência

| Exigência | Estado | Evidência |
| --- | --- | --- |
| `BET` débito e rejeição por saldo insuficiente | OK | [Processamento](./src/wagering/wagering.service.ts), [teste de disputa](./test/wagering.integration.spec.ts) |
| `WIN` crédito, referência opcional à BET da mesma rodada | OK | [Processamento](./src/wagering/wagering.service.ts), [teste](./test/wagering.integration.spec.ts) |
| `LOSS` sem efeito no saldo | OK | [Processamento](./src/wagering/wagering.service.ts), [teste](./test/wagering.integration.spec.ts) |
| `REFUND` de BET processada, integral e único por tipo | OK | [Validação e índice](./src/wagering/wagering.service.ts), [migration](./src/persistence/migrations/Migration202610200001.ts), [teste](./test/wagering.integration.spec.ts) |
| `ROLLBACK` inverso de BET, WIN ou REFUND, integral | OK | [Transação](./src/domain/wager-transaction.ts), [processamento](./src/wagering/wagering.service.ts), [teste](./test/wagering.integration.spec.ts) |
| Referência no mesmo provedor, player, wallet, moeda e rodada | OK | [Validação](./src/wagering/wagering.service.ts) |
| Reversão sem saldo com código diferente de BET sem saldo | OK | [Códigos](./src/domain/wager-transaction.ts), [teste](./test/wagering.integration.spec.ts) |
| Replay devolve resultado e saldo originais; payload divergente é conflito | OK | [Hash canônico](./src/domain/payload-hash.ts), [replay](./src/wagering/wagering.service.ts), [teste](./test/wagering.integration.spec.ts) |
| Referência ausente: `PENDING_REFERENCE`, backoff e rejeição final | OK | [Worker](./src/messaging/workers.service.ts), [caso de uso](./src/wagering/wagering.service.ts), [teste](./test/messaging.integration.spec.ts) |
| Códigos de falha estáveis e documentados | OK | [Taxonomia](./src/domain/wager-transaction.ts), [documentação](./ARCHITECTURE.md) |
| Concorrência por wallet, outras wallets independentes | OK | [Lock por linha](./src/wagering/wagering.service.ts), [teste com lock retido](./test/independent-wallets.integration.spec.ts) |
| Duas BET de 80 disputando saldo 100 deixam 20 e um débito | OK | [Teste real](./test/wagering.integration.spec.ts), [três processos](./test/multi-process.integration.spec.ts), [dois workers](./test/multi-worker.integration.spec.ts) |
| Pelo menos três processos simultâneos | OK | [Teste multiprocesso](./test/multi-process.integration.spec.ts) |

## 9. API HTTP

| Exigência | Estado | Evidência |
| --- | --- | --- |
| `POST /wallets` com `OPENING` e conflito de duplicata | OK | [Controller](./src/wagering/wagering.controller.ts), [serviço](./src/wagering/wagering.service.ts), [teste](./test/wagering.integration.spec.ts) |
| Consultas de wallet, ledger paginado e transação por IDs interno/externo | OK | [Controller](./src/wagering/wagering.controller.ts), [cursor](./src/wagering/wagering.service.ts), [teste](./test/wagering.integration.spec.ts) |
| `POST /wagering/transactions` com header de idempotência | OK | [Controller](./src/wagering/wagering.controller.ts), [hash](./src/domain/payload-hash.ts) |
| HTTP separa entrada inválida, conflito, rejeição, pendência e infraestrutura | OK | [Controller](./src/wagering/wagering.controller.ts), [filtro global](./src/observability/infrastructure.filter.ts), [teste de outage](./test/postgres-outage.integration.spec.ts) |
| Reconciliação compara, sinaliza, registra métrica/log e não corrige | OK | [Serviço](./src/wagering/wagering.service.ts), [teste de divergência](./test/reconciliation.integration.spec.ts) |
| Liveness e readiness separados; health aberto | OK | [Health](./src/observability/health.controller.ts), [teste de fila](./test/transient-sqs.integration.spec.ts), [teste de banco](./test/postgres-outage.integration.spec.ts) |

## 10–12. SQS, outbox e observabilidade

| Exigência | Estado | Evidência |
| --- | --- | --- |
| Fila FIFO de entrada e DLQ com envelope validado | OK | [Provisionamento e transporte](./src/messaging/sqs.transport.ts), [consumidor](./src/messaging/workers.service.ts) |
| Mesmo caso de uso HTTP/SQS; inbox persistente por consumidor/mensagem | OK | [WageringService](./src/wagering/wagering.service.ts), [teste](./test/messaging.integration.spec.ts) |
| Ack após commit; redelivery sem duplicar efeito | OK | [Worker](./src/messaging/workers.service.ts), [teste da janela commit/ack](./test/crash.integration.spec.ts) |
| Erro de negócio, transitório e permanente com retry/DLQ | OK | [Worker](./src/messaging/workers.service.ts), [DLQ](./test/dlq.integration.spec.ts), [outage PostgreSQL](./test/postgres-outage.integration.spec.ts) |
| `FAILED` auditável após esgotar retries quando o banco responde | OK | [Caso de uso](./src/wagering/wagering.service.ts), [evento](./src/domain/events.ts), [teste](./test/wagering.integration.spec.ts) |
| Encerramento aguarda operação em curso e devolve mensagens não iniciadas | OK | [Hooks](./src/messaging/workers.service.ts), [transporte](./src/messaging/sqs.transport.ts), [teste](./test/shutdown.integration.spec.ts) |
| Outbox após commit, dois publishers concorrentes, recuperação no reinício | OK | [Worker](./src/messaging/workers.service.ts), [teste](./test/recovery.integration.spec.ts) |
| Eventos mínimos e envelope de classe abstrata/subclasses | OK | [Eventos](./src/domain/events.ts), [persistência](./src/wagering/wagering.service.ts) |
| Falha temporária do SQS não perde evento confirmado | OK | [Retry da outbox](./src/messaging/workers.service.ts), [teste](./test/transient-sqs.integration.spec.ts) |
| Logs JSON sem payload financeiro completo | OK | [Logger](./src/observability/json-logger.ts), [logs de negócio](./src/wagering/wagering.service.ts) |
| Métricas de status, duplicatas, retry, DLQ, lock, outbox lag e latência | OK | [Métricas](./src/observability/metrics.service.ts), [endpoint](./src/observability/health.controller.ts) |
| Consumidor externo deduplica `eventId` da outbox | Limite | O evento traz `eventId`; o consumidor downstream não integra este serviço. Veja [arquitetura](./ARCHITECTURE.md). |

## 13–14. Provas e entrega

| Exigência | Estado | Evidência |
| --- | --- | --- |
| Unidade: Money, Wallet, operações, moedas e hash | OK | [Testes de domínio](./src/domain/domain.spec.ts) |
| Integração real: migrations, constraints, atomicidade, inbox/outbox, DLQ | OK | [Runner isolado](./test/run-integration.ts), [schema](./test/schema.integration.spec.ts), [mensageria](./test/messaging.integration.spec.ts) |
| Concorrência: 50 duplicatas, hot wallet, wallets distintas, três processos | OK | [Wagering](./test/wagering.integration.spec.ts), [wallets distintas](./test/independent-wallets.integration.spec.ts), [três processos](./test/multi-process.integration.spec.ts) |
| Queda entre commit/ack, dois publishers, fora de ordem, reinício | OK | [Crash](./test/crash.integration.spec.ts), [recovery](./test/recovery.integration.spec.ts), [referência](./test/messaging.integration.spec.ts) |
| Invariante final: saldo igual ao ledger | OK | Reconciliação nos testes financeiros, de falha e de concorrência; [diagnóstico de divergência](./test/reconciliation.integration.spec.ts) |
| Setup, comandos, decisões, trade-offs e limitações | OK | [README](./README.md), [arquitetura](./ARCHITECTURE.md) |
| Teste de carga | Opcional, não incluído | Diferencial sem meta obrigatória de RPS |

## Limites para a apresentação

- Autenticação real por IdP foi deixada para a integração futura, conforme permitido pelo enunciado.
- O evento da outbox pode ser publicado novamente após uma falha entre envio e gravação de `published_at`; o consumidor externo deve deduplicar `eventId`.
- Se o PostgreSQL continuar indisponível até o redrive do SQS, o worker não consegue gravar `FAILED` no banco naquele momento; a mensagem permanece auditável na DLQ.
- Um acesso SQL manual fora do caso de uso pode desalinhar saldo e ledger. A API de reconciliação detecta e sinaliza essa situação sem corrigi-la silenciosamente.
