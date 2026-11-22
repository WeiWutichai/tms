# ST9-T15 — การเก็บเอกสารที่ออกเลขแล้ว (ไม่มี hard delete · PDF ไม่ถูก render ใหม่)

วันที่: 22 พ.ย. 2569 · branch `st9/t15-retention-acceptance` · migration `0160_document_retention_guard`

ขอบเขต (D-54 "บัญชีเบา"): เอกสารที่ออกเลขแล้วของ TMS = **ใบแจ้งหนี้ ใบวางบิล ใบสำคัญจ่ายรถร่วม** (+ รับชำระ ตัวนับเลข ไฟล์ PDF ที่เก็บ audit log) — เอกสารภาษีจริง (ใบกำกับภาษี ใบเสร็จ ใบลด/เพิ่มหนี้ 50 ทวิ) ออกและเก็บที่ AccountSystem / โปรแกรมบัญชีของลูกค้า (D-55/D-56) ไม่อยู่ในระบบนี้

ที่มา: docs/04 J "เอกสารภาษี ≥ 5 ปี" (ห้าม hard-delete; retention default 7 ปี; เก็บ PDF ที่ render ณ วันออก ไม่ render ใหม่) · docs/01 §1 · spec/11 NFR-1202 · research/thai-tax-docs-research.md ข้อ 6 และ §5.1

เอกสารนี้แยก **FACT** (ตรวจจากโค้ด/ฐานข้อมูล/ผล test) กับ **ข้อเสนอ / [OPEN]** — ไม่มีการตีความกฎหมายใหม่ในงานนี้

---

## 1. FACT — ตัวกันระดับฐานข้อมูล ต่อตาราง

role: `tms_app` = API (RLS ต่อ tenant) · `tms_platform` = worker/job (ข้าม tenant) · เจ้าของ = role ที่รัน migration (เครื่อง dev เป็น superuser)
"trigger" = มีผลกับทุก role รวมเจ้าของ · "REVOKE" = ถอนสิทธิ์ของ role นั้น
ชื่อ test: `D` = `apps/api/test/document-retention.test.ts` · `S` = `apps/api/test/settlements.test.ts`

| ตาราง | กัน DELETE | กันแก้เนื้อหาหลังออก (UPDATE) | ก่อนงานนี้ | test |
|---|---|---|---|---|
| `invoice` | trigger `invoice_no_delete` (**ใหม่ 0160**) + REVOKE `tms_app` (0123) + REVOKE `tms_platform` (**ใหม่**) | trigger `invoice_issued_guard` (0140: ยอด/คู่ค้า/วันที่/snapshot/เลข/PDF), `invoice_terminal_guard`, `invoice_cancel_immutable` | REVOKE เฉพาะ `tms_app` — platform + เจ้าของลบได้ | D "DELETE บนตารางเอกสาร…", D "เอกสารที่ออกแล้วแก้เนื้อหาไม่ได้…" |
| `invoice_line` | trigger `invoice_line_no_delete` (**ใหม่**) + REVOKE ทั้งสอง role | trigger `invoice_line_guard` (0135: แก้ได้เฉพาะบรรทัด active ของร่าง) | เหมือนบน | D สองข้อเดียวกัน |
| `billing_note` | trigger `billing_note_no_delete` (**ใหม่**) + REVOKE ทั้งสอง role | trigger `billing_note_guard` (0142) | เหมือนบน | D สองข้อเดียวกัน |
| `billing_note_invoice` | trigger `billing_note_invoice_no_delete` (**ใหม่**) + REVOKE ทั้งสอง role | trigger `billing_note_invoice_guard` (0142: แก้ได้เฉพาะใบวางบิลร่าง) | เหมือนบน | D สองข้อเดียวกัน |
| `carrier_settlement` | trigger `carrier_settlement_no_delete` (**ใหม่**) + REVOKE ทั้งสอง role | trigger `carrier_settlement_terminal_guard` (0139: APPROVED → ตั้งได้แค่ข้อมูลการจ่าย · PAID/CANCELLED แก้ไม่ได้) | เหมือนบน | D "DELETE…", S "ST9-T15 เกณฑ์ตรวจรับ…" |
| `settlement_line` | trigger `settlement_line_no_delete` (**ใหม่**) + REVOKE ทั้งสอง role | trigger `settlement_line_guard` (0124/0130: บรรทัดของใบที่พ้นร่างแข็ง) | เหมือนบน | D "DELETE…", S "ST9-T15…" |
| `payment` | trigger `payment_guard` (0143 — มีอยู่แล้ว) | trigger เดียวกัน (เนื้อหาแก้ไม่ได้ กลับรายการได้ครั้งเดียว) | ครบแล้ว | D สองข้อ (+ `payments.test.ts` เดิม) |
| `payment_allocation` | trigger `payment_allocation_guard` (0143 — มีอยู่แล้ว) | trigger เดียวกัน | ครบแล้ว | D สองข้อ |
| `stored_document` (ไฟล์ที่เก็บ รวม PDF ณ วันออก) | trigger `stored_document_guard` (**ใหม่**) + REVOKE ทั้งสอง role (**ใหม่**) | trigger เดียวกัน (**ใหม่**): ไฟล์ที่เก็บแล้วเปลี่ยน `file_key`/`sha256`/ขนาด/ชนิด/เวลาสร้าง/tenant ไม่ได้ · PDF ของ `invoice`/`billing_note`/`carrier_settlement` แก้ไม่ได้ทั้งแถว (รวมเปลี่ยนเป็น `PURGED`) | **ไม่มีตัวกันเลย** — ทุก role ลบแถว/แก้ hash ได้ | D "DELETE…", D "แถวไฟล์ PDF ของเอกสารการเงิน…", S "ST9-T15…" |
| `document_sequence` (ตัวนับเลข) | trigger `document_sequence_no_delete` (**ใหม่**) + REVOKE `tms_app` (0007) + `tms_platform` (**ใหม่**) | trigger `document_sequence_guard` (**ใหม่**): `next_value` ไม่ถอยหลัง · tenant/ประเภท/สาขา/งวดแก้ไม่ได้ | REVOKE DELETE เฉพาะ `tms_app` · ถอยเลขได้ (= ออกเลขซ้ำ) | D "DELETE…", D "เอกสารที่ออกแล้วแก้เนื้อหาไม่ได้…" |
| `audit_log` | trigger `audit_log_append_only` (0007/0108) — ลบได้ทางเดียวคือฟังก์ชัน `tms_audit_retention_purge` ซึ่งข้าม entity ของเอกสาร/การเงิน | trigger เดียวกัน (UPDATE ปฏิเสธเสมอ) | ครบแล้ว | D "DELETE…", D "retention job…" (+ `retention.test.ts` เดิม) |

FACT เพิ่มเติม

- ร่างไม่มี hard delete มาแต่เดิม (role แอปไม่มีสิทธิ์ DELETE ตั้งแต่ 0123/0142/0122): ยกเลิกร่าง = `CANCELLED`, ถอดบรรทัด = `active false` / `voided_at` — trigger ใหม่จึงกันทั้งตารางโดยไม่กระทบ flow ร่าง (test เดิมของ invoice / billing note / settlement ผ่านทั้งหมด)
- ไม่มี foreign key แบบ `ON DELETE CASCADE` / `SET NULL` เข้าหรือออกจากตารางกลุ่มนี้ (ตรวจ `pg_constraint`)
- role แอป/platform ไม่มีสิทธิ์ `TRUNCATE` (D "สิทธิ์ DELETE ถูกถอน… (catalog)")
- ไฟล์ในที่เก็บ: key = `tenant/sha256.pdf` เขียนครั้งเดียว (`LocalFileStore.put` ใช้ `wx` + ตรวจ hash เมื่อมีไฟล์อยู่แล้ว) · `remove` มีผู้เรียกทางเดียวคือ retention job และเฉพาะ key ที่ทุกแถวเป็น `PURGED` — แถว PDF ของเอกสารการเงินเป็น `PURGED` ไม่ได้ (trigger) จึงไม่มีทางถึงการลบไฟล์ผ่านโค้ดของระบบ

## 2. FACT — retention job (ST9-T14) กับเอกสารที่ออกแล้ว

- `RetentionService` ลบ/แก้เฉพาะ `login_attempt`, `vehicle_position`, `stored_document` (เฉพาะ kind `EXPORT`; ไฟล์ POD พักไว้) และ `audit_log` ผ่านฟังก์ชัน DB — ไม่มีคำสั่งบนตารางเอกสาร (`retention.test.ts` "retention job แตะเฉพาะตาราง log/ไฟล์")
- เลื่อนเวลา 10 ปีแล้วรัน job: จำนวนแถวของทุกตารางในข้อ 1 เท่าเดิม · ไฟล์ PDF ยังอยู่และ sha256 ของไฟล์จริงตรงกับที่บันทึก · audit ของ `invoice`/`billing_note`/`payment`/`carrier_settlement`/`stored_document`/`document_sequence` ยังอยู่ (audit ของ entity ทั่วไปและไฟล์ส่งออกถูกลบตามปกติ) — D "retention job (เลื่อนเวลาไป 10 ปี)…"
- **ระยะเก็บ:** ค่าตั้ง `retention.financeDocumentYears` (**ใหม่**) ค่าเริ่ม **7 ปี** ขั้นต่ำ **5 ปี** (ต่ำกว่า → 422 `below_minimum`; ลดค่า = step-up ตามกติกา `retention.*` เดิม) — D "ระยะเก็บเอกสารที่ออกเลขแล้ว…" · **ไม่มี job ใดอ่านค่านี้ไปลบ** ในเฟส 0: เอกสารกลุ่มนี้ถูกเก็บตลอดที่ tenant ใช้งาน (ตรงกับ spec/11 NFR-1202) ค่านี้คือเพดานล่างที่งานลบ/archive ในอนาคตต้องเคารพ
- ก่อนงานนี้: ไม่มีค่าตั้งของเอกสารกลุ่มนี้เลย (จึงไม่มีทางตั้งต่ำกว่า 5 ปี — ไม่ใช่ defect ที่ทำให้ข้อมูลหาย แต่ "default 7 ปี" ของ docs/04 J ยังไม่มีที่อยู่)

## 3. FACT — PDF ที่เก็บ ไม่ถูก render ใหม่

| เอกสาร | เก็บเมื่อไร | หลังแก้ template | test |
|---|---|---|---|
| ใบแจ้งหนี้ — ต้นฉบับ | หลังออกเลข (ในคำขอ finalize; ล้ม = งาน `invoice.render_pdf` ลองใหม่) → `invoice.pdf_document_id` ผูกครั้งเดียว | ส่งไฟล์เดิม hash เดิม ตัว render ไม่ถูกเรียก | D "hash ของ PDF ไม่เปลี่ยนหลังแก้ template…" (+ `invoice-finalize.test.ts` เดิม) |
| ใบแจ้งหนี้ — สำเนา / ฉบับลายน้ำยกเลิก | render ครั้งแรกที่ขอ แล้วเก็บ | ไฟล์ที่เก็บแล้ว = เดิม · ยังไม่เคยเก็บ + แม่แบบเปลี่ยนรุ่น → 409 `invoice_pdf_template_changed` (ไม่ใช้แม่แบบใหม่เงียบ ๆ) | D ข้อเดียวกัน |
| ใบวางบิล — ต้นฉบับ / สำเนา | แบบเดียวกับใบแจ้งหนี้ (`billing_note.pdf_document_id`) | เหมือนบน | D ข้อเดียวกัน (+ `billing-notes.test.ts` เดิม) |
| ไฟล์รวมชุดใบวางบิลที่ส่งอีเมล (ST5-T21) | ตอนส่ง — entity `billing_note` kind `PDF` | แถว/ไฟล์แก้ไม่ได้ (trigger) | ครอบคลุมโดย trigger เดียวกัน (ไม่มี test เฉพาะ) |
| ใบสำคัญจ่ายรถร่วม — ฉบับอนุมัติ (`APPROVED`) และฉบับจ่ายแล้ว (`PAID`) | **เปลี่ยนในงานนี้:** render **ครั้งแรกที่ขอ** แล้วเก็บ (`stored_document` entity `carrier_settlement`, `metadata.variant`) + audit `settlement.pdf_stored` | ส่งไฟล์เดิม hash เดิม ตัว render ไม่ถูกเรียก | S "ST9-T15 เกณฑ์ตรวจรับ: PDF ใบสำคัญจ่ายที่มีเลขแล้ว…" |
| ใบสำคัญจ่าย — ร่าง (ไม่มีเลข) | ไม่เก็บ (render ตามคำขอ ลายน้ำ "ร่าง") | — | S ข้อเดียวกัน |

**สิ่งที่พบและแก้ (ใบสำคัญจ่าย):** ก่อนงานนี้ PDF ใบสำคัญจ่าย render ใหม่ทุกครั้ง (ใบ PAID มี cache ในหน่วยความจำ 10 นาที คีย์รวมรุ่นแม่แบบ) ตามคำตัดสิน ST6-T04 ข้อ (7) "ไม่ใช่เอกสารภาษี — ไม่เก็บไฟล์" — ขัดกับเกณฑ์ของ ST9-T15 ฉบับย่อ D-54 ที่ระบุใบสำคัญจ่ายเป็นเอกสารที่ออกเลขแล้ว แก้แบบแคบ: เก็บไฟล์ครั้งแรกที่ขอ (เขียนครั้งเดียวใต้ล็อกแถวใบ) แทน cache — บันทึกใน spec/12 §3 แถว ST9-T15

## 4. ข้อเสนอ / [OPEN]

| # | เรื่อง | สถานะ | ข้อเสนอ |
|---|---|---|---|
| 1 | **ใบสำคัญจ่ายยังไม่ได้เก็บ "ณ วันอนุมัติ/วันจ่าย"** — เก็บครั้งแรกที่มีคนขอ; ใบที่ไม่เคยถูกเปิดก่อนแก้แม่แบบจะ render ด้วยแม่แบบใหม่ (ชื่อจุดส่ง/คนขับของเที่ยวอ่านค่าปัจจุบัน; ยอดและผู้จ่ายตรึงแล้ว) และใบไม่มีช่องบันทึกรุ่นแม่แบบ ณ วันออก (ไฟล์ที่เก็บมี `metadata.templateVersion`) | [OPEN — lead/PO] (PROGRESS #78) | render หลัง commit ของ approve / mark-paid + งานลองใหม่แบบ `invoice.render_pdf` (กระทบเวลาตอบของ approve และต้องเพิ่มงานใน worker — จึงไม่ทำเงียบ ๆ ในงานนี้) |
| 2 | **ระยะเก็บตามกฎหมายของเอกสารที่ไม่ใช่เอกสารภาษี** (ใบแจ้งหนี้ ใบวางบิล ใบสำคัญจ่าย หลักฐานรับชำระ ของ D-54) — ม.87/3 และ ม.105 ทวิ ที่ research อ้าง พูดถึงใบกำกับภาษี/รายงาน/ใบรับ; เอกสารกลุ่มนี้อยู่ใต้ข้อใด เก็บกี่ปี นับจากวันไหน (วันออก / วันปิดบัญชี) และเลิกกิจการต้องเก็บต่อไหม | [OPEN — นักบัญชี/ทนาย] (PROGRESS #77; ต่อจาก ACC-C14 ใน plan/06) | ระหว่างรอ: ใช้ขั้นต่ำ 5 / ค่าเริ่ม 7 ปีตาม docs/04 J และไม่ลบเลย — ไม่ตั้งกฎเอง |
| 3 | **หลัง tenant ยกเลิกบริการ** (spec/10 §ระยะเก็บ: ส่ง export แล้ว purge วันที่ 90; plan/07 ข้อ "หลังยกเลิก") — งานลบ tenant (P1) จะชนกับ trigger กันลบของงานนี้ | [OPEN — ทนาย (plan/07) + PO] | เมื่อได้คำตอบ: ทำฟังก์ชัน SECURITY DEFINER แบบ `tms_audit_retention_purge` ที่ตรวจสถานะ tenant + ระยะเก็บเองและลง audit — ไม่ปิด trigger |
| 4 | **เจ้าของตาราง/superuser ยังข้ามได้** ด้วย `TRUNCATE`, `ALTER TABLE … DISABLE TRIGGER`, `SET session_replication_role = replica`, `DROP` (test ใช้ `TRUNCATE` ล้างฐาน *_test; `ap-dashboard.test.ts` ใช้ `session_replication_role`) | FACT + ข้อเสนอ (ops) | staging/production: role ของแอป ≠ role migrate ≠ superuser; ไม่ให้ credential เจ้าของกับ process ที่รันตลอด; สำรองข้อมูล + PITR (ST9 ops) |
| 5 | **ไฟล์ PDF บนดิสก์** — `LocalFileStore` ตั้งไฟล์เป็น read-only แต่ผู้ที่เข้าถึงเครื่องลบได้; ฐานข้อมูลเก็บ sha256 ไว้ตรวจจับ ไม่ได้ป้องกัน | ข้อเสนอ (มีอยู่แล้วใน plan/02 T-09) | production ใช้ S3-compatible + object lock ตามระยะเก็บ (≥ ค่าตั้ง `retention.financeDocumentYears`) + งานตรวจ hash เป็นรอบ |
| 6 | **ไฟล์ POD เป็นเอกสารประกอบใบแจ้งหนี้หรือไม่** (ต้องเก็บเท่าเอกสาร?) | [OPEN — PO/นักบัญชี] เดิมจาก ST9-T14 (job พักการลบไว้) | ไม่เปลี่ยนในงานนี้ |
| 7 | ตัวกันลบของ `stored_document` ครอบทุกชนิดไฟล์ (ไม่ใช่เฉพาะ PDF การเงิน) — ตรงกับพฤติกรรมเดิม (ไม่มีโค้ดใดลบแถว; retention ใช้ `PURGED`) แต่คำขอลบข้อมูลส่วนบุคคล (PDPA) ที่ต้องลบ "แถว" ในอนาคตต้องออกแบบทางเฉพาะ | ข้อสังเกต | ลบเนื้อไฟล์ผ่านสถานะ `PURGED` (มีอยู่แล้ว) + ล้าง metadata ด้วยฟังก์ชันเฉพาะเมื่อมีงาน PDPA erasure |

## 5. วิธีตรวจซ้ำ

```
cd apps/api
npx vitest run test/document-retention.test.ts
npx vitest run test/settlements.test.ts -t "ST9-T15"
```
