-- ST2-T23: code ของข้อผิดพลาดระดับไฟล์ (เช่น quota_exceeded — spec/02 MD-289) คู่กับข้อความไทยใน file_error
ALTER TABLE "import_job" ADD COLUMN "file_error_code" TEXT;
