-- ST7-T07 Versioning (docs/04 G1 "Versioning"; docs/01 §5.1; spec/07 INT-050/059)
-- pin พฤติกรรม API ต่อ key (`X-Api-Version` ค่าเริ่มของ key) — null = ใช้วันสร้างบริษัท (docs/04 G1; plan/00a: ตาม docs ไม่ใช่วันสร้าง key)
-- ลำดับการเลือกเวอร์ชัน: header X-Api-Version → api_key.api_version → วันที่สร้าง tenant (เขตเวลา Asia/Bangkok)
-- ตาราง api_key มี RLS อยู่แล้ว (0088) — คอลัมน์ใหม่ไม่ต้องเปิดซ้ำ
ALTER TABLE "api_key" ADD COLUMN "api_version" DATE;
