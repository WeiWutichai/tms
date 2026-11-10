# 05 — บัญชีและเอกสาร (Billing) · prefix `BIL`

> ⚠️ **ลำดับความสำคัญ (10 พ.ย. 2569):** ไฟล์นี้เขียนโดยไม่ได้อ่าน `docs/` (v2) เมื่อเนื้อหาขัดกับ `docs/` ให้ยึด `docs/` — ดู `plan/00-source-of-truth.md` และรายการจุดที่ขัดกันใน `plan/00a-reconcile-architecture.md`, `plan/00b-reconcile-requirements.md` · ป้าย P0/P1/P2 ในไฟล์นี้เป็นมาตราส่วนของ spec ไม่ใช่ "เฟส 0" ของแผนพัฒนา

> สถานะ: ร่าง v0.1 · 9 พ.ย. 2569
> แหล่งที่มา: `research/thai-tax-docs-research.md` (กฎหมายภาษี — อ้างเป็น "TAX §x"), `research/design-briefs.md` รอบ 1, 3, 6, 10, 11, 14 (หน้าวางบิล, รับชำระ, Settlement, เงินเบิก, template A4), `research/tms-product-learning.md` §3.6 (B1–B10), §4 (X3, X11)
> ข้อกฎหมายทุกข้อในไฟล์นี้มาจาก TAX เท่านั้น ข้อที่ TAX ไม่ได้ตอบหรือระบุว่า "ไม่พบข้อมูล" ติดป้าย **[OPEN]** และรวมไว้ใน §20 เพื่อถามนักบัญชี

## 0. ภาพรวมโมดูล

### 0.1 เอกสารที่โมดูลนี้ออก

| รหัสชนิด (`docType`) | ชื่อ | เป็นเอกสารภาษี? | ออกเมื่อ | ฐาน |
|---|---|---|---|---|
| `INV` | ใบแจ้งหนี้ | ไม่ใช่ [FACT] (TAX §1.1) | หลังส่งมอบงาน/ตามรอบบิล | §3 |
| `BN` | ใบวางบิล | ไม่ใช่ [FACT] (TAX §1.1) | ตามรอบวางบิลของลูกค้า | §3 |
| `RC` | ใบเสร็จรับเงิน (ใบรับ ม.105) | ใบรับตาม ม.105 ทวิ — ต้องมีเลขลำดับ [FACT] | ทันทีที่รับเงิน [FACT] | §5 |
| `RT` | ใบเสร็จรับเงิน/ใบกำกับภาษี (เต็มรูป ม.86/4) | ใช่ | ณ tax point = รับชำระ (ค่าเริ่มต้น) [FACT] | §5 |
| `CN` / `DN` | ใบลดหนี้ / ใบเพิ่มหนี้ (ภาษี ม.86/9–86/10) | ใช่ | เดือนภาษีที่เกิดเหตุ [FACT] | §6 |
| `ACN` / `ADN` | ใบลดหนี้/เพิ่มหนี้ภายใน (ปรับยอดใบแจ้งหนี้ที่ยังไม่มีใบกำกับภาษี) | ไม่ใช่ | เมื่ออนุมัติการปรับยอด | §6 |
| `PV` | ใบสำคัญจ่าย (Settlement รถร่วม / คืนเงินเบิก) | ไม่ใช่ | เมื่อบันทึกจ่าย | §11 |
| `WHT` | หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) | ใช่ (ภาษีเงินได้) | เมื่อจ่าย/หัก [FACT] | §11.10 |
| `CA` | ใบเบิกเงินล่วงหน้า / ใบเคลียร์เงินเบิก | ไม่ใช่ | เมื่ออนุมัติ/เคลียร์ | §12 |

### 0.2 หลักภาษีที่ใช้ทั้งโมดูล

| # | หลัก | ป้าย | อ้างอิง |
|---|---|---|---|
| T1 | ค่าขนส่งในราชอาณาจักรได้รับยกเว้น VAT ตาม ม.81(1)(ณ) แม้จ้างช่วง → ออกใบกำกับภาษีสำหรับรายการนั้นไม่ได้ | [FACT] | TAX §0.1, §1.8 |
| T2 | บริการประกอบ (ยกขน ลานตู้ ล้างตู้ เช็คอุณหภูมิ เครนยกตู้เปล่า) เสีย VAT 7% → ต้องแยกบรรทัด/แยกเอกสาร | [FACT] | TAX §1.8 |
| T3 | tax point ของบริการ = เมื่อได้รับชำระ เว้นแต่ออกใบกำกับภาษีก่อน → ใบวางบิล/ใบแจ้งหนี้ ≠ ใบกำกับภาษี | [FACT] | TAX §1.3 |
| T4 | ค่าขนส่งที่นิติบุคคลจ่าย → หัก ณ ที่จ่าย 1% (ทั้งลูกค้าหักเรา และเราหักรถร่วม); ค่าบริการ 3%; ขั้นต่ำ ≥ 1,000 บาทต่อสัญญา | [FACT] | TAX §3.1 |
| T5 | เลขที่ใบกำกับภาษีต้องเรียงลำดับ; ยกเลิกแล้วออกใหม่ต้องอ้างฉบับเดิม ห้ามใช้เลข/วันที่เดิมซ้ำ | [FACT] | TAX §1.7 |
| T6 | ใบกำกับภาษีเต็มรูปต้องมีเลขผู้เสียภาษีผู้ซื้อ + สำนักงานใหญ่/สาขาของทั้งสองฝ่าย | [FACT] | TAX §1.2 |
| T7 | ใบกำกับภาษีออกได้เฉพาะผู้ประกอบการจดทะเบียน VAT | [FACT] | TAX §6.1 |
| T8 | ใบกำกับภาษีอย่างย่อจำกัดเฉพาะค้าปลีก → **ไม่รองรับ** | [FACT] + [DECISION] | TAX §1.4 |
| T9 | เก็บใบกำกับภาษี/รายงาน ≥ 5 ปี (ขยายได้ ≤ 7 ปี, เลิกกิจการ +2 ปี) | [FACT] | TAX §5.1 |
| T10 | รายงานภาษีขาย/ซื้อแยกตามสถานประกอบการ ลงรายการภายใน 3 วันทำการ | [FACT] | TAX §5.2 |

### 0.3 ภาพการไหลของงาน

```
DO ส่งสำเร็จ + POD ผ่าน ──► คิวพร้อมวางบิล ──► ใบแจ้งหนี้ (INV) ──► [ใบวางบิล (BN) รวมหลาย INV]
                                                   │
                                   รับชำระ (Payment) ┤──► ใบเสร็จ (RC) สำหรับยอดยกเว้น VAT
                                                   └──► ใบเสร็จ/ใบกำกับภาษี (RT) สำหรับยอด VAT 7%
                                                          └──► CN/DN อ้าง RT ถ้าต้องแก้
เที่ยวรถร่วมจบ ──► Settlement ──► อนุมัติ ──► จ่าย (PV) + 50 ทวิ
เงินเบิกคนขับ ──► อนุมัติ ──► จ่าย ──► บันทึกค่าใช้จ่าย (M15) ──► เคลียร์/คืนเงินทอน (M16)
ทุกเอกสารที่ออกแล้ว ──► Export ให้นักบัญชี และ/หรือ ซิงก์ connector (syncStatus แยก)
```

---

## 1. ตั้งค่าบัญชีและภาษี (Billing settings)

1. **จุดประสงค์** — เก็บค่าที่กำหนดพฤติกรรมเอกสารทั้งหมด ต่อนิติบุคคล/สาขา และต่อลูกค้า
2. **ผู้ใช้/สิทธิ์** — owner/admin, accounting (`billing.settings:edit`); คนอื่นอ่านได้
3. **หน้าจอ** — ตั้งค่า > บัญชีและภาษี: แท็บ นิติบุคคลและสาขา · เลขที่เอกสาร (§8) · ประเภทรายได้/ภาษี · บัญชีธนาคาร · ข้อความท้ายเอกสาร; ข้อมูลหลัก > ลูกค้า > แท็บ "การวางบิล"
4. **ฟิลด์**

ระดับนิติบุคคล/สาขา (`LegalEntity`, `CompanyBranch`)

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| taxId | char(13) | ✓ | checksum 13 หลัก | |
| vatRegistered | bool | ✓ | | false → ปิดการออก RT/CN/DN และห้ามบรรทัด VAT 7% (T7) |
| branchCode | char(5) | ✓ | `^\d{5}$` | `00000` = สำนักงานใหญ่ [FACT] TAX §5.3 |
| branchLabel | text | ✓ | | แสดง "สำนักงานใหญ่" / "สาขาที่ 00001" |
| nameTh / addressTh | text | ✓ | | ตาม ภ.พ.20 |
| printBranchIssuerLine | bool | | | true → พิมพ์ "สาขาที่ออกใบกำกับภาษีคือ ..." (กรณีสาขาใช้แบบฟอร์ม HQ) [FACT] TAX §1.2 ข้อ 3 |
| logo, signatureImage | file | | PNG/JPG ≤ 1 MB | ลายเซ็นสแกนใช้กับ 50 ทวิได้ [FACT] TAX §3.2 |
| mixedVatDocMode | enum `SPLIT` \| `SINGLE` | ✓ | | ค่าเริ่มต้น `SPLIT` [PROPOSED] — ดู BIL-004, [OPEN] Q3 |
| defaultTaxInvoiceTiming | enum `ON_PAYMENT` \| `ON_INVOICE` | ✓ | | ค่าเริ่มต้น `ON_PAYMENT` (T3) |
| whtMinPerContract | decimal | ✓ | ≥ 0 | ค่าเริ่มต้น 1,000.00 [FACT] |
| whtThresholdBasis | enum `PER_DOCUMENT` \| `PER_TRIP` \| `PER_CONTRACT` | ✓ | | ค่าเริ่มต้น `PER_DOCUMENT` [PROPOSED] — [OPEN] Q8 |

ประเภทรายได้/ค่าใช้จ่าย (`ChargeType` — ใช้กับ rate card และค่าบริการเสริมใน 02-master-data)

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| code, nameTh/En/Zh | text | ✓ | code unique ต่อ tenant | เช่น FREIGHT, LOADING, WAITING, FUEL_SC, TOLL |
| taxCategory | enum `EXEMPT_TRANSPORT` \| `VAT7` \| `NON_VAT` | ✓ | `VAT7` ห้ามถ้า entity ไม่จด VAT | `NON_VAT` = tenant ไม่จด VAT |
| whtCategory | enum `FREIGHT` \| `SERVICE` \| `NONE` \| `OTHER` | ✓ | | |
| whtRate | decimal(5,2) | ✓ | 0–15 | FREIGHT ค่าเริ่มต้น 1.00, SERVICE 3.00 [FACT] T4 |
| isSystemPreset | bool | | | ค่าตั้งต้นของระบบ ผู้ใช้แก้ได้ แต่ระบบเตือนเมื่อเปลี่ยน taxCategory/whtRate ของ FREIGHT |
| glAccountRevenue / glAccountCost | text | | | ใช้กับ journal export (§14) |

ค่าตั้งต้นที่ระบบใส่ให้ (แก้ได้) — การจัดหมวดค่าน้ำมัน/ทางด่วน/ค่ารอ **[OPEN] Q2**

| code | ชื่อ | taxCategory | whtCategory / rate | ป้าย |
|---|---|---|---|---|
| FREIGHT | ค่าขนส่ง | EXEMPT_TRANSPORT | FREIGHT 1% | [FACT] |
| LOADING | ค่ายกขน/ขึ้น-ลงสินค้า | VAT7 | SERVICE 3% | [FACT] VAT (TAX §1.8); WHT ตามนิยามค่าบริการ [FACT] TAX §3.1 |
| CONTAINER_SVC | ค่าลานตู้/ยกตู้/ล้างตู้/เช็คอุณหภูมิ | VAT7 | SERVICE 3% | [FACT] |
| WAITING | ค่ารอ (demurrage) | EXEMPT_TRANSPORT | FREIGHT 1% | [OPEN] Q2 — ตั้งให้ผู้ใช้ยืนยันตอน onboarding |
| FUEL_SC | fuel surcharge | EXEMPT_TRANSPORT | FREIGHT 1% | [OPEN] Q2 |
| TOLL | ค่าทางด่วนเรียกเก็บแยก | EXEMPT_TRANSPORT | FREIGHT 1% | [OPEN] Q2 |
| EXTRA_STOP / OVERNIGHT | ค่าจุดเพิ่ม / ค่าค้างคืน | EXEMPT_TRANSPORT | FREIGHT 1% | [OPEN] Q2 |

ระดับลูกค้า (`Customer.billingProfile`)

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| taxId / branchCode / branchLabel | char(13)/char(5) | ✓ ถ้าเป็นนิติบุคคล | checksum | T6; บุคคลธรรมดาต้องมีนามสกุล [FACT] TAX §1.2 |
| isJuristic | bool | ✓ | | true → คาดว่าลูกค้าหัก WHT (T4) |
| creditTermDays | int | ✓ | 0–180 | |
| dueDateFrom | enum `INVOICE_DATE` \| `BILLING_NOTE_DATE` | ✓ | | ค่าเริ่มต้น `INVOICE_DATE` |
| billingCycle | enum `PER_DO` \| `PER_TRIP` \| `WEEKLY` \| `SEMI_MONTHLY` \| `MONTHLY` | ✓ | | |
| cutoffDay | int | | 1–31 | ใช้กับ MONTHLY/SEMI_MONTHLY |
| billingNoteRequired | bool | | | ลูกค้าที่ต้องวางบิลก่อนรับเช็ค |
| billingDays / chequeDays | text | | | เช่น "วางบิลทุกวันที่ 25" / "รับเช็คทุกศุกร์สุดท้าย" |
| taxInvoiceTiming | enum `ON_PAYMENT` \| `ON_INVOICE` | | | override ค่า entity — [OPEN] Q4 |
| requirePodForBilling | enum `NONE` \| `UPLOADED` \| `VERIFIED` | ✓ | | ค่าเริ่มต้น `VERIFIED` |
| requirePoNumber | bool | | | ต้องมีเลข PO ลูกค้าก่อนออก INV |
| invoiceGrouping | enum `ONE_PER_DO` \| `ONE_PER_TRIP` \| `ONE_PER_PERIOD` \| `PER_PO` | ✓ | | |
| billingContacts | list(email, name) | | email | ส่ง PDF |
| defaultIssuingBranchId | FK | ✓ | | สาขาที่ออกเอกสาร |

5. **กฎธุรกิจ**

- **BIL-001** [FACT] entity ที่ `vatRegistered=false` ออกได้เฉพาะ INV/BN/RC/ACN/ADN/PV/WHT; ปุ่ม/ตัวเลือก RT, CN, DN ต้องไม่แสดง และ API ตอบ `422 VAT_NOT_REGISTERED`
- **BIL-002** [PROPOSED] เปลี่ยน `taxCategory`/`whtRate` ของ ChargeType มีผลเฉพาะบรรทัดที่สร้างหลังเปลี่ยน; บรรทัดในเอกสารที่ออกแล้วเก็บ snapshot ไม่เปลี่ยนตาม
- **BIL-003** [DECISION D2] ไม่มี ChargeType หรือบัญชีใดผูกชื่อ ERP; รหัสบัญชีปลายทางอยู่ใน field mapping ของ connector (07-integration)
- **BIL-004** [PROPOSED] เมื่อเอกสารมีทั้ง EXEMPT และ VAT7: `SPLIT` = ออก RC (ส่วนยกเว้น) + RT (ส่วน VAT) แยกเลข; `SINGLE` = ออก RT ใบเดียวที่แสดงบรรทัดยกเว้น VAT แยก (ป.86/2542 ข้อ 4(5) [FACT]) — ให้นักบัญชีของ tenant เลือก [OPEN] Q3
- **BIL-005** [FACT] ไม่รองรับใบกำกับภาษีอย่างย่อ (T8)
- **BIL-006** [PROPOSED] ราคาเหมาที่รวมขนส่ง+บริการประกอบเป็นก้อนเดียว ระบบบังคับให้แยกเป็นบรรทัดตาม ChargeType ก่อนออก INV — การตีความสัญญาราคาเดียว **[OPEN] Q1**
- **BIL-007** ตอน onboarding ถามสถานะจด VAT ของนิติบุคคล (ไม่ตั้งค่าเดาให้) — กรณีกิจการที่รายได้ยกเว้นทั้งหมดจะจด VAT ได้หรือไม่ **[OPEN] Q10**

6. **สถานะ** — ไม่มี (ข้อมูลตั้งค่า) ทุกการแก้บันทึก audit (ค่าเก่า/ใหม่ ใคร เมื่อไร)
7. **event** — `billing_settings.updated`, `charge_type.updated`
8. **กรณีผิดปกติ** — เปลี่ยน `vatRegistered` true→false ขณะมี INV ที่มีบรรทัด VAT7 ค้างรับชำระ → บล็อกพร้อมรายการเอกสารที่ต้องจัดการ; ลูกค้าไม่มี taxId แต่ `isJuristic=true` → เตือนตอนบันทึก และบล็อกตอนออก RT (T6)
9. **เกณฑ์ตรวจรับ**
   - Given entity ไม่จด VAT · When สร้าง ChargeType taxCategory=VAT7 · Then ระบบปฏิเสธพร้อมข้อความ "บริษัทยังไม่จดทะเบียน VAT"
   - Given ChargeType FREIGHT whtRate 1% และ INV ออกแล้ว · When แก้ whtRate เป็น 3% · Then INV เดิมยังแสดง 1%
10. **เฟส** — P0

---

## 2. คิวพร้อมวางบิล (Ready-to-bill queue)

1. **จุดประสงค์** — รวม DO ที่ส่งสำเร็จและผ่านเงื่อนไข POD ไว้ที่เดียว กันวางบิลซ้ำ/หลุด (B3)
2. **ผู้ใช้/สิทธิ์** — accounting (`billing.invoice:create`), manager; dispatcher อ่านได้
3. **หน้าจอ** — บัญชี > วางบิล: KPI (พร้อมวางบิล · POD ยังไม่ผ่าน · ร่าง · ออกแล้วรอชำระ · เกินกำหนด — R2) → แท็บ → ตาราง DO; ตัวกรอง: ลูกค้า, งวด (วันที่ส่ง), สาขา, **"POD ผ่าน AI แล้ว"**, มี/ไม่มีเลข PO, เส้นทาง, ประเภทรถ; stepper สร้างใบ: เลือกลูกค้า+งวด → ติ๊ก DO → ตรวจ → ออกเอกสาร (design-briefs รอบ 1 ข้อ 4)
4. **ฟิลด์** (คอลัมน์ตาราง) — เลข DO, เลข SO, เลข PO ลูกค้า, วันที่ส่ง, ปลายทาง, ทะเบียน/รถร่วม, สถานะ POD (`NONE` · `UPLOADED` · `AI_PASSED` · `AI_FLAGGED` · `VERIFIED` · `REJECTED`), ยอดก่อน VAT, ยอดยกเว้น, ฐาน VAT 7%, สถานะราคา (ยืนยันแล้ว/ไม่พบเรท), ป้าย "ระงับวางบิล"
5. **กฎธุรกิจ**

- **BIL-020** DO เข้าคิวเมื่อครบทุกข้อ: (ก) สถานะ DO = `DELIVERED` หรือ `PARTIALLY_DELIVERED` หรือ `FAILED` ที่มีบรรทัดรายได้เรียกเก็บได้ (เช่น ค่าเที่ยวเปล่า) (ข) POD ผ่านตาม `requirePodForBilling` ของลูกค้า (ค) ทุกบรรทัดรายได้มีราคา (ง) ไม่มีป้ายระงับวางบิล (จ) ไม่อยู่ในบรรทัด INV ที่ active
- **BIL-021** ตัวกรอง "POD ผ่าน AI แล้ว" = สถานะ POD ∈ {`AI_PASSED`, `VERIFIED`}; `AI_FLAGGED` ต้องให้คนตรวจก่อน (D5); ระบบไม่ออกเอกสารเองจากผล AI — ผู้ใช้ต้องกดออก
- **BIL-022** [PROPOSED] unique constraint บน `InvoiceLine(sourceType, sourceLineId)` เฉพาะบรรทัดที่ INV สถานะไม่ใช่ `CANCELLED` (B3) — DO เดียวอยู่ได้ใน INV ที่ active เพียงใบเดียว
- **BIL-023** บรรทัดรายได้มาจาก revenue line ของ DO/เที่ยว (B1) ที่สร้างตั้งแต่ตอน SO/DO; ระบบ rebuild เฉพาะบรรทัดที่ระบบสร้าง เก็บบรรทัดที่ผู้ใช้เพิ่มเอง
- **BIL-024** DO ที่อยู่ใน INV ร่างถูกล็อก (แก้ราคาไม่ได้ ต้องเอาออกจากร่างก่อน) (B2)
- **BIL-025** รายงาน "งานที่ยังไม่วางบิล" แสดงอายุ (วันนับจากวันส่ง) และเตือนเมื่อเกิน N วัน (ตั้งค่า, ค่าเริ่มต้น 15)

6. **สถานะ** (`DO.billingStatus`) — `NOT_READY` → `READY` → `DRAFTED` → `INVOICED` → (`CANCELLED_INVOICE` กลับเป็น `READY`)

| จาก | ไป | เงื่อนไข | ใคร | ผลข้างเคียง |
|---|---|---|---|---|
| NOT_READY | READY | BIL-020 ครบ | ระบบ | event `do.ready_to_bill` |
| READY | DRAFTED | ใส่ใน INV ร่าง | accounting | ล็อกราคา DO |
| DRAFTED | READY | เอาออกจากร่าง/ลบร่าง | accounting | ปลดล็อก |
| DRAFTED | INVOICED | INV ออก | accounting | |
| INVOICED | READY | INV ถูกยกเลิก | accounting | log อ้างเลข INV ที่ยกเลิก |

7. **event** — `do.ready_to_bill`, `do.billing_hold_set`, `do.billing_hold_released`
8. **กรณีผิดปกติ** — POD ถูกตีกลับ (REJECTED) หลังเข้าคิว → ถอดออกจากคิว ถ้าอยู่ในร่างให้ป้ายเตือนแดงในร่าง; DO ราคาไม่พบเรท → ไม่เข้าคิว แสดงในแท็บ "ราคายังไม่ครบ"; สองคนเลือก DO เดียวกันพร้อมกัน → คนที่สองได้ `409 DO_ALREADY_DRAFTED`
9. **เกณฑ์ตรวจรับ**
   - Given ลูกค้า requirePodForBilling=VERIFIED และ DO มี POD สถานะ AI_FLAGGED · When เปิดคิวพร้อมวางบิล · Then DO อยู่แท็บ "POD ยังไม่ผ่าน" ไม่อยู่ "พร้อมวางบิล"
   - Given DO-001 อยู่ใน INV ที่ออกแล้ว · When พยายามสร้าง INV ใหม่ที่มี DO-001 · Then ระบบปฏิเสธ `409`
10. **เฟส** — P0

---

## 3. ใบแจ้งหนี้ (INV) และใบวางบิล (BN)

1. **จุดประสงค์** — ออกเอกสารเรียกเก็บเงินจาก DO ตามรอบบิลลูกค้า โดยยังไม่ใช่เอกสารภาษี (T3)
2. **ผู้ใช้/สิทธิ์** — accounting: สร้าง/แก้ร่าง/ออก (`billing.invoice:create|issue`); manager: ยกเลิก (`billing.invoice:cancel`); viewer อ่าน
3. **หน้าจอ** — รายการใบแจ้งหนี้ (แท็บสถานะ: ร่าง · ออกแล้ว · ชำระบางส่วน · ชำระแล้ว · เกินกำหนด · ยกเลิก + คอลัมน์ "ระบบบัญชี" แสดงเมื่อมี connector), drawer มาตรฐาน (แท็บ สรุป / รายการ / เอกสารแนบ / กิจกรรม; footer: ยอดคงค้าง + ปุ่ม "รับชำระ"), ฟอร์มสร้างใบวางบิล (เลือกลูกค้า → ติ๊ก INV ค้าง → วันนัดรับเช็ค)
4. **ฟิลด์**

`Invoice`

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| id | uuid | ✓ | | |
| docNo | text | ตอนออก | จาก series §8 | ร่างไม่มีเลข (B9) |
| status | enum | ✓ | §3.6 | |
| legalEntityId / issuingBranchId | FK | ✓ | | |
| customerId + snapshot (ชื่อ ที่อยู่ taxId branch) | FK + json | ✓ | | snapshot ตอนออก |
| issueDate | date | ตอนออก | ≥ วันที่ INV ล่าสุดของ series (BIL-084) | |
| periodFrom / periodTo | date | | from ≤ to | งวดของ DO |
| creditTermDays | int | ✓ | | copy จากลูกค้า แก้ได้ในร่าง |
| dueDate | date | ✓ | ≥ issueDate | BIL-031 |
| customerPoNo | text | ตามลูกค้า | | |
| lines | list(InvoiceLine) | ✓ ≥1 | | |
| subtotalExempt | decimal(14,2) | คำนวณ | | Σ บรรทัด EXEMPT_TRANSPORT |
| subtotalVatBase | decimal(14,2) | คำนวณ | | Σ บรรทัด VAT7 |
| subtotalNonVat | decimal(14,2) | คำนวณ | | Σ บรรทัด NON_VAT |
| vatAmount | decimal(14,2) | คำนวณ | | BIL-032 |
| grandTotal | decimal(14,2) | คำนวณ | | exempt + vatBase + nonVat + vat |
| whtExpected | decimal(14,2) | คำนวณ | | BIL-033 (ข้อมูลประมาณการ ไม่ใช่ยอดหักจริง) |
| netExpected | decimal(14,2) | คำนวณ | | grandTotal − whtExpected |
| paidAmount / whtReceived / outstanding | decimal | คำนวณ | | จาก Payment allocations |
| taxInvoiceTiming | enum | ✓ | | copy จากลูกค้า |
| billingNoteId | FK | | | |
| notes / internalNotes | text | | ≤ 2,000 | |
| customFields | json | | ตามนิยาม | แสดงในกล่อง "ข้อมูลอ้างอิง" บน A4 ถ้าตั้งไว้ |
| pdfFileId | FK | ตอนออก | | PDF ที่ render ณ วันออก (immutable) |
| syncStatus[] | ดู §15 | | | แยกจาก status (D3) |

`InvoiceLine`

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| lineNo | int | ✓ | | |
| sourceType / sourceLineId | enum/uuid | | | DO revenue line หรือ MANUAL |
| doId / tripId / soId | FK | | | อ้างอิงพิมพ์ |
| chargeTypeId | FK | ✓ | | |
| description | text | ✓ | ≤ 500 | เช่น "ค่าขนส่ง อยุธยา → สระบุรี · พ่วง · DO-2611-0012" |
| qty / unit / unitPrice | decimal(12,4)/text/decimal(14,4) | ✓ | qty > 0 | |
| discount | decimal(14,2) | | ≥ 0, ≤ qty×unitPrice | |
| amount | decimal(14,2) | คำนวณ | | round(qty×unitPrice − discount, 2) |
| taxCategory | enum | ✓ | snapshot จาก ChargeType | แก้ได้ในร่างพร้อมเหตุผล |
| whtCategory / whtRate | enum / decimal | ✓ | snapshot | |
| plateNo | text | | | optional บนเอกสาร [FACT] TAX §1.2 ข้อ 4 (ไม่บังคับขนส่ง) |

`BillingNote`

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| docNo / status / issueDate | | ✓ | | status: DRAFT · ISSUED · ACKNOWLEDGED · CLOSED · CANCELLED |
| customerId | FK | ✓ | | |
| invoiceIds | list | ✓ ≥1 | INV ต้องสถานะ ISSUED/PARTIALLY_PAID/OVERDUE ของลูกค้าเดียวกัน | |
| totalOutstanding | decimal | คำนวณ | | Σ outstanding ณ วันออก |
| chequeAppointmentDate | date | | ≥ issueDate | วันนัดรับเช็ค [OPINION ใน TAX §6.1] |
| acknowledgedBy / acknowledgedAt / ackFileId | text/datetime/file | | | ลายเซ็นผู้รับวางบิล (รูปถ่าย) |

5. **กฎธุรกิจ**

- **BIL-030** การจัดกลุ่ม DO เป็น INV ตาม `invoiceGrouping`: `ONE_PER_DO` = 1 DO/ใบ, `ONE_PER_TRIP` = DO ของลูกค้าเดียวในเที่ยวเดียว, `ONE_PER_PERIOD` = ทุก DO ในงวด, `PER_PO` = แยกตามเลข PO; INV หนึ่งใบมีได้ลูกค้าเดียว สาขาผู้ออกเดียว
- **BIL-031** `dueDate = issueDate + creditTermDays` ถ้า `dueDateFrom=INVOICE_DATE`; ถ้า `BILLING_NOTE_DATE` ให้ dueDate ชั่วคราว = issueDate + creditTermDays แล้วคำนวณใหม่เมื่อ BN ที่รวม INV นั้นถูก `ACKNOWLEDGED` (= ackDate + creditTermDays)
- **BIL-032** [PROPOSED] VAT คิดระดับเอกสาร: `vatAmount = round_half_up(subtotalVatBase × 0.07, 2)`; ไม่ปัดรายบรรทัด (ส่วนต่างจากปัดเศษยอมรับได้ [FACT] TAX §1.2 ป.86/2542 ข้อ 10)
- **BIL-033** [PROPOSED] `whtExpected = Σ_{category} round_half_up(Σ amount ของบรรทัดใน category × rate, 2)` เฉพาะเมื่อลูกค้า `isJuristic=true` และยอดฐานผ่านเกณฑ์ `whtMinPerContract` ตาม `whtThresholdBasis`; ฐาน WHT = ยอดก่อน VAT [PROPOSED] — [OPEN] Q13
- **BIL-034** INV เป็นเอกสารภายใน ไม่มีคำว่า "ใบกำกับภาษี" บนเอกสารเมื่อ `taxInvoiceTiming=ON_PAYMENT` [FACT] T3
- **BIL-035** ถ้า `taxInvoiceTiming=ON_INVOICE` และ INV มีบรรทัด VAT7 → ตอนออก INV ระบบออก RT (ใบกำกับภาษี) สำหรับส่วน VAT พร้อมกัน ลงวันที่ = issueDate ของ INV และนับเข้ารายงานภาษีขายเดือนนั้น (tax point เกิดเมื่อออก [FACT] T3); ใบนี้ไม่ใช่ใบเสร็จ — พิมพ์หัว "ใบแจ้งหนี้/ใบกำกับภาษี" แล้วออก RC ตอนรับเงิน [PROPOSED] — [OPEN] Q4
- **BIL-036** INV ที่ `ISSUED` แก้ไม่ได้ (immutable, B2) — แก้ยอดด้วย ACN/ADN (ยังไม่มี RT) หรือ CN/DN (มี RT แล้ว) หรือยกเลิกแล้วออกใหม่ (§7)
- **BIL-037** ก่อนออก INV ตรวจ: ลูกค้ามี taxId+branch (ถ้านิติบุคคล), เลข PO (ถ้า requirePoNumber), ทุกบรรทัดมี taxCategory, ยอด > 0; ไม่ผ่านแสดงรายการปัญหาในขั้น "ตรวจ"
- **BIL-038** INV ที่ยอด VAT7 > 0 แต่ entity ไม่จด VAT → ห้ามออก (BIL-001)
- **BIL-039** ใบวางบิลรวมได้เฉพาะ INV ที่ยังค้างชำระ; INV หนึ่งใบอยู่ใน BN ที่ active ได้ใบเดียว; ยกเลิก BN ไม่กระทบ INV
- **BIL-040** สถานะ `OVERDUE` คำนวณโดย job รายวัน 00:05 (Asia/Bangkok): `dueDate < today และ outstanding > 0`
- **BIL-041** ส่ง INV/BN ทางอีเมลไปยัง billingContacts แนบ PDF; บันทึกเวลาส่งและผู้ส่งในแท็บกิจกรรม
- **BIL-042** การออก INV ทีละหลายใบ (หลายลูกค้า) ทำเป็น async job (B10) สถานะ `PENDING/COMPLETED/ERROR` ต่อใบ ใบที่ error ไม่ทำให้ใบอื่นล้ม

6. **สถานะ** `Invoice.status`: `DRAFT` · `ISSUED` · `PARTIALLY_PAID` · `PAID` · `OVERDUE` · `CANCELLED`

| จาก | ไป | เงื่อนไข | ใคร | ผลข้างเคียง |
|---|---|---|---|---|
| — | DRAFT | สร้างจากคิว/สร้างเอง | accounting | DO → DRAFTED |
| DRAFT | (ลบ) | ยังไม่ออก | accounting | ลบได้จริงเพราะไม่มีเลข; DO → READY |
| DRAFT | ISSUED | BIL-037 ผ่าน | accounting | จองเลข (§8), render PDF, DO → INVOICED, (ON_INVOICE → ออก RT), enqueue sync |
| ISSUED/OVERDUE | PARTIALLY_PAID | รับชำระ 0 < applied < grandTotal | accounting | |
| ISSUED/PARTIALLY_PAID/OVERDUE | PAID | outstanding = 0 | ระบบ | event `invoice.paid` |
| ISSUED/PARTIALLY_PAID | OVERDUE | BIL-040 | ระบบ | แจ้งเตือนผู้รับผิดชอบลูกค้า |
| ISSUED/OVERDUE | CANCELLED | ไม่มี payment ที่ active และไม่มี RT ที่ active; เหตุผล ≥ 10 ตัวอักษร | manager | DO → READY, ส่ง void ไป connector |
| PAID | ISSUED/PARTIALLY_PAID | payment ถูก void (§4) | ระบบ | |

7. **event** — `invoice.created`, `invoice.issued`, `invoice.sent`, `invoice.partially_paid`, `invoice.paid`, `invoice.overdue`, `invoice.cancelled`, `billing_note.issued`, `billing_note.acknowledged`, `billing_note.cancelled`
8. **กรณีผิดปกติ** — ลูกค้าเปลี่ยนที่อยู่หลังออก INV → INV ใช้ snapshot เดิม (การออก RT ภายหลังใช้ข้อมูลปัจจุบันของลูกค้า [FACT] TAX §1.2 ป.86/2542 ข้อ 11); job ออกเลขล้ม → INV คง DRAFT ไม่ใช้เลข; ส่งอีเมลไม่สำเร็จ → สถานะการส่งแยก ไม่กระทบสถานะ INV
9. **เกณฑ์ตรวจรับ**
   - Given ลูกค้าเครดิต 30 วัน dueDateFrom=INVOICE_DATE · When ออก INV วันที่ 1 พ.ย. 2569 · Then dueDate = 1 ธ.ค. 2569
   - Given INV บรรทัด ค่าขนส่ง 10,000.00 (EXEMPT, WHT 1%) และค่ายกขน 1,000.00 (VAT7, WHT 3%) ลูกค้านิติบุคคล · When ออก INV · Then subtotalExempt 10,000.00, subtotalVatBase 1,000.00, vatAmount 70.00, grandTotal 11,070.00, whtExpected 130.00 (100.00 + 30.00), netExpected 10,940.00 และเอกสารไม่มีคำว่า "ใบกำกับภาษี"
   - Given INV ค่าขนส่งล้วน 25,000.00 · When ออก · Then vatAmount 0.00, ไม่มีบรรทัด "ฐาน VAT 7%", whtExpected 250.00
   - Given INV ออกแล้ว · When แก้ราคาบรรทัด · Then ปุ่มแก้ไม่แสดง และ API ตอบ `409 DOCUMENT_LOCKED`
10. **เฟส** — P0 (INV, BN, async ออกหลายใบ); ส่งอีเมล P0

---

## 4. รับชำระ (Receive payment)

1. **จุดประสงค์** — บันทึกเงินรับจริง (เต็ม/บางส่วน, หลายใบ) พร้อม WHT ที่ลูกค้าหัก และออกใบเสร็จ/ใบกำกับภาษีทันที
2. **ผู้ใช้/สิทธิ์** — accounting (`billing.payment:create`); void ต้อง manager (`billing.payment:void`)
3. **หน้าจอ** — บัญชี > รับชำระ: KPI (รับวันนี้ · รอ 50 ทวิ · เช็ครอเคลียร์ · เงินรับยังไม่ตัดใบ) → ตาราง → ฟอร์มรับชำระ (เลือกลูกค้า → ตาราง INV ค้าง ติ๊ก/กรอกยอดตัดต่อใบ → ช่องเงินรับ, WHT, ค่าธรรมเนียม → แนบสลิป/50 ทวิ → สรุปเอกสารที่จะออก) ; แท็บ AR aging (สรุป ดู 09-reports)
4. **ฟิลด์** `Payment`

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| docNo | text | ✓ | series `PAY` | เลขภายใน |
| customerId | FK | ✓ | | |
| receivedDate | date | ✓ | ≤ วันนี้ | = tax point ของ RT (T3) |
| method | enum `TRANSFER` \| `CHEQUE` \| `CASH` \| `PROMPTPAY` \| `OFFSET` | ✓ | | |
| bankAccountId | FK | ✓ ถ้าไม่ใช่ CASH | บัญชีของ entity | |
| cashAmount | decimal(14,2) | ✓ | ≥ 0 | เงินเข้าจริง |
| whtAmount | decimal(14,2) | | ≥ 0 | ยอดที่ลูกค้าหัก |
| bankFee | decimal(14,2) | | ≥ 0 | ค่าธรรมเนียมโอนที่ลูกค้าหัก |
| chequeNo / chequeDate / chequeBank | text/date/text | ✓ ถ้า CHEQUE | | |
| chequeStatus | enum `PENDING` \| `CLEARED` \| `BOUNCED` | | | |
| slipFileIds | list(file) | | ≤ 10 MB/ไฟล์ | |
| allocations | list {invoiceId, appliedAmount, whtApplied} | ✓ ≥1 หรือ unapplied | Σ ตรง BIL-051 | |
| unappliedAmount | decimal | คำนวณ | ≥ 0 | เครดิตลูกค้า |
| whtCert | {certNo, certDate, file, formType: PND3 \| PND53, status} | | | 50 ทวิ ที่ได้รับ |
| receiptDocIds | list | ระบบ | | RC/RT ที่ออก |

5. **กฎธุรกิจ**

- **BIL-050** รับชำระได้หลาย INV ของลูกค้าเดียวกันในครั้งเดียว และ INV เดียวรับได้หลายครั้ง (partial)
- **BIL-051** สมการกระทบยอด: `cashAmount + whtAmount + bankFee = Σ allocations.appliedAmount + unappliedAmount`; `appliedAmount ≤ outstanding` ของแต่ละ INV; ไม่ตรง → บันทึกไม่ได้
- **BIL-052** `whtAmount` ต่างจาก Σ whtExpected ของ INV ที่ตัด > 1.00 บาท → เตือน (ไม่บล็อก) และให้เลือกเหตุผล (ลูกค้าหักอัตราอื่น / ยังไม่หัก / อื่น ๆ)
- **BIL-053** [PROPOSED] ทุก payment ที่บันทึก → ออกเอกสารรับเงินทันที (T3, ม.105 "ทันทีที่รับเงิน" [FACT]) ต่อ 1 payment:
  - ส่วนที่ตัดจากยอดยกเว้น/NON_VAT → RC 1 ใบ (ครอบหลาย INV ได้)
  - ส่วนที่ตัดจากยอด VAT7 ของ INV ที่ยังไม่มี RT (`ON_PAYMENT`) → RT 1 ใบ (ครอบหลาย INV ได้)
  - `mixedVatDocMode=SINGLE` → RT ใบเดียวที่แสดงบรรทัดยกเว้นแยก แทน RC+RT
  - INV ที่ออก RT ไปแล้วตอนออก INV (`ON_INVOICE`) → ออก RC เท่านั้น
- **BIL-054** [PROPOSED] การแบ่งเงินที่ชำระบางส่วนระหว่างส่วนยกเว้นและส่วน VAT ของ INV เดียว = **ตามสัดส่วน** ของยอดรวมแต่ละส่วนใน grandTotal; ปัดเศษให้ส่วน VAT ก่อน แล้วส่วนยกเว้นรับเศษที่เหลือ — [OPEN] Q14 (ทางเลือก: ตัดส่วน VAT ก่อน)
  - สูตร: `vatPortionGross = round(applied × (vatBase + vat) / grandTotal, 2)`; `rtBase = round(vatPortionGross / 1.07, 2)`; `rtVat = vatPortionGross − rtBase`; `exemptPortion = applied − vatPortionGross`
- **BIL-055** RT ลงวันที่ = `receivedDate` (tax point) และต้องไม่น้อยกว่าวันที่ของ RT ล่าสุดใน series (BIL-084); ถ้าน้อยกว่า → บล็อก และให้ผู้ใช้เลือก: ใช้วันที่บันทึก (วันนี้) พร้อมเหตุผล หรือยกเลิก — [OPEN] Q15
- **BIL-056** RC/RT แสดงยอดรับรวม (appliedAmount) และแจกแจงวิธีรับ: เงินโอน/เช็ค X, ภาษีหัก ณ ที่จ่าย Y, ค่าธรรมเนียม Z [PROPOSED]
- **BIL-057** 50 ทวิ จากลูกค้า: สถานะ `NOT_EXPECTED` · `PENDING` (whtAmount > 0 แต่ยังไม่แนบ) · `RECEIVED` (แนบไฟล์+เลขที่) · `VERIFIED` (บัญชีตรวจยอด/เลขผู้เสียภาษีตรง); แจ้งเตือนรายการ PENDING เกิน 30 วัน และสรุปใน 09-reports
- **BIL-058** `unappliedAmount` เป็นเครดิตลูกค้า ใช้ตัด INV ภายหลังด้วย method=`OFFSET` (ไม่ออก RC/RT ซ้ำสำหรับเงินที่ออกใบรับไปแล้ว — RC ของเงินเกินออกตอนรับเงินในชื่อ "รับล่วงหน้า") [PROPOSED] — [OPEN] Q16 (เงินรับล่วงหน้าค่าบริการ VAT7 เกิด tax point ทันทีหรือไม่)
- **BIL-059** ผลต่างเล็กน้อย (ลูกค้าจ่ายขาด ≤ ค่าที่ตั้ง เช่น 10.00 บาท) → manager อนุมัติ "ตัดจำหน่ายส่วนต่าง" เป็นรายการปรับภายใน (ไม่ใช่ CN) [PROPOSED]
- **BIL-060** เช็ค: [PROPOSED] ออก RC/RT เมื่อบันทึกรับเช็ค — tax point ของการรับเช็ค (วันรับเช็ค vs วันเช็คผ่าน) **[OPEN] Q17**; เช็คเด้ง (BOUNCED) → payment void ตาม BIL-061
- **BIL-061** void payment: ต้องยกเลิก RC/RT ที่ออกจาก payment นั้นด้วย (ตาม §7) เหตุผล ≥ 10 ตัวอักษร; INV กลับสถานะก่อนหน้า; ถ้า RT อยู่ในเดือนภาษีที่ยื่นแล้ว → เตือนให้ปรึกษานักบัญชี (อาจต้องใช้ CN แทน) [OPEN] Q18
- **BIL-062** [PROPOSED] กระทบยอดธนาคาร (P1): นำเข้า statement CSV ของธนาคาร → จับคู่อัตโนมัติด้วย ยอด + วันที่ ±3 วัน + ชื่อผู้โอน → ผู้ใช้ยืนยัน; ไม่สร้าง payment อัตโนมัติ (D5)
- **BIL-063** AI อ่านสลิปโอน (08-ai) เติมยอด/วันที่/ธนาคารเป็นร่าง — ผู้ใช้ยืนยันก่อนบันทึก (D5)

6. **สถานะ** `Payment.status`: `POSTED` · `VOIDED`; `chequeStatus` แยก

| จาก | ไป | เงื่อนไข | ใคร | ผลข้างเคียง |
|---|---|---|---|---|
| — | POSTED | BIL-051 ผ่าน | accounting | ออก RC/RT, อัปเดต INV, enqueue sync |
| POSTED | VOIDED | เหตุผล; ยกเลิก RC/RT สำเร็จ | manager | INV ย้อนสถานะ, ส่ง void ไป connector |

7. **event** — `payment.received`, `payment.voided`, `receipt.issued`, `tax_invoice.issued`, `wht_certificate.received`, `cheque.bounced`
8. **กรณีผิดปกติ** — บันทึกซ้ำ (ลูกค้า + ยอด + วันที่ + เลขอ้างอิงสลิปเดียวกัน) → เตือนว่าอาจซ้ำ; ลูกค้าโอนรวมหลายบริษัทในเครือ → ต้องแยกเป็น payment ต่อลูกค้า (ตาม taxId+branch); ออกเอกสารล้มกลาง transaction → rollback ทั้ง payment (ไม่มีเลขรั่ว — BIL-083)
9. **เกณฑ์ตรวจรับ**
   - Given INV-A ค่าขนส่งล้วน 25,000.00 · When รับโอน 24,750.00 + WHT 250.00 · Then INV-A = PAID, ออก RC 25,000.00 ใบเดียว ไม่มี RT, 50 ทวิ สถานะ PENDING
   - Given INV-B (ยกเว้น 10,000.00 + ฐาน VAT 1,000.00 + VAT 70.00 = 11,070.00) และ mixedVatDocMode=SPLIT · When รับเต็ม cash 10,940.00 + WHT 130.00 · Then ออก RC ยอด 10,000.00 และ RT ฐาน 1,000.00 VAT 70.00 รวม 1,070.00 ลงวันที่ receivedDate
   - Given INV-B เดิม · When รับบางส่วน applied 5,535.00 · Then vatPortionGross = 535.00, RT ฐาน 500.00 VAT 35.00, RC 5,000.00, INV-B = PARTIALLY_PAID outstanding 5,535.00
   - Given payment หนึ่งรายการตัด INV-A 25,000.00 และ INV-B 11,070.00 · When บันทึก · Then ออก RC 1 ใบ (35,000.00) + RT 1 ใบ (1,070.00)
   - Given cash 10,000 + WHT 100 แต่ allocations รวม 10,200 · When บันทึก · Then ปฏิเสธ "ยอดรับไม่ตรงยอดตัด ขาด 100.00"
10. **เฟส** — P0 (รับชำระ, RC/RT, 50 ทวิ รับ); P1 (กระทบยอดธนาคาร, AI อ่านสลิป)

---

## 5. ใบเสร็จรับเงิน (RC) และใบเสร็จรับเงิน/ใบกำกับภาษี (RT)

1. **จุดประสงค์** — เอกสารรับเงินตามกฎหมาย; RT เป็นใบกำกับภาษีเต็มรูปเฉพาะส่วน VAT7
2. **ผู้ใช้/สิทธิ์** — ระบบออกจาก payment; accounting ดู/พิมพ์/ส่ง/ออกใบแทน; manager ยกเลิก
3. **หน้าจอ** — บัญชี > ใบเสร็จ/ใบกำกับภาษี: แท็บ ใบเสร็จ · ใบกำกับภาษี · ยกเลิก; drawer: ข้อมูลเอกสาร, payment ต้นทาง, INV ที่อ้าง, ประวัติพิมพ์/ใบแทน
4. **ฟิลด์** `TaxDocument` (ใช้ร่วม RC/RT/CN/DN)

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| docType | enum RC/RT/CN/DN | ✓ | | |
| docNo | text | ✓ | series §8 | |
| issueDate | date | ✓ | BIL-055 | |
| issuingBranch snapshot | json | ✓ | | ชื่อ ที่อยู่ taxId branchLabel |
| buyer snapshot | json | ✓ | RT: taxId+branch บังคับถ้าผู้ซื้อมีเลข [FACT] T6 | |
| lines | list | ✓ | | ชื่อ ชนิด ปริมาณ มูลค่า [FACT] ม.86/4(5) |
| exemptAmount / vatBase / vatAmount / total | decimal | ✓ | vatAmount แยกจากมูลค่า [FACT] ม.86/4(6) | |
| paymentId / invoiceIds | FK | ✓ (RC/RT) | | |
| replacesDocId | FK | | | ใบที่ออกแทนฉบับที่ยกเลิก (§7) |
| replacementCopies | list {issuedAt, by, reason} | | | ใบแทน ม.86/12 |
| status | enum `ISSUED` \| `CANCELLED` | ✓ | | |
| cancelReason / cancelledAt / cancelledBy | | เมื่อยกเลิก | ≥ 10 ตัวอักษร | |
| pdfFileId | FK | ✓ | | immutable |
| salesTaxReportMonth | yyyy-mm | RT/CN/DN | | = เดือนของ issueDate |

5. **กฎธุรกิจ**

- **BIL-070** [FACT] RT ต้องมีครบ: คำว่า "ใบกำกับภาษี" เด่นชัด; ชื่อ ที่อยู่ เลขผู้เสียภาษีผู้ออก + "สำนักงานใหญ่"/"สาขาที่ xxxxx"; ชื่อ ที่อยู่ผู้ซื้อ + เลขผู้เสียภาษี + สำนักงานใหญ่/สาขา (เมื่อผู้ซื้อจด VAT); เลขลำดับ; รายการ ชนิด ปริมาณ มูลค่า (แยกรายการยกเว้น VAT); VAT แยก; วันที่ออก; ภาษาไทย/เงินบาท (TAX §1.2, §6.1)
- **BIL-071** [FACT] RT/RC ที่พิมพ์รวมชุดและไม่ใช่แผ่นแรกต้องพิมพ์ "เอกสารออกเป็นชุด" จากระบบ; สำเนาต้องมีคำว่า "สำเนาใบกำกับภาษี"; ห้ามให้ผู้ใช้เขียนมือ/ประทับตราแทน — ระบบพิมพ์เองเสมอ (TAX §1.2 ข้อ 1); [PROPOSED] RT แบบหัว "ใบเสร็จรับเงิน/ใบกำกับภาษี" พิมพ์ "เอกสารออกเป็นชุด" ทุกใบ — [OPEN] Q19
- **BIL-072** [FACT] RC (ใบรับ ม.105 ทวิ) ต้องมี: เลขผู้เสียภาษีผู้ออก, ชื่อผู้ออก, เลขลำดับ, วันที่, จำนวนเงิน (TAX §1.1)
- **BIL-073** [FACT] ค่าขนส่งล้วน (EXEMPT_TRANSPORT ทั้งหมด) → ออก RC เท่านั้น ห้ามมีคำว่า "ใบกำกับภาษี" (T1)
- **BIL-074** [FACT] RT หลายแผ่น: ใช้เลขเดียว และพิมพ์ "แผ่นที่ n/N" (TAX §1.2 ป.86/2542 ข้อ 9(2))
- **BIL-075** ข้อมูล RT ที่ออกแล้วแก้ไม่ได้ทุกช่อง — แก้ได้ด้วย CN/DN (§6) หรือยกเลิกแล้วออกใหม่ (§7)
- **BIL-076** RT ทุกใบเข้ารายงานภาษีขายของเดือน issueDate อัตโนมัติ; RC ส่วนยกเว้นเข้ารายงาน "รายได้ที่ได้รับยกเว้น VAT" (§14) [PROPOSED ตาม OPINION TAX §5.2]
- **BIL-077** [FACT T10] แจ้งเตือนบัญชีถ้ามี RT ที่ยังไม่ถูก export/ซิงก์ เกิน 3 วันทำการ (ช่วยให้ลงรายงานภาษีขายทันเวลา)

6. **สถานะ** — `ISSUED` → `CANCELLED` (ดู §7) ; ใบแทนไม่เปลี่ยนสถานะ
7. **event** — `receipt.issued`, `tax_invoice.issued`, `tax_document.cancelled`, `tax_document.replacement_issued`
8. **กรณีผิดปกติ** — ลูกค้าไม่มีเลขผู้เสียภาษี (บุคคลธรรมดาไม่จด) → RT ออกได้โดยไม่มีเลข (ข้อ 7 บังคับเฉพาะกรณีผู้ซื้อต้องมีเลข) แต่ชื่อต้องมีนามสกุล; ข้อความ "สาขาที่ออกใบกำกับภาษีคือ" ไม่ต้องพิมพ์ถ้า HQ พิมพ์ให้ทุกสาขา [FACT] ป.86/2542 ข้อ 19
9. **เกณฑ์ตรวจรับ**
   - Given RT 3 หน้า · When พิมพ์ · Then ทุกหน้าเลขเดียวกันและมี "แผ่นที่ 1/3, 2/3, 3/3"
   - Given พิมพ์สำเนา RT · Then หัวกระดาษมีคำ "สำเนาใบกำกับภาษี" ที่พิมพ์จากระบบ
   - Given payment ตัด INV ค่าขนส่งล้วน · Then เอกสารที่ได้ไม่มีคำ "ใบกำกับภาษี"
10. **เฟส** — P0

---

## 6. ใบลดหนี้ / ใบเพิ่มหนี้ (CN/DN และ ACN/ADN)

1. **จุดประสงค์** — แก้ยอดหลังออกเอกสารโดยไม่แก้เอกสารเดิม
2. **ผู้ใช้/สิทธิ์** — accounting สร้างร่าง; manager/approver อนุมัติออก (`billing.creditnote:approve`)
3. **หน้าจอ** — เมนู ⋯ ใน drawer INV/RT → "ออกใบลดหนี้" / "ออกใบเพิ่มหนี้"; ฟอร์ม: เอกสารอ้างอิง (ล็อก), บรรทัดเดิม → ยอดที่ถูกต้อง, เหตุผล (รหัส + ข้อความ), ตัวอย่าง PDF; รายการ CN/DN แยกแท็บ
4. **ฟิลด์** (เพิ่มจาก TaxDocument)

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| refDocType / refDocId / refDocNo / refDocDate | | ✓ | CN/DN: ต้องเป็น RT; ACN/ADN: ต้องเป็น INV | [FACT] เลขที่ใบกำกับภาษีเดิม |
| originalAmount | decimal | ✓ | snapshot | [FACT] มูลค่าเดิม |
| correctedAmount | decimal | ✓ | CN: < original; DN: > original | [FACT] มูลค่าที่ถูกต้อง |
| difference | decimal | คำนวณ | | [FACT] ผลต่าง |
| vatDifference | decimal | คำนวณ | round(difference × 0.07, 2) | [FACT] VAT ที่เพิ่ม/คืน |
| reasonCode | enum | ✓ | รายการตาม ETDA CDNS/DBNS | [FACT] TAX §1.5 (เช่น CDNS03, CDNS99) |
| reasonText | text | ✓ | ≥ 10; บังคับเมื่อ *99 | [FACT] คำอธิบายสาเหตุโดยย่อ |
| eventDate | date | ✓ | | วันที่เกิดเหตุ ใช้ตรวจเดือนภาษี |
| affectedLines | list | ✓ | | บรรทัดที่ปรับ |

5. **กฎธุรกิจ**

- **BIL-090** [FACT] CN/DN (ภาษี) ออกได้เฉพาะอ้าง RT ที่ `ISSUED` และเฉพาะส่วน VAT7; ฟิลด์บังคับตาม ม.86/9–86/10 (TAX §1.5)
- **BIL-091** [FACT] CN ต้องมีเหตุตาม ม.82/10 (บริการผิดข้อกำหนด / คำนวณราคาสูงกว่าจริง / บอกเลิกสัญญาเพราะบริการบกพร่อง); ส่วนลด/คืนเงินที่ไม่เข้าเหตุ → ห้ามออก CN ให้ใช้รายการปรับภายใน — ระบบแสดงคำอธิบายเหตุที่ยอมรับใน dropdown; ส่วนลดเชิงพาณิชย์ (ส่งช้า, rebate) **[OPEN] Q6**
- **BIL-092** [FACT] CN/DN ต้องออกในเดือนภาษีที่เหตุเกิด (หรือเดือนถัดไปถ้ามีเหตุจำเป็น): ถ้า `issueDate` อยู่หลังเดือนของ `eventDate` เกิน 1 เดือน → บล็อก; อยู่เดือนถัดไป → บังคับกรอกเหตุผลความจำเป็น
- **BIL-093** [PROPOSED] ACN/ADN ใช้ปรับ INV ที่ยังไม่มี RT (ยังไม่เกิด tax point) — เป็นเอกสารภายใน ไม่มีคำว่า "ใบกำกับภาษี"/"ใบลดหนี้" ตามกฎหมาย พิมพ์หัว "ใบปรับลดยอด/ใบปรับเพิ่มยอด (ใบแจ้งหนี้)"; ทำให้ outstanding ของ INV เปลี่ยน และส่วน VAT ของ RT ที่จะออกตอนรับเงินใช้ยอดหลังปรับ
- **BIL-094** ยอด CN สะสมต่อ RT ห้ามเกิน vatBase ของ RT นั้น; ACN สะสมต่อ INV ห้ามเกิน outstanding
- **BIL-095** CN ที่ออกหลังลูกค้าชำระแล้ว → สร้างยอดเครดิตลูกค้า (คืนเงินหรือตัดใบถัดไป); DN → สร้างยอดค้างรับเพิ่มและอยู่ใน AR aging โดย due = issueDate ของ DN + creditTermDays [PROPOSED]
- **BIL-096** DN ที่ส่วนเพิ่มเป็น VAT7 และยังไม่ได้รับเงิน — tax point ของส่วนเพิ่ม **[OPEN] Q20** (ออก DN ตอนเกิดเหตุตาม ม.86/9 vs ออกตอนรับเงิน)
- **BIL-097** WHT ของ CN/DN: whtExpected ของ INV ที่อ้างอิงคำนวณใหม่จากยอดหลังปรับ

6. **สถานะ** — `DRAFT` → `PENDING_APPROVAL` → `ISSUED` → `CANCELLED`; `DRAFT` → (ลบได้)

| จาก | ไป | เงื่อนไข | ใคร | ผลข้างเคียง |
|---|---|---|---|---|
| DRAFT | PENDING_APPROVAL | กรอกครบ | accounting | แจ้ง approver |
| PENDING_APPROVAL | ISSUED | อนุมัติ, BIL-092 ผ่าน | manager/approver | จองเลข series CN/DN, PDF, รายงานภาษีขายเดือนนั้น, sync |
| PENDING_APPROVAL | DRAFT | ตีกลับ + เหตุผล | manager | |
| ISSUED | CANCELLED | ตาม §7 | manager | |

7. **event** — `credit_note.issued`, `debit_note.issued`, `credit_note.cancelled`, `debit_note.cancelled`
8. **กรณีผิดปกติ** — RT ต้นทางถูกยกเลิกภายหลัง → ห้าม ถ้ามี CN/DN active อ้างอยู่ ต้องยกเลิก CN/DN ก่อน; ลูกค้าเปลี่ยนชื่อ → CN ใช้ชื่อปัจจุบันของผู้ซื้อ และอ้าง RT เดิม
9. **เกณฑ์ตรวจรับ**
   - Given RT-001 ฐาน VAT 1,000.00 VAT 70.00 (ค่ายกขนคิดเกิน) · When ออก CN มูลค่าถูกต้อง 800.00 เหตุ CDNS03 · Then difference 200.00, vatDifference 14.00, PDF มีเลข RT-001 และวันที่ RT-001
   - Given เหตุเกิด 10 ก.ย. 2569 · When ออก CN วันที่ 5 พ.ย. 2569 · Then ระบบบล็อก "เกินเดือนภาษีที่อนุญาต"
   - Given INV ค่าขนส่งล้วน (ไม่มี RT) · When เลือก "ออกใบลดหนี้" · Then ระบบเสนอ ACN แทน CN
10. **เฟส** — P0 (CN/DN/ACN/ADN)

---

## 7. ยกเลิก · ออกใหม่ · ใบแทน

1. **จุดประสงค์** — กติกาเดียวสำหรับเอกสารที่ออกแล้วทุกชนิด
2. **ผู้ใช้/สิทธิ์** — ยกเลิก: manager (`billing.document:cancel`); ใบแทน: accounting
3. **หน้าจอ** — เมนู ⋯ "ยกเลิกเอกสาร" (dialog: เหตุผล ≥ 10 ตัวอักษร, ตัวเลือก "ออกฉบับใหม่แทน", ช่องแนบหลักฐานเรียกคืนต้นฉบับ); เมนู "ออกใบแทน"
4. **ฟิลด์** — `cancelReason`, `cancelledAt/by`, `originalRecalled` (bool), `recallEvidenceFileId`, `replacedByDocId`, `replacesDocId`
5. **กฎธุรกิจ**

- **BIL-100** [FACT] ห้ามลบเอกสารที่ออกแล้ว — เปลี่ยนเป็น `CANCELLED` และเก็บ record + PDF เดิม (TAX §1.7, §2.4 ห้ามลบ record) ; [DECISION D7]
- **BIL-101** [FACT] ยกเลิก RT แล้วออกใหม่: ฉบับใหม่ใช้เลขถัดไปตามลำดับที่ออกจริง พิมพ์หมายเหตุ "ออกแทนใบกำกับภาษีเลขที่ … ลงวันที่ …"; ห้ามใช้เลข/วันที่ของฉบับเดิม; บันทึกหมายเหตุในรายงานภาษีขายของเดือนที่ออกใหม่; ต้องเรียกคืนต้นฉบับ (ระบบบันทึก `originalRecalled` + หลักฐาน) (TAX §1.7)
- **BIL-102** [FACT] RT ที่ VAT คลาดจากการคำนวณด้วยเหตุอื่นที่ไม่ใช่ปัดเศษ → ต้องยกเลิกและออกใหม่ (ป.86/2542 ข้อ 10); ระบบแนะนำ CN/DN เมื่อเหตุเป็นการเปลี่ยนมูลค่าจริง และ "ยกเลิก+ออกใหม่" เมื่อเหตุเป็นข้อมูลผิด (ชื่อ เลขผู้เสียภาษี สาขา)
- **BIL-103** ยกเลิกได้ตามลำดับพึ่งพา: CN/DN → RT/RC → Payment → INV; ถ้ายังมีเอกสารลูก active ระบบแสดงรายการให้ยกเลิกก่อน
- **BIL-104** [PROPOSED] การยกเลิก RT ข้ามเดือนภาษีที่ยื่น ภ.พ.30 แล้ว → เตือนเด่น + บังคับติ๊ก "ปรึกษานักบัญชีแล้ว" — [OPEN] Q18
- **BIL-105** [FACT] ใบแทน (ม.86/12): re-render จาก snapshot เดิม เลขเดิม พร้อมข้อความ "ใบแทนใบกำกับภาษี/ใบแทนใบเพิ่มหนี้/ใบแทนใบลดหนี้ ของเลขที่ … ลงวันที่ …" และบันทึกวันที่ออกใบแทน; ห้ามแก้ข้อมูลใด ๆ; ใช้กับ 50 ทวิ ด้วย (ข้อความ "ใบแทน" ด้านบน — TAX §3.2)
- **BIL-106** INV/BN/PV (เอกสารภายใน) ยกเลิกได้โดยไม่ต้องเรียกคืน แต่เลขคงอยู่และแสดง "ยกเลิก" ในรายการ
- **BIL-107** เลขที่ของเอกสารที่ยกเลิกไม่ถูกนำกลับมาใช้ (BIL-082)

6. **สถานะ** — ดูตารางในแต่ละเอกสาร (`ISSUED` → `CANCELLED`, ไม่มีทางย้อน)
7. **event** — `<doc>.cancelled` (มี `reason`, `replacedByDocId`), `tax_document.replacement_issued`
8. **กรณีผิดปกติ** — เอกสารซิงก์ไป connector แล้ว → ส่ง void; ถ้า connector ปฏิเสธ (งวดปิด) → เอกสารใน TMS ยังยกเลิกได้ แต่ syncStatus = `FAILED` เข้า error queue (§15) — สถานะเอกสารไม่รอสถานะซิงก์ (D3)
9. **เกณฑ์ตรวจรับ**
   - Given RT-2611-0005 ออก 3 พ.ย. ชื่อลูกค้าผิด · When ยกเลิกและออกใหม่ 6 พ.ย. · Then ฉบับใหม่ได้เลขถัดไป (เช่น RT-2611-0012) ลงวันที่ 6 พ.ย. มีหมายเหตุอ้าง RT-2611-0005 ลงวันที่ 3 พ.ย. และ RT-2611-0005 ยังอยู่ในระบบสถานะยกเลิก
   - Given ลูกค้าทำ RT หาย · When ออกใบแทน · Then PDF มีเลขเดิม ข้อความ "ใบแทนใบกำกับภาษี" และ log วันที่ออกใบแทน
10. **เฟส** — P0

---

## 8. เลขที่เอกสาร (Number series)

1. **จุดประสงค์** — เลขเรียงลำดับ ไม่ซ้ำ ไม่ใช้ซ้ำ ตามชนิด/สาขา/งวด (B9)
2. **ผู้ใช้/สิทธิ์** — owner/admin, accounting ตั้งค่า; ทุกคนเห็นเลข
3. **หน้าจอ** — ตั้งค่า > บัญชีและภาษี > เลขที่เอกสาร: ตาราง series (ชนิด · สาขา · รูปแบบ · รอบรีเซ็ต · เลขถัดไป · ตัวอย่าง) + ฟอร์มแก้รูปแบบ + ตัวอย่างสด
4. **ฟิลด์** `NumberSeries`

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| tenantId / legalEntityId / branchId | FK | ✓ | | |
| docType | enum | ✓ | INV, BN, RC, RT, CN, DN, ACN, ADN, PAY, PV, WHT, CA, SET | |
| format | text | ✓ | token ที่รองรับเท่านั้น, ยาว ≤ 30 | เช่น `{PREFIX}{BR}-{YY}{MM}-{SEQ:4}` |
| prefix | text | ✓ | `^[A-Z0-9ก-๙/-]{1,8}$` | |
| resetPeriod | enum `MONTHLY` \| `YEARLY` \| `NEVER` | ✓ | | ค่าเริ่มต้น MONTHLY |
| yearSystem | enum `BE` \| `CE` | ✓ | | ปี พ.ศ./ค.ศ. ใช้ได้ทั้งคู่ [FACT] ป.86/2542 ข้อ 4(7) |
| currentPeriod / nextSeq | text / int | ระบบ | | |
| effectiveFrom | period | ✓ | ≥ งวดปัจจุบัน | การเปลี่ยนรูปแบบมีผลงวดถัดไป |

Token: `{PREFIX}` `{BR}` (รหัสสาขา 5 หลักหรือรหัสย่อ) `{YYYY}` `{YY}` `{MM}` `{SEQ:n}` — ค่าเริ่มต้น: `INV2611-0001`, `BN…`, `RC…`, `RT…`, `CN…`, `DN…`, `PV…`, `WHT2569-0001` (50 ทวิ รีเซ็ตรายปี)

5. **กฎธุรกิจ**

- **BIL-080** series แยกต่อ (นิติบุคคล × สาขา × docType × งวด); RT/CN/DN แยก series กัน [FACT] (CN/DN series แยก — TAX §6.1)
- **BIL-081** เลขจองตอน "ออก" ใน DB transaction เดียวกับการเปลี่ยนสถานะ ด้วย row lock บน `NumberSeries` (`SELECT … FOR UPDATE`); ร่างไม่มีเลข (B9)
- **BIL-082** เลขที่ออกแล้วไม่ถูกนำกลับมาใช้แม้เอกสารถูกยกเลิก [FACT] T5
- **BIL-083** ถ้า transaction ล้มหลังจองเลข → rollback ทั้งก้อน เลขไม่ถูกใช้ (ไม่มีเลขข้ามจากข้อผิดพลาดระบบ); ความยอมรับได้ของเลขข้ามในทางปฏิบัติ **[OPEN] Q5**
- **BIL-084** วันที่เอกสารใน series เดียวต้องไม่ถอยหลัง: `issueDate(n) ≥ issueDate(n−1)` (เพื่อให้เลขเรียงตามวันที่ออกจริง [FACT] T5)
- **BIL-085** แก้รูปแบบได้ แต่มีผลงวดถัดไปเท่านั้น และรูปแบบใหม่ต้องไม่สร้างเลขซ้ำกับที่เคยออก (ระบบตรวจ unique `(legalEntityId, docType, docNo)`)
- **BIL-086** [FACT] ใช้รหัสสาขานำหน้าเลขได้ (TAX §1.7 กค 0811/พ.5045)
- **BIL-087** [OPEN] Q5 series ต่อสาขาหรือ series เดียวทั้งบริษัท — ระบบรองรับทั้งสองแบบ (`branchId = null` = ทั้งบริษัท)

6. **สถานะ** — ไม่มี
7. **event** — `number_series.updated`
8. **กรณีผิดปกติ** — ออกพร้อมกัน 100 ใบ (async job) → เลขเรียงตามลำดับ commit ไม่มีซ้ำ; เปลี่ยนสาขาของผู้ใช้กลางทาง → ใช้สาขาที่ระบุบนเอกสาร
9. **เกณฑ์ตรวจรับ**
   - Given RT series ต่อเดือน เลขล่าสุด RT2611-0007 · When ออก 2 ใบพร้อมกันจาก 2 session · Then ได้ RT2611-0008 และ RT2611-0009 ไม่ซ้ำ
   - Given RT2611-0008 ถูกยกเลิก · When ออกใบถัดไป · Then ได้ RT2611-0010 (ไม่ reuse 0008)
   - Given เปลี่ยน format วันที่ 15 พ.ย. · Then ใบที่ออกใน พ.ย. ยังใช้รูปแบบเดิม ใบแรกของ ธ.ค. ใช้รูปแบบใหม่
10. **เฟส** — P0

---

## 9. หัก ณ ที่จ่าย (WHT) — กติการ่วม

1. **จุดประสงค์** — คำนวณ/ติดตาม WHT ทั้งฝั่งรับ (ลูกค้าหักเรา) และฝั่งจ่าย (เราหักรถร่วม)
2. **ผู้ใช้/สิทธิ์** — accounting
3. **หน้าจอ** — แท็บ "หัก ณ ที่จ่าย" ใน บัญชี: ฝั่งรับ (รายการ 50 ทวิ ที่ต้องได้รับ) · ฝั่งจ่าย (50 ทวิ ที่ออก, สรุป ภ.ง.ด.3/53)
4. **ฟิลด์** — `WhtEntry {direction: RECEIVED|PAID, partyId, partyTaxId, partyBranch, partyType: INDIVIDUAL|JURISTIC, formType: PND3|PND53, incomeType, rate, baseAmount, whtAmount, paidDate, certNo, certFileId, sourceDocId, condition: 1|2|3}` — `condition` 1 หัก ณ ที่จ่าย / 2 ออกให้ตลอดไป / 3 ออกให้ครั้งเดียว [OPINION ใน TAX §3.3]
5. **กฎธุรกิจ**

- **BIL-110** [FACT] อัตรา: ค่าขนส่ง 1% (ไม่รวมค่าโดยสารขนส่งสาธารณะ), ค่าบริการ 3%; ขั้นต่ำ ≥ 1,000 บาทต่อสัญญา แม้แบ่งจ่ายงวดละ < 1,000 ก็ยังหัก (TAX §3.1)
- **BIL-111** [FACT] ฝั่งจ่าย: ผู้รับเป็นบุคคลธรรมดา → ภ.ง.ด.3; นิติบุคคล → ภ.ง.ด.53 (TAX §3.1) — ระบบเลือก formType จาก `Subcontractor.partyType`; ให้นักบัญชียืนยันกรณีพิเศษ (เช่น ห้างหุ้นส่วนสามัญไม่จดทะเบียน) **[OPEN] Q21**
- **BIL-112** [PROPOSED] เกณฑ์ขั้นต่ำตาม `whtThresholdBasis`: `PER_DOCUMENT` = ยอดฐาน WHT ในเอกสาร/settlement ≥ 1,000; `PER_TRIP` = ต่อเที่ยว; `PER_CONTRACT` = ต่อสัญญาที่ผูกกับลูกค้า/รถร่วม (สัญญารายปีถือว่าผ่านเกณฑ์) — การตีความ "ต่อสัญญา" **[OPEN] Q8**
- **BIL-113** [PROPOSED] ฐาน WHT = ยอดก่อน VAT ของบรรทัดที่ whtCategory ≠ NONE หลังหักส่วนลดในบรรทัด; ไม่หักรายการหักกลบ (ค่าปรับ เงินเบิก) ออกจากฐาน — **[OPEN] Q13**
- **BIL-114** ค่าบริการเสริมที่ลูกค้าหัก 3% แต่ ChargeType ตั้ง 1% (หรือกลับกัน) → BIL-052 เตือน และให้บัญชีเลือกบันทึกตามจริงในใบ 50 ทวิ ที่ได้รับ
- **BIL-115** อัตรา e-WHT ลดเหลือ 1% (ถึง 31 ธ.ค. 2570) ใช้กับเงินได้ 2%/3%/5% ที่จ่ายผ่าน e-Withholding Tax เท่านั้น [FACT] TAX §3.3 — ระบบไม่ใช้อัตรานี้อัตโนมัติ; มี flag `paidViaEWht` ต่อ settlement ให้บัญชีเลือก [PROPOSED]
- **BIL-116** ค่าจ้างคนขับรายเที่ยว (ไม่มีเงินเดือน, M2) — การหักภาษี/ประเภทเงินได้ **[OPEN] Q22**; ระบบส่งออกยอดไปเงินเดือน (§13) ไม่ออก 50 ทวิ เองใน P0

6. **สถานะ** — ดู BIL-057 (ฝั่งรับ) และ §11.10 (ฝั่งจ่าย)
7. **event** — `wht_certificate.received`, `wht_certificate.issued`
8. **กรณีผิดปกติ** — รถร่วมไม่มีเลขผู้เสียภาษี → บล็อกการอนุมัติ settlement ที่มี WHT > 0; ลูกค้าส่ง 50 ทวิ รวมหลาย INV → แนบไฟล์เดียวกับหลาย payment ได้
9. **เกณฑ์ตรวจรับ**
   - Given whtThresholdBasis=PER_DOCUMENT และ settlement ค่าขนส่ง 800.00 · Then WHT 0.00
   - Given whtThresholdBasis=PER_CONTRACT และรถร่วมมีสัญญารายปี · When settlement 800.00 · Then WHT 8.00
10. **เฟส** — P0

---

## 10. ลูกหนี้ (AR) และติดตามหนี้

1. **จุดประสงค์** — ให้บัญชีเห็นยอดค้างตามอายุและตามลูกค้า (รายงานเต็มใน 09-reports RPT AR aging)
2. **ผู้ใช้/สิทธิ์** — accounting, manager
3. **หน้าจอ** — แท็บ "ลูกหนี้" ในหน้ารับชำระ: ตารางลูกค้า × ช่วงอายุ (ยังไม่ครบกำหนด · 1–30 · 31–60 · 61–90 · > 90), คลิกลงไปเห็น INV; ปุ่ม "ส่งใบแจ้งยอดค้าง (statement)"
4. **ฟิลด์** — คำนวณจาก INV/DN/ACN/ADN/CN/unapplied: `outstanding`, `daysPastDue = today − dueDate`
5. **กฎธุรกิจ**

- **BIL-120** ยอดค้าง = INV.grandTotal ± ACN/ADN/CN/DN ที่อ้าง − Σ appliedAmount (รวม WHT ที่ลูกค้าหักแล้ว) ; เครดิตลูกค้า (unapplied) แสดงเป็นแถวติดลบแยก
- **BIL-121** แจ้งเตือนอัตโนมัติ (ตั้งค่าได้): ก่อนครบกำหนด 3 วัน, วันครบกำหนด, เกิน 7/30 วัน — ช่องทาง อีเมลถึงลูกค้า (ตัวเลือก) และในระบบถึงผู้ดูแลลูกค้า
- **BIL-122** [PROPOSED] วงเงินเครดิตลูกค้า (`creditLimit` ใน 02) — ยอดค้าง + งานที่ยังไม่วางบิล เกินวงเงิน → เตือนตอนสร้าง SO (ไม่บล็อก ยกเว้นตั้งค่า "บล็อก")
- **BIL-123** statement ลูกค้า (PDF) = รายการ INV/CN/DN/payment ในช่วงวันที่ + ยอดยกมา/คงเหลือ

6–8. — สถานะใช้ของ INV; event `invoice.overdue`, `customer.credit_limit_exceeded`; ลูกค้าที่มีหลายสาขา → aging แยกตาม taxId+branch และรวมได้
9. **เกณฑ์ตรวจรับ** — Given INV due 1 ต.ค. 2569 ค้าง 5,000 · When ดู aging วันที่ 9 พ.ย. 2569 · Then อยู่ช่อง 31–60 (39 วัน)
10. **เฟส** — P0 (aging, statement); P1 (แจ้งเตือนลูกค้าอัตโนมัติ, วงเงินเครดิต)

---

## 11. Settlement รถร่วม (AP)

### 11.1 จุดประสงค์
สรุปค่าจ้างรถร่วมต่องวดจากเที่ยวที่จบ หักรายการต่าง ๆ หัก ณ ที่จ่าย 1% ออกใบสำคัญจ่ายและ 50 ทวิ (B5, B6, B8)

### 11.2 ผู้ใช้/สิทธิ์
| การกระทำ | role |
|---|---|
| สร้าง/แก้ร่าง, ส่งให้รถร่วมตรวจ | accounting, dispatcher (ถ้าได้สิทธิ์ `settlement:create`) |
| ตรวจ/ยืนยัน/โต้แย้ง | รถร่วม (หน้ารถร่วมผ่านลิงก์/LINE) |
| อนุมัติ | manager/approver ตามวงเงิน (`settlement:approve`) |
| บันทึกจ่าย, ออก 50 ทวิ | accounting (`settlement:pay`) |

### 11.3 หน้าจอ
- บัญชี > Settlement รถร่วม: KPI (รอสร้าง · รอรถร่วมตรวจ · โต้แย้ง · รออนุมัติ · รอจ่าย) → แท็บ → ตาราง (เลข · รถร่วม · งวด · จำนวนเที่ยว · ยอดรวม · หัก · WHT · สุทธิ · สถานะ · ระบบบัญชี)
- drawer = "การ์ดตรวจบิล" (design-briefs รอบ 3): ยอดที่รถร่วมเรียก (ขีดฆ่าถ้าต่าง) → ยอดอนุมัติตัวใหญ่; checklist: POD ครบ · ราคาตรง rate card รถร่วม · ค่าใช้จ่ายหน้างานมีหลักฐาน · หักเงินเบิก/WHT · เทียบ SO·DO·เที่ยว·ใบแจ้งหนี้รถร่วม; "ตรวจแล้ว 4/5" + ปุ่ม "อนุมัติ"
- หน้ารถร่วม (มือถือ): ดู statement → ยืนยัน / โต้แย้งรายบรรทัด (เหตุผล + รูป) → ดูใบสำคัญจ่ายและ 50 ทวิ ของตนเอง

### 11.4 ฟิลด์ `Settlement`

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| docNo | text | ✓ เมื่อส่งตรวจ | series SET | |
| subcontractorId + snapshot (ชื่อ taxId branch partyType ที่อยู่ บัญชีธนาคาร) | | ✓ | | |
| periodFrom / periodTo | date | ✓ | | ตามรอบจ่ายของรถร่วม (02) |
| subconInvoiceNo / subconInvoiceDate / file | text/date/file | | | เลขใบแจ้งหนี้ของรถร่วม (I5) |
| lines | list(SettlementLine) | ✓ | | |
| grossAmount | decimal | คำนวณ | | Σ บรรทัด EARNING |
| vatBase / vatAmount | decimal | | | เฉพาะรถร่วมจด VAT ที่เรียกเก็บบริการ VAT7 → ภาษีซื้อ |
| whtBase / whtRate / whtAmount | decimal | คำนวณ | BIL-113 | |
| deductionTotal | decimal | คำนวณ | | Σ บรรทัด DEDUCTION (ค่าบวก) |
| netPayable | decimal | คำนวณ | ≥ 0 | BIL-133 |
| dueDate | date | ✓ | | approvedAt + creditTermDays ของรถร่วม |
| status | enum | ✓ | 11.6 | |
| paymentVoucherId / whtCertId | FK | | | |

`SettlementLine`

| ฟิลด์ | ชนิด | บังคับ | หมายเหตุ |
|---|---|---|---|
| kind | `EARNING` \| `DEDUCTION` | ✓ | |
| sourceType | `TRIP_COST_LINE` \| `ACCESSORIAL` \| `FINE` \| `ACCIDENT` \| `CASH_ADVANCE` \| `FUEL_PROVIDED` \| `DAMAGE` \| `MANUAL` | ✓ | |
| sourceId | uuid | | unique ต่อ settlement active (X11) |
| tripId / doIds | FK | | |
| description, qty, unitPrice, amount | | ✓ | |
| chargeTypeId, taxCategory, whtCategory, whtRate | | EARNING ✓ | |
| claimedAmount | decimal | | ยอดที่รถร่วมเรียก |
| disputeStatus | `NONE` \| `DISPUTED` \| `RESOLVED` | | B6 |
| evidenceFileIds | list | | |

### 11.5 กฎธุรกิจ

- **BIL-130** สร้าง settlement จากเที่ยวรถร่วมที่สถานะ `COMPLETED` ในงวด; ตัวเลือกต่อรถร่วม "ไม่มี POD ไม่จ่าย" (ค่าเริ่มต้นเปิด) → เที่ยวที่ POD ยังไม่ผ่านไม่ถูกดึง (B6)
- **BIL-131** ราคาบรรทัด EARNING มาจาก cost line ของเที่ยว (B1) ตาม rate card รถร่วม (02) + ค่าใช้จ่ายหน้างานที่อนุมัติ; แก้ราคาในร่างต้องใส่เหตุผล และแสดงยอดต่างจาก rate card
- **BIL-132** [PROPOSED] cost line หนึ่งรายการอยู่ใน settlement ที่ active ได้ใบเดียว (unique `(sourceType, sourceId)` — X11); ห้ามมีเส้นทางจ่ายรถร่วมสองทาง (เช่น settlement + ซิงก์ใบแจ้งหนี้รถร่วมเป็น AP แยก)
- **BIL-133** `netPayable = grossAmount + vatAmount − whtAmount − deductionTotal`; ถ้า < 0 → ห้ามอนุมัติ ให้ยกยอดหักส่วนเกินไปงวดถัดไป (บรรทัด DEDUCTION ใหม่ sourceType=`MANUAL` อ้าง settlement เดิม) [PROPOSED]
- **BIL-134** รายการหัก: ค่าปรับจราจรที่ตั้ง "หักรถร่วม" (06-fleet), ค่าเสียหายอุบัติเหตุที่รถร่วมเป็นฝ่ายผิด, เงินเบิกล่วงหน้าที่จ่ายให้รถร่วม, น้ำมันที่บริษัทเติมให้, ค่าเสียหายสินค้า — ทุกบรรทัดต้องมีเอกสารอ้างอิง
- **BIL-135** [FACT] WHT 1% บนค่าขนส่งที่จ่ายรถร่วม (การรับขนหลายทอด — TAX §3.1); 3% สำหรับค่าบริการที่แยกบรรทัด; เกณฑ์ขั้นต่ำตาม BIL-112
- **BIL-136** บรรทัดที่ `DISPUTED` บล็อกการอนุมัติทั้งใบ จนกว่าจะ `RESOLVED` (แก้ยอดหรือยืนยันยอดเดิมพร้อมเหตุผล) (B6)
- **BIL-137** วงเงินอนุมัติตามตำแหน่ง (ตั้งค่าเดียวกับใบสั่งซ่อม 06-fleet) — เกินวงเงินส่งต่อผู้อนุมัติลำดับถัดไป
- **BIL-138** รถร่วมไม่ตอบภายใน N วัน (ค่าเริ่มต้น 3) หลังส่งตรวจ → ถือว่ายืนยัน (ตั้งค่าได้ปิด) [PROPOSED]
- **BIL-139** ถ้ารถร่วมจด VAT และเรียกเก็บบริการ VAT7 → บันทึกเลขใบกำกับภาษีของรถร่วม (เข้า "รายงานภาษีซื้อ" §14); ค่าขนส่งของรถร่วมยกเว้น VAT เช่นกัน [FACT] T1 (ยกเว้นแม้จ้างช่วง)
- **BIL-140** Export Excel ค่าจ้างรถร่วม 3 sheet (สรุป · รายเที่ยว · รายการหัก) (B10)

### 11.6 สถานะ `Settlement.status`
`DRAFT` · `SENT_TO_SUBCON` · `DISPUTED` · `CONFIRMED` · `APPROVED` · `PARTIALLY_PAID` · `PAID` · `CANCELLED`

| จาก | ไป | เงื่อนไข | ใคร | ผลข้างเคียง |
|---|---|---|---|---|
| — | DRAFT | สร้าง | accounting | ล็อก cost line |
| DRAFT | SENT_TO_SUBCON | กดส่ง | accounting | จองเลข SET, ส่งลิงก์ LINE/อีเมล |
| DRAFT | CONFIRMED | ตั้งค่ารถร่วม "ไม่ต้องให้ตรวจ" | accounting | |
| SENT_TO_SUBCON | DISPUTED | รถร่วมโต้แย้ง ≥ 1 บรรทัด | รถร่วม | แจ้ง accounting |
| DISPUTED | SENT_TO_SUBCON | แก้ไขแล้วส่งใหม่ | accounting | version +1 |
| SENT_TO_SUBCON | CONFIRMED | รถร่วมยืนยัน หรือ BIL-138 | รถร่วม/ระบบ | |
| CONFIRMED | APPROVED | checklist ครบ, ไม่มี DISPUTED, วงเงินผ่าน | manager/approver | dueDate, sync เป็น AP bill |
| APPROVED | PARTIALLY_PAID / PAID | บันทึกจ่าย | accounting | ออก PV + 50 ทวิ |
| DRAFT…APPROVED | CANCELLED | ยังไม่จ่าย + เหตุผล | manager | ปลดล็อก cost line; เลขคงอยู่ |

### 11.7 บันทึกจ่าย (Payment voucher `PV`)
| ฟิลด์ | ชนิด | บังคับ | หมายเหตุ |
|---|---|---|---|
| docNo | text | ✓ | series PV |
| paidDate | date | ✓ | วันที่หักภาษี = วันที่บน 50 ทวิ |
| method / fromBankAccountId / transferRef / slipFile | | ✓ | |
| settlementIds | list | ✓ | รถร่วมเดียวกัน |
| amount | decimal | ✓ | ≤ Σ netPayable ค้าง |
| whtAmount | decimal | ระบบ | WHT ทั้งก้อนหักในการจ่ายครั้งแรก [PROPOSED]; กรณีแบ่งจ่าย [OPEN] Q23 |

- **BIL-141** PV ออกเลขเมื่อบันทึกจ่าย; ยกเลิก PV → settlement ย้อนสถานะ และต้องยกเลิก 50 ทวิ ที่ผูก (ออกใบใหม่เลขใหม่)

### 11.8 event
`settlement.created`, `settlement.sent`, `settlement.disputed`, `settlement.confirmed`, `settlement.approved`, `settlement.paid`, `settlement.cancelled`, `payment_voucher.issued`, `wht_certificate.issued`

### 11.9 กรณีผิดปกติ
เที่ยวถูกแก้ราคาหลังอยู่ในร่าง → ร่างแสดงป้าย "ข้อมูลต้นทางเปลี่ยน" + ปุ่ม rebuild; รถร่วมเปลี่ยนบัญชีธนาคาร → ต้องอนุมัติการเปลี่ยน (กันโกง) และใช้ snapshot ตอนอนุมัติ settlement; ลิงก์รถร่วมหมดอายุ (7 วัน) → ส่งใหม่ได้

### 11.10 หนังสือรับรอง 50 ทวิ (ฝั่งจ่าย)
- **BIL-145** [FACT] ออก 2 ฉบับข้อความตรงกัน (ฉบับที่ 1 สำหรับผู้ถูกหักแนบแบบ, ฉบับที่ 2 เก็บเป็นหลักฐาน), มีหมายเลขลำดับ, ภาษาไทยหรืออังกฤษ, ลายเซ็นสแกนพิมพ์จากคอมพิวเตอร์ได้; ใบแทน = สำเนา + คำว่า "ใบแทน" ด้านบน (TAX §3.2)
- **BIL-146** [FACT] รายการบนแบบใช้ตามแบบฟอร์มมาตรฐานของกรมสรรพากรท้ายประกาศฉบับที่ 62 — ฟิลด์ทางการครบชุดยังไม่ได้เปิดตรวจ **[OPEN] Q7**; template P0 ใช้ช่อง: ผู้มีหน้าที่หัก (ชื่อ ที่อยู่ เลขผู้เสียภาษี), ผู้ถูกหัก (ชื่อ ที่อยู่ เลขผู้เสียภาษี), ลำดับที่ในแบบ (ภ.ง.ด.3/53), ประเภทเงินได้ + วันที่จ่าย + จำนวนเงินที่จ่าย + ภาษีที่หัก, รวมเงิน/ภาษี (ตัวเลข + ตัวอักษร), เงื่อนไข (หัก ณ ที่จ่าย/ออกให้ตลอดไป/ออกให้ครั้งเดียว), ลายมือชื่อผู้จ่ายเงิน + วันที่
- **BIL-147** [FACT] ส่ง 50 ทวิ เป็น PDF ทางอิเล็กทรอนิกส์ได้เมื่อแจ้งอธิบดีด้วยแบบ ภ.อ.11 และเก็บตาม ป.121/2545 (TAX §3.2) — ระบบมี flag `eWhtCertNotified` ต่อนิติบุคคล; ถ้า false → หน้ารถร่วมแสดงได้เฉพาะ "ตัวอย่าง" และให้พิมพ์กระดาษส่ง [PROPOSED] — [OPEN] Q7
- **BIL-148** series WHT รีเซ็ตรายปี; ออกเมื่อ PV ออก; ยกเลิกได้ตาม §7

### 11.11 เกณฑ์ตรวจรับ
- Given รถร่วมนิติบุคคล 3 เที่ยว × 4,500.00 = 13,500.00 (FREIGHT 1%), ค่าปรับหักรถร่วม 500.00, เงินเบิก 2,000.00 · When อนุมัติ · Then whtAmount 135.00, deductionTotal 2,500.00, netPayable 10,865.00, formType ภ.ง.ด.53
- Given บรรทัดหนึ่ง DISPUTED · When กดอนุมัติ · Then ระบบบล็อก "มีรายการโต้แย้ง 1 รายการ"
- Given cost line ของเที่ยว T-01 อยู่ใน SET-0001 (APPROVED) · When สร้าง SET ใหม่ที่ดึง T-01 · Then T-01 ไม่ถูกดึง
- Given รถร่วมบุคคลธรรมดา · When จ่าย · Then 50 ทวิ ระบุ ภ.ง.ด.3 และ PDF มี 2 ฉบับ

### 11.12 เฟส
P0 (settlement, PV, 50 ทวิ, หน้ารถร่วมดูเอกสาร); P1 (โต้แย้งรายบรรทัดผ่านหน้ารถร่วม, auto-confirm, Excel 3 sheet)

---

## 12. เงินเบิกล่วงหน้าคนขับ (Cash advance)

1. **จุดประสงค์** — คุมเงินที่ให้คนขับ/รถร่วมไปใช้ระหว่างเที่ยว (น้ำมัน ทางด่วน ค่าขึ้นลง) และเคลียร์กับใบเสร็จ (B7)
2. **ผู้ใช้/สิทธิ์** — ขอเบิก: dispatcher หรือคนขับ (แอป); อนุมัติ: manager/approver ตามวงเงิน; จ่าย/เคลียร์: accounting
3. **หน้าจอ** — บัญชี > เงินเบิก: KPI (รออนุมัติ · รอจ่าย · ค้างเคลียร์ · เกินกำหนดเคลียร์) → ตาราง → drawer (เบิก · ค่าใช้จ่ายที่บันทึก · ส่วนต่าง · กิจกรรม); แอปคนขับ: ขอเบิก, M15 ฟอร์มค่าใช้จ่าย (ถ่ายใบเสร็จ → AI เติมร่าง), M16 จบเที่ยว/คืนเงินทอน
4. **ฟิลด์** `CashAdvance`

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| docNo | text | ✓ เมื่ออนุมัติ | series CA | |
| payeeType / payeeId | `DRIVER` \| `SUBCON` | ✓ | | |
| tripIds | list | | | ผูกเที่ยว (แนะนำ) |
| requestedAmount / approvedAmount | decimal | ✓ | > 0 | |
| purpose | multi-enum FUEL, TOLL, LOADING, PARKING, OTHER + text | ✓ | | |
| issuedMethod / issuedAt / issuedBy / slipFile | | เมื่อจ่าย | | |
| clearDueDate | date | ✓ | | ค่าเริ่มต้น วันจบเที่ยว + 2 วัน |
| expenses | list(ExpenseEntry) | | | จาก M15 หรือคีย์ในระบบ |
| expenseTotal | decimal | คำนวณ | | Σ expenses ที่อนุมัติ |
| balance | decimal | คำนวณ | | approvedAmount − expenseTotal (บวก = ต้องคืน, ลบ = บริษัทต้องจ่ายเพิ่ม) |
| returnedAmount / returnedAt | decimal/datetime | | | M16 |
| status | enum | ✓ | | |

`ExpenseEntry` (ใช้ร่วมกับ 06-fleet น้ำมันและค่าใช้จ่าย)

| ฟิลด์ | ชนิด | บังคับ | หมายเหตุ |
|---|---|---|---|
| category | FUEL/TOLL/LOADING/PARKING/REPAIR/OTHER | ✓ | |
| date, amount, vendorName | | ✓ | |
| vendorTaxId, receiptNo, hasFullTaxInvoiceInCompanyName | | | ใช้คัดเข้ารายงานภาษีซื้อ — สิทธิ์ใช้ภาษีซื้อ [OPEN] Q24 |
| vatAmount | decimal | | |
| liters, pricePerLiter, odometer | | FUEL | |
| receiptFile | file | ✓ (ยกเว้นทางด่วนอิเล็กทรอนิกส์ตั้งค่าได้) | |
| aiExtracted / confirmedBy | json / user | | D5 |
| tripId | FK | | ใช้คิดต้นทุนเที่ยว (09) |
| reviewStatus | PENDING/APPROVED/REJECTED | ✓ | |

5. **กฎธุรกิจ**

- **BIL-150** วงเงินเบิกต่อครั้งและวงเงินค้างรวมต่อคนขับตั้งค่าได้; เกินวงเงินต้องผู้อนุมัติลำดับถัดไป
- **BIL-151** คนขับที่มีเงินเบิกค้างเคลียร์เกินกำหนด → เตือน dispatcher ตอนจ่ายงาน (ไม่บล็อก ค่าเริ่มต้น) และห้ามขอเบิกใหม่ถ้าตั้งค่า "บล็อก"
- **BIL-152** ค่าใช้จ่ายจาก M15 เข้าเป็น `PENDING` — AI เติมเป็นร่าง คนขับยืนยันในแอป แล้ว accounting อนุมัติรายการ (D5); ทำงานออฟไลน์และส่งเมื่อมีสัญญาณ (M17)
- **BIL-153** เคลียร์: balance > 0 → คนขับคืนเงินทอน (M16 บันทึกยอด + รูปสลิป/รับเงินสด) หรือส่งเป็นรายการหักเงินเดือน (§13) ด้วยการอนุมัติ; balance < 0 → ออก PV คืนเงินให้คนขับ
- **BIL-154** ค่าใช้จ่ายที่อนุมัติ → สร้าง cost line ของเที่ยว (B1) ใช้คิดกำไร (09-reports) และ ถ้าเป็นค่าที่เรียกเก็บลูกค้าได้ (เช่น ทางด่วนตามสัญญา) → เสนอเป็นบรรทัดรายได้ใน DO ให้ dispatcher ยืนยัน
- **BIL-155** เงินเบิกที่จ่ายให้รถร่วม → เมื่อเคลียร์ ยอดคงค้างถูกดึงเป็นบรรทัด DEDUCTION ใน settlement (BIL-134)

6. **สถานะ** — `REQUESTED` · `APPROVED` · `REJECTED` · `ISSUED` · `CLEARING` · `CLEARED` · `CANCELLED`

| จาก | ไป | เงื่อนไข | ใคร | ผลข้างเคียง |
|---|---|---|---|---|
| REQUESTED | APPROVED / REJECTED | วงเงิน; REJECTED ต้องเหตุผล | approver | แจ้งคนขับ |
| APPROVED | ISSUED | จ่ายเงิน | accounting | บันทึกวิธีจ่าย |
| ISSUED | CLEARING | คนขับส่งค่าใช้จ่ายครบ/จบเที่ยว (M16) | driver/ระบบ | |
| CLEARING | CLEARED | ทุกรายการ reviewed และ balance ปิดด้วยคืนเงิน/PV/หักเงินเดือน | accounting | |
| REQUESTED/APPROVED | CANCELLED | ยังไม่จ่าย | ผู้ขอ/accounting | |

7. **event** — `cash_advance.requested`, `.approved`, `.rejected`, `.issued`, `.cleared`, `.overdue`; `expense.submitted`, `expense.approved`
8. **กรณีผิดปกติ** — ใบเสร็จซ้ำ (เลขผู้เสียภาษีผู้ขาย + เลขใบเสร็จ + ยอดเดียวกัน) → flag ซ้ำ; ลิตรน้ำมันเกินความจุถัง (06) → flag; คนขับลาออกมียอดค้าง → แสดงในรายงานค้างเคลียร์และส่งหักเงินเดือนงวดสุดท้าย
9. **เกณฑ์ตรวจรับ**
   - Given เบิก 3,000.00 ค่าใช้จ่ายอนุมัติ 2,640.00 · When จบเที่ยว · Then balance 360.00 และ M16 แสดง "คืนเงินทอน 360.00"
   - Given เบิก 2,000.00 ค่าใช้จ่าย 2,300.00 · Then balance −300.00 และระบบเสนอออก PV คืนคนขับ 300.00
10. **เฟส** — P1 (B7) ; M15/M16 ในแอปคนขับตาม 04-execution

---

## 13. รายการหักคนขับ (Driver deductions) → ส่งออกเงินเดือน

1. **จุดประสงค์** — รวมรายการที่ต้องหักจากคนขับ (ค่าปรับ อุบัติเหตุ เงินเบิกค้าง) แล้วส่งออกให้ระบบเงินเดือน
2. **ผู้ใช้/สิทธิ์** — accounting/HR (`payroll_export:create`); manager อนุมัติ/ยกเว้น
3. **หน้าจอ** — บัญชี > รายการหักคนขับ: ตารางต่อคนขับ (รายการ · ที่มา · ยอด · งวดที่จะหัก · สถานะ) + ปุ่ม "ส่งออกงวดนี้"
4. **ฟิลด์** `DriverDeduction {driverId, sourceType: FINE|ACCIDENT|CASH_ADVANCE|DAMAGE|OTHER, sourceId, amount, installments, payrollPeriod, status, approvedBy, note}`; รวมถึงรายได้ค่าเที่ยว/เบี้ยเลี้ยงของคนขับ `DriverEarning {tripId, type: TRIP_PAY|ALLOWANCE|OVERTIME, amount}` สำหรับส่งออก
5. **กฎธุรกิจ**

- **BIL-160** รายการเกิดจาก: ค่าปรับจราจรที่เลือก "หักคนขับ" (06-fleet), ผลอุบัติเหตุที่คนขับเป็นฝ่ายผิดและกำหนดยอดหัก (06-fleet), เงินเบิกค้าง (BIL-153)
- **BIL-161** ทุกรายการต้องผ่านการอนุมัติก่อนส่งออก; แบ่งหักหลายงวดได้ (`installments`)
- **BIL-162** ไฟล์ส่งออก CSV/XLSX ต่องวด: รหัสพนักงาน · ชื่อ · รายได้ค่าเที่ยว/เบี้ยเลี้ยง · รายการหัก · ยอดสุทธิที่ส่ง — TMS **ไม่คำนวณเงินเดือน ภาษีเงินได้ หรือประกันสังคม** [PROPOSED]; ขอบเขต payroll และข้อจำกัดทางกฎหมายแรงงานเรื่องการหักค่าจ้าง **[OPEN] Q25**
- **BIL-163** เมื่อระบบเงินเดือนยืนยันการหัก (นำเข้าไฟล์ผลหรือกดยืนยัน) → สถานะ `DEDUCTED` และสถานะค่าปรับใน fleet เป็น "หักแล้ว"

6. **สถานะ** — `PENDING_APPROVAL` → `APPROVED` → `EXPORTED` → `DEDUCTED`; `PENDING_APPROVAL/APPROVED` → `WAIVED` (เหตุผล)
7. **event** — `driver_deduction.created`, `.approved`, `.exported`, `.deducted`, `.waived`
8. **กรณีผิดปกติ** — ส่งออกซ้ำงวดเดิม → ไฟล์ใหม่มีเฉพาะรายการที่ยังไม่ EXPORTED เว้นแต่เลือก "ส่งออกทั้งหมดอีกครั้ง"; ค่าปรับถูกยกเลิกหลัง EXPORTED → สร้างรายการคืน (ติดลบ) งวดถัดไป
9. **เกณฑ์ตรวจรับ** — Given ค่าปรับ 1,000.00 เลือกหักคนขับ แบ่ง 2 งวด · When อนุมัติและส่งออกงวด พ.ย. · Then ไฟล์มีรายการ 500.00 และงวด ธ.ค. เหลือ 500.00
10. **เฟส** — P1

---

## 14. ส่งออกให้นักบัญชี (เมื่อไม่มี connector)

1. **จุดประสงค์** — ให้ tenant ที่ไม่เชื่อม ERP (ค่าเริ่มต้น D1) ส่งข้อมูลให้สำนักงานบัญชี/ยื่นภาษีได้
2. **ผู้ใช้/สิทธิ์** — accounting (`billing.export`)
3. **หน้าจอ** — บัญชี > ส่งออกให้นักบัญชี: เลือกรายงาน · เดือน/ช่วง · นิติบุคคล/สาขา · รูปแบบไฟล์ (ทั่วไป CSV/XLSX · FlowAccount · PEAK · Express [OPEN] Q12) → ตัวอย่าง 20 แถว → ดาวน์โหลด (async job, B10); ประวัติการส่งออก
4. **ฟิลด์ (คอลัมน์) ของแต่ละไฟล์**

| ไฟล์ | คอลัมน์ | ป้าย |
|---|---|---|
| รายงานภาษีขาย (ต่อสาขา ต่อเดือน) | ลำดับ, วันที่, เลขที่ใบกำกับภาษี (RT/CN/DN), ชื่อผู้ซื้อ, เลขผู้เสียภาษีผู้ซื้อ, สำนักงานใหญ่/สาขาผู้ซื้อ, มูลค่า, VAT, หมายเหตุ (ยกเลิก / ออกแทนเลขที่ / CN อ้าง) | [FACT] ต้องแยกตามสถานประกอบการ + มีคอลัมน์เลขผู้ซื้อและสาขา (TAX §5.2); คอลัมน์ทางการครบชุด [OPEN] Q11 |
| รายงานรายได้ที่ได้รับยกเว้น VAT | วันที่, เลข RC, ลูกค้า, ยอดยกเว้น | [PROPOSED] ตาม OPINION TAX §5.2 (ใช้กรอก ภ.พ.30) — วิธีแสดงใน ภ.พ.30 [OPEN] Q3 |
| รายงานภาษีซื้อ | วันที่, เลขใบกำกับภาษีผู้ขาย, ผู้ขาย, เลขผู้เสียภาษี+สาขาผู้ขาย, มูลค่า, VAT, ที่มา (settlement/ค่าใช้จ่าย/ใบสั่งซ่อม) | [FACT] ต้องทำรายงานภาษีซื้อ (TAX §5.2); เกณฑ์รายการที่ใช้สิทธิ์ได้ [OPEN] Q24 |
| สรุป WHT ฝั่งจ่าย (ภ.ง.ด.3 / ภ.ง.ด.53 แยกไฟล์) | เลขผู้เสียภาษี 13 หลัก, สาขา, คำนำหน้า, ชื่อ, นามสกุล/ชื่อนิติบุคคล, ที่อยู่, วันที่จ่าย, ประเภทเงินได้, อัตรา, จำนวนเงิน, ภาษีที่หัก, เงื่อนไข | [PROPOSED] ตาม OPINION TAX §3.3 (text สำหรับ RD Prep: UTF-8 pipe-delimited, คำนำหน้าเว้นวรรคก่อนชื่อ, ที่อยู่ > 100 ตัวอักษรแยกช่อง [FACT]); spec คอลัมน์ทางการ [OPEN] Q26 |
| สรุป WHT ฝั่งรับ (50 ทวิ ที่ได้รับ) | วันที่, ลูกค้า, เลขผู้เสียภาษี, เลข 50 ทวิ, ฐาน, ภาษี, เลข INV/RC | [PROPOSED] ใช้เป็นเครดิตภาษีของ tenant |
| รายการขาย (INV/RC/RT) | เลขที่, วันที่, ลูกค้า, บรรทัด, ChargeType, taxCategory, ยอด, VAT, WHT คาด | |
| รับชำระ | เลข PAY, วันที่, ลูกค้า, วิธี, บัญชีธนาคาร, cash, WHT, fee, INV ที่ตัด | |
| จ่ายรถร่วม | เลข SET/PV, รถร่วม, ยอด, หัก, WHT, สุทธิ | |
| Journal CSV | วันที่, เลขเอกสาร, บัญชี (GL code), เดบิต, เครดิต, คำอธิบาย, คู่ค้า, สาขา | [PROPOSED] ผังบัญชีตั้งต้นและคู่บัญชี [OPEN] Q27 |

5. **กฎธุรกิจ**

- **BIL-170** ทุกไฟล์คำนวณจาก ledger/เอกสารเดียวกับที่ออก (X3) — ไม่คำนวณใหม่จาก order
- **BIL-171** รายงานภาษีขายใช้เดือนของ `issueDate` ของ RT/CN/DN; เอกสารยกเลิกแสดงแถวพร้อมหมายเหตุ "ยกเลิก" มูลค่า 0 [PROPOSED]; ใบที่ออกแทนมีหมายเหตุอ้างฉบับเดิม [FACT] T5
- **BIL-172** journal: คู่บัญชีตั้งค่าได้ต่อ ChargeType/บัญชีธนาคาร; ทุกเอกสารต้อง balance (Σ Dr = Σ Cr) ไม่ balance → ไม่ส่งออกและแสดงเอกสารที่ผิด
- **BIL-173** รูปแบบ FlowAccount/PEAK ใช้ template import ของผู้ขาย (FlowAccount: Cash Invoice .xlsx/.csv ≤ 5 MB; PEAK: ใบแจ้งหนี้ .xlsx ทศนิยม ≤ 4) [FACT] TAX §4.1–4.2; Express ยังไม่ยืนยันรูปแบบ — ซ่อนตัวเลือกจนกว่าจะยืนยัน [FACT ไม่พบข้อมูล] [OPEN] Q12
- **BIL-174** บันทึกประวัติส่งออก (ใคร เมื่อไร ช่วง ไฟล์) และ flag เอกสาร "ส่งออกแล้ว" ต่อชนิดไฟล์ — ใช้เตือนเมื่อมีเอกสารแก้/ยกเลิกหลังส่งออก
- **BIL-175** ล็อกงวด (period close) [PROPOSED P1]: accounting ปิดเดือนแล้ว → ออก/ยกเลิกเอกสารลงวันที่ในเดือนนั้นไม่ได้ ต้องให้ manager เปิดงวดพร้อมเหตุผล

6. **สถานะ** export job: `PENDING` · `COMPLETED` · `ERROR`
7. **event** — `export.completed`, `export.failed`, `period.closed`, `period.reopened`
8. **กรณีผิดปกติ** — ไฟล์ > 50,000 แถว → แบ่งไฟล์ zip; ข้อมูลลูกค้าไม่มีเลขผู้เสียภาษี → แถวมีป้ายเตือนในไฟล์และในหน้าตัวอย่าง
9. **เกณฑ์ตรวจรับ**
   - Given ต.ค. 2569 มี RT 3 ใบ (1 ใบยกเลิกแล้วออกแทน) · When ส่งออกรายงานภาษีขาย ต.ค. · Then มี 4 แถว: 2 ใบปกติ, 1 ใบ "ยกเลิก", 1 ใบ "ออกแทน RT…" และ RC ค่าขนส่งล้วนไม่อยู่ในรายงานนี้
   - Given settlement รถร่วมบุคคลธรรมดา 2 ราย นิติบุคคล 1 ราย จ่ายใน พ.ย. · When ส่งออก WHT · Then ได้ไฟล์ ภ.ง.ด.3 (2 แถว) และ ภ.ง.ด.53 (1 แถว)
10. **เฟส** — P0 (ภาษีขาย, ภาษีซื้อ, WHT, รายการขาย/รับชำระ/จ่ายรถร่วม CSV/XLSX ทั่วไป); P1 (journal, template FlowAccount/PEAK, ปิดงวด)

---

## 15. ซิงก์ไปโปรแกรมบัญชี/ERP

1. **จุดประสงค์** — ส่งเอกสารที่ออกแล้วไป connector ที่ tenant เปิด โดยไม่ผูกสถานะเอกสาร (D2, D3) — รายละเอียด adapter/mapping อยู่ใน 07-integration
2. **ผู้ใช้/สิทธิ์** — accounting เห็นคิว/ส่งซ้ำ; developer/admin ตั้งค่า
3. **หน้าจอ** — คอลัมน์ "ระบบบัญชี" (ไอคอน ซิงก์แล้ว/รอส่ง/ไม่ตรง/ล้มเหลว) และ timeline ซิงก์ใน drawer — **แสดงเฉพาะเมื่อมี connector**; เมนู "คิวเชื่อมระบบบัญชี" (ไม่ตรง · รอส่งซ้ำ · ถูกปฏิเสธ · รออนุมัติ) ตัวนับ = รายการที่ต้องทำ; ปุ่ม "ส่งเข้า <ชื่อ connector>" หลังออกเอกสาร
4. **ฟิลด์** `DocumentSync {documentType, documentId, connectorId, syncStatus, externalId, externalDocNo, lastSyncedHash, lastAttemptAt, attempts, lastErrorCode, lastErrorMessage}` (I2)
5. **กฎธุรกิจ**

- **BIL-180** syncStatus: `NOT_APPLICABLE` (ไม่มี connector/ก่อน syncFromDate) · `PENDING` · `SYNCING` · `SYNCED` · `FAILED` · `MISMATCH` · `REJECTED` · `VOID_PENDING` · `VOIDED`
- **BIL-181** เอกสารเข้าคิวซิงก์เฉพาะเมื่อ `ISSUED` (ร่างไม่ซิงก์); ยกเลิกเอกสาร → `VOID_PENDING`; สถานะเอกสารเปลี่ยนได้โดยไม่รอผลซิงก์ (D3)
- **BIL-182** TMS เป็น system of record ของเอกสารขนส่ง/วางบิล (I3) — ห้ามรับการแก้เอกสารจาก ERP กลับมา; รับกลับเฉพาะสถานะรับชำระ (I8) เพื่อ reconcile → ถ้าต่างจาก TMS = `MISMATCH`
- **BIL-183** `syncFromDate` ต่อ connector: เอกสารก่อนวันนี้ไม่ส่ง (I7)
- **BIL-184** retry อัตโนมัติ exponential (1, 5, 15, 60 นาที, สูงสุด 5 ครั้ง) แล้วเป็น `FAILED` เข้าคิว; ปุ่ม Retry ด้วยมือ; error code มีคู่มือแก้ (I6)
- **BIL-185** ต้อง map ChargeType/ลูกค้า/บัญชีธนาคาร ให้ครบก่อนส่ง (I4) — ไม่ครบ = `FAILED` code `MAPPING_MISSING`
- **BIL-186** settlement ส่งเป็น AP bill ได้ทางเดียว (BIL-132, X11)
- **BIL-187** เปิดได้หลาย connector พร้อมกัน → syncStatus แยกต่อ connector

6. **สถานะ** — ตาราง

| จาก | ไป | เงื่อนไข |
|---|---|---|
| PENDING | SYNCING | worker หยิบงาน |
| SYNCING | SYNCED | ปลายทางตอบสำเร็จ + เก็บ externalId |
| SYNCING | FAILED | error ชั่วคราวเกิน retry |
| SYNCING | REJECTED | ปลายทางปฏิเสธเชิงธุรกิจ (งวดปิด ฯลฯ) |
| SYNCED | PENDING | hash payload เปลี่ยน (เช่น เพิ่ม payment) |
| SYNCED | MISMATCH | ดึงสถานะกลับแล้วไม่ตรง |
| SYNCED | VOID_PENDING → VOIDED | เอกสารถูกยกเลิก |

7. **event** — `document.sync_succeeded`, `document.sync_failed`, `document.sync_mismatch`
8. **กรณีผิดปกติ** — connector ถูกปิดกลางทาง → คิวค้างเป็น `NOT_APPLICABLE` ไม่ลบ; ERP สร้างเลขเอกสารของตัวเอง → เก็บใน `externalDocNo` และพิมพ์เลข TMS ในช่อง ref ฝั่ง ERP (I5)
9. **เกณฑ์ตรวจรับ**
   - Given ไม่มี connector · When เปิดหน้าใบแจ้งหนี้ · Then ไม่มีคอลัมน์ "ระบบบัญชี" และไม่มีเมนูคิวเชื่อมระบบบัญชี
   - Given connector ปฏิเสธ void เพราะงวดปิด · When ยกเลิก INV · Then INV = CANCELLED และ syncStatus = REJECTED อยู่ในคิว
10. **เฟส** — P1 (ตาม 07-integration); P0 มีโครง `DocumentSync` + `NOT_APPLICABLE`

---

## 16. Template พิมพ์ A4

1. **จุดประสงค์** — PDF A4 มาตรฐานไทยของทุกเอกสาร ใช้ฟอนต์ Sarabun (design-briefs รอบ 6)
2. **ผู้ใช้/สิทธิ์** — ทุก role ที่ดูเอกสารได้พิมพ์ได้; admin ตั้งค่า template (`settings.print:edit`)
3. **หน้าจอ** — ตั้งค่า > เอกสารพิมพ์: เลือกเอกสาร → โลโก้, สี accent, ข้อความท้าย, ช่องลายเซ็น, จำนวนสำเนา, แสดง/ซ่อนฟิลด์ optional, ฟิลด์เพิ่มเติมที่แสดงในกล่อง "ข้อมูลอ้างอิง" → ตัวอย่างสด
4. **ฟิลด์บังคับต่อเอกสาร**

| เอกสาร | ฟิลด์บังคับบนกระดาษ | ต้นฉบับ/สำเนา |
|---|---|---|
| ใบส่งของ (DO) | เลข DO, วันที่, ผู้ส่ง/ผู้รับ + ที่อยู่, รายการสินค้า จำนวน หน่วย น้ำหนัก, ทะเบียนรถ, คนขับ, เลข SO/PO, QR ลิงก์ติดตาม/POD, ช่องเซ็นรับ (ชื่อ วันที่ เวลา) | ต้นฉบับ + สำเนา (ตั้งค่าจำนวนได้) |
| ใบคุมรถ (Trip sheet) | เลขเที่ยว, วันที่, ทะเบียน/หาง, คนขับ, ลำดับ stop (เวลานัด, สถานที่, DO), เลขไมล์ออก/กลับ, เงินเบิก, ช่องบันทึกค่าใช้จ่าย, ลายเซ็นคนขับ/ผู้ปล่อยรถ | เอกสารภายใน |
| ใบวางบิล (BN) | ผู้ออก (ชื่อ ที่อยู่ เลขผู้เสียภาษี สาขา), ลูกค้า (เดียวกัน), เลข/วันที่, ตาราง INV (เลข วันที่ ครบกำหนด ยอด ค้าง), รวม + ตัวอักษร, วันนัดรับเช็ค, ช่องเซ็นผู้รับวางบิล + วันที่ | ต้นฉบับ/สำเนา |
| ใบแจ้งหนี้ (INV) | ผู้ออก/ลูกค้าครบ, เลข/วันที่/ครบกำหนด/เครดิต, เลข PO, รายการ (คำอธิบาย DO ทะเบียน จำนวน ราคา ยอด, ป้าย "ยกเว้น VAT" หรือ "VAT 7%" ต่อบรรทัด), เส้นรวม (BIL-190), WHT ประมาณการ + ยอดชำระสุทธิ (ตัวเลือก), บัญชีธนาคารรับโอน | ต้นฉบับ/สำเนา |
| ใบเสร็จ (RC) | BIL-072 + วิธีรับ (BIL-056) + INV ที่อ้าง | ต้นฉบับ/สำเนา |
| ใบเสร็จรับเงิน/ใบกำกับภาษี (RT) | BIL-070, BIL-071, BIL-074 | "ต้นฉบับ" / "สำเนาใบกำกับภาษี" [FACT] |
| ใบลดหนี้/ใบเพิ่มหนี้ (CN/DN) | คำว่า "ใบลดหนี้"/"ใบเพิ่มหนี้", ผู้ออก/ผู้ซื้อ, วันที่, เลข+วันที่ใบกำกับภาษีเดิม, มูลค่าเดิม/ถูกต้อง/ผลต่าง, VAT, เหตุผล [FACT] TAX §1.5 | ต้นฉบับ/สำเนา |
| ใบสำคัญจ่ายรถร่วม (PV) | เลข/วันที่, ผู้รับเงิน (ชื่อ เลขผู้เสียภาษี บัญชี), รายการเที่ยว, รายการหัก, WHT, สุทธิ + ตัวอักษร, เลขใบแจ้งหนี้รถร่วม, ช่องเซ็น ผู้จัดทำ/ผู้อนุมัติ/ผู้รับเงิน | เอกสารภายใน |
| 50 ทวิ | BIL-146; 2 ฉบับ (ฉบับที่ 1/ฉบับที่ 2 ข้อความตามประกาศ) [FACT] | ฉบับที่ 1 / ฉบับที่ 2 |
| ใบสั่งซ่อม (WO) | เลข WO, วันที่, รถ/เลขไมล์, อาการ, รายการงาน/อะไหล่/ค่าแรง, อู่, ผู้ขอ/ผู้อนุมัติ (วงเงิน) | เอกสารภายใน |

5. **กฎธุรกิจ**

- **BIL-190** เส้นรวมของ INV/RT แสดงตามที่มี: "รวมค่าขนส่ง (ยกเว้น VAT)" · "ฐาน VAT 7%" · "VAT 7%" · "รวมทั้งสิ้น"; เอกสารที่ไม่มีบรรทัด VAT7 ห้ามแสดงบรรทัด "ฐาน VAT 7%"/"VAT 7%" (design-briefs รอบ 10 — VAT ตามการตั้งค่าลูกค้า); ถ้า entity ไม่จด VAT แสดง "รวมทั้งสิ้น" อย่างเดียว
- **BIL-191** หัวกระดาษทุกเอกสารภาษี: ชื่อ ที่อยู่ เลขผู้เสียภาษี + "สำนักงานใหญ่"/"สาขาที่ xxxxx" ของผู้ออก [FACT] T6
- **BIL-192** วันที่ในเอกสารภาษาไทยเป็น พ.ศ. รูปแบบ "9 พ.ย. 2569" หรือ "09/11/2569" (ตั้งค่าได้); โหมด EN/中文 ใช้ ค.ศ. (00-overview §6) [FACT] ใช้ได้ทั้งคู่ ป.86/2542 ข้อ 4(7)
- **BIL-193** จำนวนเงินเป็นตัวอักษรไทย (BahtText) ใต้ยอดรวม: กฎ "เอ็ด" เมื่อหลักหน่วย = 1 และมีหลักอื่นนำหน้า, "ยี่สิบ" สำหรับ 2 ที่หลักสิบ, ละ "หนึ่ง" ในหลักสิบ ("สิบ"), "บาทถ้วน" เมื่อไม่มีสตางค์, สตางค์ปัด 2 ตำแหน่ง → "…บาท…สตางค์"; เกินล้านวนซ้ำด้วย "ล้าน"; ตัวอย่าง: 11,070.00 = "หนึ่งหมื่นหนึ่งพันเจ็ดสิบบาทถ้วน", 21.50 = "ยี่สิบเอ็ดบาทห้าสิบสตางค์", 1,000,001.00 = "หนึ่งล้านเอ็ดบาทถ้วน" ; โหมด EN ใช้ "Eleven thousand seventy baht only"
- **BIL-194** กล่อง "ข้อมูลอ้างอิง": แสดง custom fields ของเอกสาร (และของ SO/DO ที่อ้าง) ที่ตั้ง "แสดงบน A4"; สูงสุด 8 ช่อง 2 คอลัมน์; ค่าว่างไม่แสดง; ห้ามวางทับช่องบังคับตามกฎหมาย
- **BIL-195** ป้าย "ต้นฉบับ"/"สำเนา" มุมขวาบน พิมพ์จากระบบ; ใบแทน/ยกเลิกแสดงข้อความ/ลายน้ำ "ใบแทน …"/"ยกเลิก"
- **BIL-196** PDF ของเอกสารภาษีถูก render ครั้งเดียวตอนออกและเก็บ immutable (hash SHA-256); พิมพ์ซ้ำใช้ไฟล์เดิม; สำเนา/ใบแทน render จาก snapshot เดิมเท่านั้น [PROPOSED ตาม OPINION TAX §5.1]
- **BIL-197** [FACT] รายการบนใบกำกับภาษีที่หัวเอกสารพิมพ์จากคอมพิวเตอร์ ต้องพิมพ์จากคอมพิวเตอร์ทั้งหมด ห้ามเขียนมือ (TAX §1.2 ข้อ 8 วรรค 3) — template ห้ามมีช่องว่างให้เขียนรายการ
- **BIL-198** ระยะเก็บ PDF/ข้อมูลเอกสารภาษี ≥ 7 ปี [PROPOSED] (กฎหมาย ≥ 5 ปี ขยายได้ ≤ 7 [FACT] T9); การเก็บบน cloud นอกสถานประกอบการต้องแจ้ง/ขออนุญาตหรือไม่ **[OPEN] Q28**
- **BIL-199** หน้ากระดาษ A4, ขอบ 15 มม., Sarabun 11–12pt, ตัวเลข tabular; หลายหน้าพิมพ์หัว/ท้ายซ้ำ + "หน้า n/N"

6. **สถานะ** — ไม่มี
7. **event** — `document.printed` (audit: ใคร ฉบับไหน), `document.emailed`
8. **กรณีผิดปกติ** — ชื่อลูกค้า/ที่อยู่ยาวเกิน → ตัดบรรทัดอัตโนมัติไม่ตัดคำไทยกลางคำ; โลโก้หาย → ไม่แสดงโลโก้ แต่ไม่ล้มการ render
9. **เกณฑ์ตรวจรับ**
   - Given INV ค่าขนส่งล้วน 25,000.00 · Then เส้นรวมมี "รวมค่าขนส่ง (ยกเว้น VAT) 25,000.00" และ "รวมทั้งสิ้น 25,000.00" และตัวอักษร "สองหมื่นห้าพันบาทถ้วน" ไม่มีบรรทัด VAT
   - Given RT ลงวันที่ 2026-11-09 โหมดไทย · Then พิมพ์ "9 พ.ย. 2569"
   - Given SO มี custom field "เลข Booking" ตั้งแสดง A4 · When พิมพ์ DO · Then กล่อง "ข้อมูลอ้างอิง" มี "เลข Booking: …"
10. **เฟส** — P0 (DO, trip sheet, BN, INV, RC, RT, CN/DN, PV, 50 ทวิ); WO ตาม 06-fleet

---

## 17. e-Tax Invoice & e-Receipt

1. **จุดประสงค์** — ส่ง RT/RC/CN/DN เป็น e-Tax ผ่าน service provider หรือโปรแกรมบัญชีที่เชื่อมไว้
2. **ผู้ใช้/สิทธิ์** — owner/admin เปิดใช้; accounting ส่ง
3. **หน้าจอ** — ตั้งค่า > e-Tax: โหมด (ไม่ใช้ · e-Tax Invoice & e-Receipt ผ่าน SP · e-Tax by Email), สถานะลงทะเบียน; คอลัมน์ "e-Tax" ในรายการเอกสาร
4. **ฟิลด์** — `etaxMode`, `providerId`, `etaxStatus` (`NOT_SENT` · `SENT` · `ACCEPTED` · `REJECTED`), `etaxRef`, ข้อมูลที่ map เป็น CII ได้ (document id/date, seller/buyer TXID+branch, lines, tax breakdown, reference doc) [OPINION TAX §2.2]
5. **กฎธุรกิจ**
- **BIL-200** [FACT] ระบบ e-Tax เป็นภาคสมัครใจ ไม่มี mandate B2B (TAX §2.1) → ปิดเป็นค่าเริ่มต้น
- **BIL-201** [FACT] ธุรกิจใช้ได้ระบบเดียว (SP หรือ by Email) → เลือกได้โหมดเดียวต่อนิติบุคคล
- **BIL-202** [PROPOSED] ไม่เขียน XML/XAdES เอง ส่งผ่าน SP API หรือผ่าน connector ที่รองรับ (TAX §2.2 OPINION)
- **BIL-203** [FACT] เอกสารพิมพ์จาก e-Tax ต้องมีข้อความว่าได้จัดทำและส่งข้อมูลให้กรมสรรพากรด้วยวิธีการทางอิเล็กทรอนิกส์ (ถ้อยคำจริงตรวจจากประกาศ) (TAX §1.2 ข้อ 11)
- **BIL-204** [FACT] RD ต้องได้รับข้อมูลภายในวันที่ 15 ของเดือนถัดไป (ระบบ SP) → แจ้งเตือนเอกสารค้างส่ง
- เกณฑ์รายได้ 30 ล้านของ by Email และโหมดที่จะรองรับ **[OPEN] Q9**
6–9. — สถานะ/event (`etax.sent`, `etax.accepted`, `etax.rejected`)/กรณีผิดปกติ (RD ปฏิเสธ schema → แก้แล้วส่งใหม่ [FACT]) และเกณฑ์ตรวจรับ จะเขียนเมื่อเลือก SP
10. **เฟส** — P2

---

## 18. Event รวมของโมดูล (สำหรับ webhook/audit)

| กลุ่ม | event |
|---|---|
| DO/คิว | `do.ready_to_bill`, `do.billing_hold_set`, `do.billing_hold_released` |
| ใบแจ้งหนี้/วางบิล | `invoice.created`, `invoice.issued`, `invoice.sent`, `invoice.partially_paid`, `invoice.paid`, `invoice.overdue`, `invoice.cancelled`, `billing_note.issued`, `billing_note.acknowledged`, `billing_note.cancelled` |
| รับเงิน/เอกสารภาษี | `payment.received`, `payment.voided`, `cheque.bounced`, `receipt.issued`, `tax_invoice.issued`, `credit_note.issued`, `debit_note.issued`, `tax_document.cancelled`, `tax_document.replacement_issued`, `wht_certificate.received` |
| AP | `settlement.created/sent/disputed/confirmed/approved/paid/cancelled`, `payment_voucher.issued`, `wht_certificate.issued` |
| คนขับ | `cash_advance.requested/approved/rejected/issued/cleared/overdue`, `expense.submitted/approved`, `driver_deduction.created/approved/exported/deducted/waived` |
| ระบบ | `export.completed/failed`, `period.closed/reopened`, `document.sync_succeeded/failed/mismatch`, `document.printed`, `document.emailed` |

payload ทุก event ใช้ schema กลาง (D6) มี `tenantId`, `documentId`, `docNo`, `status`, `occurredAt`, `actor`

## 19. สิทธิ์ (สรุป)

| การกระทำ | owner/admin | manager | accounting | approver | dispatcher | viewer |
|---|---|---|---|---|---|---|
| ตั้งค่าบัญชี/เลขที่ | ✓ | – | ✓ | – | – | – |
| สร้าง/ออก INV, BN | ✓ | ✓ | ✓ | – | อ่าน | อ่าน |
| รับชำระ / ออก RC, RT | ✓ | ✓ | ✓ | – | – | อ่าน |
| อนุมัติ CN/DN | ✓ | ✓ | – | ✓ | – | – |
| ยกเลิกเอกสารที่ออกแล้ว / void payment | ✓ | ✓ | – | – | – | – |
| Settlement สร้าง / อนุมัติ / จ่าย | ✓ | ✓/✓/– | ✓/–/✓ | –/✓/– | สร้าง (ถ้าให้สิทธิ์) | อ่าน |
| เงินเบิก ขอ / อนุมัติ / จ่าย | ✓ | ✓ | ✓ (จ่าย) | ✓ (อนุมัติ) | ขอ | – |
| ส่งออกให้นักบัญชี | ✓ | ✓ | ✓ | – | – | – |

## 20. คำถามที่ต้องตัดสิน [OPEN] (ย้ายไป 12-roadmap-open-questions.md)

| # | คำถาม | อ้างอิง TAX | ค่าเริ่มต้นชั่วคราว |
|---|---|---|---|
| Q1 | สัญญาขนส่งรวมบริการ (ขนส่ง+ยกขน/บรรจุ/คลัง/รอคิว) ราคาเดียวในใบเดียว — แยกบรรทัดยกเว้น/7% หรือทั้งสัญญาเสีย VAT | §1.8, §6.2 ข้อ 1 | บังคับแยกบรรทัดตาม ChargeType |
| Q2 | ค่าน้ำมัน/ทางด่วน/ค่ารอ/จุดเพิ่ม/ค้างคืนที่เรียกเก็บแยก เป็นค่าขนส่ง (ยกเว้น VAT, WHT 1%) หรือค่าบริการ (VAT 7%, WHT 3%) | §6.2 ข้อ 2 | ค่าขนส่ง |
| Q3 | เอกสารที่มีทั้งยกเว้นและ VAT7: ใบเดียว (SINGLE) หรือแยก 2 ใบ (SPLIT); การจดทะเบียน/เฉลี่ยภาษีซื้อ และการแสดงยอดยกเว้นใน ภ.พ.30 | §1.8, §6.2 ข้อ 1, 3 | SPLIT |
| Q4 | รองรับโหมดออกใบกำกับภาษีพร้อมใบแจ้งหนี้ (ON_INVOICE) ไหม และผลต่อ ภ.พ.30 ถ้าลูกค้าจ่ายข้ามเดือน | §6.2 ข้อ 4 | รองรับ ปิดเป็นค่าเริ่มต้น |
| Q5 | เลขข้ามยอมรับได้แค่ไหน; series ต่อสาขา/ต่อปี หรือ series เดียว | §1.7, §6.2 ข้อ 5 | ต่อสาขา ต่อเดือน |
| Q6 | ส่วนลดเชิงพาณิชย์ (ส่งช้า, rebate) ออกใบลดหนี้ได้ไหม (ประกาศฯ ฉบับ 82) | §1.5, §6.2 ข้อ 6 | ใช้รายการปรับภายใน |
| Q7 | แบบฟอร์ม 50 ทวิ ล่าสุด + ส่ง PDF อีเมลต้องยื่น ภ.อ.11 หรือไม่ | §3.2, §6.2 ข้อ 7 | พิมพ์กระดาษ |
| Q8 | ขั้นต่ำ 1,000 บาท "ต่อสัญญา" = ต่อเที่ยว/ต่อเอกสาร/ต่อสัญญารายปี; รถร่วมบุคคลที่รวมค่าน้ำมันยังเป็น 1% ไหม | §3.1, §6.2 ข้อ 8 | ต่อเอกสาร |
| Q9 | e-Tax: โหมด SP หรือ by Email; เกณฑ์ 30 ล้าน | §2.1, §6.2 ข้อ 9 | P2 |
| Q10 | ผู้ประกอบการที่รายได้ยกเว้น VAT ทั้งหมดขอจดทะเบียน VAT ได้หรือไม่ (ม.81/3) — กระทบค่า vatRegistered ตอน onboarding | §1.8 | ให้ tenant เลือกเอง |
| Q11 | คอลัมน์รายงานภาษีขาย/ซื้อตามแบบท้ายประกาศ 89/197 และปีมีผล | §5.2, §6.2 ข้อ 11 | ตาม §14 |
| Q12 | รูปแบบนำเข้า Express | §4.3, §6.2 ข้อ 12 | ซ่อนตัวเลือก |
| Q13 | ฐานคำนวณ WHT = ยอดก่อน VAT? รายการหักกลบลดฐานไหม | ไม่มีใน TAX | ก่อน VAT, ไม่ลดฐาน |
| Q14 | ชำระบางส่วน: แบ่งเงินระหว่างส่วนยกเว้นกับส่วน VAT แบบสัดส่วนหรือตัดส่วน VAT ก่อน | ไม่มีใน TAX | สัดส่วน |
| Q15 | บันทึกรับเงินย้อนหลังที่ทำให้วันที่ RT ถอยหลังกว่าใบล่าสุด — ใช้วันที่ไหน | §1.3, §1.7 | บล็อก ให้เลือกวันบันทึก + เหตุผล |
| Q16 | เงินรับล่วงหน้า/เงินเกินที่จะใช้กับค่าบริการ VAT7 เกิด tax point ทันทีหรือไม่ | ไม่มีใน TAX | ออก RC "รับล่วงหน้า" |
| Q17 | รับเช็ค: tax point ที่วันรับเช็คหรือวันเช็คผ่าน | ไม่มีใน TAX | วันรับเช็ค |
| Q18 | ยกเลิก RT/void payment ข้ามเดือนที่ยื่น ภ.พ.30 แล้ว ต้องทำอย่างไร (ยื่นเพิ่มเติม / ใช้ CN) | ไม่มีใน TAX | เตือน + ต้องยืนยัน |
| Q19 | หัว "ใบเสร็จรับเงิน/ใบกำกับภาษี" ใบเดียวต้องพิมพ์ "เอกสารออกเป็นชุด" หรือไม่ | §1.2 ข้อ 1, §1.3 | พิมพ์ |
| Q20 | ใบเพิ่มหนี้ส่วน VAT7 ที่ยังไม่ได้รับเงิน — ออกตอนเกิดเหตุหรือตอนรับเงิน | §1.5 | ตอนเกิดเหตุ |
| Q21 | ผู้รับเป็นห้างหุ้นส่วนสามัญ/คณะบุคคล ใช้ ภ.ง.ด.3 หรือ 53 | §3.1 | ตาม partyType |
| Q22 | ค่าจ้างคนขับรายเที่ยว (ไม่มีเงินเดือน) เป็นเงินได้ประเภทใด หักภาษีอย่างไร | ไม่มีใน TAX | ส่งออกไปเงินเดือน |
| Q23 | Settlement แบ่งจ่ายหลายงวด — หัก WHT ตอนจ่ายแต่ละงวดหรือครั้งแรก | §3.1 ข้อ 12/5 | ครั้งแรกทั้งก้อน |
| Q24 | ใบเสร็จค่าใช้จ่ายคนขับ (น้ำมัน ฯลฯ) ใช้เป็นภาษีซื้อได้เมื่อใด (ต้องเป็นใบกำกับเต็มรูปในนามบริษัท?) | §5.2 | เฉพาะที่ติ๊ก "ใบกำกับเต็มรูปในนามบริษัท" |
| Q25 | ขอบเขต payroll และข้อจำกัดกฎหมายแรงงานเรื่องหักค่าจ้างคนขับ | ไม่มีใน TAX | ส่งออกไฟล์เท่านั้น |
| Q26 | spec ไฟล์ text ภ.ง.ด.3/53 สำหรับ RD Prep | §3.3 | pipe-delimited UTF-8 |
| Q27 | ผังบัญชีตั้งต้นและคู่บัญชีของ journal export | ไม่มีใน TAX | ให้ tenant ตั้งเอง |
| Q28 | เก็บเอกสารภาษีบน cloud ต้องขออนุญาต/แจ้ง (ท.ป.116/2545, ป.121/2545) หรือไม่ | §5.1, §6.2 ข้อ 10 | — |
