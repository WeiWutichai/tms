-- ST1-T23 (QA D1): created_at ความละเอียด ms ให้ตรงกับ cursor ของ GET /v1/me/notifications


ALTER TABLE "notification" ALTER COLUMN "created_at" SET DEFAULT now(),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

