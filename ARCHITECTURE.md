# Arquitetura e decisões

## Limites e invariantes

O serviço tem uma API NestJS e três loops de trabalho no mesmo processo: consumo SQS, publicação da outbox e reprocessamento de referências. Processos adicionais executam os mesmos loops sobre o mesmo PostgreSQL. A unidade de concorrência é a wallet: `SELECT ... FOR UPDATE` na linha da wallet, dentro de uma transação MikroORM, serializa alterações no mesmo saldo e permite progresso independente para wallets diferentes.

O PostgreSQL guarda `wallets.balance` como `numeric(20,2)` com `CHECK(balance >= 0)`. A classe `Money` usa `decimal.js`, aceita apenas strings decimais com duas casas e opera com precisão de 40 dígitos. Entradas com mais de duas casas são rejeitadas, sem arredondamento implícito. O limite de entrada de 18 dígitos inteiros corresponde a `numeric(20,2)`. A API local abre wallets apenas em BRL; o modelo `Money` continua apto a detectar conflitos entre moedas. Contratos de criação e movimentação rejeitam valores negativos ou não positivos conforme a operação. `Wallet` só altera saldo por `debit` e `credit`, que criam um `WalletLedgerEntry` balanceado. `LOSS` não altera saldo nem versão e não gera ledger. O crédito inicial gera `OPENING` e ledger na transação de abertura; a versão inicial é 1.

As migrations SQL são versionadas e reversíveis. O runner de integração testa `up → down → up` em um banco descartável. O schema impõe unicidade para `(player_id,currency)`, `(provider_id,external_transaction_id)`, `idempotency_key`, `(wallet_id,transaction_id)` do ledger e `(consumer_name,message_id)` da inbox. `wallet_ledger` tem `CHECK` aritmético e trigger que rejeita `UPDATE` e `DELETE`. Todas as tabelas financeiras e a outbox usam a mesma transação SQL. O domínio usa factories e reidratação separadas das entidades ORM. O MikroORM foi escolhido por fornecer transações e locks por linha explícitos; as entidades persistidas são adaptações das classes de domínio.

## Processamento e idempotência

O header `Idempotency-Key` é obrigatório no HTTP. Na fila, a chave vem de `data.idempotencyKey`. O hash é SHA-256 de um JSON canônico com chaves ordenadas recursivamente dos campos `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (`amount`, `currency`) e `referenceExternalTransactionId` (ou `null`). Metadados de transporte e a própria chave não entram no hash. A comparação de replay também reconhece hashes de registros locais criados pela versão anterior, que serializava os mesmos campos em ordem fixa.

Após bloquear a wallet, o caso de uso busca a chave e a referência externa. Mesmo hash retorna o status e o saldo salvos na transação original; hash divergente retorna 409. Unicidade no banco resolve corridas entre requests que usem a mesma chave em wallets diferentes. Um evento SQS também grava a inbox na mesma transação. Redelivery com o mesmo `messageId` e hash retorna a transação já confirmada; `messageId` com payload diferente é conflito permanente.

Para uma transação nova, o fluxo é: validar entrada, bloquear wallet, verificar chave, inserir transação, aplicar regras, atualizar saldo se necessário, inserir ledger e eventos na outbox, confirmar. O consumidor SQS só faz `DeleteMessage` depois da confirmação. Se cair após o commit e antes do ack, o replay consulta inbox/idempotência e não repete o efeito financeiro.

## Regras de reversão

`REFUND` referencia uma `BET` processada e credita o mesmo valor. `ROLLBACK` referencia `BET`, `WIN` ou `REFUND` processados e aplica o movimento inverso. `WIN` pode referenciar uma `BET`; seu valor não precisa ser igual ao da aposta. A referência é resolvida por provedor e ID externo e deve corresponder a player, wallet, moeda e rodada. REFUND e ROLLBACK exigem também igualdade de valor. O índice parcial `(reference_transaction_id,kind)` impede duas reversões não rejeitadas do mesmo tipo. A operação que debitaria uma wallet sem saldo é rejeitada com `REVERSAL_INSUFFICIENT_FUNDS`; uma `BET` sem saldo usa `INSUFFICIENT_FUNDS`.

Quando a referência ainda não existe ou está pendente, a transação fica `PENDING_REFERENCE` com próximo horário de tentativa. O worker usa backoff exponencial de até 60 segundos, com oito tentativas. Esgotado o limite, a transação é rejeitada com `REFERENCE_NOT_FOUND`. Estados terminais (`PROCESSED`, `REJECTED`, `FAILED`) não fazem novas transições de domínio.

| Código | Significado |
| --- | --- |
| `INSUFFICIENT_FUNDS` | Aposta sem saldo |
| `REVERSAL_INSUFFICIENT_FUNDS` | Reversão de crédito sem saldo |
| `REFERENCE_NOT_FOUND` | Referência ausente após oito tentativas |
| `INVALID_REFERENCE` | Tipo, escopo ou valor incompatível |
| `REFERENCE_NOT_PROCESSED` | Referência rejeitada ou falha |
| `ALREADY_REVERSED` | Referência já revertida pelo mesmo tipo |
| `CURRENCY_MISMATCH` | Moeda diferente da wallet |
| `WALLET_MISMATCH` | Player diferente da wallet |
| `INFRASTRUCTURE_FAILURE` | Mensagem válida esgotou retries e foi registrada como `FAILED` |

## Filas e falhas

O LocalStack fornece uma fila FIFO de entrada, sua DLQ e uma fila FIFO de eventos. `MessageGroupId=walletId` melhora a ordenação, mas a segurança vem do lock e das constraints no banco. Erros de negócio são terminais e recebem ack. Mensagens malformadas ou em conflito são enviadas à DLQ. Erros transitórios mantêm a mensagem sem ack, ajustam a visibilidade com backoff e seguem a política de redrive de cinco recebimentos. Na quinta tentativa de uma mensagem válida, se o banco voltar a estar acessível, o worker grava `FAILED`, inbox e `WagerTransactionFailed` na mesma transação antes do ack. Se o PostgreSQL continuar indisponível, a política do SQS leva a mensagem à DLQ; não é possível gravar auditoria no banco durante a indisponibilidade dele.

O publisher seleciona eventos não publicados com `FOR UPDATE SKIP LOCKED`, envia ao SQS e marca `published_at` na mesma transação de claim. Publishers concorrentes não selecionam a mesma linha ao mesmo tempo. Uma queda depois do envio e antes de gravar `published_at` pode repetir o evento. O `eventId` está no envelope e o consumidor downstream deve deduplicá-lo. A garantia oferecida é publicação ao menos uma vez, não entrega exatamente uma vez.

Em `SIGTERM`, os loops deixam de iniciar novos trabalhos, aguardam os trabalhos em curso e zeram a visibilidade das mensagens recebidas que ainda não começaram. O cliente SQS só é fechado após os hooks de encerramento dos workers. Readiness consulta PostgreSQL e as três filas; liveness exige apenas o processo.

## Observabilidade e autenticação

Logs de framework e processamento são JSON. Os logs financeiros contêm IDs de correlação, mensagem, transação, wallet e provedor, sem valores monetários ou payload completo; mensagens de erro do framework são redigidas para evitar SQL com dados financeiros. `/metrics` expõe contadores de status, duplicatas, retries, DLQ, conflitos de lock, divergência de reconciliação, atraso da outbox, profundidade aproximada da DLQ e latência. Contadores são locais a cada processo e devem ser agregados pelo sistema de métricas.

Os endpoints financeiros usam `ProviderIdentityGuard` como ponto explícito para verificação de token de um IdP OIDC. Neste recorte ele permite acesso, como autorizado pelo desafio para autenticação não implementada. Os endpoints de health ficam abertos. Antes de uso real, o guard precisa validar assinatura, emissor, audiência e vínculo do provedor; a mensagem SQS continua um canal interno confiável, mas a identidade do provedor no payload passa pelas regras do domínio.

## Limitações e próximos testes

- Os testes automatizados exercitam PostgreSQL e LocalStack reais, incluindo 50 duplicatas simultâneas, apostas disputando saldo em três processos, wallets independentes em paralelo, redelivery, referência fora de ordem, publishers concorrentes, janela entre commit e ack, constraints, migrations reversíveis, encerramento e indisponibilidade temporária de PostgreSQL e SQS.
- O consumidor downstream da fila de eventos não faz parte deste serviço. O envelope traz `eventId` para que ele deduplique publicações repetidas; a outbox garante publicação *at-least-once*.
- A API não implementa um IdP real. As métricas são mantidas por processo e reiniciam com ele.
- A reconciliação sinaliza divergência e nunca altera saldo. Ledger de partidas dobradas é uma extensão possível, fora do requisito básico.
- Escritas SQL manuais fora do caso de uso podem alterar `wallets.balance` sem inserir ledger; o schema protege não-negatividade, unicidade, aritmética e imutabilidade, enquanto a transação da aplicação garante a correspondência saldo/ledger. Um gatilho diferido de reconciliação por transação seria um endurecimento adicional para acesso direto ao banco.
