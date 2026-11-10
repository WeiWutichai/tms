import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuditService } from './audit/audit.service';
import { EntitlementService } from './modules/entitlements/entitlement.service';
import { PriceFieldInterceptor } from './common/price-fields';
import { AuthController } from './auth/auth.controller';
import { MfaController } from './auth/mfa.controller';
import { PasswordController } from './auth/password.controller';
import { PasswordPolicy } from './auth/password-policy';
import { MfaService } from './auth/mfa.service';
import { BranchesController } from './modules/branches/branches.controller';
import { BranchesService } from './modules/branches/branches.service';
import { SequencesController } from './modules/sequences/sequences.controller';
import { SequencesService } from './modules/sequences/sequences.service';
import { AuditController } from './audit/audit.controller';
import { DocumentsController } from './modules/documents/documents.controller';
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
import { ProfileController } from './modules/me/profile.controller';
import { UsersController } from './modules/users/users.controller';
import { UserLifecycleController } from './modules/users/user-lifecycle.controller';
import { PdfRenderer } from './pdf/pdf-renderer';
import { StateService } from './state/state.service';

@Module({
  controllers: [
    AuthController,
    MfaController,
    PasswordController,
    HealthController,
    MeController,
    ProfileController,
    CompaniesController,
    UsersController,
    UserLifecycleController,
    BranchesController,
    SequencesController,
    AuditController,
    DocumentsController,
    SettingsController,
    JobsController,
  ],
  providers: [
    PrismaService,
    AuthService,
    MfaService,
    PasswordPolicy,
    EntitlementService,
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
    // ลำดับสำคัญ: ราคา (นอกสุด) → idempotency → transaction (ใน)
    // ST1-T13: ตัด field ราคาตามสิทธิ์ของ "ผู้เรียกปัจจุบัน" — อยู่นอกสุด เพื่อให้ response ที่ replay จาก
    // Idempotency-Key (เก็บแบบเต็ม) ถูกตัดตามคนที่เรียกซ้ำ ไม่ใช่ตามคนแรก
    { provide: APP_INTERCEPTOR, useClass: PriceFieldInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TransactionInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('{*path}');
  }
}
