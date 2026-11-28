-- P1-ST2-T02 review B1 (R-11 ขอบเขตเฟส 1): หน้าราคาสาธารณะไม่แสดงฟีเจอร์นอกเฟส 1 / ไม่มีถ้อยคำใน docs/02 §2
-- feature เป็นตารางแคตตาล็อกระดับแพลตฟอร์ม (ไม่มี tenant_id) — ไม่ต้อง RLS
ALTER TABLE "feature" ADD COLUMN "show_on_web" BOOLEAN NOT NULL DEFAULT true;

-- [DECISION — lead 27 พ.ย. 2569, ย้อนได้] ซ่อนจากเว็บ (ยังอยู่ใน matrix/Console/entitlement ตามเดิม):
--   track  = หน้าติดตามรถบนแผนที่ + GPS connector (plan/13 §2.2 — เฟส 2–3, D-49)
--   cf     = custom fields (plan/13 §2.2 — D-48)
--   veh    = โควตารถ (ช่วงรถของ tier คือช่วงราคา — [OPEN — PO] R-06) · ไม่มีแถวนี้ใน docs/02 §2
--   fleet, fleetx = ไม่มีถ้อยคำใน docs/02 §2 (ตาราง tier)
UPDATE "feature" SET show_on_web = false WHERE key IN ('track', 'cf', 'veh', 'fleet', 'fleetx');

-- ชื่อแสดงตามถ้อยคำ docs/02 §2 (ตาราง tier) — แทนชื่อจากต้นแบบที่อ้างของนอกเฟส 1 (แอปคนขับ, MCP, ศูนย์ข้อยกเว้น)
UPDATE "feature" SET name_th = 'ePOD — web POD โดยแอดมิน, ลิงก์อัปโหลด POD สำหรับรถร่วมไม่มีแอป', name_en = 'ePOD — web POD by admin, POD upload link for subcontractors without the app' WHERE key = 'driver';
UPDATE "feature" SET name_th = 'Open API (req/นาที)', name_en = 'Open API (req/min)' WHERE key = 'api';
UPDATE "feature" SET name_th = 'ใบค้าง + reason code', name_en = 'Pending orders + reason codes' WHERE key = 'exc';
