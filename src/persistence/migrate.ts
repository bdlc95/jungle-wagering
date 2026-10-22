import { MikroORM } from '@mikro-orm/postgresql';
import { ormConfig } from './orm.config';

async function main(): Promise<void> {
  const orm = await MikroORM.init(ormConfig);
  try {
    if (process.argv.includes('down')) {
      await orm.migrator.down();
    } else {
      await orm.migrator.up();
    }
  } finally {
    await orm.close(true);
  }
}

void main();
