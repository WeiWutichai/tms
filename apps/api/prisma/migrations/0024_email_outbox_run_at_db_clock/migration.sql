-- ST1-T03 (QA): run_at ใช้นาฬิกาฐานข้อมูล (Prisma ไม่ส่งค่าจาก Node) — claim เทียบกับ now() ของ Postgres
ALTER TABLE "email_outbox" ALTER COLUMN "run_at" SET DEFAULT now();
