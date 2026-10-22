import { spawn } from 'node:child_process';
import { MikroORM } from '@mikro-orm/postgresql';
import { ormConfig } from '../src/persistence/orm.config';

const files = [
  'test/wagering.integration.spec.ts',
  'test/independent-wallets.integration.spec.ts',
  'test/messaging.integration.spec.ts',
  'test/multi-worker.integration.spec.ts',
  'test/multi-process.integration.spec.ts',
  'test/recovery.integration.spec.ts',
  'test/crash.integration.spec.ts',
  'test/dlq.integration.spec.ts',
  'test/transient-sqs.integration.spec.ts',
  'test/shutdown.integration.spec.ts',
  'test/reconciliation.integration.spec.ts',
  'test/postgres-outage.integration.spec.ts',
  'test/schema.integration.spec.ts',
];

async function prepareDatabase(databaseUrl: string): Promise<void> {
  const target = new URL(databaseUrl);
  const databaseName = decodeURIComponent(target.pathname.slice(1));
  if (!/^[a-z0-9_]+_test$/.test(databaseName)) {
    throw new Error('TEST_DATABASE_NAME_MUST_END_WITH_TEST');
  }
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = '/postgres';
  const admin = await MikroORM.init({
    ...ormConfig,
    clientUrl: adminUrl.toString(),
  });
  try {
    const existing = await admin.em.execute<{ exists: number }[]>(
      'select 1 as exists from pg_database where datname = ?',
      [databaseName],
    );
    if (existing.length === 0) {
      await admin.em.execute(`create database "${databaseName}"`);
    }
  } finally {
    await admin.close(true);
  }
  const testOrm = await MikroORM.init({ ...ormConfig, clientUrl: databaseUrl });
  try {
    await testOrm.migrator.up();
  } finally {
    await testOrm.close(true);
  }
}

async function verifyReversibleMigration(databaseUrl: string): Promise<void> {
  const name = `jungle_migration_${crypto.randomUUID().replaceAll('-', '')}_test`;
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = '/postgres';
  const migrationUrl = new URL(databaseUrl);
  migrationUrl.pathname = `/${name}`;
  const admin = await MikroORM.init({
    ...ormConfig,
    clientUrl: adminUrl.toString(),
  });
  try {
    await admin.em.execute(`create database "${name}"`);
    const orm = await MikroORM.init({
      ...ormConfig,
      clientUrl: migrationUrl.toString(),
    });
    try {
      await orm.migrator.up();
      await orm.migrator.down();
      const tables = await orm.em.execute<{ table_name: string | null }[]>(
        "select to_regclass('public.wallets') as table_name",
      );
      if (tables[0]?.table_name !== null)
        throw new Error('MIGRATION_DOWN_LEFT_WALLETS_TABLE');
      await orm.migrator.up();
    } finally {
      await orm.close(true);
    }
    process.stdout.write('Reversible migration verified\n');
  } finally {
    await admin.em.execute(`drop database if exists "${name}"`);
    await admin.close(true);
  }
}

async function runFile(file: string, databaseUrl: string): Promise<number> {
  const child = spawn(process.execPath, ['test', file], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const databaseUrl =
    process.env.TEST_DATABASE_URL ??
    'postgresql://jungle:jungle_local@localhost:5433/jungle_wagering_test';
  await prepareDatabase(databaseUrl);
  await verifyReversibleMigration(databaseUrl);
  for (const file of files) {
    const code = await runFile(file, databaseUrl);
    if (code !== 0) {
      process.exitCode = code;
      return;
    }
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'TEST_RUNNER_FAILED'}\n`,
  );
  process.exitCode = 1;
});
