import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuditService } from './audit/audit.service';
import { MagicLinkService } from './modules/links/magic-link.service';
import { PublicRateLimitMiddleware } from './http/public-rate-limit.middleware';
import { BotProtectionService } from './http/public-entry/bot-protection';
import { PublicEntryGuard } from './http/public-entry/public-entry.guard';
import { RateLimitGuard } from './http/rate-limit/rate-limit.guard';
import { ApiVersionInterceptor } from './http/api-version/api-version.interceptor';
import { RateLimitService } from './http/rate-limit/rate-limit.service';
import { EntitlementService } from './modules/entitlements/entitlement.service';
import { PriceFieldInterceptor } from './common/price-fields';
import { AuthController } from './auth/auth.controller';
import { MfaController } from './auth/mfa.controller';
import { PasswordController } from './auth/password.controller';
import { PasswordResetController, PasswordResetService } from './auth/password-reset.controller';
import { SignupController } from './modules/signup/signup.controller';
import { SignupService } from './modules/signup/signup.service';
import { SignupCompanyService } from './modules/signup/signup-company.service';
import { SignupCompleteService } from './modules/signup/signup-complete.service';
import { CompanyLookupService } from './modules/signup/company-lookup/company-lookup.service';
import { OtpChannelService } from './modules/signup/otp-channel';
import { SignupEnabledMiddleware } from './modules/signup/signup-enabled.middleware';
import { EmailDispatcher, EmailService } from './modules/email/email.service';
import { NotificationService } from './modules/notifications/notification.service';
import { NotificationEvents } from './modules/notifications/notification-events';
import { DailyDigestService } from './modules/notifications/daily-digest.service';
import {
  NotificationPreferencesController,
  NotificationPreferencesService,
} from './modules/notifications/notification-preferences';
import {
  MessagesController,
  MessagingSettingsController,
} from './modules/messaging/messaging.controller';
import { MessagingService } from './modules/messaging/messaging.service';
import { MessagingProviders } from './modules/messaging/messaging.providers';
import { MessageDispatcher } from './modules/messaging/message-dispatcher';
import { OutboxDispatcher } from './modules/integration/outbox.dispatcher';
import { OutboxService } from './modules/integration/outbox.service';
import { OutboxSinkRegistry } from './modules/integration/outbox-sink.registry';
import { NotificationsController } from './modules/notifications/notifications.controller';
import { ImportRegistry } from './modules/imports/import-spec';
import { ImportService } from './modules/imports/import.service';
import { ImportsController } from './modules/imports/imports.controller';
import { MasterImports } from './modules/imports/master-imports';
import { AccountingExportController } from './modules/accounting-export/accounting-export.controller';
import { AccountingExportService } from './modules/accounting-export/accounting-export.service';
import { FileExportAdapterRegistry } from './modules/accounting-export/file-export-adapter';
import { ExportRegistry } from './modules/exports/export-spec';
import { ExportsController } from './modules/exports/exports.controller';
import { ExportsService } from './modules/exports/exports.service';
import { ListExports } from './modules/exports/list-exports';
import { SampleDataController } from './modules/sample-data/sample-data.controller';
import { SampleDataService } from './modules/sample-data/sample-data.service';
import { SetupChecklistController } from './modules/setup/setup.controller';
import { PlatformAuthController } from './platform/platform-auth.controller';
import { PlatformConnectorsController } from './platform/platform-connectors.controller';
import { PublicPlansController } from './modules/entitlements/public-plans.controller';
import { PlatformPlansController } from './platform/platform-plans.controller';
import { PlatformSettingsController } from './platform/platform-settings.controller';
import { PlatformSettingsService } from './platform/platform-settings.service';
import { TenantLifecycleService } from './modules/tenants/tenant-lifecycle.service';
import { ReadOnlyTripGate } from './modules/tenants/read-only-gate';
import { PlatformTenantsController } from './platform/platform-tenants.controller';
import { PlatformAuditController } from './platform/platform-audit.controller';
import {
  PlatformInvitationController,
  PlatformTeamController,
} from './platform/platform-team.controller';
import { PlatformUsageController } from './platform/platform-usage.controller';
import { PlatformApiUsageController } from './platform/platform-api-usage.controller';
import { UsageController } from './modules/usage/usage.controller';
import { UsageFinalizeService } from './modules/usage/usage-finalize.service';
import { apiUsageMiddleware } from './modules/usage/api-usage-meter';
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
import { PodChecklistService } from './modules/pod/pod-checklist.service';
import { PodController } from './modules/pod/pod.controller';
import { PodService } from './modules/pod/pod.service';
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
import { ApiKeysController } from './modules/api-keys/api-keys.controller';
import { ApiKeyAuthService } from './modules/api-keys/api-key-auth.service';
import { SandboxService } from './modules/sandbox/sandbox.service';
import { TestEventsController, TestEventsService } from './modules/sandbox/test-events.controller';
import { ApiKeysService } from './modules/api-keys/api-keys.service';
import { WebhooksController } from './modules/webhooks/webhooks.controller';
import { WebhooksService } from './modules/webhooks/webhooks.service';
import { WebhookEngine } from './modules/webhooks/webhook-engine';
import { WebhookSink } from './modules/webhooks/webhook.sink';
import {
  ConnectorsController,
  ConnectorsEffectiveController,
} from './modules/erp/connectors.controller';
import { ConnectorsService } from './modules/erp/connectors.service';
import { ErpMasterCodesController } from './modules/erp/erp-master-codes.controller';
import { ErpMasterCodesService } from './modules/erp/erp-master-codes.service';
import { CarrierErpCodesController } from './modules/erp/carrier-erp-codes.controller';
import { CustomerErpCodesController } from './modules/erp/customer-erp-codes.controller';
import { ExternalMappingService } from './modules/erp/external-mapping.service';
import { ErpDocumentWarningsService } from './modules/erp/erp-document-warnings';
import { InboundWebhookController } from './modules/erp/inbound-webhook.controller';
import { InboundWebhookService } from './modules/erp/inbound-webhook.service';
import { ConnectorResolver } from './modules/erp/connector-resolver';
import { SystemOfRecordPolicy } from './modules/erp/system-of-record.policy';
import { ErpAdapterRegistry } from './modules/erp/erp-adapter.registry';
import { ErpAdapterSink } from './modules/erp/erp-adapter.sink';
import { ErpSyncService } from './modules/erp/erp-sync.service';
import { ConnectorQueueService } from './modules/erp/connector-queue';
import { ConnectorMetricsService } from './modules/erp/connector-metrics';
import { ErpInboundEffects } from './modules/erp/erp-inbound-effects';
import { PaymentStatusPullService } from './modules/erp/payment-status-pull.service';
import { DocumentReconcileService } from './modules/erp/document-reconcile.service';
import { ReconcileController } from './modules/erp/reconcile.controller';
import { ReconcileCloseService } from './modules/erp/reconcile-close.service';
import { ReconcileResultsService } from './modules/erp/reconcile-results.service';
import { PeriodCloseReportService } from './modules/erp/period-close-report.service';
import { ErpAdaptersBootstrap } from './erp-adapters';
import {
  EventsController,
  WebhookDeliveriesController,
} from './modules/webhooks/webhook-ops.controller';
import { WebhookOpsService } from './modules/webhooks/webhook-ops.service';
import { WebhookRetentionService } from './modules/webhooks/webhook-retention';
import { RetentionService } from './modules/retention/retention.service';
import { ReasonCodesController } from './modules/reason-codes/reason-codes.controller';
import { ReasonCodesService } from './modules/reason-codes/reason-codes.service';
import {
  CarrierRecentPricesController,
  RateCardsController,
} from './modules/rate-cards/rate-cards.controller';
import { RateCardsService } from './modules/rate-cards/rate-cards.service';
import { PricingService } from './modules/pricing/pricing.service';
import { OrderMatchingService } from './modules/orders/order-matching.service';
import { OrderIntakeService } from './modules/orders/order-intake.service';
import { DeliveryOrderService } from './modules/delivery-orders/delivery-order.service';
import {
  DeliveryOrderRevertController,
  DeliveryOrdersController,
} from './modules/delivery-orders/delivery-orders.controller';
import { DeliveryOrderReturnService } from './modules/delivery-orders/delivery-order-return.service';
import { DeliveryOrderRevertService } from './modules/delivery-orders/delivery-order-revert.service';
import { OrderStateService } from './modules/orders/order-state.service';
import { TripService } from './modules/trips/trip.service';
import { SubconHireService } from './modules/trips/subcon-hire.service';
import { SubconOfferService } from './modules/trips/subcon-offer.service';
import { OfferLinks } from './modules/trips/offer-links';
import { PodLinkPublicController } from './modules/trips/pod-link.controller';
import {
  CustomerTrackingController,
  DeliveryOrderTrackingController,
  TrackingPublicController,
} from './modules/tracking/tracking.controller';
import { TrackingService } from './modules/tracking/tracking.service';
import { PodLinkService } from './modules/trips/pod-link.service';
import {
  AttachmentsService,
  CarrierAttachmentsController,
  DriverAttachmentsController,
} from './modules/attachments/attachments.controller';
import {
  SubconOfferPublicController,
  SubconOffersController,
  TripOffersController,
} from './modules/trips/subcon-offer.controller';
import { SubconOfferListService } from './modules/trips/subcon-offer-list.service';
import { TripsController } from './modules/trips/trips.controller';
import {
  DoSurchargesController,
  TripCostsController,
  TripFieldChargesController,
} from './modules/field-charges/field-charges.controller';
import { FieldChargesService } from './modules/field-charges/field-charges.service';
import {
  DeliveryOrderRevenueLinesController,
  OrderRevenueLinesController,
  RevenueLinesController,
} from './modules/revenue-lines/revenue-lines.controller';
import { RevenueLinesService } from './modules/revenue-lines/revenue-lines.service';
import { SettlementsController } from './modules/settlements/settlements.controller';
import { SettlementReviewPublicController } from './modules/settlements/settlement-review.controller';
import {
  CarrierPayLinkController,
  CarrierPayLinkPublicController,
} from './modules/settlements/carrier-pay-link.controller';
import { CarrierPayLinkService } from './modules/settlements/carrier-pay-link.service';
import { SettlementReviewService } from './modules/settlements/settlement-review.service';
import {
  DeliveryOrderReleaseController,
  InvoicesController,
} from './modules/invoices/invoices.controller';
import { BillingQueueService } from './modules/invoices/billing-queue.service';
import { BillingReleaseService } from './modules/invoices/billing-release.service';
import { InvoicesService } from './modules/invoices/invoices.service';
import { InvoiceRunsController } from './modules/invoices/invoice-runs.controller';
import { InvoiceRunService } from './modules/invoices/invoice-run.service';
import { PaymentsController } from './modules/payments/payments.controller';
import { PaymentsService } from './modules/payments/payments.service';
import { AgingService } from './modules/payments/aging.service';
import { ReportsController } from './modules/reports/reports.controller';
import { UnbilledReportService } from './modules/reports/unbilled-report.service';
import { RevenueReportService } from './modules/reports/revenue-report.service';
import { UnbilledReminderService } from './modules/reminders/unbilled-reminder.service';
import { InvoicePdfService } from './modules/invoices/invoice-pdf.service';
import { InvoiceCancelService } from './modules/invoices/invoice-cancel.service';
import { InvoiceStatusService } from './modules/invoices/invoice-status.service';
import { InvoiceFinalizeService } from './modules/invoices/invoice-finalize.service';
import { DocumentEmailService } from './modules/invoices/document-email.service';
import { InvoiceBillingGuard } from './modules/invoices/billing-guard.service';
import { BillingNotesController } from './modules/billing-notes/billing-notes.controller';
import { BillingNotesService } from './modules/billing-notes/billing-notes.service';
import { SettlementQueueService } from './modules/settlements/settlement-queue.service';
import { SettlementComparisonService } from './modules/settlements/settlement-comparison.service';
import { SettlementsService } from './modules/settlements/settlements.service';
import { SettlementPdfService } from './modules/settlements/settlement-pdf.service';
import { StopEventFlagsController } from './modules/stops/stop-event-flags.controller';
import { StopsController, TripEventsController } from './modules/stops/stops.controller';
import { StopEventsService } from './modules/stops/stop-events.service';
import { StopProjectionService } from './modules/stops/stop-projection.service';
import { PlanningController } from './modules/planning/planning.controller';
import { PlanningService } from './modules/planning/planning.service';
import { ScheduleController } from './modules/schedule/schedule.controller';
import { ScheduleService } from './modules/schedule/schedule.service';
import { BoardPreferencesService } from './modules/planning/board-preferences.service';
import { EligibilityService } from './modules/planning/eligibility.service';
import { OrdersController } from './modules/orders/orders.controller';
import { OrderResourcesController } from './modules/orders/order-resources.controller';
import { OrderBillingService } from './modules/orders/order-billing.service';
import { OrdersService } from './modules/orders/orders.service';
import { OrdersBulkController } from './modules/orders/orders-bulk.controller';
import { OrderBulkService } from './modules/orders/order-bulk.service';
import { OrderLockService } from './modules/orders/order-lock.service';
import { OrderTemplatesController } from './modules/orders/order-templates.controller';
import { OrderTemplatesService } from './modules/orders/order-templates.service';
import { OrderImports } from './modules/orders/order.import';
import { VehicleTypesController } from './modules/vehicle-types/vehicle-types.controller';
import { VehicleTypesService } from './modules/vehicle-types/vehicle-types.service';
import { CarriersController } from './modules/carriers/carriers.controller';
import { CarriersService } from './modules/carriers/carriers.service';
import { VehicleDocumentsController } from './modules/vehicle-documents/vehicle-documents.controller';
import { VehicleDocumentsService } from './modules/vehicle-documents/vehicle-documents.service';
import { Clock } from './common/clock';
import { SubconTimeoutService } from './modules/trips/subcon-timeout.service';
import { DepreciationService } from './modules/depreciation/depreciation.service';
import { ConnectorIntakeService } from './modules/connectors/connector-intake.service';
import { OrderSourceRegistry } from './modules/connectors/order-source-registry';
import { ConnectorPullScheduler } from './modules/connectors/connector-pull.scheduler';
import { DriversController } from './modules/drivers/drivers.controller';
import {
  CarrierDocsController,
  CarrierDocsPublicController,
} from './modules/carrier-docs/carrier-docs.controller';
import { CarrierDocsService } from './modules/carrier-docs/carrier-docs.service';
import { DriversService } from './modules/drivers/drivers.service';
import { VehiclesController } from './modules/vehicles/vehicles.controller';
import { VehiclesService } from './modules/vehicles/vehicles.service';
import { GeoService } from './modules/geo/geo.service';
import { CompaniesService } from './modules/companies/companies.service';
import { HealthController } from './modules/health/health.controller';
import {
  MonitoringController,
  PlatformMonitoringController,
} from './modules/monitoring/monitoring.controller';
import { MonitorCollector } from './modules/monitoring/monitor-collector';
import { AlertEvaluator } from './modules/monitoring/alert-evaluator';
import { AvailabilityService } from './modules/monitoring/availability.service';
import { MonitorScheduler } from './modules/monitoring/monitor-scheduler';
import { httpMetricsMiddleware } from './modules/monitoring/http-metrics';
import { JobsController } from './modules/jobs/jobs.controller';
import { MeController } from './modules/me/me.controller';
import { NavBadgesController, NavBadgesService } from './modules/me/nav-badges.controller';
import { ProfileController } from './modules/me/profile.controller';
import { SavedViewsController } from './modules/saved-views/saved-views.controller';
import { SavedViewsService } from './modules/saved-views/saved-views.service';
import { SearchController } from './modules/search/search.controller';
import { SearchService } from './modules/search/search.service';
import { UsersController } from './modules/users/users.controller';
import { UserLifecycleController } from './modules/users/user-lifecycle.controller';
import { PdfRenderer } from './pdf/pdf-renderer';
import {
  TripSheetsController,
  TripSheetsPublicController,
} from './modules/trip-sheets/trip-sheets.controller';
import { TripSheetsService } from './modules/trip-sheets/trip-sheets.service';
import { TripSheetLinks } from './modules/trip-sheets/sheet-links';
import { StateService } from './state/state.service';
import { ExpiryReminderService } from './modules/reminders/expiry-reminder.service';
import { PaymentDueReminderService } from './modules/reminders/payment-due-reminder.service';

@Module({
  controllers: [
    AuthController,
    MfaController,
    PasswordController,
    PasswordResetController,
    SignupController,
    InvitationAcceptController,
    InvitationsController,
    NotificationsController,
    NotificationPreferencesController,
    ImportsController,
    ExportsController,
    SetupChecklistController,
    SampleDataController,
    PlatformAuthController,
    PlatformTenantsController,
    PlatformUsageController,
    PlatformApiUsageController,
    PlatformPlansController,
    PublicPlansController,
    PlatformSettingsController,
    PlatformConnectorsController,
    PlatformTeamController,
    PlatformInvitationController,
    PlatformAuditController,
    ImpersonationController,
    HealthController,
    MonitoringController,
    PlatformMonitoringController,
    MeController,
    NavBadgesController,
    ProfileController,
    SavedViewsController,
    SearchController,
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
    OrdersBulkController,
    OrdersController,
    OrderResourcesController,
    OrderTemplatesController,
    SitesController,
    RoutesController,
    ProductsController,
    UnitsController,
    VehicleTypesController,
    ServiceItemsController,
    ReasonCodesController,
    ApiKeysController,
    WebhooksController,
    TestEventsController,
    ConnectorsEffectiveController,
    ConnectorsController,
    ErpMasterCodesController,
    CustomerErpCodesController,
    CarrierErpCodesController,
    ReconcileController,
    InboundWebhookController,
    WebhookDeliveriesController,
    EventsController,
    RateCardsController,
    DeliveryOrdersController,
    DeliveryOrderRevertController,
    PodController,
    TripsController,
    TripFieldChargesController,
    OrderRevenueLinesController,
    RevenueLinesController,
    SettlementsController,
    InvoicesController,
    InvoiceRunsController,
    PaymentsController,
    ReportsController,
    BillingNotesController,
    DeliveryOrderReleaseController,
    DeliveryOrderRevenueLinesController,
    DoSurchargesController,
    TripCostsController,
    StopsController,
    TripEventsController,
    StopEventFlagsController,
    TripOffersController,
    SubconOffersController,
    SubconOfferPublicController,
    PodLinkPublicController,
    SettlementReviewPublicController,
    CarrierPayLinkController,
    DriverAttachmentsController,
    CarrierAttachmentsController,
    CarrierPayLinkPublicController,
    TrackingPublicController,
    DeliveryOrderTrackingController,
    CustomerTrackingController,
    TripSheetsController,
    TripSheetsPublicController,
    PlanningController,
    ScheduleController,
    CarrierRecentPricesController,
    CarriersController,
    VehiclesController,
    UsageController,
    DriversController,
    VehicleDocumentsController,
    CarrierDocsController,
    CarrierDocsPublicController,
    MessagesController,
    MessagingSettingsController,
    AccountingExportController,
  ],
  providers: [
    PrismaService,
    AuthService,
    MfaService,
    PasswordPolicy,
    PasswordResetService,
    SignupService,
    SignupCompanyService,
    SignupCompleteService,
    CompanyLookupService,
    OtpChannelService,
    InvitationAcceptService,
    EmailService,
    EmailDispatcher,
    NotificationService,
    NotificationEvents,
    NotificationPreferencesService,
    DailyDigestService,
    ImportRegistry,
    ImportService,
    MasterImports,
    ExportRegistry,
    ExportsService,
    ListExports,
    FileExportAdapterRegistry,
    AccountingExportService,
    EntitlementService,
    PlatformSettingsService,
    TenantLifecycleService,
    ReadOnlyTripGate,
    MagicLinkService,
    DbService,
    StateService,
    JobQueue,
    PdfRenderer,
    CompaniesService,
    CustomersService,
    PodChecklistService,
    PodService,
    SitesService,
    RoutesService,
    CompatibilityService,
    AssignabilityService,
    ProductsService,
    UnitsService,
    VehicleTypesService,
    ServiceItemsService,
    ReasonCodesService,
    ApiKeysService,
    ApiKeyAuthService,
    SandboxService,
    TestEventsService,
    RateCardsService,
    PricingService,
    OrderIntakeService,
    SampleDataService,
    OrderBillingService,
    OrderMatchingService,
    DeliveryOrderService,
    DeliveryOrderReturnService,
    DeliveryOrderRevertService,
    OrderStateService,
    TripService,
    FieldChargesService,
    RevenueLinesService,
    SettlementQueueService,
    SettlementsService,
    SettlementReviewService,
    CarrierPayLinkService,
    SettlementComparisonService,
    SettlementPdfService,
    BillingQueueService,
    BillingReleaseService,
    InvoiceBillingGuard,
    InvoicesService,
    InvoicePdfService,
    InvoiceFinalizeService,
    InvoiceCancelService,
    InvoiceStatusService,
    DocumentEmailService,
    PaymentsService,
    AgingService,
    UnbilledReportService,
    RevenueReportService,
    BillingNotesService,
    InvoiceRunService,
    StopEventsService,
    StopProjectionService,
    SubconHireService,
    SubconOfferService,
    SubconOfferListService,
    SubconTimeoutService,
    OfferLinks,
    PodLinkService,
    AttachmentsService,
    TrackingService,
    TripSheetsService,
    TripSheetLinks,
    PlanningService,
    NavBadgesService,
    ScheduleService,
    BoardPreferencesService,
    SavedViewsService,
    SearchService,
    EligibilityService,
    OrdersService,
    OrderBulkService,
    OrderLockService,
    OrderTemplatesService,
    OrderImports,
    OrderSourceRegistry,
    ConnectorIntakeService,
    ConnectorPullScheduler,
    CarriersService,
    VehiclesService,
    DriversService,
    CarrierDocsService,
    MessagingProviders,
    MessagingService,
    MessageDispatcher,
    OutboxSinkRegistry,
    OutboxService,
    OutboxDispatcher,
    WebhookEngine,
    WebhookSink,
    ErpAdapterRegistry,
    ConnectorResolver,
    SystemOfRecordPolicy,
    ConnectorsService,
    ErpMasterCodesService,
    ExternalMappingService,
    ErpDocumentWarningsService,
    InboundWebhookService,
    ErpAdapterSink,
    ErpSyncService,
    ConnectorQueueService,
    ConnectorMetricsService,
    ErpInboundEffects,
    ReconcileResultsService,
    PeriodCloseReportService,
    ReconcileCloseService,
    PaymentStatusPullService,
    DocumentReconcileService,
    ErpAdaptersBootstrap,
    WebhooksService,
    WebhookOpsService,
    WebhookRetentionService,
    RetentionService,
    VehicleDocumentsService,
    Clock,
    MonitorCollector,
    AlertEvaluator,
    AvailabilityService,
    MonitorScheduler,
    ExpiryReminderService,
    PaymentDueReminderService,
    UnbilledReminderService,
    DepreciationService,
    UsageFinalizeService,
    GeoService,
    AuditService,
    BranchesService,
    SequencesService,
    SettingsService,
    RateLimitService,
    { provide: APP_GUARD, useClass: AuthGuard },
    // ST7-T08: หลัง AuthGuard (ต้องรู้ tenant/principal ก่อน) — Nest เรียก guard ตามลำดับที่ลงทะเบียน
    { provide: APP_GUARD, useClass: RateLimitGuard },
    // P1-ST2-T08: เพดานสมัคร/OTP + ด่านกันบอทของ `/v1/public/signup/*` (เฉพาะ handler ที่ติด decorator) — ก่อน interceptor/transaction
    BotProtectionService,
    { provide: APP_GUARD, useClass: PublicEntryGuard },
    { provide: APP_FILTER, useClass: ProblemFilter },
    // ลำดับสำคัญ: เวอร์ชัน (นอกสุด) → ราคา → idempotency → transaction (ใน)
    // ST7-T07: แปลง request/response ตาม X-Api-Version — นอกสุดเพื่อให้ response ที่ replay ถูกแปลงตามผู้เรียกปัจจุบัน
    { provide: APP_INTERCEPTOR, useClass: ApiVersionInterceptor },
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
    // ST9-T19 ตัวนับคำขอ HTTP (Prometheus) — นับตอนส่งคำตอบเสร็จ ตามแม่แบบ route
    consumer.apply(httpMetricsMiddleware).forRoutes('{*path}');
    // P1-ST1-T07 นับ API calls ของ API key / OAuth client (ในหน่วยความจำ → flush แบบ batch — api-usage-meter.ts)
    consumer.apply(apiUsageMiddleware).forRoutes('{*path}');
    // ST1-T06: ลิงก์สาธารณะ (ไม่ login) จำกัดอัตราต่อ IP
    // P1-ST2-T03: ปิดการสมัคร (`SIGNUP_ENABLED`) = 404 ก่อนตัวจำกัด/ฐานข้อมูล
    consumer.apply(SignupEnabledMiddleware).forRoutes('public/signup', 'public/signup/{*path}');
    consumer.apply(PublicRateLimitMiddleware).forRoutes('public/{*path}');
    // ST4-T14 หน้าติดตาม → ST9-T13 ทุกลิงก์สาธารณะ (NFR-135): ห้าม index/ส่ง referrer ทุกคำตอบ (รวม 404/429 ที่ออกก่อนถึง handler)
    // — token อยู่ใน URL · PDF ที่เปิด inline (ใบคุมรถ/ใบจ่ายเงิน) ก็ห้าม index
    consumer
      .apply((_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.setHeader('Referrer-Policy', 'no-referrer');
        next();
      })
      .forRoutes('public/{*path}');
    // ST1-T24: login ของ Console จำกัดต่อ IP ด้วย (กันล็อกบัญชีทีมงานซ้ำ ๆ)
    consumer.apply(PublicRateLimitMiddleware).forRoutes('platform/auth/{*path}');
    // ST9-T13 R2 (L-07): ตรวจ/รับคำเชิญ (ไม่ login) จำกัดต่อ IP แบบเดียวกับลิงก์สาธารณะ (กลุ่ม `invite`)
    // P1-ST2-T08: ทั้ง `/v1/auth/*` (login, 2FA, step-up, ลืม/ตั้งรหัสผ่าน — กลุ่ม `auth`) จำกัดต่อ IP ก่อนถึงฐานข้อมูล
    // (ลงทะเบียนครั้งเดียวครอบคำเชิญด้วย — publicBucketGroup แยกตัวนับ ไม่นับซ้ำ)
    consumer.apply(PublicRateLimitMiddleware).forRoutes('auth/{*path}');
  }
}
