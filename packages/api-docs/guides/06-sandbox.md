# Sandbox

Sandbox = บริษัทคู่แฝดของคุณในโหมดทดสอบ ข้อมูลแยกขาดจากข้อมูลจริง (คนละ tenant ในระบบ)

- เปิดครั้งแรกเมื่อผู้ใช้สลับเป็น **Sandbox** ในหน้า นักพัฒนา / Open API · key ที่สร้างในโหมดนี้ขึ้นต้น `tk_test_`
- Sandbox ได้สำเนา **นิติบุคคลและสาขา** ของบริษัท (ใช้เป็นนิติบุคคลออกบิลของใบสั่ง) ตอนสร้างครั้งแรก · ข้อมูลอื่น (ลูกค้า สถานที่ ใบสั่ง) เริ่มว่าง
- ข้อมูล Sandbox ดู/แก้ผ่าน API เท่านั้น — หน้าจอใบสั่งขนส่ง/เที่ยววิ่งในเว็บแสดงข้อมูลจริงเสมอ (หน้า นักพัฒนา / Open API สลับดู key/webhook ของ Sandbox ได้)
- base URL เดียวกับ Production — โหมดตาม key (`tk_test_` เห็นเฉพาะ Sandbox, `tk_live_` เฉพาะข้อมูลจริง)
- webhook ของ Sandbox **ส่งจริง** ไปยัง endpoint ที่สมัครในโหมด Sandbox (envelope มี `"mode": "test"`) · อีเมล/LINE/SMS และ connector ERP ไม่ทำงานใน Sandbox
- rate limit เหมือนบริษัทจริง (bucket แยก) · แพ็กเกจ/สถานะ = ของบริษัทจริง (บริษัทถูกระงับ = key test ใช้ไม่ได้ด้วย)

## ยิง event จำลอง

1. สมัคร endpoint ของคุณในหน้าเว็บ **นักพัฒนา / Open API → Webhooks** ขณะอยู่โหมด Sandbox — URL ต้องเป็น `https://` ที่เข้าถึงได้จากอินเทอร์เน็ต (ทดสอบจากเครื่องตัวเองให้ใช้ tunnel เช่น ngrok / Cloudflare Tunnel) · API key สร้าง/แก้ endpoint ไม่ได้ (อ่านได้อย่างเดียว)
2. ยิง event (key ต้องมี scope `settings:read` — ถ้าจะดู event ด้วย `GET /v1/events/{id}` เพิ่ม `events:read`):

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/test/events/trigger" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"order.created"}'
```

ได้ `200` `{eventId, type, mode, queued, deliveries[], object}` — ในคำตอบนี้ `deliveries[].state` บอกผลส่งของแต่ละ endpoint (`delivered`/`failed`/`queued`/`skipped`) และ `deliveries[].status` = HTTP status ที่ปลายทางตอบ · ดูย้อนหลังได้ที่ `GET /v1/webhook-deliveries?eventId=<eventId>` (scope `settings:read` — รายการนี้ใช้ช่อง `status` = `delivered`/`failed`/`exhausted` และ `responseStatus` = HTTP status) (ยังไม่มี endpoint = ได้ `deliveries: []` แต่ event ถูกบันทึก ดูได้ที่ `GET /v1/events/{id}` — scope `events:read`) — `type` ต้องเป็น event ที่ใช้งานอยู่ใน [รายการ webhook event](webhook-events.md) · เรียกด้วย key live = `403 sandbox_only`
