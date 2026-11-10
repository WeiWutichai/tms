-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('INVITED', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "doc_type" AS ENUM ('SO', 'TRIP', 'DO', 'BN', 'INV', 'TXINV', 'RCP', 'CN', 'DN', 'STL', 'WHT', 'WO', 'INC');

-- CreateEnum
CREATE TYPE "reset_policy" AS ENUM ('MONTHLY', 'YEARLY', 'NEVER');

-- CreateEnum
CREATE TYPE "active_status" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "billing_cycle" AS ENUM ('PER_DO', 'WEEKLY', 'MONTHLY', 'MANUAL');

-- CreateEnum
CREATE TYPE "tax_invoice_mode" AS ENUM ('ON_PAYMENT', 'ON_ISSUE');

-- CreateEnum
CREATE TYPE "geocode_status" AS ENUM ('OK', 'PENDING', 'FAILED');

-- CreateEnum
CREATE TYPE "carrier_entity_type" AS ENUM ('INDIVIDUAL', 'JURISTIC');

-- CreateEnum
CREATE TYPE "ownership" AS ENUM ('OWN', 'SUBCONTRACT');

-- CreateEnum
CREATE TYPE "vehicle_status" AS ENUM ('READY', 'MAINTENANCE', 'PARKED', 'RETIRED');

-- CreateEnum
CREATE TYPE "employment_type" AS ENUM ('EMPLOYEE_SALARIED', 'EMPLOYEE_PER_TRIP', 'CARRIER_DRIVER');

-- CreateEnum
CREATE TYPE "vehicle_doc_type" AS ENUM ('INSURANCE', 'ACT', 'ANNUAL_TAX', 'INSPECTION', 'OPERATING_LICENCE', 'GPS_DLT', 'OTHER');

-- CreateEnum
CREATE TYPE "vat_type" AS ENUM ('VAT_7', 'EXEMPT_TRANSPORT', 'ZERO_RATED');

-- CreateEnum
CREATE TYPE "rate_side" AS ENUM ('SELL', 'BUY');

-- CreateEnum
CREATE TYPE "pricing_model" AS ENUM ('PER_TRIP', 'PER_KM', 'PER_TON', 'PER_CBM', 'PER_UNIT', 'PER_DAY');

-- CreateEnum
CREATE TYPE "rate_status" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'RETIRED');

-- CreateEnum
CREATE TYPE "reason_category" AS ENUM ('ORDER_HOLD', 'DELIVERY_FAILED', 'REJECTED_BY_RECEIVER', 'POD_MISSING', 'CREDIT_NOTE', 'DEBIT_NOTE', 'SETTLEMENT_DISPUTE', 'OVERRIDE', 'CANCEL');

-- CreateEnum
CREATE TYPE "order_source" AS ENUM ('MANUAL', 'IMPORT', 'API', 'PORTAL', 'CONNECTOR');

-- CreateEnum
CREATE TYPE "so_status" AS ENUM ('DRAFT', 'RECEIVED', 'ON_HOLD', 'PLANNED', 'IN_TRANSIT', 'PARTIALLY_DELIVERED', 'DELIVERED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "stop_type" AS ENUM ('PICKUP', 'DELIVERY', 'RETURN');

-- CreateEnum
CREATE TYPE "trip_status" AS ENUM ('PLANNING', 'OFFERED', 'ASSIGNED', 'DISPATCHED', 'IN_PROGRESS', 'COMPLETED', 'COSTED', 'SETTLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "assignment_status" AS ENUM ('OFFERED', 'ACCEPTED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "stop_status" AS ENUM ('PENDING', 'ARRIVED', 'COMPLETED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "do_status" AS ENUM ('DRAFT', 'PLANNED', 'PICKED_UP', 'DISPATCHED', 'DELIVERED', 'FAILED', 'RETURNED', 'POD_PENDING', 'UNBILLED', 'BILLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "stop_event_type" AS ENUM ('ARRIVE', 'DEPART', 'COMPLETE', 'FAIL');

-- AlterTable
ALTER TABLE "job" ALTER COLUMN "run_at" SET DEFAULT now();

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "password_hash" TEXT,
    "totp_secret" TEXT,
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "status" "user_status" NOT NULL DEFAULT 'INVITED',
    "last_login_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_th" TEXT NOT NULL,
    "name_en" TEXT,
    "permissions" TEXT[],
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_role" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "company_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "id" UUID NOT NULL,

    CONSTRAINT "user_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_code" CHAR(5) NOT NULL,
    "branch_label" TEXT NOT NULL,
    "address" JSONB NOT NULL,
    "hq_prints_for_all" BOOLEAN NOT NULL DEFAULT false,
    "is_default_issuer" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_sequence" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "doc_type" "doc_type" NOT NULL,
    "branch_id" UUID,
    "period_key" TEXT NOT NULL,
    "reset_policy" "reset_policy" NOT NULL DEFAULT 'MONTHLY',
    "prefix_template" TEXT NOT NULL,
    "padding" INTEGER NOT NULL DEFAULT 4,
    "next_value" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_sequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" TEXT,
    "act_as" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "request_id" TEXT,
    "ip" TEXT,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "external_id" TEXT,
    "legal_name" TEXT NOT NULL,
    "tax_id" CHAR(13),
    "branch_code" CHAR(5),
    "billing_address" JSONB NOT NULL,
    "billing_cycle" "billing_cycle" NOT NULL DEFAULT 'MONTHLY',
    "payment_term_days" INTEGER NOT NULL DEFAULT 30,
    "tax_invoice_mode" "tax_invoice_mode" NOT NULL DEFAULT 'ON_PAYMENT',
    "default_vat_type" "vat_type",
    "wht_expected_rate" DECIMAL(5,2),
    "credit_limit" DECIMAL(14,2),
    "pod_requirements" JSONB NOT NULL DEFAULT '{}',
    "default_billing_company_id" UUID,
    "status" "active_status" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_site" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID,
    "name" TEXT NOT NULL,
    "address" JSONB NOT NULL,
    "lat" DECIMAL(9,6),
    "lng" DECIMAL(9,6),
    "geocode_status" "geocode_status" NOT NULL DEFAULT 'PENDING',
    "aliases" TEXT[],
    "open_time" TEXT,
    "close_time" TEXT,
    "vehicle_type_allowed" TEXT[],
    "avg_dwell_min" INTEGER,
    "free_time_min" INTEGER,
    "contact" JSONB,
    "external_id" TEXT,
    "status" "active_status" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carrier" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "external_id" TEXT,
    "legal_name" TEXT NOT NULL,
    "entity_type" "carrier_entity_type" NOT NULL,
    "tax_id_enc" TEXT,
    "tax_id_last4" TEXT,
    "branch_code" CHAR(5),
    "wht_rate_default" DECIMAL(5,2) NOT NULL DEFAULT 1.00,
    "bank_account_enc" TEXT,
    "payment_term_days" INTEGER NOT NULL DEFAULT 30,
    "require_pod_to_pay" BOOLEAN NOT NULL DEFAULT true,
    "phone" TEXT,
    "line_contact" TEXT,
    "score" JSONB NOT NULL DEFAULT '{}',
    "status" "active_status" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carrier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_type" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_th" TEXT NOT NULL,
    "capacity_kg" DECIMAL(10,2),
    "capacity_cbm" DECIMAL(10,2),
    "min_licence_class" TEXT,
    "status" "active_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plate" TEXT NOT NULL,
    "plate_province" TEXT NOT NULL,
    "vehicle_type_id" UUID NOT NULL,
    "ownership" "ownership" NOT NULL,
    "carrier_id" UUID,
    "capacity_kg" DECIMAL(10,2),
    "capacity_cbm" DECIMAL(10,2),
    "gps_provider" TEXT,
    "gps_device_id" TEXT,
    "chassis_no" TEXT,
    "engine_no" TEXT,
    "brand" TEXT,
    "model" TEXT,
    "year" INTEGER,
    "color" TEXT,
    "fuel_type" TEXT,
    "odometer_km" DECIMAL(10,1),
    "paired_vehicle_id" UUID,
    "purchase_cost" DECIMAL(14,2),
    "purchased_on" DATE,
    "status" "vehicle_status" NOT NULL DEFAULT 'READY',
    "external_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "licence_no" TEXT,
    "licence_class" TEXT,
    "licence_expires_at" DATE,
    "employment_type" "employment_type" NOT NULL,
    "carrier_id" UUID,
    "default_vehicle_id" UUID,
    "status" "active_status" NOT NULL DEFAULT 'ACTIVE',
    "external_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_document" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "doc_type" "vehicle_doc_type" NOT NULL,
    "issuer" TEXT,
    "ref_no" TEXT,
    "coverage_class" TEXT,
    "sum_insured" DECIMAL(14,2),
    "premium" DECIMAL(14,2),
    "starts_on" DATE,
    "expires_on" DATE NOT NULL,
    "file_key" TEXT,
    "renews_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_cost" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "occurred_on" DATE NOT NULL,
    "source_type" TEXT,
    "source_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_cost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_item" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_th" TEXT NOT NULL,
    "name_en" TEXT,
    "vat_type" "vat_type" NOT NULL,
    "wht_rate" DECIMAL(5,2) NOT NULL,
    "unit_label" TEXT NOT NULL,
    "is_surcharge" BOOLEAN NOT NULL DEFAULT false,
    "default_account_code" TEXT,
    "status" "active_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_card" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "side" "rate_side" NOT NULL,
    "customer_id" UUID,
    "carrier_id" UUID,
    "origin_site_id" UUID,
    "dest_site_id" UUID,
    "origin_zone" TEXT,
    "dest_zone" TEXT,
    "vehicle_type_id" UUID,
    "pricing_model" "pricing_model" NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "min_charge" DECIMAL(14,2),
    "extra_stop_price" DECIMAL(14,2),
    "included_stops" INTEGER NOT NULL DEFAULT 1,
    "fuel_surcharge_pct" DECIMAL(5,2),
    "service_item_id" UUID NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "status" "rate_status" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_card_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reason_code" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category" "reason_category" NOT NULL,
    "code" TEXT NOT NULL,
    "label_th" TEXT NOT NULL,
    "label_en" TEXT,
    "requires_note" BOOLEAN NOT NULL DEFAULT false,
    "requires_photo" BOOLEAN NOT NULL DEFAULT false,
    "auto_reschedule" BOOLEAN NOT NULL DEFAULT false,
    "show_on_tracking" BOOLEAN NOT NULL DEFAULT false,
    "etda_code" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "status" "active_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reason_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "so_no" TEXT,
    "source" "order_source" NOT NULL,
    "external_id" TEXT,
    "customer_id" UUID,
    "billing_company_id" UUID NOT NULL,
    "customer_ref" TEXT,
    "requested_date" DATE NOT NULL,
    "vehicle_type_id" UUID,
    "status" "so_status" NOT NULL DEFAULT 'DRAFT',
    "hold_reason_code_id" UUID,
    "hold_note" TEXT,
    "source_changed_after_plan" BOOLEAN NOT NULL DEFAULT false,
    "source_diff" JSONB,
    "locked_by" TEXT,
    "locked_at" TIMESTAMPTZ(6),
    "raw_payload" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_stop" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" "stop_type" NOT NULL,
    "site_id" UUID,
    "site_text" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(6),
    "window_end" TIMESTAMPTZ(6),

    CONSTRAINT "sales_order_stop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_line" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "item_code" TEXT,
    "description" TEXT NOT NULL,
    "qty_ordered" DECIMAL(14,3) NOT NULL,
    "unit" TEXT NOT NULL,
    "weight_kg" DECIMAL(14,3),
    "cbm" DECIMAL(14,3),
    "is_dangerous" BOOLEAN NOT NULL DEFAULT false,
    "temp_min" DECIMAL(5,1),
    "temp_max" DECIMAL(5,1),

    CONSTRAINT "sales_order_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trip_no" TEXT,
    "trip_date" DATE NOT NULL,
    "vehicle_id" UUID,
    "vehicle_plate_snapshot" TEXT,
    "vehicle_type_snapshot" TEXT,
    "driver_id" UUID,
    "driver_name_snapshot" TEXT,
    "driver_phone_snapshot" TEXT,
    "driver_accepted_at" TIMESTAMPTZ(6),
    "carrier_id" UUID,
    "carrier_name_snapshot" TEXT,
    "buy_rate_snapshot" JSONB,
    "assignment_status" "assignment_status",
    "assignment_token_hash" TEXT,
    "assignment_expires_at" TIMESTAMPTZ(6),
    "planned_distance_km" DECIMAL(10,1),
    "planned_route" JSONB,
    "actual_distance_km" DECIMAL(10,1),
    "rule_warnings" JSONB NOT NULL DEFAULT '[]',
    "status" "trip_status" NOT NULL DEFAULT 'PLANNING',
    "cost_allocation_method" TEXT NOT NULL DEFAULT 'BY_WEIGHT',
    "dispatched_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_stop" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" "stop_type" NOT NULL,
    "site_id" UUID NOT NULL,
    "planned_arrival" TIMESTAMPTZ(6),
    "planned_departure" TIMESTAMPTZ(6),
    "arrived_at" TIMESTAMPTZ(6),
    "departed_at" TIMESTAMPTZ(6),
    "status" "stop_status" NOT NULL DEFAULT 'PENDING',
    "outcome" TEXT,
    "fail_reason_code_id" UUID,
    "detention_min" INTEGER,
    "pod" JSONB,
    "last_event_id" UUID,

    CONSTRAINT "trip_stop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_order" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "do_no" TEXT,
    "do_date" DATE NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "trip_id" UUID,
    "trip_stop_id" UUID,
    "origin_site_id" UUID NOT NULL,
    "dest_site_id" UUID NOT NULL,
    "weight_kg" DECIMAL(14,3),
    "cbm" DECIMAL(14,3),
    "sell_rate_snapshot" JSONB,
    "revenue_amount" DECIMAL(14,2),
    "allocated_cost_amount" DECIMAL(14,2),
    "status" "do_status" NOT NULL DEFAULT 'DRAFT',
    "pod_status" TEXT NOT NULL DEFAULT 'NONE',
    "billing_hold" BOOLEAN NOT NULL DEFAULT false,
    "redelivery_of_id" UUID,
    "customer_ref" TEXT,
    "public_token_hash" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_order_line" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "delivery_order_id" UUID NOT NULL,
    "sales_order_line_id" UUID,
    "qty_planned" DECIMAL(14,3) NOT NULL,
    "qty_actual" DECIMAL(14,3),
    "reject_qty" DECIMAL(14,3),
    "reject_reason_code_id" UUID,
    "unit" TEXT NOT NULL,

    CONSTRAINT "delivery_order_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "do_surcharge" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "delivery_order_id" UUID NOT NULL,
    "service_item_id" UUID NOT NULL,
    "vat_type" "vat_type" NOT NULL,
    "wht_rate" DECIMAL(5,2) NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "evidence_file_key" TEXT,
    "approved_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "do_surcharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_cost" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "cost_type" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "vat_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL,
    "carrier_id" UUID,
    "settlement_line_id" UUID,
    "allocated" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_cost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stop_event" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trip_stop_id" UUID NOT NULL,
    "type" "stop_event_type" NOT NULL,
    "outcome" TEXT,
    "reason_code_id" UUID,
    "client_event_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "actor" TEXT,
    "lat" DECIMAL(9,6),
    "lng" DECIMAL(9,6),
    "accuracy_m" INTEGER,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB,

    CONSTRAINT "stop_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stored_document" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "file_key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" UUID,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stored_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_position" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "trip_id" UUID,
    "source" TEXT NOT NULL,
    "lat" DECIMAL(9,6) NOT NULL,
    "lng" DECIMAL(9,6) NOT NULL,
    "speed_kmh" DECIMAL(5,1),
    "heading" INTEGER,
    "accuracy_m" INTEGER,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_position_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_user_tenant_id_email_key" ON "app_user"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "role_tenant_id_code_key" ON "role"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "user_role_tenant_id_user_id_role_id_company_id_key" ON "user_role"("tenant_id", "user_id", "role_id", "company_id");

-- CreateIndex
CREATE UNIQUE INDEX "branch_tenant_id_company_id_branch_code_key" ON "branch"("tenant_id", "company_id", "branch_code");

-- CreateIndex
CREATE UNIQUE INDEX "document_sequence_tenant_id_doc_type_branch_id_period_key_key" ON "document_sequence"("tenant_id", "doc_type", "branch_id", "period_key");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_entity_type_entity_id_at_idx" ON "audit_log"("tenant_id", "entity_type", "entity_id", "at");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_at_idx" ON "audit_log"("tenant_id", "at");

-- CreateIndex
CREATE INDEX "customer_tenant_id_updated_at_id_idx" ON "customer"("tenant_id", "updated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_tenant_id_code_key" ON "customer"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "customer_tenant_id_external_id_key" ON "customer"("tenant_id", "external_id");

-- CreateIndex
CREATE INDEX "customer_site_tenant_id_customer_id_idx" ON "customer_site"("tenant_id", "customer_id");

-- CreateIndex
CREATE INDEX "customer_site_tenant_id_updated_at_id_idx" ON "customer_site"("tenant_id", "updated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_site_tenant_id_external_id_key" ON "customer_site"("tenant_id", "external_id");

-- CreateIndex
CREATE INDEX "carrier_tenant_id_updated_at_id_idx" ON "carrier"("tenant_id", "updated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "carrier_tenant_id_code_key" ON "carrier"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "carrier_tenant_id_external_id_key" ON "carrier"("tenant_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_type_tenant_id_code_key" ON "vehicle_type"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "vehicle_tenant_id_updated_at_id_idx" ON "vehicle"("tenant_id", "updated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_tenant_id_plate_plate_province_key" ON "vehicle"("tenant_id", "plate", "plate_province");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_tenant_id_external_id_key" ON "vehicle"("tenant_id", "external_id");

-- CreateIndex
CREATE INDEX "driver_tenant_id_updated_at_id_idx" ON "driver"("tenant_id", "updated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "driver_tenant_id_external_id_key" ON "driver"("tenant_id", "external_id");

-- CreateIndex
CREATE INDEX "vehicle_document_tenant_id_vehicle_id_doc_type_expires_on_idx" ON "vehicle_document"("tenant_id", "vehicle_id", "doc_type", "expires_on");

-- CreateIndex
CREATE INDEX "vehicle_cost_tenant_id_vehicle_id_occurred_on_idx" ON "vehicle_cost"("tenant_id", "vehicle_id", "occurred_on");

-- CreateIndex
CREATE UNIQUE INDEX "service_item_tenant_id_code_key" ON "service_item"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "rate_card_tenant_id_side_customer_id_carrier_id_idx" ON "rate_card"("tenant_id", "side", "customer_id", "carrier_id");

-- CreateIndex
CREATE UNIQUE INDEX "reason_code_tenant_id_category_code_key" ON "reason_code"("tenant_id", "category", "code");

-- CreateIndex
CREATE INDEX "sales_order_tenant_id_status_requested_date_idx" ON "sales_order"("tenant_id", "status", "requested_date");

-- CreateIndex
CREATE INDEX "sales_order_tenant_id_updated_at_id_idx" ON "sales_order"("tenant_id", "updated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_tenant_id_so_no_key" ON "sales_order"("tenant_id", "so_no");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_tenant_id_external_id_key" ON "sales_order"("tenant_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_stop_tenant_id_sales_order_id_sequence_key" ON "sales_order_stop"("tenant_id", "sales_order_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_line_tenant_id_sales_order_id_line_no_key" ON "sales_order_line"("tenant_id", "sales_order_id", "line_no");

-- CreateIndex
CREATE INDEX "trip_tenant_id_trip_date_status_idx" ON "trip"("tenant_id", "trip_date", "status");

-- CreateIndex
CREATE INDEX "trip_tenant_id_updated_at_id_idx" ON "trip"("tenant_id", "updated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "trip_tenant_id_trip_no_key" ON "trip"("tenant_id", "trip_no");

-- CreateIndex
CREATE UNIQUE INDEX "trip_stop_tenant_id_trip_id_sequence_key" ON "trip_stop"("tenant_id", "trip_id", "sequence");

-- CreateIndex
CREATE INDEX "delivery_order_tenant_id_status_idx" ON "delivery_order"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "delivery_order_tenant_id_trip_id_idx" ON "delivery_order"("tenant_id", "trip_id");

-- CreateIndex
CREATE INDEX "delivery_order_tenant_id_updated_at_id_idx" ON "delivery_order"("tenant_id", "updated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_order_tenant_id_do_no_key" ON "delivery_order"("tenant_id", "do_no");

-- CreateIndex
CREATE INDEX "delivery_order_line_tenant_id_delivery_order_id_idx" ON "delivery_order_line"("tenant_id", "delivery_order_id");

-- CreateIndex
CREATE INDEX "do_surcharge_tenant_id_delivery_order_id_idx" ON "do_surcharge"("tenant_id", "delivery_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "trip_cost_settlement_line_id_key" ON "trip_cost"("settlement_line_id");

-- CreateIndex
CREATE INDEX "trip_cost_tenant_id_trip_id_idx" ON "trip_cost"("tenant_id", "trip_id");

-- CreateIndex
CREATE INDEX "stop_event_tenant_id_trip_stop_id_occurred_at_idx" ON "stop_event"("tenant_id", "trip_stop_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "stop_event_tenant_id_client_event_id_key" ON "stop_event"("tenant_id", "client_event_id");

-- CreateIndex
CREATE INDEX "stored_document_tenant_id_entity_type_entity_id_idx" ON "stored_document"("tenant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "vehicle_position_tenant_id_vehicle_id_occurred_at_idx" ON "vehicle_position"("tenant_id", "vehicle_id", "occurred_at");


-- ===== RLS ทุกตารางใหม่ (ST0-T04/T05) =====
SELECT tms_enable_tenant_rls('app_user');
SELECT tms_enable_tenant_rls('role');
SELECT tms_enable_tenant_rls('user_role');
SELECT tms_enable_tenant_rls('branch');
SELECT tms_enable_tenant_rls('document_sequence');
SELECT tms_enable_tenant_rls('audit_log');
SELECT tms_enable_tenant_rls('customer');
SELECT tms_enable_tenant_rls('customer_site');
SELECT tms_enable_tenant_rls('carrier');
SELECT tms_enable_tenant_rls('vehicle_type');
SELECT tms_enable_tenant_rls('vehicle');
SELECT tms_enable_tenant_rls('driver');
SELECT tms_enable_tenant_rls('vehicle_document');
SELECT tms_enable_tenant_rls('vehicle_cost');
SELECT tms_enable_tenant_rls('service_item');
SELECT tms_enable_tenant_rls('rate_card');
SELECT tms_enable_tenant_rls('reason_code');
SELECT tms_enable_tenant_rls('sales_order');
SELECT tms_enable_tenant_rls('sales_order_stop');
SELECT tms_enable_tenant_rls('sales_order_line');
SELECT tms_enable_tenant_rls('trip');
SELECT tms_enable_tenant_rls('trip_stop');
SELECT tms_enable_tenant_rls('delivery_order');
SELECT tms_enable_tenant_rls('delivery_order_line');
SELECT tms_enable_tenant_rls('do_surcharge');
SELECT tms_enable_tenant_rls('trip_cost');
SELECT tms_enable_tenant_rls('stop_event');
SELECT tms_enable_tenant_rls('stored_document');
SELECT tms_enable_tenant_rls('vehicle_position');

-- ===== กติกาที่ฐานข้อมูลบังคับ (docs/01 §3.2, §3.9) =====
ALTER TABLE vehicle ADD CONSTRAINT vehicle_subcontract_needs_carrier CHECK (ownership <> 'SUBCONTRACT' OR carrier_id IS NOT NULL);
ALTER TABLE driver ADD CONSTRAINT driver_carrier_driver_needs_carrier CHECK (employment_type <> 'CARRIER_DRIVER' OR carrier_id IS NOT NULL);
ALTER TABLE rate_card ADD CONSTRAINT rate_card_side_party CHECK ((side = 'SELL' AND customer_id IS NOT NULL AND carrier_id IS NULL) OR (side = 'BUY' AND carrier_id IS NOT NULL AND customer_id IS NULL));
ALTER TABLE rate_card ADD CONSTRAINT rate_card_valid_range CHECK (valid_to IS NULL OR valid_to >= valid_from);
ALTER TABLE rate_card ADD CONSTRAINT rate_card_price_nonneg CHECK (unit_price >= 0);
ALTER TABLE vehicle ADD CONSTRAINT vehicle_odometer_nonneg CHECK (odometer_km IS NULL OR odometer_km >= 0);
ALTER TABLE document_sequence ADD CONSTRAINT document_sequence_next_positive CHECK (next_value >= 1);
-- ช่วงราคาไม่ซ้อนกันใน key เดียวกัน (exclusion constraint) ทำใน ST2-T09 พร้อม btree_gist

-- append-only สำหรับ role แอป
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON audit_log, stop_event, vehicle_cost FROM tms_app';
  END IF;
END $$;
