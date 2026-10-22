import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { ormConfig } from './persistence/orm.config';
import {
  ProviderTransactionsController,
  WageringController,
  WalletsController,
} from './wagering/wagering.controller';
import { WageringService } from './wagering/wagering.service';
import { SqsTransport } from './messaging/sqs.transport';
import { WorkersService } from './messaging/workers.service';
import { MetricsService } from './observability/metrics.service';
import { HealthController } from './observability/health.controller';
import { ProviderIdentityGuard } from './auth/provider-identity.guard';
import { APP_FILTER } from '@nestjs/core';
import { InfrastructureFilter } from './observability/infrastructure.filter';

@Module({
  imports: [MikroOrmModule.forRoot(ormConfig)],
  controllers: [
    WalletsController,
    WageringController,
    ProviderTransactionsController,
    HealthController,
  ],
  providers: [
    WageringService,
    SqsTransport,
    WorkersService,
    MetricsService,
    ProviderIdentityGuard,
    { provide: APP_FILTER, useClass: InfrastructureFilter },
  ],
})
export class AppModule {}
