-- ST8-T11 (review 4): ผลเทียบ "เทียบไม่ได้" (adapter ไม่มี comparableDocument / ไม่มีฐานของการส่ง) — severity INFO
-- เพิ่มจาก enum ใน docs/01 §3.7 (MATCH/MISMATCH/REMOTE_MISSING/ERP_UNREACHABLE) — บันทึกใน spec/12 §3 แถว ST8-T11
ALTER TYPE "reconcile_outcome" ADD VALUE IF NOT EXISTS 'NOT_COMPARABLE';
