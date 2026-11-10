import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard';
import { ProblemFilter } from './common/problem.filter';
import { DbService } from './db/db.service';
import { PrismaService } from './db/prisma.service';
import { IdempotencyInterceptor } from './http/idempotency.interceptor';
import { RequestContextMiddleware } from './http/request-id.middleware';
import { TransactionInterceptor } from './http/transaction.interceptor';
import { JobQueue } from './jobs/job-queue.service';
import { CompaniesController } from './modules/companies/companies.controller';
import { CompaniesService } from './modules/companies/companies.service';
import { HealthController } from './modules/health/health.controller';
import { JobsController } from './modules/jobs/jobs.controller';
import { MeController } from './modules/me/me.controller';
import { PdfRenderer } from './pdf/pdf-renderer';
import { StateService } from './state/state.service';

@Module({
  controllers: [HealthController, MeController, CompaniesController, JobsController],
  providers: [
    PrismaService,
    DbService,
    StateService,
    JobQueue,
    PdfRenderer,
    CompaniesService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ProblemFilter },
    // ลำดับสำคัญ: idempotency (นอก) → transaction (ใน)
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TransactionInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('{*path}');
  }
}
