-- ST3-T03: replay ETag (และ header อื่นที่จำเป็น) คู่กับ body ของ Idempotency-Key — idempotency_key มี RLS อยู่แล้ว
ALTER TABLE "idempotency_key" ADD COLUMN "response_headers" JSONB;
