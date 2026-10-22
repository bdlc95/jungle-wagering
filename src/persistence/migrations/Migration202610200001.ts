import { Migration } from '@mikro-orm/migrations';

export class Migration202610200001 extends Migration {
  name = 'Migration202610200001';

  override up(): Promise<void> {
    this.addSql(`create table wallets (
      id uuid primary key, player_id varchar(255) not null, currency char(3) not null,
      balance numeric(20,2) not null check (balance >= 0),
      version integer not null check (version >= 1),
      created_at timestamptz not null, updated_at timestamptz not null,
      unique (player_id, currency)
    )`);
    this.addSql(`create table wager_transactions (
      id uuid primary key, provider_id varchar(255) not null,
      external_transaction_id varchar(255) not null,
      idempotency_key varchar(255) not null unique,
      payload_hash char(64) not null,
      wallet_id uuid not null references wallets(id), player_id varchar(255) not null,
      round_id varchar(255) not null, game_id varchar(255) not null,
      kind varchar(16) not null check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
      amount numeric(20,2) not null check (amount > 0), currency char(3) not null,
      reference_external_transaction_id varchar(255),
      reference_transaction_id uuid references wager_transactions(id),
      status varchar(24) not null check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
      failure_code varchar(80), result_balance numeric(20,2),
      created_at timestamptz not null, processed_at timestamptz,
      reference_attempts integer not null default 0 check (reference_attempts >= 0),
      next_reference_attempt_at timestamptz,
      unique (provider_id, external_transaction_id)
    )`);
    this.addSql(`create unique index wager_one_reversal_per_kind
      on wager_transactions(reference_transaction_id, kind)
      where kind in ('REFUND','ROLLBACK') and status <> 'REJECTED'`);
    this.addSql(`create index wager_pending_reference_due
      on wager_transactions(next_reference_attempt_at)
      where status = 'PENDING_REFERENCE'`);
    this.addSql(`create table wallet_ledger (
      id uuid primary key, wallet_id uuid not null references wallets(id),
      transaction_id uuid not null references wager_transactions(id),
      direction varchar(6) not null check (direction in ('DEBIT','CREDIT')),
      amount numeric(20,2) not null check (amount > 0), currency char(3) not null,
      balance_before numeric(20,2) not null check (balance_before >= 0),
      balance_after numeric(20,2) not null check (balance_after >= 0),
      created_at timestamptz not null,
      unique (wallet_id, transaction_id),
      check (balance_after = balance_before + case when direction = 'CREDIT' then amount else -amount end)
    )`);
    this
      .addSql(`create function reject_ledger_mutation() returns trigger language plpgsql as $$
      begin raise exception 'wallet_ledger is append only'; end $$`);
    this
      .addSql(`create trigger wallet_ledger_immutable before update or delete on wallet_ledger
      for each row execute function reject_ledger_mutation()`);
    this.addSql(`create table inbox_messages (
      id uuid primary key, consumer_name varchar(255) not null, message_id varchar(255) not null,
      payload_hash char(64) not null, received_at timestamptz not null,
      processed_at timestamptz, unique (consumer_name, message_id)
    )`);
    this.addSql(`create table outbox_messages (
      id uuid primary key, aggregate_id uuid not null, event_type varchar(255) not null,
      payload jsonb not null, occurred_at timestamptz not null,
      attempts integer not null default 0 check (attempts >= 0),
      next_attempt_at timestamptz, published_at timestamptz
    )`);
    this
      .addSql(`create index outbox_due on outbox_messages(next_attempt_at, occurred_at)
      where published_at is null`);
    return Promise.resolve();
  }

  override down(): Promise<void> {
    this.addSql('drop table outbox_messages');
    this.addSql('drop table inbox_messages');
    this.addSql('drop trigger wallet_ledger_immutable on wallet_ledger');
    this.addSql('drop function reject_ledger_mutation()');
    this.addSql('drop table wallet_ledger');
    this.addSql('drop table wager_transactions');
    this.addSql('drop table wallets');
    return Promise.resolve();
  }
}
