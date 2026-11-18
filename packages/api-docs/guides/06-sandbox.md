# Sandbox

Sandbox = บริษัทคู่แฝดของคุณในโหมดทดสอบ ข้อมูลแยกขาดจากข้อมูลจริง (คนละ tenant ในระบบ)

- เปิดครั้งแรกเมื่อผู้ใช้สลับเป็น **Sandbox** ในหน้า นักพัฒนา / Open API · key ที่สร้างในโหมดนี้ขึ้นต้น `tk_test_`
- base URL เดียวกับ Production — โหมดตาม key (`tk_test_` เห็นเฉพาะ Sandbox, `tk_live_` เฉพาะข้อมูลจริง)
- webhook ของ Sandbox **ส่งจริง** ไปยัง endpoint ที่สมัครในโหมด Sandbox (envelope มี `"mode": "test"`) · อีเมล/LINE/SMS และ connector ERP ไม่ทำงานใน Sandbox
- rate limit เหมือนบริษัทจริง (bucket แยก) · แพ็กเกจ/สถานะ = ของบริษัทจริง (บริษัทถูกระงับ = key test ใช้ไม่ได้ด้วย)

## ยิง event จำลอง

ทดสอบ webhook ของคุณโดยไม่ต้องสร้างข้อมูลจริง (scope `settings:read`):

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/test/events/trigger" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"order.created"}'
```

ได้ `200` `{eventId, type, mode, queued, deliveries[], object}` — `type` ต้องเป็น event ที่ใช้งานอยู่ใน [รายการ webhook event](webhook-events.md) · เรียกด้วย key live = `403 sandbox_only`
