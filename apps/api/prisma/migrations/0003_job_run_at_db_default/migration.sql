-- run_at ใช้เวลาของฐานข้อมูล (client ไม่ส่งค่า) กันนาฬิกาเครื่อง app กับ DB ไม่ตรงกัน
ALTER TABLE "job" ALTER COLUMN "run_at" SET DEFAULT now();
