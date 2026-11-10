# 02 — ข้อมูลหลัก (Master Data)

> ⚠️ **ลำดับความสำคัญ (10 พ.ย. 2569):** ไฟล์นี้เขียนโดยไม่ได้อ่าน `docs/` (v2) เมื่อเนื้อหาขัดกับ `docs/` ให้ยึด `docs/` — ดู `plan/00-source-of-truth.md` และรายการจุดที่ขัดกันใน `plan/00a-reconcile-architecture.md`, `plan/00b-reconcile-requirements.md` · ป้าย P0/P1/P2 ในไฟล์นี้เป็นมาตราส่วนของ spec ไม่ใช่ "เฟส 0" ของแผนพัฒนา

> รหัสข้อกำหนด: `MD-nnn` · สถานะเอกสาร: ร่าง v0.1 (9 พ.ย. 2569)
> แหล่งที่มา: design-briefs รอบ 1, 6 (ข้อ 6 ผู้ขาย/อู่), 9, 10, 11 (ข้อ B สถานที่/สินค้า/ประเภทรถ/ค่าบริการเสริม, ข้อ 9 shipper key), 12 (custom fields), 13 (โควตาฟิลด์ตามแพ็กเกจ) · tms-product-learning §3.2 (M1–M7), §3.1 (P3, P8) · thai-tax-docs-research §0, §1.8, §3.1, §5.3
> อ้างอิงข้าม: รถ/หาง/เอกสารรถ/คนขับละเอียด → [06-fleet.md](06-fleet.md) · Open API, webhook, field mapping → [07-integration.md](07-integration.md) · ใช้ราคาใน SO → [03-orders-planning.md](03-orders-planning.md) · ออกเอกสารภาษี → [05-billing.md](05-billing.md) · โควตาแพ็กเกจ → [01-platform.md](01-platform.md)

## สารบัญ

| § | หัวข้อ | ช่วงรหัส | เฟส |
|---|---|---|---|
| 0 | หลักร่วมของข้อมูลหลักทุกตัว | MD-001–019 | P0 |
| 1 | ลูกค้า | MD-020–049 | P0 (แท็บ API = P1) |
| 2 | สถานที่ / สมุดที่อยู่ | MD-050–069 | P0 |
| 3 | สินค้าและหน่วย | MD-070–089 | P0 |
| 4 | ประเภทรถ | MD-090–109 | P0 |
| 5 | Rate card + fuel surcharge | MD-110–149 | P0 (อนุมัติ/เวอร์ชัน = P0, zone matrix = P1) |
| 6 | ค่าบริการเสริม (accessorial) | MD-150–179 | P0 |
| 7 | ผู้ขาย / อู่ | MD-180–199 | P1 |
| 8 | คนขับและรถร่วม (สรุป) | MD-200–219 | P0 |
| 9 | เหตุผลมาตรฐาน (reason master) | MD-220–229 | P0 |
| 10 | ฟิลด์เพิ่มเติม (custom fields) | MD-230–279 | P0 (โครง) / P1 (API flags เต็ม) |
| 11 | นำเข้า Excel/CSV | MD-280–299 | P0 |
| 12 | Event รวม + [OPEN] | — | — |

---

## 0. หลักร่วมของข้อมูลหลักทุกตัว

### 0.1 กฎร่วม

| รหัส | กฎ |
|---|---|
| MD-001 | ทุกตารางมี `tenantId` และทุก unique constraint ขึ้นต้นด้วย `tenantId` (เช่น `(tenantId, code)`) [DECISION] |
| MD-002 | ทุก entity มี `code` (รหัสที่ผู้ใช้เห็น) ระบบเสนอเลขอัตโนมัติตามรูปแบบใน §ของ entity แก้ได้ก่อนบันทึกครั้งแรก หลังบันทึกแก้ได้เฉพาะ admin และบันทึก audit; ห้ามซ้ำใน tenant (ไม่สนตัวพิมพ์เล็ก/ใหญ่, ตัดช่องว่างหัวท้าย) |
| MD-003 | สถานะข้อมูลหลักมี 2 ค่าเท่านั้น: `active` (ใช้งาน) / `inactive` (ปิดใช้) [DECISION รอบ 1] — ปิดใช้แล้วเลือกในเอกสารใหม่ไม่ได้ แต่เอกสารเก่ายังแสดงและอ้างอิงได้ |
| MD-004 | ไม่มีการลบจริง (D7): "ลบ" ได้เฉพาะรายการที่ไม่เคยถูกอ้างอิง → soft delete (`deletedAt`) กู้คืนได้ 30 วันโดย admin แล้ว job ลบถาวร; รายการที่ถูกอ้างอิงแล้วทำได้แค่ปิดใช้ |
| MD-005 | เอกสารที่อ้างข้อมูลหลัก (SO, DO, Trip, ใบแจ้งหนี้) เก็บ **snapshot** ค่าที่มีผลต่อเงิน/ภาษี/การพิมพ์ ณ เวลาสร้าง (ชื่อ ที่อยู่ เลขผู้เสียภาษี สาขา ราคา VAT) — แก้ข้อมูลหลักแล้วไม่ย้อนแก้เอกสารเก่า [DECISION, M5] |
| MD-006 | ทุกการสร้าง/แก้/ปิดใช้/ลบ/กู้คืน บันทึก audit: ใคร เมื่อไร ฟิลด์ใด ค่าเดิม→ค่าใหม่ ช่องทาง (UI/API/MCP/import/connector) |
| MD-007 | Optimistic locking ด้วย `version` — บันทึกทับข้อมูลที่คนอื่นแก้ไปแล้ว → 409 "ข้อมูลถูกแก้โดย {ชื่อ} เมื่อ {เวลา}" + ปุ่มโหลดใหม่/เปรียบเทียบ |
| MD-008 | ชื่อที่ผู้ใช้เห็นเก็บได้ 3 ภาษา (`name_th` บังคับ, `name_en`, `name_zh` ไม่บังคับ) สำหรับ entity ที่ระบุ "3 ภาษา" ในตารางฟิลด์; ถ้าภาษาอื่นว่าง แสดงภาษาไทย |
| MD-009 | เบอร์โทรเก็บ E.164 (`+66…`) แสดงแบบไทย `081-234-5678`; อีเมลตรวจรูปแบบ; ที่อยู่ไทยแยก บ้านเลขที่/ถนน · ตำบล/แขวง · อำเภอ/เขต · จังหวัด · รหัสไปรษณีย์ (เลือกจากฐานข้อมูลตำบล–อำเภอ–จังหวัด เติมรหัสไปรษณีย์อัตโนมัติ) |
| MD-010 | หน้า list ข้อมูลหลักใช้ "แถบสรุปบรรทัดเดียว" ไม่ใช้ KPI card 4 ใบ [DECISION รอบ 2]; ตารางมีตัวกรองใต้หัวคอลัมน์ เมนูคอลัมน์ (รวม custom fields) export Excel/CSV และ drawer มาตรฐาน (00-overview §6) |
| MD-011 | สิทธิ์: dispatcher = อ่านข้อมูลหลักทั้งหมด + สร้าง/แก้ สถานที่ และสินค้า; manager/admin = ทุกอย่าง; accounting = แก้ข้อมูลบัญชีของลูกค้า/ผู้ขาย (เงื่อนไขชำระ VAT WHT) ; สิทธิ์ละเอียดตั้งได้ที่หน้าสิทธิ์ตามบทบาท (01-platform) |
| MD-012 | ราคาขายเป็นข้อมูลอ่อนไหว: สิทธิ์ `price.sell.view` / `price.sell.edit` / `price.buy.view` แยกจากสิทธิ์โมดูล (P3) — ผู้ไม่มีสิทธิ์เห็น "—" ทั้งใน UI, export และ API; รถร่วมไม่เห็นราคาขายในทุกช่องทาง [DECISION] |
| MD-013 | ข้อมูลหลักทุกตัวมี section "ข้อมูลเพิ่มเติม" (custom fields) เมื่อ entity นั้นรองรับ (§10) |
| MD-014 | ข้อมูลหลักที่ถูกสร้างจาก AI/MCP/connector เข้าเป็นสถานะ `active` ได้เฉพาะเมื่อคนยืนยัน (D5) — ระหว่างรอแสดงป้าย "รอยืนยัน" และเลือกใช้ในเอกสารได้เฉพาะเอกสารร่าง |
| MD-015 | การค้นหาใน dropdown ทุกตัว: พิมพ์รหัส ชื่อ (ไทย/อังกฤษ) เลขผู้เสียภาษี หรือเบอร์โทร; แสดงสูงสุด 20 รายการ + "สร้างใหม่" (ถ้ามีสิทธิ์) |

### 0.2 Drawer ข้อมูลหลัก (ใช้โครง 00-overview §6)

| ส่วน | ข้อกำหนด |
|---|---|
| หัว 3 บรรทัด | ประเภท ("ลูกค้า") / รหัส + ชื่อ + ป้ายสถานะ / ข้อมูลระบุตัว (เลขผู้เสียภาษี + สาขา หรือ จังหวัด) |
| เมนู ⋯ | แก้ไข · คัดลอกเป็นรายการใหม่ · ปิดใช้/เปิดใช้ · ลบ (ถ้าไม่เคยถูกอ้างอิง) · ดู audit |
| แท็บ | ตามแต่ละ entity (ระบุในแต่ละ §) + "กิจกรรม" เสมอ |
| Footer | ปุ่มหลักตามบริบท (เช่น "สร้าง SO" ในลูกค้า) |

---

## 1. ลูกค้า (Customer)

**1. จุดประสงค์** — เก็บผู้ว่าจ้าง (ผู้ส่งสินค้า) พร้อมข้อมูลภาษี เงื่อนไขวางบิล การแจ้งเตือน และการเชื่อม API ของลูกค้า ใช้เป็นต้นทางของ SO, rate card และใบแจ้งหนี้

**2. ผู้ใช้/สิทธิ์** — สร้าง/แก้: admin, manager, accounting (เฉพาะแท็บบัญชี), dispatcher (ถ้าได้รับสิทธิ์ `customer.create`) · ดู: ทุก role ภายใน · แท็บ API: admin/developer · shipper ไม่เข้าหน้านี้

**3. หน้าจอ**
- รายการ: แถบสรุป (ใช้งาน N · ปิดใช้ N · เกินวงเงิน N · ไม่มีเลขผู้เสียภาษี N) · ตาราง: รหัส, ชื่อ, เลขผู้เสียภาษี/สาขา, เครดิตเทอม, รอบวางบิล, VAT ค่าขนส่ง/บริการ, ยอดค้างชำระ, SO เดือนนี้, สถานะ
- ฟอร์มสร้าง: ขั้นเดียว แบ่ง section; ปุ่ม "ค้นหา" ข้างเลขผู้เสียภาษี เติมชื่อ/ที่อยู่จากแหล่งข้อมูลนิติบุคคล (ใช้บริการเดียวกับการสมัคร — 01-platform) แก้ได้และแสดงแหล่งที่มา
- Drawer แท็บ: **สรุป** (ข้อมูลทั่วไป, ภาษี, การวางบิล, ข้อมูลเพิ่มเติม) · **ผู้ติดต่อ** · **การแจ้งเตือน** · **สถานที่** (สถานที่ที่ผูกกับลูกค้า) · **ราคา** (rate card ที่ใช้อยู่ + ค่าบริการเสริมเฉพาะลูกค้า) · **การเชื่อมต่อ API** (P1, แสดงเมื่อแพ็กเกจมี Open API) · **รหัสระบบบัญชี** (แสดงเฉพาะเมื่อมี connector — D2) · **กิจกรรม**
- Footer: "สร้าง SO" · "ดูลูกหนี้"

**4. ฟิลด์**

| กลุ่ม | ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|---|
| ทั่วไป | `code` | string(20) | ✓ | MD-002, ค่าเสนอ `CUS-0001` | |
| | `partyType` | enum `juristic`/`individual`/`foreign` | ✓ | | ต่างประเทศไม่บังคับเลขผู้เสียภาษีไทย |
| | `legalName` | string(200) | ✓ | | ชื่อตามจดทะเบียน ใช้พิมพ์บนเอกสารภาษี |
| | `displayName` | string(100) 3 ภาษา | – | | ชื่อเรียกสั้นบนกระดาน/การ์ด เช่น "ไทยสตีล" |
| | `taxId` | char(13) | ✓ ถ้า juristic | ตัวเลข 13 หลัก + check digit (mod 11) — ผิด check digit = เตือน ไม่บล็อก [PROPOSED] | บุคคลธรรมดาใช้เลขบัตรประชาชน (PDPA: ปิดบังบางหลักสำหรับผู้ไม่มีสิทธิ์บัญชี) |
| | `branchType` | enum `head_office`/`branch` | ✓ ถ้ามี taxId | | |
| | `branchCode` | char(5) | ✓ | `^\d{5}$`; head_office = `00000` | [FACT] ภ.พ.20, ประกาศฯ ฉบับ 39 ข้อ 9 |
| | `billingAddress` | address (MD-009) | ✓ | | ที่อยู่สำหรับเอกสารภาษี |
| | `defaultPickupLocationId` | ref Location | – | | เติมจุดรับใน SO ใหม่ |
| | `salesOwnerUserId` | ref User | – | | |
| | `status` | enum active/inactive | ✓ | MD-003 | |
| การวางบิล | `billingCycle` | enum `per_job`/`weekly`/`semi_monthly`/`monthly` | ✓ | default `monthly` | |
| | `billingDay` | int / list | เงื่อนไข | weekly 1–7; semi_monthly 2 วัน; monthly 1–31 หรือ "สิ้นเดือน" | ใช้สร้างรายการ "ถึงรอบวางบิล" ใน 05 |
| | `billingBasis` | enum `per_do`/`per_trip`/`per_so` | ✓ | default `per_do` | หน่วยบรรทัดในใบแจ้งหนี้ |
| | `requirePodBeforeBilling` | bool | ✓ | default true | DO ที่ POD ยังไม่ผ่าน ติ๊กวางบิลไม่ได้ |
| | `creditTermDays` | int | ✓ | 0–180, default 30 | วันครบกำหนด = วันที่ใบแจ้งหนี้ + N |
| | `creditLimit` | decimal(14,2) | – | ≥ 0 | MD-027 |
| | `documentSet` | enum | ✓ | `invoice_receipt` / `billing_note_invoice_receipt` / `tax_invoice_on_payment` | ชุดเอกสารที่ออก (05-billing) |
| | `billingEmail` / `billingContactId` | | – | | ส่งใบวางบิล |
| ภาษี | `freightVatTreatment` | enum `exempt` / `vat7_bundled` | ✓ | default `exempt` | [FACT] ขนส่งในประเทศยกเว้น VAT ม.81(1)(ณ); `vat7_bundled` = ลูกค้าขอให้คิด VAT รวม → [OPEN-MD-1] |
| | `serviceVatTreatment` | enum `vat7` / `exempt` | ✓ | default `vat7` | [FACT] บริการประกอบ (ยกขน ฯลฯ) เสีย VAT 7%; `exempt` ใช้เมื่อ tenant ไม่ได้จด VAT (บังคับตามการตั้งค่าบริษัท) |
| | `priceIncludesVat` | bool | ✓ | default false | ราคาใน rate card รวม VAT แล้วหรือไม่ |
| | `taxDocumentSplit` | enum `single_doc_separate_lines` / `separate_docs` | ✓ | default `single_doc_separate_lines` | [OPEN-MD-2] นักบัญชีเลือก |
| | `withholdsTax` | bool | ✓ | default true ถ้า juristic, false ถ้า individual | ลูกค้าหัก ณ ที่จ่ายเราหรือไม่ |
| | `whtRateFreight` | decimal(5,2) | เงื่อนไข | default 1.00 | [FACT] ท.ป.4/2528 ข้อ 12/4 |
| | `whtRateService` | decimal(5,2) | เงื่อนไข | default 3.00 | [FACT] ข้อ 12/1 |
| ปฏิบัติการ | `podRequirements` | object | – | photo/signature/receiverName/actualQty/paperDo: `off`/`optional`/`required` แยกกรณีสำเร็จ/ไม่สำเร็จ | ส่งให้แอปคนขับ (04-execution, E2) |
| | `freeWaitingHours` | decimal(4,2) | – | 0–24 | override ค่าใน accessorial (MD-157) |
| | `defaultVehicleTypeId` | ref VehicleType | – | | |
| | `customerRefRequired` | bool | – | | บังคับเลข PO ลูกค้าใน SO |
| | `notes` | text | – | | |

**ผู้ติดต่อ (CustomerContact)**

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ |
|---|---|---|---|
| `name` | string(100) | ✓ | |
| `roles` | multi enum `ordering`/`billing`/`receiving`/`accounting`/`other` | ✓ | อย่างน้อย 1 |
| `phone` | E.164 | เงื่อนไข | ต้องมีโทรหรืออีเมลอย่างน้อย 1 |
| `email` | email | เงื่อนไข | |
| `lineUserId` | string | – | ได้จากการผูก LINE OA (กล่องรับงาน 03 §1) ไม่ให้พิมพ์เอง |
| `isPrimary` | bool | – | primary ได้ 1 คนต่อ role |
| `preferredLanguage` | enum th/en/zh | – | ภาษาข้อความแจ้งเตือน |

**การแจ้งเตือน (CustomerNotificationPref)** — ตารางเหตุการณ์ × ช่องทาง × ผู้รับ

| เหตุการณ์ | ค่าเริ่มต้น | ช่องทางที่เลือกได้ | ผู้รับ |
|---|---|---|---|
| รับงานแล้ว (SO ยืนยัน) | ปิด | อีเมล, LINE | ผู้ติดต่อ role ordering |
| รถออกจากจุดรับ | เปิด | SMS, LINE, อีเมล | ผู้ติดต่อ + ผู้รับที่จุดส่ง (contact ของ Location) |
| ใกล้ถึง (ETA ≤ 30 นาที — ปรับ 10–120) | เปิด | SMS, LINE | ผู้รับที่จุดส่ง |
| ส่งแล้ว + ลิงก์ติดตาม/POD | เปิด | SMS, LINE, อีเมล | ผู้ติดต่อ + ผู้รับ |
| ส่งไม่สำเร็จ | เปิด | LINE, อีเมล | ผู้ติดต่อ ordering |
| ออกใบแจ้งหนี้/ใบวางบิล | เปิด | อีเมล | ผู้ติดต่อ billing |

**5. กฎธุรกิจ**

| รหัส | กฎ |
|---|---|
| MD-020 | Unique `(tenantId, taxId, branchCode)` เมื่อ taxId ไม่ว่าง — ซ้ำ → error "ลูกค้านี้มีแล้ว: {code} {name}" + ลิงก์ |
| MD-021 | ลูกค้า juristic ที่ไม่มี taxId บันทึกได้แต่ออกใบกำกับภาษีเต็มรูปไม่ได้ (05 บล็อก) — แสดงป้าย "ไม่มีเลขผู้เสียภาษี" |
| MD-022 | `freightVatTreatment` และ `serviceVatTreatment` ถูกคัดลอกเป็น snapshot ลงแต่ละบรรทัดราคาใน SO ตอนสร้างราคา (03 ORD-045) |
| MD-023 | ถ้าบริษัท (tenant) ไม่ได้จด VAT (ตั้งค่าบริษัท, 01-platform) → ทุกบรรทัด `vatTreatment = none` บังคับ และซ่อนตัวเลือก VAT ในหน้านี้ |
| MD-024 | WHT ที่ลูกค้าคาดว่าจะหัก คำนวณต่อบรรทัด: freight × `whtRateFreight`, service × `whtRateService` เฉพาะเมื่อ `withholdsTax` และยอดตามสัญญา ≥ 1,000.00 บาท [FACT ข้อ 12/5] — ใช้แสดง "ยอดรับสุทธิโดยประมาณ" และกระทบยอดรับชำระ (05) |
| MD-025 | แก้เงื่อนไขภาษี/เครดิตเทอม มีผลกับ SO ที่สร้างหลังบันทึกเท่านั้น; ระบบถามว่า "ใช้กับ SO ร่างที่ยังไม่ยืนยัน N ใบด้วยหรือไม่" |
| MD-026 | ปิดใช้ลูกค้าที่มี SO ยังไม่ปิด → อนุญาต แต่เตือนจำนวนงานค้าง; สร้าง SO ใหม่ไม่ได้ |
| MD-027 | วงเงินเครดิต: ยอดค้าง (ใบแจ้งหนี้ออกแล้วยังไม่ชำระ + SO ยืนยันที่ยังไม่วางบิล) > `creditLimit` → SO ใหม่สร้างได้แต่ยืนยันต้องให้ manager อนุมัติ [PROPOSED]; `creditHold = true` (manager ตั้ง) → ยืนยัน SO ไม่ได้ |
| MD-028 | แท็บ "การเชื่อมต่อ API": สร้าง shipper API key ผูกลูกค้ารายนี้ scope จำกัด `orders:write` + `orders:read` + `tracking:read` + `pod:read` เฉพาะข้อมูลที่ `customerId` = ลูกค้านี้ (บังคับที่ query layer) ; แสดง secret ครั้งเดียว; หมุน/เพิกถอนได้; ผูก field mapping profile ได้ (07) |
| MD-029 | SO ที่สร้างผ่าน shipper key เข้าเป็น `draft` เสมอ และขึ้นในกล่องรับงานแหล่ง "API" (03 ORD-003) เว้นแต่ลูกค้าเปิด `autoConfirmApiOrders` (manager เท่านั้น) [PROPOSED] |
| MD-030 | การผูก LINE OA: ผู้ติดต่อพิมพ์รหัสผูก 6 หลักที่ออกจากแท็บผู้ติดต่อ (อายุ 24 ชม.) ในแชต LINE OA → ระบบจับคู่ `lineUserId` ให้ ใช้จับคู่ลูกค้าในกล่องรับงาน |
| MD-031 | แท็บ "รหัสระบบบัญชี" มี 1 แถวต่อ connector ที่เปิด: รหัสลูกค้าในระบบนั้น + สถานะซิงก์ (D3) — ไม่แสดงเมื่อไม่มี connector |
| MD-032 | รวมลูกค้าซ้ำ (merge): admin เลือกตัวหลัก → ย้าย SO/DO/ใบแจ้งหนี้/สถานที่/rate card ไปตัวหลัก ตัวรองเป็น inactive + ป้าย "รวมเข้ากับ {code}" [P1] |

**6. สถานะ** — `active` ⇄ `inactive` (admin/manager, ต้องใส่เหตุผลเมื่อปิดใช้) · `deleted` (MD-004) · flag แยก `creditHold`

| จาก → ไป | เงื่อนไข | ใคร | ผลข้างเคียง |
|---|---|---|---|
| active → inactive | เหตุผล ≥ 10 ตัวอักษร | admin/manager | shipper API key ของลูกค้าถูกระงับ; ไม่ส่งแจ้งเตือนใหม่ |
| inactive → active | – | admin/manager | key ที่ระงับกลับมาใช้ได้ (ยกเว้นที่เพิกถอน) |

**7. Event** — `customer.created`, `customer.updated` (มี `changedFields`), `customer.deactivated`, `customer.reactivated`, `customer.credit_hold_changed`, `customer.api_key_created/revoked` (audit)

**8. กรณีผิดปกติ**
- ค้นเลขผู้เสียภาษีไม่พบ/บริการภายนอกล่ม → กรอกเองได้ แสดง "ยังไม่ได้ตรวจ"
- เลขเดียวกันแต่สาขาต่าง → สร้างได้ (เป็นลูกค้าคนละราย) แต่แสดงลิงก์ "สาขาอื่นของนิติบุคคลนี้"
- ปิดใช้ลูกค้าที่มี rate card active → rate card คงสถานะ แต่ไม่ถูกเลือกในการคำนวณ
- import ลูกค้าที่ taxId ซ้ำในไฟล์เดียวกัน → แถวหลังเป็น error (MD-283)

**9. เกณฑ์ตรวจรับ**
- Given ลูกค้า `freightVatTreatment=exempt`, `serviceVatTreatment=vat7` When สร้าง SO ค่าขนส่ง 8,000 + ค่าลงสินค้า 500 Then ยอดก่อน VAT ยกเว้น 8,000.00, ฐาน VAT 500.00, VAT 35.00, รวม 8,535.00
- Given มีลูกค้า taxId 0105551234567 สาขา 00000 When สร้างอีกรายเลข+สาขาเดียวกัน Then บันทึกไม่ได้ พร้อมลิงก์รายการเดิม
- Given shipper key ของลูกค้า A When เรียก `GET /orders` Then เห็นเฉพาะ SO ของลูกค้า A
- Given ผู้ใช้ไม่มี `price.sell.view` When เปิดแท็บราคา Then ราคาแสดง "—" และ export ไม่มีคอลัมน์ราคา

**10. เฟส** — P0: ทั้งหมดยกเว้น MD-028/029 (P1, ขึ้นกับแพ็กเกจ Open API), MD-032 (P1)

---

## 2. สถานที่ / สมุดที่อยู่ (Location)

**1. จุดประสงค์** — จุดรับ-ส่งที่ใช้ซ้ำ มีพิกัดและ geofence สำหรับปุ่มถึง/ออกจากจุดในแอปคนขับ เวลาทำการและข้อจำกัดรถสำหรับวางแผน — SO เลือกจุดจากที่นี่ [DECISION รอบ 11–12]

**2. ผู้ใช้/สิทธิ์** — สร้าง/แก้: dispatcher, manager, admin · AI/MCP/API สร้างได้เป็น "รอยืนยัน" (MD-014)

**3. หน้าจอ**
- รายการ: แถบสรุป (ทั้งหมด · ไม่มีพิกัด · ใช้บ่อย 30 วัน) · สลับมุมมอง ตาราง / แผนที่ (หมุดทุกจุด + วง geofence)
- ฟอร์ม: ซ้ายฟิลด์, ขวาแผนที่ปักหมุด (ลากหมุดได้; ค้นจากที่อยู่ → geocode; วางพิกัดจาก Google Maps link หรือ "lat,lng") + วงรัศมี geofence ปรับด้วย slider
- Drawer แท็บ: สรุป · ผู้ติดต่อ · เวลาทำการ · ประวัติ (SO/DO ที่ผ่านจุดนี้, เวลารอเฉลี่ย, ส่วนต่างพิกัดที่คนขับกดจริง) · กิจกรรม

**4. ฟิลด์**

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| `code` | string(20) | ✓ | MD-002, ค่าเสนอ `LOC-00001` | |
| `name` | string(150) 3 ภาษา | ✓ | | เช่น "คลังสินค้าอยุธยา (วังน้อย)" |
| `type` | enum `warehouse`/`factory`/`shop`/`port`/`container_yard`/`construction_site`/`depot`/`other` | ✓ | | `depot` = ลานจอดของ tenant เอง |
| `customerId` | ref Customer | – | | ว่าง = ใช้ร่วมทุกลูกค้า; มีค่า = แสดงก่อนเมื่อสร้าง SO ของลูกค้านั้น |
| `address` | address | ✓ | MD-009 | |
| `lat`, `lng` | decimal(9,6) | ✓ สำหรับใช้ใน SO ยืนยัน | อยู่ในกรอบประเทศไทย+เพื่อนบ้าน (lat 5–21, lng 97–106) เตือนถ้านอกกรอบ | |
| `geofenceRadiusM` | int | ✓ | 50–2,000, default 200 | |
| `openingHours` | array {dayOfWeek, open, close, breakStart?, breakEnd?} | – | open < close; ข้ามเที่ยงคืนได้ (`close` < `open` = วันถัดไป) | ว่าง = 24 ชม. |
| `closedDates` | date[] | – | | วันหยุดเฉพาะจุด |
| `defaultServiceMinutes` | int | – | 0–720, default 60 | เวลาขึ้น/ลงของโดยประมาณ ใช้วางความยาวการ์ดบนกระดาน |
| `appointmentRequired` | bool | – | | ต้องนัดคิวล่วงหน้า → SO บังคับใส่เลขนัด (stop.appointmentRef) |
| `maxVehicleTypeRank` | int (อ้าง VehicleType.sizeRank) | – | | รถใหญ่กว่านี้เข้าไม่ได้ (PLN block rule) |
| `maxHeightM`, `maxGrossWeightKg` | decimal | – | > 0 | สะพาน/ประตู |
| `restrictedWindows` | array {days, start, end, vehicleTypeRankMin} | – | | ช่วงห้ามรถใหญ่เข้า (ตั้งเองต่อจุด ไม่ hard-code กฎเมือง) |
| `dockCount` | int | – | ≥ 0 | |
| `driverInstructions` | text(1,000) 3 ภาษา | – | | แสดงในแอปคนขับ |
| `contacts` | array {name, phone, email, role} | – | MD-009 | ผู้รับของ — ใช้ส่ง SMS/LINE แจ้งลูกค้าปลายทาง |
| `status` | active/inactive | ✓ | | |

**5. กฎธุรกิจ**

| รหัส | กฎ |
|---|---|
| MD-050 | ตรวจซ้ำตอนสร้าง: มีสถานที่ active ห่าง ≤ 50 ม. หรือชื่อ+รหัสไปรษณีย์ตรงกัน → เตือน "อาจซ้ำกับ {code}" ให้เลือกใช้ของเดิมหรือสร้างต่อ |
| MD-051 | สถานที่ไม่มีพิกัด ใช้ใน SO ร่างได้ แต่ยืนยัน SO ไม่ได้จนกว่าจะปักหมุด (เพราะ geofence/ETA ใช้ไม่ได้) [PROPOSED] |
| MD-052 | SO stop เก็บ snapshot: ชื่อ ที่อยู่ พิกัด รัศมี ผู้ติดต่อ — แก้สถานที่หลัง SO ยืนยันแล้ว ระบบถาม "อัปเดตงานที่ยังไม่ออกวิ่ง N งานด้วยหรือไม่" (default ไม่) |
| MD-053 | ช่วงเวลาในจุดของ SO ที่อยู่นอก `openingHours`/ตรง `closedDates` → เตือนสีส้ม ไม่บล็อก |
| MD-054 | `maxVehicleTypeRank`, `maxHeightM`, `maxGrossWeightKg`, `restrictedWindows` ถูกใช้เป็นกฎตรวจตอนจัดรถ (03 PLN-085) |
| MD-055 | พิกัดจริงที่คนขับกด "ถึงจุด" ห่างจากหมุด > รัศมี ≥ 3 ครั้งใน 30 วัน → แนะนำ "ปรับหมุด" ในแท็บประวัติ (ต้องคนยืนยัน) [P1] |
| MD-056 | สถานที่ `type=depot` ใช้เป็นจุดเริ่ม/จบเที่ยวเริ่มต้นของรถ (06 vehicle.homeDepotId) |

**6. สถานะ** — active/inactive/รอยืนยัน (pending_review จาก AI/API) → ตามหลัก MD-003, MD-014

**7. Event** — `location.created`, `location.updated`, `location.deactivated`

**8. กรณีผิดปกติ** — geocode ไม่พบ → ให้ปักหมุดเอง · แผนที่โหลดไม่ได้ → กรอก lat,lng ได้ · พิกัดสลับ lat/lng (ค่าอยู่นอกไทย) → เตือน "พิกัดอาจสลับกัน" + ปุ่มสลับ

**9. เกณฑ์ตรวจรับ**
- Given สถานที่ A (14.2350, 100.5810) When สร้าง B ห่าง 30 ม. Then เตือนอาจซ้ำกับ A
- Given สถานที่ `maxVehicleTypeRank` = 6 ล้อ When ลาก DO ที่ส่งจุดนี้ไปรถพ่วง Then วางไม่ได้ เหตุผล "จุดส่งรับรถไม่เกิน 6 ล้อ"
- Given SO ร่างใช้สถานที่ไม่มีพิกัด When กดยืนยัน Then ยืนยันไม่ได้ ข้อความ "ปักหมุดสถานที่ {ชื่อ} ก่อน"

**10. เฟส** — P0 (MD-055 = P1)

---

## 3. สินค้าและหน่วย (Product, Unit)

**1. จุดประสงค์** — มาตรฐานรายการสินค้าใน SO/DO เพื่อคำนวณน้ำหนัก/ปริมาตรเทียบความจุรถ และส่งต่อข้อกำหนดพิเศษ (อันตราย/ควบคุมอุณหภูมิ) ไปยังกฎจ่ายงาน

**2. ผู้ใช้/สิทธิ์** — dispatcher, manager, admin

**3. หน้าจอ** — แท็บ "สินค้า" และ "หน่วย" ในหน้าเดียว · Drawer สินค้า: สรุป · หน่วยแปลง · กิจกรรม

**4. ฟิลด์ — หน่วย (Unit)**

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| `code` | string(10) | ✓ | unique | เช่น `BAG`, `PLT`, `PCS`, `TON`, `KG`, `CBM`, `BOX`, `CTN`, `L` |
| `name` | 3 ภาษา | ✓ | | ถุง, พาเลท, ชิ้น, ตัน, กก., ลบ.ม. (คิว), กล่อง, ตู้, ลิตร |
| `kind` | enum `count`/`weight`/`volume` | ✓ | | |
| `toKg` / `toCbm` | decimal | เงื่อนไข | weight → `toKg` บังคับ (ตัน = 1000); volume → `toCbm` | |

ชุดเริ่มต้นสร้างให้ทุก tenant ใหม่ (ถุง พาเลท ชิ้น กล่อง ตู้ ตัน กก. ลบ.ม. ลิตร) ลบไม่ได้ ปิดใช้ได้

**ฟิลด์ — สินค้า (Product)**

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| `code` | string(30) | ✓ | MD-002 | รหัสสินค้าของลูกค้าใช้ได้ |
| `name` | 3 ภาษา | ✓ | | "ปูนซีเมนต์ถุง 50 กก." |
| `customerId` | ref | – | | สินค้าของลูกค้ารายเดียว |
| `baseUnitId` | ref Unit | ✓ | | |
| `weightPerBaseUnitKg` | decimal(12,3) | ✓ ถ้าหน่วยเป็น count | > 0 | |
| `volumePerBaseUnitCbm` | decimal(12,4) | – | ≥ 0 | หรือกรอก กว้าง×ยาว×สูง (ซม.) ให้คำนวณ |
| `altUnits` | array {unitId, factorToBase} | – | factor > 0; ห้ามหน่วยซ้ำ | 1 พาเลท = 40 ถุง |
| `fragile` | bool | – | | แสดงไอคอนบนการ์ด/ใบส่งของ |
| `hazardous` | bool | – | | |
| `unNumber`, `hazardClass` | string | ✓ ถ้า hazardous | UN `^\d{4}$`; class 1–9 | |
| `tempControlled` | bool | – | | |
| `tempMinC`, `tempMaxC` | decimal | ✓ ถ้า tempControlled | min < max, −40…+30 | |
| `stackable` | bool | – | default true | |
| `barcode` | string | – | | ใช้สแกนตอนขึ้น/ลงของ (M12) |
| `status` | active/inactive | ✓ | | |

**5. กฎธุรกิจ**

| รหัส | กฎ |
|---|---|
| MD-070 | รายการสินค้าใน SO คำนวณ `weightKg = qty × factorToBase × weightPerBaseUnitKg` และ `volumeCbm` ในทำนองเดียวกัน; ผู้ใช้แก้น้ำหนักรวมเองได้ (เก็บทั้งค่าคำนวณและค่าที่แก้) |
| MD-071 | SO ที่มีสินค้า `hazardous` → ต้องใช้ประเภทรถที่ `hazmatAllowed` และคนขับใบขับขี่ ท.4 (PLN-084) [FACT ประเภทใบขับขี่ — ดู OPEN-MD-4] |
| MD-072 | SO ที่มีสินค้า `tempControlled` → ต้องใช้ประเภทรถ `refrigerated` ที่ช่วงอุณหภูมิครอบคลุม (min ของรถ ≤ tempMin ของสินค้า และ max ≥ tempMax) |
| MD-073 | SO ที่มีสินค้าที่ช่วงอุณหภูมิไม่ทับกัน → เตือน "สินค้าอุณหภูมิต่างกัน แยก SO หรือแยกเที่ยว" |
| MD-074 | ไม่บังคับใช้ข้อมูลหลักสินค้า: SO ใส่รายการแบบข้อความอิสระได้ (ชื่อ + หน่วย + น้ำหนักรวม) เพื่อให้รับงานเร็ว [DECISION — ผู้ใช้ไทยจำนวนมากไม่มี master สินค้า] |

**6. สถานะ** — active/inactive

**7. Event** — `product.created`, `product.updated` (audit; webhook P2)

**8. กรณีผิดปกติ** — เปลี่ยน `weightPerBaseUnitKg` → ไม่กระทบ SO เดิม (snapshot) · ลบหน่วยที่ถูกใช้ → ปิดใช้แทน

**9. เกณฑ์ตรวจรับ**
- Given ปูน 1 ถุง = 50 กก., 1 พาเลท = 40 ถุง When ใส่ 12 พาเลท Then น้ำหนัก 24,000.000 กก.
- Given สินค้า hazardous When เลือกคนขับใบขับขี่ ท.2 Then popover คนขับแสดงคนนี้เป็นสีเทา "ต้องใบขับขี่ ท.4"

**10. เฟส** — P0

---

## 4. ประเภทรถ (Vehicle Type)

**1. จุดประสงค์** — นิยามประเภทรถมาตรฐานที่ใช้ร่วมกันใน rate card, SO (ประเภทรถที่ต้องการ), ทะเบียนรถ (06) และกฎจ่ายงาน (ความจุ, ใบขับขี่, ข้อจำกัดสถานที่)

**2. ผู้ใช้/สิทธิ์** — แก้: manager, admin · อ่าน: ทุก role

**3. หน้าจอ** — ตาราง: รหัส, ชื่อ, หมวด, ขนาด (rank), น้ำหนักบรรทุก, ปริมาตร, พาเลท, ใบขับขี่ขั้นต่ำ, ห้องเย็น, จำนวนรถในทะเบียน · Drawer: สรุป · รถในประเภทนี้ · rate card ที่ใช้ · กิจกรรม

**4. ฟิลด์**

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| `code` | string(20) | ✓ | MD-002 | `4W`, `6W`, `10W`, `TRL` |
| `name` | 3 ภาษา | ✓ | | "10 ล้อ ตู้ทึบ" |
| `category` | enum `pickup_4w`/`truck_6w`/`truck_10w`/`truck_12w`/`full_trailer` (พ่วง)/`tractor` (หัวลาก)/`semi_trailer` (หางเทรลเลอร์)/`tractor_semi` (หัวลาก+หาง) | ✓ | | |
| `bodyType` | enum `cargo_box`/`open_stake` (คอก)/`flatbed` (พื้นเรียบ)/`refrigerated` (ห้องเย็น)/`tanker`/`container_chassis`/`dump`/`other` | ✓ | | |
| `sizeRank` | int 1–10 | ✓ | | ใช้เทียบข้อจำกัดสถานที่ (4 ล้อ=1, 6 ล้อ=3, 10 ล้อ=5, พ่วง/เทรลเลอร์=8 เป็นค่าเริ่มต้น) |
| `payloadKg` | int | ✓ | > 0 | น้ำหนักบรรทุกมาตรฐาน; รถรายคันใน 06 override ได้ |
| `volumeCbm` | decimal(8,2) | – | ≥ 0 | |
| `palletCapacity` | int | – | ≥ 0 | |
| `innerDimensionsCm` | {l,w,h} | – | | |
| `minLicenceClass` | enum `personal`/`T1`/`T2`/`T3`/`T4` | ✓ | | ท.1–ท.4 ตาม OPEN-MD-4 |
| `requiresTrailer` | bool | – | | หัวลาก: ต้องผูกหางในเที่ยว |
| `isTrailer` | bool | – | | ประเภทของหาง (ไม่มีเครื่องยนต์ ไม่ต้องมีคนขับ) |
| `refrigerated` | bool | – | | |
| `tempMinC`, `tempMaxC` | decimal | ✓ ถ้า refrigerated | min < max | |
| `hazmatAllowed` | bool | – | default false | |
| `costPerKmDefault` | decimal(10,2) | – | ≥ 0 | ใช้ใน "เสนอรถ" ถ้ายังไม่มีต้นทุนจริงจาก 06 |
| `status` | active/inactive | ✓ | | |

ชุดเริ่มต้นสำหรับ tenant ใหม่ [PROPOSED — ตัวเลขเป็นค่าตั้งต้นแก้ได้]:

| รหัส | ชื่อ | payloadKg | ใบขับขี่ขั้นต่ำ |
|---|---|---|---|
| 4W | 4 ล้อ กระบะตู้ทึบ | 1,500 | personal [OPEN-MD-4] |
| 6W | 6 ล้อ | 6,000 | T2 |
| 10W | 10 ล้อ | 15,000 | T2 |
| TRL | พ่วง (10 ล้อ + หางพ่วง) | 30,000 | T3 |
| TRC | หัวลาก + หางเทรลเลอร์ | 30,000 | T3 |
| REF6 | 6 ล้อ ห้องเย็น (0…+8 °C) | 5,000 | T2 |

**5. กฎธุรกิจ**

| รหัส | กฎ |
|---|---|
| MD-090 | ลำดับใบขับขี่ใช้เทียบแบบ "สูงกว่าใช้แทนต่ำกว่าได้": personal < T1 < T2 < T3 < T4 [PROPOSED → OPEN-MD-4]; คนขับผ่านเมื่อ `driver.licenceClass ≥ vehicleType.minLicenceClass` และใบขับขี่ยังไม่หมดอายุ ณ วันวิ่ง |
| MD-091 | ความจุที่ใช้ตรวจตอนจัดรถ = `vehicle.payloadKg` (06) ถ้ามี มิฉะนั้น `vehicleType.payloadKg`; หัวลาก+หาง = payload ของหางที่ผูกในเที่ยว |
| MD-092 | เปลี่ยน `payloadKg`/`minLicenceClass` ของประเภทรถ → ตรวจเที่ยวสถานะ planned/dispatched ใหม่ทันที; เที่ยวที่ไม่ผ่านแสดง "ต้องย้ายรถ" บนกระดาน (PLN-093) |
| MD-093 | ประเภทรถใน SO เป็นค่า "ต้องการ" — จัดรถประเภทอื่นได้ถ้า `sizeRank` ≥ ที่ขอ และไม่ติดข้อจำกัดสถานที่ แต่แสดงป้าย "ใช้รถใหญ่กว่า" และราคาขายยังตามประเภทที่ขอ |
| MD-094 | ปิดใช้ประเภทรถที่ยังมีรถ active ในทะเบียนไม่ได้ |

**6. สถานะ** — active/inactive · **7. Event** — `vehicle_type.updated` (audit; ทำให้ re-validate แผน) · **8. กรณีผิดปกติ** — ลดความจุจนเที่ยวที่วางแล้วเกิน → MD-092 · **9. เกณฑ์ตรวจรับ** — Given ประเภท TRL `minLicenceClass=T3` When เลือกคนขับใบ T2 Then เลือกไม่ได้ เหตุผล "ใบขับขี่ ท.2 ไม่พอสำหรับพ่วง (ต้อง ท.3)" · **10. เฟส** — P0

---

## 5. Rate card (ราคาขาย/ราคาซื้อ) และ fuel surcharge

**1. จุดประสงค์** — ตารางราคาที่ระบบใช้เติมราคา SO อัตโนมัติ (ฝั่งขาย) และเสนอค่าจ้างรถร่วม (ฝั่งซื้อ) โดยมีวันมีผล เวอร์ชัน และการอนุมัติ; ราคาที่ใช้ถูก snapshot ลง SO (M3, M4, M5)

**2. ผู้ใช้/สิทธิ์** — สร้าง/แก้ร่าง: manager, sales (role กำหนดเอง) ที่มี `price.sell.edit` / `price.buy.edit` · อนุมัติ: manager/approver (`ratecard.approve`) · ดู: ตาม MD-012

**3. หน้าจอ**
- รายการ: แถบสรุป (ใช้งาน · ร่าง · รออนุมัติ · หมดอายุใน 30 วัน) · แท็บ ขาย / ซื้อ · ตาราง: รหัส, ชื่อ, ฝั่ง, ลูกค้า/รถร่วม (หรือ "ราคามาตรฐาน"), เวอร์ชัน, มีผล–หมดอายุ, จำนวนเส้นทาง, สถานะ
- ตัวแก้ rate card: หัว + ตารางเส้นทางแบบ grid แก้ในแถว (ต้นทาง, ปลายทาง, ประเภทรถ, วิธีคิด, ราคา, ขั้นต่ำ, ระยะทาง, ค่าจุดเพิ่ม, FSC) + ปุ่มนำเข้า Excel/ส่งออก + แท็บ "ค่าบริการเสริมเฉพาะ" + แท็บ "เปรียบเทียบเวอร์ชัน" (diff ไฮไลต์ราคาที่เปลี่ยน %)
- Popover "เปลี่ยนเรท" ใน SO (03 ORD-046) ค้นหาจาก rate card ที่มีผล
- หน้า Fuel surcharge: ตารางช่วงราคาน้ำมัน → % + ประวัติราคาน้ำมันอ้างอิงรายสัปดาห์

**4. ฟิลด์ — RateCard (หัว)**

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| `code` | string(20) | ✓ | | `RC-S-0001` (ขาย) / `RC-B-0001` (ซื้อ) |
| `name` | string(150) | ✓ | | |
| `side` | enum `sell`/`buy` | ✓ | | |
| `customerId` | ref | – | เฉพาะ sell | ว่าง = ราคามาตรฐาน (ใช้เมื่อไม่มีของลูกค้า) |
| `subcontractorId` | ref | – | เฉพาะ buy | ว่าง = ราคาซื้อมาตรฐาน |
| `version` | int | auto | | เริ่ม 1 |
| `parentRateCardId` | ref | auto | | ชี้เวอร์ชันก่อนหน้า |
| `validFrom` | date | ✓ | | |
| `validTo` | date | – | ≥ validFrom | ว่าง = ไม่มีวันหมด |
| `priceIncludesVat` | bool | ✓ | default ตามลูกค้า | |
| `fuelSurchargeTableId` | ref | – | | ว่าง = ไม่คิด FSC |
| `status` | enum (ข้อ 6) | ✓ | | |
| `approvedBy/At`, `notes`, `attachments` (สัญญา/ใบเสนอราคา PDF) | | – | | |

**ฟิลด์ — RateCardLine (เส้นทาง)**

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| `originType` | enum `location`/`district`/`province`/`zone`/`any` | ✓ | | |
| `originRef` | ref/รหัสพื้นที่ | ✓ ยกเว้น any | | อำเภอ/จังหวัดใช้รหัสกรมการปกครอง |
| `destinationType`, `destinationRef` | เหมือนต้นทาง | ✓ | | |
| `vehicleTypeId` | ref | ✓ | | |
| `pricingMethod` | enum `flat_trip` (เหมาเที่ยว) / `per_km` / `per_ton` / `per_cbm` / `per_day` (เหมาวัน) / `per_unit` | ✓ | | M4 |
| `rate` | decimal(12,2) | ✓ | ≥ 0 | บาทต่อหน่วยของวิธีคิด |
| `unitId` | ref Unit | เงื่อนไข | `per_unit` บังคับ | เช่น บาท/พาเลท |
| `minCharge` | decimal(12,2) | – | ≥ 0 | |
| `distanceKm` | decimal(8,1) | ✓ ถ้า per_km | > 0 | ระยะอ้างอิงที่ตกลง (ไม่ใช้ GPS จริงในการคิดเงิน เว้นตั้ง `useActualDistance`) |
| `includedStops` | int | – | default 2 (รับ 1 + ส่ง 1) | |
| `extraStopRate` | decimal(12,2) | – | ≥ 0 | เกิน N จุดคิดเพิ่มต่อจุด |
| `fscApplicable` | bool | – | default true | |
| `transitHours` | decimal(5,1) | – | | ใช้ประมาณเวลาเดินทางบนกระดาน/ETA ตั้งต้น |
| `remarks` | string | – | | |

**FuelSurchargeTable**: `name`, `basePricePerLitre` (บาท/ลิตร ณ วันทำสัญญา), `stepPerLitre` (เช่น 1.00), `percentPerStep` (เช่น 1.50%), `capPercent`, `floorPercent` (ติดลบได้ถ้าตกลงลดราคาเมื่อน้ำมันลง), `referenceSource` (`manual` [P0] / auto จากแหล่งราคาน้ำมันสาธารณะ [P1, OPEN-MD-5]), `effectiveRule` (`weekly_monday` / `on_change`), และตารางราคาอ้างอิงรายวัน `FuelPriceReference {date, pricePerLitre, source, enteredBy}`

**5. กฎธุรกิจ**

| รหัส | กฎ |
|---|---|
| MD-110 | **การหาเรทอัตโนมัติ** สำหรับ SO (ฝั่ง sell) ใช้ input: ลูกค้า, ต้นทาง (จุดรับแรก), ปลายทาง (จุดส่งสุดท้าย), ประเภทรถที่ขอ, วันรับของ (`pickupDate`) |
| MD-111 | ลำดับความสำคัญ: (1) rate card ของลูกค้า ก่อน ราคามาตรฐาน; (2) ความเจาะจงพื้นที่ location > district > province > zone > any (คิดคะแนนรวมต้นทาง+ปลายทาง); (3) ประเภทรถตรงตัวเท่านั้น; (4) `validFrom ≤ pickupDate ≤ validTo` และ status `active` |
| MD-112 | ได้ผลมากกว่า 1 บรรทัดที่คะแนนเท่ากัน → ไม่เลือกเอง แสดง "พบเรทซ้อน N รายการ" ให้ผู้ใช้เลือก + แจ้ง manager ว่า rate card ซ้อน |
| MD-113 | ไม่พบเรท → SO แสดงคำเตือน 1 บรรทัด + ปุ่ม "กำหนดราคาเอง" (ต้องมี `price.sell.edit`) [DECISION รอบ 9] |
| MD-114 | สูตรค่าขนส่งฐาน: flat_trip = rate; per_km = rate × distanceKm; per_ton = rate × (น้ำหนักรวม/1000); per_cbm = rate × ปริมาตร; per_day = rate × จำนวนวัน (ปัดขึ้นเป็นวัน); per_unit = rate × qty ในหน่วยนั้น; ผล = max(ผลคำนวณ, minCharge); ปัด 2 ตำแหน่งแบบ half-up |
| MD-115 | ค่าจุดเพิ่ม = max(0, จำนวน stop − includedStops) × extraStopRate — สร้างเป็นบรรทัดแยกรหัส accessorial `EXTRA_STOP` |
| MD-116 | Fuel surcharge % = clamp( floor((ราคาอ้างอิง − basePrice) / step) × percentPerStep, floorPercent, capPercent ); ราคาอ้างอิง = ค่าใน `FuelPriceReference` ที่มีผล ณ `pickupDate` ตาม `effectiveRule`; FSC (บาท) = % × (ค่าขนส่งฐาน + ค่าจุดเพิ่ม) ของบรรทัดที่ `fscApplicable` |
| MD-117 | **Snapshot ลง SO**: `rateCardId`, `version`, `lineId`, `pricingMethod`, `rate`, `minCharge`, `distanceKm`, `fscPercent`, `fuelReferencePrice`, ค่าที่คำนวณแต่ละบรรทัด — rate card เปลี่ยนภายหลังไม่กระทบ SO (M5) [DECISION] |
| MD-118 | **เวอร์ชัน**: rate card สถานะ active แก้ตรงไม่ได้ — "แก้ไข" = สร้างเวอร์ชันใหม่ (draft) คัดลอกทุกบรรทัด; เมื่อเวอร์ชันใหม่ active ระบบตั้ง `validTo` ของเวอร์ชันเดิม = `validFrom` ใหม่ − 1 วัน อัตโนมัติ |
| MD-119 | ช่วงวันของเวอร์ชันในสาย (chain) เดียวกันห้ามทับกัน; rate card ต่างสายของลูกค้าเดียวกันทับกันได้ แต่ถ้ามีเส้นทาง×ประเภทรถซ้ำในช่วงทับ → บล็อกการอนุมัติ พร้อมรายการบรรทัดชน |
| MD-120 | การอนุมัติ: draft → pending_approval → active; ผู้ส่งอนุมัติกับผู้อนุมัติต้องเป็นคนละคน ถ้า tenant เปิด "แยกหน้าที่" (default เปิด) [PROPOSED]; tenant ที่มีผู้ใช้คนเดียวปิดได้ |
| MD-121 | SO ที่ยังเป็น draft และใช้เวอร์ชันเก่า → ปุ่ม "อัปเดตเป็นราคาปัจจุบัน" (ไม่อัปเดตเอง); SO ที่ยืนยันแล้วเปลี่ยนเรทได้ด้วย ORD-046 เท่านั้น |
| MD-122 | แจ้งเตือน rate card หมดอายุล่วงหน้า 30 และ 7 วัน ถึงผู้สร้างและ manager; หมดอายุแล้วไม่มีตัวแทน → SO ใหม่ของลูกค้านั้นตกไปราคามาตรฐาน (ถ้ามี) และแสดงป้าย "ใช้ราคามาตรฐาน" |
| MD-123 | ฝั่ง buy ใช้โครงเดียวกัน; การหาเรทซื้อใช้ subcontractorId แทน customerId; ใช้ใน "เสนอรถ" และจ่ายงานรถร่วม (03 PLN-145) — ไม่เปิดเผยต่อลูกค้าในทุกช่องทาง |
| MD-124 | Zone (P1): ผู้ใช้กำหนดกลุ่มอำเภอ/จังหวัดเป็นโซน (เช่น "โซน A กรุงเทพชั้นใน") ใช้เป็นต้นทาง/ปลายทางได้; ทับกันระหว่างโซนได้แต่ MD-112 ใช้ตัดสิน |
| MD-125 | Quote API: `POST /v1/rate-quotes` รับ input เดียวกับ MD-110 คืนราคาแจกแจง + rateCard snapshot (ไม่สร้าง SO) — scope `rates:read` หรือ shipper key ของลูกค้าเดียว (เห็นเฉพาะราคาของตัวเอง) |
| MD-126 | ราคาน้ำมันอ้างอิงที่ยังไม่ได้กรอกสำหรับสัปดาห์ปัจจุบัน → ใช้ค่าล่าสุดและแสดงป้าย "ราคาน้ำมันอ้างอิงเก่า {วันที่}" ใน SO + แจ้ง manager ทุกวันจันทร์ 09:00 |

**6. สถานะ**

| สถานะ | ความหมาย |
|---|---|
| `draft` ร่าง | แก้ได้ |
| `pending_approval` รออนุมัติ | แก้ไม่ได้ |
| `active` ใช้งาน | ใช้คำนวณได้ในช่วงวัน |
| `expired` หมดอายุ | job รายวัน 00:05 เปลี่ยนเมื่อพ้น validTo |
| `superseded` ถูกแทน | มีเวอร์ชันใหม่ active และพ้นช่วงของตัวเอง |
| `cancelled` ยกเลิก | ไม่เคยใช้งานหรือยกเลิกก่อนมีผล |

| จาก → ไป | เงื่อนไข | ใคร | ผลข้างเคียง |
|---|---|---|---|
| draft → pending_approval | มี ≥ 1 บรรทัด, ผ่าน MD-119 | ผู้มีสิทธิ์แก้ | แจ้งผู้อนุมัติ |
| pending_approval → active | อนุมัติ | `ratecard.approve` | MD-118 ปิดเวอร์ชันเดิม; event |
| pending_approval → draft | ตีกลับ + เหตุผล | ผู้อนุมัติ | แจ้งผู้ส่ง |
| active → expired / superseded | ตามวัน | ระบบ | |
| draft/pending → cancelled | เหตุผล | ผู้สร้าง/manager | |
| active → cancelled | ยังไม่ถึง validFrom เท่านั้น | manager | |

**7. Event** — `rate_card.submitted`, `rate_card.activated`, `rate_card.expiring` (30/7 วัน), `rate_card.expired`, `fuel_price.updated`

**8. กรณีผิดปกติ** — import Excel บรรทัดอ้างสถานที่/อำเภอไม่พบ → error รายแถว (§11) · SO วันรับของอยู่ในช่องว่างระหว่างเวอร์ชัน → MD-113 · ลูกค้ามี rate card 2 ใบที่เส้นทางซ้อน (ต่างประเภทรถ) → ไม่ชน · per_ton แต่ SO ไม่มีน้ำหนัก → ราคาว่าง + ข้อความ "ต้องระบุน้ำหนัก"

**9. เกณฑ์ตรวจรับ**
- Given rate card ลูกค้า: อยุธยา → สระบุรี, พ่วง, flat 7,800.00 และราคามาตรฐานเส้นเดียวกัน 8,500.00 When สร้าง SO ลูกค้านี้ Then ราคา 7,800.00 + แสดงที่มา "RC-S-0012 v3"
- Given FSC base 30.00 step 1.00 = 1.5% และราคาอ้างอิง 32.40 When คิด SO ค่าขนส่ง 7,800.00 Then FSC 3.00% = 234.00
- Given rate card v3 active When แก้ราคา Then ระบบสร้าง v4 ร่าง; v3 ยังใช้งานจน v4 อนุมัติ และ SO เดิมยังอ้าง v3
- Given ผู้ส่งอนุมัติคนเดียวกับผู้สร้าง และเปิดแยกหน้าที่ When กดอนุมัติ Then ปุ่มถูกปิด "ต้องให้ผู้อื่นอนุมัติ"

**10. เฟส** — P0: MD-110–123, 126 · P1: MD-124 (zone), MD-125 (quote API), FSC อัตโนมัติ

---

## 6. ค่าบริการเสริม (Accessorial charges catalog)

**1. จุดประสงค์** — รายการค่าใช้จ่ายเพิ่มมาตรฐาน (ค่ารอ, ค่าขึ้น/ลง, ค่าค้างคืน, ค่าจุดเพิ่ม, FSC ฯลฯ) ที่กำหนดวิธีคิด ภาษี VAT และหัก ณ ที่จ่ายไว้ล่วงหน้า เพื่อให้ SO/DO/ใบแจ้งหนี้แยกภาษีถูกต้อง

**2. ผู้ใช้/สิทธิ์** — แก้: manager, accounting (เฉพาะธงภาษี) · ดู: ทุก role ภายใน

**3. หน้าจอ** — ตาราง: รหัส, ชื่อ, หมวด, วิธีคิด, อัตราเริ่มต้น, ฟรี, VAT, WHT, ใช้กับ (ขาย/ซื้อ), อัตโนมัติ, สถานะ · Drawer: สรุป · อัตราเฉพาะลูกค้า/รถร่วม · กิจกรรม

**4. ฟิลด์**

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| `code` | string(20) | ✓ | | ระบบสงวน: `FREIGHT`, `EXTRA_STOP`, `FSC`, `DISCOUNT` |
| `name` | 3 ภาษา | ✓ | | พิมพ์บนใบแจ้งหนี้ |
| `category` | enum `freight_component` (ส่วนของค่าขนส่ง) / `ancillary_service` (บริการประกอบ) / `reimbursement` (เบิกตามจริง) / `penalty` / `discount` | ✓ | | ใช้กำหนดค่า default ภาษี |
| `calcUnit` | enum `per_time` (ครั้ง) / `per_hour` / `per_stop` / `per_night` / `per_km` / `per_ton` / `per_unit` / `percent_of_freight` / `actual_amount` | ✓ | | |
| `defaultRate` | decimal(12,2) | เงื่อนไข | ≥ 0; `actual_amount` ไม่ต้อง | |
| `freeAllowance` | decimal | – | ≥ 0 | เช่น ค่ารอฟรี 2 ชม. |
| `roundingRule` | enum `none`/`ceil_15m`/`ceil_30m`/`ceil_1h` | – | ใช้กับ per_hour | |
| `maxAmount` | decimal | – | | เพดานต่อครั้ง |
| `vatTreatment` | enum `exempt_transport` / `vat7` / `follow_customer_freight` / `follow_customer_service` / `none` | ✓ | | default จาก category: freight_component → `follow_customer_freight`; ancillary_service → `follow_customer_service`; reimbursement → [OPEN-MD-3] |
| `whtType` | enum `transport_1` / `service_3` / `none` | ✓ | | default freight_component → transport_1; ancillary_service → service_3 [FACT ข้อ 12/1, 12/4] |
| `appliesTo` | enum `sell`/`buy`/`both` | ✓ | | ค่าที่จ่ายรถร่วมด้วย เช่น ค่ารอ |
| `passThroughToSubcon` | bool | – | | ถ้าลูกค้าจ่ายค่ารอ ให้เสนอบรรทัดเดียวกันในค่าจ้างรถร่วม |
| `autoTrigger` | enum `none` / `waiting_from_stop_events` / `extra_stops` / `fsc` / `overnight_from_trip_duration` | – | | |
| `requiresEvidence` | bool | – | | บังคับแนบรูป/ใบเสร็จ (เช่น ค่าผ่านทาง) |
| `requiresApprovalAbove` | decimal | – | | ยอดเกินต้อง manager อนุมัติ |
| `status` | active/inactive | ✓ | | |

ชุดเริ่มต้น [PROPOSED; ธงภาษีที่ยังไม่แน่นอนติด OPEN]:

| รหัส | ชื่อ | หมวด | วิธีคิด | ตั้งต้น | VAT | WHT | อัตโนมัติ |
|---|---|---|---|---|---|---|---|
| FREIGHT | ค่าขนส่ง | freight_component | (จาก rate card) | – | ตามลูกค้า (ยกเว้น) [FACT] | 1% | – |
| EXTRA_STOP | ค่าจุดส่งเพิ่ม | freight_component | per_stop | 300.00 | ตามลูกค้า (ยกเว้น) [PROPOSED] | 1% | extra_stops |
| FSC | ค่าน้ำมันเพิ่ม (fuel surcharge) | freight_component | percent_of_freight | ตาราง FSC | ตามลูกค้า (ยกเว้น) [PROPOSED] | 1% | fsc |
| WAIT | ค่ารอ (ต่อชม. หลังฟรี 2 ชม.) | ? | per_hour, ceil_30m | 200.00 | [OPEN-MD-3] | [OPEN-MD-3] | waiting_from_stop_events |
| LOAD | ค่าขึ้นสินค้า | ancillary_service | per_time / per_ton | 500.00 | 7% [FACT] | 3% | – |
| UNLOAD | ค่าลงสินค้า | ancillary_service | per_time / per_ton | 500.00 | 7% [FACT] | 3% | – |
| OVERNIGHT | ค่าค้างคืน | ? | per_night | 1,000.00 | [OPEN-MD-3] | [OPEN-MD-3] | overnight_from_trip_duration |
| TOLL | ค่าผ่านทาง (ตามจริง) | reimbursement | actual_amount | – | [OPEN-MD-3] | none | – |
| DISCOUNT | ส่วนลด | discount | actual_amount / percent | – | ตามบรรทัดที่ลด | ตามบรรทัดที่ลด | – |

**5. กฎธุรกิจ**

| รหัส | กฎ |
|---|---|
| MD-150 | เมื่อเพิ่มค่าบริการเสริมใน SO/DO ระบบคำนวณ `vatTreatment` สุดท้ายของบรรทัด (resolve `follow_customer_*` จากลูกค้า) และเก็บเป็น snapshot ต่อบรรทัด; ผู้ใช้แก้ธงภาษีในบรรทัดได้เฉพาะ accounting พร้อมเหตุผล |
| MD-151 | อัตราเฉพาะลูกค้า/รถร่วม (ในแท็บ rate card "ค่าบริการเสริมเฉพาะ") มีลำดับเหนือ `defaultRate`; ลำดับ: rate card ลูกค้า > rate card มาตรฐาน > defaultRate |
| MD-152 | ค่ารออัตโนมัติ: ต่อ stop, เวลารอ = `departedAt − max(arrivedAt, windowStart)` ลบด้วย `freeAllowance` (ลูกค้า override ด้วย `freeWaitingHours`) ปัดตาม `roundingRule`; ถ้า > 0 สร้าง **บรรทัดร่าง** "ค่ารอ (แนะนำ)" ใน DO ต้องมีคนยืนยัน ก่อนเข้าบิล (D5, E10) |
| MD-153 | ค่ารอไม่คิด ถ้ารถมาถึงก่อน `windowStart` (นับเริ่มจาก windowStart) หรือเหตุรอเกิดจากฝ่ายเรา (คนขับเลือกเหตุ "รถเสีย/เอกสารไม่ครบ" ใน M14) |
| MD-154 | `percent_of_freight` คิดจากผลรวมบรรทัด category `freight_component` ที่ไม่ใช่ตัวมันเอง |
| MD-155 | ส่วนลดเก็บเป็นบรรทัดติดลบที่ผูก `appliesToLineId` (หรือ "ทั้งงาน" แบ่งตามสัดส่วน) เพื่อให้ฐาน VAT ของแต่ละกลุ่มลดถูกต้อง |
| MD-156 | บรรทัดที่ `requiresApprovalAbove` เกิน → สถานะบรรทัด `pending_approval` ไม่เข้าบิลจนอนุมัติ |
| MD-157 | เปลี่ยนธงภาษีใน catalog ไม่กระทบเอกสารเดิม (MD-005) — แสดงคำเตือนจำนวน SO ที่ยังไม่วางบิลที่ใช้รายการนี้ และปุ่ม "คำนวณใหม่สำหรับ SO ร่าง" |
| MD-158 | รหัสสงวน (`FREIGHT`, `EXTRA_STOP`, `FSC`, `DISCOUNT`) ลบ/ปิดใช้ไม่ได้ แก้ชื่อและธงภาษีได้ |
| MD-159 | mapping ประเภทค่าใช้จ่าย ↔ รหัสสินค้าในระบบบัญชีอยู่ที่ connector (07) ไม่อยู่ใน catalog นี้ (D2) |

**6. สถานะ** — active/inactive · **7. Event** — `accessorial.updated` (audit), `charge.suggested` (เมื่อ MD-152 สร้างบรรทัดร่าง — ใช้แจ้ง dispatcher)

**8. กรณีผิดปกติ** — ไม่มี departedAt (คนขับลืมกด) → ไม่สร้างค่ารอ แสดง "ข้อมูลเวลาไม่ครบ" ใน DO · offline: เวลาใช้ `occurredAt` จากเครื่อง (04) · ค่ารอเกิน `maxAmount` → ตัดที่เพดานและแสดงยอดเต็มในหมายเหตุ

**9. เกณฑ์ตรวจรับ**
- Given ค่ารอ 200.00/ชม. ฟรี 2 ชม. ปัด 30 นาที, ถึง 08:05 (window 08:00) ออก 11:20 When ปิด stop Then บรรทัดร่างค่ารอ 1.5 ชม. = 300.00 สถานะรอยืนยัน
- Given ลูกค้าบริการ VAT 7% When เพิ่ม LOAD 500.00 Then บรรทัด vat7 ฐาน 500.00 VAT 35.00, WHT ที่คาด 3% = 15.00 (ถ้ายอดสัญญา ≥ 1,000.00)
- Given FREIGHT When ผู้ใช้ dispatcher พยายามเปลี่ยนธง VAT Then แก้ไม่ได้

**10. เฟส** — P0 (MD-152 ใช้ได้เมื่อแอปคนขับส่ง arrive/depart — P0)

---

## 7. ผู้ขาย / อู่ (Vendor)

**1. จุดประสงค์** — ทะเบียนคู่ค้าฝั่งจ่ายที่ไม่ใช่รถร่วม (อู่ ร้านยาง ร้านอะไหล่ ปั๊มน้ำมัน บริษัทประกัน) ใช้ในใบสั่งซ่อม ยาง อะไหล่ น้ำมัน เคลม (06) — เลือกจากรายการแทนพิมพ์ชื่อ [DECISION รอบ 6 ข้อ 6]

**2. ผู้ใช้/สิทธิ์** — สร้าง/แก้: fleet, manager, accounting · ดู: ทุก role ภายใน

**3. หน้าจอ** — รายการ: แถบสรุป + ตาราง (รหัส, ชื่อ, ประเภท, เลขผู้เสียภาษี, เครดิตเทอม, ยอดซื้อปีนี้, ระยะซ่อมเฉลี่ย, คะแนน, สถานะ) · Drawer แท็บ: สรุป · ราคาประจำ · ประวัติ (WO/ใบเติมน้ำมัน/ซื้อยาง) · สถิติ · กิจกรรม

**4. ฟิลด์**

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ |
|---|---|---|---|
| `code` | string(20) | ✓ | `VEN-0001` |
| `name`, `partyType`, `taxId`, `branchCode`, `address` | ตามลูกค้า | ✓ (taxId ไม่บังคับ) | MD-020 รูปแบบเดียวกัน (unique taxId+branch ในกลุ่ม vendor) |
| `types` | multi enum `garage`/`tyre_shop`/`parts_shop`/`fuel_station`/`insurer`/`towing`/`other` | ✓ | ≥ 1 |
| `vatRegistered` | bool | ✓ | ใช้ตรวจใบกำกับภาษีซื้อ |
| `creditTermDays` | int | ✓ | 0–180 |
| `paymentMethod` | enum transfer/cheque/cash | – | |
| `bankAccount` | {bank, accountNo, accountName} | – | accountName ตรงชื่อผู้ขาย (เตือนถ้าไม่ตรง) |
| `whtType` | enum service_3/hire_3/transport_1/none | ✓ | default service_3 |
| `contacts` | array | – | |
| `standardPrices` | array {itemName/partId, unitId, price, validFrom, validTo} | – | ใช้เติมราคาใน WO; ราคา WO ต่างจากราคาประจำ > 10% → เตือน |
| `rating` | 1–5 | – | ผู้ใช้ให้คะแนนหลังปิด WO |
| `status` | active/inactive | ✓ | |

**สถิติ (คำนวณ, อ่านอย่างเดียว)**: ยอดซื้อรวม (เดือนนี้/ปีนี้/12 เดือน), จำนวน WO, ระยะเวลาซ่อมเฉลี่ย (ชม. จากเปิด WO ถึงรับรถ), % งานซ่อมซ้ำใน 30 วัน, คะแนนเฉลี่ย

**5. กฎธุรกิจ** — MD-180 ใบสั่งซ่อม/ใบเติมน้ำมัน/ซื้อยางต้องเลือกผู้ขายจากรายการ (สร้างด่วนได้จาก dropdown) · MD-181 ผู้ขายรายเดียวกับรถร่วม (นิติบุคคลเดียวกัน) เก็บแยก entity แต่ผูก `linkedSubcontractorId` ได้ เพื่อหักกลบใน settlement (05) [P1] · MD-182 สถิติคำนวณ nightly job

**6. สถานะ** active/inactive · **7. Event** `vendor.created/updated` (audit) · **8. กรณีผิดปกติ** ผู้ขายไม่มีเลขผู้เสียภาษีแต่ `vatRegistered=true` → บันทึกไม่ได้ · **9. เกณฑ์ตรวจรับ** Given อู่ A ราคาประจำ "เปลี่ยนถ่ายน้ำมันเครื่อง 10 ล้อ" 2,800.00 When เพิ่มใน WO ราคา 3,200.00 Then เตือน "สูงกว่าราคาประจำ 14.29%" · **10. เฟส** P1 (พร้อม fleet), แต่ entity + ฟิลด์พื้นฐานสร้างใน P0 เพื่อใช้กับน้ำมัน

---

## 8. คนขับและรถร่วม (สรุป — รายละเอียดใน 06-fleet)

**1. จุดประสงค์** — กำหนดฟิลด์ขั้นต่ำที่โมดูลรับงาน/วางแผน/บัญชีต้องพึ่ง; หน้าจอ เอกสาร และวงจรเต็มอยู่ใน [06-fleet.md](06-fleet.md)

**2–4. ฟิลด์ที่โมดูลอื่นใช้**

| Entity | ฟิลด์ | ใช้ที่ |
|---|---|---|
| Driver | `code`, `name`, `phone`, `employmentType` (`salaried` / `per_trip` / `subcontractor_driver`) (M2), `licenceNo`, `licenceClass` (personal/T1–T4), `licenceExpiry`, `hazmatCertExpiry` (ถ้ามี), `subcontractorId` (ถ้าเป็นคนขับรถร่วม), `appUserId`, `status` (active/on_leave/inactive), `defaultVehicleId` | popover เลือกคนขับ, กฎห้ามจ่ายงาน PLN-083/084, ค่าเที่ยว (05) |
| Subcontractor (Carrier) | `code`, `name`, `partyType`, `taxId`, `branchCode`, `bankAccount`, `whtRate` (default 1.00 [FACT ข้อ 12/4, กค 0706/10578]), `tier` (`preferred` รถร่วมประจำ / `other`), `cascadeRank`, `maxTripsPerDay`, `lineContact` (ผูก LINE แบบ MD-030), `smsPhone`, `defaultBuyRateCardId`, `onTimeRate30d` (คำนวณ), `acceptRate30d` (คำนวณ), `status` | เสนอรถ, cascade, settlement (05) |
| Vehicle | `plateNo` + `province` (แสดง "71-0457 กทม."), `vehicleTypeId`, `ownership` (`own`/`subcontract`) (M1), `subcontractorId`, `payloadKg` override, `status` (active/under_repair/parked/inactive), เอกสาร (ประกันภัย, พ.ร.บ., ภาษี, ตรอ.) + วันหมดอายุ, `homeDepotId`, `currentTrailerId` | กระดาน, กฎห้ามจ่ายงาน PLN-080–082 |

**5. กฎธุรกิจ**

| รหัส | กฎ |
|---|---|
| MD-200 | รถร่วมเป็น entity แยกจากคนขับ; รถ `ownership=subcontract` ต้องผูก `subcontractorId` (M1) |
| MD-201 | รถร่วมกรอกทะเบียน+คนขับใหม่ตอนรับงาน (03 PLN-152) → สร้าง Vehicle/Driver สถานะ `pending_review` ใช้กับงานนั้นได้หลังผ่านกฎห้ามจ่ายงาน (ต้องมีวันหมดอายุเอกสารขั้นต่ำ: พ.ร.บ., ภาษี, ใบขับขี่ — ถ้าไม่มีข้อมูล = ถือว่า "ไม่ทราบ" → dispatcher ยืนยันพร้อมเหตุผล) |
| MD-202 | PDPA: เลขบัตรประชาชน/ใบขับขี่คนขับเห็นเฉพาะ role ที่มี `driver.pii.view`; หน้ารถร่วมเห็นเฉพาะคนขับของตัวเอง (11-nfr) |
| MD-203 | สถิติรถร่วม (`onTimeRate30d`, `acceptRate30d`, ราคา 5 ครั้งล่าสุดต่อเส้นทาง) คำนวณทุกคืน ใช้ใน PLN-120 |

**6–9.** สถานะ/event/กรณีผิดปกติ/เกณฑ์ตรวจรับ → 06-fleet · **10. เฟส** P0

---

## 9. เหตุผลมาตรฐาน (Reason master)

**1. จุดประสงค์** — รายการเหตุผลที่ tenant ตั้งเองได้ ใช้ทุกจุดที่บังคับใส่เหตุผล เพื่อรายงานได้ (M7, PL7)

**3–4. หน้าจอ/ฟิลด์** — ตั้งค่า → เหตุผล: ตารางแยกหมวด · ฟิลด์: `category`, `code`, `label` 3 ภาษา, `requiresNote` (bool), `requiresPhoto` (bool), `autoAction` (`none` / `reschedule` / `return_to_pool`), `sortOrder`, `status`

| หมวด (`category`) | ใช้ที่ | ชุดเริ่มต้นภาษาไทย (ตัวอย่าง) |
|---|---|---|
| `so_cancel` | ยกเลิก SO (03) | ลูกค้ายกเลิก · สร้างซ้ำ · เลื่อนไม่มีกำหนด · ราคาไม่ตกลง · อื่นๆ |
| `unplanned` | งานค้างวางแผน (PL7) | ไม่มีรถว่าง · เกินความจุ · รถร่วมปฏิเสธ · ที่อยู่ผิด · หลุดช่วงเวลา |
| `subcon_reject` | รถร่วมปฏิเสธ (03 §8) | ไม่มีรถว่าง · ราคาต่ำไป · เส้นทางไม่สะดวก · เวลาไม่ได้ · อื่นๆ |
| `delivery_failed` | ส่งไม่สำเร็จ (04) | ร้านปิด · ผู้รับปฏิเสธ · ที่อยู่ผิด · สินค้าเสียหาย |
| `dispatch_override` | override กฎห้ามจ่ายงาน (03 PLN-090) | ฉุกเฉินลูกค้า · เอกสารต่ออายุแล้วรอสแกน · อื่นๆ |
| `trip_cancel`, `driver_reject`, `pod_reject` | 03/04 | ... |

**5. กฎ** — MD-220 เหตุผลถูก snapshot (code + ข้อความ) ลงรายการที่ใช้ แก้ master ไม่ย้อนแก้ · MD-221 หมวดมีรายการ "อื่นๆ" ที่ `requiresNote=true` เสมอ (ลบไม่ได้) · MD-222 ข้อความเหตุผลรวมหมายเหตุ ≥ 10 ตัวอักษรสำหรับการยกเลิก/override (00-overview §6) · **6–9** active/inactive; event ไม่มี; ตรวจรับ: Given หมวด so_cancel When เลือก "อื่นๆ" ไม่ใส่หมายเหตุ Then บันทึกไม่ได้ · **10. เฟส** P0

---

## 10. ฟิลด์เพิ่มเติม (Custom fields)

**1. จุดประสงค์** — ให้ tenant เพิ่มฟิลด์ของตัวเองใน entity หลักโดยไม่ต้องให้ทีมเราแก้โค้ด และใช้ schema เดียวกันทั้ง UI, REST API, MCP, webhook, เอกสาร API, import/export (D6) [DECISION รอบ 12]

**2. ผู้ใช้/สิทธิ์** — ตั้งค่า: admin, developer (สิทธิ์ `settings.custom_fields.manage`) · กรอก/ดูค่า: ตามสิทธิ์ต่อฟิลด์ (MD-245)

**3. หน้าจอ — ตั้งค่า → ฟิลด์เพิ่มเติม**
- ซ้าย: รายการ 10 entity พร้อมตัวนับ "ใช้แล้ว N / โควตา" (จากแพ็กเกจ D8) · ขวา: ตารางฟิลด์ของ entity ที่เลือก (ลากเรียงลำดับ): ชื่อแสดง, API key, ประเภท, บังคับ, แสดงที่ (ไอคอน), API (อ่าน/เขียน/webhook), สถานะ
- ปุ่ม "+ เพิ่มฟิลด์" → drawer 4 ส่วน: (1) ทั่วไป (2) กฎตรวจ (3) แสดงที่และสิทธิ์ (4) API — มี preview ฟอร์มจริงด้านล่างใน 3 ภาษา
- แท็บ "ถังขยะ" (ฟิลด์ที่ลบ ภายใน 30 วัน + ปุ่มกู้คืน) · แท็บ "ประวัติ" (audit)
- ฝั่งข้อมูล: ฟอร์มสร้าง/แก้มี section "ข้อมูลเพิ่มเติม"; drawer มี section "ข้อมูลเพิ่มเติม" ในแท็บสรุป; ตารางเปิดเป็นคอลัมน์และกรองได้

**Entity ที่รองรับ (10)**: SO · DO · เที่ยวรถ (Trip) · จุดรับส่ง (Stop) · ลูกค้า · สถานที่ · รถ · คนขับ · รถร่วม · ใบแจ้งหนี้

**ประเภทฟิลด์ (14)**

| # | type | UI | ค่าที่เก็บ (JSON) | กฎที่ใช้ได้ |
|---|---|---|---|---|
| 1 | `text` | ช่องบรรทัดเดียว | string ≤ 255 | required, default, min/max length, regex, unique |
| 2 | `textarea` | หลายบรรทัด | string ≤ 4,000 | required, max length |
| 3 | `integer` | ตัวเลข | integer | required, default, min/max, unique |
| 4 | `decimal` | ตัวเลข + จำนวนทศนิยม (0–6) | string ทศนิยม | required, default, min/max |
| 5 | `currency` | เงินบาท 2 ตำแหน่ง | string "1234.50" (ตามมาตรฐาน API) | required, min/max |
| 6 | `percent` | 0–100 + % | string ทศนิยม | required, min/max |
| 7 | `date` | date picker (พ.ศ. ในโหมดไทย) | "YYYY-MM-DD" | required, min/max (ค่าคงที่หรือ "วันนี้±N") |
| 8 | `datetime` | วัน+เวลา | ISO 8601 +07:00 | required, min/max |
| 9 | `boolean` | สวิตช์ | true/false | default |
| 10 | `select` | dropdown ตัวเดียว | option code | required, default |
| 11 | `multiselect` | หลายตัวเลือก | option code[] | required, min/max จำนวน |
| 12 | `email` | อีเมล | string | required, unique |
| 13 | `phone` | เบอร์ +66 | E.164 | required, unique |
| 14 | `file` | อัปโหลด (PDF/JPG/PNG ≤ 10 MB, ≤ 5 ไฟล์) | file id[] | required |

ประเภท `lookup` (อ้างข้อมูลหลักอื่น) และ `url` ไม่อยู่ในชุดแรก → [OPEN-MD-6]

**4. ฟิลด์ — CustomFieldDefinition**

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| `entity` | enum 10 ค่า | ✓ | | เปลี่ยนไม่ได้หลังบันทึก |
| `label` | {th, en, zh} | ✓ th | ≤ 60 | |
| `helpText` | {th, en, zh} | – | ≤ 200 | |
| `apiKey` | string | ✓ | `^[a-z][a-z0-9_]{1,39}$`, unique ต่อ entity, ไม่ชนคำสงวน (ชื่อฟิลด์มาตรฐานของ entity, `id`, `custom_fields`, `tenant_id`, `created_at`…) | เสนอจาก label อังกฤษอัตโนมัติ; **ล็อกหลังบันทึก** |
| `type` | enum 14 | ✓ | | เปลี่ยนได้เฉพาะคู่ที่เข้ากันได้ (MD-238) |
| `options` | array {code, label{th,en,zh}, color?, active} | ✓ ถ้า select/multiselect | code snake_case ห้ามซ้ำ, ≤ 200 ตัวเลือก | code ล็อกหลังบันทึก, ปิดตัวเลือกได้ |
| `required` | bool | – | | |
| `requiredWhenStatus` | array status ของ entity | – | ต้องเป็นสถานะที่มีจริง | เช่น บังคับเมื่อ DO → delivered |
| `defaultValue` | ตาม type | – | ต้องผ่านกฎตัวเอง | |
| `min`, `max` | ตาม type | – | min ≤ max | |
| `regex` | string | – | compile ได้ (RE2 syntax, ≤ 200 ตัวอักษร) + ช่องทดสอบ | ใช้กับ text เท่านั้น |
| `regexMessage` | {th,en,zh} | ✓ ถ้ามี regex | | |
| `unique` | bool | – | | unique ใน tenant+entity (ค่าว่างไม่นับ) |
| `displayIn` | set {`form`, `drawer`, `table_column`, `filter`, `print_a4`, `driver_app`, `tracking_page`, `export`, `subcon_page`} | ✓ | `driver_app`/`tracking_page`/`subcon_page` ใช้ได้เฉพาะ entity ที่หน้านั้นแสดง (SO, DO, Trip, Stop) | `tracking_page` = สาธารณะ → ต้องยืนยัน "ข้อมูลนี้จะเห็นโดยผู้รับ" |
| `rolePermissions` | map role → `hidden`/`view`/`edit` | ✓ | default: admin/manager edit, อื่น view | |
| `driverAppEditable` | bool | – | เฉพาะ DO/Stop/Trip | คนขับกรอกในแอป (เช่น เลขซีล) |
| `api.read` | bool | ✓ | default true | อยู่ในก้อน `custom_fields` ของ response |
| `api.write` | bool | ✓ | default true | รับค่าใน POST/PATCH |
| `api.webhook` | bool | ✓ | default true | อยู่ใน payload webhook |
| `mcp.exposed` | bool | – | default = api.read | |
| `sortOrder` | int | ✓ | | |
| `status` | enum `active`/`disabled`/`deleted` | ✓ | | |

**5. กฎธุรกิจ**

| รหัส | กฎ |
|---|---|
| MD-230 | โควตาจำนวนฟิลด์ต่อ entity อ่านจาก entitlement แพ็กเกจ (ตัวอย่างปัจจุบัน 5 / 20 / ไม่จำกัด — D8 ห้าม hard-code); นับฟิลด์ `active` + `disabled` (ไม่นับ `deleted`) ; เต็มแล้วปุ่ม "+ เพิ่มฟิลด์" แสดงข้อความ "ครบโควตา N ฟิลด์ของแพ็กเกจ" + ลิงก์อัปเกรด |
| MD-231 | ดาวน์เกรดแพ็กเกจจนเกินโควตา: ฟิลด์เดิมไม่ถูกปิด แต่สร้างเพิ่มไม่ได้จนต่ำกว่าโควตา [PROPOSED] |
| MD-232 | `apiKey` ล็อกหลังบันทึก (API, webhook, mapping, MCP อ้าง key นี้); อยากเปลี่ยน = สร้างฟิลด์ใหม่ + ย้ายค่า (ปุ่ม "คัดลอกค่าไปฟิลด์ใหม่" [P1]) |
| MD-233 | ค่าเก็บใน column `customFields JSONB` ของ entity, key = apiKey; index GIN สำหรับตัวกรอง; ฟิลด์ `unique` ใช้ partial unique index บน expression `(tenantId, (customFields->>'key'))` ที่สร้าง/ลบตามนิยาม (migration แบบ online) |
| MD-234 | ตรวจค่าที่ server เสมอ (UI ตรวจซ้ำได้) — ทุกช่องทาง (UI, API, MCP, import, connector) ใช้ validator ชุดเดียว; ข้อความผิด 3 ภาษาตาม `preferredLanguage` |
| MD-235 | API: ผิดกฎ → HTTP 422 `{code: "custom_field_invalid", details: [{field: "custom_fields.seal_no", rule: "regex", message}]}`; key ที่ไม่รู้จักหรือ `api.write=false` → 422 `custom_field_not_writable` (ไม่เงียบทิ้ง) |
| MD-236 | ค้นหา/กรองผ่าน API `?custom_fields.<key>=value` (เท่ากับ), `custom_fields.<key>[gte]=` สำหรับตัวเลข/วันที่; เฉพาะฟิลด์ที่ `api.read=true` |
| MD-237 | `openapi.yaml` ราย tenant generate ใหม่ทุกครั้งที่นิยามเปลี่ยน (version hash) — schema `CustomFields<Entity>` ใส่ type/enum/pattern/required ตามนิยาม; เอกสาร API และ MCP tool schema ใช้แหล่งเดียวกัน (D6, 07) |
| MD-238 | เปลี่ยนประเภทได้เฉพาะ: text↔textarea, integer→decimal, select→multiselect, decimal→currency; อื่น ๆ ต้องสร้างฟิลด์ใหม่; ก่อนเปลี่ยนระบบตรวจค่าที่มีอยู่ทั้งหมด ถ้ามีค่าที่แปลงไม่ได้แสดงจำนวนและบล็อก |
| MD-239 | เพิ่ม `required` / `unique` / regex ให้ฟิลด์ที่มีข้อมูลแล้ว: ระบบนับรายการที่ไม่ผ่าน แสดงก่อนบันทึก; บันทึกได้ (ไม่บล็อก) แต่รายการเดิมจะถูกบังคับเมื่อแก้ครั้งถัดไป; `unique` บล็อกถ้ามีค่าซ้ำอยู่แล้ว |
| MD-240 | `requiredWhenStatus`: ตรวจตอนเปลี่ยนสถานะเข้าสถานะที่ระบุ (เช่น ยืนยัน SO, ปิด DO); ไม่ผ่าน → เปลี่ยนสถานะไม่ได้ ข้อความ "กรอก {label} ก่อน{การกระทำ}"; ใช้กับแอปคนขับด้วยถ้า `driverAppEditable` |
| MD-241 | **ปิดใช้ (disabled)**: ซ่อนจากฟอร์ม/ตาราง/API/webhook แต่ค่ายังเก็บ เปิดกลับได้ทุกเมื่อ; นับโควตา |
| MD-242 | **ลบ (deleted)**: ต้องพิมพ์ apiKey ยืนยัน; ค่าทั้งหมดซ่อนทันที กู้คืนได้ใน 30 วัน (ค่ากลับมาครบ); หลัง 30 วัน job ลบ key ออกจาก JSONB ทุกแถวและลบนิยาม; apiKey นี้ใช้ซ้ำไม่ได้ระหว่าง 30 วัน |
| MD-243 | ฟิลด์ที่อยู่ใน field mapping profile (07) หรือ template พิมพ์ → แสดงคำเตือนรายชื่อที่ใช้ก่อนปิด/ลบ |
| MD-244 | เอกสารที่ออกแล้ว (ใบแจ้งหนี้ล็อก) เก็บ snapshot ค่าที่พิมพ์ไว้ — ลบฟิลด์ไม่ทำให้ PDF เดิมเปลี่ยน |
| MD-245 | สิทธิ์ต่อฟิลด์: `hidden` = ไม่เห็นทั้ง UI/export/API ของผู้ใช้นั้น (API key ใช้สิทธิ์ตาม scope + `api.read`); รถร่วมเห็นเฉพาะ `subcon_page`; คนขับเห็นเฉพาะ `driver_app`; หน้าติดตามเห็นเฉพาะ `tracking_page` |
| MD-246 | ฟิลด์ประเภท `file` ใช้พื้นที่เก็บ POD/ไฟล์ของแพ็กเกจ (01) และสแกนไวรัสก่อนให้ดาวน์โหลด |
| MD-247 | ค่าเริ่มต้น (`defaultValue`) เติมเฉพาะตอนสร้างรายการใหม่ ไม่ย้อนเติมรายการเดิม |
| MD-248 | การคัดลอก SO (ORD-022) คัดลอกค่า custom fields ด้วย ยกเว้นฟิลด์ `unique` และ `file` |
| MD-249 | ทุกการเปลี่ยนนิยาม (สร้าง/แก้กฎ/สิทธิ์/ปิด/ลบ/กู้คืน) และทุกการแก้ค่าของฟิลด์ (อยู่ใน audit ของ entity) บันทึก audit; หน้า "ประวัติ" กรองตามฟิลด์ได้ |

**6. สถานะ**

| จาก → ไป | เงื่อนไข | ใคร | ผลข้างเคียง |
|---|---|---|---|
| (ใหม่) → active | ผ่านกฎ, ไม่เกินโควตา | admin/developer | regenerate openapi; event |
| active → disabled | – | admin/developer | ซ่อนทุกช่องทาง |
| disabled → active | – | admin/developer | |
| active/disabled → deleted | พิมพ์ apiKey ยืนยัน | admin | ตั้ง `purgeAt = now + 30 วัน` |
| deleted → (สถานะก่อนลบ) | ก่อน purgeAt, ไม่เกินโควตา | admin | |
| deleted → purged | ถึง purgeAt | ระบบ | ลบค่าถาวร |

**7. Event** — `custom_field.created`, `custom_field.updated`, `custom_field.disabled`, `custom_field.deleted`, `custom_field.restored` (audit + แจ้ง developer ที่ subscribe `schema.changed` [P1]); ค่าฟิลด์ไปกับ event ของ entity (`order.updated` ฯลฯ) เมื่อ `api.webhook=true`

**8. กรณีผิดปกติ** — regex ทำงานนาน (ReDoS) → ใช้ RE2 + timeout 50 ms ต่อค่า · import ที่มีคอลัมน์ฟิลด์ที่ disabled → ข้ามพร้อมคำเตือน · ผู้ใช้ 2 คนสร้าง apiKey เดียวกันพร้อมกัน → unique constraint คนหลังได้ 409 · แอปคนขับรุ่นเก่า cache นิยามเดิม → server ตรวจด้วยนิยามล่าสุด ส่งข้อผิดพลาดกลับให้แก้ (04)

**9. เกณฑ์ตรวจรับ**
- Given แพ็กเกจโควตา 5 และ SO มีฟิลด์ active 4 + disabled 1 When เพิ่มฟิลด์ใหม่ Then ไม่ได้ ข้อความครบโควตา
- Given ฟิลด์ DO `seal_no` text regex `^[A-Z]{2}\d{6}$` requiredWhenStatus=delivered, driverAppEditable When คนขับปิด DO โดยไม่กรอก Then แอปไม่ให้ยืนยัน POD และแสดงข้อความภาษาของคนขับ
- Given ฟิลด์บันทึกแล้ว When แก้ apiKey Then ช่องเป็น read-only พร้อมคำอธิบาย
- Given ลบฟิลด์ `po_line` When กู้คืนวันที่ 29 Then ค่าเดิมทุกแถวกลับมา; วันที่ 31 ไม่มีปุ่มกู้คืน
- Given `POST /v1/orders` ส่ง `custom_fields.seal_no="x"` When ผิด regex Then 422 `custom_field_invalid` details ระบุฟิลด์
- Given ฟิลด์ `api.webhook=false` When เกิด `order.updated` Then payload ไม่มี key นี้

**10. เฟส** — P0: ประเภท 1–13, displayIn form/drawer/table/filter/export/print_a4, กฎทั้งหมด, API read/write · P1: `file`, driver_app/tracking/subcon page, MCP flag, MD-232 ย้ายค่า, `schema.changed`

---

## 11. นำเข้า Excel/CSV สำหรับข้อมูลหลัก

**1. จุดประสงค์** — ลูกค้าไทยเก็บข้อมูลหลักใน Excel แทบทั้งหมด จึงต้องนำเข้าได้ตั้งแต่วันแรก พร้อม dry-run และรายงานตรวจรายแถว (P8) — ใช้ใน setup checklist (01)

**2. ผู้ใช้/สิทธิ์** — ผู้มีสิทธิ์สร้างของ entity นั้น; rate card ต้องมี `price.*.edit`

**3. หน้าจอ** — ปุ่ม "นำเข้า" ในทุกหน้ารายการข้อมูลหลัก → wizard 4 ขั้น: (1) ดาวน์โหลด template / อัปโหลดไฟล์ (2) จับคู่คอลัมน์ (จำการจับคู่ล่าสุด; ใช้ field mapping profile ได้ — 07; AI แนะนำได้ — 08) (3) ตรวจ (dry-run) แสดงสรุป ผ่าน/เตือน/ผิด + ตารางรายแถว + ดาวน์โหลดรายงาน (4) ยืนยันนำเข้า → งาน async + แถบความคืบหน้า + ผลสรุป · ประวัติการนำเข้า (ไฟล์ ผู้ทำ เวลา ผล ไฟล์รายงาน)

**Entity ที่นำเข้าได้**: ลูกค้า (+ผู้ติดต่อ แยก sheet), สถานที่, สินค้า, หน่วย, ประเภทรถ, rate card (หัว + บรรทัด แยก sheet), ค่าบริการเสริม, ผู้ขาย, รถร่วม, คนขับ*, รถ* (*รูปแบบใน 06)

**4. ฟิลด์ — ตัวเลือกนำเข้า**

| ตัวเลือก | ค่า | ค่าเริ่มต้น |
|---|---|---|
| `mode` | `create_only` / `upsert_by_code` / `update_only` | `create_only` |
| `errorPolicy` | `all_or_nothing` / `skip_invalid_rows` | `all_or_nothing` |
| `dateFormat` | อัตโนมัติ / `DD/MM/YYYY พ.ศ.` / `DD/MM/YYYY ค.ศ.` / `YYYY-MM-DD` | อัตโนมัติ (ปี > 2400 = พ.ศ.) |
| `encoding` (CSV) | อัตโนมัติ / UTF-8 / TIS-620 (Windows-874) | อัตโนมัติ |

**รายงานตรวจ (ต่อแถว)**: `rowNumber`, `status` (ok/warning/error), `column`, `value`, `errorCode` (เช่น `required`, `invalid_format`, `duplicate_in_file`, `duplicate_in_db`, `reference_not_found`, `custom_field_invalid`, `quota_exceeded`), `message` 3 ภาษา — ดาวน์โหลดเป็นไฟล์ต้นฉบับ + คอลัมน์ "ผลตรวจ" ต่อท้าย เพื่อแก้แล้วอัปโหลดใหม่

**5. กฎธุรกิจ**

| รหัส | กฎ |
|---|---|
| MD-280 | รองรับ .xlsx และ .csv, ≤ 10 MB และ ≤ 5,000 แถวต่อไฟล์ [PROPOSED]; sheet แรกหรือชื่อ sheet ตาม template |
| MD-281 | ขั้นตรวจไม่เขียนข้อมูลจริง; ใช้ validator เดียวกับ UI/API (MD-234) รวม custom fields (คอลัมน์ `cf.<apiKey>`) |
| MD-282 | อ้างอิงข้ามตาราง (ลูกค้าของสถานที่, ประเภทรถใน rate card) อ้างด้วย `code` หรือชื่อที่ตรงตัว; ไม่พบ → `reference_not_found`; อ้างถึงรายการที่อยู่ในไฟล์เดียวกัน (sheet ก่อนหน้า) ได้ |
| MD-283 | ค่าซ้ำในไฟล์เดียวกัน (code, taxId+branch) → แถวหลังเป็น error |
| MD-284 | `upsert_by_code`: แถวที่มี code อยู่แล้วแก้เฉพาะคอลัมน์ที่มีในไฟล์ (คอลัมน์ว่าง = ไม่แก้; ค่า `__CLEAR__` = ล้างค่า) |
| MD-285 | Rate card นำเข้าเป็นสถานะ `draft` เสมอ ต้องผ่านอนุมัติ (MD-120); นำเข้าทับ rate card active = สร้างเวอร์ชันใหม่ |
| MD-286 | `all_or_nothing` ทำใน transaction เดียว; `skip_invalid_rows` บันทึกแถวที่ผ่าน และรายงานแถวที่ข้าม |
| MD-287 | ทุกการนำเข้าเป็น 1 audit batch (`importJobId`) ย้อนดูได้ว่ารายการไหนมาจากไฟล์ไหน; ยกเลิกการนำเข้า (rollback) ได้ภายใน 24 ชม. ถ้ารายการที่สร้างยังไม่ถูกอ้างอิง [P1] |
| MD-288 | สถานที่ที่ไม่มี lat/lng → geocode จากที่อยู่ในขั้นตรวจ ผลเป็น "เตือน: พิกัดจาก geocode" ให้ตรวจบนแผนที่ภายหลัง |
| MD-289 | ตรวจโควตา (เช่น จำนวนรถ, custom fields) ก่อนนำเข้า เกิน → error `quota_exceeded` ระดับไฟล์ |

**6. สถานะงานนำเข้า** — `uploaded` → `validating` → `validated` (รอยืนยัน, หมดอายุ 24 ชม.) → `importing` → `completed` / `completed_with_errors` / `failed` / `cancelled`

**7. Event** — `master_import.validated`, `master_import.completed` (แจ้งในระบบ + อีเมลผู้ทำเมื่อเกิน 1 นาที)

**8. กรณีผิดปกติ** — หัวคอลัมน์ไม่ตรง template → ไปขั้นจับคู่ · ไฟล์มีสูตร Excel → ใช้ค่าที่คำนวณแล้ว · เลขผู้เสียภาษีถูก Excel แปลงเป็นตัวเลข (หาย 0 นำหน้า / 1.05E+12) → เติม 0 ให้ครบ 13 หลักถ้าตัวเลขยาว 12 หลัก + เตือน; รูปแบบวิทยาศาสตร์ → error · ข้อมูลถูกแก้ระหว่างรอยืนยัน → ตรวจซ้ำอัตโนมัติก่อนนำเข้า

**9. เกณฑ์ตรวจรับ**
- Given ไฟล์ลูกค้า 200 แถว มี 3 แถว taxId ผิด When ตรวจ Then สรุป ผ่าน 197 / ผิด 3 และดาวน์โหลดไฟล์ที่มีคอลัมน์ผลตรวจได้
- Given `all_or_nothing` และมีแถวผิด When กดนำเข้า Then ปุ่มถูกปิด จนกว่าจะแก้หรือเปลี่ยนเป็น skip
- Given CSV จาก Excel ไทย encoding TIS-620 When อัปโหลด Then อ่านภาษาไทยถูกต้อง
- Given วันที่ "15/11/2569" When dateFormat อัตโนมัติ Then เก็บ 2026-11-15

**10. เฟส** — P0 (ยกเว้น MD-287 rollback = P1)

---

## 12. Event รวม และ [OPEN]

### 12.1 Event ข้อมูลหลัก

| Event | ส่ง webhook | หมายเหตุ |
|---|---|---|
| `customer.created` / `customer.updated` / `customer.deactivated` | P1 (scope `master:read`) | audit ใน P0 |
| `location.created` / `location.updated` | P1 | |
| `rate_card.activated` / `rate_card.expiring` / `rate_card.expired` | P1 | `expiring` ใช้แจ้งเตือนในระบบตั้งแต่ P0 |
| `fuel_price.updated` | ไม่ส่ง | ภายใน |
| `charge.suggested` | ไม่ส่ง | แจ้ง dispatcher |
| `custom_field.*` | ไม่ส่ง (P1: `schema.changed`) | audit |
| `master_import.completed` | ไม่ส่ง | แจ้งผู้ทำ |

### 12.2 คำถามเปิด (ย้ายไป 12-roadmap-open-questions.md)

| รหัส | คำถาม | ผลกระทบ |
|---|---|---|
| OPEN-MD-1 | ลูกค้าบางรายขอให้คิด VAT 7% กับค่าขนส่งด้วย (ตัวเลือก `vat7_bundled`) — ทำได้ตามกฎหมายหรือไม่ เมื่อบริการขนส่งในประเทศได้ยกเว้นตาม ม.81(1)(ณ) และกรณีสัญญารวมขนส่ง+บริการอื่นต้องเสีย VAT ทั้งสัญญาหรือไม่ (research §1.8 "ไม่พบข้อมูล") | enum `freightVatTreatment` |
| OPEN-MD-2 | งานที่มีทั้งรายการยกเว้นและ VAT 7%: ออกใบกำกับภาษีใบเดียวแยกบรรทัด หรือแยก 2 เอกสาร — ให้นักบัญชีเลือกเป็นค่าเริ่มต้น | `taxDocumentSplit`, 05 |
| OPEN-MD-3 | ธง VAT/WHT ของ ค่ารอ, ค่าค้างคืน, ค่าผ่านทางที่เรียกเก็บตามจริง — ถือเป็นส่วนของค่าขนส่ง (ยกเว้น VAT, WHT 1%) หรือค่าบริการ (VAT 7%, WHT 3%) หรือเงินทดรองจ่าย | ชุดเริ่มต้น accessorial |
| OPEN-MD-4 | การจับคู่ประเภทใบขับขี่ (ส่วนบุคคล / ท.1–ท.4) กับประเภทรถและน้ำหนัก และใบชั้นสูงใช้แทนชั้นต่ำได้ทุกกรณีหรือไม่ (รวมรถ 4 ล้อ < 3,500 กก. ที่ใช้รับจ้าง) — ต้องยืนยันกับกฎกรมการขนส่งทางบก | MD-090, PLN-084 |
| OPEN-MD-5 | แหล่งราคาน้ำมันดีเซลอ้างอิงอัตโนมัติ (สนพ./ผู้ค้าน้ำมันรายใด) และเงื่อนไขการใช้ข้อมูล | FSC P1 |
| OPEN-MD-6 | เพิ่มประเภท custom field `lookup` (อ้างข้อมูลหลัก) และ `url` ในชุดแรกหรือไม่ (ต้นแบบมี 14 ประเภท — ยืนยันรายการ 14 ประเภทกับต้นแบบ) | MD §10 |
| OPEN-MD-7 | ลูกค้าเกินวงเงิน: แค่ขออนุมัติยืนยัน SO (MD-027) หรือบล็อกการจัดรถด้วย | MD-027 |
