-- ST2-T21 รถร่วมอัปโหลดเอกสารรถ/ใบขับขี่เองผ่านลิงก์ (docs/04 B2.1 แถวรถร่วม "carrier อัปโหลดเอกสารเองผ่านลิงก์ LINE ได้")
-- ตารางใหม่ carrier_doc_submission = เอกสารที่ส่งมารอ admin ตรวจ (ยังไม่ใช่ vehicle_document → ไม่ปลดบล็อก isAssignable จนกว่าอนุมัติ)
-- ลิงก์ใช้ magic_link เดิม (ST1-T06) purpose `carrier_docs` — คอลัมน์ purpose เป็น text ไม่ต้องแก้

-- CreateTable
CREATE TABLE "carrier_doc_submission" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "carrier_id" UUID NOT NULL,
    "magic_link_id" UUID,
    "vehicle_id" UUID,
    "driver_id" UUID,
    "doc_type" TEXT NOT NULL,
    "target_document_id" UUID,
    "title" TEXT,
    "doc_no" TEXT,
    "issuer" TEXT,
    "starts_on" DATE,
    "expires_on" DATE NOT NULL,
    "file_document_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMPTZ(6),
    "review_reason" TEXT,
    "result_document_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carrier_doc_submission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "carrier_doc_submission_tenant_id_carrier_id_status_created__idx" ON "carrier_doc_submission"("tenant_id", "carrier_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "carrier_doc_submission_tenant_id_vehicle_id_doc_type_idx" ON "carrier_doc_submission"("tenant_id", "vehicle_id", "doc_type");

-- CreateIndex
CREATE INDEX "carrier_doc_submission_tenant_id_driver_id_idx" ON "carrier_doc_submission"("tenant_id", "driver_id");

-- AddForeignKey
ALTER TABLE "carrier_doc_submission" ADD CONSTRAINT "carrier_doc_submission_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_doc_submission" ADD CONSTRAINT "carrier_doc_submission_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_doc_submission" ADD CONSTRAINT "carrier_doc_submission_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- เป้าหมายเดียวต่อรายการ: เอกสารรถ (vehicle_id) หรือใบขับขี่ (driver_id + DRIVER_LICENCE)
ALTER TABLE "carrier_doc_submission" ADD CONSTRAINT "carrier_doc_submission_target_check" CHECK (
  ("vehicle_id" IS NOT NULL AND "driver_id" IS NULL AND "doc_type" IN ('INSURANCE','COMPULSORY_ACT','ANNUAL_TAX','INSPECTION','TRANSPORT_LICENSE','GPS_DLT_CERT','OTHER'))
  OR ("driver_id" IS NOT NULL AND "vehicle_id" IS NULL AND "doc_type" = 'DRIVER_LICENCE')
);
ALTER TABLE "carrier_doc_submission" ADD CONSTRAINT "carrier_doc_submission_status_check"
  CHECK ("status" IN ('PENDING_REVIEW', 'APPROVED', 'REJECTED'));
-- ตรวจแล้วต้องมีผู้ตรวจ เวลา และเหตุผล (CLAUDE.md: อนุมัติ/ไม่อนุมัติ ต้องมีเหตุผล + audit)
ALTER TABLE "carrier_doc_submission" ADD CONSTRAINT "carrier_doc_submission_review_check" CHECK (
  "status" = 'PENDING_REVIEW'
  OR ("reviewed_at" IS NOT NULL AND "reviewed_by" IS NOT NULL AND "review_reason" IS NOT NULL)
);
ALTER TABLE "carrier_doc_submission" ADD CONSTRAINT "carrier_doc_submission_files_check"
  CHECK (cardinality("file_document_ids") > 0);

SELECT tms_enable_tenant_rls('carrier_doc_submission');

-- ไม่มีการลบ (เก็บเป็นหลักฐาน)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON "carrier_doc_submission" FROM tms_app';
  END IF;
END $$;
