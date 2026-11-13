-- ST3-T04: จำนวนรายการ (entity) ที่ผ่าน/นำเข้า เมื่อ 1 รายการมีหลายแถว (ใบสั่งขนส่ง) — null = 1 แถว = 1 รายการ
ALTER TABLE "import_job" ADD COLUMN "ok_entities" INTEGER,
ADD COLUMN "imported_entities" INTEGER;
