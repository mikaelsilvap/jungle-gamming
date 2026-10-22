import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { MetricsController } from './health/metrics.controller';
import { HttpObservabilityMiddleware } from './observability/http-observability.middleware';
import { createOrm } from './persistence/orm';
import { WalletPostgresAdapter } from './persistence/wallet-postgres.adapter';
import { WalletOpeningService } from './wallets/wallet-opening.service';
import { WalletsController } from './wallets/wallets.controller';
import { WageringController } from './wagering/wagering.controller';
import { ProcessWagerService } from './wagering/process-wager.service';
import { createWagerSqsClient } from './messaging/wager-sqs-consumer';

class AppShutdown {
  constructor(private readonly orm: MikroORM, private readonly sqs: SQSClient) {}
  async onApplicationShutdown(): Promise<void> { this.sqs.destroy(); await this.orm.close(true); }
}

@Module({
  controllers: [HealthController, MetricsController, WalletsController, WageringController],
  providers: [
    { provide: MikroORM, useFactory: createOrm },
    { provide: SQSClient, useFactory: createWagerSqsClient },
    { provide: HealthService, useFactory: (orm: MikroORM, sqs: SQSClient) => new HealthService(orm, sqs,
      process.env.SQS_COMMAND_QUEUE_URL ?? '', process.env.SQS_DLQ_QUEUE_URL ?? ''), inject: [MikroORM, SQSClient] },
    { provide: WalletPostgresAdapter, useFactory: (orm: MikroORM) => new WalletPostgresAdapter(orm), inject: [MikroORM] },
    { provide: WalletOpeningService, useFactory: (persistence: WalletPostgresAdapter) => new WalletOpeningService(persistence), inject: [WalletPostgresAdapter] },
    { provide: ProcessWagerService, useFactory: (orm: MikroORM) => new ProcessWagerService(orm), inject: [MikroORM] },
    { provide: AppShutdown, useFactory: (orm: MikroORM, sqs: SQSClient) => new AppShutdown(orm, sqs), inject: [MikroORM, SQSClient] },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void { consumer.apply(HttpObservabilityMiddleware).forRoutes('*'); }
}
