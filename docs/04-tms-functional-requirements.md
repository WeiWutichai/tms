# TMS Functional & Platform Requirements (v2)

Nov 3, 2026 · @wei · แทนที่ v1 (Oct 14, 2026)

TMS เป็นระบบ **standalone-first** ที่มี **Open API เป็น first-class** และมี ERP (KRS) เป็น connector หนึ่งตัวบนมาตรฐาน API เดียวกัน ไม่ใช่ศูนย์กลางของระบบอีกต่อไป เอกสารนี้เป็น checklist ฟังก์ชันครบทั้งระบบ 13 หมวด (A–K + B2 Fleet + E2 Driver app, เพิ่ม 4 พ.ย. 69) ราว 270 รายการ แต่ละแถวมีลำดับความสำคัญและ "ที่มา" (id จาก research 3 ฉบับ หรือ v1) ส่วนรายละเอียดภายในของ KRS adapter อยู่ใน "TMS × KRS Integration", ราคา/tenant อยู่ใน "Product & Commercial", มาตรฐาน API ฉบับเต็มอยู่ใน "TMS API Benchmark" หัวข้อ 9

## 0. สิ่งที่เปลี่ยนจาก v1

| เรื่อง | v1 | v2 | เหตุผล |
|---|---|---|---|
| จุดยืน | KRS pilot ก่อน, standalone ตาม | standalone + KRS pilot พร้อมกัน; ERP = connector | ตลาดไทยส่วนใหญ่ไม่มี ERP ที่มี API; KRS คือลูกค้า 1 ราย |
| นิยาม P0 | "ถ้าไม่มี KRS ใช้งานจริงไม่ได้" | **ต้องมีเพื่อขาย standalone และขึ้น KRS pilot พร้อมกัน** | ป้องกันการสร้างระบบที่ขายได้แค่รายเดียว |
| Billing | วางบิล → ส่ง ERP | AR ครบชุดเอกสารไทย + AP รถร่วม + หัก ณ ที่จ่าย ในตัว | standalone ต้องออกเอกสารภาษีเองได้ (thai-tax-docs) |
| Integration | ERP adapter + API อ่าน (P1) | Open API เขียน/อ่าน + webhook เป็น P0; KRS/FlowAccount/PEAK/Express เป็น connector บน API เดียวกัน | tms-api-benchmark หัวข้อ 9–11 |
| Dispatch | DO = 1 เที่ยว | DO ↔ Trip ↔ TripStop แยกกัน; จ่ายงานรถร่วมผ่านลิงก์ LINE | PL1, PL4 |
| Driver | app P2 | ePOD ผ่านลิงก์ P0, app offline-first P1 — สเปก 10 จอใน E2 (เพิ่ม 4 พ.ย. 69) | E1, E6, decision 2026-11-04 |
| หมวดใหม่ | — | K "สิ่งที่ไม่ทำ" | X1–X14 |

นิยาม P0 = ต้องมีเพื่อขาย standalone รายแรก **และ** ขึ้น KRS pilot (ชุดเดียวกัน); P1 = ลูกค้าทั่วไป 10–200 คันจะไม่ต่ออายุถ้าไม่มี; P2 = สร้างความต่าง/ขยายตลาด

## 1. ภาพรวมโมดูลและลำดับความสำคัญ

| # | โมดูล | หน้าที่ | P0 | P1 | P2 |
|---|---|---|---|---|---|
| A | Platform & Auth | login, 2FA, role/permission ระดับฟิลด์, หลายนิติบุคคล/สาขา, setup checklist, audit | ✔ | custom role, SSO | portal ลูกค้า |
| B | Master data | ลูกค้า, สาขา, Carrier (รถร่วม), รถ, คนขับ 3 ประเภท, จุดส่ง, rate card 2 ฝั่ง, accessorial, reason master | ✔ | rate approval, สูตรเหมาวัน | time slot |
| B2 | Fleet (จัดการรถ) | ทะเบียนรถขยาย, เอกสารรถ+เตือนต่ออายุ, PM ตามแผน, ใบสั่งซ่อม (WO), น้ำมัน/ค่าใช้จ่ายเดินรถ, ต้นทุนต่อคัน (vehicle_cost ledger), อุบัติเหตุ/เคลม, รถร่วมแบบย่อ | ✔ ทะเบียน+เอกสาร+รถร่วมย่อ | PM, WO, น้ำมัน, ต้นทุน/กำไรต่อคัน, เคลม | อะไหล่/สต็อก, DVIR, GPS fuel sensor |
| C | Order intake | รับ order ทุก source (มือ/Excel/API/KRS), upsert ด้วย external id, ใบค้าง + reason code, edit lock | ✔ | recurring | customer portal |
| D | Planning & Dispatch | DO↔Trip↔TripStop, planning board, จ่ายงานรถร่วมผ่าน LINE, assign vs dispatch | ✔ | cascade P1→P2, margin, ปันส่วนต้นทุน | VRP |
| E | Execution & POD | สถานะต่อ stop, ePOD เว็บ/ลิงก์, actual qty, detention, tracking link | ✔ | หน้าติดตามรถ (แผนที่) + GPS connector ค่ายแรก, geofence | GPS ค่ายอื่น |
| E2 | Driver app (ePOD) — มือถือ | แอปคนขับ 10 จอ offline-first (login OTP, งานวันนี้, รายละเอียดงาน, POD, แจ้งปัญหา, DVIR, เบิกเงิน/น้ำมัน, ของฉัน) + web ลิงก์รถร่วมไม่ต้อง login; ใช้ Open API scope `driver` | ✔ M10 ลิงก์รถร่วม | M1–M6, M8–M9 แอปคนขับ (เฟส 2) | M7 DVIR |
| F | Billing & Settlement | AR ครบชุดเอกสารไทย, VAT ต่อรายการ, WHT, AP รถร่วม + 50 ทวิ, cash advance, รับชำระ/aging | ✔ | e-Tax ผ่าน SP, ภ.ง.ด.3/53 export | e-WHT |
| G | Open API & Integration | API มาตรฐาน + webhook, ErpAdapter, external mapping, error queue, connector KRS | ✔ API+KRS | FlowAccount, PEAK, Express export | marketplace, GPS |
| H | Reports & Dashboard | ทุกตัวคำนวณจาก invoice/settlement line เดียวกัน | ✔ | กำไร, aging, ส่งอัตโนมัติ | DLT |
| I | Cross-cutting | แจ้งเตือน, ค้นหา, import/export, settings, help center | ✔ | LINE, help step-by-step | — |
| J | Security, Compliance, NFR | tenant isolation, retention 5 ปี, e-Tax XML, PDPA | ✔ | pentest | — |
| K | สิ่งที่ไม่ทำ | ขอบเขตที่ตัดออกและเหตุผล | — | — | — |

## A. Platform, Authentication และสิทธิ์

สรุป: ระบบเป็น multi-tenant shared schema + RLS, permission ละเอียดถึงระดับฟิลด์ราคา, รองรับหลายนิติบุคคล/สาขาตาม ภ.พ.20 ตั้งแต่ P0 เพราะใบกำกับภาษีผูกกับสาขาผู้ออก

**A1. Authentication**

| ฟังก์ชัน | รายละเอียด | P | ที่มา |
|---|---|---|---|
| Login อีเมล + รหัสผ่าน | argon2id, rate limit 5 ครั้ง/15 นาที ต่อบัญชีและ IP, ล็อก 15 นาที | P0 | v1 |
| นโยบายรหัสผ่าน | ≥ 12 ตัว, ตรวจ HIBP k-anonymity, ห้ามซ้ำ 5 ครั้งล่าสุด, ไม่บังคับเปลี่ยนตามเวลา | P0 | v1 |
| ลืมรหัสผ่าน | ลิงก์อีเมลอายุ 30 นาที ใช้ครั้งเดียว ไม่เผยว่ามีอีเมลในระบบ | P0 | v1 |
| 2FA TOTP | backup code 10 ชุด; บังคับ: Innovera admin, `owner`, `accounting` ที่อนุมัติได้; owner ตั้งบังคับทั้งองค์กรได้ | P0 | v1 |
| 2FA OTP อีเมล | ทางเลือกสำหรับ user ไม่มีสมาร์ทโฟน อายุ 10 นาที | P1 | v1 |
| Session | JWT access 15 นาที + refresh 7 วัน (httpOnly), idle 8 ชม. (ตั้งได้), จำอุปกรณ์ 30 วัน | P0 | v1 |
| Token version ต่อ user | ทุก JWT มี `tokenVersion`; เปลี่ยน role/ถอนสิทธิ์/ระงับ → bump → **ทุก session หลุดทันที**; เพิ่มสิทธิ์ → banner ให้ refresh | P0 | P4 |
| ดูอุปกรณ์ที่ login | รายการ session + เพิกถอนรายตัว | P1 | v1 |
| SSO (Google/Entra) | OIDC สำหรับ tier Business+ | P2 | v1 |
| Login คนขับ | เบอร์โทร + OTP SMS สำหรับ Driver app ไม่มีรหัสผ่าน; เลือก tenant ถ้าเบอร์อยู่หลาย tenant; จำเครื่อง 30 วัน (`driver_device`) — ดู E2 M1 | P1 | v1 (เลื่อนขึ้นตาม E1), decision 2026-11-04 |
| เข้าถึงโดยไม่ login (magic link) | ลิงก์เซ็นด้วย HMAC + หมดอายุ สำหรับรถร่วมรับงาน/อัปโหลด POD/ดูใบจ่าย และผู้รับติดตามพัสดุ; จำกัด action ต่อลิงก์ | P0 | PL4, E6, B8, E9 |

**A2. User lifecycle**

| ฟังก์ชัน | รายละเอียด | P | ที่มา |
|---|---|---|---|
| เชิญผู้ใช้ | อีเมล ลิงก์ 7 วัน กำหนด role ตอนเชิญ นับ seat ตาม tier | P0 | v1 |
| โปรไฟล์ | ชื่อ เบอร์ ภาษา timezone ลายเซ็นดิจิทัล (ใช้บนเอกสาร/50 ทวิ) | P0 | v1 |
| ระงับ / เปิดใช้ / ลบ | ระงับ = bump tokenVersion ทันที; ลบ = anonymize ใน audit แต่เก็บ record | P0 | v1, P4 |
| โอนงาน | ระงับ planner → ย้าย order/trip ที่ถือครอง | P1 | v1 |
| ประวัติ login | เวลา IP อุปกรณ์ ผล เก็บ 1 ปี | P0 | v1 |
| User เข้าได้หลาย tenant | สำนักงานบัญชี/กลุ่มบริษัท ใช้บัญชีเดียวสลับ tenant | P1 | P1 (LogisticsX `UserTenantAccess`) |

**A3. Role และ permission**

สิทธิ์เป็น `{module}.{view|manage}` + permission พิเศษระดับฟิลด์ ผูกกับ role; role มาตรฐาน 10 แบบมีตั้งแต่ P0, tenant owner สร้าง/แก้ custom role ได้ที่ P1

| สิทธิ์ | Owner | Admin | Planner | Dispatcher | **Invoicer** | Accounting | Approver | Viewer | **Carrier portal** | Driver | **Customer portal** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| user / role / 2FA policy | ✔ | ✔ | | | | | | | | | |
| ตั้งค่าองค์กร / สาขา / connector / API key | ✔ | ✔ | | | | | | | | | |
| Master data | ✔ | ✔ | แก้ | อ่าน | อ่าน | อ่าน | อ่าน | อ่าน | | | |
| **ดู/แก้ราคาขาย** (field perm) | ✔ | ✔ | เลือกได้ | **ไม่เห็น** (default) | ✔ | ✔ | อ่าน | เลือกได้ | **ห้ามเด็ดขาด** | ห้าม | เฉพาะของตัวเอง |
| **ดูราคาซื้อรถร่วม** (field perm) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | อ่าน | เลือกได้ | เฉพาะของตัวเอง | ห้าม | ห้าม |
| Order: ดู / จัด / ยกเลิก | ✔ | ✔ | ✔ | อ่าน | อ่าน | อ่าน | อ่าน | อ่าน | | | สร้าง/ดูของตัวเอง |
| Trip: assign / dispatch / ปิด | ✔ | ✔ | assign | ✔ | อ่าน | อ่าน | อ่าน | อ่าน | รับ/ปฏิเสธ + POD | ยืนยันของตัวเอง | |
| Invoice/ใบวางบิล: draft / finalize | ✔ | ✔ | | | ✔ / ✔ | ✔ / ✔ | อ่าน / ✔ | อ่าน | | | ดู/ดาวน์โหลดของตัวเอง |
| ใบลดหนี้/เพิ่มหนี้: ขอ / อนุมัติ | ✔ / ✔ | ✔ / | | | ขอ | ขอ | อนุมัติ | | | | |
| Settlement รถร่วม: สร้าง / อนุมัติ / จ่าย | ✔ | ✔ | | สร้าง | สร้าง | ✔ / ✔ / ✔ | อนุมัติ | อ่าน | ดู + dispute ของตัวเอง | ดูค่าเที่ยวตัวเอง | |
| Integration log / error queue / retry | ✔ | ✔ | | | ✔ | ✔ | ✔ | อ่าน | | | |
| รายงานการเงิน | ✔ | ✔ | | | ✔ | ✔ | ✔ | เลือกได้ | | | |
| รายงานปฏิบัติการ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | | | |
| Export ข้อมูล | ✔ | ✔ | ✔ | | ✔ | ✔ | | | | | |
| Audit log | ✔ | ✔ | | | | อ่านของบัญชี | | | | | |

กฎเพิ่มเติม: ผู้สร้างใบแจ้งหนี้ finalize ใบตัวเองไม่ได้ (ปิดได้สำหรับ tenant เล็กโดย owner ยอมรับความเสี่ยง); เปลี่ยน role ต้อง step-up 2FA; **Carrier/Customer portal เป็น principal แยก** (ไม่นับ seat, ผูกกับ Carrier/Customer record ไม่ใช่ user ภายใน) — ที่มา: v1, P2, P3, P7

**A4. หลายนิติบุคคล / สาขา (ภ.พ.20)**

| ฟังก์ชัน | รายละเอียด | P | ที่มา |
|---|---|---|---|
| `legal_entity` ใน tenant | ชื่อจดทะเบียน, เลขผู้เสียภาษี 13 หลัก, สถานะจด VAT, โลโก้/ลายเซ็นบนเอกสาร; 1 tenant มีได้หลายนิติบุคคล | P0 | P9 |
| `company_branch` ต่อนิติบุคคล | รหัสสาขา 5 หลัก (00000 = สำนักงานใหญ่), ที่อยู่ตาม ภ.พ.20, เป็น `issuing_branch` บังคับบนใบกำกับภาษี/ใบเสร็จ | P0 | P9, thai-tax 5.3 |
| Number series ต่อ (นิติบุคคล × สาขา × ประเภทเอกสาร × ปี/เดือน) | prefix ตั้งเอง เช่น `INV-00001-2569-`; เลขออกตอน finalize เท่านั้น | P0 | B9 |
| Routing เอกสารตามนิติบุคคล | ลูกค้า/สัญญากำหนด "ออกบิลในนาม" (Invoice As) และรถร่วมกำหนด "จ้างในนาม" (Tender As); map 1 สาขา ↔ 1 company ใน ERP | P0 | I9 |
| Group view | ดูรายงานรวมทุกนิติบุคคล / แยกรายตัว | P1 | P9 (Dashdoc) |

**A5. Onboarding / setup**

| ฟังก์ชัน | รายละเอียด | P | ที่มา |
|---|---|---|---|
| Setup checklist | ตั้งค่าองค์กร → สาขา → เลขเอกสาร → ภาษี default → import master → เชิญทีม → (เลือก) ต่อ connector; แสดง % เสร็จบนหน้าแรก | P0 | P8, X5 |
| Import Excel ทุก master แบบ **dry-run** | อัปโหลด → preview ทุกแถว → รายงานแถวผิดพร้อมเหตุผล → ยืนยัน commit; template .xlsx ดาวน์โหลดได้ | P0 | P8 |
| ค่าเริ่มต้นภาษาไทยพร้อมใช้ | reason master, ประเภทรถ, accessorial, VAT/WHT default, รูปแบบเอกสาร — ใช้ได้ทันทีไม่ต้องตั้ง | P0 | X5 |
| Feature flag ตาม plan + override ต่อ tenant | gate add-on (รถร่วม, ERP connector, optimizer); ตรวจซ้ำใน cron job ด้วย | P0 | P5 |

**A6. Innovera platform admin** — role `super_admin`, `support` (อ่านอย่างเดียว + impersonate มี audit และอีเมลแจ้ง tenant owner ทุกครั้ง), `billing`; บังคับ 2FA + IP allowlist — P0 (impersonate) / P1 (allowlist) — ที่มา: v1, P6

**A7. Audit log** — ทุก create/update/delete ทุก entity: ใคร อะไร diff jsonb เวลา IP เหตุผล (override); อ่านได้จากหน้า entity และหน้ารวม; เก็บ 5 ปี; append-only — P0 — ที่มา: v1

## B. Master data

สรุป: แยก Carrier (รถร่วม) ออกจาก Driver, คนขับมี 3 ประเภทที่กำหนดวิธีจ่าย, rate card มี 2 ฝั่งโครงเดียวกัน key `(ต้นทาง, ปลายทาง, ประเภทรถ)` และทุกราคาถูก snapshot ลงเอกสาร

ทุก master มี: ค้นหา/กรอง, สร้าง/แก้/ปิดใช้ (ไม่ลบถ้ามีเอกสารอ้างถึง), import Excel dry-run, export, `externalId` ต่อ connector, ประวัติการแก้ — P0 ทั้งหมดเว้นที่ระบุ

| Master | ฟิลด์หลัก | ฟังก์ชันเฉพาะ | P | ที่มา |
|---|---|---|---|---|
| ลูกค้า (customer) | ชื่อ, เลขผู้เสียภาษี 13 หลัก, **รหัสสาขา 5 หลัก**, ที่อยู่ออกใบกำกับ, ที่อยู่ส่ง (หลายจุด), ผู้ติดต่อ, เครดิตวัน, รอบวางบิล, "ออกบิลในนาม" (นิติบุคคลเรา), สถานะจด VAT ของลูกค้า, รับ e-Tax ได้ไหม, **POD checklist config**, free time ค่ารอ, `externalId` ต่อ connector | ตรวจเลข 13 หลัก; ตรวจ e-Tax readiness ผ่าน RD `checkRegstration` (P1); merge ลูกค้าซ้ำ (P1) | P0 | v1, E2, E10, thai-tax 2.4 |
| **Carrier (รถร่วม/ผู้รับเหมา)** | ชื่อ, บุคคล/นิติบุคคล, เลขผู้เสียภาษี/บัตรประชาชน, สาขา, ที่อยู่, บัญชีธนาคาร, **อัตรา WHT (default 1%)**, เงื่อนไขจ่าย, parent carrier, ผู้ติดต่อ LINE/เบอร์, "จ้างในนาม", คะแนนประเมิน, เพดานเที่ยว/วัน, priority | entity แยกจาก Driver; รถและคนขับในสังกัดอ้างถึง carrier; ประเมินประสิทธิภาพ (P1) | P0 | M1, I9, PL5 |
| รถ (vehicle) | ทะเบียน, จังหวัด, ประเภท, น้ำหนัก/ปริมาตร, **ownership = OWN / SUBCONTRACT** (+carrierId), GPS (ค่าย+รหัส), สถานะ, **capability tags** (ห้องเย็น, ติดเครน, ลากตู้) — ฟิลด์ขยาย (เลขตัวถัง/เครื่อง, ยี่ห้อ/รุ่น/ปี, เลขไมล์, หัวลาก–หาง, ต้นทุนซื้อ/ค่าเสื่อม) และเอกสารรถทุกประเภท **ย้ายไปอยู่ที่โมดูล B2 Fleet** | นับรถ active สำหรับ tier; การเตือนเอกสารใกล้หมด, PM, ใบสั่งซ่อม, น้ำมัน, ต้นทุนต่อคัน → ดู B2 | P0 | v1, M1, M6, decision 2026-11-04 |
| คนขับ (driver) | ชื่อ, เบอร์, บัตรประชาชน (เข้ารหัส), ใบขับขี่+ประเภท+วันหมดอายุ, **ประเภท = EMPLOYEE_SALARY / EMPLOYEE_PER_TRIP / SUBCONTRACT** (+carrierId), รถประจำ, สถานะ | ประเภทกำหนดวิธีคิดค่าเที่ยวและเอกสารจ่าย; ตรวจใบขับขี่ตรงประเภทรถตอน assign; เตือนหมดอายุ | P0 | M2 |
| จุดส่ง / สถานที่ (location) | ชื่อ, ที่อยู่, พิกัด, **geofence radius**, เวลาเปิด-ปิด, **ประเภทรถที่เข้าได้**, service time เฉลี่ย, ผู้ติดต่อ, หมายเหตุ, alias หลายตัว | geocode อัตโนมัติ + คนยืนยัน; จุด geocode ไม่ได้ขึ้นใบค้าง | P0 | v1, E4, M6 |
| เส้นทาง (route / OD pair) | ต้นทาง, ปลายทาง, ระยะทาง, เวลามาตรฐาน, ค่าผ่านทาง | key สำหรับ rate card และจับคู่ order | P0 | v1 |
| **Rate card ขาขาย** (ต่อลูกค้า) | key `(ต้นทาง, ปลายทาง, ประเภทรถ)`, สูตรราคา (ดูตาราง B1), **วันเริ่ม-หมดอายุ**, สถานะ DRAFT → PENDING_APPROVAL → ACTIVE → EXPIRED, additional stop charge, fuel surcharge index | ซ้อนช่วงเวลาไม่ได้; เตือน NEAR_EXPIRY 30 วัน; แก้ในฟอร์มหรือ Excel import; **อนุมัติก่อนใช้** (P1 — P0 ใช้ ACTIVE ทันทีโดย Admin) | P0 | M3 |
| **Rate card ขาซื้อ** (ต่อ Carrier) | โครงเดียวกับขาขาย + "ราคา 5 ครั้งล่าสุดที่จ้างรายนี้" | ใช้คำนวณ cost line และ settlement | P0 | M3, PL4 |
| **Accessorial catalog** (ค่าใช้จ่ายเพิ่ม) | รหัส, ชื่อ, ราคา default, หน่วย, **vat_treatment** (EXEMPT_TRANSPORT / VAT_7), **wht_rate** (1% / 3%), ฝั่ง (ขาย/ซื้อ/ทั้งคู่), map กับรหัสสินค้า/บริการ ERP | ราคาถูก **copy ลง order เป็น snapshot**; แก้ catalog แล้วเอกสารเก่าไม่เปลี่ยน | P0 | M5, thai-tax 1.8, 3.1 |
| **Reason master** | หมวด: ค้างวางแผน / ส่งไม่สำเร็จ / ปฏิเสธรับบางส่วน / ไม่เซ็นเอกสาร / ล่าช้า / dispute; ต่อ reason: บังคับรูป, บังคับโน้ต, **auto-reschedule**, แสดงบน tracking page | ชุดเริ่มต้นภาษาไทย; snapshot ข้อความลงงาน (แก้ master ไม่ย้อนแก้งานเก่า) | P0 | M7, PL7 |
| สินค้า / หน่วย | รหัส, ชื่อ, หน่วย, น้ำหนัก/ปริมาตร, อุณหภูมิ, สินค้าอันตราย, `externalId` | คำนวณ load และ compatibility | P0 | v1 |
| คลัง / ต้นทาง | ชื่อ, ที่อยู่, พิกัด, ช่องโหลด, เวลาทำการ | time slot (P2) | P0 | v1 |
| **Vehicle-type compatibility** | matrix ประเภทรถ × ประเภทงาน/สินค้า/จุดส่ง (เช่น ห้องเย็นเท่านั้น, ห้าม 10 ล้อเข้าซอย) | constraint ตอน assign — เตือน + override พร้อมเหตุผล | P0 | M6 |
| ผังรหัส ERP (master code) | ค่าที่ connector ยอมรับ: หน่วย, พนักงานขาย, ผังบัญชี, รหัสสินค้า/บริการ, อัตรา VAT — **sync ลงมาจาก ERP** ไม่คีย์ซ้ำ | validate ก่อน push; หน้า mapping ต้องครบก่อน export | P0 (KRS) | v1, I4 |

**B1. สูตรราคา (ใช้ทั้งขาขายและขาซื้อ)**

| สูตร | พารามิเตอร์ | ตัวอย่างไทย | P | ที่มา |
|---|---|---|---|---|
| เหมาเที่ยว (FLAT_TRIP) | ราคาต่อเที่ยวตาม OD × ประเภทรถ | กรุงเทพ→ชลบุรี 6 ล้อ 4,500 | P0 | M4 |
| ตามระยะทาง (PER_DISTANCE) | บาท/กม. + ขั้นต่ำ, ระยะจาก route master หรือ GPS | 18 บาท/กม. ขั้นต่ำ 1,500 | P0 | M4 |
| ตามน้ำหนัก/ปริมาตร (PER_UNIT) | บาท/ตัน หรือ /คิว หรือ /ชิ้น + ขั้นต่ำ | 350 บาท/ตัน | P0 | M4 |
| เหมาวัน (PER_DAY) | ค่ารถ/วัน + กม. เกิน + ชม. เกิน | "12 ชม. 1 วัน" 3,500 + 12/กม. | P1 | M4 (Shipsy) |
| **เกิน N จุดคิดเพิ่มต่อจุด** | additional_stop_charge หลังจุดที่ N | จุดที่ 4 ขึ้นไป +300/จุด | P0 | M4 (NOSTRA) |
| **Fuel surcharge** | ตารางราคาน้ำมันอ้างอิง × % หรือบาท/กม. มีผลตามช่วงเวลา | ดีเซล > 32 บาท +5% | P1 | M4 |
| สถานะคำนวณ | ทุก order มี `pricingStatus`: AVAILABLE / RATE_MISSING / CALCULATION_FAILURE + breakdown ต่อพารามิเตอร์ | — | P0 | M4 (Locus) |

## B2. Fleet — จัดการรถ

สรุป: รถเป็น asset ที่มีต้นทุนของตัวเอง ไม่ใช่แค่ master ที่ trip อ้างถึง — ทะเบียนรถขยายเป็นโปรไฟล์ครบ, เอกสารรถทุกประเภทมีวันหมดอายุและเตือนล่วงหน้า, งานซ่อมเดินผ่านใบสั่งซ่อม (WO) ที่เปิดได้จาก PM / แจ้งเสีย / อุบัติเหตุ, น้ำมันและค่าใช้จ่ายเดินรถถูกบันทึกต่อคัน และ **ทุกบาทที่เกิดกับรถไหลลง `vehicle_cost` ledger เดียว** เพื่อให้กำไรต่อคันในรายงาน H เท่ากับยอดในเอกสารเสมอ รถร่วม (`SUBCONTRACT`) ใช้โมดูลนี้แบบย่อเฉพาะเอกสารบังคับก่อนรับงาน

**B2.1 ฟังก์ชัน**

| ส่วน | ข้อมูล / ฟังก์ชัน | P | ที่มา |
|---|---|---|---|
| 1. ทะเบียนรถขยาย | เลขตัวถัง / เลขเครื่อง, ยี่ห้อ / รุ่น / ปี, สี, น้ำหนักเปล่า / น้ำหนักบรรทุก, ชนิดเชื้อเพลิง, ความจุถัง (ลิตร), **เลขไมล์ปัจจุบัน** (อัปเดตอัตโนมัติจาก DO ที่ปิด / GPS), **หัวลาก–หาง จับคู่** (trailer ผูกกับหัวลากประจำ เปลี่ยนได้ต่อ trip), สถานะ **พร้อม / ซ่อม / จอด / ปลดระวาง**, ต้นทุนซื้อ / วันซื้อ / วิธีคิดค่าเสื่อม (เส้นตรง N ปี → ค่าเสื่อม/เดือนลง `vehicle_cost`), รูปรถ + เอกสารแนบ | P0 | decision 2026-11-04, M1 |
| 2. เอกสารและต่ออายุ | ประเภทเอกสาร: **ประกันภัย** (บริษัท, เลขกรมธรรม์, ชั้น, ทุนประกัน, เบี้ย, วันเริ่ม–หมด), **พ.ร.บ.**, **ภาษีประจำปี**, **ตรวจสภาพ ตรอ.**, ใบอนุญาตประกอบการขนส่ง, ใบรับรอง GPS DLT, ใบขับขี่ (อ้างจาก driver); แนบไฟล์ต่อฉบับ; **เตือน 60 / 30 / 7 วัน** ก่อนหมด (in-app + อีเมล + LINE ตาม I); ประวัติการต่อทุกครั้ง (ฉบับเก่าไม่ลบ); ค่าใช้จ่ายต่ออายุ → `vehicle_cost` category `DOCUMENT` | P0 | decision 2026-11-04, v1, I |
| 3. PM ตามแผน | แผนบำรุงรักษาต่อประเภทรถ (เช่น เปลี่ยนน้ำมันเครื่องทุก 10,000 กม. หรือ 6 เดือน — ใช้เงื่อนไขไหนถึงก่อน); คำนวณวันครบกำหนดจาก **เลขไมล์จริง** + อัตรา กม./วัน เฉลี่ย; เตือนล่วงหน้า (ตั้ง N กม. / N วัน); **ปฏิทิน PM** รายเดือน; เตือนบน planning board เป็น badge "ครบ PM" **ไม่บล็อก** การจัดงาน (override พร้อมเหตุผล) | P1 | decision 2026-11-04 |
| 4. ใบสั่งซ่อม (Work Order) | เปิดจาก: PM ครบกำหนด / **แจ้งเสียโดยคนขับ** (ผ่าน Driver app หรือลิงก์ + รูป) / อุบัติเหตุ (ส่วน 8); ฟิลด์: อาการ, **อู่ภายใน / อู่ภายนอก** (vendor), วันเข้า–วันออก (คาด/จริง), รายการงาน + อะไหล่ + ค่าแรง ต่อบรรทัด, เลขไมล์ ณ วันซ่อม, **ผู้อนุมัติ + วงเงิน** (เกินวงเงิน → approver), สถานะ **แจ้ง → อนุมัติ → กำลังซ่อม → เสร็จ → ปิด** (+ ปฏิเสธ / ยกเลิก), แนบใบเสร็จอู่; รถเปลี่ยนสถานะเป็น "ซ่อม" อัตโนมัติเมื่อ IN_PROGRESS และกลับ "พร้อม" เมื่อปิด; ค่าซ่อมรวม → `vehicle_cost` category `REPAIR`; **ถ้าอู่ภายนอกวางบิล → สร้างรายการ AP** (เส้นทางเดียวกับ F6/F7 ไม่จ่ายซ้ำ) | P1 | decision 2026-11-04 |
| 5. อะไหล่และสต็อก | ทะเบียนอะไหล่ (รหัส, ชื่อ, หน่วย, ราคาล่าสุด, min stock), รับเข้า / เบิกออกผูก WO, **ประวัติเปลี่ยนอะไหล่ต่อคัน** (เช่น ยาง 4 เส้น ตำแหน่ง + กม. ที่วิ่งได้), เตือนต่ำกว่า min stock | P2 (บันทึกรายการอะไหล่เป็นบรรทัดใน WO = P1) | decision 2026-11-04 |
| 6. น้ำมันและค่าใช้จ่ายเดินรถ | บันทึกเติมน้ำมัน (ลิตร, บาท, ปั๊ม, เลขไมล์, รูปใบเสร็จ) ด้วยมือ / จาก Driver app / **import CSV บัตรฟลีท**; คำนวณ **กม./ลิตร ต่อคัน และต่อคนขับ**; เตือนผิดปกติเมื่อเบี่ยงจากค่าเฉลี่ยคันนั้นเกิน X %; ค่าทางด่วน / ค่าปรับ / ค่าจอด ต่อคันต่อเที่ยว; **เชื่อมกับเงินเบิกคนขับ** (F7 cash advance — เคลียร์บิลน้ำมัน = fuel_log + vehicle_cost ในขั้นเดียว); GPS fuel sensor = P2 | P1 | decision 2026-11-04, F7, B7 |
| 7. ประวัติและต้นทุนต่อคัน | หน้าโปรไฟล์รถแสดง **timeline ทุกเหตุการณ์** (เที่ยว, เติมน้ำมัน, ซ่อม, ต่อเอกสาร, อุบัติเหตุ, เปลี่ยนสถานะ); **ต้นทุนรวมต่อคัน/เดือน** = น้ำมัน + ซ่อม + เอกสาร + ค่าเสื่อม (+ ค่าเที่ยวคนขับที่ปันมา) เทียบรายได้ที่ปันลงรถจาก invoice line → **กำไร/คัน**; utilization % (วันที่มี trip ÷ วันพร้อมใช้); รายงาน "รถควรปลดระวาง" (ค่าซ่อม/กม. สูงกว่าเกณฑ์ + อายุ) | P1 | decision 2026-11-04, R1, X3 |
| 8. อุบัติเหตุ / เคลม | บันทึกเหตุ (วัน-เวลา, สถานที่, คนขับ, trip ที่เกี่ยว), รูป, คู่กรณี, เลขเคลม, สถานะเคลม (แจ้ง / รอประกัน / อนุมัติ / จ่ายแล้ว / ปฏิเสธ), ค่าเสียหายประเมิน vs ประกันจ่าย vs เราจ่ายเอง; **ผูกกับ WO** (ซ่อมจากเหตุนี้) และกรมธรรม์ประกันในส่วน 2; ส่วนที่เราจ่ายเอง → `vehicle_cost` category `INCIDENT` | P1 | decision 2026-11-04 |
| 9. DVIR ตรวจก่อนออกรถ | checklist ใน Driver app ก่อนเริ่มเที่ยว (ยาง, ไฟ, เบรก, น้ำมันเครื่อง, เอกสารในรถ) พร้อมรูป; พบปัญหา → **เปิด WO อัตโนมัติ** สถานะ REPORTED + แจ้ง dispatcher | P2 | decision 2026-11-04, E1 |
| รถร่วม (`SUBCONTRACT`) | ใช้แบบย่อเฉพาะส่วน 1–2: **เอกสารบังคับก่อนรับงาน** (ประกันภัย, พ.ร.บ., ใบขับขี่คนขับ) — หมดอายุ → เตือนบน planning board และบล็อก assign จนกว่าจะอัปเดต (override โดย admin พร้อมเหตุผล); carrier อัปโหลดเอกสารเองผ่านลิงก์ LINE ได้; **ไม่มี** PM / WO / อะไหล่ / น้ำมัน สำหรับรถร่วม | P0 | decision 2026-11-04, PL4 |

**B2.2 หน้าจอ**

| หน้าจอ | เนื้อหา | P | ที่มา |
|---|---|---|---|
| ทะเบียนรถ / โปรไฟล์รถ | ตารางรถ: tab สถานะ (พร้อม / ซ่อม / จอด / ปลดระวาง) พร้อมตัวนับ, คอลัมน์เอกสารใกล้หมด (badge), PM ถัดไป, กม./ลิตร; โปรไฟล์: ข้อมูลรถ, เอกสาร, timeline, ต้นทุน/กำไร 12 เดือน, WO ที่เปิดอยู่ | P0 (ตาราง+โปรไฟล์พื้นฐาน) / P1 (timeline, ต้นทุน) | decision 2026-11-04 |
| ใบสั่งซ่อม (WO) | คิวตามสถานะ แจ้ง / รออนุมัติ / กำลังซ่อม / เสร็จ / ปิด; ฟอร์ม WO + บรรทัดงาน/อะไหล่/ค่าแรง; อนุมัติในหน้า (step-up 2FA เกินวงเงิน) | P1 | decision 2026-11-04 |
| ปฏิทินซ่อมบำรุง | ปฏิทินรายเดือน: PM ครบกำหนด, WO ที่นัดอู่, รถที่จอดซ่อม → ใช้ประกอบตารางรถ/คนขับรายวันใน D2 | P1 | decision 2026-11-04 |
| น้ำมันและค่าใช้จ่าย | บันทึก/import เติมน้ำมัน, กราฟ กม./ลิตร ต่อคัน, รายการผิดปกติ, ค่าทางด่วน/ค่าปรับ/ค่าจอด; กรองคัน/คนขับ/ช่วงวัน | P1 | decision 2026-11-04 |
| เอกสารรถรวม | ตารางเอกสารทุกคัน × ทุกประเภท เรียงตามวันหมด, filter "หมดใน 30/60 วัน", อัปโหลดต่ออายุจากหน้าเดียว, export | P0 | decision 2026-11-04 |

**B2.3 ผลกระทบต่อโมดูลอื่น**

| โมดูล | ผลกระทบ | P | ที่มา |
|---|---|---|---|
| D Planning & Dispatch | การ์ดรถบน planning board แสดง badge: เอกสารหมด / ใกล้หมด, ครบ PM, อยู่ในสถานะซ่อม; ทั้งหมด **เตือนไม่บล็อก** (override + เหตุผล) ยกเว้นรถร่วมที่เอกสารบังคับหมดอายุ; รถสถานะ "ซ่อม"/"จอด" ไม่ขึ้นใน filter รถว่าง | P0 (เอกสาร) / P1 (PM, ซ่อม) | decision 2026-11-04, D2 |
| F Settlement / เบิกเงิน | เงินเบิกค่าน้ำมันที่คนขับเคลียร์บิล (F7) สร้าง `fuel_log` + `vehicle_cost` อัตโนมัติ ไม่ต้องคีย์ซ้ำ; ค่าซ่อมที่อู่ภายนอกวางบิลเดินเส้นทาง AP เดียว (ไม่จ่ายซ้ำ); `trip_cost.cost_type = FUEL/REPAIR` อ้าง `vehicle_cost` เดียวกันเมื่อปันลง trip | P1 | decision 2026-11-04, F7, K11 |
| H Reports | **ต้นทุน/กำไรต่อคัน ต้องคำนวณจาก `vehicle_cost` ledger เดียว** (น้ำมัน + ซ่อม + เอกสาร + ค่าเสื่อม + อุบัติเหตุ) ร่วมกับ invoice line / cost line ที่ปันลงรถ — ไม่คำนวณแยกจากหน้าโปรไฟล์รถ; รายงานใหม่: เอกสารใกล้หมด, PM ค้าง, กม./ลิตร, รถควรปลดระวาง | P1 | decision 2026-11-04, X3 |
| E Execution / Driver app | แจ้งเสีย (E2 M6) + DVIR (E2 M7) + บันทึกเติมน้ำมัน (E2 M8) เป็น action ในแอป/ลิงก์คนขับ ใช้ event model เดียวกับ E1 (offline ได้) | P1 / P2 (DVIR) | decision 2026-11-04, E1, E2 |
| G Open API | resource `vehicles` เพิ่ม sub-resource `/documents`, `/work-orders`, `/fuel-logs`, `/costs`; webhook `vehicle.document_expiring`, `work_order.status_changed` | P1 | decision 2026-11-04, benchmark 10 |

## C. Order intake

สรุป: order ทุกใบเข้าทางเดียวกันผ่าน domain service เดียว (UI/Excel/API/connector ล้วนเรียก `upsertOrder`) โดยใช้ `(source, externalId)` เป็น key idempotent และงานที่ยังจัดไม่ได้ต้องมี reason code เสมอ

| ฟังก์ชัน | รายละเอียด | P | ที่มา |
|---|---|---|---|
| **Upsert ด้วย external id** | `PUT /orders/external/{externalId}` idempotent: สร้างถ้าไม่มี, อัปเดตถ้ามี; กฎ field ที่แก้ไม่ได้หลัง `in_transit` → 409 | P0 | O1 |
| **Source ของ order** | enum MANUAL / EXCEL / API / PORTAL / ERP:{connector} + `externalRef`; แสดง badge บนทุกหน้า | P0 | O2 |
| กรอกมือ | ฟอร์มเดียว, duplicate จาก order เดิม, template งานประจำ | P0 | v1, X4 |
| Import Excel | template + dry-run + รายงานแถวผิด (ใช้กลไก A5) | P0 | v1, P8 |
| รับจาก ERP connector | KRS adapter เรียก upsert เดียวกับ API (ไม่มีทางลัด) ทุกใบเข้าระบบเสมอ | P0 | v1, I1 |
| รับจาก Open API | `POST /orders` + Idempotency-Key (ดู G1) | P0 | benchmark 9.3 |
| รับจาก customer portal | ลูกค้าสร้าง/duplicate งาน, ค้นด้วยเลข PO ตัวเอง, ดู POD/ใบแจ้งหนี้ | P2 | O3 |
| จับคู่อัตโนมัติ | ลูกค้า (externalId → customer), ต้นทาง/ปลายทาง (ข้อความ → location ด้วย alias + fuzzy), rate card → `pricingStatus` | P0 | v1 |
| เรียนรู้ alias | map ครั้งเดียว จำเป็น alias ของ location/customer | P0 | v1 |
| **หน้าใบค้าง + reason code ครบชุด** | `CUSTOMER_UNMAPPED`, `LOCATION_UNMAPPED`, `GEOCODING_ERROR`, `RATE_MISSING`, `UNALLOCATED_NO_VEHICLE`, `CAPACITY_EXCEEDED`, `VEHICLE_TYPE_INCOMPATIBLE`, `CARRIER_REJECTED`, `DELIVERY_WINDOW_EXHAUSTED`, `RESCHEDULES_EXHAUSTED`, `SOURCE_CHANGED_AFTER_PLAN`, `SOURCE_ERROR` — แสดงเป็น badge บน pool พร้อม action เคลียร์ | P0 | v1, PL7 |
| **Edit lock** | เปิดแก้ → ป้าย "กำลังแก้ไขโดย …" คนอื่น read-only; หมดอายุ 10 นาทีไม่ activity; permission `orders.unlock` ปลดของคนอื่น | P0 | O4 |
| แยก / รวม order | แยกเป็นหลาย leg (หลาย trip), รวมหลาย order ลูกค้าเดียวใน trip เดียว | P0 | v1, PL1 |
| ยกเลิก / คืนสถานะ | พร้อม reason; order ที่มี trip แล้วต้องถอดจาก trip ก่อน; ERP แก้หลังวางแผน → ใบค้าง `SOURCE_CHANGED_AFTER_PLAN` ไม่ทับอัตโนมัติ | P0 | v1 |
| งานประจำ (recurring) | สร้างล่วงหน้ารายวัน/สัปดาห์ จาก template | P1 | v1 |
| Custom fields | 3–5 ช่องต่อ tenant (เลข PO, เลขตู้, อ้างอิงลูกค้า) แสดงบนเอกสาร | P1 | O3, E8 |

## D. Planning & Dispatch

สรุป: โมเดลหลักคือ Order (DO) ↔ Trip (ใบคุมรถ) ↔ TripStop โดย trip เก็บ snapshot รถ/คนขับ/carrier ต่อเที่ยว, planning board รวมรถบริษัทและรถร่วมในจอเดียว และการจ่ายงานรถร่วมทำผ่านลิงก์ LINE ไม่ต้องมี account

**D1. โมเดลข้อมูล**

| Entity | รายละเอียด | P | ที่มา |
|---|---|---|---|
| Order (DO) | 1 order = 1 งานส่งของลูกค้า มี stops (pickup/delivery) และ items; มี revenue line ตั้งแต่สร้าง | P0 | PL1, B1 |
| Trip (ใบคุมรถ) | รวมหลาย order/leg; เก็บ `vehicleId`, `driverId`, `secondaryDriverId`, `trailerId`, `carrierId` **เป็น snapshot ต่อเที่ยว** (ไม่อ้าง mainDriver ของรถ); มี cost line ตั้งแต่สร้าง | P0 | PL1, X12 |
| TripStop | ลำดับ, ประเภท, location, planned window, `arrivedAt`, `departedAt`, สถานะ, orders ที่ลง/ขึ้นที่จุดนี้ | P0 | PL1 |
| Leg | order แตกเป็นหลาย leg (เช่น ส่งผ่าน hub, เปลี่ยนรถ) แต่ละ leg อยู่ใน trip ต่างกันได้ | P1 | PL1 (Alvys split) |
| สถานะ trip | คำนวณจาก stops: PLANNED → ASSIGNED → DISPATCHED → IN_TRANSIT → COMPLETED; ยกเลิก trip ยกเลิก order ที่ยังไม่ส่งตามไป | P0 | PL1 |
| Parent/child trip (รถร่วม) | จ้างรถร่วม = สร้าง child trip ผูก carrier; ลูกค้าเห็นแค่ parent; POD/สถานะจาก child sync ขึ้น parent; cost อยู่ที่ child | P1 | PL6 |

**D2. Planning board**

| ฟังก์ชัน | รายละเอียด | P | ที่มา |
|---|---|---|---|
| จอ split: pool ซ้าย / scheduler ขวา | ซ้าย = order ค้างจัด (กรอง/group/sort, badge reason code) ขวา = timeline รถหรือคนขับ × วัน ลากวาง ปรับขนาดได้ | P0 | PL2 |
| View | ตามรถ / ตามคนขับ / ตาม carrier / **"รถบริษัท + รถร่วม" (default)**; ปรับ field บนการ์ดงาน | P0 | PL2 |
| Saved views + filter badges | บันทึก filter ชุดเป็นชื่อ แชร์ในทีม; filter ที่ใช้อยู่แสดงเป็น badge ลบได้ | P1 | PL2 |
| **Filter รถที่รับได้สองทาง** | คลิก order → รถ/คนขับที่ผ่าน constraint ถูกเน้น ที่เหลือจาง; คลิกรถ → order ที่รับได้ถูกเน้น | P0 | PL3 |
| "ว่างเมื่อไหร่/ที่ไหน" | availability = เวลาส่งจุดสุดท้าย + dwell เฉลี่ย; แสดง "ว่างใน 2 ชม. ที่ชลบุรี" | P1 | PL3 |
| ตรวจ constraint ตอนจัด | น้ำหนัก/ปริมาตร, vehicle-type compatibility, ใบขับขี่, เอกสารรถหมดอายุ, ชั่วโมงขับ, จุดส่งไม่รับประเภทรถ — **เตือน + override พร้อมเหตุผล** ไม่บล็อก | P0 | v1, M6 |
| **เวลาขัดกันขึ้นแดงไม่บล็อก** | trip ซ้อนเวลาบนรถเดียวแสดงสีแดง ยังบันทึกได้ | P0 | PL8 |
| Multi-drop | เรียงลำดับ stop ด้วยมือ, คำนวณระยะ/เวลารวม, กันลำดับผิด (ส่งก่อนรับ) | P0 | v1 |
| **Assign vs Dispatch แยกปุ่ม** | Assign = ผูกรถ/คนขับ (ASSIGNED); Assign & dispatch = ส่งงานทันที (DISPATCHED); bulk actions | P0 | PL9 |
| **Send all** | checkbox ส่งงานทั้งวันของทุกรถทีเดียว; ปฏิทินขึ้นเขียวเมื่อส่งครบ | P0 | PL8 |
| Priority 4 ระดับ | สีพื้นแถวตาม priority ของ order | P1 | PL3 (Alvys) |
| เสนอรถอัตโนมัติ (rule-based) | เรียงรถตาม ว่าง/ประเภท/ใกล้ต้นทาง/ต้นทุน ให้คนเลือก (ไม่ใช่ optimizer) | P1 | v1, PL3 |
| VRP / optimizer | เรียก engine ภายนอกผ่าน interface | P2 | v1 |
| ตารางรถ/คนขับรายวัน | ภาระงาน, ว่าง, ซ่อม, ลา (คลิกขวาใส่วันลา/โน้ต) | P0 | v1, PL2 |
| ใบงานประจำวัน | PDF/LINE ใบคุมรถให้คนขับ (ก่อน/แทน app) | P0 | v1 |

**D3. จ่ายงานรถร่วม (subcontract)**

| ฟังก์ชัน | รายละเอียด | P | ที่มา |
|---|---|---|---|
| เลือก carrier + ราคาซื้อ | แสดง rate card ขาซื้อ + ราคา 5 ครั้งล่าสุดที่จ้างรายนี้; ใส่ cost; preview ใบสั่งงาน | P0 | PL4 |
| **ส่งลิงก์ LINE/SMS ไม่ต้อง login** | ลิงก์อายุ 48 ชม.; carrier กด **รับ + ใส่ทะเบียนรถ + ชื่อ/เบอร์คนขับ** หรือ **ปฏิเสธ + เหตุผล**; ซ่อนราคาขาย/ที่อยู่ลูกค้าได้ (preliminary) | P0 | PL4 |
| หมดเวลา → แจ้ง dispatcher | ไม่ตอบใน N ชม. → แจ้งเตือน + ปุ่มส่งรายถัดไป | P0 | PL4 |
| **Cascade P1 → P2** | ลำดับ carrier ต่อ OD/ประเภทรถ (priority คงที่ หรือ "ถูกสุดก่อน"); ปฏิเสธ/หมดเวลา → ส่งรายถัดไปอัตโนมัติ; เพดานเที่ยว/วัน ต่อ carrier | P1 | PL5 |
| **บันทึกเหตุผลการเลือก** | ทุกการจ้าง carrier เก็บ `selectionReason` (ถูกสุด / ลำดับ / override โดย … เพราะ …) ตรวจสอบย้อนได้ | P0 | PL5 |
| Margin ต่อ carrier | % margin default + simulator "ขาย 5,000 จ้าง 4,200 = 16%" + badge margin ต่ำกว่าเกณฑ์ | P1 | PL6 |
| เปลี่ยน carrier | ต้องยกเลิก child trip แล้วจ้างใหม่ (ประวัติคงอยู่) | P0 | PL6 |

**D4. ปันส่วนต้นทุน/รายได้**

| ฟังก์ชัน | รายละเอียด | P | ที่มา |
|---|---|---|---|
| แบ่ง cost ของ trip ลง order | ตามน้ำหนัก / ระยะ / จำนวนจุด / เท่ากัน (เลือกต่อ tenant) | P1 | PL10 |
| แบ่ง revenue ของ order ลง leg | % ต่อ leg เช่น รับ 25 / ขนส่งหลัก 50 / ส่ง 25 | P1 | PL10 |
| Margin ตามสัดส่วน km | trip รถร่วมที่รวมหลาย order แบ่ง margin ตาม km | P2 | PL6 |

## E. Execution & POD

สรุป: ทุกการเปลี่ยนสถานะเป็น event ที่ idempotent ด้วย `clientEventId` + `occurredAt` จากเครื่อง (รองรับ offline ตั้งแต่ schema), POD เป็น checklist ที่ตั้งต่อลูกค้าได้ และรถร่วมที่ไม่มีแอปทำ POD ผ่านลิงก์ได้

**E1. Event model และ offline-first spec**

| ข้อกำหนด | รายละเอียด | P | ที่มา |
|---|---|---|---|
| Stop event | `arrive`, `depart`, `complete` (outcome delivered / partial / failed / undelivered_retain), `fail`; ทุก event มี `clientEventId` (UUIDv4), `occurredAt` (เวลาเครื่อง), `receivedAt` (server), GPS, accuracy, แหล่ง (app/web/link/api) | P0 | E1 |
| Idempotent server | unique `(tenantId, clientEventId)`; ซ้ำ → คืนผลเดิม; event มาสลับลำดับ → เรียงด้วย `occurredAt` และ validate state machine; ขัดแย้ง → เก็บทั้งคู่ + flag ให้ dispatcher ตัดสิน | P0 | E1 |
| Outbox บนอุปกรณ์ | app เก็บ event + ไฟล์ใน local queue, ส่งเมื่อออนไลน์ตามลำดับ, แสดง "รอส่ง N รายการ"; รูปบีบอัดก่อน; retry backoff | P1 | E1 |
| Offline เป็น setting ระดับ tenant | เปิด/ปิดได้ มีผล session ถัดไป | P1 | E1 (Onfleet) |
| GPS adaptive | ส่งพิกัดถี่ขึ้นเมื่อใกล้จุด ห่างลดความถี่ ประหยัดแบต | P1 | X8 |

**E2. การบันทึกสถานะและ POD**

| ฟังก์ชัน | รายละเอียด | P | ที่มา |
|---|---|---|---|
| อัปเดตสถานะผ่านเว็บ | admin/หน้าคลังบันทึก arrive/depart/complete แทนคนขับ พร้อมเวลาและผู้บันทึก | P0 | v1 |
| **POD checklist config ต่อลูกค้า** | ชนิด field: PHOTO / SIGNATURE / NOTE / BARCODE / BOOLEAN / SINGLE_CHOICE / PIN / RATING; แต่ละตัวตั้ง Disabled / Enabled / **Required**; แยกชุดสำหรับสำเร็จ vs ไม่สำเร็จ; default ของ tenant + override ต่อลูกค้า | P0 | E2 |
| ePOD ผ่านเว็บ | อัปโหลดรูป/ลายเซ็น/ไฟล์, น้ำหนักชั่ง, เลขอ้างอิงลูกค้า, ผู้รับ + ความสัมพันธ์ | P0 | v1 |
| **ePOD ผ่านลิงก์ (รถร่วม/คนขับไม่มีแอป)** | ลิงก์ต่อ trip จาก LINE: ค้นด้วยเลข DO → กดถึง/ออก → อัปโหลดรูป (≤ 5 ไฟล์/stop) → ลายเซ็นบนจอ → ปิดงาน; ใช้ event model เดียวกัน | P0 | E6 |
| **Actual quantity + reject reason ต่อรายการ** | ต่อ item: planned vs delivered vs rejected + reason (จาก reason master หมวด "ปฏิเสธรับ"); วางบิลตามยอดส่งจริงได้ (ตั้งต่อลูกค้า) | P0 | E3 |
| ตีกลับบางส่วน/ทั้งหมด | จาก actual qty → สร้างงานส่งซ้ำหรือคืนคลัง | P0 | v1, E3 |
| **Undelivered-retain + auto-reschedule** | outcome "ส่งไม่สำเร็จ ของยังอยู่บนรถ"; reason ที่ติ๊ก auto-reschedule → สร้าง stop ใหม่วันถัดไปอัตโนมัติ; นับครั้ง → `RESCHEDULES_EXHAUSTED` | P0 | E7, M7 |
| **Geofence เตือนไม่บล็อก** | กดถึง/ปิดงานนอกรัศมี → เตือน "ห่างจุด 1.2 กม." + บังคับเลือกเหตุผล; บันทึก distance ลง event; รายงาน POD นอกพื้นที่ | P1 | E4 |
| บันทึกเหตุล่าช้า / ค่าใช้จ่ายหน้างาน | รอคิว ค้างคืน ทางด่วน ยกของ → accessorial line (ขาย/ซื้อ) พร้อมรูปใบเสร็จ | P0 | v1 |
| **Detention อัตโนมัติ** | `departedAt − arrivedAt − freeTime(ลูกค้า)` > 0 → เสนอ accessorial "ค่ารอ" อัตโนมัติ ให้ Invoicer ยืนยัน | P1 | E10 |
| หลายคนขับต่อเที่ยว + เลขตู้ | `secondaryDriverId`, `containerNo` บน trip/order | P1 | E8 |
| **Tracking link สาธารณะ** | ลิงก์มีแบรนด์ tenant; ผู้รับกรอกเลข DO/PO → เห็นสถานะ stepper, ETA, POD (ถ้าเปิด); ไม่เผยราคา | P0 | E9 |
| แจ้งลูกค้าปลายทาง | SMS/LINE/อีเมลเมื่อออกรถ/ใกล้ถึง พร้อม tracking link | P1 | v1, E9 |
| Driver app (ePOD, offline-first) | สเปกเต็มอยู่ที่ **E2** (10 จอ M1–M10 + ข้อกำหนดเทคนิค); flow หลัก: งานวันนี้ → ออกเดินทาง → ถึงจุด → POD → ปิด; ปุ่มใหญ่ ไทยล้วน; usability test กับคนขับจริงก่อนปล่อย; **M10 ลิงก์รถร่วม (web ไม่ต้อง login) = P0** ใช้ตั้งแต่เฟส 0 | P1 (M1–M9, เฟส 2 — ยกจาก P2/เฟส 3) / P0 (M10) / P2 (M7 DVIR) | v1, E1, X9, decision 2026-11-04 |
| **หน้าติดตามรถ (แผนที่)** | แผนที่ + หมุดรถสีตามสถานะ, เส้นทางแผน vs จริง, รายการเที่ยววันนี้ + ETA, timeline สถานะต่อเที่ยว, แจ้งเตือนออกนอกเส้นทาง/จอดนาน; พิกัดจาก GPS connector 1 ค่ายแรก หรือจากแอป/ลิงก์คนขับ; ไม่มีพิกัด = แสดงสถานะล่าสุดจาก event แทน | **P1** (ยกจาก P2 ตามการตัดสินใจ 3 พ.ย. 69) | v1, E5, design 03 หน้า 7 |
| ซ่อมบำรุงรถ (PM) / ใบสั่งซ่อม | ย้ายไปโมดูล **B2 Fleet** (ส่วน 3–4): PM ตามแผน, WO, ค่าซ่อม → `vehicle_cost`; แจ้งเสียจากคนขับผ่านแอป/ลิงก์ | P1 (ยกจาก P2) | v1, decision 2026-11-04 |

## E2. Driver app (ePOD) — มือถือ

สรุป: แอปคนขับเป็น client อีกตัวของ Open API ชุดเดียวกับ web (scope `driver`) มี 10 จอ ออกแบบ **offline-first ทุก action** — กดแล้วเห็นผลทันที (optimistic) แล้วค่อยส่งผ่าน outbox queue, server idempotent ด้วย `clientEventId` ตาม E1; ปุ่มใหญ่ ไทยล้วน ≤ 4 ขั้นต่อ stop (K9); M10 เป็น web ไม่ต้อง login สำหรับรถร่วม จึงเป็น P0 ใช้ได้ตั้งแต่เฟส 0 โดยไม่ต้องมีแอป ส่วนแอป M1–M9 เป็น P1 (เฟส 2 — ยกจาก P2/เฟส 3 เดิม) ยกเว้น M7 DVIR เป็น P2 ตาม B2 ส่วน 9

**E2.1 จอ (10 จอ)**

| จอ | สิ่งที่ทำ | ข้อมูลที่เขียน / อ่าน | P | ที่มา |
|---|---|---|---|---|
| **M1 เข้าสู่ระบบ** | เบอร์โทร + OTP SMS **ไม่มีรหัสผ่าน**; ถ้าเบอร์อยู่หลาย tenant → เลือก tenant; **จำเครื่อง 30 วัน** (ไม่ขอ OTP ซ้ำจนกว่าจะหมดอายุ / ถูกเพิกถอน / เปลี่ยนเครื่อง) | เขียน: `driver_device` (device_id, platform, app_version, push_token, trusted_until); อ่าน: driver + tenant ที่ผูกเบอร์ | P1 | decision 2026-11-04, A1 "Login คนขับ" |
| **M2 งานวันนี้** (หน้าแรก) | หัวจอ: ทะเบียนรถประจำวัน (เปลี่ยนได้ + เหตุผล), สถานะ sync **online / offline + "รอส่ง N รายการ"**; รายการการ์ดงาน: เลข DO, ลูกค้า, route ต้นทาง→ปลายทาง, เวลานัด, จำนวนจุด, น้ำหนัก, badge (ห้องเย็น / ด่วน / รอ POD / geofence); ปุ่ม **เริ่มงาน**; tab ล่าง 4 ปุ่ม **งาน · แจ้งปัญหา · เบิกเงิน · ของฉัน**; ถ้ายังไม่ทำ DVIR วันนี้ → การ์ดบังคับไป M7 ก่อน (เมื่อ tenant เปิด DVIR) | อ่าน: trip + trip_stop + DO ของคนขับวันนี้ (`GET /driver/today`, cache ไว้ใช้ offline); เขียน: trip `vehicle_id` override, outbox status | P1 | decision 2026-11-04, D2 "ใบงานประจำวัน" |
| **M3 รายละเอียดงาน** | stepper จุดแวะเรียงลำดับ (รับ → ส่ง 1 → ส่ง 2 …) จุดปัจจุบันขยาย; ต่อจุด: ปุ่ม **นำทาง** (เปิด Google Maps / แผนที่ในเครื่อง), **โทร** ผู้ติดต่อจุดส่ง, รายการสินค้า + จำนวนแผน; ปุ่มหลักเปลี่ยนตามขั้น **ออกเดินทาง → ถึงจุด → ขึ้นของเสร็จ (จุดรับ) → ส่งของ (จุดส่ง → M4)**; กดนอก geofence → **เตือนไม่บล็อก** "ห่างจุด 1.2 กม." + บังคับเลือกเหตุผลจาก reason master | เขียน: `stop_event` type `depart` / `arrive` / `loaded` / `complete` พร้อม GPS, accuracy, distance จาก geofence, reason; อ่าน: trip_stop, site (พิกัด, geofence radius, ผู้ติดต่อ), DO line | P1 | decision 2026-11-04, E1, E4 (geofence) |
| **M4 POD** | ฟอร์มตาม **POD checklist ของลูกค้า** (E2 config): รูปหลายใบ (กล้องในแอป, **ฝัง timestamp + พิกัดลงรูปและ EXIF**), ลายเซ็นบนจอ, ชื่อผู้รับ + ความสัมพันธ์, **actual qty ต่อรายการ** (default = แผน) + เหตุผลบังคับเมื่อน้อยกว่าแผน (reason master หมวด "ปฏิเสธรับ"), น้ำหนักชั่ง, สแกนบาร์โค้ด/QR; ปุ่ม **ส่งไม่สำเร็จ** → เลือก reason (บังคับรูปตาม reason) → outcome `failed` หรือ **`undelivered_retain`** (ของยังอยู่บนรถ → auto-reschedule ตาม E2) | เขียน: `stop_event` type `complete` + outcome, `trip_stop.pod` jsonb, `delivery_order_line.qty_actual/reject_qty/reject_reason_code_id`, `documents` (รูป/ลายเซ็น ผ่าน presigned upload เมื่อออนไลน์); อ่าน: `customer.pod_requirements`, DO line | P1 | decision 2026-11-04, E2, E3, E7 |
| **M5 สำเร็จ** | หน้ายืนยัน "ส่งจุดที่ 2/4 แล้ว" + จุดถัดไป + ปุ่มนำทางต่อ; **banner offline** "บันทึกในเครื่องแล้ว จะส่งเมื่อมีสัญญาณ (รอส่ง N รายการ)" เมื่อไม่มีเน็ต; จบจุดสุดท้าย → สรุปเที่ยว (จุดสำเร็จ / ไม่สำเร็จ, เวลารวม) | อ่าน: outbox state, trip summary | P1 | decision 2026-11-04, E1 Outbox |
| **M6 แจ้งปัญหา** | ประเภท **รถเสีย / อุบัติเหตุ / ล่าช้า / ปัญหาลูกค้า / อื่น** + ข้อความ + รูป (หลายใบ) + พิกัดอัตโนมัติ + trip/จุดที่เกี่ยว (เลือกจากงานวันนี้); ส่งแล้ว → **สร้าง work order (รถเสีย) หรือ incident (อุบัติเหตุ) อัตโนมัติ** สถานะ REPORTED + แจ้ง dispatcher; ล่าช้า → บันทึก delay event บน stop (แสดงบน tracking page ถ้า reason เปิดไว้); ปุ่ม **โทรฝ่ายจัดรถ** (เบอร์จาก tenant settings) | เขียน: `work_order` (source `DRIVER_APP`) / `incident` / `stop_event` type `delay`, `documents`; อ่าน: trip วันนี้, เบอร์ dispatcher | P1 | decision 2026-11-04, B2 ส่วน 4, 8 |
| **M7 DVIR ตรวจรถก่อนออก** | checklist 10 ข้อ (ยาง, ไฟหน้า-ท้าย-เลี้ยว, เบรก, น้ำมันเครื่อง/น้ำหล่อเย็น, กระจก/ที่ปัดน้ำฝน, แตร, เข็มขัด, เอกสารในรถ, อุปกรณ์ฉุกเฉิน/ถังดับเพลิง, สภาพตัวถัง/ตู้สินค้า) ผ่าน / ไม่ผ่าน + รูปเมื่อไม่ผ่าน; **เลขไมล์** (บังคับ, ตรวจไม่ถอยหลัง); **บังคับก่อนงานแรกของวัน** ต่อรถต่อคนขับ (tenant เปิด/ปิดได้); ข้อไม่ผ่านระดับร้ายแรง → เปิด WO อัตโนมัติ + เตือน dispatcher แต่ **ไม่บล็อก** เริ่มงาน (override + เหตุผล) | เขียน: `dvir_report` + `dvir_item`, `vehicle.odometer_km`, `work_order` (อัตโนมัติ); อ่าน: vehicle, template checklist ต่อประเภทรถ | P2 | decision 2026-11-04, B2 ส่วน 9 |
| **M8 เบิกเงิน / น้ำมัน** | **ยอดเงินเบิกคงเหลือ** (advance ที่รับ − ที่เคลียร์แล้ว); ปุ่ม **บันทึกค่าใช้จ่าย**: ประเภท (น้ำมัน / ทางด่วน / ค่าจอด / ค่าปรับ / อื่น), จำนวนเงิน, **ลิตร + ราคา/ลิตร** (เฉพาะน้ำมัน, ติ๊กเต็มถัง), **เลขไมล์**, ปั๊ม (จากพิกัด), **รูปใบเสร็จ** (บังคับ); รายการที่ส่งแล้วแสดง **สถานะอนุมัติ** (รอตรวจ / อนุมัติ / ตีกลับ + เหตุผล); ขอเบิกเพิ่ม (ถ้า tenant เปิด) | เขียน: `fuel_log` (source `DRIVER_APP`, ผูก `cash_advance_id`) → `vehicle_cost` อัตโนมัติ, คำขอ cash advance; อ่าน: cash advance ของตน, สถานะอนุมัติ | P1 | decision 2026-11-04, B2 ส่วน 6, F7 |
| **M9 ของฉัน** | **สรุปเดือนนี้**: เที่ยวที่จบ, จุดส่งสำเร็จ / ไม่สำเร็จ, กม. รวม, ค่าเที่ยว (เฉพาะ `EMPLOYEE_PER_TRIP` / `SUBCONTRACT`); **ใบจ่ายเงินที่อนุมัติแล้ว** (ดู PDF, 50 ทวิ ถ้ามี); **ใบขับขี่ + วันหมดอายุ** (เตือนก่อนหมด 30 วัน, อัปโหลดรูปใบใหม่ให้ admin ยืนยัน); **ภาษา** ไทย / อังกฤษ (+ เมียนมา / กัมพูชา P2); อุปกรณ์ที่จำไว้ + ออกจากระบบ | อ่าน: trip ของตน, driver payout / settlement, `driver.license_*`; เขียน: `driver_device` (ลบ), คำขอแก้ใบขับขี่ (`documents`), ภาษาที่เลือก (`driver.locale`) | P1 | decision 2026-11-04, F7 "คนขับ/รถร่วมดูค่าเที่ยวของตัวเอง" |
| **M10 ลิงก์รถร่วม (web ไม่ต้อง login)** | หน้า web responsive เปิดจากลิงก์ LINE/SMS (magic link A1): **รับ / ปฏิเสธข้อเสนองาน** (ใส่ทะเบียนรถ + ชื่อ/เบอร์คนขับ หรือเหตุผลปฏิเสธ — D3) และ **อัปโหลด POD ด้วยเลข DO** (กดถึง/ออก → รูป ≤ 5 ใบ/stop → ลายเซ็น → actual qty → ปิดงาน — E2 "ePOD ผ่านลิงก์"); ใช้ UI ชุดเดียวกับ M3–M5 แบบย่อ ไม่มี outbox (ต้องออนไลน์) แต่ส่ง `clientEventId` เหมือนกัน | เขียน: `trip.assignment_status`, `stop_event` (source `link`), `trip_stop.pod`, `documents`; อ่าน: trip ที่ลิงก์ชี้ (ซ่อนราคาขาย/ที่อยู่ลูกค้าตาม PL4) | **P0** | decision 2026-11-04, PL4, E6 |

**E2.2 ข้อกำหนดเทคนิค**

| ข้อกำหนด | รายละเอียด | P | ที่มา |
|---|---|---|---|
| **Offline-first ทุก action** | ทุกปุ่มที่เขียนข้อมูล (M3–M8) ทำงานแบบ optimistic: อัปเดต UI/local DB ทันที → เข้า **outbox queue** → ส่งเมื่อออนไลน์เรียงตาม `occurredAt`; ทุก event มี `clientEventId` (UUIDv4), `occurredAt` (เวลาเครื่อง), GPS lat/lng, `accuracy` (เมตร), `source = app`; server idempotent ตาม E1 (ซ้ำ → คืนผลเดิม; ขัดแย้ง → flag ให้ dispatcher); ส่งเป็น batch ผ่าน `POST /driver/events`; ไฟล์รูป/ลายเซ็นอยู่ในคิวเดียวกัน ส่งหลัง event ที่อ้าง; retry exponential backoff; ข้อมูลอ่าน (งานวันนี้, master ที่เกี่ยว) cache ไว้ใช้ได้ทั้งวัน | P1 (M10 = P0 แต่ไม่มี outbox) | decision 2026-11-04, E1 |
| ขนาดตัวอักษรและปุ่ม | body **16 px** ขั้นต่ำ (หัวข้อ 20–24 px), ปุ่มหลัก **สูง 56 px** เต็มความกว้าง, ทุก touch target **≥ 48 px**; contrast ตาม WCAG AA ใช้กลางแดดได้; ไทยล้วน ไม่มีศัพท์อังกฤษบนปุ่มหลัก | P1 | decision 2026-11-04, K9, X9 |
| รูปภาพ | บีบอัดในเครื่องก่อนส่ง **≤ 1 MB/ใบ** (ด้านยาว ≤ 1600 px, JPEG q≈80); **ฝัง EXIF** (DateTimeOriginal, GPS lat/lng, อุปกรณ์) + **ประทับ timestamp + พิกัดลงบนรูป** (watermark มุมล่าง); server ตรวจ MIME จริงและเก็บ EXIF ไว้ใน `document.metadata` | P1 | decision 2026-11-04, E2 |
| GPS adaptive | ขอพิกัดถี่ขึ้นเมื่อใกล้จุดถัดไป (< 2 กม. → ทุก 15–30 วิ) ห่าง → ทุก 2–5 นาที หรือตามระยะเคลื่อนที่; ไม่ tracking ตลอดเวลา (กล่อง GPS DLT ทำหน้าที่นั้นผ่าน connector E); ตำแหน่งแนบไปกับทุก event เสมอแม้ปิด tracking; เก็บ GPS log 90 วันตาม J | P1 | decision 2026-11-04, X8, K8 |
| Background location | ขอสิทธิ์ตามที่ OS อนุญาต (Android foreground service + notification ระหว่างมีงาน active; iOS "While Using" + significant-change); ถ้าผู้ใช้ไม่ให้สิทธิ์ แอปยังใช้ได้ (พิกัดเฉพาะตอนกดปุ่ม) ไม่บล็อก | P1 | decision 2026-11-04, K8 |
| Push notification | งานใหม่ / เปลี่ยนแผน (เพิ่ม-ลดจุด, เปลี่ยนเวลา, ยกเลิก) / ข้อความจาก dispatcher / ผลอนุมัติเบิกเงิน; FCM (Android) + APNs (iOS) ผ่าน `driver_device.push_token`; แตะแล้วเปิดจอที่เกี่ยว; ไม่มี push → แอป poll `GET /driver/today` เมื่อเปิดหน้า | P1 | decision 2026-11-04, I แจ้งเตือน |
| Cross-platform ตัวเดียว | **Flutter หรือ React Native** (ยังไม่เลือก — ดู "สิ่งที่ยังต้องตัดสินใจ"); เกณฑ์เลือก: กล้อง/EXIF, SQLite offline, background location, ขนาด APK, ทีมที่มี; **Android ก่อน iOS** (ปล่อย Android ก่อน ≥ 1 เฟส) | P1 | decision 2026-11-04 |
| รองรับเครื่องรุ่นเก่า | **Android 8.0 (API 26)+**, RAM 2 GB, จอ 5"; iOS 15+; APK ≤ 40 MB; ทดสอบบนเครื่องราคา ≤ 5,000 บาทจริง; ไม่ใช้ animation หนัก | P1 | decision 2026-11-04, X8 |
| API ชุดเดียวกับ web | ใช้ Open API `/v1` เดียวกัน scope **`driver`** (เห็นเฉพาะ trip ที่ตนถูก assign, ไม่เห็นราคาขาย/ซื้อ ตาม A3); endpoint กลุ่ม `/driver/*` เป็น view เฉพาะ client นี้แต่เรียก domain service เดียวกับ UI (ไม่มีทางลัด); auth = OTP → JWT เดียวกัน refresh 30 วัน (จำเครื่อง); รายละเอียดใน Architecture หัวข้อ 5 | P1 | decision 2026-11-04, G1, benchmark 9 |
| Usability test | ทดสอบกับคนขับจริง ≥ 5 คน (รวมคนไม่ถนัดสมาร์ทโฟน) ก่อนปล่อยทุก release ใหญ่; เกณฑ์: ปิด stop ได้ใน ≤ 4 ขั้นโดยไม่ต้องสอน | P1 | K9, X9 |

**E2.3 ผลกระทบต่อโมดูลอื่น**

| โมดูล | ผลกระทบ | P | ที่มา |
|---|---|---|---|
| A Auth | A1 "Login คนขับ" (OTP) และ "จำอุปกรณ์ 30 วัน" ใช้กับแอป → ตาราง `driver_device`; เพิกถอนเครื่องได้จาก admin (เครื่องหาย); role Driver ใน A3 ได้ scope `driver` เท่านั้น | P1 | decision 2026-11-04, A1 |
| E Execution / POD | M3–M5 คือ client หลักของ E1 event model และ E2 POD checklist; `stop_event` แยกเป็นตารางของตัวเอง (หลาย event ต่อ stop) แทนที่จะเก็บแค่ `client_event_id` เดียวบน `trip_stop`; outcome `undelivered_retain` + auto-reschedule ทำผ่านแอปได้; geofence distance บันทึกต่อ event → รายงาน POD นอกพื้นที่ | P1 | decision 2026-11-04, E1, E2 |
| B2 Fleet | M6 "รถเสีย" → `work_order` สถานะ REPORTED (source DRIVER_APP) / "อุบัติเหตุ" → `incident`; M7 → `dvir_report` + `dvir_item` + อัปเดต `vehicle.odometer_km` + เปิด WO อัตโนมัติ; M8 → `fuel_log` (source DRIVER_APP) → `vehicle_cost` และ กม./ลิตร ต่อคนขับ | P1 / P2 (DVIR) | decision 2026-11-04, B2 ส่วน 4, 6, 8, 9 |
| F7 Cash advance / ค่าเที่ยว | M8 เคลียร์บิลผูก `cash_advance_id` → ยอดคงเหลือและสถานะอนุมัติแสดงในแอป; M9 แสดงใบจ่ายที่อนุมัติ + 50 ทวิ (แทนลิงก์ใน F7 สำหรับคนขับที่มีแอป) | P1 | decision 2026-11-04, F7 |
| D3 / PL4 จ่ายงานรถร่วม | M10 คือหน้า web ของลิงก์รับงาน + POD ลิงก์ที่ D3 และ E2 อ้างถึง — เป็น P0 เพราะใช้กับรถร่วมตั้งแต่เฟส 0 โดยไม่ต้องมีแอป; เมื่อแอปออก รถร่วมยังใช้ลิงก์ฟรีต่อไป | P0 | decision 2026-11-04, PL4, E6 |
| G Open API | เพิ่ม scope `driver` + endpoint กลุ่ม `/driver/*` (today, stops/{id}/events, pod, issues, expenses, dvir, me) + `POST /driver/events` batch idempotent; webhook เดิม (`stop.*`, `pod.captured`) ยิงจาก event ที่แอปส่งเหมือน client อื่น | P1 | decision 2026-11-04, Architecture 5.5 |
| H Reports | ข้อมูลใหม่: POD นอก geofence, เวลาจริงต่อจุด (จาก `stop_event`), อัตราส่งสำเร็จต่อคนขับ, DVIR ไม่ผ่าน, กม./ลิตร ต่อคนขับ — อ่านจากตารางเดียวกัน ไม่คำนวณแยก | P1 | decision 2026-11-04, X3 |
| I แจ้งเตือน | ช่องทางใหม่ push (FCM/APNs) สำหรับ role Driver เพิ่มจาก in-app/อีเมล/LINE | P1 | decision 2026-11-04, I |
| 02 Product & Commercial | add-on 80 บาท/คนขับ active/เดือน คงเดิม; เฟสเปลี่ยน: M10 เฟส 0, M1–M9 เฟส 2 (จากเฟส 3) | — | decision 2026-11-04 |

## F. Billing & Settlement

สรุป: TMS ออกเอกสารการเงินครบชุดตามกฎหมายไทยได้เองแบบ standalone — ใบวางบิล / ใบแจ้งหนี้ / ใบกำกับภาษี / ใบเสร็จ / ใบลดหนี้-เพิ่มหนี้ / 50 ทวิ — โดย VAT และ WHT คิดต่อรายการ (ค่าขนส่งในประเทศยกเว้น VAT แต่บริการประกอบ 7%), tax point เป็นวันรับชำระ, เอกสารที่ finalize แล้ว immutable เลขรันไม่ข้าม และฝั่ง AP จ่ายรถร่วมพร้อมหัก ณ ที่จ่าย 1% ครบวงจร — ให้นักบัญชียืนยันข้อที่ติด "ถามนักบัญชี" ใน thai-tax 6.2 ก่อน freeze schema

**F1. หลักการภาษีที่ฝังในระบบ**

| กฎ | การออกแบบ | P | ที่มา |
|---|---|---|---|
| ค่าขนส่งในราชอาณาจักร **ยกเว้น VAT** (ม.81(1)(ณ)) แม้จ้างช่วง | ทุก line มี `vatTreatment` ∈ EXEMPT_TRANSPORT / VAT_7 / ZERO_RATED จาก accessorial catalog; เอกสารที่มีแต่ EXEMPT ออกเป็น "ใบแจ้งหนี้/ใบเสร็จรับเงิน" ไม่มีคำว่าใบกำกับภาษี | P0 | thai-tax 0.1, 1.8 |
| บริการประกอบ (ยกขน ล้างตู้ ลานตู้ ค่ารอ) **เสีย VAT 7%** | line VAT_7 ปนอยู่ → ใบกำกับภาษีแสดงรายการยกเว้นแยกบรรทัด (ป.86/2542 ข้อ 4(5)) **หรือ** แยกเป็น 2 เอกสาร — ตั้งค่าต่อ tenant ตามที่นักบัญชีเลือก | P0 | thai-tax 1.8, 6.2 ข้อ 1–2 |
| **Tax point บริการ = เมื่อรับชำระ** (ม.78/1) | default: ใบกำกับภาษี+ใบเสร็จ trigger จาก `payment_received`; โหมด `issue_early` ออกพร้อมใบวางบิลเมื่อลูกค้าขอ; วันที่ใบกำกับ = วันเกิด event ไม่ใช่วันส่งของ | P0 | thai-tax 0.2, 1.3 |
| **WHT 1% ค่าขนส่ง / 3% ค่าบริการ** ขั้นต่ำ 1,000/สัญญา | `whtRate` ต่อ line ไม่ใช่ต่อคู่ค้า; เอกสารแสดงยอด WHT ที่ลูกค้าจะหัก; ฝั่งจ่ายรถร่วมคำนวณจริง | P0 | thai-tax 3.1 |
| เลขเอกสารเรียงลำดับ ห้ามใช้ซ้ำ ยกเลิกต้องอ้างฉบับเดิม | series ต่อ (นิติบุคคล × สาขา × ประเภท × งวด); ออกเลขตอน finalize ด้วย row lock; ยกเลิก = status CANCELLED คง record; ห้าม hard-delete | P0 | B9, thai-tax 1.7 |
| สาขาผู้ออกและผู้ซื้อ (ประกาศ 39/196) | ใบกำกับภาษีบังคับ `issuingBranch` และ `customer.branchCode`; render "สำนักงานใหญ่" / "สาขาที่ 00001" | P0 | thai-tax 1.2, 5.3 |
| ภาษาไทย/บาท, ฟอนต์ไทย, พ.ศ./ค.ศ. | PDF ทุกใบ; ตัวเลือก พ.ศ. ต่อ tenant | P0 | X10, thai-tax 1.2 |

**F2. เอกสารฝั่ง AR (ลูกค้า) — ฟิลด์บังคับและกฎ**

| เอกสาร | ฟิลด์บังคับ (นอกจากหัวเอกสาร: ชื่อ/ที่อยู่/เลขฯ/สาขา ผู้ออกและผู้ซื้อ, เลขที่, วันที่) | กฎเฉพาะ | P | ที่มา |
|---|---|---|---|---|
| **ใบแจ้งหนี้** (Invoice) | รายการ (อ้าง order/trip), จำนวน, ราคา, vatTreatment ต่อบรรทัด, ยอดก่อน VAT แยกยกเว้น/7%, VAT, รวม, WHT ที่คาดว่าจะถูกหัก, due date, PO ลูกค้า | 1 ใบ : หลาย DO ของลูกค้าเดียว (ไทยวางบิลรวม); 1 DO อยู่ได้ใน 1 ใบ active | P0 | B2, X12, thai-tax 1.1 |
| **ใบวางบิล** (Billing note) | รายการใบแจ้งหนี้ค้าง + ยอดรวม + วันนัดรับเช็ค/โอน + ผู้รับวางบิล/วันที่ | สรุปหลาย invoice ต่อรอบวางบิล; ไม่กระทบภาษี; สร้างอัตโนมัติตาม `billing_cycle` ของลูกค้า | P0 | B2, thai-tax 1.1 |
| **ใบกำกับภาษี** (เต็มรูป ม.86/4) | คำว่า "ใบกำกับภาษี", เลขลำดับ (+เล่ม), ชื่อ ชนิด ปริมาณ มูลค่า, VAT แยกชัด, รายการยกเว้นแยกบรรทัด, "เอกสารออกเป็นชุด" (เมื่อรวมชุดและไม่ใช่แผ่นแรก), "สาขาที่ออกใบกำกับภาษีคือ…" (เมื่อสาขาใช้ฟอร์ม HQ), ข้อความ e-Tax (เมื่อส่ง e-Tax); optional: ทะเบียนรถ/เลขงาน | ออกได้เฉพาะนิติบุคคลที่จด VAT และเฉพาะเอกสารที่มี line VAT_7; วันที่ตาม tax point | P0 | thai-tax 1.2, 6.1 |
| **ใบเสร็จรับเงิน** (ใบรับ ม.105 ทวิ) | เลขลำดับเล่ม+ใบ, จำนวนเงิน, รายการ, วิธีชำระ, อ้างใบแจ้งหนี้/ใบกำกับ | ออกทันทีที่รับเงิน ทุกกรณีรวมค่าขนส่งยกเว้น VAT; รองรับฟอร์มรวม "ใบเสร็จรับเงิน/ใบกำกับภาษี" (เอกสารออกเป็นชุด) | P0 | thai-tax 1.1, 1.3 |
| **ใบลดหนี้** (ม.86/10) | คำว่า "ใบลดหนี้", **เลขที่ใบกำกับภาษีเดิม** (FK บังคับ), มูลค่าเดิม/ที่ถูกต้อง/ผลต่าง, VAT คืน, **สาเหตุโดยย่อ** | `reasonCode` ตาม ETDA CDNS (เช่น CDNS03 คำนวณสูงเกิน, CDNS99 อื่น+text); เหตุต้องเข้า ม.82/10 มิฉะนั้นบล็อก + แนะนำ "เอกสารปรับปรุงภายใน"; ออกในเดือนภาษีที่เกิดเหตุ | P0 | thai-tax 1.5 |
| **ใบเพิ่มหนี้** (ม.86/9) | เหมือนใบลดหนี้ แต่ VAT เพิ่ม | reasonCode ตาม CDNG | P0 | thai-tax 1.5 |
| **ใบแทน** (ม.86/12) | render PDF เดิม + ข้อความ "ใบแทนใบกำกับภาษี เลขที่ … วันที่ …" | ใช้เลขเดิม; log วันที่ออกใบแทน; ห้ามแก้ข้อมูล | P1 | thai-tax 1.6 |
| ใบกำกับภาษีอย่างย่อ | — | **ไม่ทำ** (ค้าปลีกเท่านั้น) | — | thai-tax 1.4 |
| **บันทึกรับ 50 ทวิ จากลูกค้า** | เลขที่ 50 ทวิ ของลูกค้า, วันที่, ยอดหัก, ไฟล์แนบ | ปิดยอดค้าง 1% → รับชำระสุทธิ 99% + WHT receivable; รายงานกระทบ ภ.ง.ด. ปลายปี | P0 | thai-tax 3.2 |

**F3. Flow วางบิล (AR)**

| ขั้น | รายละเอียด | P | ที่มา |
|---|---|---|---|
| Revenue line ตั้งแต่สร้าง order | ราคาจาก rate card snapshot + accessorial snapshot; `sourceType/sourceId` ต่อ line; rebuild เฉพาะบรรทัดระบบเมื่อ order เปลี่ยน เก็บบรรทัดที่คนเพิ่มเอง; ไม่ rebuild หลัง finalize | P0 | B1 |
| คิว "พร้อมวางบิล" | order DELIVERED ที่ POD ครบ (ตาม checklist ลูกค้า) และ `pricingStatus = AVAILABLE`; กรองลูกค้า/ช่วงวัน; option "ไม่มี POD ไม่วางบิล" | P0 | B2, B6 |
| **Flag กันวางบิลซ้ำ** | unique `(tenantId, orderId)` ใน invoice line ที่ active; order มี `billingStatus` UNBILLED / IN_DRAFT / INVOICED / CREDITED; รายงาน "ยังไม่วางบิลเกิน N วัน" | P0 | B3 |
| Draft (แก้ได้) | เพิ่ม/ลด/รวม/แยกบรรทัด (Group / Merge / Single), ส่วนลด, ย้าย order ระหว่าง draft; order ใน draft ถูกล็อกแก้ราคา; PDF pro forma อัปเดตตามแก้; **draft ไม่มีเลข ไม่ส่ง ERP** | P0 | B2 |
| **Finalize (immutable)** | ตรวจ: ลูกค้ามีเลขฯ+สาขา, ทุก line มี vatTreatment, separation of duties → ออกเลข (row lock) → render PDF เก็บเป็นไฟล์ ณ วันออก → event `invoice.finalized` → outbox ไป connector; แก้หลังนี้ = ใบลดหนี้/เพิ่มหนี้เท่านั้น | P0 | B2, B9 |
| ยกเลิกใบ | เฉพาะยังไม่ส่งลูกค้า/ยังไม่รับชำระ; status CANCELLED คงเลข; ฉบับใหม่อ้างเลขเดิม; ส่ง void ไป connector | P0 | thai-tax 1.7, I7 |
| Template บิลรายเดือน / duplicate | จำโครงบิลต่อลูกค้า ลด key ซ้ำ | P1 | X4 |
| Invoice run (async) | รอบอัตโนมัติตาม billing_cycle สร้าง draft ทุกลูกค้า → job PENDING / RUNNING / COMPLETED / ERROR + ลิงก์ PDF/Excel + webhook `job.completed` | P0 | B10, benchmark 9.10 |
| พิมพ์/ส่งเอกสาร | PDF ตาม design brief ทุกใบ; ส่งอีเมล/LINE/ดาวน์โหลดจาก customer portal; ชุด "ใบวางบิล+ใบแจ้งหนี้+ใบกำกับ" รวมไฟล์ | P0 | v1 |

**F4. Lifecycle และ revert rules**

| สถานะ order (billing) | ย้อนได้โดย | ล็อกอะไร | ที่มา |
|---|---|---|---|
| DELIVERED | Dispatcher (ภายใน 24 ชม.) / Admin | — | B4 |
| RELEASED (ส่งบัญชี) | Invoicer; ต้อง stop ครบ arrive+depart และ POD ครบ | แก้ stop/qty ไม่ได้ | B4 (Alvys) |
| IN_DRAFT | Invoicer ถอดออกจาก draft | แก้ราคาใน order ไม่ได้ (แก้ที่ draft) | B2 |
| INVOICED | **ย้อนไม่ได้** → ใบลดหนี้ | ทุกอย่าง | B2, B4 |
| PAID / PARTIALLY_PAID | ย้อนไม่ได้; แก้รับชำระด้วย reversal entry | ทุกอย่าง | B4 |
| CREDITED | — | — | B2 |

permission ต่อ transition กำหนดใน role; ทุก transition มี timestamp แยก (`releasedAt`, `invoicedAt`, `paidAt`) — P0

**F5. รับชำระและ aging**

| ฟังก์ชัน | รายละเอียด | P | ที่มา |
|---|---|---|---|
| บันทึกรับชำระ | ต่อใบแจ้งหนี้/ใบวางบิล: วันที่, วิธี (โอน/เช็ค/เงินสด), ยอดรับ, **WHT ที่ถูกหัก (อ้าง 50 ทวิ)**, ค่าธรรมเนียม, ส่วนต่าง; รับบางส่วนได้; Payment แยกตาราง | P0 | B4, thai-tax 3.2 |
| Trigger เอกสาร | รับชำระ → ออกใบเสร็จ (+ใบกำกับภาษีถ้ายังไม่ออกและมี VAT_7) อัตโนมัติ | P0 | thai-tax 1.3 |
| สถานะ invoice | ISSUED → SENT → PARTIALLY_PAID → PAID / OVERDUE / CANCELLED คำนวณจาก Payment | P0 | B4 |
| Aging | 0–30 / 31–60 / 61–90 / > 90 ต่อลูกค้า; เตือนครบกำหนด | P0 | v1, R2 |
| Payment status จาก ERP | ถ้า connector รองรับ ดึงกลับแล้ว reconcile กับ Payment ใน TMS (ดู G) | P0 (KRS) | I8 |

**F6. AP — Settlement รถร่วม (Carrier)**

| ขั้น | รายละเอียด | P | ที่มา |
|---|---|---|---|
| Cost line ตั้งแต่สร้าง trip | จาก rate card ขาซื้อ snapshot + accessorial ฝั่งซื้อ; `sourceType/sourceId`; rebuild เฉพาะบรรทัดระบบ | P0 | B1 |
| คิวจ่ายรถร่วม | trip COMPLETED ของ carrier ที่ยังไม่อยู่ใน settlement; option "ไม่มี POD ไม่จ่าย"; กรอง carrier/ช่วงวัน | P0 | B5, B6 |
| **ติ๊กเที่ยว → ใบสำคัญจ่าย (settlement draft)** | รวมหลาย trip; ใส่เลขใบแจ้งหนี้/ใบเสร็จของรถร่วม; บรรทัดหัก (ติดลบ): เงินเบิกล่วงหน้า, ค่าน้ำมันที่เราจ่าย, ค่าปรับ, ค่าเสียหาย; unique `(tripCostLineId)` กันจ่ายซ้ำ | P0 | B5, X11 |
| **รถร่วมตรวจผ่านลิงก์** | ส่ง LINE → เห็นรายการเที่ยว/ยอด/หัก → กด "ยอมรับ" หรือ **"โต้แย้ง" รายการ** พร้อมเหตุผล/รูป (เช่น ค่ารอไม่ตรง) | P0 | B5, B6, B8 |
| **Dispute** | item status OPEN / DISPUTED / APPROVED; dispute บล็อก approve ทั้งใบจนเคลียร์; หน้าเอกสารคู่ยอด: planned vs executed vs claimed + POD | P0 | B6 |
| Approve (separation of duties) | ผู้สร้างอนุมัติเองไม่ได้; step-up 2FA เกินวงเงินที่ตั้ง | P0 | B5, v1 |
| **คำนวณ WHT + ออก 50 ทวิ** | ยอดก่อนหัก × `whtRate` ของ carrier (default 1%; line ค่าบริการ 3%); ขั้นต่ำ 1,000/สัญญา; ออกหนังสือรับรอง 50 ทวิ 2 ฉบับ มีเลขลำดับ series แยก, ลายเซ็นสแกน, PDF ส่ง LINE/อีเมล; ใบแทน 50 ทวิ | P0 | B5, thai-tax 3.2 |
| จ่าย | บันทึกวันโอน/เลขอ้างอิง/ธนาคาร; สถานะ settlement DRAFT → SENT → APPROVED → PAID; ไฟล์โอนธนาคาร (bulk payment CSV) | P0 / P1 (ไฟล์ธนาคาร) | B5 |
| **ภ.ง.ด.3 / ภ.ง.ด.53 export** | รายเดือน: บุคคล → ภ.ง.ด.3, นิติบุคคล → ภ.ง.ด.53; export text/CSV UTF-8 ตาม layout ที่ RD Prep map ได้ (เลขฯ 13 หลัก, สาขา, คำนำหน้าเว้นวรรค, ที่อยู่แยกช่อง, วันที่จ่าย, ประเภทเงินได้, อัตรา, ยอด, ภาษี, เงื่อนไข) | P1 | thai-tax 3.3 |
| e-Withholding Tax | ส่งผ่านธนาคาร | P2 | thai-tax 3.3 |
| Excel ค่าจ้างรถร่วม 3 sheet | Summary / Vehicle charges / Trip charges + PDF; สร้างเป็น async job | P1 | B10 |

**F7. AP — คนขับและเงินเบิกล่วงหน้า**

| ฟังก์ชัน | รายละเอียด | P | ที่มา |
|---|---|---|---|
| **Cash advance** | เบิกต่อเที่ยว/ต่อวัน (น้ำมัน ทางด่วน เบี้ยเลี้ยง) → บันทึกจ่าย → คนขับเคลียร์บิลพร้อมรูปใบเสร็จ → ส่วนต่างคืน/หักค่าเที่ยว; Cashbox dashboard | P1 | B7 |
| ค่าเที่ยวคนขับ `EMPLOYEE_PER_TRIP` | คำนวณตามเที่ยว/ระยะ/ค้างคืน (สูตร B1) → ใบจ่ายรายงวด (gross + หัก) → approve → จ่าย; ไม่หัก WHT (เงินเดือน/ค่าจ้าง 40(1)-(2) อยู่กับ HR) | P1 | M2, B5 |
| `EMPLOYEE_SALARY` | ไม่คิดค่าเที่ยว แต่คิด cost ต่อเที่ยวแบบปันส่วน (standard cost) เพื่อกำไร | P1 | M2, R1 |
| **คนขับ/รถร่วมดูค่าเที่ยวของตัวเอง** | ในแอปหรือลิงก์: เที่ยวที่จบ, ยอด, สถานะจ่าย, ดาวน์โหลด 50 ทวิ | P0 (ลิงก์) / P1 (แอป) | B8 |
| ค่าแรง/เบี้ยเลี้ยง → HR | export รายงานส่ง payroll | P2 | v1 |

**F8. ต้นทุนเที่ยวและกำไร**

| ฟังก์ชัน | รายละเอียด | P | ที่มา |
|---|---|---|---|
| ต้นทุนต่อเที่ยว | รถร่วม (cost line), ค่าเที่ยวคนขับ, น้ำมัน (กรอก/GPS), ทางด่วน, ค่าซ่อม (P2) → รวมบน trip | P1 | v1, B1 |
| กำไรต่อ order / ลูกค้า / รถ | revenue line − cost line ปันส่วน (D4) — คำนวณจาก ledger เดียวกับบิล | P1 | R1, X3 |

**F9. e-Tax Invoice & e-Receipt**

| ฟังก์ชัน | รายละเอียด | P | ที่มา |
|---|---|---|---|
| Data model map เป็น ETDA CII ได้ | document id/date, seller/buyer TXID (13 หลัก + 5 หลักสาขา), lines, tax breakdown, reference doc (388/T01), DCN reason code — เก็บไว้ตั้งแต่ P0 | P0 | thai-tax 2.2 |
| **ส่งผ่าน Service Provider** | ไม่เขียน XML+XAdES เอง; adapter `ETaxProvider` (INET / Leceipt / ธนาคาร) ส่งหลัง finalize → เก็บ XML ที่ SP คืน + สถานะ; ข้อความบนกระดาษ "เอกสารนี้ได้จัดทำและส่งข้อมูลให้แก่กรมสรรพากรด้วยวิธีการทางอิเล็กทรอนิกส์"; ลูกค้าเลือก e-Tax Invoice & e-Receipt **หรือ** e-Tax by Email (โหมดเดียวต่อนิติบุคคล) | P1 | thai-tax 2.1–2.5 |
| รายงานภาษีขาย | ต่อสถานประกอบการ: ลำดับ, วันที่, เลขที่ใบกำกับ, ผู้ซื้อ, เลขฯ 13 หลัก, สาขา, มูลค่า, VAT, หมายเหตุ (ยกเลิก/ลดหนี้); แยกรายงาน "รายได้ยกเว้น" สำหรับ ภ.พ.30 | P0 | thai-tax 5.2 |

## G. Open API & Integration

สรุป: Open API เป็นช่องทางหลักที่ทุก connector (KRS, FlowAccount, PEAK, Express export, UI ของเราเอง) ใช้ร่วมกัน ตามมาตรฐานใน tms-api-benchmark หัวข้อ 9; ERP adapter เป็นชั้นบางที่แปล payload และดูแล mapping/error queue ไม่มีทางลัดเข้า DB

**G1. มาตรฐาน Open API (ทั้งหมด P0 เว้นที่ระบุ)**

| ด้าน | ข้อกำหนด | P | ที่มา |
|---|---|---|---|
| URL & naming | `https://api.<domain>/v1/`; resource พหูพจน์ lowercase; tenant ไม่อยู่ใน path (ผูก credential); nested เฉพาะ `/trips/{id}/stops/{id}`; action = `POST /trips/{id}/dispatch`, `/stops/{id}/arrive|depart|complete|fail`, `/orders/{id}/cancel`, `/invoices/{id}/finalize|void`; JSON camelCase; ID prefix `ord_ trp_ stp_ drv_ veh_ car_ cus_ inv_ evt_`; เงิน `{amount:"1250.00",currency:"THB"}`; เวลา ISO 8601 UTC | P0 | benchmark 9.1 |
| **Auth** | OAuth2 client credentials → JWT RS256 1 ชม., scope `resource:verb`; static key `tk_live_/tk_test_` map เป็น principal เดียวกัน; หลาย key ต่อ tenant, scope/expiry/IP allowlist ต่อ key, rotation มี `revokeAt` ≤ 7 วัน, `lastUsedAt`; UI ของเราใช้ Auth Code + PKCE ออก JWT เดียวกัน → controller ชุดเดียว | P0 | benchmark 9.2 |
| **Idempotency** | ทุก POST รับ `Idempotency-Key` scope (tenant, key, path) เก็บ 24 ชม.; ซ้ำ+body เดิม → replay + `Idempotent-Replayed: true`; body ต่าง → 422 `idempotency_mismatch`; ยังทำอยู่ → 409 | P0 | benchmark 9.3 |
| **External id** | ทุก resource มี `externalId` unique `(tenantId, resource)`; `PUT/PATCH /{resource}/external/{externalId}` → 201/200; path `{id}` รับ `ext:{externalId}` | P0 | benchmark 9.3, O1 |
| Concurrency | `ETag` ทุก GET/PUT/PATCH; `If-Match` ไม่ตรง → 412 (ไม่บังคับ 428) | P0 | benchmark 9.3 |
| **Webhook** | event `{resource}.{action}`; envelope `{id,type,version,occurredAt,tenantId,data{object,previousAttributes},request}`; headers `X-TMS-Event/-Event-Id/-Timestamp/-Signature: t=,v1=/-Attempt`; HMAC-SHA256(secret, `t.rawBody`) tolerance 5 นาที; roll secret ส่ง 2 ลายเซ็น 24 ชม.; timeout 10 วิ; retry 8 ครั้ง (1m,5m,30m,2h,6h,12h,24h,24h); at-least-once; auto-disable หลัง 50 ล้มเหลวติด + อีเมล; verification `challenge` echo | P0 | benchmark 9.4 |
| Webhook ops | `GET /webhook-deliveries?eventId=`, `POST /webhook-deliveries/{id}/retry`, `POST /events/{id}/redeliver?endpointId=` เก็บ 30 วัน; `GET /webhooks/event-types` | P0 | benchmark 9.4 |
| **Error RFC 9457** | `application/problem+json` ทุก 4xx/5xx: `type,title,status,detail,instance,code,requestId,errors[]`; `code` stable catalog; 404 สำหรับ cross-tenant; list ว่าง = 200 `[]` | P0 | benchmark 9.5 |
| **Pagination** | cursor `?limit=(default 25,max 200)&cursor=`; `{data,nextCursor,hasMore}`; keyset `updatedAt,id`; ห้าม offset; filter `*After/*Before`, `status=in`, `externalId=`; `sort=-updatedAt`; `fields=`/`expand=`; ทุก list รองรับ `updatedAfter` สำหรับ incremental pull | P0 | benchmark 9.6 |
| Versioning | major ใน path `/v1`; `X-Api-Version: YYYY-MM-DD` (default = วันที่ tenant สร้าง); เพิ่ม field/enum = non-breaking; client ต้อง tolerate unknown enum; deprecation ≥ 12 เดือน + headers `Deprecation`, `Sunset`, `Link` + อีเมลเจ้าของ key | P0 | benchmark 9.7 |
| **Rate limit** | 50 req/s ต่อ tenant (burst 100), 20/s ต่อ key, write หนัก 5/s; headers `RateLimit-Limit/-Remaining/-Reset` + `Retry-After`; `rateLimitProfile` ต่อ plan | P0 | benchmark 9.8 |
| **Sandbox** | tenant mode `test` cluster เดียว, key `tk_test_`, webhook ส่งจริง, `POST /test/events/trigger` | P0 | benchmark 9.9 |
| OpenAPI & SDK | OpenAPI 3.1 จาก NestJS decorators ที่ `GET /v1/openapi.json`; CI diff spec ทุก PR (breaking → bump major); docs site + llms.txt + `.md` ทุกหน้า; Postman; TypeScript SDK generate (P0), Python (P1) | P0 / P1 | benchmark 9.9 |
| Bulk / async | `POST /orders:bulk` ≤ 200 → 207 multi-status; งานหนัก → 202 `{jobId,statusUrl}` → `GET /jobs/{id}` (pending/running/succeeded/failed/succeeded_with_errors + progress) → webhook `job.completed`; job เก็บ 7 วัน; รับ Idempotency-Key | P0 | benchmark 9.10 |

**G2. Resource เฟสแรก**

| # | Resource | Endpoints ขั้นต่ำ | P | ที่มา |
|---|---|---|---|---|
| 1 | `orders` | POST, GET list/one, PATCH, `PUT /external/{id}`, `/cancel`, `/documents`, `/tracking`, `/events` | P0 | benchmark 10 |
| 2 | `webhooks`, `events`, `webhook-deliveries`, `event-types` | CRUD, retry, redeliver | P0 | benchmark 10 |
| 3 | `stops` | GET, `/arrive`, `/depart`, `/complete`, `/fail` (รับ `clientEventId`) | P0 | benchmark 10, E1 |
| 4 | `documents` (POD/ไฟล์) | presigned upload, GET metadata, download URL หมดอายุ | P0 | benchmark 10 |
| 5 | `customers`, `locations` | CRUD + `PUT /external/{id}` | P0 | benchmark 10 |
| 6 | `invoices`, `invoice-runs`, `payments` | GET, `/finalize`, `/void`, `POST /invoice-runs`, `POST /payments` (บันทึกรับชำระจาก ERP) | P0 | benchmark 10, I8 |
| 7 | `trips` | GET, `/assign`, `/dispatch`, `/complete` | P0 | benchmark 10 |
| 8 | `drivers`, `vehicles`, `carriers` | GET, POST/PATCH, `PUT /external/{id}` | P0 | benchmark 10 |
| 9 | `carrier-settlements` (AP) | GET, `/approve`, `/mark-paid`; webhook `settlement.approved` ให้ ERP ฝั่ง AP | P1 | benchmark 10, B5 |
| 10 | `jobs`, `api-keys`, `openapi.json` | GET | P0 | benchmark 10 |
| — | เฟสถัดไป | rate quotes/tenders, route optimization, fuel/toll, maintenance, telemetry | P2 | benchmark 10 |

**G3. ErpAdapter framework**

| ฟังก์ชัน | รายละเอียด | P | ที่มา |
|---|---|---|---|
| Interface `ErpAdapter` + capabilities | `upsertCustomer/Vendor/Invoice/Payment/Bill`, `void*`, `getAccounts/getItems/getVatRates`, `pullOrders`, `pullPaymentStatus`, `healthCheck`; แต่ละ adapter ประกาศ `capabilities` (เช่น KRS: pullOrders+pushInvoice+pullPayment; Express: fileExport เท่านั้น) UI แสดงเฉพาะที่รองรับ | P0 | I1 |
| Provider factory + `StandaloneProvider` (no-op) + `DemoProvider` | standalone ใช้ได้ทันที; demo สำหรับ staging/sandbox | P0 | I1 |
| **ตาราง `external_mapping`** | `(tenantId, provider, entityType, localId, externalId, externalDocNo, externalVersion, lastSyncedHash, lastSyncedAt, status: synced/failed/retired, lastError)`; push เฉพาะเมื่อ hash เปลี่ยน | P0 | I2 |
| **System-of-record rules** | TMS = เจ้าของงานขนส่ง/ใบวางบิล/ใบแจ้งหนี้/settlement; ERP = เจ้าของลูกค้า(หลัก)/ผังบัญชี/VAT/การรับชำระ(ถ้ามี); แก้ใน TMS แล้ว regenerate ห้ามแก้/ลบใน ERP; field กลุ่ม auto-sync (ราคา, วันที่, accessorial) vs ต้อง regenerate (เปลี่ยนลูกค้า); แก้ได้จนรับชำระ; ตารางนี้ต่อ connector ตกลงกับลูกค้าก่อน go-live | P0 | I3 |
| **Sync master ลงมา** | รหัสสินค้า/บริการ, VAT rate, ผังบัญชี, ลูกค้า จาก ERP → หน้า mapping "accessorial/ประเภทรายได้ TMS ↔ รหัส ERP" ต้องครบก่อน export (บล็อก finalize ถ้าไม่ครบและ connector เปิด) | P0 | I4 |
| เลขเอกสารสองฝั่ง | ส่งเลข TMS ในช่อง ref ของ ERP; เก็บเลข ERP ใน `externalDocNo`; เลขใบแจ้งหนี้รถร่วมใน memo ของ bill | P0 | I5 |
| **Error queue ลูกค้าดูเอง** | หน้า "สถานะเชื่อม {connector}": แยก "รอคิว" / "ล้มเหลว" / "สำเร็จ"; ปุ่ม Retry รายตัว/ทั้งหมด; คู่มือต่อ error code (ลิงก์ help); กรณี "งวดบัญชีปิด" แจ้งให้เปิดงวดแล้ว re-export; request/response log (ตัด secret) | P0 | I6, X7 |
| `syncFromDate` | ไม่ push เอกสารก่อนวันที่กำหนด (go-live กลางงวด); incremental batch; void เมื่อยกเลิก | P0 | I7 |
| **Payment status pull** | polling/change feed ตาม capability → สร้าง Payment ใน TMS → reconcile; ส่วนต่างขึ้น MISMATCH | P0 | I8 |
| Routing ตามนิติบุคคล | mapping `legal_entity/branch ↔ ERP company`; Invoice As / Tender As | P0 | I9 |
| **Inbound webhook ledger** | URL มี tenant token; ตรวจ signature ก่อน; ledger `processed_webhook_event (provider, eventKey)` unique; replay-safe | P0 | I10 |
| Outbox | ทุก event ภายใน → outbox → webhook dispatcher + connector push; UI ของเราเองก็ subscribe (realtime) | P0 | v1, benchmark 11 |
| หน้าจัดการ connector | เปิด/ปิด, credential (เข้ารหัส), healthCheck, feature flag, syncFromDate, mapping, log | P0 | v1 |
| Integration marketplace | ลูกค้าเปิด connector เอง เมื่อมี adapter > 1 | P2 | I11 |

**G4. Connector**

| Connector | รูปแบบ | Capabilities | P | ที่มา |
|---|---|---|---|---|
| **KRS** | API (poller SO/DO read-only + Invoice POST/PUT/GET) ตามเอกสาร TMS × KRS | pullOrders, pushInvoice, voidInvoice, pullPaymentStatus, getMasters | P0 | v1 |
| **FlowAccount** | Open API OAuth2 client_credentials (`openapi.flowaccount.com/v1`, sandbox `/test`); ต้อง Pro Business; โควตา 5,000 เอกสาร/เดือน | upsertContact, pushTaxInvoice/Receipt/BillingNote, pushExpense (AP), getChartOfAccounts, pullPaymentStatus (status approved/paid) | P1 | thai-tax 4.1 |
| **PEAK** | API headers `Client-Token`, `User-Token`, `Time-Stamp`, `Time-Signature` (HMAC-SHA1); ต้อง Pro Plus; e-Tax เป็น action ใต้ Invoices/Receipts/CreditNotes | upsertContact, pushInvoice/Receipt/CreditNote/BillingNote, pushExpense, webhooks | P1 | thai-tax 4.2 |
| **Express** | **file export** เท่านั้น (ไม่มี API สาธารณะ); CSV/Excel ตาม layout ที่ตกลงกับสำนักงานบัญชี; ยืนยันกับ ESG ก่อนโฆษณา | exportInvoices, exportBills | P1 | thai-tax 4.3 |
| CSV generic | export ทุกเอกสาร layout กลาง ให้โปรแกรมอื่น | export | P0 | thai-tax 4.5 |
| SAP B1 | Service Layer OData `/b1s/v2/` | upsertBP, pushARInvoice, pushAPInvoice | P2 | thai-tax 4.4 |
| Xero (+ThaiTax) | API | upsertContact, pushInvoice, pullPayment | P2 | thai-tax 4.5 |
| e-Tax Service Provider | INET / Leceipt / ธนาคาร (ดู F9) | signAndSubmit, getStatus | P1 | thai-tax 2.5 |
| GPS connector | Cartrack / EyeFleet / GPS iAM ผ่าน interface เดียว | pullPositions, pullEvents | **P1** (1 ค่ายแรกที่ลูกค้า pilot ใช้) / P2 (ค่ายอื่น) | v1, E5 |
| LINE OA / Messaging API | ส่งลิงก์งาน/POD/ใบจ่าย/แจ้งเตือน (LINE Notify ปิดบริการแล้ว ใช้ Messaging API) | send | P0 | v1, PL4 |
| Map / geocode | Google / Longdo / NOSTRA Map เลือกผ่าน config | geocode, distance | P0 | v1 |

## H. Reports & Dashboard

สรุป: รายงานและ dashboard ทุกตัวคำนวณจาก invoice line / cost line / settlement line / payment เดียวกันที่ใช้ออกเอกสาร ไม่คำนวณแยกจาก order เพื่อให้ตัวเลขบน dashboard เท่ากับบิลเสมอ; ทุกรายงานกรองช่วงวัน/ลูกค้า/รถ/คนขับ/carrier/นิติบุคคล, export CSV/Excel/PDF, บันทึก filter

| รายงาน | เนื้อหา | P | ที่มา |
|---|---|---|---|
| Dashboard ปฏิบัติการ | วันนี้: order รอจัด (ตาม reason code), trip กำลังวิ่ง, ส่งแล้ว, ล้มเหลว, รถว่าง/ใช้งาน/ซ่อม, งานรถร่วมรอตอบ | P0 | v1, PL7 |
| **Dashboard บิล** | draft / ค้างวางบิล (มูลค่า) / ออกแล้วรอชำระ / ครบกำหนด / รับชำระบางส่วน / WHT รอ 50 ทวิ; ยอดเดือนนี้ vs เดือนก่อน — จาก invoice/payment table | P0 | R2, X3 |
| Dashboard AP รถร่วม | รอตรวจ / disputed / รออนุมัติ / รอจ่าย / จ่ายแล้ว; 50 ทวิ ที่ยังไม่ออก | P0 | B5, B6 |
| Dashboard เชื่อมต่อ | ต่อ connector: คิว, ล้มเหลว, lag, health | P0 | v1, I6 |
| รายได้ | ต่อลูกค้า / เส้นทาง / รถ / ประเภทรถ / นิติบุคคล / เดือน — จาก invoice line finalized | P0 | v1, X3 |
| **DO ยังไม่วางบิลเกิน N วัน** | กันรายได้ตกหล่น; ส่ง LINE/อีเมลให้ Invoicer อัตโนมัติ | P0 | v1, B3 |
| **กำไรต่อเที่ยว / order / ลูกค้า / รถ** | revenue line − cost line ปันส่วน − ค่าเที่ยวคนขับ | P1 | R1 |
| **ต้นทุน / กำไรต่อคัน (Fleet)** | ต่อคัน/เดือน: น้ำมัน + ซ่อม + เอกสาร + ค่าเสื่อม + อุบัติเหตุ จาก `vehicle_cost` ledger เดียว vs รายได้ที่ปันลงรถ; utilization %, กม./ลิตร, เอกสารใกล้หมด, PM ค้าง, รถควรปลดระวาง — ดู B2.3 | P1 | decision 2026-11-04, X3 |
| ค้างชำระ / aging | ต่อลูกค้า + รายการ 50 ทวิ ที่ยังไม่ได้รับ | P0 | v1, R2 |
| **รายงานภาษี** | ภาษีขาย (ต่อสาขา), รายได้ยกเว้น VAT, สรุป WHT ถูกหัก (รับ), สรุป WHT หัก (จ่าย) ประกอบ ภ.ง.ด.3/53 | P0 / P1 | thai-tax 5.2, 3.3 |
| **รายงานส่งลูกค้า (รายวัน) vs วิเคราะห์ภายใน (รายเดือน)** | ชุด "ส่งลูกค้า": งานที่ส่งวันนี้ + POD + ค่าใช้จ่ายหน้างาน ต่อลูกค้า; ชุด "ภายใน": utilization, กำไร | P1 | R3 |
| **ตั้งเวลาส่งรายงาน** | อีเมล/LINE ตามเวลาที่ตั้ง ถึงบัญชี/การเงิน/ลูกค้า | P1 | R4 |
| ประสิทธิภาพส่ง | ตรงเวลา %, ตีกลับ %, POD นอก geofence %, เวลาเฉลี่ยต่อจุด, ต่อคนขับ/carrier | P1 | v1, E4 |
| การใช้รถ | เที่ยว/รถ/เดือน, กม., เที่ยวเปล่า %, utilization | P1 | v1 |
| Cash / COD reconciliation | เงินสด/เงินเบิกต่อเที่ยว "เก็บได้/ต้องเก็บ", cash advance ค้างเคลียร์ | P1 | R5, B7 |
| ประเมิน carrier | ตอบรับ %, ปฏิเสธ %, ตรงเวลา, dispute | P1 | v1, PL5 |
| รายงานตามกฎ DLT | ชั่วโมงขับ, ความเร็ว (ต้อง GPS) | P2 | v1 |

## I. Cross-cutting

สรุป: ทุกฟังก์ชันร่วม (แจ้งเตือน ค้นหา import/export ไฟล์ settings help) ต้องตั้งเองได้จาก UI โดย tenant ไม่พึ่งทีม Innovera และมี help center ภาษาไทยแบบ step-by-step ตั้งแต่ P1

| ฟังก์ชัน | รายละเอียด | P | ที่มา |
|---|---|---|---|
| การแจ้งเตือน | in-app + อีเมล (P0) + LINE (P0 สำหรับรถร่วม/คนขับ, P1 สำหรับทีมภายใน); เหตุการณ์: ใบค้างใหม่, งานรถร่วมหมดเวลา, dispute, ขออนุมัติ, เอกสารรถ/ใบขับขี่/rate card ใกล้หมด, connector ล่ม, DO ยังไม่วางบิล, ครบกำหนดชำระ; ผู้ใช้ตั้งว่ารับอะไรทางไหน; สรุปรายวัน 08:00 | P0 / P1 | v1 |
| ค้นหา global (⌘K) | เลข order/trip/invoice/ทะเบียน/ลูกค้า/เลข PO/เลขตู้ → กระโดดไปเอกสาร | P0 | v1, 3.9 |
| Import / Export | Excel/CSV ทุก master และเอกสาร dry-run; export ตาม filter; งานใหญ่ background + แจ้งเมื่อเสร็จ (job) | P0 | v1, P8 |
| ไฟล์แนบ | POD, เอกสารรถ, สัญญา, ใบเสร็จ cash advance, 50 ทวิ ที่รับ — object storage, presigned URL หมดอายุ, 10 MB/ไฟล์, ตรวจ MIME จริง | P0 | v1 |
| ตั้งค่าองค์กร | นิติบุคคล/สาขา, โลโก้, prefix เลขเอกสาร, timezone, พ.ศ./ค.ศ., VAT/WHT default, รอบวางบิล, free time ค่ารอ, POD checklist default, นโยบาย 2FA/session, โหมด tax point, แยก/รวมเอกสาร VAT | P0 | v1, F1 |
| UI pattern มาตรฐาน | tab สถานะพร้อมตัวนับ, status chip, route chip "A → B", KPI card เหนือตาราง, filter ต่อคอลัมน์ + เลือกคอลัมน์, saved views, ที่อยู่ตัดบรรทัดเดียว + tooltip — ตาม design brief | P0 | 3.9 |
| ความคิดเห็น/โน้ตบนเอกสาร | ต่อ order/trip/invoice/settlement + mention | P1 | v1 |
| ประวัติการแก้ไขต่อเอกสาร | timeline สถานะ + ใครแก้อะไร จาก audit log | P0 | v1 |
| ภาษา | UI ไทย/อังกฤษ ต่อผู้ใช้; เอกสาร PDF ไทยเป็นหลัก | P0 (ไทย) / P1 (อังกฤษ) | v1, X10 |
| Help | tooltip ฟิลด์, ลิงก์คู่มือจากทุกหน้า, ติดต่อ support ในระบบ | P1 | v1 |
| **Help center step-by-step** | สาธารณะ ภาษาไทย ทีละหน้าจอพร้อมภาพ ครอบคลุมทุก flow + error code catalog + API docs (เลียนแบบ docs.alvys.com); in-app chat support | P1 | X14 |
| Onboarding wizard | = setup checklist (A5) | P0 | v1, P8 |

## J. Security, Compliance และ Non-functional

สรุป: tenant isolation ด้วย RLS, เอกสารภาษีเก็บ ≥ 5 ปี (ตั้ง 7 ปีเผื่อขยาย) แบบ immutable รวม XML e-Tax, Innovera เป็น processor ตาม PDPA โดยใช้ฐานสัญญา/legitimate interest สำหรับข้อมูลคนขับ ไม่ใช่ consent

**Security**

| ข้อกำหนด | รายละเอียด | P | ที่มา |
|---|---|---|---|
| ขนส่งข้อมูล | HTTPS TLS 1.2+, HSTS, cookie `Secure HttpOnly SameSite=Lax` | P0 | v1 |
| เก็บข้อมูลลับ | credential ERP/API key/บัตรประชาชนคนขับ เข้ารหัส AES-256-GCM key ใน KMS; ไม่โชว์เต็ม; หมุน key ได้ | P0 | v1, thai-tax 5.4 |
| Tenant isolation | shared schema + `tenantId` ทุกตาราง + Prisma extension + Postgres RLS ชั้นสอง; test cross-tenant ทุก endpoint อัตโนมัติ; cross-tenant → 404 | P0 | P1, benchmark 11 |
| Input validation | schema ทุก API, กัน SQLi/XSS/CSRF, จำกัด upload, MIME จริง | P0 | v1 |
| Rate limiting | ต่อ IP/user/key/tenant (G1); login เข้มกว่า | P0 | v1, benchmark 9.8 |
| Secret ใน log | ไม่เก็บ password/key/token; integration log ตัด header | P0 | v1 |
| Magic link | HMAC + หมดอายุ + จำกัด action + revoke ได้; ไม่เผยราคาขายใน payload ของรถร่วม | P0 | PL4, P3 |
| Dependency scanning | CI ตรวจ CVE ทุก build; patch critical 7 วัน | P0 | v1 |
| Security headers | CSP, X-Frame-Options, Referrer-Policy | P0 | v1 |
| Penetration test | ก่อนเปิด standalone และปีละครั้ง | P1 | v1 |
| IP allowlist | Innovera admin และ API key ของ tenant (เลือกได้) | P1 | v1 |

**Retention และ compliance**

| ข้อกำหนด | รายละเอียด | P | ที่มา |
|---|---|---|---|
| **เอกสารภาษี ≥ 5 ปี** (ม.87/3, ม.105 ทวิ) | invoice/tax invoice/receipt/credit-debit note/50 ทวิ/รายงานภาษีขาย: ห้าม hard-delete; soft-delete + retention default **7 ปี** (เผื่อขยาย); เก็บ **PDF ที่ render ณ วันออก** ไม่ render ใหม่ | P0 | thai-tax 5.1 |
| **e-Tax XML** | เก็บ XML ที่ลงนามจาก SP + สถานะส่ง RD + audit log การเข้าถึง ≥ 5 ปี; แก้ไขด้วยรายการปรับปรุงที่เห็นค่าก่อน/หลัง ห้ามลบ | P1 | thai-tax 2.4, 5.1 |
| Audit log 5 ปี, integration log 24 เดือน, login log 1 ปี, ไฟล์ POD 2 ปี, GPS log 90 วัน | ตั้งต่อ tenant ไม่ต่ำกว่าขั้นต่ำ | P0 | v1, thai-tax 5.4 |
| เก็บเอกสารนอกสถานประกอบการ (cloud) | ถามนักบัญชีเรื่อง ท.ป.116/2545 / ป.121/2545; เตรียมเอกสารระบบ (flowchart, access control) ให้ลูกค้ายื่น | P1 | thai-tax 5.1, 6.2 ข้อ 10 |
| **PDPA** | Innovera = processor, tenant = controller; DPA ในสัญญา; Record of Processing; ข้อมูลคนขับใช้ฐานสัญญา + legitimate interest (ไม่ใช่ consent); privacy notice template ให้ tenant; แจ้งเหตุละเมิดภายใน 72 ชม.; สิทธิ์เจ้าของข้อมูล export/anonymize ยกเว้นที่กฎหมายภาษีบังคับ (เลขบัตรใน 50 ทวิ/ภ.ง.ด.3) | P0 / P1 (DSAR) | v1, thai-tax 5.4 |
| ลบ tenant | soft-delete 90 วัน → export → purge + ยืนยันลายลักษณ์อักษร; เอกสารภาษีส่งมอบลูกค้าก่อน purge | P1 | v1 |
| Data residency | โฮสต์ในไทย | P0 | v1 |

**Non-functional**

| หัวข้อ | เป้าหมาย | ที่มา |
|---|---|---|
| Availability | 99.5% รายเดือน (เฟสแรก), 99.9% Business+; maintenance แจ้ง 48 ชม.; status page (P1) | v1 |
| Performance | ตาราง 10,000 แถว < 2 วิ (cursor paging); finalize invoice 500 DO < 5 วิ; invoice run 2,000 DO เป็น job < 2 นาที; API p95 < 300 ms; webhook ส่งภายใน 5 วิหลัง event | v1, benchmark |
| ขนาด | 100 tenant, 5,000 รถ, 50,000 order/เดือน, 1M event/เดือน บนโครงเดียว | v1 |
| Backup | snapshot ทุก 6 ชม. + WAL, เก็บ 30 วัน, ไฟล์ versioned; restore test ทุกไตรมาส; RPO 1 ชม., RTO 4 ชม. | v1 |
| Monitoring | uptime, error rate, outbox/webhook queue, connector lag, job queue, disk; alert ทีม Innovera | v1 |
| Browser / device | Chrome/Edge 2 เวอร์ชัน, Safari; จอ ≥ 1280; magic link, tracking page และ M10 ลิงก์รถร่วม responsive มือถือ (Chrome Android / Safari iOS 2 เวอร์ชันล่าสุด, LINE in-app browser) | v1, E6, decision 2026-11-04 |
| Mobile (Driver app E2) | **Android 8.0 (API 26)+** RAM 2 GB, iOS 15+; Android ปล่อยก่อน iOS; **offline ใช้งานได้ทั้งวัน** (cache งานวันนี้ + master ที่เกี่ยว, outbox ไม่จำกัดจำนวน event, ไฟล์ค้างส่ง ≤ 500 MB แล้วเตือน); **รูป ≤ 1 MB/ใบ** หลังบีบอัด, ≤ 10 ใบ/stop, ฝัง EXIF timestamp+พิกัด; APK ≤ 40 MB; เปิดแอปถึงหน้างานวันนี้ < 2 วิ (cache), sync batch 100 event < 5 วิ; แบตเตอรี่: GPS adaptive ใช้ ≤ 5%/ชม. ระหว่างมีงาน active; ตัวอักษร body 16 px, touch target ≥ 48 px, ปุ่มหลัก 56 px; ภาษาไทยหลัก | decision 2026-11-04, E2.2, X8, K9 |
| Accessibility | WCAG 2.1 AA contrast + keyboard ในตาราง/ฟอร์ม | v1 |
| Localization | ไทยหลัก, อังกฤษรอง; พ.ศ./ค.ศ.; THB (สกุลอื่น P2) | v1 |
| Environments | dev / staging / production; staging มี DemoProvider + mock KRS จาก contract; sandbox tenant ใน production cluster | v1, I1, benchmark 9.9 |
| Deploy | CI/CD, migration ย้อนกลับได้, feature flag, zero-downtime; OpenAPI diff gate | v1, benchmark 9.9 |

## K. สิ่งที่ไม่ทำ

สรุป: ตัดสิ่งที่ลูกค้าของคู่แข่งบ่นและโครงสร้างที่ไม่เข้ากับไทยออกตั้งแต่ต้น เพื่อไม่ต้อง unwind ภายหลัง

| # | ไม่ทำ | ทำแทน | ที่มา |
|---|---|---|---|
| K1 | สัญญายาวพร้อมค่าปรับ, เก็บเงินเต็มปีเมื่อเพิ่มรถกลางสัญญา | รายเดือน ไม่มีสัญญา คิดตามรถ/คนขับ active จริง | X1 |
| K2 | ล็อก ePOD / reason code / วางบิล ไว้ tier สูง | อยู่ใน tier แรกทั้งหมด; add-on = optimizer, ERP connector, e-Tax SP | X2 |
| K3 | dashboard คำนวณแยกจากบิล | ทุกรายงานอ่านจาก invoice/cost/settlement/payment line เดียวกัน (H) | X3 |
| K4 | ให้บัญชีคีย์ซ้ำ | duplicate, template บิลรายเดือน, invoice run, upsert จาก DO | X4 |
| K5 | config ที่ต้องให้ Innovera ตั้งให้ | ค่าเริ่มต้นไทยพร้อมใช้ + setup checklist; ทุก setting ตั้งได้จาก UI | X5 |
| K6 | workflow engine เต็มรูป | POD checklist + reason master + step ต่อประเภทงานที่ config ได้ในขอบเขตจำกัด | X6 |
| K7 | integration ที่ลูกค้ามองไม่เห็น | หน้าสถานะ connector + error queue + retry + request log ให้ลูกค้าดูเอง | X7 |
| K8 | แอปที่กินแบต / GPS ค้าง | adaptive location, background mode ตาม OS, offline outbox | X8 |
| K9 | ปล่อย Driver app โดยไม่ทดสอบกับคนขับจริง | usability test ก่อนปล่อย; ปุ่มใหญ่ ไทยล้วน ≤ 4 ขั้นต่อ stop | X9 |
| K10 | UI/เอกสารอังกฤษเป็นหลัก | ไทยเป็นหลักทั้ง UI, PDF, ฟอนต์, พ.ศ.; อังกฤษเป็นตัวเลือก | X10 |
| K11 | สองเส้นทางจ่ายรถร่วมพร้อมกัน | เส้นทางเดียว: settlement → AP ของ ERP; unique `(tripCostLineId)` | X11 |
| K12 | DB-per-tenant, เลข identity เดียวทุกเอกสาร, 1 invoice : 1 order, รถร่วมเป็น Employee, หาคนขับจาก `vehicle.mainDriver`, driver API ไม่มี idempotency, sync ทางเดียวไม่ reconcile | ตรงข้ามทุกข้อ (A, B, D1, E1, G3) | X12 |
| K13 | build แยกต่อลูกค้า | multi-tenant เดียว ปรับด้วย config + branding (โลโก้บนเอกสาร/tracking page) | X13 |
| K14 | support ที่ตอบช้าและไม่มีคู่มือ | help center step-by-step ภาษาไทย + in-app chat + error code catalog | X14 |
| K15 | ใบกำกับภาษีอย่างย่อ | B2B ขนส่งไม่ใช่ค้าปลีก | thai-tax 1.4 |
| K16 | เขียน XML e-Tax + XAdES และถือ certificate เอง | ส่งผ่าน Service Provider | thai-tax 2.2–2.3 |
| K17 | เป็น system of record ของผังบัญชี/GL | TMS จบที่เอกสารขนส่ง-การเงินระดับเอกสาร; GL อยู่ที่ ERP/โปรแกรมบัญชี | I3 |
| K18 | VRP engine ของตัวเอง | interface เรียก engine ภายนอก (P2) | v1 |
| K19 | public API แบบ offset pagination / tenant ใน path / PascalCase | มาตรฐาน G1 | benchmark 9 |
| K20 | ระบบบัญชีสต็อกอะไหล่เต็มรูป (FIFO / ต้นทุนถัวเฉลี่ย, นับสต็อก, หลายคลัง) ในเฟสแรก | บันทึกอะไหล่เป็นบรรทัดใน WO ด้วยราคาที่จ่ายจริง (P1); ทะเบียนอะไหล่ + รับ/เบิก + min stock แบบง่ายเป็น P2; มูลค่าสต็อกทางบัญชีอยู่ที่ ERP (B2 ส่วน 5) | decision 2026-11-04 |

## สิ่งที่ยังต้องตัดสินใจ

| เรื่อง | ผลกระทบ | ใครตอบ |
|---|---|---|
| คำถามนักบัญชี 12 ข้อใน thai-tax-docs 6.2 (สัญญารวมบริการ VAT, ค่าน้ำมัน/ทางด่วน 1% หรือ 3%, เลขข้าม, ใบลดหนี้ส่วนลด, ฟอร์ม 50 ทวิ + ภ.อ.11, e-Tax 30 ล้าน, cloud storage) | schema F1–F2, F6 ก่อน freeze | นักบัญชี/สรรพากร |
| KRS รับเอกสารแบบไหน (ใบแจ้งหนี้/ใบกำกับ/AP voucher), ใครออกเลข, งวดปิดแล้วทำอย่างไร | G3 system-of-record table ของ KRS, G4 | KRS (product-learning 5 ข้อ 18–20) |
| Express: เวอร์ชันและวิธีนำเข้าของสำนักงานบัญชีลูกค้าเป้าหมาย | G4 ก่อนโฆษณา "export Express" | ESG / ลูกค้า |
| e-Tax SP รายแรก (INET / Leceipt / ธนาคาร) และราคาต่อฉบับ | F9, ราคา add-on | Innovera |
| cloud provider / region ไทย | J data residency, ต้นทุน | Innovera |
| SLA กับ KRS ในฐานะ pilot | J availability | Innovera × KRS |
| Driver app: Flutter หรือ React Native (เกณฑ์: กล้อง/EXIF, SQLite offline, background location, ขนาด APK, ทีม) | E2.2 ก่อนเริ่มเฟส 2; ไม่กระทบ API/data model | Innovera |
