# TMS Product & Commercial

Oct 14, 2026 · @wei

ขายเป็น Subscription คิดต่อรถต่อเดือน, ERP connector เป็น add-on, ใช้ standalone ได้โดยไม่ต้องมี ERP และสร้าง multi-tenant ตั้งแต่วันแรกแม้ลูกค้ารายแรกจะมีรายเดียว ราคาในเอกสารนี้เป็น **ตัวเลขตั้งต้นให้ตัดสินใจ** ยังไม่ได้ทดสอบกับตลาด

## 1. รูปแบบขายและ tier

**ทำไม Subscription** — กลุ่มเป้าหมายคือขนส่งไทย SME ถึงขนาดกลางที่ research ชี้ว่าคืนทุน 6–24 เดือนและเลือกจาก TCO ต่ำ ผู้เล่นที่ชนะกลุ่มนี้ (Logis Boy, Shipwell, Locus) เป็น subscription ทั้งหมด License ก้อนเดียวขายยากและทำให้ต้องดูแลหลายเวอร์ชัน

**หน่วยคิดเงิน: ต่อรถ ไม่ใช่ต่อ user** — ลูกค้าขนส่งนับรถเป็น และไม่ควรถูกลงโทษที่ให้คนขับ/แอดมินใช้ระบบหลายคน

| Tier | จำนวนรถ | ราคาตั้งต้น (บาท/รถ/เดือน) | User | รวมอะไร |
| --- | --- | --- | --- | --- |
| Starter | 1–10 | 350 | ไม่จำกัด | SO/DO/Invoice, วางแผนรถ, ใบค้าง, export |
| Growth | 11–50 | 280 | ไม่จำกัด | + รถร่วม/ผู้รับเหมา, รายงาน, API อ่านข้อมูล |
| Business | 51–200 | 220 | ไม่จำกัด | + reconcile กับ ERP, approval flow, SLA ตอบใน 1 วันทำการ |
| Enterprise | 200+ | ตกลงรายปี | ไม่จำกัด | + on-prem/private cloud, custom connector, SLA 24×7 |

ขั้นต่ำต่อเดือน: Starter 3,000 บาท (กันลูกค้า 1–2 คันที่ต้นทุนดูแลสูงกว่ารายได้)

**Add-on**

| รายการ | ราคาตั้งต้น | หมายเหตุ |
| --- | --- | --- |
| ERP connector (KRS เป็นตัวแรก) | 4,000 บาท/เดือน/connector + setup 25,000 บาท | setup รวมทดสอบ field mapping และ master code กับ ERP ของลูกค้า |
| GPS/Telematics connector | 1,500 บาท/เดือน/ค่าย | ต่อกับกล่องที่ลูกค้ามีอยู่ |
| Driver app (ePOD) | 80 บาท/คนขับ/เดือน | เฟสถัดไป |
| Custom report / integration | คิดตามงาน | ผ่าน Digital Transformation แบบ Logis Boy |

**ลดความเสี่ยงให้ลูกค้าตัดสินใจ** — ทดลองใช้ฟรี 30 วัน (Starter/Growth) ไม่ต้องใส่บัตร, สัญญารายปีลด 15%, ย้ายข้อมูลเข้าให้ฟรีถ้าทำสัญญารายปี

**สิ่งที่ยังต้องตัดสินใจ**

- [ ] ราคาต่อรถจริงหลังเทียบกับ Logis Boy / Cartrack Delivery (ควรขอใบเสนอราคาเขามาเทียบ)
- [ ] จะนับ "รถ" อย่างไร: รถที่ active ในเดือนนั้น หรือรถที่ลงทะเบียนทั้งหมด (เสนอ: active = มี DO ในเดือน)
- [ ] รถร่วม/รถผู้รับเหมา คิดครึ่งราคาหรือเต็ม

## 2. Multi-tenant model

ใช้ฐานข้อมูลเดียว แยกด้วย `tenant_id` ทุกตาราง (shared schema) — ถูกที่สุดและพอสำหรับ 100 tenant แรก; Enterprise ที่ขอแยกฐานค่อยทำ schema-per-tenant หรือ private deployment ภายหลัง เพราะโค้ดเดียวกันรองรับทั้งสองแบบถ้ามี `tenant_id` อยู่แล้ว

| หลักการ | รายละเอียด |
| --- | --- |
| `tenant_id` ทุกตาราง | รวม `erp_doc_map`, `erp_outbox`, `erp_sync_log` — ไม่มีตารางใดเป็น global ยกเว้น `tenant`, `plan`, `platform_user` |
| บังคับที่ชั้น DB | PostgreSQL Row-Level Security ผูกกับ `current_setting('app.tenant_id')` — ป้องกัน bug ใน query ข้ามลูกค้า ไม่ใช่แค่ `WHERE` ใน code |
| Config ต่อ tenant | ERP adapter, API key, feature flag (`erp.krs.doSync`), billing\_cycle, เลขรันเอกสาร, timezone — เก็บใน `tenant_setting` (jsonb) ไม่ hardcode |
| ERP adapter ผูก tenant | `tenant_erp_connection(tenant_id, erp_code, config, status)` — tenant หนึ่งมีได้หลาย connector, connector หนึ่งมีได้หลาย tenant (KRS ลูกค้าคนละบริษัท) |
| คิวงานแยก fairness | outbox worker และ SO poller หยิบงาน round-robin ตาม tenant ไม่ให้ลูกค้าใบใหญ่ 446 รายการบล็อกรายอื่น |
| เลขเอกสาร | `tms_voucher_no` ขึ้นต้นด้วย prefix ของ tenant (`PP-INV-2610-0007`) กันซ้ำข้าม tenant ฝั่ง ERP ที่ใช้ร่วมกัน |
| ขอบเขตข้อมูล | export, log, reconcile เห็นเฉพาะ tenant ตัวเอง; Innovera admin เห็นทุก tenant แต่ทุกการเข้าดูข้อมูลลูกค้าถูก audit |
| ลบ tenant | soft-delete 90 วันแล้ว purge; ส่ง export ให้ลูกค้าก่อนลบ (PDPA) |

**ตารางระดับ platform** (ไม่มี `tenant_id`)

- `tenant` — id, ชื่อ, สถานะ (`TRIAL` / `ACTIVE` / `SUSPENDED` / `CLOSED`), tier, จำนวนรถที่ซื้อ, วันเริ่ม/หมดอายุ, trial\_ends\_at
- `plan` — tier, ราคา, limit, feature list
- `platform_user` — ทีม Innovera + role (`super_admin`, `support`)
- `tenant_usage_monthly` — รถ active, DO, Invoice, API calls ต่อเดือน → ใช้ออกบิล

**Standalone vs เชื่อม ERP** — ต่างกันแค่ `tenant_erp_connection` มีแถวหรือไม่ ถ้าไม่มี: Invoice จบที่สถานะ `ACCEPTED` ภายใน TMS, พิมพ์/ส่ง PDF ได้, ไม่มี outbox/reconcile; เปิด connector ทีหลังได้โดยไม่ย้ายข้อมูล

## 3. Portal 2 ชั้น

แยกเป็น 2 แอป (หรือ 2 route group ใน codebase เดียว) เพราะสิทธิ์และ audit ต่างกันคนละระดับ: Admin portal ของ Innovera จัดการ tenant, ส่วนลูกค้ามีหน้า "องค์กร" ในตัว TMS จัดการของตัวเองโดยไม่ต้องเปิด ticket มาหาเรา

**Innovera Admin Portal** (`admin.<domain>`, login แยก, บังคับ 2FA)

| หน้า | ทำอะไร |
| --- | --- |
| Tenants | สร้าง/ระงับ/ปิด, เปลี่ยน tier และจำนวนรถ, ต่ออายุ, แปลง trial → paid, impersonate (เข้าดูในมุมลูกค้าแบบมี audit) |
| Connectors | เปิด-ปิด ERP/GPS connector ต่อ tenant, ใส่ API key (เข้ารหัส), ทดสอบ healthCheck, ดู outbox/sync log ข้าม tenant |
| Usage & Billing | รถ active, DO, Invoice ต่อเดือนต่อ tenant → ออกใบแจ้งหนี้ของเราเอง (เฟสแรก export CSV ไปออกบิลมือได้) |
| Health | คิวค้าง, MISMATCH เปิดอยู่, poller ล่าสุด, error rate 7 วัน ต่อ tenant — รู้ก่อนลูกค้าโทรมา |
| Feature flags | เปิดฟีเจอร์ทดลองรายลูกค้า (เช่น doSync, ePOD) |
| Audit log | ทุก action ของทีม Innovera บนข้อมูลลูกค้า |

**หน้าองค์กรของลูกค้า** (ใน TMS, role `tenant_owner` / `tenant_admin`)

| หน้า | ทำอะไร |
| --- | --- |
| ผู้ใช้และสิทธิ์ | เชิญ user, กำหนด role (`planner`, `accounting`, `viewer`, `driver`), ปิดบัญชี |
| รถและคนขับ | ทะเบียนรถ, ประเภท, รถบริษัท/รถร่วม, คนขับ — จำนวนรถ active โชว์เทียบกับ quota ของ tier |
| ลูกค้าและ rate card | ลูกค้าที่วางบิล, รหัสฝั่ง ERP, ราคาต่อเที่ยว/ตัน/กม., รอบวางบิล |
| การเชื่อมต่อ | ดูสถานะ connector ที่เปิดให้, กดทดสอบ, ดู log ของตัวเอง — แต่ **ตั้งค่า API key และ mapping ครั้งแรกทำโดย Innovera** (รวมใน setup fee) |
| แผนและการชำระเงิน | tier ปัจจุบัน, รถที่ใช้/ซื้อ, วันหมดอายุ, ประวัติบิล, ขออัปเกรด |
| ตั้งค่าเอกสาร | prefix เลข DO/Invoice, โลโก้, ที่อยู่บนใบ, timezone |

## 3.5 Mobile application: มีเฉพาะแอปคนขับ (ePOD) และเป็นเฟสหลัง

ส่วนเดียวของระบบที่ต้องเป็น mobile คือแอปคนขับ ส่วนวางแผน วางบิล และ portal ทั้งสองชั้นเป็น web responsive พอ เหตุผลจาก research: โครงการ TMS ล้มที่ frontline adoption — คนขับคือผู้ป้อนสถานะจริง ถ้าไม่มีแอป สถานะ DO จะมาจากแอดมินกรอกย้อนหลัง ทำให้ reconcile ช้าและผิด

| เฟส | การยืนยัน DO | หมายเหตุ |
| --- | --- | --- |
| 0–1 (KRS pilot, standalone) | แอดมิน/พนักงานหน้าคลังกรอกผ่านเว็บ | วิธีที่ KRS ทำอยู่แล้ว; DO state machine รองรับทั้งสองทางตั้งแต่แรก |
| 3 | Driver app ePOD | add-on 80 บาท/คนขับ/เดือน ตามตาราง add-on |

**ขอบเขต Driver app (เฟส 3)**

- รับรายการ DO ของวัน, กดเริ่มวิ่ง/ถึงจุด, ถ่ายรูปพร้อม timestamp + พิกัด, เซ็นชื่อผู้รับ, ตีกลับบางส่วน/ทั้งหมด, บันทึกเหตุล่าช้า, น้ำหนักชั่ง
- **Offline-first เป็นข้อบังคับ** — เก็บงานในเครื่อง sync เมื่อมีสัญญาณ (จุดเด่นของ Logis Boy ที่ research เน้น)
- เบา กินแบตน้อย รองรับมือถือรุ่นเก่า (บทเรียน NOSTRA ePOD ที่ได้ 3.4 ดาวจากปัญหาอัปเดตบนเครื่องเก่า)
- ไม่ทำ GPS tracking ตลอดเวลาในแอป — ให้กล่อง GPS ตามกฎ DLT ทำ แล้วต่อผ่าน GPS connector

**เทคโนโลยี:** cross-platform ตัวเดียว (Flutter หรือ React Native) เพราะคนขับไทยใช้ Android เป็นหลักแต่ต้องมี iOS และทีมเล็ก; ช่วงทดลองใช้ PWA ก่อนได้ แต่ offline และกล้องทำได้จำกัดกว่า

- [ ] เลือก Flutter / React Native / PWA ก่อนเริ่มเฟส 3

## 4. Roadmap ขาย

ขายทีละวง: ทำให้ KRS เป็น reference customer ที่พูดได้ก่อน แล้วค่อยเปิด standalone ให้ตลาดกว้าง และรับ ERP ที่สองเมื่อมีลูกค้าจ่ายจริง ไม่ทำ connector ล่วงหน้า

| เฟส | ช่วง | เป้าหมาย | สิ่งที่ต้องมี | เกณฑ์ผ่าน |
| --- | --- | --- | --- | --- |
| 0 — KRS pilot | ขึ้นระบบ → +3 เดือน | tenant เดียว ใช้จริง ปิดเดือนบัญชีผ่าน reconcile | เอกสารออกแบบ TMS × KRS ทั้งหมด, admin portal ขั้นต่ำ (tenant, connector, health) | ปิดงวดบัญชี 2 เดือนติดโดย MISMATCH ค้าง = 0 |
| 1 — Standalone | ถัดไป 3 เดือน | ลูกค้า 5 รายที่ไม่มี ERP ใช้ trial → paid | หน้าองค์กรลูกค้าครบ, พิมพ์ใบแจ้งหนี้ PDF, trial flow อัตโนมัติ, ออกบิลเราเองจาก usage | trial → paid ≥ 30% |
| 2 — ERP ที่สอง | เมื่อมีลูกค้า Growth+ ขอ | adapter ตัวที่สองพิสูจน์ว่า interface ใช้ได้จริง | connector framework (config-driven mapping, ไม่เขียนใหม่ทั้งตัว) | setup connector ใหม่ ≤ 15 วันทำการ |
| 3 — ขยาย | ปีที่ 2 | Driver app ePOD, GPS connector, รถร่วมหลายผู้รับเหมา | จาก research: offline POD, connector GPS ต่างค่าย | ARR ครอบคลุมต้นทุนทีม |

**สิ่งที่ยังต้องตัดสินใจ**

- [ ] ชื่อผลิตภัณฑ์และโดเมน (แยกจาก innoveraappcenter หรือไม่)
- [ ] KRS คิดราคาเท่าไรในฐานะ pilot (ส่วนลดแลก reference + case study)
- [ ] ออกบิลลูกค้าเองด้วยมือกี่รายก่อนทำระบบ billing อัตโนมัติ (เสนอ: ทำมือจนถึง 10 tenant)
