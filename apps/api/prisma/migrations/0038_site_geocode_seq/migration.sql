-- ST2-T03 (review): ผูก job geocode กับคำขอที่สั่ง — job เก่า (ที่อยู่ A→B→A, ปัก→ล้าง) เขียนผลทับไม่ได้
ALTER TABLE "customer_site" ADD COLUMN "geocode_seq" INTEGER NOT NULL DEFAULT 0;

SELECT tms_enable_tenant_rls('customer_site');
