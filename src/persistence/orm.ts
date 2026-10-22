import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { persistenceEntities } from './entities';

export function createOrmOptions() {
  const clientUrl = process.env.DATABASE_URL ?? 'postgresql://wagering_app:local_only_change_me@127.0.0.1:5432/wagering';
  const compiledMigrations = process.env.NODE_ENV === 'production' || process.env.MIKRO_ORM_MIGRATIONS_PATH === 'dist';
  return {
    clientUrl,
    entities: persistenceEntities,
    extensions: [Migrator],
    migrations: {
      path: compiledMigrations ? './dist/src/persistence/migrations' : './src/persistence/migrations',
      glob: compiledMigrations ? '*.js' : '*.ts',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      snapshotOnMigrate: false,
    },
    debug: process.env.NODE_ENV === 'development',
  };
}

export async function createOrm(): Promise<MikroORM> {
  return await MikroORM.init(createOrmOptions()) as unknown as MikroORM;
}
