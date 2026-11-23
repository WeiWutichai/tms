-- ST8-T13 ปุ่ม "ลงบัญชีแล้ว" (docs/01 A.2 "approval ถ้า `external_mapping.posted_at` ไม่ว่าง หรืออายุใบ > N วัน"; A.6; §6.5 POSTED)
-- ERP ที่บอกสถานะลง GL ไม่ได้ (KRS — ไม่มี capability `postedStatus`) → บัญชีกดปุ่มใน TMS · มีค่า = แทนที่เอกสารฝั่ง ERP ต้องมีผู้อนุมัติ
-- ย้อนกลับ: ALTER TABLE external_mapping DROP COLUMN posted_at, DROP COLUMN posted_by; (ตารางมี RLS อยู่แล้ว — 0141)

ALTER TABLE "external_mapping" ADD COLUMN "posted_at" TIMESTAMPTZ(6),
ADD COLUMN "posted_by" TEXT;
