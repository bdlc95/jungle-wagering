import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import {
  InboxRecord,
  LedgerRecord,
  OutboxRecord,
  WagerRecord,
  WalletRecord,
} from './entities';
import { Migration202610200001 } from './migrations/Migration202610200001';

export const ormConfig = defineConfig({
  clientUrl:
    process.env.DATABASE_URL ??
    'postgresql://jungle:jungle_local@localhost:5433/jungle_wagering',
  entities: [
    WalletRecord,
    WagerRecord,
    LedgerRecord,
    InboxRecord,
    OutboxRecord,
  ],
  extensions: [Migrator],
  migrations: { migrationsList: [Migration202610200001] },
});
