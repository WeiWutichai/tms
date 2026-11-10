# 03 — รับงาน วางแผน และจ่ายงาน (Orders & Planning)

> ⚠️ **ลำดับความสำคัญ (10 พ.ย. 2569):** ไฟล์นี้เขียนโดยไม่ได้อ่าน `docs/` (v2) เมื่อเนื้อหาขัดกับ `docs/` ให้ยึด `docs/` — ดู `plan/00-source-of-truth.md` และรายการจุดที่ขัดกันใน `plan/00a-reconcile-architecture.md`, `plan/00b-reconcile-requirements.md` · ป้าย P0/P1/P2 ในไฟล์นี้เป็นมาตราส่วนของ spec ไม่ใช่ "เฟส 0" ของแผนพัฒนา

> รหัสข้อกำหนด: `ORD-nnn` (กล่องรับงาน, SO, DO) · `PLN-nnn` (เที่ยวรถ, กระดานวางแผน, กฎห้ามจ่ายงาน, เสนอรถ, จ่ายงานรถร่วม, ส่งแผน) · สถานะเอกสาร: ร่าง v0.1 (9 พ.ย. 2569)
> แหล่งที่มา: design-briefs รอบ 2 (การ์ดเสนอรถ), 3 (เที่ยวรถ/รถร่วม), 6 ข้อ 4 (กฎห้ามจ่ายงาน), 9 (drawer SO + กระดาน), 10 (lane, 7 วัน, popover คนขับ, VAT ตามลูกค้า), 11 (webhook events), 12 (custom fields), 14 (กล่องรับงาน/AI/MCP) · tms-product-learning §3.3 (O1–O4), §3.4 (PL1–PL10)
> อ้างอิงข้าม: ข้อมูลหลัก/ราคา → [02-master-data.md](02-master-data.md) · การวิ่งงาน แอปคนขับ POD หน้ารถร่วม → [04-execution.md](04-execution.md) · วางบิล เงินเบิก settlement → [05-billing.md](05-billing.md) · รถ/เอกสารรถ/ผลตรวจรถ → [06-fleet.md](06-fleet.md) · API/webhook → [07-integration.md](07-integration.md) · AI แปลงข้อความเป็น SO → [08-ai.md](08-ai.md)

## สารบัญ

| § | หัวข้อ | รหัส | เฟส |
|---|---|---|---|
| 0 | โมเดลข้อมูลและ flow | – | – |
| 1 | กล่องรับงาน (Inbox) | ORD-001–019 | P0 (LINE/อีเมล/API), P1 (MCP) |
| 2 | ใบสั่งขนส่ง (SO) | ORD-020–079 | P0 |
| 3 | ใบส่งของ (DO) | ORD-080–099 | P0 |
| 4 | เที่ยวรถ / ใบคุมรถ (Trip) | PLN-001–039 | P0 |
| 5 | กระดานวางแผน | PLN-040–079 | P0 |
| 6 | กฎห้ามจ่ายงาน | PLN-080–109 | P0 |
| 7 | เสนอรถ | PLN-110–129 | P1 |
| 8 | จ่ายงานรถร่วม | PLN-130–169 | P0 (ส่งทีละราย) / P1 (cascade อัตโนมัติ) |
| 9 | ส่งแผนให้คนขับ | PLN-170–189 | P0 |
| 10 | Event รวม + [OPEN] | – | – |

---

## 0. โมเดลข้อมูลและ flow

```
Inbox message ──(สร้าง SO)──▶ SO (1 งานของลูกค้า: stops + items + ราคา)
                                │ ยืนยัน
                                ▼
                     DO × N (1 ใบต่อ 1 จุดส่ง [ต่อ 1 คันถ้าแยก])
                                │ ลากเข้าเที่ยว / จ่ายรถร่วม
                                ▼
          Trip (ใบคุมรถ: รถ + คนขับ + หาง, TripStop เรียงลำดับ, หลาย DO หลาย SO)
                                │ ส่งแผน → วิ่ง → POD (04)
                                ▼
                 DO delivered + POD ผ่าน → วางบิล (05) / ค่าเที่ยว-settlement (05)
```

| ความสัมพันธ์ | กฎ |
|---|---|
| SO 1 — n DO | DO สร้างเมื่อ SO ยืนยัน (ORD-081) |
| DO n — 1 Trip (ต่อ leg) | DO อยู่ได้ทีละ 1 เที่ยวที่ active; ถ้าส่งไม่สำเร็จแล้วส่งใหม่ = leg ใหม่ในเที่ยวใหม่ (PL1) |
| Trip 1 — n TripStop | stop รับ/ส่งเรียงลำดับ; 1 stop อ้างได้หลาย DO (เช่น รับของหลาย DO ที่คลังเดียวกัน) |
| Trip — รถ/คนขับ/หาง | เก็บ **snapshot ต่อเที่ยว** (PL1) — เปลี่ยนคนขับประจำรถไม่กระทบเที่ยวเก่า |
| API naming | SO = `orders`, DO = `shipments`, Trip = `trips` (07) |

เลขเอกสาร (ตั้ง prefix/รูปแบบได้ที่ตั้งค่าเลขเอกสาร — 05): ค่าเริ่มต้น `SO-YYMM-NNNN`, `DO-YYMM-NNNN`, `TRP-YYMM-NNNN` (YY/MM เป็น พ.ศ. 2 หลักท้าย เช่น SO-6911-0126 [PROPOSED] หรือ ค.ศ. ตามตั้งค่า); เอกสารปฏิบัติการออกเลขตอนสร้าง (ไม่ใช่ตอน finalize แบบเอกสารภาษี) ข้ามเลขได้

---

## 1. กล่องรับงาน (Inbox)

**1. จุดประสงค์** — รวมคำสั่งงานที่เข้ามาจากนอกระบบ (LINE OA, อีเมล, MCP, API) ไว้ที่เดียว ให้ dispatcher ตรวจและแปลงเป็น SO โดย AI ช่วยร่าง (การ parse ข้อความ/ไฟล์ด้วย AI กำหนดใน 08-ai.md) — ไม่มีอะไรกลายเป็น SO ยืนยันเองอัตโนมัติ (D5)

**2. ผู้ใช้/สิทธิ์** — ดู/จัดการ: dispatcher, manager · ตั้งค่าช่องทาง: admin · สิทธิ์ `inbox.view`, `inbox.process`

**3. หน้าจอ** (เมนู ปฏิบัติการ → กล่องรับงาน; ตัวนับ sidebar = รอตรวจ)
- แท็บสถานะ: รอตรวจ · สร้าง SO แล้ว · ไม่ใช่งาน · ทั้งหมด; ตัวกรอง: แหล่ง, ลูกค้า (ที่จับคู่ได้), ผู้รับผิดชอบ, ช่วงเวลา
- รายการซ้าย (แบบกล่องข้อความ): ไอคอนแหล่ง, ผู้ส่ง/ลูกค้า, ข้อความย่อ 2 บรรทัด, จำนวนไฟล์แนบ, เวลาที่รอ (ส้มเมื่อ > SLA)
- แผงขวา: ต้นฉบับ (ข้อความ/อีเมล/ไฟล์ preview, ไฮไลต์ส่วนที่ AI ดึง) + SO ร่าง 1..n ใบ (ฟอร์ม SO เต็มแบบเดียวกับ §2) + ปุ่ม "สร้าง SO" / "สร้างทั้งหมด" / "ไม่ใช่งาน" / "มอบหมาย" / "ตอบกลับ" (LINE/อีเมล ข้อความสำเร็จรูป เช่น "รับงานแล้ว เลขที่ SO-…")
- ตั้งค่า → ช่องทางรับงาน: LINE OA (เชื่อม channel), อีเมลรับงาน (ที่อยู่เฉพาะ tenant), กฎจับคู่ผู้ส่ง → ลูกค้า, SLA (นาที), ผู้รับผิดชอบเริ่มต้น

**4. ฟิลด์ — InboxMessage**

| ฟิลด์ | ชนิด | บังคับ | หมายเหตุ |
|---|---|---|---|
| `source` | enum `line_oa` / `email` / `mcp` / `api` / `upload` | ✓ | upload = ผู้ใช้วาง/อัปโหลดเองจากปุ่ม "สร้างจากข้อความ/ไฟล์" |
| `receivedAt` | datetime | ✓ | |
| `externalMessageId` | string | ✓ | LINE message id / Message-ID อีเมล / idempotency key — unique ต่อ source (กันซ้ำ) |
| `sender` | {name, lineUserId?, email?, phone?, userId? (MCP)} | ✓ | |
| `matchedCustomerId` | ref | – | จับคู่จาก lineUserId/อีเมลผู้ติดต่อ (02 MD-030) หรือโดเมนอีเมล หรือ AI (ต้องยืนยัน) |
| `subject`, `bodyText` | text | – | |
| `attachments` | file[] | – | PDF, xlsx, csv, jpg/png ≤ 20 MB/ไฟล์ |
| `parseJobId`, `parseStatus` | ref, enum `not_started`/`processing`/`done`/`failed`/`skipped` | – | ผลการ parse (08) |
| `draftOrders` | SO draft[] | – | 0..n ร่าง |
| `status` | enum `pending_review` รอตรวจ / `converted` สร้าง SO แล้ว / `not_order` ไม่ใช่งาน | ✓ | |
| `notOrderReason` | enum `chat` / `inquiry` / `duplicate` / `spam` / `other` + note | ✓ ถ้า not_order | |
| `assigneeUserId` | ref | – | |
| `createdOrderIds` | ref[] | – | |
| `mcpContext` | {clientName, userId, toolName} | – | แสดงป้าย "จาก MCP · {ชื่อผู้ใช้}" |

**5. กฎธุรกิจ**

| รหัส | กฎ |
|---|---|
| ORD-001 | LINE OA: ข้อความ/รูป/ไฟล์จากผู้ใช้ LINE ที่ผูกกับผู้ติดต่อลูกค้า → สร้าง InboxMessage; ข้อความต่อเนื่องจากผู้ส่งเดียวกันภายใน 5 นาที รวมเป็นรายการเดียว [PROPOSED]; ผู้ส่งที่ยังไม่ผูก → เข้ากล่องโดย `matchedCustomerId` ว่าง |
| ORD-002 | อีเมล: ที่อยู่รับงานเฉพาะ tenant (เช่น `orders-{slug}@in.<domain>`) หรือ forward จากอีเมลบริษัท; แยก 1 อีเมล = 1 รายการ, ไฟล์แนบเก็บทั้งหมด; ตรวจ SPF/DKIM — ไม่ผ่านแสดงป้าย "ผู้ส่งไม่ยืนยัน" |
| ORD-003 | API: `POST /v1/orders` ด้วย `status=draft` หรือ shipper key (02 MD-029) → สร้าง SO ร่างพร้อม InboxMessage source `api` ที่ชี้ SO นั้น; `POST /v1/inbox-messages` (ข้อความดิบให้ AI parse) [P1] |
| ORD-004 | MCP: tool ระดับ "ร่าง" (`create_order`, `order_from_text`, `order_from_document`) สร้าง InboxMessage source `mcp` + SO ร่าง เสมอ — ไม่ยืนยัน SO ผ่าน MCP (D5) |
| ORD-005 | เมื่อเปิด AI รับงาน (ตั้งค่า AI) ระบบส่ง parse อัตโนมัติเมื่อรายการเข้า (หัก AI credit ตาม 08) ; ปิด AI = ผู้ใช้กรอก SO เองในแผงขวา |
| ORD-006 | "สร้าง SO" จากร่าง: ตรวจฟิลด์ตาม §2 → SO สถานะ `draft` หรือ `confirmed` (ตามปุ่ม "สร้างและยืนยัน"); ทุก SO จาก inbox เก็บ `sourceChannel` และ `inboxMessageId` (O2); InboxMessage → `converted` เมื่อร่างทุกใบถูกสร้างหรือทิ้ง |
| ORD-007 | กันซ้ำ: ถ้าลูกค้า + เลข PO ลูกค้าตรงกับ SO ที่ไม่ยกเลิกใน 90 วัน → เตือน "อาจซ้ำกับ {SO}" ต้องกดยืนยันว่าสร้างต่อ |
| ORD-008 | "ไม่ใช่งาน" ต้องเลือกเหตุผล; ย้อนกลับเป็นรอตรวจได้ภายใน 30 วัน |
| ORD-009 | SLA รอตรวจ (ค่าเริ่มต้น 30 นาทีในเวลาทำการ) — เกินแสดงสีส้ม และแจ้งผู้รับผิดชอบ/manager ครั้งเดียว |
| ORD-010 | ล็อกการทำงาน: ผู้ใช้เปิดรายการ → ป้าย "กำลังตรวจโดย {ชื่อ}" ให้ผู้อื่น (O4); ผู้อื่นยังเปิดดูได้ แต่กดสร้าง SO ต้องยืนยัน "ยึดงาน" |
| ORD-011 | ตอบกลับ LINE/อีเมลจากกล่องรับงานบันทึกในกิจกรรมของรายการ; ข้อความอัตโนมัติ "รับเรื่องแล้ว" เปิด/ปิดได้ต่อช่องทาง |

**6. สถานะ**

| จาก → ไป | เงื่อนไข | ใคร | ผลข้างเคียง |
|---|---|---|---|
| (เข้า) → pending_review | ข้อความใหม่ไม่ซ้ำ `externalMessageId` | ระบบ | parse (ถ้าเปิด), ตัวนับ sidebar +1 |
| pending_review → converted | สร้าง SO ≥ 1 และไม่มีร่างค้าง | dispatcher | ลิงก์ SO, ตอบกลับอัตโนมัติ (ถ้าเปิด) |
| pending_review → not_order | เหตุผล | dispatcher | ตัวนับ −1 |
| not_order → pending_review | ภายใน 30 วัน | dispatcher | |
| converted → pending_review | SO ทั้งหมดที่สร้างถูกยกเลิกด้วยเหตุผล "สร้างซ้ำ/ผิด" | ระบบเสนอ, คนยืนยัน | |

**7. Event** — `inbox.message_received`, `inbox.message_converted`, `inbox.message_dismissed` (ภายใน/แจ้งเตือน; ไม่ส่ง webhook)

**8. กรณีผิดปกติ** — parse ล้มเหลว/AI credit หมด → แสดง "AI อ่านไม่ได้ กรอกเอง" พร้อมต้นฉบับ · ไฟล์ใหญ่เกิน → เก็บข้อความ ไฟล์ขึ้นเหตุผล · LINE webhook ส่งซ้ำ → กันด้วย `externalMessageId` · ข้อความเดียวหลายงาน → หลาย SO ร่าง (08) · ลูกค้าจับคู่ไม่ได้ → บังคับเลือกลูกค้าก่อนสร้าง SO

**9. เกณฑ์ตรวจรับ**
- Given ผู้ติดต่อ LINE ผูกกับลูกค้า "ปูนไทย" ส่ง "พรุ่งนี้ 8 โมง รับปูน 24 ตัน ที่คลังอยุธยา ส่งโรงงานสระบุรี ขอรถพ่วง 1 คัน PO 45890" When ข้อความเข้า Then มีรายการรอตรวจ ลูกค้าจับคู่แล้ว และ SO ร่าง 1 ใบ (ถ้าเปิด AI) ที่มี PO 45890
- Given SO ร่างจาก MCP When dispatcher เปิดกล่อง Then เห็นป้าย "จาก MCP · {ชื่อผู้ใช้}" และ SO ยังเป็นร่าง
- Given PO 45890 ของลูกค้าเดียวกันมี SO อยู่แล้ว When สร้าง SO Then มีคำเตือนซ้ำ

**10. เฟส** — P0: LINE OA, อีเมล, API, upload, สถานะ 3 ค่า · P1: MCP (ตาม 07/08), `POST /inbox-messages`, รวมข้อความต่อเนื่อง

---

## 2. ใบสั่งขนส่ง (SO)

**1. จุดประสงค์** — คำสั่งงาน 1 งานจากลูกค้า: จุดรับ-ส่ง สินค้า ประเภทรถ ช่วงเวลา และราคาขายที่ snapshot จาก rate card — เป็นต้นทางของ DO, การวางแผน และการวางบิล

**2. ผู้ใช้/สิทธิ์** — สร้าง/แก้: dispatcher, manager (`order.create/edit`) · ยืนยัน: dispatcher (`order.confirm`) · ยกเลิก: dispatcher ก่อนจัดรถ, manager หลังจัดรถ (`order.cancel`) · ราคา: ตาม 02 MD-012 · shipper: ผ่าน API/portal เฉพาะของตัวเอง

**3. หน้าจอ**
- รายการ SO: KPI/แถบสรุป (รอยืนยัน · รอจัดรถ · กำลังขนส่ง · เกินกำหนด · ยังไม่วางบิล) คลิกกรอง → แท็บสถานะ → ตาราง (เลข SO, ลูกค้า, PO ลูกค้า, วันรับ, เส้นทาง "อยุธยา → สระบุรี", ประเภทรถ, น้ำหนัก, ยอดรวม, สถานะ, ที่มา, custom fields) → drawer
- ปุ่มสร้าง: "+ สร้าง SO" (หลัก) · "สร้างจากข้อความ/ไฟล์" (ไป §1/08) · "นำเข้า CSV/Excel" · เมนู ⋯ ของ SO "คัดลอกเป็นใบใหม่"
- ฟอร์มสร้าง/แก้ (หน้าเต็มหรือ drawer กว้าง): ลูกค้า → (เติมค่าตั้งต้นจากลูกค้า) → จุดรับ-ส่ง (เลือกจากสถานที่, ลากเรียง, เพิ่มจุด) → สินค้า → ประเภทรถ/จำนวนคัน → ช่วงเวลา → ราคา (คำนวณสด) → หมายเหตุ → ข้อมูลเพิ่มเติม; ปุ่ม "บันทึกร่าง" / "บันทึกและยืนยัน"
- **Drawer SO** (00-overview §6, รอบ 9): กว้าง 600px (จอแคบ 100%)
  - หัว: "ใบสั่งขนส่ง" / `SO-…` (18/600 accent) + ป้ายสถานะ / ชื่อลูกค้า · PO ลูกค้า; ขวาบน ⋯ (แก้ไข · คัดลอกเป็นใบใหม่ · พิมพ์ · ยกเลิกเอกสาร) + ปิด
  - แท็บ: สรุป · สินค้า · เอกสารแนบ · กิจกรรม (timeline สถานะ ใครทำ เมื่อไร + log ระบบ)
  - แท็บสรุป section: **ข้อมูลงาน** (grid 2 คอลัมน์: ลูกค้า, รหัสลูกค้า, ประเภทรถที่ต้องการ, น้ำหนัก/ปริมาตร, กำหนดส่ง — เกินกำหนดสีแดง `#B3322A` "เกิน 1 วัน", ที่มา: สร้างเอง / นำเข้า CSV / API / ERP / LINE / อีเมล / MCP) · **จุดรับ–ส่ง** (ลำดับแนวตั้งมีเส้นเชื่อม: ชื่อสถานที่ ที่อยู่ย่อ ช่วงเวลา ผู้ติดต่อ+เบอร์) · **รถ/คนขับ** (ยังไม่จัด: "ยังไม่จัดรถ" + ลิงก์ "จัดรถ"; จัดแล้ว: ทะเบียน คนขับ เที่ยว (ลิงก์) ต่อ DO) · **ราคา** (ตารางแจกแจงชิดขวา: ค่าขนส่งตาม rate card พร้อมคำอธิบาย "อยุธยา → สระบุรี · พ่วง · 65 กม.", ค่ารอ, ค่าขึ้น/ลงสินค้า, ค่าน้ำมันเพิ่ม, ค่าจุดเพิ่ม, ส่วนลด → รวมก่อน VAT (แยก ยกเว้น VAT / ฐาน VAT 7%), VAT, รวมทั้งสิ้น, หัก ณ ที่จ่ายโดยประมาณ; ลิงก์เล็ก "เปลี่ยนเรท"; ไม่พบเรท = คำเตือน 1 บรรทัด + ปุ่ม "กำหนดราคาเอง") · **หมายเหตุ** (ถึงลูกค้า/ภายใน) · **ข้อมูลเพิ่มเติม**
  - ห้ามชิปเทาครอบชื่อเส้นทาง — เขียนข้อความธรรมดา
  - Footer ติดล่าง: ซ้าย ยอดรวม (label เล็ก + 20/600); ขวา ปุ่มรอง "ส่งต่อรถร่วม" (outline ไม่มีไอคอน) + ปุ่มหลัก "จัดรถ" (เปลี่ยนตามสถานะ: ร่าง → "ยืนยัน SO")

**4. ฟิลด์ — SO (หัว)**

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| `orderNo` | string | auto | unique (tenant) | |
| `customerId` | ref | ✓ | ลูกค้า active, ไม่ creditHold สำหรับยืนยัน | snapshot ชื่อ/taxId/สาขา/ที่อยู่บิล (MD-005) |
| `customerRef` (PO ลูกค้า) | string(50) | เงื่อนไข | บังคับถ้า `customer.customerRefRequired` | ORD-007 กันซ้ำ |
| `externalId` | string(100) | – | unique ต่อ (tenant, source) | upsert ทาง API `PUT /orders/{externalId}` (O1) |
| `sourceChannel` | enum `manual`/`csv`/`api`/`erp`/`line`/`email`/`mcp`/`copy` | auto | | แสดงเป็นคำไทย |
| `serviceDate` (วันรับของ) | date | ✓ | ≥ วันนี้ − 7 (ย้อนหลังต้องสิทธิ์ manager) | ใช้หาเรท (MD-110) |
| `requiredVehicleTypeId` | ref | ✓ | active | [DECISION] บังคับ |
| `vehicleCount` | int | ✓ | 1–50, default 1 | ORD-084 |
| `stops` | OrderStop[] | ✓ | ≥ 1 pickup และ ≥ 1 drop; pickup แรกต้องมาก่อน drop แรก | |
| `items` | OrderItem[] | – | | ไม่บังคับ แต่ต้องมีน้ำหนักรวม (ORD-028) |
| `totalWeightKg` | decimal(12,3) | ✓ | > 0 | คำนวณจาก items หรือกรอกเอง |
| `totalVolumeCbm` | decimal(10,3) | – | ≥ 0 | |
| `specialHandling` | set {fragile, hazardous, temp_controlled} | auto | จาก items + เลือกเพิ่มได้ | ส่งผลกับ PLN-084/086 |
| `tempRangeC` | {min, max} | เงื่อนไข | | ถ้า temp_controlled |
| `priceLines` | OrderCharge[] | ✓ เมื่อยืนยัน | ORD-040–049 | |
| `rateSnapshot` | JSON | auto | MD-117 | |
| `currency` | 'THB' | auto | | |
| `subtotalExempt`, `subtotalVatable`, `vatAmount`, `grandTotal`, `whtEstimate`, `netReceivableEstimate` | decimal(14,2) | auto | | |
| `noteToCustomer` | text(1,000) | – | | พิมพ์บนใบส่งของ/แสดงหน้าติดตาม |
| `internalNote` | text(2,000) | – | | ไม่ออกนอกระบบ (ไม่อยู่ใน API shipper, ไม่พิมพ์) |
| `driverNote` | text(1,000) | – | | แสดงในแอปคนขับ |
| `salesOwnerUserId` | ref | – | default จากลูกค้า | |
| `customFields` | JSON | ตามนิยาม | 02 §10 | |
| `status` | enum (ข้อ 6) | ✓ | | |
| `billingStatus` | enum `not_ready`/`ready`/`partially_billed`/`billed` | auto | | แยกจากสถานะงาน (D3 แนวเดียวกัน) |
| `cancelReasonCode`, `cancelNote`, `cancelledBy/At` | | เงื่อนไข | MD-222 | |
| `lockedBy`, `lockedAt` | | auto | ORD-031 | |
| `version` | int | auto | MD-007 | |

**OrderStop**

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| `sequence` | int | ✓ | ต่อเนื่อง 1..n | |
| `type` | enum `pickup`/`drop` | ✓ | | |
| `locationId` | ref Location | ✓ | active, มีพิกัดเมื่อยืนยัน (MD-051) | snapshot (MD-052) |
| `windowStart`, `windowEnd` | datetime | ✓ start, end ไม่บังคับ | start < end; เตือนถ้านอกเวลาทำการ (MD-053) | |
| `appointmentRef` | string | เงื่อนไข | บังคับถ้า location.appointmentRequired | |
| `serviceMinutes` | int | – | default จาก location | |
| `contactName`, `contactPhone` | | – | default จาก location | |
| `instructions` | text | – | | |
| `itemAllocations` | {itemId, qty}[] | ✓ สำหรับ drop ถ้ามี items | ผลรวม drop = ผลรวม pickup ต่อ item | กำหนดว่าจุดส่งไหนได้อะไร |

**OrderItem**: `productId` (ไม่บังคับ — MD-074), `description` ✓, `qty` ✓ > 0, `unitId` ✓, `weightKg` (คำนวณ MD-070 / แก้ได้), `volumeCbm`, `handlingFlags`, `customerItemRef`, `lotNo`

**OrderCharge (บรรทัดราคา)**: `accessorialCode` ✓ (FREIGHT/EXTRA_STOP/FSC/WAIT/LOAD/…/DISCOUNT/MANUAL), `description`, `qty`, `unit`, `rate`, `amount`, `vatTreatment` (snapshot: `exempt_transport`/`vat7`/`none`), `whtType`, `source` (`rate_card`/`auto`/`manual`/`suggested`), `status` (`active`/`pending_approval`/`suggested`), `appliesToLineId` (สำหรับส่วนลด), `dropStopSequence` (ถ้าเป็นของจุดใดจุดหนึ่ง)

**5. กฎธุรกิจ**

*การสร้าง*

| รหัส | กฎ |
|---|---|
| ORD-020 | ช่องทางสร้าง: manual, CSV/Excel (template SO หลายแถว 1 แถวต่อ stop จัดกลุ่มด้วยคอลัมน์ `order_ref`; ใช้ wizard + dry-run เดียวกับ 02 §11), API (`POST /orders`, `PUT /orders/{externalId}` idempotent), inbox (§1), คัดลอก (ORD-022), connector ERP (07) |
| ORD-021 | เลือกลูกค้าแล้วเติมค่าตั้งต้น: จุดรับ (`defaultPickupLocationId`), ประเภทรถ, สถานที่ของลูกค้าขึ้นก่อนใน dropdown, ข้อมูล custom fields default |
| ORD-022 | คัดลอกเป็นใบใหม่: คัดลอก ลูกค้า stops items ประเภทรถ หมายเหตุ custom fields (MD-248) — ไม่คัดลอก PO ลูกค้า วันที่ (ตั้งเป็นวันถัดไปเวลาเดิม) ราคา (คำนวณใหม่จาก rate card ปัจจุบัน) ไฟล์แนบ |
| ORD-023 | `POST /orders` รองรับ header `Idempotency-Key` (24 ชม.); `PUT /orders/{externalId}` แก้ได้เฉพาะ SO สถานะ draft/confirmed ที่ยังไม่มี DO ในเที่ยว — หลังจากนั้นตอบ 409 `order_locked_for_update` |
| ORD-024 | SO ที่สร้างผ่าน API ด้วย key ภายใน (ไม่ใช่ shipper) สร้างเป็น `confirmed` ได้ถ้าส่ง `status=confirmed` และผ่านกฎยืนยันทั้งหมด มิฉะนั้นเป็น draft |
| ORD-025 | stop ใช้สถานที่จากข้อมูลหลักเท่านั้น; ที่อยู่ใหม่ → "สร้างสถานที่ด่วน" (ชื่อ ที่อยู่ ปักหมุด) ในฟอร์มโดยไม่ออกจากหน้า |
| ORD-026 | ช่วงเวลา: drop windowStart ต้อง ≥ pickup windowStart แรก; ถ้า `transitHours` จาก rate card ทำให้ไปไม่ทัน windowEnd ของ drop → เตือน "เวลาอาจไม่พอ (ประมาณ X ชม.)" ไม่บล็อก |
| ORD-027 | ประเภทรถบังคับ; ถ้าน้ำหนักรวม > payload × vehicleCount → เตือน "น้ำหนักเกินความจุ ต้องใช้อย่างน้อย N คัน" พร้อมปุ่มปรับ vehicleCount |
| ORD-028 | ต้องมีน้ำหนักรวม > 0 ก่อนยืนยัน (ใช้ตรวจความจุ PLN-087) |

*ราคา*

| รหัส | กฎ |
|---|---|
| ORD-040 | เมื่อมีลูกค้า + ต้นทาง + ปลายทาง + ประเภทรถ + วันที่ ระบบหาเรทตาม MD-110–113 และสร้างบรรทัด `FREIGHT` (source rate_card) × vehicleCount, `EXTRA_STOP` (MD-115), `FSC` (MD-116) อัตโนมัติ; คำนวณใหม่เมื่อฟิลด์ input เปลี่ยนขณะ SO เป็น draft |
| ORD-041 | ค่าบริการเสริมที่รู้ล่วงหน้า (ขึ้น/ลงสินค้า, ค่าค้างคืน) เพิ่มจาก catalog (02 §6) ด้วยอัตรา MD-151; ค่ารอเกิดภายหลังจากเวลาจริงเป็นบรรทัด `suggested` ใน DO (MD-152) และรวมขึ้นมาที่ SO เมื่อยืนยัน |
| ORD-042 | ส่วนลด: จำนวนเงินหรือ % ผูกบรรทัดหรือทั้งงาน (MD-155); ส่วนลด > X% ของค่าขนส่ง (ตั้งค่า tenant, default 10%) → บรรทัด `pending_approval` ต้อง manager อนุมัติก่อนยืนยัน SO |
| ORD-043 | "กำหนดราคาเอง": สร้างบรรทัด FREIGHT source `manual` ต้องมีสิทธิ์ `price.sell.edit` + เหตุผล; SO แสดงป้าย "ราคากำหนดเอง" และนับในรายงานงานนอก rate card |
| ORD-044 | ยอดรวม: `subtotalExempt` = Σ บรรทัด `exempt_transport`; `subtotalVatable` = Σ บรรทัด `vat7`; `vatAmount` = round_half_up(subtotalVatable × 7%, 2); `grandTotal` = subtotalExempt + subtotalVatable + vatAmount (+ บรรทัด `none`) ; ถ้า `priceIncludesVat` ฐานบรรทัด vat7 = amount × 100/107 |
| ORD-045 | `vatTreatment` ของแต่ละบรรทัด resolve จาก accessorial + การตั้งค่าลูกค้า (MD-022, MD-150) ณ เวลาสร้างบรรทัด แล้ว snapshot; tenant ไม่จด VAT → `none` ทุกบรรทัด (MD-023) |
| ORD-046 | "เปลี่ยนเรท" (popover ค้นหา rate card ที่มีผลของลูกค้า/มาตรฐาน ตามเส้นทาง/ประเภทรถ): หลัง SO ยืนยันแล้วต้องมีเหตุผลและบันทึก audit; SO ที่มี DO อยู่ในใบแจ้งหนี้แล้วเปลี่ยนไม่ได้ (ต้องใบลด/เพิ่มหนี้ — 05) |
| ORD-047 | `whtEstimate` ตาม MD-024 แสดงเป็นข้อมูลประกอบเท่านั้น (ไม่ใช่ภาษีจริง — ภาษีจริงเกิดที่ใบแจ้งหนี้/รับชำระ 05) |
| ORD-048 | ตัวเลขใน SO เป็น "ราคาคาดการณ์"; ฐานวางบิลจริงคือ DO ที่ส่งแล้ว + ค่าใช้จ่ายที่ยืนยัน (05) |
| ORD-049 | ผู้ไม่มี `price.sell.view` เห็นแท็บราคาเป็น "—" และ footer ไม่แสดงยอด |

*การแก้ไข ยืนยัน ยกเลิก*

| รหัส | กฎ |
|---|---|
| ORD-030 | ยืนยัน SO ต้องผ่าน: ลูกค้า active และไม่ creditHold (MD-027), stops มีพิกัด, น้ำหนัก > 0, ประเภทรถ, ราคามี ≥ 1 บรรทัด FREIGHT ที่ไม่ pending, custom fields `requiredWhenStatus=confirmed` |
| ORD-031 | ล็อกการแก้: เปิดโหมดแก้ → `lockedBy` (หมดอายุเมื่อไม่มี heartbeat 2 นาที) ผู้อื่นเห็นป้าย "กำลังแก้ไขโดย {ชื่อ}" และแก้ไม่ได้ (O4); manager ปลดล็อกได้ |
| ORD-032 | แก้ SO หลังยืนยัน: ฟิลด์ที่แก้ได้ตามสถานะ — `confirmed`: ทุกอย่าง (DO สร้างใหม่ตาม ORD-085); `planned`/`partially_planned`: หมายเหตุ ช่วงเวลา ราคา custom fields; เพิ่ม/ลบ stop ต้องดึง DO ที่ได้รับผลออกจากเที่ยวก่อน; `in_transit` ขึ้นไป: หมายเหตุ ราคา (ORD-046) custom fields เท่านั้น |
| ORD-033 | แก้ช่วงเวลา/stop ของ SO ที่อยู่ในเที่ยว `dispatched` → แจ้งคนขับ (M18) + ระบบตั้งเที่ยวเป็น "แผนเปลี่ยน รอส่งใหม่" (PLN-175) |
| ORD-034 | ยกเลิก SO: เลือกเหตุผล (หมวด `so_cancel`) + หมายเหตุ ≥ 10 ตัวอักษรรวม (MD-222); ก่อนมี DO ในเที่ยว: dispatcher; DO อยู่ในเที่ยว planned/dispatched: manager — ระบบถอด DO ออกจากเที่ยว แจ้งคนขับ/รถร่วม; เมื่อรถออกวิ่งแล้ว (DO picked_up) ยกเลิก SO ไม่ได้ → ใช้ "ส่งไม่สำเร็จ/ตีกลับ" ใน 04 |
| ORD-035 | ยกเลิกหลังรถออกจากลาน (เที่ยว in_progress แต่ยังไม่รับของ) → manager เลือก "คิดค่ายกเลิก" (accessorial `CANCEL_FEE` ถ้ามี) หรือไม่คิด; ค่าจ้างรถร่วมที่รับงานแล้วให้ระบุค่าชดเชย (05) |
| ORD-036 | SO ที่ยกเลิก: DO ทั้งหมด cancelled, `billingStatus` คงไว้ถ้ามีค่ายกเลิก, ส่ง `order.cancelled` |
| ORD-037 | สถานะ SO คำนวณจากสถานะ DO (ORD-050) ยกเว้น draft/confirmed/cancelled ที่ตั้งโดยผู้ใช้ |

**6. สถานะ SO**

| สถานะ | ป้ายไทย | ความหมาย |
|---|---|---|
| `draft` | ร่าง | แก้ได้ทั้งหมด ยังไม่มี DO |
| `confirmed` | รอจัดรถ | ยืนยันแล้ว มี DO, ยังไม่มี DO ใดในเที่ยว |
| `partially_planned` | จัดรถบางส่วน | DO บางใบอยู่ในเที่ยว |
| `planned` | จัดรถแล้ว | DO ทุกใบ (ที่ไม่ยกเลิก) อยู่ในเที่ยว |
| `in_transit` | กำลังขนส่ง | DO อย่างน้อย 1 ใบ picked_up |
| `delivered` | ส่งครบ | DO ทุกใบอยู่ในสถานะสิ้นสุด (delivered/partially_delivered/failed_closed) |
| `completed` | ปิดงาน | ส่งครบ + POD ผ่านทุกใบ + ค่าใช้จ่ายยืนยันแล้ว → พร้อมวางบิล |
| `cancelled` | ยกเลิก | |

| จาก → ไป | เงื่อนไข | ใคร | ผลข้างเคียง |
|---|---|---|---|
| draft → confirmed | ORD-030 | dispatcher | สร้าง DO (ORD-081); `order.created` (ถ้ายังไม่เคยส่ง) + `order.confirmed`; แจ้งลูกค้า "รับงานแล้ว" (ถ้าเปิด) |
| confirmed → draft | ไม่มี DO ในเที่ยว | dispatcher | ลบ DO (soft) |
| confirmed → partially_planned / planned | DO เข้าเที่ยว | ระบบ | `order.updated` |
| planned → partially_planned / confirmed | DO ถูกถอดจากเที่ยว | ระบบ | |
| planned/partially_planned → in_transit | DO แรก picked_up | ระบบ (04) | `order.updated` |
| in_transit → delivered | ทุก DO ถึงสถานะสิ้นสุด | ระบบ | |
| delivered → completed | POD ผ่าน (04) + ไม่มีบรรทัด suggested/pending ค้าง | ระบบ หรือ dispatcher กด "ปิดงาน" | `billingStatus = ready`; `order.completed` |
| completed → delivered | เปิดงานใหม่ (ยังไม่วางบิล) + เหตุผล | manager | |
| draft/confirmed/partially_planned/planned → cancelled | ORD-034 | ตาม ORD-034 | `order.cancelled` |

**7. Event** — `order.created`, `order.confirmed`, `order.updated` (มี `changedFields`; ไม่ส่งถ้าเปลี่ยนเฉพาะ internalNote), `order.cancelled`, `order.completed`, `order.price_changed` (ภายใน + audit) — payload รวม `custom_fields` ที่ `api.webhook=true` (MD-245) และไม่มีราคาเมื่อ webhook ไปยังผู้ไม่มีสิทธิ์ราคา (07)

**8. กรณีผิดปกติ**
- ไม่พบเรท → ORD-043 · พบเรทซ้อน → MD-112
- ราคาน้ำมันอ้างอิงเก่า → MD-126
- ลูกค้าถูกปิดใช้หลังสร้างร่าง → ยืนยันไม่ได้
- สองคนแก้พร้อมกัน → ORD-031 + MD-007
- API ส่ง stop ที่ไม่มี locationId แต่มีที่อยู่+พิกัด → สร้าง Location `pending_review` อัตโนมัติ (MD-014) และใช้ใน SO ร่างได้
- CSV หลาย SO บางแถวผิด → ตาม errorPolicy (02 MD-286)
- วันรับของเป็นวันหยุดของจุดรับ → เตือน (MD-053)

**9. เกณฑ์ตรวจรับ**
- Given ลูกค้ามี rate card อยุธยา → สระบุรี พ่วง 7,800.00, FSC 3%, ลูกค้า freight ยกเว้น/บริการ 7% When สร้าง SO + ค่าลงสินค้า 500.00 + ส่วนลด 200.00 ที่ค่าขนส่ง Then ตารางราคา: ค่าขนส่ง 7,800.00, ค่าน้ำมันเพิ่ม 234.00, ค่าลงสินค้า 500.00, ส่วนลด −200.00, ยกเว้น VAT 7,834.00, ฐาน VAT 500.00, VAT 35.00, รวม 8,369.00
- Given SO ร่างไม่มีน้ำหนัก When กดยืนยัน Then ยืนยันไม่ได้ "ระบุน้ำหนักรวม"
- Given SO อยู่ในเที่ยว dispatched When dispatcher ยกเลิก Then ต้องเป็น manager; เมื่อ manager ยกเลิก DO ถูกถอดจากเที่ยว และคนขับได้รับแจ้ง
- Given `PUT /orders/KRS-DO-7781` ส่งซ้ำ 2 ครั้ง When ครั้งที่ 2 Then ไม่สร้างใหม่ อัปเดต SO เดิม
- Given SO ใช้ rate card v3 When อนุมัติ v4 Then SO นี้ยังแสดง "RC-S-0012 v3" และยอดเดิม
- Given ผู้ใช้ B เปิด SO ที่ A กำลังแก้ Then เห็น "กำลังแก้ไขโดย A" และปุ่มแก้ถูกปิด

**10. เฟส** — P0 ทั้งหมด; `order.price_changed` webhook = P1

---

## 3. ใบส่งของ (DO)

**1. จุดประสงค์** — หน่วยส่งมอบต่อจุดส่ง: ใช้ลากเข้าเที่ยว เก็บ POD จำนวนส่งจริง ค่าใช้จ่ายหน้างาน และเป็นฐานวางบิล (API: `shipments`)

**2. ผู้ใช้/สิทธิ์** — สร้างอัตโนมัติจาก SO; แยก/รวม: dispatcher; ดู: ทุก role ภายใน; รถร่วมเห็น DO ที่อยู่ในงานของตัวเอง (ไม่มีราคาขาย)

**3. หน้าจอ** — รายการ DO (แท็บ: รอจัด · อยู่ในเที่ยว · กำลังส่ง · ส่งแล้ว · ไม่สำเร็จ · POD รอตรวจ) · Drawer DO (หัว: "ใบส่งของ" / DO-… + สถานะ / ลูกค้า · SO · PO; แท็บ: สรุป · สินค้า (แผน vs ส่งจริง) · POD (04, ผลตรวจ AI 08) · เอกสารแนบ · กิจกรรม; footer: "พิมพ์ใบส่งของ" + "จัดรถ"/"ดูเที่ยว") · พิมพ์ A4 ใบส่งของ (Sarabun, QR ลิงก์ติดตาม)

**4. ฟิลด์ — DO**

| ฟิลด์ | ชนิด | บังคับ | หมายเหตุ |
|---|---|---|---|
| `doNo` | auto | ✓ | |
| `orderId` | ref | ✓ | |
| `pickupStopRefs` | OrderStop seq[] | ✓ | จุดรับที่ของของ DO นี้มาจาก |
| `dropStopSeq` | int | ✓ | 1 DO = 1 จุดส่ง |
| `splitIndex` | int | – | 1..n เมื่อแยกตามคัน (ORD-084) แสดง DO-…-1 |
| `items` | {orderItemId, plannedQty, actualQty?, rejectedQty?, rejectReason?} | – | E3 |
| `weightKg`, `volumeCbm` | decimal | ✓ | สัดส่วนจาก items/แยก |
| `windowStart/End` | datetime | ✓ | จาก stop |
| `tripId`, `tripStopIds` | ref | – | |
| `status` | enum ข้อ 6 | ✓ | |
| `podStatus` | enum `none`/`submitted`/`ai_checked`/`accepted`/`rejected` | auto | 04 |
| `charges` | OrderCharge[] | – | บรรทัดที่เกิดจริงต่อ DO (ค่ารอ ฯลฯ) |
| `billingStatus` | `not_ready`/`ready`/`billed` | auto | |
| `trackingToken` | string | auto | ลิงก์ติดตามสาธารณะ (04) |
| `customFields` | JSON | | |

**5. กฎธุรกิจ**

| รหัส | กฎ |
|---|---|
| ORD-080 | 1 DO ต่อ 1 จุดส่ง (drop stop) ต่อ 1 คัน [DECISION]; SO ที่มีจุดส่ง 3 จุด = 3 DO |
| ORD-081 | DO สร้างเมื่อ SO → confirmed; items แบ่งตาม `itemAllocations` ของ drop; น้ำหนัก DO = Σ น้ำหนัก items ที่จัดสรร (ถ้าไม่มี items แบ่งน้ำหนักรวมเท่า ๆ กันต่อ drop และเตือนให้ตรวจ) |
| ORD-082 | ฐานวางบิล `billingBasis=per_do` (02): ราคาของ SO ถูกกระจายลง DO — FREIGHT/FSC ตามสัดส่วนน้ำหนัก (หรือเท่ากันถ้าไม่มีน้ำหนัก), EXTRA_STOP ตามจุด, บรรทัดที่ผูก `dropStopSequence` ลง DO นั้น; ส่วนต่างปัดเศษใส่ DO สุดท้าย (PL10) |
| ORD-083 | DO ไม่ผูกกับรถจนเข้าเที่ยว; ลาก DO ระหว่างเที่ยวได้จนกว่าสถานะ picked_up |
| ORD-084 | **แยก DO** (split): เมื่อ vehicleCount > 1 หรือ DO หนักเกินความจุรถคันเดียว — dispatcher แยกตามจำนวน/น้ำหนัก (เช่น 24 ตัน → 12 + 12) ได้ DO ลูก `splitIndex`; SO ที่ vehicleCount = N และมี drop เดียว ระบบเสนอแยกเป็น N ใบอัตโนมัติตอนยืนยัน (ต้องกดยอมรับ) ; ราคากระจายตาม ORD-082 |
| ORD-085 | แก้ SO สถานะ confirmed (ยังไม่มี DO ในเที่ยว) → สร้าง DO ใหม่ทั้งชุด (เลขเดิมถูกยกเลิก, ข้ามเลขได้) |
| ORD-086 | รวม DO (merge) ได้เฉพาะ DO ของ SO และจุดส่งเดียวกันที่แยกไว้ และยังไม่เข้าเที่ยว |
| ORD-087 | DO failed: ของยังอยู่บนรถ → เลือก "ส่งใหม่" (DO กลับ `pending` เป็น leg ใหม่ รอจัดเที่ยวใหม่, ป้าย "ส่งซ้ำ") หรือ "ตีกลับต้นทาง" (สร้าง stop คืนของ) หรือ "ปิดไม่สำเร็จ" (`failed_closed`) — ตาม reason `autoAction` (MD-220, E7) |
| ORD-088 | ฐานวางบิลรายเที่ยว/ราย SO (`per_trip`/`per_so`) ใช้ DO เป็นตัวตรวจว่าครบ แต่บรรทัดบิลรวมระดับเที่ยว/SO (05) |

**6. สถานะ DO**

| สถานะ | ป้ายไทย | Event |
|---|---|---|
| `pending` | รอจัดรถ | – |
| `assigned` | อยู่ในเที่ยว | `shipment.assigned` (เมื่อเที่ยว dispatched) |
| `picked_up` | รับของแล้ว | `shipment.picked_up` |
| `arrived` | ถึงจุดส่ง | `shipment.arrived` |
| `delivered` | ส่งสำเร็จ | `shipment.delivered` |
| `partially_delivered` | ส่งบางส่วน | `shipment.delivered` (`partial=true`) |
| `failed` | ส่งไม่สำเร็จ (รอตัดสิน) | `shipment.failed` |
| `failed_closed` | ปิดไม่สำเร็จ | – |
| `cancelled` | ยกเลิก | `order.updated` |

| จาก → ไป | เงื่อนไข | ใคร |
|---|---|---|
| pending → assigned | เข้าเที่ยวที่ผ่านกฎ | dispatcher (กระดาน) / รถร่วมรับงาน |
| assigned → pending | ถอดจากเที่ยว (ก่อน picked_up) | dispatcher |
| assigned → picked_up | คนขับยืนยันขึ้นของที่จุดรับ (M12) | คนขับ / dispatcher แทน (เหตุผล) |
| picked_up → arrived → delivered/partially_delivered/failed | แอปคนขับ (04) | คนขับ / รถร่วมผ่านลิงก์ |
| failed → pending / failed_closed | ORD-087 | dispatcher |
| pending/assigned → cancelled | SO ยกเลิกหรือแก้ (ORD-085) | ระบบ |

**7. Event** — `shipment.assigned`, `shipment.picked_up`, `shipment.arrived`, `shipment.delivered`, `shipment.failed`, `pod.uploaded` (04)

**8. กรณีผิดปกติ** — จุดรับหลายจุด/จุดส่งหลายจุด (milk run) → DO อ้างจุดรับหลายจุดได้ · ส่งได้น้อยกว่าแผน → partially_delivered + actualQty (E3) ใช้วางบิลตามที่ตั้งในลูกค้า (05) · แยก DO แล้วรวมน้ำหนักไม่เท่าเดิม → บันทึกไม่ได้

**9. เกณฑ์ตรวจรับ**
- Given SO 1 จุดรับ 3 จุดส่ง When ยืนยัน Then มี DO 3 ใบ และน้ำหนักรวม DO = น้ำหนัก SO
- Given SO 24 ตัน พ่วง vehicleCount 2 When ยืนยัน Then ระบบเสนอแยก DO 12/12 ตัน; ยอมรับแล้วได้ DO-…-1, DO-…-2 และค่าขนส่งแบ่งครึ่ง
- Given DO failed เหตุผล "ร้านปิด" (autoAction reschedule) When dispatcher เปิด Then DO กลับรอจัด ป้าย "ส่งซ้ำ"

**10. เฟส** — P0 (merge ORD-086 = P1)

---

## 4. เที่ยวรถ / ใบคุมรถ (Trip)

**1. จุดประสงค์** — การวิ่ง 1 ครั้งของรถ 1 คัน + คนขับ (+หาง) รวมหลาย DO หลายจุด เป็นหน่วยของการจ่ายงาน ติดตาม ต้นทุน เงินเบิก และค่าเที่ยวรถร่วม (PL1)

**2. ผู้ใช้/สิทธิ์** — สร้าง/แก้/ส่งแผน: dispatcher · override กฎ: manager · ปิดเที่ยว: dispatcher/accounting · คนขับ: เห็นเฉพาะเที่ยวตัวเองในแอป · รถร่วม: เห็นเที่ยวที่รับงาน

**3. หน้าจอ** — รายการเที่ยว (แท็บสถานะ, ตัวกรองวัน/รถ/คนขับ/รถร่วม) · Drawer เที่ยว: หัว "เที่ยวรถ / ใบคุมรถ" / TRP-… + สถานะ / ทะเบียน · คนขับ · (รถร่วม); แท็บ: สรุป (รถ คนขับ หาง เวลาแผน/จริง ระยะทาง น้ำหนักรวมเทียบความจุ) · จุดจอด (ลำดับ ลากเรียงได้ก่อน dispatched, ต่อ stop แสดง DO, เวลาแผน/ETA/จริง) · ค่าใช้จ่ายและเงินเบิก (เงินเบิกล่วงหน้า, ค่าใช้จ่ายหน้างาน, ค่าเที่ยว/ค่าจ้างรถร่วม, กำไรขั้นต้นของเที่ยว — ตามสิทธิ์ราคา) · เอกสารแนบ · กิจกรรม; footer: "พิมพ์ใบคุมรถ" + ปุ่มหลักตามสถานะ ("ส่งแผน" / "ปิดเที่ยว") · พิมพ์ A4 ใบคุมรถ (รายการจุด DO ช่องเซ็น เงินเบิก)

**4. ฟิลด์ — Trip**

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| `tripNo` | auto | ✓ | | |
| `serviceDate` | date | ✓ | | |
| `assignmentType` | enum `own`/`subcontract` | ✓ | | |
| `vehicleId` | ref | ✓ ตั้งแต่ planned | PLN-080–087 | snapshot ทะเบียน ประเภท payload |
| `trailerId` | ref | เงื่อนไข | บังคับถ้า `requiresTrailer` | |
| `driverId` | ref | ✓ ตั้งแต่ planned (own); รถร่วมกรอกตอนรับงาน | PLN-083/084 | snapshot ชื่อ ใบขับขี่ |
| `coDriverId` | ref | – | | งานทางไกล (E8) [P1] |
| `subcontractorId` | ref | ✓ ถ้า subcontract | | |
| `stops` | TripStop[] | ✓ ≥ 2 | ลำดับ: จุดรับของ DO ต้องมาก่อนจุดส่งของ DO เดียวกัน | |
| `startLocationId`, `endLocationId` | ref | – | default `homeDepotId` | |
| `plannedStart`, `plannedEnd` | datetime | ✓ | คำนวณจาก stop + transit; แก้ได้ | ใช้วางบนกระดาน |
| `actualStart`, `actualEnd` | datetime | auto | | |
| `plannedDistanceKm`, `actualDistanceKm` | decimal | – | | actual จาก GPS/เลขไมล์ (06) |
| `loadWeightKg` (peak) | decimal | auto | ≤ payload (PLN-087) | น้ำหนักสูงสุดระหว่างทาง (รับ-ส่งหลายจุด) |
| `cashAdvanceIds` | ref[] | – | | เงินเบิก (05) |
| `costLines` | {type, amount, source} | – | | ค่าเที่ยวคนขับ, ค่าจ้างรถร่วม, น้ำมัน, ทางด่วน (B1) |
| `planSentAt`, `planVersion` | | auto | | PLN-170 |
| `overrides` | {ruleCode, reason, approvedBy, at}[] | – | | PLN-090 |
| `status` | enum ข้อ 6 | ✓ | | |
| `cancelReasonCode/Note` | | เงื่อนไข | | |
| `customFields` | JSON | | | |

**TripStop**: `sequence`, `type` (`pickup`/`drop`/`depot`/`fuel`/`rest`), `locationId` (snapshot), `doIds[]`, `plannedArrival`, `plannedDeparture`, `eta` (04), `actualArrival`, `actualDeparture`, `status` (`pending`/`arrived`/`done`/`skipped`/`failed`), `geofenceOverrideReason`

**5. กฎธุรกิจ**

| รหัส | กฎ |
|---|---|
| PLN-001 | สร้างเที่ยว: (ก) ลาก DO ลงแถวรถบนกระดาน → ถ้าไม่มีเที่ยว draft/planned ของรถนั้นที่ช่วงเวลาซ้อน สร้างเที่ยวใหม่, ถ้ามีให้ถาม "เพิ่มเข้า TRP-… หรือสร้างเที่ยวใหม่" (b) ปุ่ม "จัดรถ" ใน SO/DO → dialog เลือกรถ/คนขับ (c) API `POST /trips` [P1] |
| PLN-002 | เพิ่ม DO เข้าเที่ยว = เพิ่ม stop รับ (ถ้าจุดรับยังไม่มีในเที่ยว) และ stop ส่ง; จุดเดียวกันติดกันรวมเป็น stop เดียว; ลำดับเริ่มต้น = เรียงตาม windowStart แล้วผู้ใช้ลากปรับได้ |
| PLN-003 | ตรวจลำดับ: ห้ามส่งก่อนรับของ DO เดียวกัน (บล็อก); ช่วงเวลาไม่ทัน → แดงแต่ไม่บล็อก (PL8) |
| PLN-004 | คำนวณ `plannedStart/End` จาก windowStart แรก − เวลาเดินทางจากลาน, serviceMinutes ต่อ stop, transitHours/ระยะทาง (ความเร็วเฉลี่ยตั้งค่า tenant default 50 กม./ชม. [PROPOSED]) |
| PLN-005 | น้ำหนักระหว่างทาง: คำนวณสะสมตามลำดับ stop (รับ +, ส่ง −); `loadWeightKg` = ค่าสูงสุด ใช้ตรวจความจุ (PLN-087) |
| PLN-006 | เปลี่ยนรถ/คนขับในเที่ยว: ก่อน dispatched แก้ได้อิสระ (ผ่านกฎ); หลัง dispatched ต้องส่งแผนใหม่ (PLN-175); หลัง in_progress = "โอนเที่ยว" (PLN-008) |
| PLN-007 | เงินเบิกล่วงหน้า: ปุ่ม "เบิกเงิน" ใน drawer สร้างคำขอเงินเบิกผูก `tripId` + คนขับ (05); เที่ยวปิด (closed) ไม่ได้ถ้าเงินเบิกยังไม่เคลียร์ (ยกเว้น manager override + เหตุผล) |
| PLN-008 | รถเสียกลางทาง/โอนงาน: dispatcher เลือก stop ที่ยังไม่ทำ → "ย้ายไปเที่ยวใหม่" สร้างเที่ยวใหม่ (รถใหม่) รับช่วงที่จุดปัจจุบัน; DO ที่ picked_up แล้วย้ายได้ (ของถ่ายลำ) โดยบันทึก stop "ถ่ายของ" ทั้งสองเที่ยว; เที่ยวเดิมไป completed เมื่อ stop ที่เหลือทำเสร็จ |
| PLN-009 | ต้นทุนเที่ยว (B1): ระบบสร้าง cost line อัตโนมัติ — own: ค่าเที่ยวคนขับตามตารางค่าเที่ยว (05) + ประมาณน้ำมัน (ระยะ × อัตรากินของรถ × ราคา) ; subcontract: ค่าจ้างที่ตกลง (PLN-145); บรรทัดที่ผู้ใช้เพิ่มเองไม่ถูกเขียนทับเมื่อคำนวณใหม่ |
| PLN-010 | รายได้ของเที่ยว = Σ รายได้ DO ในเที่ยว (ORD-082) เพื่อคิดกำไรต่อเที่ยว (09) |
| PLN-011 | ปิดเที่ยว (completed → closed): ทุก stop done/skipped/failed (มีเหตุผล), POD ส่งครบ (ไม่จำเป็นต้องตรวจผ่าน), เลขไมล์จบ, เงินเบิกเคลียร์, ค่าใช้จ่ายหน้างานยืนยัน; หลัง closed แก้ cost ได้เฉพาะ accounting + เหตุผล |
| PLN-012 | ยกเลิกเที่ยว: draft/planned โดย dispatcher; dispatched โดย dispatcher + แจ้งคนขับ/รถร่วม (รถร่วมที่รับงานแล้วต้องระบุค่าชดเชย 0 หรือจำนวน); in_progress ยกเลิกไม่ได้ → ใช้ PLN-008 หรือปิด stop เป็น failed; DO ในเที่ยวที่ยกเลิกกลับ `pending` |

**6. สถานะเที่ยว**

| สถานะ | ป้ายไทย | ความหมาย |
|---|---|---|
| `draft` | ร่าง | มี DO แต่ยังไม่ครบรถ/คนขับ หรือยังไม่ผ่านกฎ |
| `planned` | วางแผนแล้ว | รถ+คนขับ(own)/รถร่วมยืนยัน ครบ ผ่านกฎหรือ override แล้ว ยังไม่ส่งแผน |
| `dispatched` | ส่งงานแล้ว | ส่งแผนให้คนขับ/รถร่วมรับงานแล้ว |
| `accepted` | คนขับรับงาน | คนขับกดรับใน M11 หรือ tenant ตั้งรับอัตโนมัติ (การเปลี่ยนสถานะช่วงวิ่งงาน dispatched → accepted/rejected → in_progress อยู่ที่ 04 §1) |
| `rejected` | คนขับปฏิเสธ | กลับมาที่กระดานวางแผนเพื่อจัดใหม่ (04 §1) |
| `in_progress` | กำลังวิ่ง | คนขับกด "เริ่มเที่ยว" หรือถึง stop แรก |
| `completed` | วิ่งจบ | ทุก stop สิ้นสุด |
| `closed` | ปิดเที่ยว | ค่าใช้จ่าย/เงินเบิก/เลขไมล์ครบ (PLN-011) |
| `cancelled` | ยกเลิก | |

| จาก → ไป | เงื่อนไข | ใคร | ผลข้างเคียง |
|---|---|---|---|
| draft → planned | รถ + คนขับ (own) ผ่านกฎ §6 หรือ override; รถร่วม: ข้อเสนอ accepted (PLN-152) | dispatcher / ระบบ | DO → assigned (ภายใน) |
| planned → draft | ถอดรถ/คนขับ | dispatcher | |
| planned → dispatched | ส่งแผน (PLN-170) และ re-check กฎผ่าน | dispatcher | `shipment.assigned` ต่อ DO, แจ้งคนขับ (04 M18) |
| dispatched → planned | คนขับปฏิเสธ (M11) หรือ dispatcher ดึงกลับ | ระบบ/dispatcher | แจ้ง dispatcher |
| dispatched → in_progress | คนขับเริ่มเที่ยว (ต้องผ่านตรวจรถก่อนออก — PLN-082) | คนขับ | `trip.started` |
| in_progress → completed | ทุก stop สิ้นสุด | ระบบ | `trip.completed` |
| completed → closed | PLN-011 | dispatcher/accounting | ส่งเข้า settlement/ค่าเที่ยว (05) |
| closed → completed | เปิดใหม่ + เหตุผล (ยังไม่อยู่ใน settlement ที่อนุมัติ) | manager | |
| draft/planned/dispatched → cancelled | PLN-012 | ตาม PLN-012 | `trip.cancelled`; DO → pending |

**7. Event** — `trip.created`, `trip.planned`, `trip.dispatched`, `trip.started`, `trip.completed`, `trip.closed`, `trip.cancelled`, `trip.plan_changed` (หลัง dispatched), `trip.rule_overridden` (audit)

**8. กรณีผิดปกติ** — คนขับไม่กดเริ่มเที่ยวแต่ GPS ออกจากลาน → แจ้ง exception "รถออกโดยไม่เริ่มเที่ยว" (04) · DO ถูกยกเลิกขณะอยู่ในเที่ยว dispatched → ถอด stop + แจ้งคนขับ · เที่ยวข้ามเที่ยงคืน → serviceDate = วันเริ่ม; แสดงบนกระดานทั้งสองวัน · เปลี่ยนหางระหว่างเที่ยว → บันทึกประวัติพ่วง/ปลด (06)

**9. เกณฑ์ตรวจรับ**
- Given เที่ยวรับ A (DO1, DO2) ส่ง B (DO1), C (DO2) When ลาก C ขึ้นก่อน A Then บล็อก "ต้องรับของก่อนส่ง"
- Given เงินเบิก 3,000.00 ยังไม่เคลียร์ When กดปิดเที่ยว Then ปิดไม่ได้ ข้อความชี้ไปเงินเบิก
- Given เที่ยว in_progress รถเสียหลังส่ง B When ย้าย stop C ไปรถใหม่ Then เกิดเที่ยวใหม่มี stop "ถ่ายของ" + C และเที่ยวเดิมจบที่ stop ถ่ายของ

**10. เฟส** — P0 (coDriver, POST /trips = P1)

---

## 5. กระดานวางแผน (Planning board)

**1. จุดประสงค์** — จอเดียวสำหรับจัด DO ลงรถ (รถบริษัท + รถร่วม) ตามเวลา เห็นความจุ ความขัดแย้งเวลา และรถที่จ่ายงานไม่ได้ (PL2, PL3)

**2. ผู้ใช้/สิทธิ์** — dispatcher, manager (`planning.edit`); viewer อ่านอย่างเดียว; ราคาบนการ์ดตาม MD-012

**3. หน้าจอ**

| ส่วน | ข้อกำหนด |
|---|---|
| แถบบน | ตัวเลือกวัน (date picker, ←/→, "วันนี้"), สลับมุมมอง **วันนี้ (รายชั่วโมง)** / **7 วัน**, ตัวกรองรถ (ประเภท, รถบริษัท/รถร่วม, สาขา/ลาน), ค้นหา (ทะเบียน/SO/ลูกค้า), saved views, ปุ่ม "ส่งแผน" (นับจำนวนเที่ยวที่ยังไม่ส่ง), **legend** สีสถานะ |
| คอลัมน์ซ้าย "SO รอจัด" | การ์ด DO ที่ `pending` (จัดกลุ่มตาม SO) ตัวกรอง: วัน, ประเภทรถ, ลูกค้า, จุดรับ (จังหวัด), ป้ายพิเศษ; เรียง: กำหนดส่ง → น้ำหนัก; ป้ายเหตุผลค้าง (PL7: ไม่มีรถว่าง / เกินความจุ / รถร่วมปฏิเสธ / ที่อยู่ผิด / หลุดช่วงเวลา) |
| คอลัมน์รถ (กว้างคงที่ 220px) | บรรทัด 1: ทะเบียน (500) + ประเภทรถ · บรรทัด 2: คนขับ · ใบขับขี่ (ไม่มี: "ยังไม่กำหนดคนขับ" + ลิงก์ "กำหนด" → popover) · บรรทัด 3: แถบความจุ "5,400 / 6,000 กก." (เกิน = แดง) — รถร่วมมีป้าย "รถร่วม · {ชื่อ}"; รถติดกฎ: ป้ายเหตุผลเดียว (+N ถ้ามีหลายข้อ) + ปุ่ม (i) "ดูสาเหตุ" |
| พื้นที่ timeline (วันนี้) | แกนเวลา 06:00–20:00 ทุก 1 ชม. (ปรับช่วงได้ในตั้งค่า tenant [PROPOSED]); เส้นแนวตั้ง "ตอนนี้" อัปเดตทุก 1 นาที; งานนอกช่วงแสดงที่ขอบพร้อมลูกศร "ต่อ 21:30"; แถวรถติดกฎเป็นลาย hatch จางบนพื้นขาว ตัวอักษรยังชัด |
| มุมมอง 7 วัน | คอลัมน์ = วัน, การ์ดเรียงในช่องวันของแถวรถ แสดงข้อความเต็มไม่ตัดคำ (ขยายความสูงแถว), แสดงเที่ยวข้ามวันเป็นแถบยาว |
| การ์ดงาน (เที่ยว/DO) | พื้นขาว ขอบ 1px `#CDD1C8` แถบซ้าย 3px ตามสถานะ; 3 บรรทัด: เลข SO (500 accent) · ลูกค้า / ช่วงเวลา · เส้นทาง / น้ำหนักต่อความจุ; ความกว้างตามระยะเวลาจริง ข้ามเส้นช่องได้ไม่ถูกตัด; ข้อความยาว ellipsis + tooltip ข้อมูลเต็ม; ป้าย "ต้องย้ายรถ", "แผนเปลี่ยน", "ยังไม่ส่ง", ไอคอนพิเศษ (อันตราย/ห้องเย็น/เปราะบาง) |
| Lane | งานบนรถเดียวกันที่เวลาซ้อน → แยก sub-lane ซ้อนลงในแถวเดียวกัน (แถวสูงขึ้น) และขอบเวลาที่ซ้อนเป็นสีแดง (เตือน ไม่บล็อก) |
| คลิกการ์ด | เปิด drawer เที่ยว/DO; คลิกการ์ดใน "SO รอจัด" → ไฮไลต์รถที่รับได้ (PL3) และจางรถที่รับไม่ได้ |

**สีสถานะ (legend)**: ร่าง (เทา `#3B424C`) · วางแผนแล้ว-ยังไม่ส่ง (ส้ม `#8F5500`) · ส่งงานแล้ว (น้ำเงิน `#2257C4`) · กำลังวิ่ง (น้ำเงินเข้ม/แถบเต็ม) · วิ่งจบ (เขียว `#17733F`) · มีปัญหา/ล่าช้า (แดง `#B3322A`) — ใช้ token จาก design system

**4. ฟิลด์ (สถานะ UI ที่ต้องเก็บ)** — `PlanningView {userId, name, filters, mode, timeRange, isDefault}`; ไม่มี entity ธุรกิจใหม่ (ใช้ Trip/DO)

**5. กฎธุรกิจ**

| รหัส | กฎ |
|---|---|
| PLN-040 | ลาก DO จาก "SO รอจัด" ลงแถวรถ ณ ตำแหน่งเวลา → PLN-001; ลากการ์ดเที่ยวระหว่างแถว = เปลี่ยนรถของเที่ยว; ลากแนวนอน = เลื่อนเวลา plannedStart (snap 15 นาที) |
| PLN-041 | ระหว่างลาก ตรวจกฎฝั่ง client จาก cache (รถ เอกสาร คนขับ ความจุ ข้อจำกัดสถานที่) ตอบภายใน 100 ms: วางได้ = ขอบเขียว `#17733F`; วางไม่ได้ = ขอบแดง + cursor not-allowed + tooltip เหตุผลข้อแรก; เตือน (เวลาซ้อน/ไปไม่ทัน) = ขอบส้ม วางได้ |
| PLN-042 | เมื่อปล่อย server ตรวจซ้ำทุกกฎ (แหล่งความจริง); ไม่ผ่าน → ย้อนการ์ดกลับ + toast เหตุผล |
| PLN-043 | แถบความจุต่อรถ = `loadWeightKg` สูงสุดของเที่ยวในวัน / payload (MD-091); มี volume → แสดง tooltip ปริมาตรด้วย |
| PLN-044 | Popover เลือกคนขับ (จากลิงก์ "กำหนด" หรือในการ์ด): รายการคนขับ active ของบริษัท (หรือของรถร่วมนั้น) เรียง: คนขับประจำรถ → ว่างทั้งช่วง → อื่น ๆ; คนที่ไม่ผ่านแสดงสีเทาพร้อมเหตุผล: ใบขับขี่ไม่ถึงชั้น (MD-090), ใบขับขี่หมดอายุ, ลา, มีเที่ยวซ้อนเวลา, ขับต่อเนื่องเกินกำหนดตามกฎชั่วโมงขับ (06) ; ช่องค้นหา |
| PLN-045 | Real-time: การเปลี่ยนแปลงจากผู้ใช้อื่น/แอปคนขับ/รถร่วม push ผ่าน websocket ภายใน 2 วินาที; การ์ดที่คนอื่นกำลังลากแสดงป้ายชื่อ; บันทึกใช้ optimistic lock (MD-007) — ชนกัน → toast "{ชื่อ} เพิ่งแก้เที่ยวนี้" และโหลดใหม่ |
| PLN-046 | Undo การลากล่าสุด (Ctrl/⌘+Z) ภายในเซสชัน สำหรับเที่ยวที่ยังไม่ dispatched |
| PLN-047 | Bulk: เลือกหลาย DO (Shift/⌘) ลากพร้อมกันลงรถเดียว; เลือกหลายเที่ยว → "ส่งแผน" / "ยกเลิกการจัด" (PL9) |
| PLN-048 | ปุ่มแยก "จัดรถ" (→ planned) กับ "จัดรถและส่ง" (→ dispatched ทันที) (PL9) |
| PLN-049 | แถวรถเรียง: รถบริษัท (ตามลาน/ประเภท/ทะเบียน) → รถร่วมประจำ → รถร่วมอื่นที่มีงานในวัน; รถร่วมที่ไม่มีงานแสดงในกลุ่มพับ "รถร่วมทั้งหมด" |
| PLN-050 | รถสถานะ inactive ไม่แสดง; under_repair/parked แสดงเป็นแถว hatch (PLN-080) |
| PLN-051 | Performance: ≤ 200 คัน × 7 วัน × 1,500 การ์ด render ≤ 2 วินาที (virtualized rows) |
| PLN-052 | การ์ด "SO รอจัด" ที่ตรงกับวันที่เลือกแต่ไม่มีรถประเภทนั้นว่างเลย แสดงป้าย "ไม่มีรถว่าง" และปุ่ม "ส่งต่อรถร่วม" |
| PLN-053 | เที่ยวที่ส่งแผนแล้วแต่ถูกแก้ (รถ/คนขับ/stop/เวลา) แสดงป้าย "แผนเปลี่ยน" จนกว่าจะส่งใหม่ (PLN-175) |

**6. สถานะ** — ใช้สถานะเที่ยว (§4) และ DO (§3)

**7. Event** — ไม่มี event ใหม่ (ใช้ `trip.*`, `shipment.assigned`); บันทึก audit การลากที่เปลี่ยนรถ/คนขับ

**8. กรณีผิดปกติ** — ขาดการเชื่อมต่อ websocket → แถบ "ข้อมูลอาจไม่ล่าสุด · โหลดใหม่" และลากได้ (server ตรวจ) · จอเล็ก (< 1,280px) → ซ่อนคอลัมน์ "SO รอจัด" เป็นปุ่มเปิด panel · tablet: ลากด้วยการกดค้าง 300 ms · ไม่มีรถเลย → empty state "เพิ่มรถ" + "นำเข้า Excel"

**9. เกณฑ์ตรวจรับ**
- Given รถ 6 ล้อ payload 6,000 มีงาน 5,400 กก. When ลาก DO 1,400 กก. ทับช่วงเวลาที่ของยังอยู่บนรถ Then ขอบแดง tooltip "น้ำหนักเกิน 800 กก. (6,800 / 6,000)" วางไม่ได้
- Given DO สองใบบนรถเดียวเวลา 09:00–12:00 และ 11:00–14:00 When วาง Then แสดงเป็น 2 lane ขอบเวลาซ้อนแดง และบันทึกได้
- Given ตอนนี้ 10:20 When เปิดมุมมองวันนี้ Then เส้นปัจจุบันอยู่ที่ 10:20
- Given คนขับใบ ท.2 หมดอายุ 1 พ.ย. When เปิด popover สำหรับรถพ่วงวันที่ 9 พ.ย. Then คนนี้เป็นสีเทา "ใบขับขี่หมดอายุ 1 พ.ย. 2569"
- Given ผู้ใช้ A และ B เปิดกระดานเดียวกัน When A ลาก DO เข้ารถ Then B เห็นการ์ดย้ายภายใน 2 วินาที

**10. เฟส** — P0 (saved views, undo = P1)

---

## 6. กฎห้ามจ่ายงาน (Dispatch block rules)

**1. จุดประสงค์** — ป้องกันการจ่ายงานให้รถ/คนขับที่ผิดกฎหมายหรือไม่ปลอดภัย ทั้งรถบริษัทและรถร่วม และบังคับให้การยกเว้นมีผู้รับผิดชอบ [DECISION รอบ 6 ข้อ 4, รอบ 9]

**2. ผู้ใช้/สิทธิ์** — ระบบตรวจทุกครั้ง · override: manager (`dispatch.override`) · ขอ override: dispatcher

**3. หน้าจอ**
- แถวรถติดกฎ: ลาย hatch, ป้ายเหตุผลเดียว (+N), ปุ่ม (i)
- Popover "ดูสาเหตุ": รายการกฎที่ติด แต่ละข้อ = ไอคอน + ข้อความ + วันที่/ค่า + ลิงก์ไปแก้ (เอกสารรถ, ใบสั่งซ่อม, ผลตรวจรถ, โปรไฟล์คนขับ) + ป้าย "override ได้ / ไม่ได้"; ท้าย popover: "ขออนุมัติยกเว้น" (dispatcher) หรือ "อนุมัติยกเว้น" (manager) พร้อมช่องเหตุผลบังคับ
- การ์ดงานบนรถที่ติดกฎหลังวางแผน: ป้าย "ต้องย้ายรถ" + ปุ่ม "ย้ายไปรถอื่น" (เปิดรายการรถที่ผ่านกฎ เรียงตามความเหมาะสม)
- ไม่มีปุ่ม "ขอยกเว้น" บนการ์ด (รอบ 9)

**4. ฟิลด์ — ตารางกฎ**

| รหัสกฎ | เงื่อนไข (ณ ช่วงเวลาของเที่ยว) | แหล่งข้อมูล | ระดับ | override ได้ (ค่าเริ่มต้น) |
|---|---|---|---|---|
| `VEHICLE_UNDER_REPAIR` | รถสถานะ `in_repair` หรือมี WO เปิดที่ตั้ง "จอดซ่อม" ทับช่วง | 06 | บล็อก | ไม่ได้ (ต้องปิด WO/เปลี่ยนสถานะรถ) |
| `VEHICLE_PARKED` | รถสถานะ parked (จอด/ไม่ใช้งานชั่วคราว) | 06 | บล็อก | ได้ |
| `DOC_INSURANCE_EXPIRED` | ประกันภัยหมดก่อน plannedEnd | 06 เอกสารรถ | บล็อก | ได้ [OPEN-ORD-1] |
| `DOC_CMI_EXPIRED` | พ.ร.บ. หมด | 06 | บล็อก | ไม่ได้ [PROPOSED → OPEN-ORD-1] |
| `DOC_TAX_EXPIRED` | ภาษีรถประจำปีหมด | 06 | บล็อก | ไม่ได้ [PROPOSED → OPEN-ORD-1] |
| `DOC_INSPECTION_EXPIRED` | ตรอ./ตรวจสภาพหมด | 06 | บล็อก | ได้ [OPEN-ORD-1] |
| `PRETRIP_CRITICAL_FAILED` | ผลตรวจรถก่อนออกวันนั้นมีข้อวิกฤตไม่ผ่านที่ยังไม่แก้ | 04 M7 / 06 | บล็อก | ไม่ได้ (ต้องแก้หรือช่างยืนยันผ่าน) |
| `DRIVER_LICENCE_EXPIRED` | ใบขับขี่หมดก่อน plannedEnd | คนขับ | บล็อก | ไม่ได้ |
| `DRIVER_LICENCE_CLASS` | ชั้นใบขับขี่ < `minLicenceClass` (MD-090) หรือมีสินค้าอันตรายแต่ไม่ใช่ ท.4 | คนขับ + ประเภทรถ + SO | บล็อก | ไม่ได้ |
| `DRIVER_UNAVAILABLE` | ลา/inactive/มีเที่ยวซ้อนเวลา | คนขับ | บล็อก (ลา) / เตือน (ซ้อนเวลา) | ได้ |
| `OVERWEIGHT` | `loadWeightKg` > payload | PLN-005 | บล็อก | ได้ด้วยการอนุมัติ manager เท่านั้น ภายในเพดาน (PLN-091) |
| `LOCATION_VEHICLE_LIMIT` | sizeRank > `maxVehicleTypeRank` หรือเกิน maxHeight/maxGrossWeight หรือทับ restrictedWindows | สถานที่ (MD-054) | บล็อก | ได้ |
| `TEMP_MISMATCH` | SO ห้องเย็นแต่รถไม่ refrigerated/ช่วงไม่ครอบคลุม (MD-072) | | บล็อก | ไม่ได้ |
| `HAZMAT_NOT_ALLOWED` | สินค้าอันตรายแต่ประเภทรถ `hazmatAllowed=false` | | บล็อก | ไม่ได้ |
| `TRAILER_MISSING` | หัวลากไม่มีหาง / หางติดกฎเอกสารของตัวเอง | 06 | บล็อก | ไม่ได้ |
| `SUBCON_INACTIVE` | รถร่วม inactive หรือถูกระงับ | MD-200 | บล็อก | ไม่ได้ |
| `VEHICLE_RETIRED` | รถสถานะ retired (ปลดระวาง) | 06 | บล็อก | ไม่ได้ |
| `DOC_OTHER_EXPIRED` | เอกสารประเภทอื่นที่ tenant ตั้ง "ห้ามจ่ายงาน" หมดอายุ | 06 FLT-C | บล็อก | ตามที่ tenant ตั้ง |
| `PM_OVERDUE` | เลยกำหนด PM เกิน N กม./วัน (ปิดเป็นค่าเริ่มต้น) | 06 FLT-D | เตือน (หรือบล็อกถ้า tenant ตั้ง) | ได้ |
| `TYRE_BELOW_MIN` | ดอกยางต่ำกว่าเกณฑ์ (ปิดเป็นค่าเริ่มต้น) | 06 FLT-G | เตือน (หรือบล็อกถ้า tenant ตั้ง) | ได้ |
| `DOC_EXPIRING_SOON` | เอกสารใดหมดภายใน 7 วันหลังเที่ยว | 06 | เตือน | – |
| `TIME_CONFLICT` | เที่ยวซ้อนเวลาบนรถเดียว / ไปไม่ทันช่วงเวลา | PLN-003 | เตือน | – |

> รายการรหัสนี้เป็นชุดหลัก (canonical) ที่ 06 §18 `getDispatchBlocks` ต้องคืนค่าให้ตรงกัน

**ฟิลด์ — DispatchOverride**: `tripId`, `ruleCode`, `ruleSnapshot` (ค่า ณ ตอนนั้น เช่น วันหมดอายุ, น้ำหนัก), `reasonCode` (หมวด `dispatch_override`), `note` (≥ 10 ตัวอักษร), `requestedBy`, `approvedBy`, `approvedAt`, `validUntil` (= plannedEnd ของเที่ยวนั้นเท่านั้น), `status` (`requested`/`approved`/`rejected`/`expired`)

**5. กฎธุรกิจ**

| รหัส | กฎ |
|---|---|
| PLN-080 | กฎรถ (`VEHICLE_*`, `DOC_*`, `PRETRIP_*`, `TRAILER_*`) ประเมินต่อรถ × ช่วงเวลาเที่ยว; ใช้ทั้งรถบริษัทและรถร่วม [DECISION] |
| PLN-081 | เอกสารที่ "ไม่ทราบวันหมดอายุ" (รถร่วมใหม่) → ถือเป็นเตือน `DOC_UNKNOWN` ต้อง dispatcher ยืนยันพร้อมเหตุผลก่อน dispatched (MD-201) |
| PLN-082 | `PRETRIP_CRITICAL_FAILED` ตรวจซ้ำตอนคนขับกดเริ่มเที่ยวในแอป — ไม่ผ่าน = เริ่มไม่ได้ (ไม่ขึ้นกับ override บนกระดาน) |
| PLN-083 | กฎคนขับประเมินกับคนขับของเที่ยว (รวม coDriver) |
| PLN-084 | ลำดับชั้นใบขับขี่ตาม MD-090; สินค้า hazardous บังคับ T4 |
| PLN-085 | กฎสถานที่ประเมินทุก stop ในเที่ยว ใช้ข้อจำกัดที่เข้มที่สุด |
| PLN-086 | กฎอุณหภูมิ/อันตราย ประเมินจาก SO ทุกใบในเที่ยว |
| PLN-087 | น้ำหนักใช้ค่าสูงสุดระหว่างทาง (PLN-005) เทียบ payload ของรถ (หรือหาง) |
| PLN-088 | การประเมินเกิดเมื่อ: ลาก/วาง, เปลี่ยนรถ/คนขับ/หาง, ส่งแผน, คนขับเริ่มเที่ยว, และ **job เบื้องหลัง** เมื่อข้อมูลต้นทางเปลี่ยน (เอกสารหมดอายุเที่ยงคืน, เปิด WO, ผลตรวจรถไม่ผ่าน, ใบขับขี่แก้ไข, ประเภทรถแก้ — MD-092) |
| PLN-089 | ตัวตั้งค่า tenant: เปิด/ปิด override ต่อกฎที่ระบุ "ได้" ในตาราง; กฎที่ระบุ "ไม่ได้" เปลี่ยนเป็นได้ไม่ได้ [PROPOSED] |
| PLN-090 | Override: dispatcher กด "ขออนุมัติยกเว้น" (เหตุผลบังคับ) → แจ้ง manager (ในระบบ + LINE) → manager อนุมัติ/ปฏิเสธพร้อมเหตุผล; manager ทำเองได้ในขั้นเดียว; override ใช้กับเที่ยวนั้นเท่านั้น และบันทึก audit + `trip.rule_overridden`; ข้อมูลกฎเปลี่ยนหลัง override (เช่น น้ำหนักเพิ่ม) → override เดิมหมดผล ต้องขอใหม่ |
| PLN-091 | `OVERWEIGHT` override ได้ไม่เกิน X% ของ payload (ตั้งค่า tenant, default 0% = ห้าม) [PROPOSED → OPEN-ORD-2]; เกินเพดาน = บล็อกเด็ดขาด |
| PLN-092 | งานบนรถที่ติดกฎใหม่หลังวางแผน (PLN-088): การ์ดเที่ยวแสดง "ต้องย้ายรถ" + ปุ่ม "ย้ายไปรถอื่น"; เที่ยวสถานะ dispatched → แจ้ง dispatcher + สร้าง exception "รถติดกฎ" (04); ไม่ถอดงานอัตโนมัติ |
| PLN-093 | "ย้ายไปรถอื่น": แสดงรถที่ผ่านกฎทั้งหมดในช่วงเวลา เรียงตาม: ประเภทเดียวกัน → ความจุเหลือพอดี → อยู่ใกล้จุดรับ; เลือกแล้วย้ายทั้งเที่ยว (คนขับตามรถถ้าเป็นคนขับประจำ มิฉะนั้นคงคนขับเดิมและตรวจกฎใหม่) |
| PLN-094 | ผลการประเมินเก็บเป็น `DispatchCheck {tripId, at, results[]}` ล่าสุดเพื่อแสดงเร็วและใช้รายงาน "จำนวน override ต่อเดือน" (09) |

**6. สถานะ (DispatchOverride)** — requested → approved / rejected; approved → expired (เมื่อเที่ยวจบหรือข้อมูลกฎเปลี่ยน)

**7. Event** — `trip.rule_blocked` (ภายใน), `trip.rule_overridden`, `dispatch.override_requested`, `vehicle.document_expiring` (06, webhook ที่มีอยู่)

**8. กรณีผิดปกติ** — ข้อมูลเอกสารรถไม่ได้กรอกเลย (tenant ใหม่) → tenant เลือกได้ว่า "ไม่มีข้อมูล = เตือน" (default ช่วงทดลอง 30 วันแรก) หรือ "= บล็อก" [PROPOSED] · เอกสารหมดระหว่างเที่ยวที่กำลังวิ่ง → ไม่หยุดเที่ยว แต่สร้าง exception · manager อนุมัติจากมือถือ → หน้าอนุมัติแบบย่อผ่านลิงก์ในแจ้งเตือน (ต้อง login)

**9. เกณฑ์ตรวจรับ**
- Given รถ 71-0457 กทม. ตรวจรถก่อนออกไม่ผ่านข้อวิกฤต "เบรก" When ลาก DO ลงรถนี้ Then วางไม่ได้ tooltip "ตรวจรถไม่ผ่าน: เบรก (08:12)" และ popover ไม่มีปุ่ม override
- Given รถมีเที่ยว planned และ พ.ร.บ. หมดเที่ยงคืนนี้ When job เที่ยงคืนทำงาน Then การ์ดแสดง "ต้องย้ายรถ" และ dispatcher ได้รับแจ้ง
- Given ประกันภัยหมด (override ได้) When dispatcher ขอยกเว้นพร้อมเหตุผล "ต่ออายุแล้วรอกรมธรรม์" และ manager อนุมัติ Then เที่ยวเป็น planned, audit มีผู้ขอ/ผู้อนุมัติ/เหตุผล/ค่า ณ ตอนนั้น
- Given 6,800 กก. บนรถ 6,000 กก. และเพดาน override 0% When manager พยายามอนุมัติ Then ไม่มีตัวเลือกอนุมัติ ข้อความ "น้ำหนักเกินกฎหมาย/ความจุ ห้ามยกเว้น"
- Given คนขับใบ ท.2 When ใส่ในเที่ยวรถพ่วง Then บล็อก `DRIVER_LICENCE_CLASS` override ไม่ได้

**10. เฟส** — P0 (`LOCATION_VEHICLE_LIMIT` restrictedWindows = P1)

---

## 7. เสนอรถ (Vehicle suggestion)

**1. จุดประสงค์** — ช่วยตัดสินใจระหว่างรถบริษัท / รถร่วมประจำ / รถร่วมอื่น สำหรับ SO/DO ที่เลือก ด้วยการเปรียบเทียบต้นทุน ความตรงเวลา และความจุ — แบบกฎ (ไม่ใช่ optimizer) [DECISION รอบ 2 การ์ด 2]

**2. ผู้ใช้/สิทธิ์** — dispatcher, manager; ตัวเลขต้นทุน/margin แสดงตาม `price.buy.view`/`price.sell.view`

**3. หน้าจอ** — ปุ่ม "เสนอรถ" ใน drawer SO/DO และบนการ์ด "SO รอจัด" → dialog การ์ดเปรียบเทียบ: ซ้าย = เงื่อนไขงาน (น้ำหนัก, ประเภทรถ, กำหนดส่ง, เส้นทาง, ป้ายพิเศษ); ขวา = 3 ตัวเลือก (รถบริษัทที่ดีที่สุด / รถร่วมประจำที่ดีที่สุด / รถร่วมอื่นที่ดีที่สุด) แต่ละใบ: ชื่อ/ทะเบียน, คะแนนตัวใหญ่ (0–100), แถบ ต้นทุน · ตรงเวลา · ความจุ, ต้นทุนคาด (บาท) + margin, เวลาว่าง/ถึงจุดรับได้, เหตุผล 2–3 ข้อ; ใบแนะนำขอบ accent + ป้าย "แนะนำ"; ลิงก์ "ดูทั้งหมด" (รายการเต็มเรียงคะแนน); ปุ่มในแต่ละใบ: "จัดรถนี้" (own) / "ส่งข้อเสนอ" (รถร่วม → §8)

**4. ฟิลด์ — ผลการคำนวณ (Suggestion)**

| ฟิลด์ | ที่มา |
|---|---|
| `candidateType` | own / subcon_preferred / subcon_other |
| `estimatedCost` | own: ระยะทาง (stop ทั้งหมด + ขาไปจุดรับจากตำแหน่งว่างล่าสุด) × ต้นทุน/กม. ของรถ (06; ไม่มี = `costPerKmDefault`) + ค่าเที่ยวคนขับ; subcon: ราคาซื้อจาก rate card buy (MD-123) หรือ ค่าเฉลี่ย 5 ครั้งล่าสุดในเส้นทาง+ประเภทรถ (PL4) |
| `margin` | รายได้ SO/DO − estimatedCost |
| `onTimeScore` | own: ช่องว่างเวลา (รถว่างก่อน windowStart − เวลาเดินทางไปจุดรับ ≥ 0 = เต็ม); subcon: `onTimeRate30d` × `acceptRate30d` |
| `capacityScore` | ใกล้ 100% utilization แต่ไม่เกิน = สูง; เกิน = ตัดออก |
| `score` | ถ่วงน้ำหนัก ต้นทุน 40 / ตรงเวลา 35 / ความจุ 25 (ปรับได้ในตั้งค่า) [PROPOSED] |
| `reasons[]` | ข้อความอธิบาย เช่น "ว่างตั้งแต่ 06:30 ที่ลานวังน้อย ห่าง 12 กม." |

**5. กฎธุรกิจ**

| รหัส | กฎ |
|---|---|
| PLN-110 | ตัดผู้สมัครที่ติดกฎบล็อก (§6) ออกก่อนคำนวณ; แสดงจำนวนที่ถูกตัด + เหตุผลสรุป ("ตัดออก 4 คัน: ซ่อม 1, เอกสารหมด 2, ใบขับขี่ 1") |
| PLN-111 | รถบริษัทนับว่าว่างถ้าไม่มีเที่ยวทับช่วง [windowStart − เวลาไปจุดรับ, ประมาณเวลาจบ]; ตำแหน่งเริ่ม = จุดส่งสุดท้ายของเที่ยวก่อนหน้า หรือลาน (PL3) |
| PLN-112 | รถร่วมประจำ = `tier=preferred`; ถ้ามีเพดาน `maxTripsPerDay` และครบแล้ว → ตัดออก |
| PLN-113 | ไม่มีข้อมูลราคาซื้อของรถร่วม → ต้นทุน "ไม่ทราบ" คะแนนต้นทุน = กลาง (50) และแสดงป้าย |
| PLN-114 | margin ต่ำกว่าเกณฑ์ (ตั้งค่า tenant default 10%) → ป้ายเตือนส้มบนใบนั้น |
| PLN-115 | บันทึกผลเสนอที่แสดงและตัวเลือกที่ผู้ใช้เลือก (`SuggestionLog`) เพื่อตรวจสอบย้อนหลังว่าทำไมเลือกรถร่วมรายนี้ (PL5) |

**6. สถานะ** — ไม่มี (คำนวณสด) · **7. Event** — ไม่มี (audit SuggestionLog)

**8. กรณีผิดปกติ** — ไม่มีผู้สมัครเลย → ข้อความ "ไม่มีรถที่ผ่านเงื่อนไข" + ปุ่ม "ส่งข้อเสนอรถร่วม (ทั้งหมด)" · ไม่มีพิกัดตำแหน่งรถ → ใช้ลาน และลดความมั่นใจ · คำนวณเกิน 3 วินาที → แสดงผลบางส่วน + "กำลังคำนวณ"

**9. เกณฑ์ตรวจรับ**
- Given รถบริษัทว่าง 1 คัน (ต้นทุน 5,200) และรถร่วมประจำราคาซื้อ 6,000 ราคาขาย 7,800 When เสนอรถ Then 3 ใบ และใบรถบริษัทมีป้าย "แนะนำ" (ถ้าคะแนนสูงสุด) พร้อม margin 2,600.00
- Given รถทุกคันประเภทนี้ติดกฎ When เสนอรถ Then การ์ดรถบริษัทว่าง พร้อมเหตุผลที่ถูกตัด

**10. เฟส** — P1 (P0 มีเฉพาะการไฮไลต์รถที่รับได้บนกระดาน PLN-040/PL3)

---

## 8. จ่ายงานรถร่วม (Subcontractor dispatch)

**1. จุดประสงค์** — ส่งข้อเสนองานให้รถร่วมผ่านลิงก์ LINE/SMS (ไม่ต้องมีบัญชี) ให้กดรับพร้อมทะเบียนและคนขับ หรือปฏิเสธพร้อมเหตุผล ตามลำดับ cascade พร้อมราคาซื้อและ margin และใช้กฎห้ามจ่ายงานชุดเดียวกัน (PL4, PL5, PL6)

**2. ผู้ใช้/สิทธิ์** — ส่งข้อเสนอ: dispatcher (`subcon.dispatch`) · ราคาซื้อเกินเพดาน/ margin ต่ำกว่าเกณฑ์: manager อนุมัติ · รถร่วม: ผ่านหน้าลิงก์ (04-execution §หน้ารถร่วม)

**3. หน้าจอ**
- จาก drawer SO/DO ปุ่ม "ส่งต่อรถร่วม", จากกระดาน (คลิกขวา/เมนูการ์ด) หรือจากการ์ด "เสนอรถ" → panel 3 ขั้น:
  1. **เลือกรถร่วม**: โหมด "รายเดียว" (เลือก 1) หรือ "ไล่ลำดับ (cascade)" (เลือกหลายรายแล้วลากเรียง, ค่าเริ่มต้นจาก `cascadeRank`); แต่ละรายแสดง ราคา 5 ครั้งล่าสุดในเส้นทางนี้, อัตรารับงาน/ตรงเวลา 30 วัน, งานวันนี้/เพดาน, ป้ายกฎ (รถร่วม inactive)
  2. **ราคาและเงื่อนไข**: ราคาเสนอ (เติมจาก rate card buy → ค่าเฉลี่ยล่าสุด → ว่าง), ค่าบริการเสริมส่งต่อ (`passThroughToSubcon`), เวลาตอบกลับ (timeout), เงื่อนไขพิเศษ; แสดง ราคาขาย (ถ้ามีสิทธิ์) − ราคาซื้อ = margin บาท/%
  3. **ตัวอย่างใบสั่งงาน** (สิ่งที่รถร่วมจะเห็น — **ไม่มีราคาขาย**: จุดรับ-ส่ง เวลา สินค้า น้ำหนัก ประเภทรถ ราคาค่าจ้าง เงื่อนไข POD) → "ส่งข้อเสนอ"
- แท็บ "ข้อเสนอรถร่วม" ในหน้า SO/DO และหน้ารวม "งานรถร่วม" (ปฏิบัติการ): ตารางข้อเสนอ สถานะ เวลาเหลือ ผู้ส่ง; ปุ่ม ส่งซ้ำ / ถอนข้อเสนอ / ข้ามไปรายถัดไป
- บนกระดาน: การ์ดที่รอรถร่วมตอบ อยู่ในแถว "รอรถร่วมตอบ" พร้อมนับถอยหลัง

**4. ฟิลด์ — SubconOffer**

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| `offerNo` | auto | ✓ | | |
| `doIds` / `tripId` | ref | ✓ | DO ต้อง pending หรือเที่ยว draft | ข้อเสนอเป็นระดับเที่ยว (ระบบสร้างเที่ยว draft subcontract ให้) |
| `cascadeGroupId` | uuid | – | | ข้อเสนอในลำดับเดียวกัน |
| `cascadeStep` | int | – | | |
| `subcontractorId` | ref | ✓ | active | |
| `offeredPrice` | decimal(12,2) | ✓ | > 0 | ราคาซื้อ (ก่อนหัก ณ ที่จ่าย) |
| `extraCharges` | {code, amount}[] | – | | |
| `sellPriceSnapshot`, `marginAmount`, `marginPercent` | decimal | auto | | ไม่ส่งไปหน้ารถร่วม |
| `priceSource` | enum `rate_card`/`last_avg`/`manual` | auto | | |
| `responseTimeoutMinutes` | int | ✓ | 5–1,440, default ตามตั้งค่า (งานวันนี้ 30, ล่วงหน้า 120) [PROPOSED] | |
| `linkToken` | string (≥ 32 bytes random) | auto | | ลิงก์อายุ 48 ชม. หรือจนงานจบ (PL4) |
| `channels` | set {line, sms} | ✓ | ต้องมี contact ช่องทางนั้น | |
| `status` | enum ข้อ 6 | ✓ | | |
| `sentAt`, `respondedAt`, `expiresAt` | datetime | auto | | |
| `rejectReasonCode`, `rejectNote` | | เงื่อนไข | หมวด `subcon_reject` | |
| `acceptedVehicle` | {vehicleId? , plateNo, province} | ✓ เมื่อรับ | | |
| `acceptedDriver` | {driverId?, name, phone, licenceClass?, licenceExpiry?} | ✓ เมื่อรับ | | |
| `counterPrice` | decimal | – | | [P2] รถร่วมเสนอราคากลับ |
| `selectionRationale` | text | ✓ เมื่อไม่ได้เลือกรายที่ถูกที่สุด/ลำดับแรก | | PL5 ตรวจสอบย้อนหลัง |

**5. กฎธุรกิจ**

| รหัส | กฎ |
|---|---|
| PLN-130 | รถร่วมต้องผ่านกฎระดับรถร่วม (`SUBCON_INACTIVE`) ก่อนส่ง; กฎระดับรถ/คนขับ (§6) ประเมินตอนรถร่วมกรอกทะเบียน+คนขับ (PLN-152) [DECISION ใช้กฎเดียวกัน] |
| PLN-131 | ส่งข้อเสนอ: สร้างเที่ยว `draft` ประเภท subcontract, DO → ป้าย "รอรถร่วมตอบ" (ยัง pending แต่ล็อกไม่ให้ลากเข้ารถอื่นจนกว่าจะถอน/หมดเวลา) |
| PLN-132 | ข้อความ LINE/SMS: ชื่อบริษัท, สรุปงาน 2 บรรทัด (วันเวลา, เส้นทาง, ประเภทรถ), ค่าจ้าง, เวลาที่ต้องตอบ, ลิงก์ — ไม่มีราคาขาย/ชื่อลูกค้าถ้า tenant ตั้ง "ซ่อนชื่อลูกค้าจากรถร่วม" |
| PLN-133 | Cascade: ส่งให้ลำดับ 1 → ถ้าปฏิเสธหรือหมดเวลา ส่งลำดับถัดไปอัตโนมัติ; จบเมื่อมีผู้รับ หรือครบรายชื่อ → แจ้ง dispatcher "ไม่มีรถร่วมรับงาน" และ DO กลับ pending ป้าย "รถร่วมปฏิเสธ" (PL7) |
| PLN-134 | โหมด "ส่งพร้อมกันหลายราย" (broadcast, ใครรับก่อนได้) [P1]: ผู้รับคนแรกได้งาน ที่เหลือได้ข้อความ "งานนี้มีผู้รับแล้ว" อัตโนมัติ |
| PLN-135 | ทุกลำดับ cascade และราคาที่เสนอบันทึกใน `SubconOffer` (audit ว่าเสนอใคร ราคาเท่าไร ใครปฏิเสธ เพราะอะไร) — ใช้ตรวจการทุจริต (PL5) |
| PLN-140 | ราคา: เติมจาก rate card buy ของรถร่วม (MD-123) → ราคามาตรฐานฝั่งซื้อ → ค่าเฉลี่ย 5 ครั้งล่าสุด → ว่าง (กรอกเอง); แก้ราคาได้ |
| PLN-141 | margin = ราคาขายของ DO ในเที่ยว (ORD-082, ไม่รวม VAT) − ราคาซื้อ − ค่าบริการเสริมส่งต่อ; margin% < เกณฑ์ (default 10%) หรือราคาซื้อ > ราคาขาย → ต้อง manager อนุมัติก่อนส่ง (สถานะ `pending_approval`) |
| PLN-142 | ข้อเสนอที่ส่งแล้วแก้ราคาไม่ได้ — ต้องถอนแล้วส่งใหม่ (ลิงก์เดิมแสดง "ข้อเสนอนี้ถูกยกเลิก") |
| PLN-145 | เมื่อรถร่วมรับงาน ราคาที่ตกลงเป็น cost line ของเที่ยว (PLN-009) และเป็นฐาน settlement (05) พร้อมหัก ณ ที่จ่าย 1% [FACT ท.ป.4/2528 ข้อ 12/4] |
| PLN-150 | หน้าลิงก์ของรถร่วม (รายละเอียด UI ใน 04): ปุ่ม "รับงาน" / "ปฏิเสธ"; ลิงก์ใช้ได้กับข้อเสนอเดียว; เปิดลิงก์บันทึก `viewedAt` |
| PLN-151 | ปฏิเสธ: เลือกเหตุผล (หมวด `subcon_reject`) + หมายเหตุไม่บังคับ (ยกเว้น "อื่นๆ") |
| PLN-152 | รับงาน: เลือกทะเบียนจากรถของตัวเองที่ลงทะเบียนไว้ หรือพิมพ์ใหม่ (ทะเบียน + จังหวัด + ประเภทรถ) และเลือก/พิมพ์คนขับ (ชื่อ, เบอร์, ชั้นใบขับขี่, วันหมดอายุ — ถ้ามี) → ระบบประเมินกฎ §6 ทันที: ผ่าน → ข้อเสนอ `accepted`, เที่ยว `planned` (หรือ `dispatched` ถ้าตั้ง "รถร่วมรับ = ส่งงาน" default เปิด); ไม่ผ่านกฎบล็อกที่ override ไม่ได้ → แจ้งรถร่วมทันที "รถ/คนขับนี้รับงานไม่ได้: {เหตุผล} กรุณาเลือกคันอื่น"; ติดกฎที่ override ได้หรือ `DOC_UNKNOWN` → `accepted_pending_check` รอ dispatcher ยืนยัน (PLN-081/090) |
| PLN-153 | รถ/คนขับใหม่จากรถร่วม → สร้างข้อมูล `pending_review` (MD-201) ผูกรถร่วมนั้น |
| PLN-154 | หมดเวลา: job ตรวจทุก 1 นาที; ถึง `expiresAt` ไม่มีคำตอบ → `expired` + cascade ต่อ (PLN-133); ลิงก์แสดง "หมดเวลาตอบรับ" |
| PLN-155 | ถอนข้อเสนอ (dispatcher) ได้เมื่อ `sent`/`accepted_pending_check`; หลัง `accepted` ต้องยกเลิกเที่ยว (PLN-012, ระบุค่าชดเชย) |
| PLN-156 | รถร่วมที่รับงานแล้วขอยกเลิก (ผ่านลิงก์ "ยกเลิกการรับงาน" ก่อนเริ่มเที่ยว) → ต้องใส่เหตุผล; เที่ยวกลับ draft, DO กลับ pending + แจ้ง dispatcher ด่วน; นับลดคะแนน `acceptRate` |
| PLN-157 | เพดานต่อรถร่วม (`maxTripsPerDay`) นับเที่ยว accepted ในวัน; ครบแล้วไม่อยู่ในรายการ cascade อัตโนมัติ (เลือกเองได้พร้อมเหตุผล) |
| PLN-158 | งานรถร่วมเป็น parent/child (PL6): ลูกค้าเห็นเฉพาะ SO/DO ของตน (ไม่เห็นรถร่วม/ราคาซื้อ); POD จากรถร่วมผูก DO เดิม |

**6. สถานะ SubconOffer**

| สถานะ | ป้ายไทย |
|---|---|
| `pending_approval` | รออนุมัติราคา |
| `sent` | รอตอบ |
| `accepted_pending_check` | รับงาน — รอตรวจรถ/คนขับ |
| `accepted` | รับงาน |
| `rejected` | ปฏิเสธ |
| `expired` | หมดเวลา |
| `withdrawn` | ถอนข้อเสนอ |
| `cancelled_by_subcon` | รถร่วมยกเลิก |

| จาก → ไป | เงื่อนไข | ใคร | ผลข้างเคียง |
|---|---|---|---|
| (ใหม่) → pending_approval | PLN-141 | ระบบ | แจ้ง manager |
| (ใหม่)/pending_approval → sent | ผ่าน/อนุมัติ | dispatcher/manager | ส่ง LINE/SMS, ตั้ง expiresAt |
| sent → accepted | PLN-152 ผ่าน | รถร่วม | เที่ยว planned/dispatched; `subcon_offer.accepted`; ข้อเสนออื่นใน cascade/broadcast ถูกถอน |
| sent → accepted_pending_check | ติดกฎ override ได้/ไม่ทราบเอกสาร | รถร่วม | แจ้ง dispatcher |
| accepted_pending_check → accepted | dispatcher ยืนยัน/override | dispatcher/manager | |
| accepted_pending_check → rejected | dispatcher ปฏิเสธรถที่กรอก | dispatcher | แจ้งรถร่วมให้เลือกคันใหม่หรือ cascade ต่อ |
| sent → rejected | เหตุผล | รถร่วม | cascade ต่อ |
| sent → expired | ถึงเวลา | ระบบ | cascade ต่อ |
| sent/accepted_pending_check → withdrawn | – | dispatcher | ลิงก์ใช้ไม่ได้ |
| accepted → cancelled_by_subcon | ก่อน in_progress + เหตุผล | รถร่วม | PLN-156 |

**7. Event** — `subcon_offer.sent`, `subcon_offer.accepted`, `subcon_offer.rejected`, `subcon_offer.expired`, `subcon_offer.withdrawn`, `subcon_offer.cancelled` (ภายใน + แจ้งเตือน; webhook P2) และ `trip.dispatched`, `shipment.assigned` ตามปกติ

**8. กรณีผิดปกติ** — LINE ส่งไม่สำเร็จ (ยังไม่เป็นเพื่อน OA) → ส่ง SMS แทนอัตโนมัติถ้ามีเบอร์ + แจ้ง · รถร่วมกดรับพร้อมกันสองคนในโหมด broadcast → transaction lock, คนที่สองเห็น "มีผู้รับแล้ว" · ลิงก์ถูกส่งต่อให้คนอื่น → ใช้ได้ (ไม่มี login) แต่ log IP/อุปกรณ์ และ tenant เปิด "ยืนยัน OTP เบอร์รถร่วม" ได้ [P1] · SO ถูกยกเลิกระหว่างรอตอบ → ถอนข้อเสนออัตโนมัติ + ข้อความแจ้ง

**9. เกณฑ์ตรวจรับ**
- Given cascade รถร่วม A → B → C timeout 30 นาที When A ปฏิเสธ "ราคาต่ำไป" และ B ไม่ตอบ Then 30 นาทีหลังส่ง B ระบบส่ง C และประวัติแสดง A ปฏิเสธ (เหตุผล), B หมดเวลา
- Given ราคาขาย 7,800 ราคาซื้อเสนอ 7,300 (margin 6.4% < 10%) When กดส่ง Then สถานะรออนุมัติ และไม่มีข้อความถึงรถร่วมจน manager อนุมัติ
- Given รถร่วมรับงานด้วยคนขับใบ ท.2 สำหรับพ่วง When กดยืนยัน Then หน้ารถร่วมแสดง "คนขับนี้รับงานไม่ได้: ใบขับขี่ไม่ถึง ท.3" และข้อเสนอยัง sent
- Given หน้าลิงก์รถร่วม Then ไม่มีราคาขายหรือ margin ปรากฏใน HTML/response ใด ๆ
- Given รถร่วมรับงาน 6,800.00 When ปิดเที่ยว Then cost line ค่าจ้างรถร่วม 6,800.00 และ WHT 1% = 68.00 พร้อมเข้า settlement

**10. เฟส** — P0: รายเดียว + cascade แบบส่งทีละรายอัตโนมัติ, timeout, accept/reject, กฎ, margin · P1: broadcast, OTP · P2: counter price

---

## 9. ส่งแผนให้คนขับ (Send plan)

**1. จุดประสงค์** — ให้ dispatcher วางแผนตอนเย็นแล้วส่งทั้งวันทีเดียว (PL8) และให้คนขับรับ/ปฏิเสธงานในแอป

**2. ผู้ใช้/สิทธิ์** — dispatcher (`planning.dispatch`)

**3. หน้าจอ** — ปุ่ม "ส่งแผน (N)" บนกระดาน → dialog: รายการเที่ยว planned ของวันที่เลือก (ติ๊กได้) จัดกลุ่มตามคนขับ, แสดงเที่ยวที่ส่งไม่ได้ (ติดกฎ/ไม่มีคนขับ) พร้อมเหตุผล, ตัวเลือก "ส่งทันที" / "ตั้งเวลาส่ง" (เช่น 05:00 พรุ่งนี้), ช่องทาง (push แอป + LINE คนขับถ้าผูก) → สรุปผลส่ง

**4. ฟิลด์** — `PlanDispatchBatch {id, tripIds[], scheduledAt, sentAt, sentBy, results[{tripId, status: sent/failed/skipped, reason}]}`; Trip: `planVersion`, `planSentAt`, `driverAck` (`pending`/`accepted`/`rejected`), `driverAckAt`, `driverRejectReason`

**5. กฎธุรกิจ**

| รหัส | กฎ |
|---|---|
| PLN-170 | ส่งแผน = re-check กฎ §6 ทุกเที่ยว → ผ่าน: เที่ยว `dispatched`, `planVersion` +1, push ถึงคนขับ; ไม่ผ่าน: ข้ามพร้อมเหตุผล |
| PLN-171 | ตั้งเวลาส่ง: job ส่งตามเวลา และ re-check กฎ ณ เวลาส่งจริง |
| PLN-172 | คนขับรับ/ปฏิเสธในแอป (M11) — ปฏิเสธต้องเลือกเหตุผล (หมวด `driver_reject`) → เที่ยวกลับ `planned` + แจ้ง dispatcher ด่วน |
| PLN-173 | คนขับไม่ตอบรับภายใน X นาทีก่อน plannedStart (default 60) → exception "คนขับยังไม่รับงาน" (04) |
| PLN-174 | รถร่วม: เที่ยวที่รถร่วมรับผ่านลิงก์ถือว่า dispatched แล้ว (PLN-152) ไม่ต้องส่งแผนซ้ำ; รายละเอียดคนขับรถร่วมได้ลิงก์งาน/ePOD ของตัวเอง (04) |
| PLN-175 | แก้เที่ยวที่ dispatched (stop, เวลา > 15 นาที, รถ, DO): เที่ยวติดป้าย "แผนเปลี่ยน" (PLN-053); dispatcher กด "ส่งการเปลี่ยนแปลง" → คนขับได้ข้อความสรุปสิ่งที่เปลี่ยน (diff) ใน M18 และต้องกดรับทราบ; การเปลี่ยนเวลา ≤ 15 นาทีส่งอัตโนมัติแบบแจ้งเตือนเท่านั้น |
| PLN-176 | เปลี่ยนคนขับหลัง dispatched → คนขับเดิมได้ข้อความ "งานถูกย้าย" และงานหายจากแอป; คนขับใหม่ได้งานเป็น pending ack |
| PLN-177 | ส่งแผนซ้ำเมื่อ push ล้มเหลว: retry 3 ครั้ง แล้วแสดง "ส่งไม่ถึงเครื่อง" + ปุ่มส่งทาง LINE/SMS |

**6. สถานะ** — `driverAck`: pending → accepted/rejected; ใช้ร่วมกับสถานะเที่ยว (§4)

**7. Event** — `trip.dispatched`, `trip.plan_changed`, `trip.driver_accepted`, `trip.driver_rejected`, `shipment.assigned`

**8. กรณีผิดปกติ** — คนขับออฟไลน์ → แอปได้งานเมื่อออนไลน์ (04 offline); สถานะส่งแสดง "ส่งแล้ว · ยังไม่ถึงเครื่อง" · คนขับมี 2 เที่ยวซ้อนเวลา (override แล้ว) → แอปแสดงตามลำดับเวลา

**9. เกณฑ์ตรวจรับ**
- Given 18 เที่ยว planned วันพรุ่งนี้ (1 เที่ยวติดกฎ) When ส่งแผน Then 17 เที่ยว dispatched และสรุปแสดง 1 ข้ามพร้อมเหตุผล
- Given เที่ยว dispatched When เลื่อน stop 2 ไป 40 นาที Then ป้าย "แผนเปลี่ยน" และคนขับไม่ได้รับจนกว่ากด "ส่งการเปลี่ยนแปลง"
- Given คนขับปฏิเสธงาน "ป่วย" When ปฏิเสธ Then เที่ยวกลับ planned และ dispatcher ได้แจ้งเตือน

**10. เฟส** — P0 (ตั้งเวลาส่ง PLN-171 = P1)

---

## 10. Event รวม และ [OPEN]

### 10.1 Event ของโมดูลนี้

| Event | Webhook (07) | ผู้เกิด |
|---|---|---|
| `order.created` / `order.updated` / `order.cancelled` | ✓ P0 (ชื่อตามรอบ 11) | §2 |
| `order.confirmed` / `order.completed` | ✓ P1 | §2 |
| `shipment.assigned` / `shipment.picked_up` / `shipment.arrived` / `shipment.delivered` / `shipment.failed` | ✓ P0 | §3, 04 |
| `pod.uploaded` | ✓ P0 | 04 |
| `trip.started` / `trip.completed` | ✓ P0 | §4 |
| `trip.created` / `trip.planned` / `trip.dispatched` / `trip.cancelled` / `trip.closed` / `trip.plan_changed` | ✓ P1 | §4, §9 |
| `trip.rule_overridden`, `dispatch.override_requested`, `trip.driver_accepted/rejected` | ภายใน + audit | §6, §9 |
| `subcon_offer.*` | ภายใน (webhook P2) | §8 |
| `inbox.message_received/converted/dismissed` | ภายใน | §1 |

payload ทุก event มี `event_id`, `occurred_at` (ISO 8601 +07:00), `tenant_id`, `data` (schema เดียวกับ REST — D6) และ `custom_fields` ตาม MD-245

### 10.2 คำถามเปิด (ย้ายไป 12-roadmap-open-questions.md)

| รหัส | คำถาม | ผลกระทบ |
|---|---|---|
| OPEN-ORD-1 | กฎเอกสารรถหมดอายุ (ประกันภัยภาคสมัครใจ, พ.ร.บ., ภาษีรถประจำปี, ตรอ.) ข้อใดผิดกฎหมายเด็ดขาดจน "ห้าม override" และข้อใดเป็นนโยบายบริษัท — ต้องยืนยันกับที่ปรึกษากฎหมาย/กรมการขนส่งทางบก | ตารางกฎ §6 คอลัมน์ override |
| OPEN-ORD-2 | ยอมให้ manager อนุมัติบรรทุกเกิน payload ได้ไม่เกินกี่ % (ถ้าได้เลย) เมื่อเทียบกับน้ำหนักรวมตามกฎหมายของกรมทางหลวง (payload ที่ลงทะเบียนอาจต่ำกว่าเพดานกฎหมาย) — ต้นแบบรอบ 9 ให้ขออนุมัติได้ แต่ระบุว่า 6,800/6,000 "ผิดกฎหมาย" | PLN-091 |
| OPEN-ORD-3 | รูปแบบเลขเอกสารปฏิบัติการ (SO/DO/TRP) ใช้ปี พ.ศ. หรือ ค.ศ. เป็นค่าเริ่มต้น (ต้นแบบใช้ SO-2611-…) | §0, 05 |
| OPEN-ORD-4 | ค่าเริ่มต้น timeout ตอบรับของรถร่วม (30/120 นาที) และอายุลิงก์ 48 ชม. — ยืนยันกับลูกค้าจริง 3–5 ราย | PLN-154 |
| OPEN-ORD-5 | ค่ายกเลิกงาน (CANCEL_FEE) และค่าชดเชยรถร่วมเมื่อยกเลิกหลังรับงาน: มีนโยบายมาตรฐานในตลาดไทยหรือไม่ และธง VAT/WHT ของค่ายกเลิก | ORD-035, PLN-012 |
| OPEN-ORD-6 | ช่วงเวลากระดานค่าเริ่มต้น 06:00–20:00 พอสำหรับลูกค้าที่วิ่งกลางคืน (งานท่าเรือ/ห้องเย็น) หรือควรเป็น 24 ชม. แบบเลื่อนได้ | PLN §5 |
