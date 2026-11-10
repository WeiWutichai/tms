# TMS Product & Commercial (v2)

Nov 3, 2026 · @wei · แทนที่ v1 (Oct 14, 2026)

**จุดยืนใหม่:** TMS แบบ **Standalone เป็นสินค้าหลัก** — บริษัทขนส่งที่ไม่มี ERP สมัครแล้วใช้ได้ทันที ตั้งแต่รับงาน จัดรถ ไปจนถึงออกใบวางบิล ใบแจ้งหนี้ ใบกำกับภาษี ใบเสร็จ ใบลดหนี้/เพิ่มหนี้ และ 50 ทวิ ให้รถร่วมภายในระบบเอง ส่วน **ERP/โปรแกรมบัญชี connector เป็น add-on** (KRS ตัวแรก, FlowAccount และ PEAK ผ่าน API, Express ผ่าน file export) **KRS คือ pilot customer** ที่พิสูจน์ connector framework ไม่ใช่ศูนย์กลางของสินค้า

สิ่งที่เปลี่ยนจาก v1: (1) สลับลำดับ — v1 มอง "KRS ก่อน แล้วค่อยเปิด standalone"; v2 ทำ standalone core กับ KRS pilot พร้อมกัน เพราะ KRS เองก็ต้องใช้ core เดียวกัน (2) ย้าย ePOD, reason code, วางบิล และเอกสารภาษีลงมาอยู่ tier แรกทั้งหมดตามบทเรียน X2 (3) เพิ่มกลุ่มลูกค้า "มีโปรแกรมบัญชีไทย" ที่ v1 มองข้าม ซึ่งน่าจะเป็นกลุ่มใหญ่สุดของตลาด SME (4) e-Tax Invoice เป็น add-on ผ่าน service provider ไม่เขียน XML/XAdES เอง

ราคาทุกตัวในเอกสารนี้เป็น **ตัวเลขตั้งต้นเพื่อตัดสินใจ** ยังไม่ทดสอบกับตลาด ผู้เล่นไทยทุกรายไม่ประกาศราคา (research ข้อ 2.1) จึงไม่มี benchmark ตรง

## 1. Positioning และกลุ่มลูกค้า

**ประโยคขาย:** "ระบบขนส่งที่ปิดงานถึงใบกำกับภาษีได้ในที่เดียว — ไม่ต้องมี ERP, แต่ถ้ามีก็เชื่อมได้"

**ทำไมถึงเปลี่ยนมา standalone-first**

- ตลาดเป้าหมาย (ขนส่งทางบกไทย 10–200 คัน) ส่วนใหญ่ไม่มี ERP — มีแค่ Express/FlowAccount/PEAK หรือ Excel กับสำนักงานบัญชี ถ้าสินค้าต้องพึ่ง ERP connector ก่อนใช้ จะขายได้แค่กลุ่มเล็กสุด
- ผู้เล่นไทยที่ขายกลุ่มนี้ (Treasure, Logis Boy, Hublink) ล้วนชูจุดขาย "ปิดงานแล้วออกใบวางบิล/ใบเสร็จ/หัก ณ ที่จ่ายได้เลย" ไม่มีเจ้าไหนชู ERP integration และไม่มีเจ้าไหนบอกชื่อโปรแกรมบัญชีไทยที่เชื่อมได้ — ช่องว่างคือ "วางบิลในระบบได้ครบ **และ** ส่งเข้าโปรแกรมบัญชีที่ลูกค้าใช้อยู่ได้"
- KRS ต้องใช้ core เดียวกันอยู่ดี (DO, Trip, Invoice, state machine) ต่างกันแค่ `tenant_erp_connection` มีแถวหรือไม่ — จึงไม่มีต้นทุนเพิ่มที่จะทำ standalone พร้อมกัน

**กลุ่มลูกค้า 3 กลุ่ม**

| กลุ่ม | ลักษณะ | สิ่งที่เขาต้องการจาก TMS | สิ่งที่ขาย | ส่วนแบ่งคาดการณ์ |
| --- | --- | --- | --- | --- |
| A — ไม่มี ERP | ขนส่ง 5–50 คัน ใช้ Excel + สำนักงานบัญชี หรือออกใบกำกับด้วย Word | ออกเอกสารขาย/จ่ายรถร่วมครบในระบบ กันวางบิลซ้ำ/หลุด ส่งรายงานให้สำนักงานบัญชีปลายเดือน | **Standalone** (Starter/Growth) + export Excel/CSV ให้สำนักงานบัญชี | ~50% |
| B — มีโปรแกรมบัญชีไทย | ขนส่ง 10–100 คัน บัญชีใช้ FlowAccount / PEAK / Express อยู่แล้ว | TMS ออกเอกสารขนส่งและใบวางบิล แล้วส่งใบกำกับ/ใบเสร็จเข้าโปรแกรมบัญชีโดยไม่คีย์ซ้ำ | Standalone + **Accounting connector add-on** (API หรือ file export) | ~35% |
| C — มี ERP เฉพาะ | ขนส่ง 50–200+ คัน หรือบริษัทในเครือที่ใช้ KRS / SAP B1 / ERP ที่ทำเอง | TMS เป็น system of record ของงานขนส่ง, ERP เป็นเจ้าของบัญชี/VAT, ต้อง reconcile สองฝั่ง | Business/Enterprise + **ERP connector add-on** + setup fee | ~15% |

**ขอบเขตที่ไม่ทำ:** ไม่เป็นโปรแกรมบัญชี (ไม่มีผังบัญชี, ไม่ปิดงบ, ไม่ยื่น ภ.พ.30 ให้) — ออกเอกสารฝั่งขายและฝั่งจ่ายรถร่วมได้ครบตามกฎหมาย แล้ว export หรือ sync ไปให้บัญชีทำต่อ กลุ่ม A ที่โตขึ้นจะย้ายไปกลุ่ม B โดยไม่ต้องเปลี่ยน TMS

## 2. รูปแบบขายและ tier

**หลักการ 4 ข้อ** (ตอบบทเรียน X1, X2 จาก research)

| หลักการ | ทำอย่างไร | เหตุผล |
| --- | --- | --- |
| คิดต่อ **รถ active** ไม่ใช่ต่อ user | รถ active = รถที่มี Trip อย่างน้อย 1 เที่ยวในเดือนนั้น (รวมรถร่วมที่รับงานผ่านระบบ) นับท้ายเดือนจาก `tenant_usage_monthly` | Dashdoc/OptimoRoute คิดตาม active จริง; ลูกค้าขนส่งนับรถเป็น ไม่ควรถูกลงโทษที่ให้ทั้งทีมใช้ |
| User ไม่จำกัดทุก tier | รวม dispatcher, บัญชี, คนขับ, รถร่วม, ลูกค้าที่เข้า portal | Alvys / Rose Rocket ทำแบบนี้ และ adoption ของ frontline คือจุดที่ TMS ล้มบ่อยสุด |
| ไม่มีสัญญาผูก | รายเดือนยกเลิกได้ทุกเดือน; รายปีเป็นส่วนลดไม่ใช่เงื่อนไข; เพิ่ม/ลดรถกลางเดือนคิดตามจริงเดือนถัดไป | X1: Cartrack สัญญา 3 ปี + ค่าปรับ, Track-POD เก็บเต็มปีเมื่อเพิ่มคนขับ คือคำบ่นอันดับต้น |
| Trial 30 วัน ไม่ต้องใส่บัตร | เปิดครบทุกฟีเจอร์ของ Growth, รถไม่เกิน 20 คัน, มีข้อมูลตัวอย่างบริษัทขนส่งไทยให้ลองทันที | Logis Boy ให้ 1 เดือน, OptimoRoute 30 วัน — เป็นมาตรฐานที่ตลาดคุ้น; Treasure ให้แค่ 15 วัน |

**ตาราง tier** (ราคาตั้งต้น บาท/รถ active/เดือน ไม่รวม VAT)

| | Starter | Growth | Business | Enterprise |
| --- | --- | --- | --- | --- |
| จำนวนรถ active | 1–15 | 16–60 | 61–200 | 200+ |
| ราคา/รถ/เดือน | 350 | 280 | 220 | ตกลงรายปี |
| ขั้นต่ำ/เดือน | 2,500 | 4,500 | 13,500 | — |
| รายปีจ่ายล่วงหน้า | −15% | −15% | −15% | ตามสัญญา |
| User | ไม่จำกัด | ไม่จำกัด | ไม่จำกัด | ไม่จำกัด |
| นิติบุคคล/สาขาใน tenant | 1 นิติบุคคล 1 สาขา | 1 นิติบุคคล หลายสาขา | หลายนิติบุคคล | หลายนิติบุคคล |
| **Core ขนส่ง** — DO/Trip/ใบคุมรถ, planning board, รถบริษัท + รถร่วม, rate card ขาย/ซื้อ, ใบค้าง + reason code, Excel import | ✓ | ✓ | ✓ | ✓ |
| **ePOD** — web POD โดยแอดมิน, ลิงก์อัปโหลด POD สำหรับรถร่วมไม่มีแอป, tracking link สาธารณะ | ✓ | ✓ | ✓ | ✓ |
| **เอกสารขาย** — ใบวางบิล, ใบแจ้งหนี้, ใบกำกับภาษีเต็มรูป, ใบเสร็จ, ใบลดหนี้/เพิ่มหนี้, ใบแทน; PDF ไทย ปี พ.ศ.; เลขรันต่อ (ประเภท, สาขา) | ✓ | ✓ | ✓ | ✓ |
| **จ่ายรถร่วม/คนขับ** — settlement, หัก ณ ที่จ่าย 1%, ออก 50 ทวิ, เงินเบิกล่วงหน้า, ใบสำคัญจ่าย | ✓ | ✓ | ✓ | ✓ |
| **Export ให้บัญชี** — Excel/CSV รายงานภาษีขาย, ภ.ง.ด.3/53, สรุปค่าเที่ยว | ✓ | ✓ | ✓ | ✓ |
| รายงานกำไรต่อเที่ยว/ลูกค้า/รถ + ส่งรายงานตามเวลา (อีเมล/LINE) | พื้นฐาน | ✓ | ✓ | ✓ |
| Approval flow (ราคา, settlement), permission ระดับ field (ซ่อนราคาขายจาก dispatcher) | — | ✓ | ✓ | ✓ |
| Customer portal (ลูกค้าสร้างงาน, ค้นด้วย PO) | — | ✓ | ✓ | ✓ |
| **Open API — อ่าน** (DO/Trip/Invoice status, webhook ขาออก) | — | ✓ | ✓ | ✓ |
| **Open API — เขียน** (upsert order ด้วย external id, สร้าง invoice, webhook ขาเข้า) | — | — | ✓ | ✓ |
| SSO, audit log export, data residency/private cloud, custom connector | — | — | — | ✓ |
| Support | ศูนย์ช่วยเหลือ + อีเมล 2 วันทำการ | + in-app chat 1 วันทำการ | + SLA ตอบ 4 ชม. ทำการ | 24×7 ตามสัญญา |

**ทำไมเส้นแบ่ง tier เป็นแบบนี้**

- ทุกอย่างที่ลูกค้า "ต้องมีเพื่อปิดเดือน" อยู่ Starter — ePOD, reason code, วางบิล, เอกสารภาษี, 50 ทวิ ถ้าล็อกไว้ tier สูง ลูกค้ากลุ่ม A จะรู้สึกโดนบีบแบบที่รีวิว Track-POD/Onfleet บ่น (X2) และจะไปใช้ Word ออกใบกำกับต่อ
- สิ่งที่แยก tier คือ **ขนาดองค์กร** (หลายสาขา, หลายนิติบุคคล, approval, permission ละเอียด) และ **การเชื่อมต่อ** (API) ไม่ใช่ฟีเจอร์การทำงานประจำวัน
- Open API แยกอ่าน/เขียน: **อ่านที่ Growth** เพราะลูกค้า Growth มักถูกลูกค้าของเขา (shipper) ขอสถานะงานไปขึ้น dashboard; **เขียนที่ Business** เพราะการรับ order จากระบบภายนอกต้องมี idempotency, mapping และ support ที่หนักกว่า — และ connector add-on ทุกตัวสร้างบน API ชุดเดียวกันนี้
- ลด Starter เหลือ 15 คัน (v1: 10) และ Growth ถึง 60 (v1: 50) ให้ขั้นต่ำต่อเดือนสมเหตุสมผลกับงานซัพพอร์ต

## 3. Add-on

หลัก: add-on ต้อง "เพิ่มมูลค่า" ไม่ใช่ปลดล็อกของพื้นฐาน (X2) ทุก add-on เปิด/ปิดได้ต่อ tenant ผ่าน feature flag + `tenant_erp_connection` ไม่ต้องย้ายข้อมูล

### 3.1 ERP / โปรแกรมบัญชี connector

แยกราคาตาม **รูปแบบการเชื่อม** เพราะต้นทุนดูแลต่างกันคนละระดับ

| รูปแบบ | ตัวอย่าง | สิ่งที่ทำ | ราคาตั้งต้น | Setup | Tier ต่ำสุด |
| --- | --- | --- | --- | --- | --- |
| **File export** (ทางเดียว) | Express (CSV/Excel ตาม template), สำนักงานบัญชีทั่วไป | ส่งออกใบกำกับ/ใบเสร็จ/ใบลดหนี้/ค่าเที่ยวรถร่วมเป็นไฟล์ตาม template ของโปรแกรมปลายทาง; mark "export แล้ว" กันส่งซ้ำ | **1,000 บาท/เดือน** หรือรวมใน Growth+ ฟรี | ไม่มี (ลูกค้าเลือก template เอง) | Starter |
| **API connector — โปรแกรมบัญชี cloud** (สองทาง) | FlowAccount Open API, PEAK API | สร้างใบกำกับ/ใบเสร็จ/ใบลดหนี้ตรงเข้าโปรแกรมบัญชี, sync ผู้ติดต่อและสินค้า/บริการ, ดึงสถานะรับชำระกลับมา reconcile, error queue + retry ที่ลูกค้าดูเอง | **2,000 บาท/เดือน/connector** | 5,000 บาท (mapping รายการค่าใช้จ่าย ↔ สินค้า/บริการ, ทดสอบใน sandbox) | Growth |
| **API connector — ERP** (สองทาง + master จาก ERP) | KRS (ตัวแรก), SAP B1 Service Layer | เหมือนข้างบน + ดึง master (ลูกค้า, ผังบัญชี, VAT code) จาก ERP, routing ตามนิติบุคคล, reconcile งวดบัญชี, `syncFromDate` | **4,000 บาท/เดือน/connector** | 25,000 บาท (field mapping, master code, UAT กับ ERP ของลูกค้า) | Business |
| **Custom connector** | ERP ที่ลูกค้าทำเอง, ระบบ WMS | ตามขอบเขต | คิดตามงาน + 4,000/เดือน ดูแล | ประเมินรายโครงการ | Enterprise |

หมายเหตุสำคัญจาก research ภาษี:

- FlowAccount API ต้องแพ็กเกจ **Pro Business** ฝั่งลูกค้า; PEAK API ต้อง **Pro Plus** ขึ้นไป — ต้องบอกลูกค้าก่อนขาย ไม่ใช่ค่าใช้จ่ายของเรา แต่กระทบการตัดสินใจ
- ใช้ API สร้าง Tax Invoice/Receipt ตรง ๆ กับ FlowAccount เท่านั้น เพราะไฟล์ import ของ FlowAccount รองรับแค่เอกสารขายเงินสด (CA)
- **Express:** ไม่พบ API สาธารณะและ format import ทางการ — ต้องยืนยันกับ ESG หรือทดสอบกับสำนักงานบัญชีจริง **ก่อนโฆษณาว่า "export เข้า Express ได้"** ระหว่างนี้ขายเป็น "export Excel ตาม template ที่สำนักงานบัญชีกำหนด"
- ลำดับทำ connector: FlowAccount → PEAK → CSV generic → SAP B1/Xero เมื่อมีลูกค้าจ่ายจริง (ไม่ทำล่วงหน้า)

### 3.2 e-Tax Invoice & e-Receipt

| หัวข้อ | แนวทาง |
| --- | --- |
| จุดยืน | **ไม่เขียน XML (ขมธอ.3-2560) + XAdES เอง** เก็บ data model ให้ map เป็น CII ได้ (TXID 13 หลัก + รหัสสาขา, lines, tax breakdown, reference doc) แล้วส่งผ่าน **service provider** ที่ลงนามแทนด้วย certificate ของ SP (ขึ้นทะเบียน บ.อ.01 แบบ ข. ลูกค้าไม่ต้องมี USB token เอง) |
| ทางเลือกลูกค้า | (ก) ลูกค้าใช้ FlowAccount/PEAK อยู่แล้ว → ส่ง e-Tax ผ่าน connector ข้อ 3.1 ให้โปรแกรมบัญชีจัดการ (PEAK ต่อ INET/Leceipt อยู่แล้ว) — ไม่ต้องซื้อ add-on นี้ (ข) ลูกค้า standalone → add-on e-Tax ผ่าน SP ที่เราเป็น partner (INET หรือ Leceipt ตัวแรก) |
| ราคาตั้งต้น | **ค่าเปิดใช้ 3,000 บาท** (ช่วยยื่น บ.อ.01, ตั้งค่าสาขา, ทดสอบ validation) + **ค่าบริการ SP ส่งต่อตามจริง** (per document ตามที่ SP เรียกเก็บ, บวก margin 0 ในเฟสแรก) — เพราะ research ไม่พบราคาสาธารณะของ SP ใด จึงยังตั้งราคารวมไม่ได้ |
| ข้อควรระวัง | e-Tax by Email (Time Stamp) จำกัดรายได้ ≤ 30 ล้าน และใช้ได้ระบบเดียว — ให้ลูกค้าถามนักบัญชีก่อนเลือก; ห้ามลบ record ต้องแก้ด้วยรายการปรับปรุงเห็นค่าก่อน/หลัง (กระทบ design ของ `invoice` immutability) ; มีมาตรการหักรายจ่าย 200% ปี 2569–2570 ใช้เป็นจุดขายได้แต่ต้องกำกับว่ารอกฎหมายออก |
| เฟส | หลังเปิด standalone (เฟส 1 ปลาย–เฟส 2) เมื่อมีลูกค้าถามจริง ≥ 3 ราย |

### 3.3 GPS connector และ Driver app

| Add-on | ราคาตั้งต้น | ขอบเขต | เฟส |
| --- | --- | --- | --- |
| GPS/Telematics connector | 1,500 บาท/เดือน/ค่าย GPS (ไม่จำกัดจำนวนรถในค่ายนั้น) | ดึงพิกัด/arrive-depart จากกล่องตามกฎ DLT ที่ลูกค้ามีอยู่ มาคำนวณค่ารอ, geofence เตือน, ETA — ไม่ติดตั้งกล่องเอง | 3 |
| Driver app (ePOD บนมือถือ) | 80 บาท/คนขับ active/เดือน (คงเดิม) | แอปคนขับ 9 จอ M1–M9 ตามสเปก Functional Requirements **E2**: login OTP, งานวันนี้, รายละเอียดงาน, POD (รูป+พิกัด+timestamp, เซ็นรับ, Actual Qty + reject reason, ตีกลับบางส่วน), แจ้งปัญหา, DVIR, เบิกเงิน/น้ำมัน, ของฉัน; offline-first ทุก action; **ลิงก์รถร่วม (M10) ฟรี อยู่ใน Starter ตั้งแต่เฟส 0** | **2** (ยกจากเฟส 3 — decision 2026-11-04) |
| Custom report / Digital transformation | คิดตามงาน | เหมือน v1 | ทุกเฟส |

Driver app เป็น add-on ได้โดยไม่ขัด X2 เพราะ **ePOD พื้นฐาน (web + ลิงก์อัปโหลด) อยู่ Starter แล้ว** app คือความสะดวกเพิ่มสำหรับคนขับประจำ ไม่ใช่เงื่อนไขในการปิดงาน

## 4. Multi-tenant + หลายนิติบุคคล/สาขาใน tenant เดียว

**Multi-tenant** (คงจาก v1 — ไม่ทำ build แยกต่อลูกค้า ตาม X13)

| หลักการ | รายละเอียด |
| --- | --- |
| Shared schema + `tenant_id` ทุกตาราง | รวม `erp_doc_map`, `erp_outbox`, `erp_sync_log`; ตารางระดับ platform มีแค่ `tenant`, `plan`, `platform_user`, `tenant_usage_monthly` |
| บังคับที่ DB | PostgreSQL RLS ผูกกับ `current_setting('app.tenant_id')` + Prisma extension ใส่ `tenant_id` อัตโนมัติ; unique เป็น `(tenant_id, doc_no)` |
| Config ต่อ tenant | feature flag ตาม plan + override ราย tenant (ตรวจซ้ำใน cron), ERP adapter, API key (เข้ารหัส), เลขรันเอกสาร, timezone, branding — ใน `tenant_setting` jsonb |
| Fairness | outbox worker / poller / งานออก PDF หยิบงาน round-robin ตาม tenant |
| Standalone vs connector | ต่างกันแค่ `tenant_erp_connection` มีแถวหรือไม่; `StandaloneProvider` = no-op; เปิด connector ทีหลังได้โดยไม่ย้ายข้อมูล |
| PDPA / ปิด tenant | soft-delete 90 วัน → purge; export ให้ลูกค้าก่อน; ข้อมูลคนขับเก็บเท่าที่จำเป็น |
| Enterprise แยกฐาน | schema-per-tenant หรือ private deployment ภายหลัง — โค้ดเดียวกันรองรับได้เพราะมี `tenant_id` อยู่แล้ว |

**หลายนิติบุคคล/หลายสาขาใน tenant เดียว** (ใหม่ใน v2 — จาก P9, I9 และ ภ.พ.20)

| ประเด็น | แนวทาง |
| --- | --- |
| โมเดล | `tenant` (องค์กรที่จ่ายเงินให้เรา) → `legal_entity` (นิติบุคคล: เลขผู้เสียภาษี 13 หลัก, ชื่อ, ที่อยู่จดทะเบียน) → `branch` (รหัสสาขา 5 หลักตาม ภ.พ.20: `00000` สำนักงานใหญ่, `00001`…) |
| เอกสารภาษี | ใบกำกับภาษี/ใบเสร็จ/ใบลดหนี้ทุกใบผูกกับ `branch` ที่ออก → หัวกระดาษ ชื่อ-ที่อยู่-สาขา และ TXID+รหัสสาขาใน e-Tax ถูกต้องอัตโนมัติ; **เลขรันแยกต่อ (legal_entity, branch, ประเภทเอกสาร, งวด)** |
| ผู้ซื้อ | ลูกค้าแต่ละรายเก็บเลขผู้เสียภาษี + รหัสสาขาที่รับใบกำกับ (บุคคลธรรมดาใช้เลขบัตร, ต่างชาติใช้ passport) |
| Rate card / งาน | งานหนึ่งเลือก "ออกบิลในนาม" (Invoice As) ได้ตามสัญญาลูกค้า; รถและคนขับใช้ร่วมกันข้ามนิติบุคคลใน tenant เดียว |
| ERP routing | 1 `branch` หรือ 1 `legal_entity` ↔ 1 company ใน ERP (KRS มีหลายบริษัทในเครือ) กำหนดใน `tenant_erp_connection.config` |
| Tier | Starter = 1 นิติบุคคล 1 สาขา; Growth = 1 นิติบุคคล หลายสาขา; Business+ = หลายนิติบุคคล — เป็นเส้นแบ่ง tier ที่สะท้อนขนาดองค์กรจริง |
| สิทธิ์ | role จำกัดขอบเขตได้ที่ระดับ branch (ฝ่ายวางบิลสาขา A เห็นเฉพาะเอกสารสาขา A) |

## 5. Portal 2 ชั้น

แยกเป็น 2 route group ใน codebase เดียว (login แยก) เพราะสิทธิ์และ audit ต่างระดับกัน หลักการจาก X5: **ทุก setting ที่ลูกค้าตั้งเองได้ต้องตั้งได้จาก UI** ทีม Innovera แตะเฉพาะที่ต้องใช้ credential หรือ mapping เชิงเทคนิค

**Innovera Admin Portal** (`admin.<domain>`, บังคับ 2FA)

| หน้า | ทำอะไร |
| --- | --- |
| Tenants | สร้าง/ระงับ/ปิด, เปลี่ยน tier และ quota รถ, แปลง trial → paid, impersonate พร้อม audit |
| Connectors | เปิด-ปิด connector ต่อ tenant, ใส่/หมุน API key (เข้ารหัส), healthCheck, ดู outbox/sync log ข้าม tenant, อนุมัติ connector ที่ลูกค้าขอเปิดเองจาก marketplace |
| Usage & Billing | รถ active, DO, Invoice, API calls, เอกสาร e-Tax ต่อเดือนต่อ tenant → ออกใบแจ้งหนี้ของเราเอง (เฟสแรก export CSV ออกบิลมือจนถึง 10 tenant) |
| Health | คิวค้าง, MISMATCH เปิดอยู่, poller ล่าสุด, error rate 7 วัน ต่อ tenant |
| Feature flags | เปิดฟีเจอร์ทดลองรายลูกค้า |
| Audit log | ทุก action ของทีม Innovera บนข้อมูลลูกค้า |

**หน้าองค์กรของลูกค้า** (ใน TMS, role `tenant_owner` / `tenant_admin`)

| หน้า | ทำอะไร | เฟส |
| --- | --- | --- |
| ผู้ใช้และสิทธิ์ | เชิญ user, role เริ่มต้น (เจ้าของ / ผู้จัดการ / dispatcher / ฝ่ายวางบิล / บัญชี / คนขับ / รถร่วม / ลูกค้า) แก้ permission `{module}.{view\|manage}` เองได้, จำกัดขอบเขตสาขา | 0–1 |
| นิติบุคคลและสาขา | เพิ่มนิติบุคคล/สาขาตาม ภ.พ.20, โลโก้, ที่อยู่บนใบ, prefix และเลขรันต่อสาขา, ลายเซ็นผู้มีอำนาจ | 0–1 |
| รถและคนขับ | ทะเบียน, ประเภท, รถบริษัท/รถร่วม, คนขับ 3 แบบ (รถร่วม / มีเงินเดือน / รายเที่ยว); รถ active เทียบ quota | 0–1 |
| ลูกค้าและ rate card | ลูกค้าที่วางบิล (เลขผู้เสียภาษี + สาขา), ราคาขาย/ราคาซื้อ, รอบวางบิล, POD ที่ต้องการต่อลูกค้า, Excel import พร้อม dry-run | 0–1 |
| Reason master | เหตุผลงานค้าง/ส่งไม่สำเร็จ/ปฏิเสธ แก้เองได้ มีชุดเริ่มต้นภาษาไทย | 0–1 |
| **การเชื่อมต่อ (Marketplace)** | เฟส 0–1: ดูสถานะ connector, ทดสอบ, ดู error queue + retry ของตัวเอง — **API key และ mapping ครั้งแรก Innovera ตั้งให้** (รวมใน setup fee) · เฟส 2: ลูกค้ากด "เปิดใช้ FlowAccount/PEAK" ใส่ credential เอง → หน้า mapping ค่าใช้จ่าย ↔ สินค้า/บริการ → ทดสอบ sandbox → เปิดใช้ โดยไม่ต้องเปิด ticket; ERP connector (KRS, SAP B1) ยังผ่าน Innovera ต่อไป | 0–2 |
| Open API | สร้าง/หมุน API key, เลือก scope อ่าน/เขียนตาม tier, ตั้ง webhook URL, ดู request log | 2 |
| แผนและการชำระเงิน | tier, รถที่ใช้/ซื้อ, add-on ที่เปิด, วันหมดอายุ, ประวัติบิล, ขออัปเกรด | 1 |

## 6. Mobile application

มีเฉพาะ **แอปคนขับ (ePOD)** ส่วนวางแผน วางบิล และ portal ทั้งสองชั้นเป็น web responsive เหตุผลเดิมจาก research: TMS ล้มที่ frontline adoption — คนขับคือผู้ป้อนสถานะจริง **สเปกเต็ม (10 จอ M1–M10 + ข้อกำหนดเทคนิค + ผลกระทบต่อโมดูลอื่น) อยู่ที่ Functional Requirements หัวข้อ E2** เอกสารนี้เก็บเฉพาะเฟสและราคา — decision 2026-11-04: เลื่อนแอปคนขับจากเฟส 3 มาเฟส 2 และแยกลิงก์รถร่วม (M10) ออกมาเป็นเฟส 0 เพราะไม่ต้องมีแอป

| เฟส | การยืนยัน DO | หมายเหตุ | ที่มา |
| --- | --- | --- | --- |
| 0 | แอดมิน/หน้าคลังกรอกผ่านเว็บ **+ M10 ลิงก์รถร่วม (web ไม่ต้อง login)**: รับ/ปฏิเสธข้อเสนองาน + อัปโหลด POD ด้วยเลข DO | วิธีที่ KRS ทำอยู่; DO state machine รองรับทุกทางตั้งแต่แรก; ลิงก์ทำให้ Starter มี ePOD จริงตาม X2; ฟรี ไม่ใช่ add-on | E2 M10 (P0), decision 2026-11-04 |
| 1 | เหมือนเฟส 0 | — | — |
| **2** | **Driver app M1–M9** (Android ก่อน, iOS ตาม) | add-on **80 บาท/คนขับ active/เดือน (คงเดิม)**; M7 DVIR เป็น P2 ปล่อยตามหลังใน release ถัดไปได้; รถร่วมใช้ลิงก์ M10 ฟรีต่อไป | E2 (P1), decision 2026-11-04 |
| 3 | ขยาย: iOS ครบ, DVIR, ภาษาเมียนมา/กัมพูชา, GPS connector ค่ายที่ 2+ | — | E2 M7, M9 |

**ขอบเขต Driver app (เฟส 2) — สรุปจาก E2**

- 9 จอ: M1 login OTP (ไม่มีรหัสผ่าน, จำเครื่อง 30 วัน) · M2 งานวันนี้ · M3 รายละเอียดงาน (stepper จุด, นำทาง, โทร, ปุ่มตามขั้น) · M4 POD (checklist ต่อลูกค้า, รูปฝัง timestamp+พิกัด, ลายเซ็น, actual qty, ส่งไม่สำเร็จ) · M5 สำเร็จ + banner offline · M6 แจ้งปัญหา → WO/incident อัตโนมัติ · M7 DVIR (P2) · M8 เบิกเงิน/น้ำมัน · M9 ของฉัน (สรุปเดือน, ใบจ่าย, ใบขับขี่, ภาษา)
- **Offline-first ทุก action** — optimistic UI + outbox queue, `clientEventId` (UUID) + `occurredAt` + GPS/accuracy จากเครื่อง, server idempotent, sync batch `POST /driver/events`
- เบา กินแบตน้อย รองรับเครื่องเก่า **Android 8+** (บทเรียน NOSTRA ePOD 3.4 ดาว, Locus กินแบต): GPS adaptive เฉพาะเมื่อใกล้จุด, background location ตาม OS, รูปบีบอัด ≤ 1 MB/ใบ — กล่อง GPS ตามกฎ DLT ทำหน้าที่ tracking ผ่าน GPS connector
- ปุ่มใหญ่ (ปุ่มหลัก 56 px, target ≥ 48 px, ตัวอักษร 16 px) ภาษาไทยล้วน ขั้นตอนน้อย ทำ usability test กับคนขับจริงก่อนปล่อย
- geofence เป็นคำเตือน + บังคับใส่เหตุผล ไม่บล็อก (พิกัดลูกค้าไทยมักไม่แม่น)
- ใช้ Open API ชุดเดียวกับ web (scope `driver`) — ไม่มี backend แยก

**เทคโนโลยี:** cross-platform ตัวเดียว (Flutter หรือ React Native — ยังไม่เลือก) — คนขับไทยใช้ Android เป็นหลัก ปล่อย Android ก่อน iOS; M10 เป็น web responsive ธรรมดาเปิดใน LINE ได้ ไม่ต้องติดตั้ง

- [ ] เลือก Flutter / React Native ก่อนเริ่มเฟส 2 (เกณฑ์อยู่ใน Functional Requirements E2.2)

## 7. Roadmap ขาย 4 เฟส

เปลี่ยนจาก v1: standalone core ไม่รอ KRS จบ — ทำพร้อมกันเพราะเป็นโค้ดเดียวกัน; connector ตัวที่สองเป็น FlowAccount/PEAK (ตลาดกว้าง, API สาธารณะ, sandbox ฟรี) ไม่ใช่ ERP ตัวที่สอง

| เฟส | ช่วง | เป้าหมาย | สิ่งที่ต้องมี | เกณฑ์ผ่าน |
| --- | --- | --- | --- | --- |
| **0 — KRS pilot + Standalone core** | เริ่ม → +3 เดือน | KRS ใช้จริง 1 tenant ปิดงวดผ่าน reconcile **และ** standalone ใช้ออกเอกสารภาษีครบใน tenant ทดสอบ (บริษัทขนส่งใกล้ตัว 1–2 ราย ใช้ฟรี) | Core DO/Trip/Invoice + state machine; เอกสารขาย 6 ชนิด + 50 ทวิ เป็น PDF ไทย; นิติบุคคล/สาขา; connector framework (port/adapter, ExternalMapping, outbox, error queue) + `KrsAdapter` + `StandaloneProvider`; admin portal ขั้นต่ำ (tenant, connector, health); หน้าองค์กรลูกค้า 5 หน้าแรก; **M10 ลิงก์รถร่วมไม่ต้อง login (รับ/ปฏิเสธงาน + POD ด้วยเลข DO — E2, P0)** | KRS ปิดงวด 2 เดือนติด MISMATCH ค้าง = 0; tenant standalone ออกใบกำกับ+50 ทวิ ครบ 1 รอบเดือนโดยนักบัญชีของเขายอมรับ |
| **1 — เปิดขาย Standalone + Accounting connector** | ถัดไป 3–4 เดือน | ลูกค้าจ่ายจริง 8 ราย (กลุ่ม A 5, กลุ่ม B 3) | trial flow อัตโนมัติ 30 วัน; ออกบิลเราเองจาก usage (มือ); FlowAccount connector → PEAK connector (API, ตาม template connector framework); export Excel/CSV generic; help center ไทย step-by-step; ราคาสาธารณะบนเว็บ | trial → paid ≥ 30%; setup connector FlowAccount/PEAK ให้ลูกค้าใหม่ ≤ 3 วันทำการ; ticket ต่อ tenant ต่อเดือน ≤ 2 |
| **2 — Open API สาธารณะ + Partner + Marketplace + Driver app** | เดือน 8–12 | ลูกค้ากลุ่ม B/C เปิด connector เองได้; มี partner ขาย 2 ราย (สำนักงานบัญชี, ผู้ขาย GPS); **คนขับประจำของลูกค้า Growth+ ปิดงานผ่านแอป** | API docs สาธารณะ (อ่าน Growth / เขียน Business) + sandbox; marketplace ให้ลูกค้าใส่ credential FlowAccount/PEAK เอง; e-Tax add-on ผ่าน SP ตัวแรก; ERP ตัวที่สอง (SAP B1) เมื่อมีลูกค้า Business จ่ายจริง; partner program ส่วนแบ่ง 15–20% ปีแรก; **Driver app M1–M9 (Android ก่อน) offline-first บน Open API scope `driver` ตาม E2 — add-on 80 บาท/คนขับ/เดือน** (ยกจากเฟส 3 — decision 2026-11-04) | connector ใหม่ setup ≤ 15 วันทำการ; ≥ 50% ของ connector ใหม่เปิดโดยลูกค้าเองไม่เปิด ticket; MRR 20 tenant; **Driver app: คนขับปิด stop ได้ใน ≤ 4 ขั้นใน usability test, event sync สำเร็จ ≥ 99.5%** |
| **3 — GPS + iOS + ขยาย** | ปีที่ 2 | GPS connector, Driver app iOS ครบ + DVIR (M7), รถร่วมหลายผู้รับเหมา (cascade P1→P2), optimizer เบื้องต้น | GPS connector ≥ 2 ค่าย, settlement dispute flow, Driver app iOS + DVIR + ภาษาเพิ่ม | ARR ครอบคลุมต้นทุนทีม; Driver app ≥ 4.3 ดาว; attach rate add-on ≥ 40% ของ tenant Growth+ |

**ตัวเลขรายได้ตั้งต้น** (เพื่อเห็นภาพ ไม่ใช่ forecast): tenant Growth เฉลี่ย 30 คัน × 280 = 8,400 บาท/เดือน; ถ้า 40% ซื้อ accounting connector (+2,000) → ARPU ≈ 9,200 บาท/เดือน; 20 tenant ปลายเฟส 2 ≈ 184,000 บาท/เดือน (MRR) ก่อน ERP connector และ setup fee

## 8. สิ่งที่ต้องตัดสินใจ

**ราคาและการนับ**

- [ ] ยืนยันตัวเลขต่อรถ 350/280/220 — ขอใบเสนอราคาจริงจาก Treasure, Logis Boy, NOSTRA (ไม่มีราคาสาธารณะ) มาเทียบก่อนประกาศ
- [ ] นิยาม "รถ active" = มี Trip ในเดือน — รถร่วมที่รับงานผ่านลิงก์นับเป็น active หรือไม่ และคิดเต็มหรือครึ่งราคา (เสนอ: นับ แต่คิดครึ่ง 50% เพื่อจูงใจให้เอารถร่วมเข้าระบบ)
- [ ] File export ให้ฟรีใน Growth+ หรือเก็บ 1,000 ทุก tier (เสนอ: ฟรี Growth+ เพื่อดันอัปเกรดจาก Starter)
- [ ] Open API เขียนที่ Business ตามเสนอ หรือเปิดที่ Growth แต่คิด add-on — จะกระทบว่า connector FlowAccount/PEAK (ซึ่งเขียนข้อมูล) ขายให้ Growth ได้โดยไม่ขัดกัน (เสนอ: connector ที่เราทำขายได้ตั้งแต่ Growth, API เขียนตรงเริ่ม Business)

**Connector และภาษี**

- [ ] KRS คิดราคาเท่าไรในฐานะ pilot — เสนอ: ฟรี ERP connector 12 เดือน + Business tier ลด 50% แลก reference + case study + สิทธิ์ใช้ชื่อ
- [ ] เลือก service provider e-Tax ตัวแรก (INET vs Leceipt vs ธนาคาร) และขอราคาต่อเอกสารเป็นลายลักษณ์อักษร — ไม่มีราคาสาธารณะเลย
- [ ] ยืนยันกับ ESG ว่า Express นำเข้าใบกำกับจาก Excel/CSV ได้ด้วยวิธีใด ก่อนใช้คำว่า "รองรับ Express" ในสื่อขาย
- [ ] คำถามนักบัญชีก่อน freeze schema (จาก thai-tax-docs-research 6.2): เกณฑ์ 30 ล้านของ e-Tax by Email ปัจจุบัน, ใบกำกับออกวันไหนสำหรับบริการขนส่ง, การยกเว้น VAT ขนส่งในประเทศกรณีใดกระทบลูกค้าเรา

**สินค้าและแบรนด์**

- [ ] ชื่อผลิตภัณฑ์และโดเมน (แยกจาก innoveraappcenter หรือไม่) — ต้องมีก่อนเปิด trial สาธารณะเฟส 1
- [ ] ออกบิลลูกค้าเองด้วยมือจนถึง 10 tenant ตามเสนอ หรือทำ billing อัตโนมัติตั้งแต่เฟส 1
- [ ] tenant standalone ทดสอบในเฟส 0 เป็นใคร (ต้องเป็นบริษัทขนส่งจริงที่ยอมให้นักบัญชีของเขาตรวจเอกสารที่ระบบออก)
- [ ] เฟส 2 ERP ตัวที่สองเป็น SAP B1 ตามเสนอ หรือรอดูว่าลูกค้า Business รายแรกใช้อะไร (เสนอ: รอ — ไม่ทำ connector ล่วงหน้า)
