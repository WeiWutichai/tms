-- ST7-T18 × ST7-T11: คอลัมน์ updated_at ที่ใช้เป็น cursor ต้องเป็นความละเอียด ms (TIMESTAMPTZ(3)) ตาม 0109_cursor_ms_precision
-- (ตาราง erp_master_code / erp_code_mapping สร้างใน 0110 ก่อนที่ 0109 จะอยู่บน main) · ย้อนได้ด้วย TIMESTAMPTZ(6)

-- AlterTable
ALTER TABLE "erp_master_code" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "erp_code_mapping" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);
