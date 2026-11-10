# 07 — Integration: Connector บัญชี/ERP, Open API, Webhook, Field mapping, MCP server

> ⚠️ **ลำดับความสำคัญ (10 พ.ย. 2569):** ไฟล์นี้เขียนโดยไม่ได้อ่าน `docs/` (v2) เมื่อเนื้อหาขัดกับ `docs/` ให้ยึด `docs/` — ดู `plan/00-source-of-truth.md` และรายการจุดที่ขัดกันใน `plan/00a-reconcile-architecture.md`, `plan/00b-reconcile-requirements.md` · ป้าย P0/P1/P2 ในไฟล์นี้เป็นมาตราส่วนของ spec ไม่ใช่ "เฟส 0" ของแผนพัฒนา

> รหัสข้อกำหนด: `INT-nnn` · สถานะ: ร่าง v0.1 (9 พ.ย. 2569)
> แหล่งที่มา: `research/design-briefs.md` รอบ 1 (ข้อ 1–3, 7, 9), รอบ 11, 12, 14 (ข้อ 7), 15A · `research/tms-api-benchmark.md` §9 (มาตรฐาน API), §10 · `research/trcloud-api-mcp-learning.md` · `research/ai-mcp-plan.md` §2
> หลักที่ห้ามย้อน: D1 standalone, D2 หลาย ERP ไม่ hard-code, D3 สถานะเอกสารแยกจากสถานะซิงก์, D5 AI/MCP เสนอ คนยืนยัน, D6 schema ชุดเดียว

## 0. ภาพรวม

| ช่องทาง | ใครเขียน | ทิศทาง | ใช้เมื่อ |
|---|---|---|---|
| **Connector บัญชี/ERP** (§1–§3) | ทีมเรา | TMS ⇄ ระบบบัญชี | ลูกค้าใช้โปรแกรมบัญชี/ERP และอยากให้เอกสารไหลเข้าเอง |
| **ส่งออกไฟล์ให้นักบัญชี** (§4) | ทีมเรา | TMS → ไฟล์ | ไม่มี connector |
| **Open API (REST)** (§5–§9) | ลูกค้า/คู่ค้า | ⇄ | ERP/WMS/e-commerce/ผู้ส่งสินค้าต่อเอง |
| **Webhook** (§10) | ลูกค้า/คู่ค้า | TMS → ภายนอก | อยากรู้สถานะทันทีโดยไม่ poll |
| **Field mapping profile** (§11) | ลูกค้า | ขาเข้า/ขาออก | payload ภายนอกไม่ตรง schema ของเรา |
| **Shipper-scoped key** (§12) | ลูกค้าออกให้ผู้ส่งสินค้า | ⇄ | ผู้ส่งสินค้าส่งงาน/ดูสถานะของตัวเอง |
| **MCP server** (§13) | ลูกค้าใช้ AI ของตัวเอง | ⇄ (ร่าง) | สั่งงาน/ถามข้อมูลผ่าน Claude/ChatGPT ฯลฯ |

- **INT-001** [DECISION] schema กลางเดียว (OpenAPI 3.1 generate จาก NestJS DTO + custom fields ของ tenant) ใช้กับ REST, webhook payload, MCP tool parameter, เอกสาร API และ field mapping (D6)
- **INT-002** [DECISION] ทุกช่องทางผ่าน API layer เดียว (application service) — MCP server และ connector worker ไม่ต่อฐานข้อมูลตรง
- **INT-003** ทุกการสร้าง/แก้/ลบ credential (connector, API key, webhook secret, MCP connection) เขียน audit (01 §11.5)

---

## 1. Connector บัญชี/ERP — หน้ารายการและตั้งค่า

1. **จุดประสงค์** — เชื่อม TMS กับโปรแกรมบัญชี/ERP ที่ลูกค้าใช้ แบบ optional โดยค่าเริ่มต้นคือ "ไม่เชื่อม"
2. **ผู้ใช้/สิทธิ์** — ตั้งค่า: owner/admin; ดู/จัดการคิว: accounting (01 §12); จำนวน connector ตาม `connectors.accounting` (01 §6)
3. **หน้าจอ** — ตั้งค่า → การเชื่อมต่อ
   - การ์ดแรก (ค่าเริ่มต้น, ถูกเลือกอยู่): **"ไม่เชื่อม — ใช้ TMS ออกเอกสารเอง"** + ลิงก์ "ส่งออกไฟล์ให้นักบัญชี" (§4)
   - การ์ด connector ขนาดเท่ากันทุกตัว **เรียงตามตัวอักษร** ไม่มีตัวใดถูกเลือกจนกว่าจะกด "เชื่อมต่อ": API ทั่วไป (ลิงก์ไป Open API §5) · Express · FlowAccount · KRS · PEAK · SAP Business One (รายการมาจาก `ConnectorDefinition` ไม่ hard-code)
   - การ์ดแต่ละใบ: ชื่อ, สถานะ (ไม่ได้เชื่อม / เชื่อมแล้ว / ผิดพลาด), ปุ่ม เชื่อมต่อ · ทดสอบ · ดู log · ตั้งค่า · ยกเลิกการเชื่อม
   - หน้าตั้งค่า connector (แท็บ): **การเชื่อมต่อ** (credential/URL, ทดสอบ) · **เอกสารที่ส่ง** (ประเภทเอกสาร × เปิด/ปิด × ทิศทาง) · **Mapping** (ประเภทค่าใช้จ่าย/ค่าบริการ ↔ รหัสสินค้า/บริการ; VAT code; บัญชีรายได้/ลูกหนี้/ภาษีขาย/WHT; ลูกค้า/ผู้ขาย ↔ รหัสคู่ค้า; สาขา) · **เลขเอกสาร** (ใครออกเลข) · **ซิงก์** (syncFromDate, โหมดอัตโนมัติ/ด้วยมือ, รอบดึงสถานะชำระ) · **Log** (request/payload/response แต่ละครั้ง; "ดูตัวอย่าง payload" อยู่ที่นี่)
   - เมื่อมี connector ≥ 1: เมนูบัญชีเพิ่ม "คิวเชื่อมระบบบัญชี" (§2), คอลัมน์ไอคอน "ระบบบัญชี" ในรายการเอกสาร, แท็บ "รหัสระบบบัญชี" ในหน้าลูกค้า/ผู้ขาย; ท้าย sidebar แสดง "เชื่อมกับ {ชื่อ connector}" — เมื่อไม่มี connector ทั้งหมดนี้ซ่อน และท้าย sidebar แสดง "ไม่ได้เชื่อมระบบบัญชี · ตั้งค่า"
4. **ฟิลด์**

| Entity.ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| ConnectorDefinition.code | string | ✓ | | `express`, `flowaccount`, `krs`, `peak`, `sapb1`, `generic_api` — ข้อมูล catalog |
| ConnectorDefinition.capabilities | json | ✓ | | ประเภทเอกสารที่รองรับ, ทิศทาง, รองรับออกเลขเอง, transport (`api` / `file_drop` / `db_bridge`) |
| ConnectorInstance.tenantId, legalEntityId | | ✓ | 1 instance ต่อ definition ต่อ legal entity | |
| .status | enum §1.6 | ✓ | | |
| .credentials | encrypted json (KMS) | ✓ | ทดสอบผ่านก่อนเปิด | ไม่แสดงกลับเต็ม |
| .numberingOwner | `tms` / `external` | ✓ | ล็อกหลังมีเอกสารซิงก์แล้ว | §1 INT-013 |
| .syncFromDate | date | ✓ | ≤ วันนี้; ≥ วันเริ่มใช้ TMS | เอกสารก่อนวันนี้ไม่ส่ง |
| .syncMode | `auto` / `manual` | ✓ | | auto = ส่งเมื่อเอกสารออก/เปลี่ยน |
| .paymentPullInterval | นาที | | 15–1440 | ดึงสถานะชำระกลับ |
| ConnectorDocTypeConfig.(docType, enabled, direction) | | ✓ | direction ต้องอยู่ใน capabilities | docType: `invoice`, `tax_invoice`, `receipt`, `billing_note`, `credit_note`, `debit_note`, `payment_received`, `subcon_bill`, `subcon_payment`, `wht_certificate`, `customer`, `vendor`, `expense` |
| ConnectorMapping.(kind, tmsValue, externalValue) | | ✓ | kind ∈ `charge_type` `vat_code` `account` `branch` `payment_method` | ตาราง mapping |

5. **กฎธุรกิจ**
- **INT-010** [DECISION] ห้ามมี connector ใดเป็นค่าเริ่มต้นหรือถูกแนะนำใน UI; ชื่อ connector ปรากฏใน UI เฉพาะเมื่อเปิดใช้งาน (ข้อความเช่น "ส่งเข้า {ชื่อ}") (D2)
- **INT-011** [DECISION] connector เป็นส่วนเสริม: ปิด/ล้มเหลวแล้วการออกเอกสาร รับชำระ และ export ใน TMS ทำงานปกติ (D1)
- **INT-012** ทิศทางต่อประเภทเอกสาร: `push` (TMS → ภายนอก), `pull` (ภายนอก → TMS — เช่นสถานะรับชำระ, master ลูกค้า), `both` (master data เท่านั้น ใช้กฎ "แก้ล่าสุดชนะ" + log ความขัดแย้ง)
- **INT-013** ผู้ออกเลขเอกสาร: `tms` = TMS ออกเลขตาม 05 และส่งเลขไปให้ปลายทางใช้ตาม; `external` = เอกสารใน TMS ได้ "เลขชั่วคราว" (เช่น `TMP-…`) จนกว่าปลายทางตอบเลขจริง แล้วบันทึก `externalNumber` และพิมพ์ด้วยเลขจริง [PROPOSED] — โหมด `external` ใช้ได้เฉพาะ connector ที่ capabilities รองรับ และเอกสารพิมพ์/ส่งลูกค้าไม่ได้จนกว่าได้เลขจริง [OPEN: ใบกำกับภาษีที่ต้องออกทันทีหน้างานกับโหมด external]
- **INT-014** เปลี่ยน `numberingOwner` ไม่ได้หลังมีเอกสารซิงก์สำเร็จ ≥ 1 ใบ (ต้องยกเลิกการเชื่อมแล้วตั้งใหม่พร้อม syncFromDate ใหม่)
- **INT-015** ก่อนเปิดใช้: ทดสอบการเชื่อมต่อผ่าน + mapping ครบทุก charge type ที่มีใช้ใน 90 วันล่าสุด (ไม่ครบ → แสดงรายการที่ขาด, เปิดได้แต่เอกสารที่ใช้ค่าที่ขาดจะเข้าคิว `needs_mapping`)
- **INT-016** ยกเลิกการเชื่อม: หยุดส่ง/ดึงทันที, เก็บ `ExternalMapping` และ log ไว้ (ใช้ถ้าเชื่อมกลับ), เมนูคิว/คอลัมน์ซิงก์ซ่อนเมื่อไม่มี connector เหลือ
- **INT-017** connector ต่อ legal entity; หลายนิติบุคคลใช้ connector คนละตัวได้
6. **สถานะ ConnectorInstance**

| จาก → ไป | เงื่อนไข | ใครทำ | ผลข้างเคียง |
|---|---|---|---|
| `not_connected` → `configuring` | กด "เชื่อมต่อ" | admin | ตรวจโควตา connector (01 PLT-079) |
| `configuring` → `active` | ทดสอบผ่าน + กดเปิดใช้ | admin | เริ่มส่งเอกสารตั้งแต่ syncFromDate; แสดงเมนูคิว |
| `active` → `error` | auth ล้มเหลว / ปลายทางล่มต่อเนื่อง ≥ 30 นาที | ระบบ | แจ้งผู้ดูแล (01 §13.5); เอกสารใหม่เข้าคิว `pending` |
| `error` → `active` | ทดสอบผ่านอีกครั้ง / ปลายทางกลับมา | ระบบ/admin | ส่งคิวค้างตามลำดับ |
| `active` → `paused` | กดหยุดชั่วคราว | admin | เอกสารใหม่ `pending` |
| `paused` → `active` | กดเปิด | admin | |
| ทุกสถานะ → `disconnected` | ยกเลิกการเชื่อม + เหตุผล | admin | INT-016 |

7. **Event** — `connector.connected`, `connector.error`, `connector.disconnected` (ภายใน/แจ้งเตือน; ไม่ใช่ webhook สาธารณะ)
8. **กรณีผิดปกติ** — credential หมดอายุ (OAuth ของ cloud accounting) → `error` + ปุ่ม "เชื่อมใหม่"; ปลายทางเปลี่ยน API → log error code ปลายทางเต็ม; mapping ถูกลบขณะมีเอกสารรอ → เอกสารเข้า `needs_mapping`
9. **เกณฑ์ตรวจรับ**
- Given tenant ใหม่ When เปิด ตั้งค่า → การเชื่อมต่อ Then การ์ด "ไม่เชื่อม" ถูกเลือก, การ์ด connector เรียงตามตัวอักษร, ไม่มีเมนู "คิวเชื่อมระบบบัญชี" ใน sidebar
- Given connector `active` ล่ม When ออกใบแจ้งหนี้ Then ใบแจ้งหนี้ `status=issued` ปกติ และ `syncStatus=pending`
10. **เฟส** — P0: กรอบ connector + "ไม่เชื่อม" + export ไฟล์ (§4) · P1: connector ตัวแรก 1–2 ตัว (เลือกตามความต้องการลูกค้าเฟส 0) [OPEN: ลำดับ connector] · P2: ตัวที่เหลือ

---

## 2. Sync engine, สถานะซิงก์, คิวเชื่อมระบบบัญชี

1. **จุดประสงค์** — ส่ง/ดึงเอกสารอย่างเชื่อถือได้ และให้คนจัดการรายการที่ไม่สำเร็จ
2. **ผู้ใช้/สิทธิ์** — accounting, owner/admin
3. **หน้าจอ**
   - คอลัมน์ "ระบบบัญชี" ในรายการเอกสาร: ไอคอนเล็ก (ซิงก์แล้ว / รอส่ง / ไม่ตรง / ล้มเหลว) + tooltip ชื่อ connector + เวลา — แยกจากคอลัมน์สถานะเอกสาร (D3)
   - Drawer เอกสาร: timeline การซิงก์ (เฉพาะเมื่อมี connector) + ปุ่ม "ส่งเข้า {ชื่อ}" / "ส่งซ้ำ"
   - **คิวเชื่อมระบบบัญชี** (กลุ่มบัญชี): แท็บ ไม่ตรง · รอส่งซ้ำ · ถูกปฏิเสธ · รออนุมัติ (+ mapping ไม่ครบ) ; ตัวนับ sidebar = จำนวนรายการที่ต้องทำเท่านั้น (ไม่รวม `pending` ที่ระบบกำลังส่งเอง); ตาราง: เอกสาร, ประเภท, connector, สถานะ, ข้อความ error (แปลเป็นไทย + code ดิบ), ครั้งที่ลอง, ล่าสุด; การกระทำ: ส่งซ้ำ, แก้ mapping แล้วส่ง, ทำเครื่องหมาย "จัดการในระบบบัญชีแล้ว" (บังคับเหตุผล), ดู payload
4. **ฟิลด์**

| Entity.ฟิลด์ | ชนิด | หมายเหตุ |
|---|---|---|
| `SyncRecord` (tenantId, connectorInstanceId, objectType, objectId, operation `create` `update` `void` `pull`, syncStatus, attempt, nextAttemptAt, lastErrorCode, lastErrorMessage, requestPayloadRef, responseRef, externalId, externalNumber, syncedAt) | | 1 แถวต่อ (object, connector, operation ล่าสุด) + ประวัติใน `SyncAttempt` |
| `SyncAttempt` (syncRecordId, at, httpStatus, durationMs, errorCode, payloadRef, responseRef) | | เก็บ 90 วัน [PROPOSED] |
| `ExternalMapping` (tenantId, connectorInstanceId, objectType, tmsId, externalId, externalCode, externalNumber, lastSyncedHash, updatedAt) | | unique `(connectorInstanceId, objectType, tmsId)` และ `(connectorInstanceId, objectType, externalId)` |

5. **กฎธุรกิจ**
- **INT-020** [DECISION] `Document.status` (ร่าง/ออกแล้ว/ชำระบางส่วน/ชำระแล้ว/เกินกำหนด/ยกเลิก — 05) ไม่ถูกเปลี่ยนโดยผลซิงก์; ซิงก์ล้มเหลวไม่ทำให้เอกสารกลับเป็นร่าง (D3)
- **INT-021** การส่งใช้ outbox pattern: ธุรกรรมที่ออกเอกสารเขียน `SyncRecord(pending)` ใน transaction เดียวกัน → worker ส่ง → อัปเดตผล
- **INT-022** retry อัตโนมัติเมื่อ error ชั่วคราว (timeout, 429, 5xx, network): backoff 1, 5, 15, 60 นาที, 4, 12 ชม. (6 ครั้ง) [PROPOSED] → ครบแล้วเป็น `failed` เข้าคิว; error ถาวร (4xx validation, รหัสไม่มีในปลายทาง) → `rejected` ทันทีไม่ retry
- **INT-023** idempotency ต่อปลายทาง: ใช้ `ExternalMapping` ตรวจก่อนสร้างซ้ำ; ปลายทางที่รับ external reference ส่ง `tmsId` เป็น reference เสมอ
- **INT-024** ลำดับ: master (ลูกค้า/ผู้ขาย) ต้องซิงก์ก่อนเอกสารที่อ้างถึง — เอกสารรอ master อยู่ `pending` พร้อมเหตุผล "รอข้อมูลลูกค้า"
- **INT-025** "ไม่ตรง" (`mismatch`): การดึงกลับพบยอด/สถานะในปลายทางต่างจาก TMS (เช่น ยอดใบแจ้งหนี้ต่าง, ปลายทางยกเลิกเอกสาร) → ไม่แก้ TMS อัตโนมัติ เข้าแท็บ "ไม่ตรง" ให้คนตัดสิน (ใช้ค่าของ TMS ส่งซ้ำ / ออกใบลดหนี้ใน TMS / ทำเครื่องหมายรับทราบ)
- **INT-026** สถานะรับชำระที่ดึงกลับ (`pull payment_received`) สร้าง "รับชำระ" ใน TMS แบบ `source=connector` เฉพาะเมื่อจับคู่เอกสารได้ 1:1 และยอดไม่เกินยอดค้าง — ไม่เช่นนั้นเข้า "รออนุมัติ"
- **INT-027** เอกสารที่ `issueDate < syncFromDate` ไม่ถูกส่งอัตโนมัติ; ส่งด้วยมือได้ทีละใบ (ยืนยัน)
- **INT-028** void/ยกเลิกเอกสารใน TMS ที่ซิงก์แล้ว → ส่ง operation `void` (หรือใบลดหนี้ตามความสามารถปลายทาง); ปลายทางไม่รองรับ → เข้า "รออนุมัติ" พร้อมคำแนะนำให้ยกเลิกในระบบบัญชีด้วยมือ
6. **สถานะ syncStatus**

| จาก → ไป | เงื่อนไข | ผล |
|---|---|---|
| (ไม่มี) → `pending` | เอกสารออก/แก้/ยกเลิก + connector active + docType เปิด | outbox |
| `pending` → `synced` | ปลายทางตอบสำเร็จ | บันทึก ExternalMapping, externalNumber |
| `pending` → `retrying` | error ชั่วคราว | nextAttemptAt ตาม INT-022 |
| `retrying` → `failed` | ครบจำนวน retry | เข้าคิว "รอส่งซ้ำ" |
| `pending`/`retrying` → `rejected` | error ถาวร | เข้าคิว "ถูกปฏิเสธ" |
| `pending` → `needs_mapping` | mapping ไม่ครบ | เข้าคิว "mapping ไม่ครบ" |
| `pending` → `awaiting_approval` | INT-026/028 หรือเอกสารก่อน syncFromDate | เข้าคิว "รออนุมัติ" |
| `synced` → `mismatch` | ดึงกลับพบความต่าง | เข้าคิว "ไม่ตรง" |
| `failed`/`rejected`/`needs_mapping`/`mismatch` → `pending` | ผู้ใช้กดส่งซ้ำ/แก้ mapping | |
| ใด ๆ → `resolved_manually` | ผู้ใช้ทำเครื่องหมาย + เหตุผล ≥ 10 ตัว | audit |

7. **Event** — `sync.succeeded`, `sync.failed`, `sync.mismatch_detected` (ภายใน + แจ้งเตือน); webhook สาธารณะ `invoice.synced` [PROPOSED P2]
8. **กรณีผิดปกติ** — ปลายทางรับแล้วแต่ timeout ก่อนตอบ → retry ต้องค้นด้วย reference ก่อนสร้าง (INT-023); งวดบัญชีปลายทางปิดแล้ว → `rejected` code `period_closed` + คำแนะนำ [OPEN: นโยบายเอกสารย้อนงวด — รอคุยกับผู้ให้บริการ ERP]; ผู้ใช้แก้เอกสารในปลายทางเอง → ตรวจพบตอนดึงกลับเป็น `mismatch`
9. **เกณฑ์ตรวจรับ**
- Given connector ตอบ 503 ทุกครั้ง When ออกใบแจ้งหนี้ Then retry 6 ครั้งตามตาราง แล้ว `failed` ปรากฏในแท็บ "รอส่งซ้ำ" และตัวนับ sidebar +1
- Given ปลายทางมียอด 10,700.00 แต่ TMS 10,500.00 When ดึงกลับ Then `mismatch` และสถานะเอกสาร TMS ไม่เปลี่ยน
10. **เฟส** — P1 (พร้อม connector ตัวแรก); outbox + SyncRecord schema P0

---

## 3. ExternalMapping และรหัสระบบบัญชีของข้อมูลหลัก

- หน้าลูกค้า/ผู้ขาย/สินค้า-บริการ: แท็บ "รหัสระบบบัญชี" (แสดงเมื่อมี connector) — ตาราง connector × รหัสภายนอก × ซิงก์ล่าสุด × ปุ่ม "จับคู่กับรายการที่มีอยู่" (ค้นจากปลายทาง) / "สร้างในปลายทาง"
- **INT-030** ลูกค้า 1 รายมีรหัสภายนอกได้ 1 รหัสต่อ connector; จับคู่ซ้ำ (2 ลูกค้า TMS → 1 รหัสปลายทาง) ห้าม — แจ้ง "รหัสนี้ผูกกับ {ลูกค้า} แล้ว"
- **INT-031** การนำเข้า master ครั้งแรก: ดึงรายการจากปลายทาง → จับคู่อัตโนมัติด้วย taxId+branch แล้วชื่อ (normalize) → แสดงผลให้ยืนยันเป็นชุด; ที่จับคู่ไม่ได้เลือก "สร้างใน TMS" / "ข้าม"
- **INT-032** ทุก entity หลักใน TMS มี `externalId` (nullable, unique ต่อ tenant+resource — สำหรับ Open API §5) แยกจาก `ExternalMapping` (ต่อ connector)
- เฟส: P1

---

## 4. ส่งออกไฟล์ให้นักบัญชี (เมื่อไม่มี connector)

1. **จุดประสงค์** — ให้ลูกค้าที่ไม่เชื่อมระบบบัญชีส่งข้อมูลให้นักบัญชีได้ครบ
2. **ผู้ใช้/สิทธิ์** — accounting, owner/admin (สิทธิ์ export ของโมดูลบัญชี)
3. **หน้าจอ** — ปุ่ม "ส่งออกให้นักบัญชี" (หน้ารายการบัญชี + การ์ด "ไม่เชื่อม") → dialog: ช่วงวันที่ (ค่าเริ่ม เดือนที่แล้ว), ชุดข้อมูล (checkbox), รูปแบบไฟล์ (ทั่วไป / Express / PEAK / FlowAccount — เรียงทั่วไปก่อนแล้วตามตัวอักษร), ชนิด (Excel/CSV UTF-8 with BOM), แนบ PDF เอกสาร (zip); ตั้งเวลาส่งอีเมลรายเดือน [P1]
4. **ฟิลด์ / ชุดข้อมูล**

| ชุดข้อมูล | คอลัมน์หลัก |
|---|---|
| รายการขาย (ใบแจ้งหนี้/ใบกำกับ/ใบลด-เพิ่มหนี้) | เลขที่, วันที่, ลูกค้า, เลขผู้เสียภาษี, สาขา, มูลค่ายกเว้น VAT, มูลค่า VAT 7%, VAT, รวม, สถานะ, เอกสารอ้างอิง |
| รับชำระ | วันที่, เลขที่ใบเสร็จ, เอกสารที่ตัด, วิธีรับ, ยอดรับ, WHT ที่ถูกหัก, ค่าธรรมเนียม |
| จ่ายรถร่วม (Settlement) | เลขที่, ผู้รับเหมา, เลขผู้เสียภาษี, ยอด, WHT 1%, สุทธิ, วันที่จ่าย |
| หัก ณ ที่จ่าย | ภ.ง.ด.3/53 รายการ: ผู้ถูกหัก, เลขผู้เสียภาษี, ที่อยู่, ประเภทเงินได้, อัตรา, ยอด, ภาษี |
| ค่าใช้จ่าย/ซื้อ | วันที่, ผู้ขาย, เลขผู้เสียภาษี, ประเภท, ยอด, VAT ซื้อ |

5. **กฎธุรกิจ** — **INT-040** template ต่อโปรแกรมบัญชีเป็นข้อมูล (`ExportTemplate`) แก้ได้โดยไม่ deploy; **INT-041** export เป็น async job (> 5,000 แถว) แจ้งเมื่อเสร็จ ลิงก์อายุ 7 วัน; **INT-042** export ทุกครั้งบันทึก audit (ใคร ช่วงใด ชุดใด); **INT-043** รูปแบบไฟล์เฉพาะโปรแกรมต้องทดสอบนำเข้าจริงกับโปรแกรมนั้นก่อนเปิด [OPEN: ได้ template นำเข้าจริงของแต่ละโปรแกรม]
7. **Event** — `export.completed`
9. **เกณฑ์ตรวจรับ** — Given ไม่มี connector When export รายการขาย ต.ค. แบบทั่วไป Then ไฟล์เปิดใน Excel ภาษาไทยไม่เพี้ยน และยอดรวมตรงรายงานภาษีขาย (09)
10. **เฟส** — P0 (ทั่วไป) · template เฉพาะโปรแกรม P1

---

## 5. Open API — ภาพรวม, Sandbox, มาตรฐาน

1. **จุดประสงค์** — ให้ลูกค้าและคู่ค้าเชื่อม TMS เองโดยไม่ต้องให้ทีมเราทำ integration
2. **ผู้ใช้/สิทธิ์** — เมนู ตั้งค่า → นักพัฒนา / Open API: owner/admin, developer; feature `api.open_api` (ไม่มี = 🔒 หน้าแนะนำ — 01 PLT-076)
3. **หน้าจอ** — แท็บ: ภาพรวม · API keys · Webhooks · Field mapping · Log · เอกสาร · MCP
   - ภาพรวม: สถานะ API (เปิด/ปิดตามแพ็กเกจ/ปิดโดยแพลตฟอร์ม), โควตาเดือนนี้ (เรียกไปแล้ว/ลิมิต), error rate 24 ชม., latency p95, KPI แยก **REST vs MCP** และ **อ่าน / สร้าง / แก้ / อื่น ๆ** + กราฟรายเดือน 12 เดือน; ลิงก์ เอกสาร, `openapi.yaml`, Postman collection, status page, changelog
   - สวิตช์โหมด **Sandbox / Production** ที่หัวหน้า: โหมด Sandbox แสดงป้ายส้ม "SANDBOX" ตลอดและทุกตาราง/key/log กรองเฉพาะ sandbox
4. **ฟิลด์** — ไม่มี (อ่านจาก ApiKey/ApiRequestLog/UsageRecord)
5. **กฎธุรกิจ (มาตรฐาน API — ย่อจาก tms-api-benchmark §9 ซึ่งเป็นข้อกำหนดเต็ม)**

| รหัส | หัวข้อ | ข้อกำหนด |
|---|---|---|
| INT-050 | Base URL / version | `https://api.<domain>/v1/` (live) และ `https://sandbox.api.<domain>/v1/` [PROPOSED]; major ใน path; header `X-Api-Version: YYYY-MM-DD` pin พฤติกรรม (ค่าเริ่ม = วันที่สร้าง key) |
| INT-051 | Tenant | ไม่อยู่ใน URL — ระบุจาก credential; cross-tenant = 404 |
| INT-052 | รูปแบบ | JSON camelCase, `application/json`; resource พหูพจน์; action = `POST /{resource}/{id}/{verb}`; ID prefix (`ord_`, `shp_`, `trp_`, `stp_`, `cus_`, `loc_`, `veh_`, `drv_`, `car_`, `inv_`, `pay_`, `doc_`, `evt_`, `whk_`, `job_`); เงิน `{ "amount": "1250.00", "currency": "THB" }`; เวลา ISO 8601 พร้อม offset (`+07:00` ใน response) |
| INT-053 | externalId | ทุก resource หลักมี `externalId` unique ต่อ tenant; `PUT/PATCH /{resource}/external/{externalId}` upsert (201/200); `{id}` รับ `ext:{externalId}` |
| INT-054 | Idempotency | ทุก POST รับ `Idempotency-Key` (≤ 255) เก็บ 24 ชม. ต่อ (tenant, key, path); replay → response เดิม + `Idempotent-Replayed: true`; body ต่าง → 422 `idempotency_mismatch`; กำลังทำ → 409 |
| INT-055 | Concurrency | `ETag` ทุก GET/PUT/PATCH; `If-Match` ไม่ตรง → 412 |
| INT-056 | Error | RFC 9457 `application/problem+json`: `type, title, status, detail, instance, code, requestId, errors[{field, code, message}]`; `code` คงที่ (catalog ในเอกสาร); 400/401/403/404/409/412/422/429/5xx ตาม benchmark §9.5; list ว่าง = 200 `data: []` |
| INT-057 | Pagination | cursor: `?limit=` (ค่าเริ่ม 25, สูงสุด 200) `&cursor=` → `{ data, nextCursor, hasMore }`; ห้าม offset; filter `updatedAfter/Before`, `status=a,b`, `externalId`, `custom_fields.{key}=`; sort whitelist `?sort=-updatedAt`; `?fields=`, `?expand=` |
| INT-058 | Bulk/async | `POST /{resource}:bulk` ≤ 200 รายการ → 207 multi-status; งานหนัก → 202 + `job_` + `GET /jobs/{id}` + webhook `job.completed` |
| INT-059 | Deprecation | ประกาศ ≥ 12 เดือน, header `Deprecation`, `Sunset`, `Link`; อีเมลเจ้าของ key ที่ยังเรียก; enum ใหม่ = non-breaking (client ต้องรับ unknown) |
| INT-060 | Custom fields | ก้อน `customFields: { key: value }` ใน request/response/webhook; ตรวจตามกฎของฟิลด์ (02) ผิด → 422 code `custom_field_invalid` พร้อม field path |
| INT-061 | Sandbox | sandbox = tenant คู่ `mode=test` ข้อมูลแยกขาด; key `tms_test_…`; webhook ส่งจริงไปยัง endpoint sandbox; `POST /v1/test/events/trigger` ยิง event จำลอง; ไม่นับ usage/โควตา (แต่มี rate limit); ข้อมูลตัวอย่าง seed ได้และ "ล้าง sandbox" ได้ |
| INT-062 | Auth | `Authorization: Bearer <api key>` หรือ OAuth2 client credentials `POST /oauth/token` (JWT 1 ชม., scope แบบ `resource:verb`) [PROPOSED P1]; ทั้งสองแปลงเป็น principal เดียวกัน |

6. **สถานะ** — API ของ tenant: `enabled` / `disabled_by_plan` / `disabled_by_platform` (01 PLT-115) / `read_only_by_status` (01 ตาราง 1.6)
7. **Event** — ไม่มีเฉพาะ
8. **กรณีผิดปกติ** — สลับเป็น Sandbox แล้วเปิดลิงก์เอกสารจาก production → เอกสารแสดง base URL ตามโหมดปัจจุบัน; tenant `suspended` → ทุก call 403 `tenant_suspended`
9. **เกณฑ์ตรวจรับ** — Given key `tms_test_` When `GET /v1/orders` บน production URL Then 401 `key_environment_mismatch`
10. **เฟส** — P1 (Open API อ่าน + เขียน orders, webhook, sandbox) · OAuth client credentials P1 · bulk/async P2 [PROPOSED; ต้นแบบออกแบบครบแล้ว แต่ไม่จำเป็นต่อ MVP]

### 5.1 รายการ resource API v1

| # | Resource | Endpoint หลัก | Scope | เฟส |
|---|---|---|---|---|
| 1 | `orders` (SO) | `GET /orders`, `GET /orders/{id}`, `POST /orders`, `PATCH /orders/{id}`, `PUT/PATCH /orders/external/{externalId}`, `POST /orders/{id}/cancel`, `POST /orders/{id}/attachments`, `GET /orders/{id}/events` | `orders:read` `orders:write` | P1 |
| 2 | `shipments` (DO) | `GET /shipments`, `GET /shipments/{id}`, `PATCH /shipments/{id}` (ฟิลด์ที่แก้ได้ตามสถานะ), `GET /shipments/{id}/tracking` (ตำแหน่งล่าสุด + ETA) | `shipments:read` `shipments:write` `tracking:read` | P1 |
| 3 | `trips` | `GET /trips`, `GET /trips/{id}` (+ `expand=stops,vehicle,driver`), `POST /trips/{id}/dispatch` [P2] | `trips:read` `trips:write` | P1 |
| 4 | `stops` | `GET /trips/{tripId}/stops`, `POST /stops/{id}/arrive` `/depart` `/complete` `/fail` | `trips:write` | P2 |
| 5 | `pod` | `GET /shipments/{id}/pod` (ชื่อผู้รับ, เวลา, พิกัด, ลายเซ็น, รูป — URL ลงนามอายุ 15 นาที, ผลตรวจ AI) | `pod:read` | P1 |
| 6 | `documents` | `POST /documents` (multipart / presigned), `GET /documents/{id}`, `GET /documents/{id}/download` | `documents:read` `documents:write` | P1 |
| 7 | `customers` | CRUD + upsert external | `master:read` `master:write` | P1 |
| 8 | `locations` | CRUD + upsert (externalId หรือพิกัด+ชื่อ) | `master:read` `master:write` | P1 |
| 9 | `products`, `vehicle-types`, `accessorials` | GET list/one | `master:read` | P1 |
| 10 | `vehicles`, `drivers` | GET, POST, PATCH, upsert external | `vehicles:read` `vehicles:write` | P1 |
| 11 | `carriers` (รถร่วม) | GET, POST, upsert external | `master:read` `master:write` | P2 |
| 12 | `rate-quotes` | `POST /rate-quotes` (ขอราคาจาก rate card ตามเส้นทาง/ประเภทรถ/น้ำหนัก) | `rates:read` | P2 |
| 13 | `invoices` | `GET /invoices`, `GET /invoices/{id}`, `GET /invoices/{id}/pdf` · `POST /invoice-runs` (async ร่าง) [P2] | `invoices:read` (`invoices:write` P2) | P1 |
| 14 | `payments` | `GET /payments`, `POST /payments` (บันทึกรับชำระจาก ERP) [P2] | `payments:read` `payments:write` | P2 |
| 15 | `custom-fields` | `GET /custom-fields?entity=` (นิยามฟิลด์ของ tenant) | `master:read` | P1 |
| 16 | `webhooks`, `webhook-deliveries`, `events`, `event-types` | §10 | `webhooks:manage` | P1 |
| 17 | `jobs` | `GET /jobs/{id}` | ตาม job | P2 |
| 18 | `openapi.json` / `openapi.yaml` | spec ของ tenant (รวม custom fields) | key ใดก็ได้ | P1 |

Scope ทั้งหมด: `orders:read` `orders:write` `shipments:read` `shipments:write` `trips:read` `trips:write` `tracking:read` `pod:read` `documents:read` `documents:write` `master:read` `master:write` `vehicles:read` `vehicles:write` `rates:read` `invoices:read` `invoices:write` `payments:read` `payments:write` `webhooks:manage`

- **INT-063** [DECISION] ไม่มี endpoint ลบเอกสารบัญชี/ภาษีผ่าน API — ยกเลิกผ่าน action ตามกฎ 05 เท่านั้น; endpoint เขียนใบแจ้งหนี้สร้างได้แค่ "ร่าง" (D5 ใช้หลักเดียวกับ AI)
- **INT-064** `invoices:write`, `payments:write`, `trips:write` ต้องมี feature `api.write` [PROPOSED: แพ็กเกจสูง]

---

## 6. API keys

1. **จุดประสงค์** — ออก credential ที่จำกัดสิทธิ์ได้และเพิกถอนได้
2. **ผู้ใช้/สิทธิ์** — owner/admin, developer
3. **หน้าจอ** — ตาราง: ชื่อ, prefix (เช่น `tms_live_8f3a…`), โหมด live/test, scope, IP ที่อนุญาต, mapping profile ที่ผูก, ลูกค้าที่จำกัด (shipper key), สร้างโดย, สร้างเมื่อ, ใช้ล่าสุด (+IP ล่าสุด), หมดอายุ, สถานะ · "+ สร้าง API key" (ฟอร์ม) → dialog แสดง secret เต็ม **ครั้งเดียว** (ช่อง monospace + คัดลอก + คำเตือน "ปิดแล้วดูอีกไม่ได้") · เมนู ⋯: แก้ scope/IP/ชื่อ, หมุนเวียน, เพิกถอน
4. **ฟิลด์**

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| name | string(80) | ✓ | unique ต่อ tenant | |
| mode | `live` / `test` | ✓ | | prefix `tms_live_` / `tms_test_` |
| scopes | string[] | ✓ | ≥ 1; scope เขียนต้องมี feature | checkbox อ่าน/เขียน แยก resource |
| ipAllowlist | CIDR[] | | IPv4/IPv6 ถูกรูปแบบ, ≤ 20 รายการ | ว่าง = ทุก IP |
| expiresIn | 30 / 90 / 365 วัน / ไม่หมด | ✓ | | ค่าเริ่ม 365 [PROPOSED] |
| mappingProfileId | | | profile ต้อง source = api_key | §11 |
| customerScopeId | Customer | | | §12 |
| secretHash | sha-256 + pepper | ✓ | | เก็บเฉพาะ hash + prefix 8 ตัว |
| createdBy, lastUsedAt, lastUsedIp, revokedAt, revokeReason | | | | |

5. **กฎธุรกิจ**
- **INT-070** secret แสดงครั้งเดียวตอนสร้าง/หมุน; ระบบเก็บ hash; support/ทีมเราดูไม่ได้ (รวมถึงตอน impersonate — 01 PLT-122)
- **INT-071** หมุนเวียน (rotate): ออก secret ใหม่ทันที, secret เก่าใช้ได้อีก 24 ชม. (เลือกได้ 0 / 24 ชม. / 7 วัน) [ต้นแบบ 24 ชม.; benchmark ≤ 7 วัน]
- **INT-072** เพิกถอน: ยืนยัน + เหตุผล ≥ 10 ตัว มีผลทันที (≤ 60 วิ ทุก node)
- **INT-073** key ผูก tenant + โหมด; สิทธิ์ของ key = scope ของ key (ไม่ขึ้นกับ role ของผู้สร้าง) — แต่ผู้สร้างเลือกได้เฉพาะ scope ที่ role ตัวเองมีสิทธิ์ในโมดูลนั้น [PROPOSED]
- **INT-074** แจ้งเตือนผู้ดูแล + ผู้สร้าง: key หมดอายุใน 14/3 วัน, ถูกใช้จาก IP ใหม่ที่ไม่เคยเห็นใน 30 วัน, error 4xx/5xx > 20% ใน 15 นาที
- **INT-075** IP ไม่อยู่ใน allowlist → 403 `ip_not_allowed` (log เก็บ IP)
- **INT-076** ผู้ใช้ผู้สร้างถูกปิด → key ยังทำงาน แต่แสดงป้าย "ผู้สร้างถูกปิดใช้งาน" ให้โอนเจ้าของ (01 PLT-036)
6. **สถานะ** — `active` → `rotating` (มี secret เก่าค้าง) → `active` · `active` → `expired` (ถึงวัน) · `active`/`rotating` → `revoked`
7. **Event** — `api_key.created`, `api_key.rotated`, `api_key.revoked`, `api_key.expiring`, `api_key.new_ip` (audit + แจ้งเตือน)
8. **กรณีผิดปกติ** — ใช้ key ที่ revoked → 401 `key_revoked`; หมดอายุ → 401 `key_expired`; scope ไม่พอ → 403 `insufficient_scope` + `requiredScope`
9. **เกณฑ์ตรวจรับ** — Given rotate เลือก 24 ชม. When ใช้ secret เก่าหลัง 23 ชม. Then 200 และหลัง 25 ชม. Then 401 `key_revoked`
10. **เฟส** — P1

---

## 7. Rate limit และโควตา API

- **INT-080** ค่าตาม entitlement (01 §6): `api.rate_limit_per_min` ต่อ key [PROPOSED seed: — / 300 / 1,000; ต้นแบบระบุเริ่มต้น 60], `api.monthly_calls` ต่อ tenant, `webhooks.endpoints`; ปรับรายลูกค้าได้ด้วย override (01 PLT-116)
- **INT-081** ชั้นป้องกันระบบ (ไม่ขึ้นกับแพ็กเกจ) [PROPOSED จาก benchmark §9.8]: ต่อ tenant 50 req/s burst 100; endpoint หนัก (bulk, invoice-runs, export) 5 req/s
- **INT-082** ทุก response มี `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`; เกิน → 429 problem+json `code: rate_limited`, `scope: key|tenant|endpoint` + `Retry-After`; เกินโควตารายเดือน → 429 `quota_exceeded`
- **INT-083** การนับ usage: REST และ MCP นับแยก source แต่รวมโควตาเดียวกัน; ไม่นับ 429/5xx และ sandbox; webhook ขาออกไม่นับ
- เกณฑ์ตรวจรับ: Given limit 300/นาที When ยิง 301 ครั้งใน 60 วิ Then ครั้งที่ 301 ได้ 429 พร้อม `Retry-After`
- เฟส P1

---

## 8. Log การเรียก API (REST + MCP)

1. **จุดประสงค์** — ให้ลูกค้าและ support debug ได้ด้วย request id
2. **ผู้ใช้/สิทธิ์** — owner/admin, developer; Console support (01 §10.7)
3. **หน้าจอ** — ตาราง: เวลา, ช่องทาง (REST / MCP), method + path (หรือชื่อ tool), HTTP status, เวลาตอบ (ms), API key / MCP connection (ผู้ใช้), IP, request id · ตัวกรอง: ช่วงเวลา, ช่องทาง, status (2xx/4xx/5xx), key, path/tool · drawer: request/response (header + body ปิดบังข้อมูลอ่อนไหว), request id + ปุ่มคัดลอก "แจ้ง support"
4. **ฟิลด์** — `ApiRequestLog(id=requestId, tenantId, mode, channel rest|mcp, credentialType, credentialId, userId?, method, pathTemplate, path, toolName?, status, durationMs, ip, userAgent, requestBodyRef, responseBodyRef, errorCode, at)`
5. **กฎธุรกิจ** — **INT-085** เก็บตาม `api.log_retention_days` (ค่าเริ่ม 30 วัน [PROPOSED]) แล้วลบ body เหลือ metadata 90 วัน · **INT-086** ปิดบังก่อนบันทึก: `Authorization`, secret, token, รหัสผ่าน, เลขบัตรประชาชน, เบอร์โทรเต็ม (เก็บ 3 ตัวท้าย) · **INT-087** body > 64 KB เก็บเฉพาะ 64 KB แรก + ขนาดจริง
9. **เกณฑ์ตรวจรับ** — Given MCP tool `search_orders` ถูกเรียก When กรอง "MCP" Then เห็นแถวชื่อ tool และผู้ใช้ที่อนุญาตการเชื่อมต่อ
10. **เฟส** — P1

---

## 9. เอกสาร API, OpenAPI ต่อ tenant, Postman

1. **จุดประสงค์** — เอกสารที่ตรงกับ schema จริงของ tenant (รวม custom fields) และลองเรียกได้อย่างปลอดภัย
2. **ผู้ใช้/สิทธิ์** — ผู้ที่เข้าเมนู Open API ได้; เอกสารสาธารณะทั่วไป (ไม่มี custom fields) เปิดที่ docs site
3. **หน้าจอ** — แท็บ "เอกสาร": เมนูซ้าย (เริ่มต้นใช้งาน → แนวทาง → resource ตาม §5.1 → webhook events → error codes → changelog); หน้า endpoint มี **3 แท็บ**:
   1. **คำอธิบายข้อมูล** — method + path, scope ที่ต้องใช้, คำอธิบายไทย, ตารางฟิลด์แบ่งกลุ่ม **ข้อมูล / object / array** คอลัมน์: บังคับ · ชื่อ · ชนิด · ความยาว · คำอธิบายไทย · ตัวอย่าง (custom fields ของ tenant อยู่ในกลุ่ม `customFields` พร้อมป้าย "ฟิลด์ของบริษัทคุณ"), ตัวอย่าง response, error ที่เป็นไปได้
   2. **ตัวอย่างโค้ด** — แท็บภาษา cURL / JavaScript / Python / PHP (code block monospace) ใช้ base URL ตามโหมด และ key placeholder
   3. **ลองเรียก** — editor JSON + เลือก test key → ส่ง; **ใช้ได้เฉพาะ Sandbox** — ในโหมด Production แท็บนี้ disabled พร้อมข้อความ "ลองเรียกได้เฉพาะ Sandbox เพื่อไม่ให้สร้างข้อมูลจริง"
   - "เริ่มต้นใช้งาน": auth (Bearer), base URL live/sandbox, idempotency, pagination, rate limit headers, error format, เวลา ISO 8601 + Asia/Bangkok, เงินเป็น string ทศนิยม 2 ตำแหน่ง, versioning, วิธีตรวจลายเซ็น webhook
4. **ฟิลด์** — ไม่มี (generate)
5. **กฎธุรกิจ** — **INT-090** `GET /v1/openapi.json|yaml` คืน spec ของ tenant ที่ key สังกัด (รวม custom fields ที่ตั้ง "เปิดใน API" — 02) · **INT-091** spec กลาง generate จาก code; CI เทียบ spec ทุก PR — breaking change ต้อง bump major · **INT-092** Postman collection generate จาก spec ของ tenant (ดาวน์โหลด) · **INT-093** หน้าเอกสาร ตัวอย่าง และ MCP parameter table อ่านจาก spec เดียวกัน (D6) · **INT-094** changelog API มีวันที่ + ประเภท (added/changed/deprecated) และอีเมลถึง developer เมื่อมี deprecated
8. **กรณีผิดปกติ** — custom field ถูกลบ → spec ไม่มีฟิลด์นั้น, request ที่ส่งมายังรับได้แต่ไม่บันทึก + warning header `X-TMS-Warning: unknown_custom_field` [PROPOSED]
9. **เกณฑ์ตรวจรับ** — Given tenant เพิ่ม custom field `po_ref` บน SO When ดาวน์โหลด openapi.yaml Then schema Order มี `customFields.po_ref` พร้อมชนิด/กฎ · Given โหมด Production When เปิดแท็บ "ลองเรียก" Then ปุ่มส่ง disabled
10. **เฟส** — P1 · SDK TypeScript P2

---

## 10. Webhooks

1. **จุดประสงค์** — แจ้งเหตุการณ์ไปยังระบบของลูกค้า/คู่ค้าทันที เชื่อถือได้และตรวจสอบที่มาได้
2. **ผู้ใช้/สิทธิ์** — owner/admin, developer (`webhooks:manage` ถ้าผ่าน API); จำนวน endpoint ตาม `webhooks.endpoints`
3. **หน้าจอ** — แท็บ Webhooks: ตาราง endpoint (URL, event ที่สมัคร, สถานะ, อัตราสำเร็จ 7 วัน, ส่งล่าสุด) · "+ เพิ่ม endpoint" · รายละเอียด endpoint: ประวัติการส่ง (event, เวลา, HTTP status, เวลาตอบ, ครั้งที่ลอง), drawer payload/response, ปุ่ม "ส่งซ้ำ", "ส่ง event ทดสอบ", "หมุน secret", "เปิดใช้อีกครั้ง"; กล่องคำอธิบายวิธีตรวจลายเซ็น + ตัวอย่างโค้ด
4. **ฟิลด์**

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| url | URL | ✓ | `https://` เท่านั้น; ไม่ใช่ IP ภายใน/localhost/metadata (กัน SSRF); resolve แล้วตรวจซ้ำตอนส่ง | |
| events | string[] | ✓ | อยู่ใน event-types | `*` ไม่อนุญาต [PROPOSED] |
| description | string(200) | | | |
| extraHeaders | {k:v}[] | | ≤ 5, ห้ามทับ header `X-TMS-*`/`Content-Type` | |
| secret | string | ✓ | ระบบสร้าง `whsec_…` | แสดงครั้งเดียว |
| mappingProfileId | | | source = outbound_webhook | §11 |
| customerScopeId | | | | endpoint ของ shipper ได้เฉพาะ event งานของตัวเอง |
| status | §10.6 | ✓ | | |

5. **กฎธุรกิจ**
- **INT-100** Envelope: `{ id, type, version, occurredAt, tenantId, mode, data: { object, previousAttributes }, request: { id, idempotencyKey } }` — object = snapshot เต็มตาม schema API (รวม customFields)
- **INT-101** Headers: `X-TMS-Event`, `X-TMS-Event-Id`, `X-TMS-Timestamp`, `X-TMS-Signature: t=<unix>,v1=<hex>`, `X-TMS-Attempt`
- **INT-102** ลายเซ็น HMAC-SHA256(secret, `${t}.${rawBody}`); ผู้รับควรปฏิเสธ `|now − t| > 300 วิ` (กัน replay); หมุน secret → 24 ชม. ส่ง `v1` ทั้งของใหม่และเก่า
- **INT-103** ส่ง: timeout 10 วิ, สำเร็จ = 2xx; retry เมื่อ 408/429/5xx/timeout/network แบบ exponential backoff **8 ครั้งภายใน 24 ชม.**: +1 นาที, +5 นาที, +15 นาที, +30 นาที, +1 ชม., +3 ชม., +6 ชม., +12 ชม. (รวม ≈ 22 ชม. 51 นาที) [ต้นแบบ "8 ครั้งใน 24 ชม."; benchmark เสนอ ~3 วัน]; 4xx อื่น (400/401/403/404/410) ไม่ retry
- **INT-104** at-least-once, ไม่รับประกันลำดับ — ผู้รับ dedupe ด้วย `id` และใช้ `occurredAt`/`data.object.updatedAt` จัดลำดับ
- **INT-105** auto-disable [PROPOSED]: event ล้มเหลวขั้นสุดท้ายติดกัน 50 รายการ **หรือ** ไม่มีการส่งสำเร็จเลย 72 ชม. ขณะมี event รอ → `disabled_failing` + อีเมลผู้ดูแลและผู้สร้าง; event ระหว่างปิดเก็บไว้ 30 วัน ส่งซ้ำได้หลังเปิดใหม่ (เลือก "ส่ง event ที่ค้าง")
- **INT-106** ส่งซ้ำ (resend) ด้วยมือได้ภายใน 30 วัน (`POST /v1/webhook-deliveries/{id}/retry`, `POST /v1/events/{id}/redeliver?endpointId=`) — event id เดิม, `X-TMS-Attempt` เพิ่ม
- **INT-107** event ทดสอบ: ส่ง `webhook.test` ที่มี payload ตัวอย่างของ event ที่เลือก ป้าย `"test": true`; ไม่นับอัตราสำเร็จ
- **INT-108** event เกิดใน transaction → เขียน outbox; dispatcher ส่งหลัง commit เท่านั้น
- **INT-109** tenant read_only/suspended → พัก (ไม่ทิ้ง) ส่งต่อเมื่อ active (01 ตาราง 1.6); พักเกิน 30 วันทิ้งพร้อม log
- **INT-110** webhook ไม่ส่งข้อมูลที่ endpoint ไม่ควรเห็น: endpoint ของ shipper ได้เฉพาะ event ของงานลูกค้ารายนั้นและไม่มีราคาต้นทุน/รถร่วม [PROPOSED]

**รายการ event สาธารณะ (v1)** — `GET /v1/event-types` คือรายการจริง

| กลุ่ม | Event | เกิดเมื่อ | เฟส |
|---|---|---|---|
| SO | `order.created`, `order.updated`, `order.cancelled` | สร้าง/แก้/ยกเลิก SO | P1 |
| DO | `shipment.created`, `shipment.assigned` (ผูกเที่ยว/รถ), `shipment.picked_up`, `shipment.arrived`, `shipment.delivered`, `shipment.failed` (ส่งไม่สำเร็จ/บางส่วน), `shipment.status_changed` (ทุกการเปลี่ยน) | สถานะ DO (04) | P1 |
| POD | `pod.uploaded`, `pod.verified` (ผลตรวจ AI/คนยืนยัน — 08) | | P1 |
| เที่ยว | `trip.dispatched`, `trip.started`, `trip.completed`, `trip.cancelled` | | P1 |
| จุด | `stop.arrived`, `stop.departed` | | P2 |
| ETA | `shipment.eta_changed` (เปลี่ยน ≥ 15 นาที) | | P2 |
| บัญชี | `invoice.issued`, `invoice.paid`, `invoice.cancelled`, `credit_note.issued`, `payment.received` | | P1 |
| รถร่วม | `settlement.approved`, `settlement.paid` | | P2 |
| Fleet | `vehicle.document_expiring` (60/30/7 วัน) | | P1 |
| ข้อยกเว้น | `exception.created`, `exception.resolved` | | P2 |
| ระบบ | `job.completed`, `webhook.test` | | P1 |

> **ตารางนี้เป็นรายการ event สาธารณะชุดหลัก (canonical)** — event ที่โมดูลอื่นกล่าวถึงแต่ไม่อยู่ในตารางนี้ (เช่น `order.confirmed`, `order.completed`, `trip.accepted`, `trip.rule_overridden`, `invoice.sent`, `invoice.overdue`, `work_order.*`, `accident.*`, `fine.*`, `settlement.created`) ถือเป็น **event ภายใน** ใช้กับ audit log และการแจ้งเตือนในระบบ ยังไม่ส่งออกทาง webhook จนกว่าจะเพิ่มในตารางนี้ · ชื่อที่ซ้ำความหมาย (`trip.accepted` vs `trip.driver_accepted`, `shipment.eta_updated` vs `shipment.eta_changed`) ให้ใช้ชื่อในตารางนี้หรือชื่อแรก · ข้อความในโมดูลที่มีรูป `xxx.verb` แบบกริยาสั่ง (เช่น `exception.take`, `order.cancel`, `pod.capture`) เป็น **ชื่อสิทธิ์ (permission)** ไม่ใช่ event [PROPOSED]

6. **สถานะ endpoint**

| จาก → ไป | เงื่อนไข | ใครทำ | ผลข้างเคียง |
|---|---|---|---|
| (ใหม่) → `active` | บันทึก (ส่ง `webhook.test` อัตโนมัติ 1 ครั้ง ผลไม่บล็อก) | developer | แสดง secret ครั้งเดียว |
| `active` → `disabled` | ผู้ใช้ปิด | developer | event ใหม่ไม่ถูกสร้าง delivery |
| `active` → `disabled_failing` | INT-105 | ระบบ | อีเมล; เก็บ event 30 วัน |
| `disabled`/`disabled_failing` → `active` | เปิดใหม่ (เลือกส่ง event ค้างไหม) | developer | |
| ใด ๆ → (ลบ) | ลบ + ยืนยัน | developer | ประวัติการส่งเก็บตาม retention |

7. **Event** — `webhook_endpoint.created/disabled/auto_disabled` (audit)
8. **กรณีผิดปกติ** — endpoint redirect 3xx → ถือว่าล้มเหลว (ไม่ follow); response ใหญ่ > 64 KB → ตัดเก็บ; DNS ชี้ IP ภายใน → ล้มเหลว `ssrf_blocked`; event เดียวกันสมัครหลาย endpoint → delivery แยกต่อ endpoint
9. **เกณฑ์ตรวจรับ**
- Given endpoint ตอบ 500 ตลอด When เกิด `shipment.delivered` Then มี 9 attempt (1 + retry 8) ภายใน 24 ชม. ตาม INT-103 แล้ว delivery = `failed`
- Given ผู้รับคำนวณ HMAC ด้วย secret ที่ได้ When ตรวจ `X-TMS-Signature` Then ตรงกัน
10. **เฟส** — P1

---

## 11. Field mapping profile

1. **จุดประสงค์** — แปลงข้อมูลจากรูปแบบของคู่ค้าเป็น schema TMS (ขาเข้า) หรือจาก TMS เป็นรูปแบบของคู่ค้า (ขาออก) โดยไม่เขียนโค้ด
2. **ผู้ใช้/สิทธิ์** — owner/admin, developer
3. **หน้าจอ** — แท็บ Field mapping: รายการ profile (ชื่อ, แหล่งข้อมูล, entity, ผูกกับ, ใช้ล่าสุด, error 7 วัน) · ตัวแก้: (1) เลือกแหล่ง + entity ปลายทาง (2) วางตัวอย่าง (JSON / แถว CSV / ไฟล์) (3) ตาราง **ต้นทาง | การแปลงค่า | ฟิลด์ TMS** (รวม custom fields) + ปุ่ม "จับคู่อัตโนมัติ" + "ให้ AI แนะนำ" (08 §AI mapping — ป้าย "AI แนะนำ" ต่อแถว, ยอมรับทั้งหมด/ทีละแถว, แนะนำ custom field ที่ควรสร้าง) (4) ปุ่ม "ทดสอบ" แสดงผลลัพธ์ + error ต่อฟิลด์ (5) บันทึก + ผูก
4. **ฟิลด์**

| Entity.ฟิลด์ | ชนิด | บังคับ | หมายเหตุ |
|---|---|---|---|
| MappingProfile.name | string | ✓ | |
| .source | `api_key` / `csv_import` / `connector` / `outbound_webhook` | ✓ | |
| .direction | `inbound` / `outbound` | ✓ | outbound_webhook = outbound |
| .targetEntity | `order` `shipment` `customer` `location` `vehicle` `driver` … | ✓ | |
| .sampleRef | | | ตัวอย่างล่าสุด |
| .version | int | ✓ | แก้ = เวอร์ชันใหม่; log อ้างเวอร์ชัน |
| MappingRule.(sourcePath, targetField, transforms[], required, onError `reject`/`skip_field`/`default`) | | ✓ | sourcePath แบบ JSONPath หรือชื่อคอลัมน์ |

**การแปลงค่า (transforms) ที่รองรับ**

| transform | พารามิเตอร์ | ตัวอย่าง |
|---|---|---|
| `trim`, `upper`, `lower` | — | |
| `date` | รูปแบบต้นทาง, ปฏิทิน `buddhist`/`gregorian`, เขตเวลา | `05/11/2569` → `2026-11-05` |
| `number` | ตัวคั่นหลักพัน/ทศนิยม | `1,250.50` → `1250.50` |
| `unit` | จาก → ไป (kg, ton, ลบ.ม., ชิ้น ตามหน่วยใน 02) | `24 ตัน` → `24000 kg` |
| `lookup` | ตาราง key→value (แก้ในหน้า) หรือ master (ลูกค้าด้วย taxId/ชื่อ, สถานที่ด้วยรหัส/ชื่อ) | `BKK01` → `loc_…` |
| `enum_map` | ค่าต้นทาง → enum TMS | `URGENT` → `priority=high` |
| `constant` | ค่า | `serviceType=ftl` |
| `concat` | ฟิลด์[], ตัวคั่น | ที่อยู่หลายบรรทัด → 1 ฟิลด์ |
| `split` | ตัวคั่น, index | `ชื่อ นามสกุล` |
| `regex_extract` | pattern, group | `PO-(\d+)` |
| `default_if_empty` | ค่า | |
| `phone_th` | — | `081-234-5678` → `+66812345678` |

5. **กฎธุรกิจ**
- **INT-120** "จับคู่อัตโนมัติ" ใช้กฎ: ชื่อตรง (ไม่สนตัวพิมพ์/`_`/`-`) → synonym list (ไทย/อังกฤษ เช่น `ผู้รับ`=`consignee`) → ชนิดข้อมูลเข้ากัน; ไม่ใช้ AI credit
- **INT-121** ผูก profile กับ API key (ขาเข้า): request ที่ใช้ key นั้นแปลงผ่าน profile ก่อน validate schema; ไม่มี profile = ต้องส่งตาม schema TMS ตรง ๆ
- **INT-122** ผูกกับ CSV import (02/03), connector (ทับ mapping มาตรฐานของ connector เฉพาะฟิลด์ที่กำหนด), webhook ขาออก (แปลง payload ก่อนเซ็นลายเซ็น — ลายเซ็นคำนวณจาก body ที่ส่งจริง)
- **INT-123** แปลงไม่สำเร็จ: `onError=reject` → API ตอบ 422 `mapping_failed` พร้อม `errors[{sourcePath, targetField, transform, message}]`; CSV → แถวนั้นอยู่ในรายงานผลนำเข้า; ทุกกรณีบันทึก `MappingFailure(profileId, version, requestId, sourcePath, rawValue (ปิดบัง PII), reason, at)` เก็บ 30 วัน และแสดงจำนวนใน profile
- **INT-124** "ทดสอบ" ไม่สร้างข้อมูลจริง (dry-run) และไม่นับ API usage
- **INT-125** แก้ profile ที่ผูกกับ key ที่ใช้งานอยู่ = เวอร์ชันใหม่มีผลทันที; ย้อนเวอร์ชันได้ 1 คลิก
6. **สถานะ** — `draft` → `active` (ผ่านทดสอบ ≥ 1 ครั้ง) → `archived`
7. **Event** — `mapping.failed` (สรุปรายชั่วโมงเมื่อ > 10 ครั้ง → แจ้งเตือน)
8. **กรณีผิดปกติ** — ตัวอย่างไม่ใช่ JSON/CSV ที่อ่านได้ → แจ้งตำแหน่งที่ผิด; ฟิลด์บังคับของ TMS ไม่ถูก map → บันทึกไม่ได้ (เว้นมี `constant`/`default`); lookup ไม่พบ → ตาม onError
9. **เกณฑ์ตรวจรับ** — Given profile แปลงวันที่ `buddhist` When ส่ง `"pickup_date":"05/11/2569"` ด้วย key ที่ผูก Then SO ถูกสร้างด้วย pickup 2026-11-05 · Given lookup สถานที่ไม่พบและ onError=reject Then 422 `mapping_failed` และ MappingFailure +1
10. **เฟส** — P1 (api_key, csv) · connector/outbound_webhook P2 · AI แนะนำ P1 (08)

---

## 12. Shipper-scoped API key (key ของผู้ส่งสินค้า)

1. **จุดประสงค์** — ให้ลูกค้าของบริษัทขนส่ง (ผู้ส่งสินค้า) ส่งงานและดูสถานะของตัวเองผ่าน API
2. **ผู้ใช้/สิทธิ์** — ออกโดย owner/admin, developer จาก ข้อมูลหลัก → ลูกค้า → แท็บ "การเชื่อมต่อ API"
3. **หน้าจอ** — แท็บในหน้าลูกค้า: รายการ key ของลูกค้ารายนี้, ปุ่มสร้าง (scope จำกัด), webhook endpoint ของลูกค้ารายนี้, ลิงก์เอกสาร API แบบย่อสำหรับผู้ส่งสินค้า (ส่งให้ทางอีเมลได้)
4. **ฟิลด์** — ApiKey ปกติ + `customerScopeId` (บังคับ)
5. **กฎธุรกิจ**
- **INT-130** scope ที่เลือกได้จำกัด: `orders:write`, `orders:read`, `shipments:read`, `tracking:read`, `pod:read`, `documents:write` (แนบไฟล์ของงานตัวเอง), `invoices:read` (ใบแจ้งหนี้ของตัวเอง) [PROPOSED]
- **INT-131** ทุก query ถูกบังคับ filter `customerId = customerScopeId` ที่ชั้น service; ข้อมูลรายอื่น = 404
- **INT-132** response ตัดฟิลด์ภายใน: ต้นทุน, ค่ารถร่วม, กำไร, หมายเหตุภายใน, ข้อมูลรถร่วม/คนขับเกินที่หน้าติดตามสาธารณะแสดง (04)
- **INT-133** SO ที่สร้างผ่าน shipper key: `customerId` ถูกตั้งเป็น customerScopeId เสมอ (ส่งค่าอื่น = 422), สถานะเริ่ม = รอยืนยัน (ผู้วางแผนรับงาน) [PROPOSED]
- **INT-134** นับ usage/rate limit ของ tenant ผู้ออก key
9. **เกณฑ์ตรวจรับ** — Given key จำกัดลูกค้า A When `GET /v1/shipments/{DO ของลูกค้า B}` Then 404
10. **เฟส** — P2

---

## 13. MCP server

1. **จุดประสงค์** — ให้ผู้ใช้ลูกค้าใช้ AI assistant ของตัวเอง (Claude Code, Claude.ai, ChatGPT, อื่น ๆ) อ่านข้อมูลและสร้างร่างงานใน TMS ภายใต้สิทธิ์ของตัวเอง
2. **ผู้ใช้/สิทธิ์** — ผู้ใช้ลูกค้าทุกคนที่ role มีสิทธิ์ (เชื่อมต่อในนามตัวเอง); ผู้ดูแลเห็นและเพิกถอนการเชื่อมต่อทั้งหมด; feature `mcp.server` (ตาม Open API) + `api.open_api`
3. **หน้าจอ** — ตั้งค่า → นักพัฒนา / Open API → แท็บ **MCP**
   - การ์ด "เชื่อมต่อ" 3 ขั้น: (1) Server URL เดียวทุกลูกค้า `https://mcp.<domain>/v1` + คัดลอก (2) แท็บตามโปรแกรม: **Claude Code** (คำสั่งเพิ่ม MCP server แบบ HTTP + `/mcp` เพื่อยืนยันตัวตน) / **Claude.ai** (เพิ่ม custom connector ด้วย URL) / **ChatGPT** (เพิ่ม connector ด้วย URL) / **อื่น ๆ** (JSON config) พร้อมปุ่มคัดลอก (3) ครั้งแรกระบบเปิดหน้า login TMS → หน้า **"อนุญาต"** แสดง client, ผู้ใช้, บริษัท, scope ที่ขอ → AI ได้ token โดยไม่เห็นรหัสผ่าน
   - กล่องคำอธิบายสิทธิ์: "สิทธิ์ของ AI = สิทธิ์ของบทบาทคุณ ∩ ขอบเขตที่คุณอนุญาตตอนเชื่อมต่อ — ไม่ใช่สิทธิ์ทั้งบริษัท"
   - ตาราง **การเชื่อมต่อที่ใช้งานอยู่**: client, ผู้ใช้, scope, เชื่อมเมื่อ, ใช้ล่าสุด, จำนวนเรียก 7 วัน, ปุ่มเพิกถอน (ผู้ใช้เห็นของตัวเอง; ผู้ดูแลเห็นทั้งหมด)
   - **แคตตาล็อก tool**: รายการซ้ายแบ่งหมวด → drawer มาตรฐาน: ชื่อ tool (คัดลอก) + ป้ายระดับ (อ่าน / ร่าง — ต้องยืนยันใน TMS / เขียน — ต้องยืนยันใน AI), scope ที่ต้องใช้, คำอธิบาย 2 บรรทัด, ตัวอย่างประโยคภาษาไทยงานขนส่ง, ตารางพารามิเตอร์ (ตารางเดียวกับเอกสาร API รวม custom fields), ข้อควรรู้, สวิตช์เปิด/ปิด tool (ผู้ดูแล), tool อื่นในหมวดเดียวกัน
4. **ฟิลด์**

| Entity.ฟิลด์ | หมายเหตุ |
|---|---|
| `McpClient` (clientId, name, redirectUris, registeredVia `dcr`/`preset`) | รองรับ OAuth dynamic client registration [PROPOSED] |
| `McpConnection` (id, tenantId, userId, clientId, scopes[], createdAt, lastUsedAt, calls7d, revokedAt, revokedBy) | 1 แถวต่อการอนุญาต |
| `McpToolSetting` (tenantId, toolName, enabled) | ค่าเริ่ม = เปิดทุก tool ที่ entitlement อนุญาต |
| access token อายุ 1 ชม. + refresh token 30 วัน (rotating) | ผูก tenant + user + connection |

**แคตตาล็อก tool (ชื่อ verb_entity)**

| หมวด | Tools | ระดับ |
|---|---|---|
| งานขนส่ง | `search_orders`, `get_order`, `get_shipment`, `search_shipments`, `get_trip`, `search_trips` | อ่าน |
| งานขนส่ง | `create_order`, `update_order`, `cancel_order`, `attach_order` | ร่าง |
| ติดตาม/POD | `get_vehicle_location`, `get_shipment_eta`, `get_pod` | อ่าน |
| ติดตาม/POD | `request_pod_resend` | ร่าง |
| วางแผน | `suggest_vehicle_for_order` | อ่าน |
| วางแผน | `create_dispatch_draft` | ร่าง |
| จากเอกสาร/ข้อความ | `order_from_text`, `order_from_document`, `expense_from_receipt`, `vehicle_document_from_file` (ใช้ AI credit — 08) | ร่าง |
| จากเอกสาร/ข้อความ | `pod_check` | อ่าน |
| บัญชี | `get_invoice`, `search_invoices`, `list_overdue_receivables`, `get_subcontractor_settlement` | อ่าน |
| บัญชี | `create_invoices_from_delivered` (DO ส่งแล้ว + POD ผ่าน → ร่างใบแจ้งหนี้) | ร่าง |
| รถ | `get_vehicle`, `list_expiring_documents`, `list_maintenance_due`, `get_fuel_anomalies` | อ่าน |
| รถ | `report_incident` | ร่าง |
| ข้อมูลหลัก | `search_customers`, `search_locations`, `quote_rate` | อ่าน |
| ข้อมูลหลัก | `upsert_customer`, `upsert_location` | เขียน |
| รายงาน | `get_profit_by_trip`, `get_profit_by_customer`, `get_otif`, `get_fleet_cost_per_km` | อ่าน |
| ข้อยกเว้น | `list_exceptions` | อ่าน |
| ข้อยกเว้น | `assign_exception`, `resolve_exception` | เขียน |

5. **กฎธุรกิจ**
- **INT-140** [DECISION] URL เดียวทุกลูกค้า ไม่มี company/user id ใน URL — tenant และผู้ใช้ระบุจาก OAuth token เท่านั้น
- **INT-141** [DECISION] สิทธิ์ที่มีผล = permission ของ role ผู้ใช้ (01 §12) ∩ scope ของการเชื่อมต่อ ∩ tool ที่เปิดใน `McpToolSetting` ∩ entitlement; ตรวจทุกครั้งที่เรียก (role เปลี่ยน มีผลทันที)
- **INT-142** [DECISION] ระดับ tool: **อ่าน** — คืนข้อมูล ไม่เปลี่ยนอะไร · **ร่าง** — สร้างรายการสถานะร่าง/รอยืนยันใน TMS เท่านั้น ไปอยู่ในกล่องรับงานหรือรายการรอยืนยันของโมดูลนั้น ป้าย **"จาก MCP · {ชื่อผู้ใช้}"**, tool คืน id + ลิงก์ให้ผู้ใช้ไปยืนยัน · **เขียน** — มีผลทันทีหลัง AI client ขอการยืนยันจากผู้ใช้ (tool รับ `confirm: true` ในการเรียกครั้งที่สองหลังแสดงสรุป) [PROPOSED]
- **INT-143** [DECISION] tool ที่กระทบเงิน ภาษี การจ่ายงานรถ หรือการลบ เป็นระดับ **ร่าง** เสมอ — ห้ามตั้งเป็นเขียน (D5)
- **INT-144** ตัวช่วยใน tool ร่าง: ออกเลขเอกสารให้เอง; จับคู่ลูกค้า/สถานที่จากชื่อหรือเลขผู้เสียภาษีหรือที่อยู่ข้อความ; จับคู่ไม่ได้หรือกำกวม (> 1 ตัวเลือก) → tool คืน `needs_clarification` พร้อมตัวเลือก ให้ AI ถามผู้ใช้กลับ — ห้ามเดา
- **INT-145** ข้อมูลที่ tool คืนเป็นข้อมูล ไม่ใช่คำสั่ง: ฟิลด์ข้อความอิสระ (หมายเหตุ, ข้อความลูกค้า) ห่อด้วย marker `untrusted_content` ใน tool result [PROPOSED] (กัน prompt injection — 08 AI-005)
- **INT-146** การเรียก tool นับ usage แยก source `mcp` (INT-083) และบันทึกใน ApiRequestLog (`channel=mcp`, toolName, userId, connectionId); tool ที่ใช้ AI นับ AI credit เพิ่ม
- **INT-147** เพิกถอนการเชื่อมต่อ: ผู้ใช้เจ้าของหรือผู้ดูแล → token ใช้ไม่ได้ ≤ 60 วิ; ผู้ใช้ถูกปิด → ทุกการเชื่อมต่อของผู้ใช้เพิกถอนอัตโนมัติ (ต่างจาก API key — 01 PLT-036)
- **INT-148** ไฟล์แนบที่ส่งผ่าน tool เก็บใน storage ของ TMS; ชนิด jpg/png/heic/pdf/xlsx/csv, ≤ 10 MB/ไฟล์ [PROPOSED]
- **INT-149** ห้าม impersonate หรือใช้สิทธิ์ทีมเราผ่าน MCP (01 PLT-125)
6. **สถานะ** — McpConnection: `active` → `revoked` (ผู้ใช้/ผู้ดูแล/ระบบ) · `active` → `expired` (refresh token ไม่ใช้ 30 วัน)
7. **Event** — `mcp.connection_authorized`, `mcp.connection_revoked`, `mcp.draft_created {toolName, objectType, objectId}` (audit + แจ้งผู้ใช้ในแอป)
8. **กรณีผิดปกติ** — tool ถูกปิดโดยผู้ดูแล → error `tool_disabled` ข้อความไทยให้ AI แจ้งผู้ใช้; role ไม่มีสิทธิ์ → `permission_denied` พร้อมบอกโมดูล; tenant read_only → tool ร่าง/เขียน ตอบ `tenant_read_only`; AI credit หมด → tool กลุ่มเอกสาร ตอบ `ai_credit_exhausted`
9. **เกณฑ์ตรวจรับ**
- Given ผู้ใช้ viewer อนุญาต scope `orders:write` When AI เรียก `create_order` Then `permission_denied` (role ∩ scope)
- Given dispatcher When AI เรียก `create_order` ด้วย "พรุ่งนี้ 8 โมง รับปูน 24 ตันที่คลังอยุธยา ส่งโรงงานสระบุรี ขอรถพ่วง 1 คัน PO 45890" Then เกิด SO ร่างในกล่องรับงาน ป้าย "จาก MCP · {ชื่อ}" และไม่มี DO/เที่ยวถูกสร้าง
- Given AI เรียก `create_invoices_from_delivered` Then ได้ใบแจ้งหนี้สถานะร่างเท่านั้น
10. **เฟส** — P1: tool อ่าน + ร่างกลุ่มงานขนส่ง/ติดตาม/บัญชีอ่าน · P2: tool เขียน, กลุ่มจากเอกสาร, วางแผน, รายงานกำไร [PROPOSED — ai-mcp-plan วาง MCP อ่านระยะ 2, เขียนระยะ 3]

---

## 14. สิ่งที่ไม่ลอกจาก TRCloud (อ้างอิง trcloud-api-mcp-learning §3)

| TRCloud ทำ | เราทำแทน | ข้อ |
|---|---|---|
| auth ด้วย passkey + MD5 securekey ใน body; secret แสดงเต็มในตาราง | Bearer token ใน header, secret แสดงครั้งเดียว, เก็บ hash, scope/IP/expiry ต่อ key, rotate | INT-062, INT-070 |
| JSON ห่อใน `x-www-form-urlencoded` | `application/json` ตรง, HTTP status ถูกต้อง, problem+json, OpenAPI | INT-052, INT-056 |
| ฟิลด์อิสระ `c1`–`c20` ไม่มีชื่อ/ชนิด/กฎ | custom fields มีชื่อ ชนิด กฎ (02) และอยู่ใน spec | INT-060 |
| MCP URL มี `company` / `user` id ใน query | URL เดียว ระบุจาก OAuth token | INT-140 |
| MCP ใช้สิทธิ์ระดับบริษัท | role ผู้ใช้ ∩ scope การเชื่อมต่อ | INT-141 |
| tool เขียนบันทึกจริงทันที (แค่ทวนตัวเลข) | ระดับ อ่าน/ร่าง/เขียน; เงิน/ภาษี/จ่ายงาน/ลบ = ร่างเสมอ | INT-142, INT-143 |
| Test API ยิงข้อมูลจริงและนับ usage | "ลองเรียก" เฉพาะ Sandbox | INT-061, §9 |
| ไม่เห็น webhook, log รายครั้ง, scope ต่อ key, rate limit docs | มีครบ | §6–§10 |

สิ่งที่หยิบมา (ปรับเป็นแบบของเรา ไม่ลอกหน้าตา): API กับ MCP ใช้ตารางฟิลด์เดียวกัน, ชื่อ tool verb_entity, tool "งานธุรกิจ" นอก CRUD, tool จากเอกสารแยกตามชนิด, หน้าเชื่อมต่อ 3 ขั้นแยกแท็บตามโปรแกรม AI, เอกสาร tool เขียนเพื่อผู้ใช้ทั่วไป (ประโยคตัวอย่าง + ข้อควรรู้), ออกเลขเอกสาร/upsert คู่ค้าให้, dashboard แยกนับอ่าน/สร้าง/แก้

---

## 15. Entity ของโมดูล (สรุป — ฉบับเต็มใน 10-data-model)

`ConnectorDefinition`, `ConnectorInstance`, `ConnectorDocTypeConfig`, `ConnectorMapping`, `SyncRecord`, `SyncAttempt`, `ExternalMapping`, `ExportTemplate`, `ExportJob`, `ApiKey`, `ApiRequestLog`, `IdempotencyKey(tenantId, key, path, requestHash, responseRef, status, expiresAt)`, `WebhookEndpoint`, `WebhookEvent` (outbox), `WebhookDelivery(eventId, endpointId, attempt, status, httpStatus, durationMs, nextAttemptAt)`, `MappingProfile`, `MappingRule`, `MappingFailure`, `McpClient`, `McpConnection`, `McpToolSetting`

## 16. รายการ [OPEN] ของไฟล์นี้

| # | คำถาม | อ้างอิง |
|---|---|---|
| O-INT-1 | ลำดับ connector ที่ทำก่อน (เลือกจากความต้องการลูกค้าเฟส 0) | §1 เฟส |
| O-INT-2 | ใบกำกับภาษีที่ต้องออก/พิมพ์ทันที เมื่อระบบบัญชีเป็นผู้ออกเลข (โหมด external) | INT-013 |
| O-INT-3 | นโยบายเอกสารย้อนงวดเมื่องวดบัญชีปลายทางปิดแล้ว (ถามผู้ให้บริการ ERP แต่ละราย) | §2 กรณีผิดปกติ |
| O-INT-4 | template ไฟล์นำเข้าจริงของ Express / PEAK / FlowAccount สำหรับ export | INT-043 |
| O-INT-5 | ค่า rate limit ต่อแพ็กเกจ (ต้นแบบ 60/300/1,000 ต่อนาที vs ชั้นระบบ 50 req/s ต่อ tenant) | INT-080, INT-081 |
| O-INT-6 | ระยะ retry webhook: 8 ครั้งใน 24 ชม. (ต้นแบบ) หรือ ~3 วัน (benchmark) | INT-103 |
| O-INT-7 | เกณฑ์ auto-disable webhook | INT-105 |
| O-INT-8 | แพ็กเกจที่ได้ `api.write` และ MCP server | INT-064, §13 |
