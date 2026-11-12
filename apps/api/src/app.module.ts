import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuditService } from './audit/audit.service';
import { MagicLinkService } from './modules/links/magic-link.service';
import { PublicRateLimitMiddleware } from './http/public-rate-limit.middleware';
import { EntitlementService } from './modules/entitlements/entitlement.service';
import { PriceFieldInterceptor } from './common/price-fields';
import { AuthController } from './auth/auth.controller';
import { MfaController } from './auth/mfa.controller';
import { PasswordController } from './auth/password.controller';
import { PasswordResetController, PasswordResetService } from './auth/password-reset.controller';
import { EmailDispatcher, EmailService } from './modules/email/email.service';
import { NotificationService } from './modules/notifications/notification.service';
import { NotificationsController } from './modules/notifications/notifications.controller';
import { ImportRegistry } from './modules/imports/import-spec';
import { ImportService } from './modules/imports/import.service';
import { ImportsController } from './modules/imports/imports.controller';
import { MasterImports } from './modules/imports/master-imports';
import { SetupChecklistController } from './modules/setup/setup.controller';
import { PlatformAuthController } from './platform/platform-auth.controller';
import { PlatformTenantsController } from './platform/platform-tenants.controller';
import { ImpersonationController } from './platform/impersonation.controller';
import {
  InvitationAcceptController,
  InvitationAcceptService,
} from './auth/invitation-accept.controller';
import { InvitationsController } from './modules/users/invitations.controller';
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
import { CustomersController } from './modules/customers/customers.controller';
import { CustomersService } from './modules/customers/customers.service';
import { SitesController } from './modules/sites/sites.controller';
import { ProductsController } from './modules/products/products.controller';
import { ProductsService } from './modules/products/products.service';
import { UnitsController } from './modules/products/units.controller';
import { UnitsService } from './modules/products/units.service';
import { RoutesController } from './modules/routes/routes.controller';
import { RoutesService } from './modules/routes/routes.service';
import { CompatibilityService } from './modules/compatibility/compatibility.service';
import { AssignabilityService } from './modules/assignability/assignability.service';
import { SitesService } from './modules/sites/sites.service';
import { ServiceItemsController } from './modules/service-items/service-items.controller';
import { ServiceItemsService } from './modules/service-items/service-items.service';
import { ReasonCodesController } from './modules/reason-codes/reason-codes.controller';
import { ReasonCodesService } from './modules/reason-codes/reason-codes.service';
import {
  CarrierRecentPricesController,
  RateCardsController,
} from './modules/rate-cards/rate-cards.controller';
import { RateCardsService } from './modules/rate-cards/rate-cards.service';
import { PricingService } from './modules/pricing/pricing.service';
import { VehicleTypesController } from './modules/vehicle-types/vehicle-types.controller';
import { VehicleTypesService } from './modules/vehicle-types/vehicle-types.service';
import { CarriersController } from './modules/carriers/carriers.controller';
import { CarriersService } from './modules/carriers/carriers.service';
import { VehicleDocumentsController } from './modules/vehicle-documents/vehicle-documents.controller';
import { VehicleDocumentsService } from './modules/vehicle-documents/vehicle-documents.service';
import { DriversController } from './modules/drivers/drivers.controller';
import { DriversService } from './modules/drivers/drivers.service';
import { VehiclesController } from './modules/vehicles/vehicles.controller';
import { VehiclesService } from './modules/vehicles/vehicles.service';
import { GeoService } from './modules/geo/geo.service';
import { CompaniesService } from './modules/companies/companies.service';
import { HealthController } from './modules/health/health.controller';
import { JobsController } from './modules/jobs/jobs.controller';
import { MeController } from './modules/me/me.controller';
import { ProfileController } from './modules/me/profile.controller';
import { UsersController } from './modules/users/users.controller';
import { UserLifecycleController } from './modules/users/user-lifecycle.controller';
import { PdfRenderer } from './pdf/pdf-renderer';
import { StateService } from './state/state.service';
import { Clock } from './common/clock';
import { ExpiryReminderService } from './modules/reminders/expiry-reminder.service';

@Module({
  controllers: [
    AuthController,
    MfaController,
    PasswordController,
    PasswordResetController,
    InvitationAcceptController,
    InvitationsController,
    NotificationsController,
    ImportsController,
    SetupChecklistController,
    PlatformAuthController,
    PlatformTenantsController,
    ImpersonationController,
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
    CustomersController,
    SitesController,
    RoutesController,
    ProductsController,
    UnitsController,
    VehicleTypesController,
    ServiceItemsController,
    ReasonCodesController,
    RateCardsController,
    CarrierRecentPricesController,
    CarriersController,
    VehiclesController,
    DriversController,
    VehicleDocumentsController,
  ],
  providers: [
    PrismaService,
    AuthService,
    MfaService,
    PasswordPolicy,
    PasswordResetService,
    InvitationAcceptService,
    EmailService,
    EmailDispatcher,
    NotificationService,
    ImportRegistry,
    ImportService,
    MasterImports,
    EntitlementService,
    MagicLinkService,
    DbService,
    StateService,
    JobQueue,
    PdfRenderer,
    CompaniesService,
    CustomersService,
    SitesService,
    RoutesService,
    CompatibilityService,
    AssignabilityService,
    ProductsService,
    UnitsService,
    VehicleTypesService,
    ServiceItemsService,
    ReasonCodesService,
    RateCardsService,
    PricingService,
    CarriersService,
    VehiclesService,
    DriversService,
    VehicleDocumentsService,
    Clock,
    ExpiryReminderService,
    GeoService,
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
    // ST1-T06: ลิงก์สาธารณะ (ไม่ login) จำกัดอัตราต่อ IP
    consumer.apply(PublicRateLimitMiddleware).forRoutes('public/{*path}');
    // ST1-T24: login ของ Console จำกัดต่อ IP ด้วย (กันล็อกบัญชีทีมงานซ้ำ ๆ)
    consumer.apply(PublicRateLimitMiddleware).forRoutes('platform/auth/{*path}');
  }
}
