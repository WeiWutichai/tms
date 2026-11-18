-- ST7-T10 Bulk/async: สถานะงาน `succeeded_with_errors` (docs/04 G1 — ทำครบแต่บางรายการไม่ผ่าน)
-- ไม่มีตารางใหม่ (job เปิด RLS แล้วใน 0001)
ALTER TYPE "job_status" ADD VALUE IF NOT EXISTS 'SUCCEEDED_WITH_ERRORS';
