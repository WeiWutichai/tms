# 00b — Reconcile ข้อกำหนด, ลำดับความสำคัญ/เฟส และเชิงพาณิชย์ (docs v2 ↔ spec)

> จัดทำ 10 พ.ย. 2569 · เทียบ `docs/04-tms-functional-requirements.md` + `docs/02-tms-product-commercial.md` (v2, เจ้าของสินค้า 3–4 พ.ย.) กับ `spec/00–09, 11, 12` (9 พ.ย., เขียนโดยไม่ได้อ่าน docs/) และ `research/decisions.md`, `research/design-briefs.md` (ต้นแบบ)
> กติกาตัดสิน: docs v2 เป็นของเจ้าของสินค้า → ยึดลำดับความสำคัญและรายการ "K สิ่งที่ไม่ทำ" ของ docs เป็นค่าเริ่มต้น; ของที่มีเฉพาะใน spec = ข้อเสนอเฟสถัดไป เว้นแต่ถูกและจำเป็นต่อเกณฑ์ผ่านเฟส 0
> ป้าย: **[ตรง]** สองฝั่งตรงกัน · **[ขัด]** ขัดกันต้องเลือก · **[RB-n]** ต้องให้เจ้าของตัดสิน (หัวข้อ 6) · data model/สถาปัตยกรรม ดู `plan/00a-*.md` ไฟล์นี้ไม่ลงรายละเอียด schema
> ไฟล์นี้ไม่แก้ docs/, spec/, research/ — "ควรเติมที่ spec/xx" คืองานแก้ spec ภายหลัง

## 1. สรุป

1. **แกนตรงกัน:** standalone-first, ERP เป็น connector ไม่ hard-code, สถานะเอกสารแยกจากสถานะซิงก์, ภาษีต่อบรรทัด (ค่าขนส่งยกเว้น VAT / บริการ 7% / WHT 1%–3%), tax point = รับชำระ, เลขออกตอน finalize, รายงานอ่านจาก ledger เดียวกับบิล, user ไม่จำกัด, คิดเงินต่อรถ active, ไม่ผูกสัญญา, e-Tax ผ่าน service provider, ไม่ทำใบกำกับอย่างย่อ
2. **มาตราส่วนเฟสคนละแบบ:** spec "P0 = MVP ขายได้" ≈ docs เฟสขาย 0 + 1 + บางส่วนของเฟส 2 (แอปคนขับ) แต่ **ตัด** สิ่งที่ docs วางเป็นเฟส 0 ออก (KRS connector, Open API เขียน, payment pull) — ใช้ spec P0 เป็นขอบเขตเฟส 0 ไม่ได้ (ตาราง 1.1)
3. **spec ใหญ่กว่า docs เฟส 0 ใน 5 ก้อน:** (ก) one-platform — self-signup + OTP + ตรวจ RD, แพ็กเกจ/entitlement, เรียกเก็บเงิน, Platform Console เต็ม (docs = เฟส 1) (ข) แอปคนขับ M1–M18 + ติดตามรถ + ศูนย์ข้อยกเว้น + แจ้งลูกค้าปลายทาง (docs = P1/เฟส 2) (ค) fleet: ใบสั่งซ่อม, ผลตรวจรถ, น้ำมัน, อุบัติเหตุ (docs = P1/P2) (ง) custom fields เต็มรูป, กล่องรับงาน LINE/อีเมล (จ) AI, MCP, field mapping (docs ไม่มี)
4. **spec เล็กกว่า docs เฟส 0 ใน 4 ก้อน:** (ก) KRS connector = P1 และ "connector ตัวแรก" ยังเปิด (docs: KRS เฟส 0) (ข) Open API + webhook = P1, stops/payments/carriers = P2 (docs G1–G2 = P0) (ค) หลายนิติบุคคล = P1 + ยังเปิดว่า tenant เดียวหรือไม่ (docs A4 = P0, ตัดสินแล้ว) (ง) ไม่มีหน้าใบค้าง + reason code ขาเข้า, จับคู่/alias, `selectionReason`, help center, admin portal หน้า Connectors/Health
5. **พฤติกรรมขัดกันตรง ๆ:** กฎจัดรถ (docs เตือน + override ไม่บล็อก ↔ spec บล็อก + ผู้จัดการอนุมัติ), ตรวจรถก่อนออก (docs P2 ไม่บล็อก ↔ spec P0 ข้อวิกฤตห้ามออกรถ), แอปคนขับ (docs add-on 80 บาท ↔ spec ฟีเจอร์พื้นฐานทุกแพ็กเกจ), ภาษา (docs ไทย P0/อังกฤษ P1 ↔ spec ไทย/อังกฤษ/จีน P0), audit log (5 ปี ↔ 2 ปี), ที่ตั้งข้อมูล (ไทย P0 ↔ ยังเปิด)
6. **เชิงพาณิชย์มีตัวเลข 3 ชุด:** docs/02 350/280/220 (ราคาลดตามขนาด fleet) · decisions + spec seed 249/399/499 + ส่วนลดปริมาณ (ราคาเพิ่มตามฟีเจอร์) · ต้นแบบ ฿390/฿690 (3 ระดับ, placeholder) — ต้นแบบวาง "รถร่วม + Settlement" ไว้ระดับกลาง ซึ่งขัด docs/02 §2 (จ่ายรถร่วม + 50 ทวิ อยู่ Starter) และเจตนาของ K2
7. **docs ขัดกันเอง 3 จุด** (ต้องเคาะด้วย): Open API = P0 ใน docs/04 แต่ "เปิดสาธารณะ" + หน้า API key ลูกค้า = เฟส 2 ใน docs/02; GPS connector ค่ายแรก = P1 ใน docs/04 แต่เฟส 3 ใน docs/02 §3.3/§7; settlement dispute = P0 ใน docs/04 F6 แต่ "settlement dispute flow" อยู่เฟส 3 ใน docs/02 §7
8. **spec ขัดกันเอง 4 จุด:** Open API (07 §5 = P1 ↔ 12 §1 = P0 อ่าน), กล่องรับงาน (03 §1 = P0 ↔ 12 = P1), รายงานกำไร (09 §2 = P1 ↔ 12 = P0), เงินเบิกคนขับ (05 §12 = P1 ↔ 12 = P0); prefix API key (`tms_live_` ใน 07 ↔ `tk_live_` ใน 11)
9. **ความหมายต่อ "เฟส 0":** ฐาน = docs/04 P0 ทั้งชุด (หัวข้อ 5) ซึ่งหนักที่ billing/AP + Open API + connector framework + KRS; ไม่มีแอปคนขับ, ไม่มี self-signup, fleet แค่ทะเบียน + เอกสาร; รับจาก spec เฉพาะรายละเอียดจอ/ฟิลด์/เกณฑ์ตรวจรับของฟังก์ชันที่อยู่ในฐาน และผู้สมัครเพิ่มราคาถูก 9 รายการ (5.2)
10. **ต้องเคาะก่อนเขียนโค้ด:** RB-1 ถึง RB-8, RB-13, RB-15, RB-17, RB-19 (กระทบ schema/ขอบเขตเฟส 0) และ RB-10 ถ้ารับผู้สมัคร 5.2 ข้อ 5; ที่เหลือ (RB-9, RB-11, RB-12, RB-14, RB-16, RB-18) เคาะได้ระหว่างเฟส 0 ก่อนเปิดหน้าราคาเฟส 1

### 1.1 แปลงมาตราส่วน

| มาตราส่วน | นิยาม | เทียบกับอีกฝั่ง |
|---|---|---|
| docs/04 **P0** | ต้องมีเพื่อขาย standalone รายแรก **และ** ขึ้น KRS pilot | = docs/02 เฟสขาย 0 (เริ่ม → +3 เดือน) · ใน spec กระจายเป็น P0 (core, billing, AP) และ **P1/P2** (connector, API เขียน, webhook, stops API, payment pull) |
| docs/04 **P1** | ลูกค้า 10–200 คันไม่ต่ออายุถ้าไม่มี | = docs/02 เฟส 1 (trial flow, FlowAccount/PEAK, help center) + เฟส 2 (Driver app M1–M9, API สาธารณะ, e-Tax SP, marketplace) · ใน spec หลายตัวเป็น **P0** (แอปคนขับ, ใบสั่งซ่อม, น้ำมัน, อุบัติเหตุ, แจ้งลูกค้า, แผนที่ติดตาม, rate card approval, fuel surcharge) |
| docs/04 **P2** | สร้างความต่าง/ขยายตลาด | = docs/02 เฟส 3+ (GPS ค่าย 2+, DVIR, cascade, optimizer, portal) · ใน spec ส่วนใหญ่ P2 ยกเว้น ตรวจรถก่อนออก = **P0** |
| spec **P0** "MVP ขายได้" | pilot 1 รายทำครบวงจร 1 เดือนไม่ใช้ Excel + นักบัญชียืนยัน (ไม่มีเกณฑ์ KRS) | ≈ docs เฟส 0 (ลบ KRS/API เขียน) + เฟส 1 (self-signup, แพ็กเกจ, Console) + เฟส 2 บางส่วน (แอปคนขับ) |
| spec **P1** "หลังเปิดขาย" | — | ≈ docs เฟส 1–2 (connector ตัวแรก, Open API, MCP, Opn) |
| spec **P2** "ขยาย" | — | ≈ docs เฟส 3+ |

เกณฑ์ผ่านเฟส 0 ที่ใช้ทั้งไฟล์ (docs/02 §7): KRS ปิดงวด 2 เดือนติด MISMATCH ค้าง = 0 **และ** tenant standalone ทดสอบออกใบกำกับภาษี + 50 ทวิ ครบ 1 รอบเดือนโดยนักบัญชีของเขายอมรับ

## 2. ตารางเทียบรายโมดูล

รูปแบบ: (a) อยู่ใน docs/04 แต่ spec ไม่มี/ไม่ครบ → ไฟล์ spec ที่ควรเติม · (b) อยู่ใน spec แต่ docs/04 ไม่มี → เฟสที่เสนอ · (c) ลำดับความสำคัญไม่ตรง

### A. Platform & Auth (spec/01, 11)

**(a) docs มี — spec ไม่มี/ไม่ครบ**
- A3 role **Invoicer** แยกจาก Accounting, **Planner** แยกจาก Dispatcher, principal **Carrier portal / Customer portal** (P0) — spec มี owner/admin, manager, dispatcher, accounting, fleet, approver, developer, viewer → spec/01 §12 [RB-17]
- A3 "ผู้สร้างใบแจ้งหนี้ finalize ใบตัวเองไม่ได้" (separation of duties, P0) — spec มีเฉพาะ rate card (02) และวงเงิน settlement (BIL-137) → spec/05 §3, §11
- A4 `legal_entity` หลายนิติบุคคลใน tenant + "Invoice As / Tender As" (P0) — spec/01 §13.2 หลายนิติบุคคล = P1 และ [OPEN] Q-A11 ทั้งที่ spec/05 มี `legalEntityId` / `issuingBranchId` / `defaultIssuingBranchId` บนเอกสารแล้ว; ไม่มี Tender As ฝั่งรถร่วม → spec/01 §13.2, 02 §8 [RB-13]
- A4 Group view รวมทุกนิติบุคคล (P1) — spec มีตัวกรองนิติบุคคล/สาขาในรายงาน (RPT-004) ไม่ระบุมุมมองรวมกลุ่ม → spec/09 §0
- A5 Setup checklist ต้องมีขั้น "เลขเอกสาร" และ "ภาษี default" (P0) — checklist ของ spec (ตั้งค่าบริษัท → รถ → คนขับ → ทีม → SO แรก → เชื่อมบัญชี) ไม่มีสองขั้นนี้ → spec/01 §4
- A6 impersonate ต้อง **อีเมลแจ้ง tenant owner ทุกครั้ง** (P0) — spec ให้ลูกค้าดูรายการ session ย้อนหลัง (PLT-124) และยังเปิด Q-A17 → spec/01 §11
- docs/02 §5 Admin Portal หน้า **Connectors** (เปิด/ปิด connector ต่อ tenant, credential, healthCheck, outbox/sync log ข้าม tenant) และ **Health** (คิวค้าง, MISMATCH, poller, error rate) — เฟส 0 ตาม §7; spec §10 ไม่มีสองหน้านี้ → spec/01 §10
- A1 magic link แบบรวมศูนย์ (HMAC + หมดอายุ + จำกัด action + revoke, P0) — spec มี token แยกราย feature (EXE-E, EXE-D) ไม่มีข้อกำหนดกลาง → spec/11 §2.3
- A7 audit log เก็บ **5 ปี** — spec PLT-128 / NFR-404 = 2 ปี [ขัด, RB-15]
- A1 รหัสผ่าน ≥ 12 ตัว, refresh 7 วัน, idle 8 ชม. — spec ≥ 10 ตัว, refresh 30 วัน, idle 12 ชม. [ขัด, RB-15]

**(b) spec มี — docs ไม่มี**
- PLT-010–019 วงจรสถานะ tenant 7 ค่า + dunning 7/21/60 วัน (spec P0) → schema เฟส 0, cron/banner เฟส 1
- PLT-020–026 สมัครเอง 3 ขั้น + OTP + ตรวจ RD + dedup `(taxId, branchCode)`; §10.3 คิวอนุมัติ (spec P0) → เฟส 1 [RB-5]
- PLT-060–066 `Plan/PlanVersion/PlanEntitlement/AddOn/Override` แบบมีเวอร์ชัน (spec P0) → schema + guard เฟส 0 (ต่อจาก A5 "feature flag ตาม plan"), ตัวแก้ matrix เฟส 1
- PLT-070–075 ตัวนับรถ active จากทะเบียนบนเอกสารที่ปิดงาน (spec P0) → ผู้สมัครเฟส 0 (5.2 ข้อ 5); PLT-076–082 เมนู 🔒 + โควตา → เฟส 1
- PLT-090–098 หน้าแพ็กเกจ/ชำระเงิน, สลิป, ใบกำกับภาษีของแพลตฟอร์ม (spec P0), Opn/PromptPay (P1) → เฟส 1 [RB-5]
- §10.4–10.7 ตัวแก้ feature matrix, add-on/คูปอง, การเงินแพลตฟอร์ม, usage API/AI → เฟส 1–2
- PLT-120–125 impersonate โหมด read_only/full, หมดอายุ 60 นาที, รายการที่ห้ามทำ → รับเป็นรายละเอียดของ A6 (เฟส 0 เฉพาะ read_only)
- 01 §13.5 ตารางกฎแจ้งเตือน event × ผู้รับ × ช่องทาง → เฟส 1 (เฟส 0 ใช้ค่าตั้งต่อผู้ใช้ตาม docs I)

**(c) ลำดับความสำคัญไม่ตรง**

| รายการ | docs/04 · docs/02 | spec | ข้อเสนอ |
|---|---|---|---|
| หลายนิติบุคคล/สาขา + series ต่อนิติบุคคล×สาขา | A4 P0 · เฟส 0 | สาขา P0, นิติบุคคล P1 + OPEN | P0 ตาม docs (KRS ใช้หลายบริษัท) [RB-13] |
| สมัครเอง / trial flow | เฟส 1 | P0 | เฟส 1; เฟส 0 ทีมเราสร้าง tenant [RB-5] |
| หน้าแผนและการชำระเงิน, ออกบิลลูกค้า | เฟส 1 (ออกบิลมือถึง 10 tenant) | P0 สลิป + PDF, P1 Opn | เฟส 1 [RB-5] |
| สิทธิ์ระดับฟิลด์ราคาขาย/ราคาซื้อ | A3 P0 (tier: Growth+) | P1 (PLT-134) | P0 เฉพาะ 2 ฟิลด์นี้ (ลิงก์รถร่วมต้องซ่อนราคาขายอยู่แล้ว) |
| User อยู่หลาย tenant | A2 P1 | P0 (Membership) | โครง Membership เฟส 0, UI สลับบริษัทเฟส 1 |
| Custom role | P1 | P1 | [ตรง] |
| SSO | P2 | P2 | [ตรง] |
| IP allowlist | P1 (admin เรา + API key) | P1 (+เว็บลูกค้า) | [ตรง] |

### B. Master data (spec/02)

**(a) docs มี — spec ไม่มี/ไม่ครบ**
- "เส้นทาง (route / OD pair)" เป็น master แยก: ระยะทาง, เวลามาตรฐาน, ค่าผ่านทาง (P0) — spec เก็บระยะทางในบรรทัด rate card ไม่มี entity → spec/02 §5
- Location "alias หลายตัว" + C "เรียนรู้ alias" (P0) — spec ไม่มี alias (กล่าวถึงเฉพาะใน 08 AI) → spec/02 §2
- "ผังรหัส ERP (master code) sync ลงมาจาก ERP" (P0 สำหรับ KRS) — spec 07 §1 Mapping / §3 = P1 → spec/07 [RB-3]
- B1 "สถานะคำนวณ `pricingStatus` AVAILABLE / RATE_MISSING / CALCULATION_FAILURE + breakdown" (P0) — spec มีแค่ "ไม่พบเรท"/บรรทัด pending ไม่เป็น enum → spec/02 §5, 03 §2
- "Vehicle-type compatibility matrix" (P0) — spec กระจายเป็นกฎ (MD-090 ชั้นใบขับขี่, MD-054 ข้อจำกัดสถานที่, MD-072 อุณหภูมิ, hazmat) ครอบคลุมเทียบเท่า ไม่มี matrix ประเภทงาน → ยอมรับแบบ spec, เติมหมายเหตุที่ spec/02 §4
- Carrier: parent carrier, "จ้างในนาม (Tender As)" (P0) — ไม่มี → spec/02 §8
- ลูกค้า: ตรวจ e-Tax readiness ผ่าน RD (P1) — ไม่มี → spec/02 §1

**(b) spec มี — docs ไม่มี**
- MD-230–279 custom fields 13 ชนิด + ตัวเลือกแสดงผล + API (spec P0 โครง) — docs มีแค่ C "Custom fields 3–5 ช่องต่อ tenant" P1 → P1 แบบย่อ; เต็มรูปเฟส 2 [RB-16]
- Rate card แบบมีเวอร์ชัน + อนุมัติ (spec P0), zone (P1), rate-quote API → อนุมัติ P1 ตาม docs; zone เฟส 2
- `FuelSurchargeTable` + ราคาอ้างอิง (spec P0 manual) → P1 ตาม docs B1
- MD-180–199 ผู้ขาย/อู่ (spec P1) → P1 พร้อมใบสั่งซ่อม
- MD-027 / BIL-122 credit hold / วงเงินเครดิตลูกค้า → P1 (Q-A14)
- MD-028/029 shipper API key ต่อลูกค้า → เฟส 2+ (ดู G)
- MD-287 ยกเลิกการนำเข้าใน 24 ชม. → P1

**(c) ลำดับความสำคัญไม่ตรง**

| รายการ | docs/04 | spec | ข้อเสนอ |
|---|---|---|---|
| อนุมัติ rate card ก่อนใช้ | P1 (P0 = ACTIVE ทันทีโดย Admin) | P0 | P1; เฟส 0 เก็บ snapshot ลงเอกสาร |
| สูตรเหมาวัน (PER_DAY) | P1 | P0 (enum `per_day`) | P1 |
| Fuel surcharge | P1 | P0 | P1 |
| ผังรหัส ERP sync | P0 (KRS) | P1 | P0 เฉพาะผ่าน adapter ที่เปิด |
| Custom fields | P1 (3–5 ช่อง) | P0 โครง / P1 API | P1; เฟส 0 สำรองคอลัมน์ (5.2 ข้อ 6) |
| ลูกค้า, Carrier, รถ, คนขับ 3 ประเภท, location, accessorial, reason master, import dry-run | P0 | P0 | [ตรง] |

### B2. Fleet (spec/06)

**(a) docs มี — spec ไม่มี/ไม่ครบ**
- **`vehicle_cost` ledger เดียว** — ทุกบาทที่เกิดกับรถลงตารางเดียว (B2 สรุป, B2.3 H, docs/01 §3.8; P1) — spec ไม่มี ledger, FLT-003 คำนวณต้นทุน/กม. จากหลายตาราง → spec/06 §1, 09 §8 (ต้องยึด docs เมื่อทำ fleet P1; ดู 00a)
- ค่าเสื่อมราคารายเดือนลง ledger (ส่วน 1) — spec มี `depreciationMethod` แต่รายงานตั้งค่าเริ่มต้น "ไม่รวมค่าเสื่อม" (RQ5) → spec/09 §8 [ขัด]
- รถร่วม "อัปโหลดเอกสารเองผ่านลิงก์ LINE" (P0) — spec FLT-045 = P1 → spec/06 §3
- ส่วน 7 utilization % และรายงาน "รถควรปลดระวาง" (P1) — spec มี TCO (P2) แทน → spec/09 §8
- B2.3 G: sub-resource `/vehicles/{id}/documents|work-orders|fuel-logs|costs` + webhook `work_order.status_changed` (P1) — spec มีเฉพาะ `vehicle.document_expiring` → spec/07 §5.1

**(b) spec มี — docs ไม่มี**
- FLT-B หางเป็นทรัพย์สินแยก มีเอกสาร/PM/ยางของตัวเอง + ประวัติการพ่วง (spec P0) — docs มี "หัวลาก–หาง จับคู่" ในทะเบียน P0 → รับส่วนเอกสารหางเข้าเฟส 0 (5.2 ข้อ 7)
- FLT-G ยาง (P1), FLT-J ถังน้ำมันบริษัท (P2), FLT-L ใบสั่ง/ค่าปรับจราจร + หักคนขับ (P1), FLT-M คะแนนการขับ (P2), FLT-N ลีสซิ่ง/เช่าซื้อ (P1) → ทั้งหมด P2 (เฟส 3+) จนกว่ามีลูกค้าขอ
- FLT-O ประวัติเลขไมล์ทุกแหล่ง + ตรวจกระโดด (spec P0) → เฟส 0 เก็บเฉพาะเลขไมล์ปัจจุบัน (docs ส่วน 1); ประวัติ P1
- FLT-E วงเงินอนุมัติหลายลำดับ, FLT-K ที่มาเคส 4 แหล่ง → รายละเอียดของ P1
- 06 §18 รหัสเหตุห้ามจ่ายงาน → ดู D [RB-6]

**(c) ลำดับความสำคัญไม่ตรง**

| รายการ | docs/04 | spec | ข้อเสนอ |
|---|---|---|---|
| ทะเบียนรถขยาย + เอกสาร + เตือน 60/30/7 + หน้าเอกสารรวม | P0 | P0 (FLT-A, FLT-C) | [ตรง] |
| รถร่วมแบบย่อ (เอกสารบังคับก่อนรับงาน, บล็อก assign) | P0 | P0 (กฎ PLN-080) | [ตรง] |
| PM ตามแผน | P1 | P1 (รายการครบกำหนดแบบง่าย P0) | P1 |
| ใบสั่งซ่อม (WO) | P1 | **P0** (FLT-E) | P1 [RB-7] |
| น้ำมันและค่าใช้จ่าย | P1 | **P0** บันทึก (FLT-I) | P1 [RB-7] |
| อุบัติเหตุ/เคลม | P1 | **P0** เคส / P1 เคลม (FLT-K) | P1 [RB-7] |
| DVIR / ผลตรวจรถก่อนออก | **P2** (ส่วน 9, M7; ไม่บล็อก) | **P0** (FLT-F; ข้อวิกฤตบล็อกเริ่มเที่ยว PLN-082) | P2; พฤติกรรมตาม docs [RB-7] |
| อะไหล่/สต็อก | P2 แบบง่าย (K20); บรรทัดอะไหล่ใน WO = P1 | P2 แบบต้นทุนเฉลี่ยถ่วงน้ำหนัก + ปรับยอดนับจริง (FLT-140–144) | P2 แบบง่ายตาม K20 [RB-18] |
| ต้นทุน/กำไรต่อคัน | P1 | P1 (KPI), TCO P2 | P1 ผ่าน `vehicle_cost` |

### C. Order intake (spec/03 §1–3)

**(a) docs มี — spec ไม่มี/ไม่ครบ**
- **"หน้าใบค้าง + reason code ครบชุด" 12 รหัส (P0)** — spec ไม่มีหน้ารวม: คอลัมน์ "SO รอจัด" มีป้ายเหตุผล 5 แบบ (ไม่มีรถว่าง / เกินความจุ / รถร่วมปฏิเสธ / ที่อยู่ผิด / หลุดช่วงเวลา) ที่เหลือกระจายอยู่ที่กฎห้ามจ่ายงาน, ศูนย์ข้อยกเว้น, แท็บ "ราคายังไม่ครบ"; ไม่มีรหัสขาเข้า `CUSTOMER_UNMAPPED`, `LOCATION_UNMAPPED`, `SOURCE_CHANGED_AFTER_PLAN`, `SOURCE_ERROR`, `RESCHEDULES_EXHAUSTED` → spec/03 (หัวข้อใหม่) — จำเป็นต่องานขาเข้าจาก KRS
- "จับคู่อัตโนมัติ" ลูกค้า (externalId), สถานที่ (alias + fuzzy), rate card → `pricingStatus` (P0) — spec มีเฉพาะผ่าน AI (08, P1) → spec/03 §2
- "ยกเลิก/คืนสถานะ: ERP แก้หลังวางแผน → ใบค้าง ไม่ทับอัตโนมัติ" (P0) — ไม่มี → spec/03 §2, 07 §2
- "รับจาก ERP connector เรียก upsert เดียวกับ API" + "Upsert ด้วย external id" (P0) — spec ORD-020 กล่าวถึงแต่ API/connector เป็น P1 → [RB-3], [RB-4]
- "กรอกมือ: template งานประจำ" (P0), "งานประจำ (recurring)" (P1) — spec มีเฉพาะ "คัดลอกเป็นใบใหม่" (ORD-022) → spec/03 §2
- "รับจาก customer portal" (P2) — spec ไม่มี portal (ใช้ shipper API key แทน) → คง P2
- Edit lock หมดอายุ 10 นาที + สิทธิ์ `orders.unlock` — spec ORD-031 heartbeat 2 นาที, manager ปลดล็อก → เทียบเท่า ยึดรายละเอียด spec

**(b) spec มี — docs ไม่มี**
- ORD-001–011 กล่องรับงาน (LINE OA, อีเมล, upload) — 03 §1 ระบุ P0 แต่ 12 §1 ระบุ P1 → เฟส 2 พร้อม AI รับงาน [RB-16]
- ORD-007 เตือน PO ลูกค้าซ้ำใน 90 วัน → ถูก; ผู้สมัครเฟส 0 (5.2 ข้อ 9)
- ORD-030 ด่านยืนยัน SO (ลูกค้าไม่ credit hold, พิกัดครบ, มีราคา), ORD-035 ค่ายกเลิก → P1 (Q-A14, Q-A15)
- ORD-081 สร้าง DO อัตโนมัติ 1 ใบต่อจุดส่งจาก `itemAllocations`; ORD-088 `billingBasis` per_do/per_trip/per_so → สอดคล้อง docs/01 "SO → trip → DO"; ชื่อ resource API ต่างกัน (docs `orders` เดียว ↔ spec `orders` + `shipments`) → ดู 00a

**(c) ลำดับความสำคัญไม่ตรง**

| รายการ | docs/04 | spec | ข้อเสนอ |
|---|---|---|---|
| รับ order จาก Open API | P0 | P1 (07 §5.1) | P0 [RB-4] |
| รับ order จาก ERP connector | P0 (KRS) | P1 | P0 [RB-3] |
| Import Excel + dry-run, กรอกมือ, แยก/รวม, edit lock | P0 | P0 | [ตรง] (merge DO = P1 ใน spec ยอมรับ) |
| Custom fields บน order | P1 | P0 | P1 |
| กล่องรับงาน LINE/อีเมล | — | P0/P1 | เฟส 2 |

### D. Planning & Dispatch (spec/03 §4–9)

**(a) docs มี — spec ไม่มี/ไม่ครบ**
- D2 "ตรวจ constraint ตอนจัด — **เตือน + override พร้อมเหตุผล ไม่บล็อก**" (P0) — spec §6 เป็น "กฎห้ามจ่ายงาน" 22 รหัส ส่วนใหญ่ **บล็อก** และหลายข้อ override ไม่ได้ → [ขัด, RB-6]
- D3 "บันทึกเหตุผลการเลือก `selectionReason`" ทุกการจ้าง carrier (P0) — ไม่มี → spec/03 §8
- D2 View "ตามคนขับ / ตาม carrier" (P0) — กระดานของ spec เป็นแถวรถอย่างเดียว (รถบริษัท → รถร่วม) → spec/03 §5
- D2 "Filter รถที่รับได้สองทาง" (P0) — spec ไฮไลต์ทางเดียว (เลือกงาน → รถที่รับได้) → spec/03 §5
- D2 "ตารางรถ/คนขับรายวัน (คลิกขวาใส่วันลา/โน้ต)" (P0) — spec บันทึกลาเป็นช่วงวันที่ในหน้าคนขับ (FLT-302) ไม่มีตารางภาระงานรายวันและโน้ตบนกระดาน → spec/03 §5
- D4 ปันส่วนต้นทุน/รายได้ (P1), D1 Leg ผ่าน hub (P1), D2 Priority 4 ระดับ (P1) — spec มีบางส่วนใน 09 §2 (ตัวเลือกแบ่งต้นทุน P2) → spec/03, 09
- D2 VRP ผ่าน engine ภายนอก (P2) — spec 08 §9 ระยะ 3 ใช้ solver ในระบบ → [RB-18]

**(b) spec มี — docs ไม่มี**
- PLN-080–092 `DispatchOverride` (ขอ → ผู้จัดการอนุมัติ, ใช้ได้เฉพาะเที่ยวนั้น, ประเมินซ้ำด้วย job เบื้องหลัง) → [RB-6]
- PLN-045 กระดาน real-time (websocket ≤ 2 วิ) + มุมมองวันนี้/7 วัน → รับเป็นรายละเอียดของ D2 (docs G3 "UI subscribe realtime")
- PLN-130–169 โหมดไล่ลำดับ, broadcast (P1), เสนอราคากลับ (P2), ยืนยัน OTP เบอร์รถร่วม (P1) → cascade P1, ที่เหลือ P2
- DRV-M11 คนขับรับ/ปฏิเสธงานใหม่ + timeout → มากับแอปคนขับ
- PLN-170–189 "ส่งแผนให้คนขับ" = docs "Send all" + "ใบงานประจำวัน" → [ตรง], ตั้งเวลาส่ง P1

**(c) ลำดับความสำคัญไม่ตรง**

| รายการ | docs/04 · docs/02 | spec | ข้อเสนอ |
|---|---|---|---|
| Cascade P1 → P2 อัตโนมัติ | P1 · เฟส 3 | 03 §8: "cascade ส่งทีละรายอัตโนมัติ" P0 (สารบัญไฟล์เดียวกันเขียน P1) | P1; เฟส 0 = ส่งทีละราย + หมดเวลาแจ้ง + ปุ่มส่งรายถัดไป |
| Margin ต่อ carrier / simulator | P1 | P0 (แสดงในข้อเสนอ) | P1 |
| เสนอรถ (rule-based) | P1 | P1 | [ตรง] |
| Saved views | P1 | P1 | [ตรง] |
| จ่ายงานรถร่วมผ่านลิงก์ LINE/SMS | P0 | P0 | [ตรง] (ลิงก์ 48 ชม. ทั้งคู่) |
| Assign vs Dispatch, multi-drop, เวลาขัดกันขึ้นแดง | P0 | P0 | [ตรง] |

### E. Execution & POD (spec/04 EXE)

**(a) docs มี — spec ไม่มี/ไม่ครบ**
- E2 POD checklist ชนิด BOOLEAN / SINGLE_CHOICE / PIN / RATING (P0) — `PodProfile` ของ spec มี photo, paperDoPhoto, signature, recipientName, actualQty, barcodeScan, note, cod → spec/04 §13 (เฟส 0 ใช้ชุดของ spec ได้; เติม 4 ชนิดเมื่อมีลูกค้าขอ)
- E2 "Undelivered-retain + auto-reschedule + นับครั้ง → `RESCHEDULES_EXHAUSTED`" (P0) — spec ORD-087 มี 3 ทางเลือก ไม่มีตัวนับ → spec/03 §3
- E2 "Tracking link: ผู้รับกรอกเลข DO/PO" (P0) — spec EXE-D ลิงก์ต่อ DO + หน้าค้นด้วยเลข DO ที่ต้องกรอกเบอร์ผู้รับ 4 ตัวท้าย (EXE-062); ไม่มีค้นด้วยเลข PO → ยึด spec (ปลอดภัยกว่า), เติม PO ที่ spec/04 §4
- E2 "หลายคนขับต่อเที่ยว + เลขตู้" (P1) — spec มี coDriver (P1) ไม่มี `containerNo` (ให้ใช้ custom field) → ยอมรับ
- E1/E2 สถานะผ่านเว็บ, ePOD ผ่านเว็บ, actual qty, ตีกลับ, ค่าใช้จ่ายหน้างาน, ePOD ผ่านลิงก์ — spec มีครบ (`web_on_behalf`, S5, M15) [ตรง]

**(b) spec มี — docs ไม่มี**
- EXE-B **ศูนย์ข้อยกเว้น** 13 ประเภท + เจ้าของ + SLA + ปิดอัตโนมัติ (spec P0) — docs ใช้ "ใบค้าง + reason code" + แจ้งเตือน + dashboard → P1 (เฟส 1–2); เฟส 0 ใช้หน้าใบค้าง [RB-16]
- EXE-C แจ้งลูกค้าปลายทางพร้อม template 3 ภาษา + โควตา SMS/LINE (spec P0) → P1 ตาม docs
- EXE-A แผนที่สด + ETA + สัญญาณขาด จากตำแหน่งแอป (spec P0) → มากับแอปคนขับ [RB-14]
- EXE-E S6 ดูการเงินต้องยืนยัน OTP เบอร์รถร่วม — docs ใช้ magic link อย่างเดียว → รับ (ความปลอดภัยเพิ่ม, ถูก)
- `PodProfile.paperDoSubstitutesSignature` (รูปใบส่งของที่เซ็นแล้วแทนลายเซ็น), ฟิลด์ COD + `COD_MISMATCH` → ข้อแรกเป็นผู้สมัครเฟส 0 (5.2 ข้อ 8); COD = P1 (docs H "Cash/COD reconciliation" P1)

**(c) ลำดับความสำคัญไม่ตรง**

| รายการ | docs/04 · docs/02 | spec | ข้อเสนอ |
|---|---|---|---|
| หน้าติดตามรถ (แผนที่) | P1 | P0 | P1 พร้อมแอปคนขับ [RB-14] |
| GPS connector ค่ายแรก | docs/04 P1 · docs/02 เฟส 3 (ขัดกันเอง) | P1 | [RB-14] |
| แจ้งลูกค้าปลายทาง SMS/LINE/อีเมล | P1 | P0 (SMS/อีเมล), P1 LINE | P1 |
| Geofence เตือนไม่บล็อก | P1 | P0 (ในแอป) | ตามแอปคนขับ |
| Detention อัตโนมัติ | P1 | P1 | [ตรง] |
| Tracking link สาธารณะ | P0 | P0 (แผนที่ P1) | [ตรง] |
| ePOD เว็บ + ลิงก์รถร่วม | P0 | P0 | [ตรง] |

### E2. Driver app (spec/04 DRV)

**เลขจอชนกัน:** docs M10 = ลิงก์รถร่วม (web ไม่ login) · spec M10 = จอสิทธิ์และ PDPA และใช้ S1–S6 (EXE-E) เป็นหน้ารถร่วม · spec เพิ่ม M11–M18 → ข้อเสนอ: ยึดเลข docs (M1–M10), S1–S6 = รายละเอียดของ M10, จอ PDPA ของ spec เปลี่ยนเป็นเลขใหม่, M11–M18 คงเลข

**(a) docs มี — spec ไม่มี/ไม่ครบ**
- E2.2 Usability test กับคนขับจริง ≥ 5 คนก่อนปล่อยทุก release ใหญ่ (P1, K9) — spec ไม่มี → spec/04 §6, 11 §16 [RB-18]
- E2.2 "Android ก่อน iOS ≥ 1 เฟส" — spec ระบุ iOS/Android พร้อมกัน → spec/04 §6
- E2.2 รูป: ประทับ timestamp + พิกัดเป็น **ลายน้ำบนรูป** + EXIF — spec DRV-166 เก็บใน metadata "ไม่ใส่ลายน้ำ" [ขัด] → ยึด docs (หลักฐานอ่านได้จากรูปเดียว)
- E2.2 ปุ่มหลัก 56 px, เป้าสัมผัส ≥ 48 px, APK ≤ 40 MB — spec 52 px / 44 px / ≤ 50 MB → ยึด docs
- M9 ภาษาเมียนมา/กัมพูชา (P2) — spec ใช้ TH/EN/中文 → [RB-12]
- 02 §3.3 แอปเป็น **add-on 80 บาท/คนขับ active/เดือน** — spec `driver_app` เป็นฟีเจอร์พื้นฐานทุกแพ็กเกจ → [RB-2]

**(b) spec มี — docs ไม่มี**
- M11 รับ/ปฏิเสธงานใหม่ · M12 ขึ้นของที่ต้นทาง (+สแกน P1) · M13 ส่งไม่สำเร็จ/บางส่วน (docs รวมใน M4) · M14 เวลารอ 3 จังหวะ · M15 ฟอร์มค่าใช้จ่าย (+OCR) · M16 จบเที่ยว · M17 คิวออฟไลน์ · M18 ข้อความจากฝ่ายจัดรถ · DRV-ST สถานะพิเศษ 5 แบบ → รับเป็นสเปกจอของเฟส 2
- ออฟไลน์ ≥ 72 ชม., คิว ≥ 1,000 event / 300 MB, อัปโหลด resumable, รองรับเวอร์ชัน N-2 + บังคับอัปเดต (NFR-801–808) — docs: ใช้ได้ทั้งวัน, ไฟล์ค้าง ≤ 500 MB → รับของ spec (เข้มกว่า) ยกเว้นเพดานไฟล์ใช้ 500 MB
- DRV-008 custom fields ในแอป, COD ในแอป → เฟส 2+

**(c) ลำดับความสำคัญไม่ตรง**

| รายการ | docs/04 · docs/02 | spec | ข้อเสนอ |
|---|---|---|---|
| M10 ลิงก์รถร่วม (รับ/ปฏิเสธ + POD ด้วยเลข DO) | **P0 · เฟส 0**, ฟรีทุกแพ็กเกจ | P0 (EXE-E S1–S5) | [ตรง] |
| แอปคนขับ M1–M6, M8–M9 | **P1 · เฟส 2** (เดือน 8–12), add-on | **P0** ทุกจอ M1–M18, พื้นฐานทุกแพ็กเกจ | เฟส 2 ตาม docs [RB-2] |
| M7 DVIR | **P2 · เฟส 3**, ไม่บล็อก | **P0**, บังคับ + บล็อกเมื่อข้อวิกฤตไม่ผ่าน | P2 [RB-7] |
| เลือกเทคโนโลยีแอป | ก่อนเริ่มเฟส 2 | "เริ่ม P0" (Q-D2) | ก่อนเฟส 2 (ไม่กระทบ API) |
| Login คนขับ OTP | P1 | P0 | ตามแอป |

### F. Billing & Settlement (spec/05)

**(a) docs มี — spec ไม่มี/ไม่ครบ**
- F1 "รายการ VAT ปนยกเว้น: ใบเดียวแยกบรรทัด **หรือ** 2 เอกสาร — ตั้งค่าต่อ tenant" (P0) — spec ตั้งค่าเริ่มต้น 2 ใบ (RC + RT) [PROPOSED] และยังเปิด Q-A18 → spec/05 §1, §5 [RB-9]
- F1 โหมด `issue_early` ออกใบกำกับพร้อมใบวางบิลเมื่อลูกค้าขอ (P0) — spec ยังเปิด Q-B4 → spec/05 §5 [RB-9]
- F3 Finalize ตรวจ separation of duties (P0) — ไม่มีสำหรับใบแจ้งหนี้ → spec/05 §3
- F4 สถานะ **RELEASED (ส่งบัญชี)** + กฎย้อนสถานะตาม role/เวลา (Dispatcher ภายใน 24 ชม.) (P0) — spec มี NOT_READY → READY → DRAFTED → INVOICED ไม่มีขั้น release → spec/05 §2
- F5 "Payment status จาก ERP" (P0 สำหรับ KRS) — spec INT-026 = P1 → [RB-3]
- F6 "รถร่วมตรวจผ่านลิงก์ + โต้แย้งรายการ" และ "Dispute" (P0) — spec §11.12: ดูเอกสารผ่านลิงก์ P0, โต้แย้งรายบรรทัดผ่านลิงก์ P1 → [RB-8]
- F6 Approve: ผู้สร้างอนุมัติเองไม่ได้ + step-up 2FA เกินวงเงิน (P0) — spec มีวงเงินตามตำแหน่ง (BIL-137) ไม่ระบุ SoD → spec/05 §11
- F6 ไฟล์โอนธนาคาร bulk payment CSV (P1) — ไม่มี → spec/05 §11.7
- F7 ค่าเที่ยวคนขับ `EMPLOYEE_PER_TRIP` → ใบจ่ายรายงวด (P1) — spec ส่งออกยอดไปเงินเดือนอย่างเดียว (BIL-116, §13; Q-A12) → spec/05 §13
- F9 "data model map เป็น ETDA CII ตั้งแต่ P0" — spec §17 e-Tax = P2 ระบุฟิลด์ไว้ → ต้องเก็บฟิลด์ตั้งแต่เฟส 0 แม้ฟีเจอร์เป็น P1/P2

**(b) spec มี — docs ไม่มี**
- BIL-093 **ACN/ADN** ใบปรับลด/เพิ่มยอดใบแจ้งหนี้ที่ยังไม่มีใบกำกับภาษี (spec P0) — docs F2 บังคับใบลดหนี้อ้างเลขใบกำกับเดิมและบอกให้ใช้ "เอกสารปรับปรุงภายใน" เมื่อไม่เข้าเหตุ แต่ไม่ได้นิยามเอกสารนั้น → ผู้สมัครเฟส 0 (5.2 ข้อ 1)
- §14 รายงานภาษีซื้อ + BIL-139 บันทึกใบกำกับของรถร่วมที่จด VAT (spec P0) → ผู้สมัครเฟส 0 (5.2 ข้อ 3)
- §14 Journal CSV + `glAccountRevenue/Cost` (P1), BIL-175 ล็อกงวด (P1) → เฝ้าระวัง K17 [RB-18]; ล็อกงวด P1
- BIL-062 กระทบยอด statement ธนาคาร, AI อ่านสลิป (P1) → เฟส 2
- BIL-138 รถร่วมไม่ตอบ N วัน = ถือว่ายืนยัน (P1) → P1 พร้อม dispute ผ่านลิงก์
- §13 รายการหักคนขับ → ส่งออกเงินเดือน (P1) — docs F7 "ค่าแรง/เบี้ยเลี้ยง → HR" = P2 → P2
- BIL-133 ยอดสุทธิติดลบยกไปงวดถัดไป, เอกสาร PV / CA แยกชนิด → รับเป็นรายละเอียด

**(c) ลำดับความสำคัญไม่ตรง**

| รายการ | docs/04 · docs/02 | spec | ข้อเสนอ |
|---|---|---|---|
| Settlement dispute ผ่านลิงก์ | docs/04 F6 P0 · docs/02 §7 เฟส 3 (ขัดกันเอง) | P1 | [RB-8] |
| ภ.ง.ด.3/53 export | docs/04 P1 · docs/02 ตาราง tier: อยู่ Starter | P0 (สรุป WHT CSV) | CSV ทั่วไปเข้าเฟส 0 (5.2 ข้อ 2); รูปแบบ RD Prep = P1 |
| ใบแทน | P1 | P0 | P1 |
| Cash advance | P1 | 05 §12 P1 (12 §1 เขียน P0) | P1 |
| e-Tax ผ่าน SP | P1 · เฟส 1 ปลาย–2 เมื่อลูกค้าถาม ≥ 3 ราย | P2 | P1 ตาม docs (มีเงื่อนไขเดิม) |
| Excel ค่าจ้างรถร่วม 3 sheet | P1 | P1 | [ตรง] |
| Invoice run (async) | P0 | UI P0; API `invoice-runs` P2 | P0 |
| AR 6 เอกสาร, รับชำระ, aging, settlement + WHT + 50 ทวิ, รายงานภาษีขาย | P0 | P0 | [ตรง] |

### G. Open API & Integration (spec/07, 08)

**(a) docs มี — spec ไม่มี/ไม่ครบ**
- **G1 ทั้งชุด = P0** (auth OAuth2 client credentials + static key, idempotency, external id, ETag, webhook + ops, RFC 9457, cursor, versioning, rate limit, sandbox, OpenAPI + TypeScript SDK, bulk/async) — spec 07 §5–10 = **P1** (OAuth P1, bulk/async P2, SDK P2) → [RB-4]
- **G2 resource P0:** `stops` (arrive/depart/complete/fail), `payments` (POST จาก ERP), `invoice-runs`, `trips` (assign/dispatch/complete), `carriers`, `jobs` — spec จัดเป็น **P2**; ที่เหลือ P1 → [RB-4]
- **G3 framework P0:** `DemoProvider`, ตาราง system-of-record ต่อ connector, sync master ลงมา (บล็อก finalize ถ้า mapping ไม่ครบ), payment status pull, inbound webhook ledger — spec: กรอบ connector + schema outbox/`SyncRecord` P0, sync engine + คิว + `ExternalMapping` P1; ไม่มี inbound webhook ledger และ DemoProvider → spec/07 §2–3 [RB-3]
- G3 system-of-record: "ERP = เจ้าของลูกค้า(หลัก)" — spec INT-012 master สองทางใช้ "แก้ล่าสุดชนะ" [ขัด] → ยึด docs (ตารางต่อ connector ตกลงก่อน go-live)
- **G4 KRS = P0** — spec 07 §1: connector ตัวแรก P1 "เลือกตามความต้องการลูกค้าเฟส 0" [OPEN O-INT-1 / Q-A10] → [RB-3]
- G4 LINE OA / Messaging API (P0) — spec ใช้ LINE ส่งลิงก์รถร่วมใน P0 แต่ยังเปิดว่า OA ของใคร/ใครจ่าย (Q-D5, กำหนดตอบ P1) → [RB-19]
- G1 webhook retry 8 ครั้ง (1m, 5m, 30m, 2h, 6h, 12h, 24h, 24h ≈ 3 วัน) — spec INT-103 = 8 ครั้งใน 24 ชม. และเปิด Q-D6 → ยึด docs
- G1 key prefix `tk_live_/tk_test_`, sandbox = tenant mode test ใน cluster เดียว — spec 07 ใช้ `tms_live_`/`tms_test_` + โดเมน `sandbox.api` [PROPOSED] (11-nfr ใช้ `tk_live_`) → ยึด docs

**(b) spec มี — docs ไม่มี**
- INT §11 Field mapping profile (P1) + AI แนะนำ mapping → เฟส 2 [RB-16]
- INT §12 Shipper-scoped API key (P2) → เฟส 3 (ทางเลือกของ customer portal)
- INT §13 MCP server (P1 อ่าน + ร่าง, P2 เขียน) และ 08 AI ระยะ 1 ทั้งหมด (P1; Q-A6 ถามว่าจะดึงเข้า P0) → เฟส 2+ ไม่เข้าเฟส 0 [RB-16]
- INT-013 `numberingOwner = external` (เลขชั่วคราวจนระบบบัญชีตอบ) → ตรงกับคำถามเปิด docs "ใครออกเลข" — ตัดสินพร้อม KRS
- INT-010 การ์ด connector เรียงตามตัวอักษร ไม่มีตัวใดเป็นค่าเริ่มต้น; `ConnectorDefinition` เป็นข้อมูล → รับ (ตรงหลัก ERP-agnostic)
- INT-040 `ExportTemplate` เป็นข้อมูล, OpenAPI ต่อ tenant รวม custom fields, โควตา `api.monthly_calls`, สถิติ REST vs MCP → เฟส 2

**(c) ลำดับความสำคัญไม่ตรง**

| รายการ | docs/04 · docs/02 | spec | ข้อเสนอ |
|---|---|---|---|
| Open API อ่าน + เขียน + webhook | docs/04 P0 · docs/02: เปิดสาธารณะเฟส 2 (อ่าน Growth / เขียน Business) | 07: P1 · 12: P0 อ่าน, P1 เขียน | เฟส 0 = แกน API ที่ UI + KrsAdapter ใช้; เปิดสาธารณะเฟส 2 [RB-4] |
| Connector framework | P0 | กรอบ P0, engine P1 | P0 |
| KRS connector | P0 · เฟส 0 | P1, ตัวแรกยังเปิด | P0 หลัง `ErpAdapter` [RB-3] |
| FlowAccount / PEAK | P1 · เฟส 1 (FlowAccount → PEAK) | P1 "1–2 ตัว" | [ตรง] หลัง KRS |
| Express / template เฉพาะโปรแกรม | P1 | P1 | [ตรง] |
| CSV generic export | P0 | P0 (07 §4, 05 §14) | [ตรง] |
| ลูกค้าเปิด connector เอง (marketplace) | P2 · เฟส 2; เฟส 0–1 Innovera ตั้ง credential | UI เชื่อมเองตั้งแต่ต้น | เฟส 2 ตาม docs |
| MCP / AI / field mapping | — | P1 | เฟส 2+ [RB-16] |

### H. Reports & Dashboard (spec/09)

**(a) docs มี — spec ไม่มี/ไม่ครบ**
- "Dashboard AP รถร่วม" (P0) — spec 09 §4 AP aging = P1 → spec/09 §1 หรือ §4
- "Dashboard เชื่อมต่อ" ต่อ connector: คิว, ล้มเหลว, lag, health (P0) — spec มีแค่การ์ด "คิวเชื่อมระบบบัญชี" → spec/09 §1, 07 §2
- "รายได้" ต่อลูกค้า/เส้นทาง/รถ/ประเภทรถ/นิติบุคคล/เดือน (P0) — spec รวมอยู่ในรายงานกำไร (P1) → ต้องมีรายงานรายได้อย่างเดียวที่ P0 → spec/09 §2
- "DO ยังไม่วางบิลเกิน N วัน" + ส่ง LINE/อีเมลให้ Invoicer อัตโนมัติ (P0) — spec BIL-025 มีรายงาน + เตือนเมื่อเกินเกณฑ์ ไม่ระบุผู้รับ/ช่องทาง → spec/05 §2
- Dashboard ปฏิบัติการ: order รอจัดแยกตาม reason code, งานรถร่วมรอตอบ (P0) — KPI ของ spec ไม่แยก → spec/09 §1
- Cash/COD reconciliation, ประเมิน carrier, การใช้รถ (P1), รายงาน DLT (P2) — spec มีบางส่วน (สถิติรถร่วม, รายงาน fleet) → spec/09

**(b) spec มี — docs ไม่มี**
- §5 OTIF, §6 POD ครบ %, DSO, §8 downtime / PM ตรงเวลา / ค่าปรับต่อคนขับ (P1), TCO + ยาง (P2) → P1–P2 ตาม spec
- §10–11 ระดับความสดของข้อมูล + พจนานุกรมตัวชี้วัด, RPT-011 การ์ดเงินไม่ render เมื่อไม่มีสิทธิ์ → รับเป็นหลักร่วมตั้งแต่เฟส 0
- 08 §7 "ถามข้อมูล" ด้วย AI → เฟส 2+

**(c) ลำดับความสำคัญไม่ตรง**

| รายการ | docs/04 | spec | ข้อเสนอ |
|---|---|---|---|
| กำไรต่อเที่ยว/ลูกค้า/รถ | P1 | 09 §2 P1 (12 §1 เขียน P0) | P1 |
| Dashboard AP รถร่วม | P0 | P1 | P0 แบบนับตามสถานะ settlement |
| รายงานภาษี: ขาย / WHT | P0 / P1 | P0 ทั้งคู่ | ดู F |
| Aging ลูกหนี้, dashboard ปฏิบัติการ + บิล | P0 | P0 | [ตรง] |
| ตั้งเวลาส่งรายงาน | P1 | P1 | [ตรง] |

### I. Cross-cutting (spec/00, 01 §13.5, 11)

**(a) docs มี — spec ไม่มี/ไม่ครบ**
- "Help center step-by-step" ไทย + error code catalog + in-app chat (P1; เป็นของที่ต้องมีในเฟส 1 ตาม docs/02 §7; K14) — spec ไม่มีทั้งชุด → spec/12 §1 + หัวข้อใหม่ [RB-18]
- "ค้นหา global (⌘K)" เลข order/trip/invoice/ทะเบียน/ลูกค้า/PO/เลขตู้ (P0) — spec มีแค่เป้า NFR-606/707 ไม่มีสเปกฟังก์ชัน → spec/00 §6
- "ความคิดเห็น/โน้ตบนเอกสาร + mention" (P1) — drawer มาตรฐานของ spec มีแท็บกิจกรรม แต่ระบุความเห็นเฉพาะในศูนย์ข้อยกเว้น ไม่มี mention → spec/00 §6
- การแจ้งเตือน: LINE = P0 สำหรับรถร่วม/คนขับ, สรุปรายวัน 08:00 — spec 01 §13.5 LINE/SMS = P1 (แต่ลิงก์งานรถร่วมใช้ LINE ใน P0) → ทำให้ชัดที่ spec/01 §13.5
- "ภาษา: ไทย P0, อังกฤษ P1" — spec TH/EN/中文 ครบทุกหน้า [DECISION] → [ขัด, RB-12]

**(b) spec มี — docs ไม่มี**
- ภาษาจีน (UI, แอปคนขับ, template แจ้งลูกค้า) → [RB-12]
- กฎร่วม "ยกเลิก/override/อนุมัติ ต้องใส่เหตุผล ≥ 10 ตัวอักษร" (00 §6), drawer มาตรฐาน → รับตั้งแต่เฟส 0
- ชั่วโมงเงียบ + ตารางกฎแจ้งเตือน → เฟส 1

**(c) ลำดับความสำคัญไม่ตรง**

| รายการ | docs/04 | spec | ข้อเสนอ |
|---|---|---|---|
| ภาษา UI | ไทย P0 / อังกฤษ P1 | ไทย/อังกฤษ/จีน P0 | เฟส 0 ไทย + โครง i18n; อังกฤษ P1; จีน [RB-12] |
| LINE แจ้งทีมภายใน | P1 | P1 | [ตรง] |
| Help center | P1 (เฟส 1) | ไม่มี | เพิ่มเข้า spec ที่เฟส 1 |
| ⌘K | P0 | เป้า NFR เท่านั้น | P0 แบบค้นเลขเอกสาร/ทะเบียน/ลูกค้า |

### J. Security, Compliance, NFR (spec/11)

**(a)/(c) ค่าที่ไม่ตรงกัน**

| หัวข้อ | docs/04 | spec | ข้อเสนอ |
|---|---|---|---|
| Data residency | โฮสต์ในไทย (P0) | ยังเปิด ไทยหรือสิงคโปร์ (Q-D1, NFR-OPEN-1) | ไทย ตาม docs [RB-15] |
| Audit log | 5 ปี | 2 ปี (NFR-404) | 5 ปี [RB-15] |
| GPS log | 90 วัน (ตัดสินแล้ว) | ยังเปิด 90 วัน vs 2/5/7 ปี (Q-C7) | 90 วัน |
| ไฟล์ POD | 2 ปี | ตามแพ็กเกจ (decisions: 2/5/7 ปี) | 2 ปีขั้นต่ำ; แยกตามแพ็กเกจตัดสินพร้อมราคา [RB-9] |
| RPO / backup | RPO 1 ชม., เก็บ 30 วัน | RPO ≤ 15 นาที, PITR 35 วัน | ใช้ของ spec (เข้มกว่า ไม่ขัด) |
| แจ้ง maintenance | 48 ชม. | 72 ชม. | 72 ชม. |
| ฐาน PDPA ข้อมูลคนขับ | ฐานสัญญา + legitimate interest (ตัดสินแล้ว) | [PROPOSED] รอฝ่ายกฎหมาย | ยึด docs; ให้กฎหมายยืนยันก่อนเฟส 2 (แอปเก็บตำแหน่ง) |
| Pentest | P1 ก่อนเปิด standalone | P1 ก่อนเปิดขาย | [ตรง] |
| Availability 99.5% / 99.9%, WCAG AA, Android 8+ / iOS 15+ | — | — | [ตรง] |

**(b) spec มี — docs ไม่มี:** OWASP ASVS L2, audit hash chain + WORM (NFR-403), สแกนมัลแวร์ไฟล์อัปโหลด, กู้ข้อมูลราย tenant, service credit (Q-C12), DPO (Q-C11) → hash chain/WORM และสแกนไฟล์ = P1; ที่เหลือเฟส 1–2

### K. สิ่งที่ไม่ทำ (K1–K20) — ตรวจ spec

| # | สถานะ | หลักฐานใน spec / สิ่งที่ต้องแก้ |
|---|---|---|
| K1 ไม่ผูกสัญญา | ตรง | D4, PLT-093 ไม่มีค่าปรับ; รายปี (`committedVehicles`) เป็นส่วนลด |
| K2 ไม่ล็อก ePOD/reason code/วางบิลไว้ tier สูง | ตรง (มีข้อสังเกต) | ePOD, วางบิล, เอกสารภาษี, จ่ายรถร่วม + 50 ทวิ เป็น isBasic (PLT-061); แต่ `subcon.dispatch_link`, `subcon.settlement_review` ยัง [OPEN] (O-PLT-11) และต้นแบบรอบ 13 วาง "รถร่วม + Settlement" ไว้ระดับ "มาตรฐาน" — docs/02 §2 ให้อยู่ Starter [RB-11] |
| K3 dashboard ไม่คำนวณแยก | ตรง | RPT-001, BIL-170 |
| K4 ไม่ให้บัญชีคีย์ซ้ำ | ไม่ครบ | มีคัดลอก/ออกหลายใบ; ขาด template บิลรายเดือน, งานประจำ |
| K5 ไม่มี config ที่ต้องให้ทีมเราตั้ง | ตรง | ตั้งเองได้ทุกหน้า (เฟส 0–1 docs ให้ทีมเราตั้ง credential connector) |
| K6 ไม่ทำ workflow engine เต็มรูป | **เฝ้าระวัง** | `DispatchOverride` (ขอ → อนุมัติ), ศูนย์ข้อยกเว้นตั้ง SLA/เจ้าของ, `org.approval_flows`, ตารางกฎแจ้งเตือน — แต่ละตัวมีขอบเขตจำกัด ห้ามรวมเป็น engine กลาง |
| K7 integration ที่ลูกค้ามองเห็น | ตรง | คิวเชื่อมระบบบัญชี, log, ส่งซ้ำ (07 §2) |
| K8 แอปไม่กินแบต | ตรง | `locationIntervalSec`, NFR-807 ≤ 5%/ชม. |
| K9 ไม่ปล่อยแอปโดยไม่ทดสอบกับคนขับจริง | **ขาด** | ไม่มีด่าน usability test ทั้งที่วางแอปเป็น P0 [RB-18] |
| K10 ไทยเป็นหลัก | ตรง (มีข้อสังเกต) | ไทยเป็นค่าเริ่มต้น แต่บังคับ 3 ภาษาครบทุกหน้าตั้งแต่ P0 [RB-12] |
| K11 เส้นทางจ่ายรถร่วมทางเดียว | ตรง | BIL-132 |
| K12 โครงสร้างที่ไม่เข้ากับไทย | ตรง | 1 INV : หลาย DO, รถร่วมแยกจากคนขับ, snapshot ต่อเที่ยว, event idempotent, มี mismatch |
| K13 ไม่ build แยกต่อลูกค้า | ตรง | multi-tenant + entitlement |
| K14 support มีคู่มือ | **ขาด** | ไม่มี help center / error code catalog [RB-18] |
| K15 ไม่ทำใบกำกับอย่างย่อ | ตรง | BIL-005, T8 |
| K16 ไม่เขียน e-Tax XML เอง | ตรง | BIL-202, PLT-098 |
| K17 ไม่เป็น system of record ของ GL | **เฝ้าระวัง** | Journal CSV + `glAccountRevenue/Cost` + คู่บัญชีต่อ ChargeType (BIL-172, P1), ล็อกงวด (BIL-175), Q-A13 เจ้าหนี้ผู้ขายเต็มรูป → จำกัดเป็น "mapping เพื่อ export" ไม่เก็บผังบัญชี/ยอดบัญชี [RB-18] |
| K18 ไม่ทำ VRP engine เอง | **ขัด (ระยะ 3)** | 08 §9 "ผู้ช่วยวางแผน: solver (เช่น OR-Tools) จัดรถ/ลำดับจุด" = engine ในระบบ → เปลี่ยนเป็น interface เรียก engine ภายนอก; "เสนอรถ" แบบกฎ (03 §7) ไม่ขัด [RB-18] |
| K19 มาตรฐาน public API | ตรง | cursor, tenant ไม่อยู่ใน path, camelCase (INT-051–057) |
| K20 ไม่ทำบัญชีสต็อกอะไหล่เต็มรูปในเฟสแรก | **เกินขอบเขต P2** | FLT-H (P2): ต้นทุนเฉลี่ยถ่วงน้ำหนัก, มูลค่าคงคลัง, ปรับยอดนับจริง (FLT-140–144); FLT-J ถังน้ำมันใช้สูตรเดียวกัน → P2 ของ docs คือทะเบียน + รับ/เบิก + min stock, ราคาที่จ่ายจริง [RB-18] |

## 3. เชิงพาณิชย์

| หัวข้อ | docs/02 (v2) | research/decisions.md | spec/01 | ต้นแบบ (รอบ 13) | จุดยืนที่เสนอ |
|---|---|---|---|---|---|
| หน่วยคิดเงิน | ต่อรถ active/เดือน | เหมือนกัน (ข้อ 1) | เหมือนกัน | เหมือนกัน | ต่อรถ active/เดือน [ตรง] |
| นิยามรถ active | มี Trip ≥ 1 เที่ยวในเดือน (รวมรถร่วมที่รับงานผ่านระบบ) | ทะเบียนบน DO/Trip ที่ **ปิดสถานะ** ≥ 1 ใบ, นับ 23:59 สิ้นเดือน, ผูกทะเบียนบนเอกสาร | PLT-070–075 = decisions | "รถบริษัท + รถร่วมที่วิ่งจริงในเดือน" | นิยาม decisions (กันนับ Trip ร่าง, กันยุบทะเบียน) [RB-10] |
| ชื่อ/จำนวน tier | Starter / Growth / Business / Enterprise แบ่งตาม **ขนาด fleet** 1–15 / 16–60 / 61–200 / 200+ | 4 ชื่อเดียวกัน แบ่งตาม **ฟีเจอร์** | seed 3 + Enterprise; [OPEN] 3 หรือ 4 (Q-A1) | เริ่มต้น / มาตรฐาน / องค์กร (3) จำกัดรถ ≤ 20 / ≤ 80 / ไม่จำกัด | ต้องให้เจ้าของตัดสิน [RB-9] — เสนอ 4 ชื่อของ docs |
| ราคา/รถ/เดือน | 350 / 280 / 220 / ตกลง | 249 / 399 / 499 / ตกลง + ส่วนลดปริมาณ คันที่ 51–100 −10%, 101+ −20% | PLT-063 = decisions (seed) | ฿390 / ฿690 / ติดต่อฝ่ายขาย | ต้องให้เจ้าของตัดสิน [RB-9] |
| ขั้นต่ำ/เดือน | 2,500 / 4,500 / 13,500 | 2,490 / 3,990 / 9,980 | = decisions | ไม่มี | ตามชุดราคาที่เลือก |
| ส่วนลดรายปี | −15% ทุก tier | −10% / −15% / −15% | = decisions | "ลด 2 เดือน" | ตามชุดราคาที่เลือก |
| Trial | 30 วัน ไม่ใส่บัตร ฟีเจอร์ Growth ≤ 20 คัน | 30 วัน (ข้อ 6) | 30 วัน, 20 คัน | 30 วัน ไม่ใช้บัตร | 30 วัน ไม่ใส่บัตร ≤ 20 คัน [ตรง] |
| User | ไม่จำกัดทุก tier | ไม่จำกัด | ไม่จำกัด | ไม่จำกัด | [ตรง] |
| นิติบุคคล/สาขา | 1/1 · 1/หลายสาขา · หลายนิติบุคคล | เหมือน docs | สาขา P0, นิติบุคคล P1, [OPEN] Q-A11 | หลายนิติบุคคลที่ "องค์กร" | ตาม docs [RB-13] |
| ราคารถร่วม | นับ; เสนอ **ครึ่งราคา** (§8) | **เต็มราคา** + ลิงก์ POD ฟรี (ไม่แนะนำครึ่ง) | PLT-073 เต็มราคา [OPEN Q-A3] | นับ | ต้องให้เจ้าของตัดสิน [RB-10] — เสนอเต็มราคา |
| ฟีเจอร์รถร่วม (จ่ายงานผ่านลิงก์, settlement, 50 ทวิ) | Starter | ทุก tier | payment + 50 ทวิ พื้นฐาน; dispatch link / settlement review [OPEN Q-A8] | ระดับ "มาตรฐาน" | ทุกแพ็กเกจ (docs/02 §2, เจตนา K2) [RB-11] |
| แอปคนขับ | add-on 80 บาท/คนขับ active/เดือน, เฟส 2; ลิงก์รถร่วมฟรี | ไม่กล่าวถึง (ePOD web + ลิงก์ทุก tier) | `driver_app` พื้นฐานทุกแพ็กเกจ | อยู่ระดับ "เริ่มต้น" | ต้องให้เจ้าของตัดสิน [RB-2] — ค่าเริ่มต้นตาม docs |
| Open API | อ่าน Growth / เขียน Business; สาธารณะเฟส 2 | เหมือน docs | `api.open_api`, `api.write` [OPEN Q-A9]; rate limit — / 300 / 1,000 ต่อนาที | — / 60→300 + webhook 3 / 1,000 | ตาม docs; เพดานระบบ 50 req/s ต่อ tenant (G1) |
| Connector บัญชี | add-on: file export 1,000 (หรือฟรี Growth+), API บัญชี cloud 2,000/ตัว + setup 5,000, ERP 4,000/ตัว + setup 25,000 | เหมือน docs | รวมในแพ็กเกจเป็นโควตา 0 / 1 / ไม่จำกัด + add-on "connector เพิ่ม" | export / 1 ตัว / ไม่จำกัด | ต้องให้เจ้าของตัดสิน [RB-9] — ค่าเริ่มต้น add-on ตาม docs |
| e-Tax | add-on เปิดใช้ 3,000 + ค่า SP ตามจริง | เฟส 2 (ของเราเอง) | P2 | — | ตาม docs |
| GPS connector | add-on 1,500/เดือน/ค่าย | add-on Growth | `tracking.live_map` ไม่ใช่พื้นฐาน | "ติดตามรถ" ระดับมาตรฐาน | ตาม docs |
| Fleet | ไม่อยู่ในตาราง tier (B2 เพิ่ม 4 พ.ย.) | — | `fleet.basic` พื้นฐาน; `fleet.full` สูงกว่า | พื้นฐาน = มาตรฐาน, เต็ม = องค์กร | ทะเบียน + เอกสารรถทุกแพ็กเกจ; ที่เหลือตัดสินพร้อมราคา [RB-9] |
| โควตาอื่น (POD GB, custom fields, AI credit) | ไม่มี | POD 5/25/100 GB | POD [OPEN Q-A2]; custom fields 5/20/∞; AI 200/1,000 | POD 20/100 GB; custom fields 5/20/∞ | ตัดสินพร้อมราคา ไม่ต้องก่อนเฟส 0 |
| เกินโควตารถ | คิดตามจริงเดือนถัดไป ไม่บล็อก | — | soft limit + add-on รถเกิน [OPEN Q-A4] | เตือนก่อนสร้าง | ไม่บล็อกงานขนส่ง (ตรงทั้งสองฝั่ง) |
| เรียกเก็บเงินลูกค้า | เฟส 1 ออกบิลมือจาก usage CSV ถึง 10 tenant | อัตโนมัติตั้งแต่เฟส 1; Opn + EasySlip | P0 สลิป + PDF; P1 Opn; ย้อนหลัง [OPEN Q-A5] | บัตร / PromptPay / โอน + สลิป | เฟส 1; มือหรืออัตโนมัติ [RB-5] |
| ค้างชำระ / เก็บข้อมูล | soft-delete 90 วัน | 7 / 21 / 60 วัน; เก็บ 90 วัน; เอกสารของเรา 7 ปี | = decisions | 7 สถานะ | ตาม decisions (เป็น config) |
| KRS pilot | เสนอฟรี connector 12 เดือน + Business ลด 50% (§8) | — | — | — | ต้องให้เจ้าของตัดสิน (มีเฉพาะ docs) |

## 4. คำถามเปิด — เทียบ 3 รายการ

รายการ: docs/04 "สิ่งที่ยังต้องตัดสินใจ" (7 ข้อ) · docs/02 §8 (12 ข้อ) · spec/12 §2 (Q-A1–A18, Q-B1–B26, Q-C1–C12, Q-D1–D10, Q-E1–E5)

**ซ้ำกัน (รวมเป็นข้อเดียว)**

| เรื่อง | docs/04 | docs/02 §8 | spec/12 | หมายเหตุ |
|---|---|---|---|---|
| ราคา/tier/ขั้นต่ำ | — | ข้อ 1 | Q-A1 | + decisions ข้อ 4 → RB-9 |
| รถ active + ราคารถร่วม | — | ข้อ 2 | Q-A3 | + decisions ข้อ 1, 9, 12 → RB-10 |
| แพ็กเกจที่ได้ API เขียน | — | ข้อ 4 | Q-A9 | docs เสนอ Business |
| คำถามนักบัญชี/สรรพากร | ข้อ 1 (12 ข้อ) | ข้อ 8 | Q-B1–B23 | spec ละเอียดกว่า (26 ข้อ) — ใช้ชุด spec เป็นรายการถาม |
| ระบบบัญชีรับเอกสารแบบไหน, ใครออกเลข, งวดปิด | ข้อ 2 (KRS) | — | Q-B25, O-INT-2/3 | spec ขยายเป็น "ทุก ERP"; KRS ต้องตอบก่อนเฟส 0 |
| รูปแบบนำเข้า Express | ข้อ 3 | ข้อ 7 | Q-B22 | |
| e-Tax (SP รายแรก, เกณฑ์ 30 ล้าน) | ข้อ 4 | ข้อ 6 | Q-B9 | การเลือก SP มีเฉพาะ docs |
| Cloud region | ข้อ 5 | — | Q-D1 | docs J ระบุ "ไทย" แล้ว เหลือเลือกผู้ให้บริการ → RB-15 |
| เทคโนโลยีแอปคนขับ | ข้อ 7 | §6 checklist | Q-D2 | กำหนดตอบต่างกัน: ก่อนเฟส 2 ↔ เริ่ม P0 |
| ออกบิลลูกค้ามือหรืออัตโนมัติ | — | ข้อ 10 | Q-A5 (บางส่วน) | + decisions ข้อ 10 → RB-5 |

**docs ตัดสินแล้ว แต่ spec ยังเปิด (ปิดตาม docs ได้เลย)**

| spec | docs ตัดสินไว้ว่า |
|---|---|
| Q-A10 connector ตัวแรก | KRS (เฟส 0) → FlowAccount → PEAK → CSV generic (docs/02 §3.1, §7) |
| Q-A11 หลายนิติบุคคล | tenant เดียว → `legal_entity` → `branch` (A4 P0, docs/02 §4) |
| Q-A8 ลิงก์รถร่วม/ตรวจ settlement เป็นพื้นฐาน | อยู่ Starter (docs/02 §2, K2) |
| Q-D6 webhook retry | 8 ครั้ง ≈ 3 วัน, ปิดอัตโนมัติหลัง 50 ครั้งติด (G1) |
| Q-C7 เก็บ GPS ดิบ / ฐานกฎหมายติดตามคนขับ | 90 วัน; ฐานสัญญา + legitimate interest (J) — ให้ฝ่ายกฎหมายยืนยัน |
| Q-A18 / Q-B3 ใบเดียวหรือ 2 ใบ | ตั้งค่าต่อ tenant ตามที่นักบัญชีเลือก (F1) — ยังต้องเลือกค่าเริ่มต้น → RB-9 |
| Q-D3 ผู้ให้บริการแผนที่ | Google / Longdo / NOSTRA เลือกผ่าน config (G4) — ยังต้องเลือกตัวแรก |

**มีเฉพาะ docs:** ราคา KRS ในฐานะ pilot (02 §8) · SLA กับ KRS (04) · tenant standalone ทดสอบเฟส 0 คือใคร (02 §8) · ชื่อผลิตภัณฑ์/โดเมน (02 §8; decisions ข้อ 11) · ERP ตัวที่สอง SAP B1 หรือรอ (02 §8) · file export ฟรีใน Growth+ หรือเก็บ 1,000 (02 §8)

**มีเฉพาะ spec:**
- กระทบเฟส 0 (ต้องตอบก่อน): Q-D5 LINE OA ของใคร/ใครจ่าย [RB-19] · Q-A16 ปี พ.ศ./ค.ศ. ในเลขเอกสารปฏิบัติการ · Q-C1 เอกสารรถตัวไหนห้าม override · Q-C3 ชั้นใบขับขี่กับประเภทรถ · Q-C2 น้ำหนักเกิน · Q-A17 ขอความยินยอมก่อน impersonate · Q-D10 ช่วงเวลากระดานวางแผน · Q-E1 เวลารอตอบของรถร่วม · Q-B12–B21 (ฐาน WHT, รับชำระบางส่วน, ย้อนวันที่, ยกเลิกหลังยื่น ภ.พ.30, WHT เมื่อจ่ายเป็นงวด)
- เฟส 1: Q-A2 พื้นที่ POD · Q-A4 โควตาอ่อน/แข็ง · Q-B24 ใบกำกับค่าบริการของเรา · Q-C10 ผู้สมัครบุคคลธรรมดา · Q-C12 SLA มีเงินชดเชย · Q-A14 วงเงินเครดิต · Q-A15 ค่ายกเลิก
- เฟส 2+: Q-A6/A7, Q-C9, Q-D7 (AI) · Q-A12 เงินเดือนคนขับ · Q-A13 เจ้าหนี้ผู้ขาย · Q-B26 วิธีเฉลี่ยต้นทุน · Q-C4–C6 (ชั่วโมงขับ, ดอกยาง, หักค่าจ้าง) · Q-C8 PDPA ผู้รับปลายทาง · Q-C11 DPO · Q-D4 GPS API · Q-D8 ชนิด custom field · Q-D9 ราคาน้ำมันอ้างอิง · Q-E2–E5 เกณฑ์ติดตาม/fleet/เสนอรถ/OTIF

## 5. ข้อเสนอขอบเขต "เฟส 0" สำหรับทำแผนพัฒนา

### 5.1 ฐาน = docs/04 P0 (ใช้รายละเอียดจอ/ฟิลด์/เกณฑ์ตรวจรับจาก spec เมื่อไม่ขัด)

**A Platform**
- Login อีเมล + รหัสผ่าน, นโยบายรหัสผ่าน, ลืมรหัสผ่าน, 2FA TOTP (บังคับ owner / accounting ที่อนุมัติได้ / ทีมเรา), session JWT + `tokenVersion`
- Magic link (HMAC, หมดอายุ, จำกัด action, เพิกถอนได้) สำหรับรถร่วมและผู้รับ
- เชิญผู้ใช้, โปรไฟล์ + ลายเซ็น, ระงับ/เปิด/ลบ, ประวัติ login
- Role มาตรฐาน + สิทธิ์ `{module}.{view|manage}` + สิทธิ์ฟิลด์ราคาขาย/ราคาซื้อ + separation of duties
- `legal_entity` + `company_branch` + number series ต่อ (นิติบุคคล × สาขา × ประเภท × งวด) + Invoice As / Tender As
- Setup checklist, import Excel dry-run ทุก master, ค่าเริ่มต้นไทยพร้อมใช้, feature flag ตาม plan + override
- Admin portal ขั้นต่ำ (tenant, connector, health) + impersonate มี audit และแจ้ง owner
- Audit log ทุก entity แบบ append-only

**B Master data**
- ลูกค้า, Carrier, รถ (OWN/SUBCONTRACT + capability tags), คนขับ 3 ประเภท, สถานที่ (alias, geofence radius), เส้นทาง/OD, สินค้า/หน่วย, คลัง
- Rate card ขาขาย/ขาซื้อ (ACTIVE ทันทีโดย admin), สูตร FLAT_TRIP / PER_DISTANCE / PER_UNIT + ค่าจุดเพิ่ม, `pricingStatus`
- Accessorial catalog (`vat_treatment`, `wht_rate`, snapshot), reason master ชุดไทย, กฎความเข้ากันได้ของประเภทรถ
- ผังรหัส ERP ที่ sync จาก connector (เฉพาะ tenant ที่เปิด connector)

**B2 Fleet**
- ทะเบียนรถขยาย + โปรไฟล์พื้นฐาน + สถานะ พร้อม/ซ่อม/จอด/ปลดระวาง + จับคู่หัวลาก–หาง
- เอกสารรถ + เตือน 60/30/7 วัน + หน้าเอกสารรถรวม + badge บนกระดานวางแผน
- รถร่วมแบบย่อ: เอกสารบังคับก่อนรับงาน, บล็อก assign เมื่อหมด (admin override), อัปโหลดผ่านลิงก์

**C Order intake**
- `upsertOrder` เดียวทุกช่องทาง (กรอกมือ / Excel dry-run / Open API / ERP connector) + `externalId` + source badge
- จับคู่อัตโนมัติ (ลูกค้า, สถานที่ด้วย alias, rate card) + เรียนรู้ alias
- หน้าใบค้าง + reason code 12 รหัส
- Edit lock, แยก/รวม order, ยกเลิก/คืนสถานะ, ต้นทางแก้หลังวางแผน → ใบค้าง

**D Planning & Dispatch**
- SO/DO ↔ Trip ↔ TripStop (snapshot รถ/คนขับ/carrier ต่อเที่ยว), สถานะ trip คำนวณจาก stop
- กระดานวางแผน: pool + scheduler, view, filter รถที่รับได้, ตรวจ constraint, เวลาขัดกันขึ้นแดง, multi-drop, Assign vs Dispatch, Send all, ตารางรถ/คนขับรายวัน, ใบงานประจำวัน PDF
- จ่ายงานรถร่วม: เลือก carrier + ราคาซื้อ, ลิงก์รับ/ปฏิเสธ 48 ชม., หมดเวลาแจ้ง, `selectionReason`, เปลี่ยน carrier

**E Execution & POD / E2**
- Stop event model + server idempotent (`clientEventId`, `occurredAt`)
- อัปเดตสถานะและ ePOD ผ่านเว็บ, POD checklist ต่อลูกค้า, actual qty + เหตุผลปฏิเสธ, ตีกลับ, ส่งไม่สำเร็จของยังอยู่บนรถ + นัดส่งใหม่, ค่าใช้จ่ายหน้างาน → accessorial
- Tracking link สาธารณะ
- M10 ลิงก์รถร่วม: รับ/ปฏิเสธงาน + POD ด้วยเลข DO (responsive, เปิดใน LINE ได้)

**F Billing & Settlement**
- หลักภาษีต่อบรรทัด, tax point, เลขเรียงออกตอน finalize, PDF ไทย/พ.ศ.
- AR: ใบแจ้งหนี้, ใบวางบิล, ใบกำกับภาษี, ใบเสร็จ, ใบลดหนี้/เพิ่มหนี้, บันทึกรับ 50 ทวิ จากลูกค้า
- Flow: revenue line, คิวพร้อมวางบิล, กันวางบิลซ้ำ, draft, finalize (immutable), ยกเลิก, invoice run, พิมพ์/ส่ง; lifecycle + กฎย้อนสถานะ (F4)
- รับชำระ + ออกเอกสารอัตโนมัติ + สถานะ invoice + aging (+ ดึงสถานะชำระจาก connector ที่รองรับ)
- AP รถร่วม: cost line, คิวจ่าย, settlement + รายการหัก, ตรวจผ่านลิงก์, dispute, อนุมัติ, WHT + 50 ทวิ, บันทึกจ่าย
- คนขับ/รถร่วมดูยอดของตัวเองผ่านลิงก์; เก็บฟิลด์ให้ map เป็น ETDA CII; รายงานภาษีขาย + รายได้ยกเว้น

**G Open API & Integration**
- มาตรฐาน API (G1) และ resource เฟสแรก (G2 ข้อ 1–8, 10) — ขอบเขตที่เปิดจริงดู RB-4
- `ErpAdapter` framework (G3): StandaloneProvider/DemoProvider, `external_mapping`, system-of-record, sync master, error queue ให้ลูกค้าดูเอง, `syncFromDate`, payment pull, inbound webhook ledger, outbox, หน้าจัดการ connector
- Connector: KRS (หลัง interface กลาง ไม่ hard-code), CSV generic, LINE, map/geocode

**H / I / J**
- Dashboard ปฏิบัติการ / บิล / AP รถร่วม / เชื่อมต่อ; รายงานรายได้, DO ยังไม่วางบิลเกิน N วัน, aging, ภาษีขาย
- แจ้งเตือน in-app + อีเมล (+ LINE สำหรับรถร่วม), ⌘K, import/export + job, ไฟล์แนบ, ตั้งค่าองค์กร, ประวัติแก้ไขต่อเอกสาร, UI ไทย
- Security P0 ทั้งชุด (RLS + test แยก tenant, เข้ารหัส, rate limit, magic link), retention เอกสารภาษี, PDPA พื้นฐาน, โฮสต์ในไทย, backup/monitoring

### 5.2 ผู้สมัครเพิ่มเข้าเฟส 0 จาก spec (ต้องให้เจ้าของตัดสิน)

| # | รายการ (รหัส spec) | เหตุผล 1 บรรทัด |
|---|---|---|
| 1 | ใบปรับลด/เพิ่มยอดใบแจ้งหนี้ ACN/ADN (BIL-093) | ค่าขนส่งยกเว้น VAT ไม่มีใบกำกับให้ใบลดหนี้อ้าง — รอบเดือนแรกต้องมีทางแก้ยอดใบแจ้งหนี้ |
| 2 | สรุป WHT ฝั่งจ่าย ภ.ง.ด.3/53 เป็น CSV ทั่วไป (05 §14) | นักบัญชีของ tenant ทดสอบต้องยื่นเดือนถัดไป; docs/02 วางไว้ Starter อยู่แล้ว |
| 3 | รายงานภาษีซื้อ + บันทึกใบกำกับของรถร่วมที่จด VAT (05 §14, BIL-139) | นักบัญชีใช้ปิด ภ.พ.30; เป็นรายงานจากข้อมูลที่มีอยู่ |
| 4 | Schema `Tenant.status` 7 ค่า + `Plan/PlanVersion/Entitlement` + unique `(taxId, branchCode)` (PLT-010, PLT-060) | ทุกโมดูลอ้าง enum นี้; ทำตอนนี้กัน migrate เฟส 1 (decisions "ก่อนเขียน schema เฟส 0") — ไม่รวม UI |
| 5 | ตัวนับรถ active ตามนิยามที่เคาะ (PLT-070–075) | เก็บตัวเลขจริงจาก pilot ไว้ทดสอบราคาก่อนเปิดเฟส 1; เป็น insert เมื่อปิดเอกสาร |
| 6 | คอลัมน์ `customFields` บน SO/DO + แสดง 3–5 ช่องบนเอกสาร (MD-230 แบบย่อ) | KRS/ลูกค้ามักต้องมีเลข PO/เลขตู้บนใบแจ้งหนี้; ไม่รวมตัวตั้งค่า 13 ชนิด |
| 7 | หางเป็นทรัพย์สินที่มีเอกสารของตัวเอง (FLT-B) | ถ้า pilot ใช้หัวลาก–หาง เอกสารหางหมดอายุต้องเตือนได้; ใช้ตารางรถเดิม |
| 8 | POD: รูปใบส่งของที่เซ็นแล้วแทนลายเซ็นบนจอ (`paperDoSubstitutesSignature`) | วิธีที่รถร่วมไทยทำจริงผ่านลิงก์; ลดงานตีกลับ POD |
| 9 | เตือน PO ลูกค้าซ้ำ (ORD-007) | กัน order ซ้ำจาก Excel/API/connector ซึ่งทำให้ MISMATCH |

### 5.3 เลื่อนออกจากเฟส 0 แน่นอน

- สมัครเอง + OTP + ตรวจ RD + คิวอนุมัติ; หน้าแพ็กเกจ/ชำระเงิน; ใบกำกับของแพลตฟอร์ม; Opn/สลิป; dunning อัตโนมัติ; คูปอง/add-on ซื้อเอง; ตัวแก้ feature matrix (เฟส 1)
- แอปคนขับทุกจอ (M1–M9, M11–M18), DVIR/ตรวจรถก่อนออก, push notification (เฟส 2 / P2)
- หน้าติดตามรถบนแผนที่, GPS connector, ออกนอกเส้นทาง/จอดนาน
- ศูนย์ข้อยกเว้น, แจ้งลูกค้าปลายทาง SMS/LINE/อีเมล
- กล่องรับงาน LINE OA/อีเมล, AI ทุกฟีเจอร์, MCP, field mapping profile, shipper API key
- Custom fields เต็มรูป; rate card approval, เหมาวัน, fuel surcharge, zone
- Fleet: PM, ใบสั่งซ่อม, น้ำมัน, อุบัติเหตุ/เคลม, ยาง, อะไหล่, ถังน้ำมัน, ค่าปรับ, ลีสซิ่ง, คะแนนการขับ, ต้นทุนต่อคัน
- เงินเบิกคนขับ, ค่าเที่ยวคนขับ, รายการหักคนขับ/ส่งออกเงินเดือน, ไฟล์โอนธนาคาร
- Connector FlowAccount / PEAK / Express template, e-Tax ผ่าน SP, marketplace
- Cascade อัตโนมัติ / broadcast / เสนอราคากลับ, เสนอรถ, margin simulator, ปันส่วนต้นทุน
- รายงานกำไร, OTIF, POD ครบ %, TCO, ตั้งเวลาส่งรายงาน
- ภาษาอังกฤษ/จีน (ทำแค่โครง i18n), SSO, custom role, help center (เฟส 1), customer portal, VRP

## 6. ต้องให้เจ้าของตัดสิน

| # | เรื่อง | ตัวเลือก | ค่าเริ่มต้นที่เสนอ |
|---|---|---|---|
| RB-1 | ขอบเขตเฟส 0 | (ก) docs/04 P0 (KRS pilot + tenant standalone ทดสอบ) (ข) spec P0 (MVP ขายได้ รวม one-platform + แอปคนขับ ไม่มี KRS) | (ก) + ผู้สมัคร 5.2 ที่อนุมัติ |
| RB-2 | แอปคนขับ: เฟสและราคา | (ก) docs: M10 เฟส 0, แอปเฟส 2, add-on 80 บาท/คนขับ (ข) ดึงแอปขั้นต่ำ M1–M5 เข้าเฟส 1 (ค) spec: M1–M18 ใน MVP, รวมทุกแพ็กเกจ | (ก) |
| RB-3 | KRS connector / connector ตัวแรก | (ก) docs: KrsAdapter เฟส 0 แล้ว FlowAccount → PEAK เฟส 1 (ข) spec: เฟส 0 มีแค่กรอบ + export ไฟล์, ตัวแรกเลือกทีหลัง | (ก) — หลัง `ErpAdapter`, UI เป็นกลาง (INT-010) |
| RB-4 | Open API เฟส 0 ทำแค่ไหน | (ก) G1 + G2 ครบตาม docs/04 P0 (ข) แกน API ใช้ภายใน (key, idempotency, externalId, ETag, problem+json, cursor, webhook + outbox, OpenAPI gen, test tenant) + resource ที่ UI/KRS ใช้; เลื่อน docs site สาธารณะ, SDK, หน้า API key ของลูกค้า, OAuth client credentials, bulk, rate limit ต่อ plan ไปเฟส 2 (ค) spec: API ทั้งหมด P1 | (ข) — ตรงกับ docs/02 §5, §7 ที่เปิดสาธารณะเฟส 2 |
| RB-5 | One-platform (สมัครเอง, แพ็กเกจ, เรียกเก็บเงิน, Console เต็ม) | (ก) docs: เฟส 1; เฟส 0 ทีมเราสร้าง tenant, ออกบิลมือ (ข) spec/decisions: P0 และออกบิลอัตโนมัติ | (ก) + schema ตาม 5.2 ข้อ 4; มือหรืออัตโนมัติเคาะก่อนเริ่มเฟส 1 |
| RB-6 | กฎตอนจัดรถ | (ก) docs D2: เตือน + override พร้อมเหตุผล ไม่บล็อก (ยกเว้นรถร่วมเอกสารบังคับหมด) (ข) spec PLN-080–092: บล็อก + ผู้จัดการอนุมัติ, หลายข้อ override ไม่ได้ (ค) ค่าเริ่มต้นแบบ (ก) + tenant ตั้ง "บล็อก" รายกฎได้ | (ก) ในเฟส 0; (ค) เป็น P1 หลังได้คำตอบ Q-C1–C3 |
| RB-7 | Fleet เฟส 0 และตรวจรถก่อนออก | (ก) docs: ทะเบียน + เอกสาร + รถร่วมย่อ; WO/น้ำมัน/อุบัติเหตุ P1; DVIR P2 ไม่บล็อก (ข) spec: WO, ผลตรวจรถ (บล็อก), น้ำมัน, อุบัติเหตุ, ประวัติเลขไมล์ ใน MVP | (ก); เมื่อทำ P1 ยึด `vehicle_cost` ledger |
| RB-8 | Settlement dispute ผ่านลิงก์ | (ก) docs/04 F6: รถร่วมโต้แย้งรายบรรทัดผ่านลิงก์ = P0 (ข) เฟส 0: รถร่วมดู + กดยอมรับผ่านลิงก์, พนักงานบันทึก dispute ในเว็บ (บล็อกอนุมัติ); โต้แย้งผ่านลิงก์ = P1 (ค) docs/02 §7: ทั้ง flow เฟส 3 | (ข) |
| RB-9 | ราคา, tier, add-on | (ก) docs/02: 350/280/220 แบ่งตามขนาด fleet, connector เป็น add-on (ข) decisions: 249/399/499 แบ่งตามฟีเจอร์ + ส่วนลดปริมาณ (ค) ต้นแบบ: ฿390/฿690 3 ระดับ, connector เป็นโควตาในแพ็กเกจ | ต้องให้เจ้าของตัดสิน — เคาะ "ทิศทาง tier" ก่อน (ขนาด fleet หรือฟีเจอร์) เพราะกำหนด entitlement matrix; ตัวเลขเคาะก่อนเปิดหน้าราคาเฟส 1; ค่าเริ่มต้น (ข) ด้วยชื่อ tier ของ docs |
| RB-10 | นิยามรถ active และราคารถร่วม | นิยาม: (ก) มี Trip ≥ 1 (docs) (ข) เอกสารปิดสถานะ ≥ 1 ผูกทะเบียนบนเอกสาร (decisions/spec) · รถร่วม: เต็มราคา / ครึ่งราคา | นิยาม (ข); รถร่วมเต็มราคา (ต้องให้เจ้าของยืนยัน) |
| RB-11 | ฟีเจอร์รถร่วมอยู่แพ็กเกจไหน | (ก) ทุกแพ็กเกจ (docs/02 §2 Starter, เจตนา K2) (ข) ระดับกลางขึ้นไป (ต้นแบบ) | (ก) — ตั้ง `subcon.dispatch_link`, `subcon.settlement_review` เป็น isBasic |
| RB-12 | ภาษา | (ก) docs: ไทย P0, อังกฤษ P1, เมียนมา/กัมพูชา P2 ในแอป (ข) spec: ไทย/อังกฤษ/จีน ครบทุกหน้าตั้งแต่ P0 | (ก) + โครง i18n ตั้งแต่ต้น; ภาษาจีนให้เจ้าของยืนยันว่าต้องการและเฟสใด |
| RB-13 | หลายนิติบุคคล | (ก) docs A4: tenant เดียว → นิติบุคคล → สาขา ตั้งแต่ P0 (ข) spec: P1 หรือแยกเป็นกลุ่ม tenant | (ก) |
| RB-14 | หน้าติดตามรถ + GPS connector ค่ายแรก | (ก) docs/04: P1 (ข) docs/02: GPS เฟส 3 (ค) spec: แผนที่จากแอป P0, GPS P1 | หน้าติดตามรถมาพร้อมแอปคนขับ (เฟส 2); GPS ค่ายแรกเมื่อ pilot ต้องการ (เฟส 2–3) |
| RB-15 | ค่าความปลอดภัย/retention ที่ไม่ตรง | audit 5 ปี ↔ 2 ปี · รหัสผ่าน ≥ 12 ↔ ≥ 10 · refresh 7 วัน ↔ 30 วัน · โฮสต์ไทย ↔ ยังเปิด | ค่าของ docs ทุกข้อ |
| RB-16 | ของที่มีเฉพาะใน spec: AI, MCP, กล่องรับงาน, field mapping, custom fields เต็มรูป, ศูนย์ข้อยกเว้น | (ก) ทั้งหมดหลังเฟส 1 (ข) ดึงบางตัวเข้า MVP (Q-A6) | (ก): ศูนย์ข้อยกเว้น + custom fields แบบย่อ เฟส 1–2; AI/MCP/กล่องรับงาน/field mapping เฟส 2+ |
| RB-17 | ชุด role เริ่มต้น | (ก) docs: Owner, Admin, Planner, Dispatcher, Invoicer, Accounting, Approver, Viewer + Carrier/Customer portal, Driver (ข) spec: owner/admin, manager, dispatcher, accounting, fleet, approver, developer, viewer | (ก) สำหรับเฟส 0 + เพิ่ม manager; fleet/developer เพิ่มเมื่อโมดูลนั้นเปิด |
| RB-18 | แก้ spec ให้ตรงรายการ K | K18 เปลี่ยน solver ในระบบเป็น engine ภายนอก · K20 ลด FLT-H/FLT-J เป็นแบบง่าย · K17 จำกัด Journal/GL เป็น mapping เพื่อ export · K9 เพิ่มด่าน usability test · K14 เพิ่ม help center เฟส 1 | แก้ทั้ง 5 ข้อตาม docs |
| RB-19 | ส่งลิงก์รถร่วมทาง LINE ในเฟส 0 | (ก) ปุ่มคัดลอก/แชร์ลิงก์ ให้ผู้จัดรถส่งจาก LINE ของตัวเอง + SMS (ข) LINE OA กลางของแพลตฟอร์มผ่าน Messaging API (ค) LINE OA ของแต่ละ tenant | (ก) ในเฟส 0; เลือก (ข)/(ค) ก่อนเฟส 1 (Q-D5) — docs G4 ระบุ Messaging API เป็น P0 แต่ไม่ได้ระบุเจ้าของ OA |
