import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { MfaController } from './auth/mfa.controller';
import { MfaService } from './auth/mfa.service';
import { BranchesController } from './modules/branches/branches.controller';
import { BranchesService } from './modules/branches/branches.service';
import { SequencesController } from './modules/sequences/sequences.controller';
import { SequencesService } from './modules/sequences/sequences.service';
import { AuditController } from './audit/audit.controller';
import { SettingsController } from './modules/settings/settings.controller';
import { SettingsService } from './modules/settings/settings.service';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
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
import { UsersController } from './modules/users/users.controller';
import { PdfRenderer } from './pdf/pdf-renderer';
import { StateService } from './state/state.service';

@Module({
  controllers: [
    AuthController,
    MfaController,
    HealthController,
    MeController,
    CompaniesController,
    UsersController,
    BranchesController,
    SequencesController,
    AuditController,
    SettingsController,
    JobsController,
  ],
  providers: [
    PrismaService,
    AuthService,
    MfaService,
    DbService,
    StateService,
    JobQueue,
    PdfRenderer,
    CompaniesService,
    AuditService,
    BranchesService,
    SequencesService,
    SettingsService,
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
