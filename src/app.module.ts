import { Module } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { HealthController } from './health/health.controller';
import { createOrm } from './persistence/orm';
import { WalletPostgresAdapter } from './persistence/wallet-postgres.adapter';
import { WalletOpeningService } from './wallets/wallet-opening.service';
import { WalletsController } from './wallets/wallets.controller';
import { WageringController } from './wagering/wagering.controller';
import { ProcessWagerService } from './wagering/process-wager.service';

class OrmShutdown {
  constructor(private readonly orm: MikroORM) {}
  async onApplicationShutdown(): Promise<void> { await this.orm.close(true); }
}

@Module({
  controllers: [HealthController, WalletsController, WageringController],
  providers: [
    { provide: MikroORM, useFactory: createOrm },
    { provide: WalletPostgresAdapter, useFactory: (orm: MikroORM) => new WalletPostgresAdapter(orm), inject: [MikroORM] },
    { provide: WalletOpeningService, useFactory: (persistence: WalletPostgresAdapter) => new WalletOpeningService(persistence), inject: [WalletPostgresAdapter] },
    { provide: ProcessWagerService, useFactory: (orm: MikroORM) => new ProcessWagerService(orm), inject: [MikroORM] },
    { provide: OrmShutdown, useFactory: (orm: MikroORM) => new OrmShutdown(orm), inject: [MikroORM] },
  ],
})
export class AppModule {}
