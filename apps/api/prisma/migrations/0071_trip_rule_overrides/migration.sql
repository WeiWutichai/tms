-- ST3-T14 (D-07 PO 16 พ.ย. 2569): การยกเว้นกฎบล็อก (trips:override) / ยืนยันคำเตือนพร้อมเหตุผลต่อเที่ยว
-- แยกจาก rule_warnings (ผลตรวจที่คำนวณใหม่ทุกครั้ง) — append-only; ไม่มีตารางใหม่ (RLS ของ trip ครอบอยู่แล้ว)
ALTER TABLE "trip" ADD COLUMN "rule_overrides" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "trip" ADD CONSTRAINT "trip_rule_overrides_array" CHECK (jsonb_typeof("rule_overrides") = 'array');
