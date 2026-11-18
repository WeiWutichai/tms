# Postman

ไฟล์ [tms-api.postman_collection.json](tms-api.postman_collection.json) (Postman Collection v2.1) — ทุก endpoint ในเอกสารนี้ แยกโฟลเดอร์ตาม resource พร้อม body ตัวอย่างจาก schema

1. Postman → **Import** → เลือกไฟล์
2. แท็บ **Variables** ของ collection: ใส่ `baseUrl` (ไม่ต้องใส่ `/v1`) และ `apiKey` (`tk_test_…` แนะนำให้เริ่มที่ Sandbox)
3. ทุกคำขอใช้ Bearer `{{apiKey}}` และ `X-Api-Version: {{apiVersion}}` · POST ได้ `Idempotency-Key: {{$guid}}` ใหม่ทุกครั้ง

spec OpenAPI 3 ของ endpoint ในเอกสารนี้: [openapi.json](openapi.json) — import เข้า Postman/Insomnia หรือใช้ generate client ภาษาอื่นได้
