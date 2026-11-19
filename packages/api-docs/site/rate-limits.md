# Rate limit

จำกัดแบบ token bucket หลายชั้นพร้อมกัน (ค่าของแพ็กเกจมาตรฐาน — แพ็กเกจ `high` = 2 เท่าทุกชั้น)

| ชั้น | อัตรา | ใช้กับ |
|---|---|---|
| ต่อบริษัท | 50 คำขอ/วินาที (burst 100) | ทุกช่องทางรวมกัน (เว็บ + API key + OAuth client) |
| ต่อ API key / OAuth client | 20 คำขอ/วินาที | key แต่ละตัว |
| คำขอหนัก | 5 คำขอ/วินาที ต่อบริษัท | export, นำเข้า, PDF, ทำทีละหลายรายการ (`:bulk`), ส่งทดสอบ |

ทุก response มี header ของ bucket ที่ใกล้เต็มที่สุด:

```http
RateLimit-Limit: 20
RateLimit-Remaining: 17
RateLimit-Reset: 1
```

เกิน = `429` พร้อม `Retry-After: <วินาที>` — รอตามนั้นแล้วส่งใหม่ (SDK ทำให้อัตโนมัติ) · Sandbox มี bucket แยกแต่ใช้อัตราเดียวกับบริษัทจริง
