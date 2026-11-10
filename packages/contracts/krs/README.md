# contract ของ KRS (mock สำหรับ ST7–ST8)

ที่มา: `docs/01` Appendix A — ใช้สร้าง mock server และ unit test ของ payload builder (KrsAdapter ต้อง whitelist ฟิลด์: ส่งเกิน = 400)

| ไฟล์ | ใช้กับ |
|---|---|
| `invoice-request.schema.json` | body ของ `POST /invoice` และ `PUT /invoice/{transactionNo}` |
| `invoice-response.schema.json` | response 201/200 และ `GET /invoice/{transactionNo}` |

error ที่ mock ต้องจำลอง: 400 payload ผิด/มีฟิลด์เกิน/ส่ง voucherNo มาเอง · 401 key ผิด · 404 ไม่พบ · 409 `tmsVoucherNo` ซ้ำ · 503 ฐานข้อมูล KRS ล่ม (ให้ retry)

**สถานะ:** ตาม contract ที่มีใน docs — คำถามที่ยังรอทีม KRS (VAT ต่อรายการ, รหัสลูกค้า NSF/PP, entryBy) อยู่ใน `plan/08-questions-krs.md`; เมื่อได้คำตอบให้แก้ schema ที่นี่ก่อนเขียน adapter
