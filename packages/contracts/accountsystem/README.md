# Contract: AccountSystem (Innovera) — `ext/v1` ที่ TMS ใช้ (ST8-T16)

**ที่มา (FACT — อ่านจาก repo AccountSystem แบบอ่านอย่างเดียว ณ commit `d9b1c1d`, 21 พ.ย. 2569 — ห้ามแก้ repo นั้นจากฝั่ง TMS):**

| เรื่อง | ไฟล์ใน AccountSystem |
| --- | --- |
| route `ext/v1/*`, API key, scope | `apps/accounting-api/src/ext.controller.ts` |
| สร้างร่าง + กันซ้ำ `external_source`/`external_ref` | `packages/db/src/ledger-service.ts:158` `createDraftDocument` |
| schema ของร่าง (`DocumentDraftCreate`, `DocumentLineInput`, `WebhookEvent`) | `packages/contracts/src/index.ts` |
| scope, webhook outbox, ลายเซ็น, sync คู่ค้า | `packages/db/src/hub.ts` (`API_SCOPES`, `emitTx`, `signWebhook`, `deliverDue`, `syncContacts`) |
| payload ของ webhook | `packages/db/src/sales.ts:363/498/612`, `packages/db/src/purchase.ts:483/837` |
| error → HTTP | `apps/accounting-api/src/errors.ts` |

## Endpoint ที่ TMS ใช้

| Endpoint | scope | ใช้ทำอะไร |
| --- | --- | --- |
| `POST {base}/ext/v1/documents` | `documents:draft` | สร้าง IV ร่าง (ใบแจ้งหนี้) / AP ร่าง (ใบสำคัญจ่ายรถร่วม) — body เดี่ยวหรือ array ≤ 500 · ตอบ `{id, created}` (ซ้ำ = `created:false` id เดิม) |
| `GET {base}/ext/v1/documents?external_ref=&external_source=` | `documents:read` | healthCheck (ref ที่ไม่มีอยู่ = `[]`) |
| `PUT {base}/ext/v1/contacts` | `contacts:draft` | จับคู่/สร้างคู่ค้าด้วยเลขผู้เสียภาษี + สาขา หรือ `external_source`/`external_ref` → ได้ `code` (สร้างใหม่ = `EXT-####`) |

- ยืนยันตัวตน: `Authorization: Bearer inn_…` (API key ต่อบริษัทฝั่ง AccountSystem — เก็บเป็น credential เข้ารหัสใน TMS)
- ไม่มี global prefix (`ext/v1` อยู่ที่ราก) — `baseUrl` ของ connector = origin ของ accounting-api
- error body `{ "error": "ข้อความไทย" }` · 400 = body ผิด (zod) · 401 = key ผิด/เพิกถอน/ระงับ · 403 = ไม่มี scope · 422 = กฎธุรกิจ (`LedgerError` เช่น "ไม่พบคู่ค้า X") · 500
- **API สร้างได้แค่ร่าง** — การลงบัญชี/จ่ายเงิน/ยกเลิก ทำโดยผู้ใช้ใน AccountSystem เท่านั้น (ไม่มี endpoint void)

## `DocumentDraftCreate` (`document-draft-create.schema.json`)

หัวเอกสารเป็น `.strict()` (ฟิลด์เกิน = 400) · บรรทัด (`DocumentLineInput`) เป็น object ปกติของ zod (ฟิลด์เกินถูกตัดทิ้งเงียบ)
`external_source` + `external_ref` ต้องมาคู่กัน และไม่ซ้ำต่อบริษัท (unique `company_id, external_source, external_ref`)

## Webhook (`webhook-event.schema.json`)

- ลงทะเบียนด้วย `POST ext/v1/webhooks` (scope `webhooks:manage`) `{url, events}` → ได้ `secret` (`whsec_…`) ครั้งเดียว · url ต้อง https + IP สาธารณะ
- header: `x-innovera-event`, `x-innovera-delivery` (id ต่อการส่ง), `x-innovera-timestamp` (unix วินาที — ใหม่ทุกครั้งที่ลองส่ง), `x-innovera-signature: sha256=<hex>`
- ลายเซ็น = `HMAC-SHA256(secret, "${timestamp}.${body}")` · ส่งครั้งแรก + ลองใหม่ 3 ครั้ง (60 วิ / 5 นาที / 30 นาที) แล้ว dead-letter
- body `{ id (uuid ต่อ event), type, company_id, occurred_at, data }` — `data` ตามชนิด:
  - `document.posted`: `{id, doc_type, doc_no, external_source, external_ref, grand_total, journal_no}`
  - `document.voided`: `{id, doc_type, doc_no, external_source, external_ref, reason, reversal}`
  - `payment.received` (RV): `{id, doc_no, contact_id, cash_in, wht, applications:[{document_id, doc_no, external_ref, applied, wht}]}` — `applied` **ไม่รวม** WHT (AccountSystem ตรวจ `applied + wht ≤ ยอดค้าง`)
  - `payment.paid` (PV): `{id, doc_no, contact_id, paid, wht, certificates:[เลข 50 ทวิ], bills:[{document_id, applied, wht}], vendor_credit?}` — ไม่มี `external_ref` ของบิล
  - `period.closed` (TMS ไม่ใช้)
  - หมายเหตุ: schema `WebhookEvent.data` ใน contracts (`document_id`, `doc_no`, `amount`, `external_ref`) **ไม่ตรง** กับที่ส่งจริง (`id`, …) — TMS อ่านตามที่ส่งจริงใน `sales.ts`/`purchase.ts`

## ช่องว่างที่รู้แล้ว — [OPEN — ทีม AccountSystem] (D-55; คำถามค้าง #61)

1. `vat_rate` รายบรรทัดถูกทิ้ง (`ledger-service.ts:174` ตั้ง `vat_rate: null`) และไม่แยก "ยกเว้น" กับ "0%" (`Rate` เป็นตัวเลขเท่านั้น)
2. ไม่มี WHT รายบรรทัดใน AP — TMS ส่ง WHT ประมาณการเป็นบรรทัดหมายเหตุ (`line_type: note`) แทน
3. ไม่มีมิติ DO / เที่ยว / รถ ต่อบรรทัด — TMS ใส่เลข DO/เที่ยวในคำอธิบายบรรทัด
4. `syncContacts` จับคู่ด้วยเลขผู้เสียภาษี + สาขาได้แล้ว (FACT) แต่ `POST documents` รับแค่ `contact_code`
5. webhook `payment.*` ไม่มี `doc_type`, ไม่มีวิธีรับเงิน/ข้อมูลเช็ค, `payment.paid` ไม่มี `external_ref` ของบิล
6. ไม่มีร่าง RV ตัดชำระผ่าน API (D-57: ส่งรับชำระ/เช็คจาก TMS ไป AccountSystem ยังทำไม่ได้)
7. ไม่มีอนุมัติร่างเป็นชุด
8. **ไม่มีทางยกเลิกร่างผ่าน API** — ยกเลิกใบใน TMS แล้วต้องยกเลิกร่างใน AccountSystem เอง (TMS ขึ้นงานในบันทึกการซิงก์)
9. `createDraftDocument` ไม่คำนวณ `amount` จาก `qty × unit_price` (ไม่ส่ง = `0.00`) และไม่เก็บ `discount` — TMS ส่ง `amount` หลังส่วนลดเสมอ
