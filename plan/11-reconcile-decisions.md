# 11 — ตารางตัดสินจุดขัดกัน (ST0-T19 ส่วนที่ 1)

> ร่าง 10 พ.ย. 2569 · ที่มา: `plan/01-phase0-backlog.md` §3.1 (21 ข้อ) + `plan/00a`, `plan/00b` + คำตัดสินใน `plan/05`
> สถานะ: **ใช้ค่าเริ่มต้นไปก่อน** — ข้อที่ติด ★ ต้องให้ PO ยืนยันก่อน freeze schema ของ stage นั้น · ข้ออื่นถือว่าตัดสินแล้วตามกติกา "docs ชนะ spec" (`CLAUDE.md`) เว้นแต่ PO แย้ง
> ส่วนที่ 2 ของ T19 (Prisma schema v0 ของ ST1–ST4 + JSON schema ของ mock KRS) ทำต่อจากตารางนี้

| # | เรื่อง | ตัดสิน | ฐาน | กระทบ | ต้องยืนยัน |
|---|---|---|---|---|---|
| 1 | ชื่อ entity | `company` / `branch`; แยก `sales_order` กับ `delivery_order` | docs/01 §3 (D-01, D-17) | ทุกตาราง | — |
| 2 | สถานะเที่ยว | `PLANNING → OFFERED → ASSIGNED → DISPATCHED → IN_PROGRESS → COMPLETED → COSTED → SETTLED` + `CANCELLED`; เพิ่ม "คนขับรับงาน" เป็นธงบน trip ไม่ใช่สถานะใหม่ | docs/01 §4.2 + D-24 | ST3, ST4, ST6 | ★ D-24 (spec ต้องการ `accepted`/`rejected` เป็นสถานะ) |
| 3 | ชื่อ enum ที่ต่างกัน | สูตรราคา `PER_TRIP / PER_KM / PER_TON / PER_CBM / PER_UNIT`; rate card `DRAFT / PENDING_APPROVAL / APPROVED / RETIRED` (อนุมัติ = P1 แต่เก็บสถานะไว้); dispute รายการ `NONE / DISPUTED / RESOLVED`; settlement `SENT_TO_CARRIER` | docs/01 (ชื่อยาว อ่านชัด) | ST2, ST6 | — |
| 4 | รหัสเหตุผลใบค้าง | ใช้ชุด docs/04 C 12 รหัสเป็นชุดระบบ (ลบไม่ได้) และ map ชื่อใน docs/01 §4.1 เข้าไป: `ROUTE_PENDING → LOCATION_UNMAPPED/RATE_MISSING`, `NO_VEHICLE → UNALLOCATED_NO_VEHICLE` | docs/04 C ละเอียดกว่า | ST2-T12, ST3-T07 | — |
| 5 | สถานะใบแจ้งหนี้ | ตาม docs/01 §4.4: `DRAFT / ISSUED / SENT / ACCEPTED / MISMATCH / PARTIALLY_PAID / PAID / ADJUSTED / VOIDED / CANCELLED(draft)` — SENT/ACCEPTED/MISMATCH เกิดเฉพาะ tenant ที่เปิด connector และ API แสดงเป็น object `sync` แยก (standalone ไม่เห็น); "ส่งลูกค้าแล้ว" = `sent_to_customer_at`; เกินกำหนด = คำนวณจาก `due_date` | docs/01 §4.4 (แก้ 10 พ.ย. — ร่างแรกของตารางนี้ตั้งชื่อเอง ผิดหลัก docs ชนะ) | ST5, ST7 | ★ ยืนยันกับนักบัญชี (`plan/06`) |
| 6 | สถานะ DO / วางบิล | ตาม docs/01 §4.3 สถานะเดียว: `DRAFT → PLANNED → DISPATCHED → DELIVERED → POD_PENDING → UNBILLED → BILLED` + `FAILED / RETURNED / CANCELLED`; เพิ่ม "รับของแล้ว" ตาม D-23; ไม่มี `RELEASED` (ถ้าต้องกันวางบิลใช้ธง `billing_hold`) | docs/01 §4.3 + D-23 (แก้ 10 พ.ย. เช่นกัน) | ST4, ST5 | — |
| 7 | ยกเลิกใบที่ออกเลขแล้ว | ออกเลขแล้วแก้/ลบไม่ได้; ยกเลิก = ใบลดหนี้เต็มใบ (`VOIDED`) เลขเดิมคงอยู่; `CANCELLED` ใช้เฉพาะ draft (ไม่มีเลข) | docs/01 §4.4 + กฎภาษี | ST5 | ★ คำถามนักบัญชีข้อ 8 (D-20) |
| 8 | ความสามารถ KRS | ทำตาม docs/01 A.1–A.2: ไม่มี void/payment status/getMasters → `capabilities()` ของ KrsAdapter ไม่ประกาศ 3 อย่างนี้; framework รองรับ + DemoProvider | docs/01 Appendix A | ST7, ST8 | ★ คำตอบทีม KRS (`plan/08`) |
| 9 | mapping ไม่ครบตอน finalize | ไม่บล็อกการออกเอกสาร (standalone-first); outbox เป็น `FAILED_FINAL` class `VALIDATION` + แสดงในคิวข้อผิดพลาด | docs/01 §7.4 | ST5, ST7 | — |
| 10 | ขอบเขต Open API | เฟส 0 = endpoint ที่ UI + connector ใช้ + webhook; หน้า key/docs/sandbox/SDK สาธารณะ = เฟสขาย 2 | D-05 | ST7 | — |
| 11 | ชุด role | 9 role ภายใน (owner, admin, manager, planner, dispatcher, invoicer, accounting, approver, viewer — แก้ 10 พ.ย. 2569 ให้ตรง D-12 "ชุด docs + manager" ซึ่งมี approver) + principal รถร่วมผ่าน magic link; driver/customer portal ไม่มีในเฟส 0 | D-12 | ST1 | — |
| 12 | Admin portal | tenant list, connector status, health, impersonate (มีเหตุผล + audit) — ไม่มี allowlist | docs/02 §5, §7 | ST1 | — |
| 13 | ส่งลิงก์รถร่วม / เปลี่ยน carrier | ปุ่มแชร์ลิงก์ + SMS (D-13); เปลี่ยน carrier = ยกเลิกการจ้างบน trip เดิม (ไม่มี parent/child trip) | D-13 + docs/04 D3 | ST3 | — |
| 14 | เงินเบิก / ค่าเที่ยวคนขับ | บรรทัดหัก "เงินเบิกล่วงหน้า" กรอกมือใน settlement; ค่าเที่ยวคนขับไม่มีในเฟส 0 (รถร่วมเท่านั้น) | docs/04 F6/F7 P-level | ST6 | — |
| 15 | ค่าใช้จ่ายรถ | เขียนแถว `vehicle_cost` ตอนต่อเอกสารรถ (P0) แต่ยังไม่มีหน้ารายงาน; เตือนในระบบ + อีเมล (LINE ทีมภายใน P1) | docs/04 B2 | ST2 | — |
| 16 | แถวสองระดับ | ภาษา: ไทยบังคับ, EN ไม่บังคับใน DoD (D-11 — แก้ DoD ใน `plan/10` แล้ว); saved views = P1; รายงานภาษีขาย P0, ภาษีซื้อ P1 | D-11 + docs/04 | หลาย stage | — |
| 17 | ส่งเอกสารให้ลูกค้า | PDF + อีเมล; ไม่มี customer portal | docs/04 F3 (portal = P2) | ST5 | — |
| 18 | ที่ตั้งข้อมูล | ไทยถ้าบริการครบ ไม่งั้นสิงคโปร์ + ข้อความโอนข้ามแดน | D-16 | T-08 | ★ เลือก cloud (PLAN §1.1 ข้อ 10) |
| 19 | NFR ไม่มีป้าย P | ถือเป็นเป้าเฟส 0 ยกเว้นแถว Mobile app | — | ST9 | — |
| 20 | กฎตอนจัดงาน | เตือน + เหตุผล (ยกเว้นรถร่วมเอกสารหมดอายุ = บล็อก) | docs/04 D2 | ST3 | ★ **D-07 ยังรอคำตอบ** |
| 21 | Settlement dispute | ดู + ยอมรับผ่านลิงก์; พนักงานบันทึกข้อโต้แย้งในเว็บ; โต้แย้งรายบรรทัดผ่านลิงก์ = P1 | D-09 | ST6 | — |

## สิ่งที่ตารางนี้ทำให้เดินต่อได้

- schema ของ ST1 (ผู้ใช้/role/บริษัท/สาขา/เลขเอกสาร/audit) และ ST2 (master + fleet P0) ไม่ติดข้อ ★ ใด → เขียน schema v0 และ freeze ได้เลย
- ST3–ST4 ติด ★ ข้อ 2 (D-24) และข้อ 20 (D-07) → schema v0 เป็นร่าง จนกว่า PO ตอบ
- ST5–ST6 ติด ★ ข้อ 5, 7 → รอนักบัญชี

## ต้องแก้เอกสารตาม (ทำพร้อม schema v0)

- `spec/03` สถานะเที่ยว + กฎตอนจัดงาน, `spec/05` สถานะใบแจ้งหนี้ + การยกเลิก, `spec/10` enum ทั้งชุด → ให้ตรงตารางนี้
- `docs/04` ข้อความที่ขัดกันเอง (ข้อ 11, 13, 14, 16, 17) → เสนอ PO แก้ (docs เป็นของ PO)
