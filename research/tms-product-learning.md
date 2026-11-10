# TMS Product Learning: product ที่ควรเรียนรู้ และสิ่งที่หยิบมาใช้ได้

> **ขอบเขต:** TMS SaaS สำหรับผู้ประกอบการขนส่งทางบกไทยขนาด 10–200 คัน (รถบริษัท + รถร่วม) เชื่อม ERP ผ่าน adapter (ตัวแรกคือ KRS) และใช้ standalone ได้
> **วันที่ทำ research:** 3 พ.ย. 2569 (2026-11-03)
> **เป้าหมาย:** ถอดสิ่งที่นำมาใช้ได้ ไม่ได้จัดอันดับว่าใครดีที่สุด และไม่ได้หาระบบมาซื้อ

## วิธีอ่านเอกสารนี้

- **FACT** คือข้อเท็จจริงที่มีลิงก์อ้างอิงกำกับ เปิดดูได้
- **OPINION** คือความเห็นหรือการตีความของผู้ทำ research
- ทุกส่วนตั้งแต่ข้อ 3 ("สิ่งที่ควรหยิบมาใช้") เป็นต้นไปเป็น OPINION ทั้งหมด แต่อ้างกลับไปที่ FACT ในข้อ 2
- **"ไม่พบข้อมูล" / "unverified"** แปลว่าค้นแล้วแต่ไม่พบแหล่งที่ยืนยันได้ ไม่ได้แปลว่า product ไม่มีฟีเจอร์นั้น
- **screenshot** อยู่ใน `assets/` ระบุ path ไว้ในหน้าของแต่ละ product

## ข้อจำกัดของ research รอบนี้ (อ่านก่อน)

1. **REA MCP จับภาพหน้าจอไม่ได้**
   - REA ต้องต่อกับเบราว์เซอร์ที่เปิดไว้อยู่แล้วผ่าน CDP endpoint บาง session ได้ error ว่า "REA could not start…" และ REA แนะนำให้ restart MCP client แล้วรัน `rea doctor`
   - ภาพทั้งหมดจึงมาจาก 3 แหล่งแทน:
     - headless Chrome (หน้าเว็บของเจ้าไทย)
     - รูปที่ฝังอยู่ใน help center หรือหน้า marketing ของผู้ขาย
     - screenshot ที่อยู่ใน repo ของ LogisticsX
   - **ยังไม่มีภาพที่จับจากระบบจริงในโหมด demo เลย**
2. **G2, Capterra, GetApp และ Software Advice ตอบ 403 กับการ fetch อัตโนมัติ**
   - คะแนนและคำบ่นส่วนใหญ่มาจาก snippet ของผลค้นหา หรือเว็บรวมรีวิว ซึ่งระบุกำกับไว้ทุกจุด
   - ควรเปิดหน้ารีวิวจริงด้วยตัวเองก่อนนำไปอ้างต่อ
3. **ระบบไทยทุกเจ้าไม่มี help center สาธารณะ**
   - ข้อมูลมาจากหน้า marketing, app store และข่าว PR จึงรู้ "มีอะไร" แต่ไม่รู้ "ทำอย่างไร"
   - **ต้องลอง demo เอง** ดูข้อ 5
4. **แหล่งที่ให้ข้อมูล "ทำอย่างไร" ได้ดีที่สุด** มี 4 แหล่ง:
   - docs.alvys.com
   - help.dashdoc.com
   - knowledge.shipsy.ai
   - เอกสารใน repo ของ LogisticsX

## คัดเลือก: ตัวไหนควรเรียนรู้ (OPINION)

| กลุ่ม | Product | เหตุผล |
|---|---|---|
| **เรียนรู้ลึก (หลัก)** | Alvys, Dashdoc, Rose Rocket, Shipsy, NOSTRA Logistics, Treasure TMS, LogisticsX | ทุกตัวเป็นระบบของผู้ประกอบการขนส่งและมีงานรถร่วม + วางบิล ส่วน Shipsy, NOSTRA และ Treasure มีลูกค้าในไทย/SEA |
| **เรียนเฉพาะเรื่อง** | Locus (contract/freight reconciliation, POD checklist), Onfleet / OptimoRoute / Track-POD (ePOD, reason codes, offline), Logis Boy (Delivery Slip control, GPS ผ่านแอปสำหรับรถร่วม) | เด่นเฉพาะบางโมดูล |
| **ไม่ต้องลงลึก** | Turvo (help center ปิด, เริ่มที่ $5,000/เดือน), Cargoson (ระบบฝั่ง shipper), EyeFleet / Cartrack (เป็น GPS vendor ที่เพิ่ม dispatch เข้ามา), Hublink (ไม่มี demo) | เกณฑ์ไม่ตรง หรือข้อมูลไม่พอ แต่ยังมี idea 1–2 ข้อที่เก็บไว้ในหน้าของแต่ละตัว |

---

## 1. ตารางสรุป

| Product | Segment | Demo/Trial | Pricing model | โมดูลเด่น | ERP/บัญชี integration | คะแนนรีวิว* |
|---|---|---|---|---|---|---|
| **Alvys** (US) | Carrier/broker | **Trial 14 วัน** | ตามปริมาณ load, user ไม่จำกัด, 3 tier | Status lifecycle + กฎ revert, Dispatch Planner, carrier settlement + dispute | QBO, QBD, NetSuite, BC, Sage Intacct + public API (docs ละเอียดมาก) | Capterra 4.4 (51), G2 ~4.7 (17) |
| **Dashdoc** (FR/EU) | Carrier/broker | Demo, ไม่มี trial | ต่อ active driver (+20% ถ้าเกินสัญญา) | Planning board pool+scheduler, subcontract parent/child + margin, draft→finalize invoice | Exact, Pennylane, Sage, Billit, Winbooks, FEC export, API | G2/Capterra 0 รีวิว |
| **Rose Rocket / TMS.ai** (CA) | Carrier/broker/3PL | Demo | เริ่ม $2,080/เดือน, user ไม่จำกัด | Order→Leg→Manifest, cost/revenue allocation, carrier bill, 4 portals | QBO, Xero, Invoice ID builder | G2 4.8 (15), Capterra 4.4 (35) |
| **Shipsy** (IN, SEA) | Shipper + carrier/CEP | Demo | Custom | Allocation engine รถร่วม P1→P2, Vendor Portal, Vendor Payout | Integration Marketplace, async invoice API | G2 4.5 (~158) |
| **Locus** (IN, มีลูกค้าไทย) | Shipper (enterprise) | Demo | Custom | Order + reason codes, POD checklist, contract + freight reconciliation | API ที่ลูกค้ากำหนด ID เอง + callbacks | G2 ~4.5 (~59) |
| **NOSTRA Logistics** (TH) | Shipper/3PL/carrier | ฟอร์มติดต่อ | "ตามการใช้งาน", Standard Subscription | Costing engine (OD/ระยะ/hybrid/fuel), รถร่วม + quota, Cash Advance, ePOD offline | อ้างว่าเชื่อม ERP/บัญชี/Excel แต่ไม่มีรายละเอียด | iOS ePOD 3.36 (11) |
| **Treasure TMS** (TH) | โรงงาน + บริษัทรับจ้างขนส่ง | **Demo 15 วัน** | ไม่เปิดเผย | Auto revenue+cost ต่อเที่ยว, เลือกรถร่วมราคาต่ำสุด, กันวางบิลซ้ำ, หัก ณ ที่จ่าย | ไม่ระบุ | ไม่พบ |
| **Logis Boy** (TH) | Carrier/โรงงาน | **Trial 1 เดือน** | ไม่เปิดเผย | Delivery Slip control, GPS ผ่านแอปสำหรับรถร่วม | ไม่พบข้อมูล | iOS 5.0 (1) |
| **LogisticsX** (OSS) | Carrier (US/EU) | **Live demo** | Base + ต่อรถ ($41 ต่อ 1 คัน) | Load/Trip/TripStop, invoice rebuild, settlement, mapping table | QBO (ทางเดียว) + provider pattern | N/A |
| **Onfleet** | Last-mile | Demo | ตาม task (เริ่ม $619/เดือน, 2,500 tasks) | Completion reasons แยก success/failed, offline toggle | API | G2 4.6 (140) |
| **OptimoRoute** | Last-mile | **Trial 30 วัน** | ต่อคนขับที่ active ($35–44) | Unscheduled panel + timeline, POD Required/Enabled | API | Capterra 4.6 (~250) |
| **Track-POD** | Last-mile | **Free trial** | ต่อคนขับ ($49–89) หรือต่อ order | Actual Qty, reject reasons, offline | QBO, Xero, Sage, Zapier, webhooks | ~4.5 (แหล่งรอง) |
| Turvo | Broker/3PL/shipper | Demo | เริ่ม $5,000/เดือน | Collaboration ข้าม tenant ผ่านลิงก์ | QBO/NetSuite/Xero (ข่าว 2019), API | G2 4.4 (20) |
| Cargoson | **Shipper** | ไม่มี trial | $199–€599/เดือน | Carrier rate compare | D365, NetSuite, Odoo | Capterra 4.8 (52) |
| EyeFleet (TH) | GPS + dispatch | ขอใบเสนอราคา | ไม่เปิดเผย | Geofence-gated action, แจ้งปัญหาพร้อมรูป | ไม่พบข้อมูล | Play 4.9 (68) |
| Cartrack (TH) | Fleet/GPS | Demo | ตามจำนวนรถ, สัญญา 3 ปี | ส่งรายงานทางอีเมลตามเวลาที่ตั้ง | อ้างว่าเชื่อม ERP แต่ไม่มีรายละเอียด | Play (fleet) 4.5 (54.2K) |

\* ตัวเลขในวงเล็บคือจำนวนรีวิว G2 และ Capterra ส่วนใหญ่มาจาก snippet (ดูข้อจำกัดข้อ 2)

---

## 2. หน้าของแต่ละ product

แต่ละหน้าถอด 6 หัวข้อ:
0. Segment / demo
1. โมดูลเด่น / flow
2. ERP / บัญชี
3. Pricing
4. UI
5. Reviews / คำบ่น
6. Admin / multi-tenant


### 2.1 ไทย

หมายเหตุของกลุ่มนี้:
- ทุกเจ้าไม่มี help center หรือ docs สาธารณะที่อธิบาย flow ทีละหน้าจอ ข้อมูลทั้งหมดมาจากหน้าการตลาด, app store และข่าว PR
- ไม่มีเจ้าไหนประกาศราคา
- ไม่มีเจ้าไหนระบุชื่อโปรแกรมบัญชีไทยที่เชื่อมได้ (Express/FlowAccount/PEAK/SAP B1)
- Pantip/G2/Capterra ไม่พบรีวิว
- Screenshot ถ่ายด้วย headless Chrome เพราะ REA ต้องมี CDP endpoint

#### Logis Boy (บริษัท โลจิสบอย จำกัด)

**0. Segment / demo**
- FACT: กลุ่มลูกค้าคือ "บริษัทขนส่ง โรงงาน หรือบริษัทเทรดดิ้งที่มีงานขนส่ง" ([โปรแกรมขนส่ง](https://www.logisboysolutions.com/โปรแกรมขนส่ง))
- FACT: **ทดลองใช้ฟรี 1 เดือน** ([logisboy.tech](https://www.logisboy.tech/))
- FACT: ขาย TMS/WMS และรับทำซอฟต์แวร์ custom

**1. โมดูลและ flow**
- FACT: flow ที่ประกาศคือ รับออเดอร์ → วางแผน single/multi-drop + Route Optimization → จ่ายงานและคนขับรับงาน → ปิดงานแต่ละเที่ยว → **วางบิลลูกค้า, ทำค่าเที่ยว, รายรับรายจ่าย** → รายงาน
- FACT: "ฟังก์ชันควบคุมใบขนส่ง TMS: Delivery Slip เพื่อลดปัญหาการวางบิลล่าช้า"
- FACT: แยกรายงานรายวัน "เพื่อนำส่งลูกค้า" กับรายเดือน "เพื่อวิเคราะห์"
- FACT รถร่วม: GPS อยู่ในแอป POD "ใช้สำหรับรถร่วมบริการที่ไม่สะดวกในการติดตั้ง แต่ยังคงมาตรฐานได้เหมือนรถบริษัท"
- FACT (`assets/logisboy-1.png`): หน้า Delivery Job เป็นตารางที่มีคอลัมน์ Status badge สี / Job No. / **DO No.** / Customer / Delivery Date / Vehicle Type / Vehicle No. / Driver / Origin พร้อมตัวกรองวันที่และ dropdown "All Partner"
- FACT driver app (POD 2.0): Accept job → Pickup → Delivery → Close job + กรอกข้อมูล ([Play](https://play.google.com/store/apps/details?id=logisboy.pod&hl=th))
- ไม่พบข้อมูล: offline, reason codes

**2. ERP**
- ไม่พบข้อมูล

**3. Pricing**
- ไม่ประกาศราคา บอกแค่ "ราคาที่จับต้องได้"

**4. UI**
- OPINION: admin template แบบ sidebar ดำ ตารางหนาแน่น ดูยุคเก่า แต่ status badge อ่านง่าย (`assets/logisboy-1.png`, `assets/logisboy-2.png`)

**5. Reviews**
- FACT: Play 500+ ดาวน์โหลด ยังไม่มีคะแนน
- FACT: iOS 5.0 จาก 1 รีวิว ([iOS](https://apps.apple.com/th/app/logisboypod/id6445881014))
- FACT: มีแอปแยกชื่อลูกค้า เช่น "TMS THAIKK", "TMS-SCM-DEMO"
- OPINION: น่าจะทำ build แยกต่อลูกค้า (single-tenant/custom)

**6. Admin**
- ไม่พบข้อมูล

#### NOSTRA LOGISTICS TMS / TMS Plus+ (GIS Co., Ltd. กลุ่ม CDG)

**0. Segment / demo**
- FACT: กลุ่มเป้าหมายคือ shipper, 1PL/2PL/3PL และบริษัทที่ใช้รถตัวเองผสมรถร่วม ([nostralogistics](https://www.nostralogistics.com/))
- FACT: อ้างลูกค้ากว่า 300 ธุรกิจ ([brandinside](https://brandinside.asia/?p=239857))
- FACT: TMS Plus+ เปิดตัว มิ.ย. 2569 รองรับ SME ถึง Enterprise ([naewna](https://www.naewna.com/relation/969655))
- FACT: ไม่มี trial มีแค่ฟอร์มติดต่อ

**1. โมดูลและ flow (FACT)** ([tms](https://www.nostralogistics.com/tms/), [epod](https://www.nostralogistics.com/mobile-application/epod/))
- โมดูล: Delivery Order grouping, VRP, Routing & Sequence, Resource Optimization, Shipment, Finance & Document, Maintenance, Dashboard
- constraint ของ VRP: น้ำหนักและขนาดรถ, ประเภทรถ (ห้องเย็น), เวลาเปิดร้าน, เวลาพัก, service time, pickup-before-delivery
- **Costing:** อัตราค่าเที่ยวตามประเภทงาน รองรับทั้ง Own Fleet และ Sub-Contract
  - สูตร: OD cost matrix / ตามระยะทางหรือน้ำหนัก / hybrid ที่คิดเพิ่มต่อจุดเมื่อเกิน N จุด
  - ปรับตามราคาน้ำมันแต่ละช่วงเวลาได้
  - rate จำกัดตามกลุ่มธุรกิจ
  - **อนุมัติใบเสนอราคาของ sub-contractor**
  - เลือกรถตาม "ต้นทุนต่ำสุด / เส้นทางดีที่สุด / priority หรือ quota ของผู้ขนส่ง"
- **Finance:** P&L, ใบแจ้งหนี้และใบวางบิล, รวมบิลค่าใช้จ่ายของคนขับ, **Cash Advance**, Cashbox Dashboard
- **ePOD app**
  - back office ปรับ step ต่อประเภทงานได้
  - หลายคนขับต่อเที่ยว
  - จ่ายงานให้รถร่วมได้ และ **รถร่วมดูใบจ่ายเงินและค่าเที่ยวหลังจบงาน**
  - check-in ที่จุดรับและส่ง ปิดงานด้วยรูปและลายเซ็น
  - **offline + sync อัตโนมัติ**
  - ผู้รับค้นสถานะด้วย tracking no.
- **Monitoring:** timeline รายวัน, แจ้งเตือน delay, ETA

**2. ERP**
- FACT: บอกว่าเชื่อม "WMS, ERP, โปรแกรมบัญชี และ Excel ได้อย่างยืดหยุ่น" แต่ไม่มีรายละเอียด
- FACT: มี Connector ดึงข้อมูล GPS ยี่ห้ออื่น

**3. Pricing**
- FACT: "ราคาเริ่มต้นตามการใช้งาน" แพ็กเกจ Standard Subscription ติดตั้ง 1–2 สัปดาห์
- ไม่มีตัวเลขราคา

**4. UI** (`assets/nostra-1.png`, `assets/nostra-2.png`)
- FACT: mockup เป็นตาราง dispatch สีเขียว-แดงบน tablet คู่กับแผนที่ ส่วนมือถือเป็น timeline รายจุด
- OPINION: เว็บโทนดำ-ทอง ดูพรีเมียมแบบองค์กร

**5. Reviews**
- FACT: iOS NOSTRA LOGISTICS ePOD ได้ **3.36 จาก 11** ([iOS](https://apps.apple.com/th/app/nostra-logistics-epod/id1502067887))
- FACT: Mobile Monitoring ได้ **2.85 จาก 13** ([iOS](https://apps.apple.com/th/app/nostra-mobile-monitoring/id1414745191))
- ดึงข้อความรีวิวไม่ได้

**6. Admin**
- FACT: ฟอร์มตรวจสภาพรถและ workflow ต่อประเภทงานปรับได้
- role/branch: ไม่พบข้อมูล

#### EyeFleet Smart Transport (อีสท์อินโนเวชั่น)

**0. Segment / demo**
- FACT: GPS ตามมาตรฐานกรมการขนส่งทางบก ลูกค้า 4,632 ราย รถกว่า 100,000 คัน ([eyefleet](https://eyefleet.co/))
- ไม่มี trial
- OPINION: เป็น GPS vendor ที่เพิ่ม dispatch ไม่ใช่ carrier TMS เต็มรูป

**1. โมดูลและ flow (FACT)** ([smart-transport](https://eyefleet.co/smart-transport/), [Smart Driver iOS](https://apps.apple.com/us/app/eyefleet-smart-driver/id1481537476))
- เพิ่มรายการจัดส่งและจุดขึ้น-ลง เลือกประเภทรถและคนขับ
- Smart Driver app
  - คนขับกดรับงานเอง
  - **"ขึ้นหรือลงสินค้าได้ทันทีเมื่ออยู่ในระยะจุด"** = geofence-gated
  - **แจ้งปัญหาด้วยข้อความ+รูป**
  - แสดงเลขตู้คอนเทนเนอร์
- Smart Tracking: ผู้รับปลายทางค้นด้วยรหัสงานและให้คะแนนคนขับ
- Executive Summary: แสดงรายรับ-รายจ่ายและกำไรต่องาน
- ไม่พบข้อมูล: รถร่วม, วางบิล, offline

**2–3. ERP / Pricing**
- ไม่พบข้อมูล

**4. UI**
- OPINION: แบรนด์ส้ม-ม่วง (`assets/eyefleet-1.png`)

**5. Reviews**
- FACT: Play EyeFleet 4.9 จาก 68 รีวิว ([Play](https://play.google.com/store/apps/details?id=com.eastinnovation.eyefleet&hl=th))
- FACT: iOS Smart Driver 4.95 จาก 19 รีวิว

#### Cartrack Delivery (Cartrack Thailand / Karooooo)

**0. Segment / demo**
- FACT: ขาย fleet/GPS เป็นหลัก มีหน้า get-a-demo ([cartrack.co.th](https://www.cartrack.co.th/))
- FACT: หน้า dispatchers อ้างชื่อ "Cartrack Delivery" ([dispatchers](https://www.cartrack.co.th/solutions/for-business/teams/dispatchers))
- FACT: **แอป Cartrack Delivery ไม่พบบน Play (404) และ App Store แล้ว** ตรวจ 3 พ.ย. 2569
- OPINION: segment คือ last-mile/fleet

**1. โมดูลและ flow (FACT)** ([task-management](https://www.cartrack.co.th/platform/features/workforce-optimisation/task-management), [transport](https://www.cartrack.co.th/solutions/for-business/industries/transportation-logistics))
- จ่ายงานล่วงหน้าหรือ real-time
- คนขับกดรับงานเอง
- แชตในแอป
- เก็บลายเซ็นและรูปถ่าย
- **ส่งรายงานให้ฝ่ายการเงินทางอีเมลตามเวลาที่ตั้ง**
- แจ้งปลายทางเมื่อใกล้ถึง
- ตรวจโกงน้ำมันโดยจับคู่เซนเซอร์ + พิกัด + ใบเสร็จ

**2. ERP**
- มีแค่ข้อความ "รวมระบบ ERP และ TMS" ไม่มีรายละเอียด

**3. Pricing**
- FACT: หน้า "ราคา" เป็นฟอร์มเลือกจำนวนรถ 1-6/7-25/26-100/100+ ([pricing](https://www.cartrack.co.th/see-plans-and-pricing))
- FACT: รีวิวพูดถึง **สัญญา 3 ปี + ค่าปรับเมื่อยกเลิก**

**4. UI**
- OPINION: เว็บขาวสะอาด (`assets/cartrack-1.png`)

**5. Reviews**
- FACT: แอป fleet ได้ 4.5 จาก 54.2K รีวิว ([Play](https://play.google.com/store/apps/details?id=com.cartrack.fleet&hl=th&gl=TH))
- คำบ่น: "ไม่มีทีมซัพพอร์ต 24/7… ยกเลิกก็เสียค่าปรับตามสัญญา 3 ปี", "gps ติดรถค้างบ่อย… รายงานก้อไม่ดี"

#### Treasure TMS & VRP (Treasure Innovation) — เพิ่มเติม ([treasure tms](https://www.treasureinnovation.com/our-solutions/treasure-tms-system/), [booking](https://www.treasureinnovation.com/our-solutions/treasure-booking-tms-solutions/))
- FACT segment: แยกหน้าการตลาดเป็น "โรงงาน/ผู้ผลิต" กับ "บริษัทรับจ้างขนส่ง" มี **demo ฟรี 15 วัน** (`assets/treasure-1.png`)
- FACT flow: รับออเดอร์หลายช่องทาง → จัดรถด้วย AI หรือมือ → คิดราคาและต้นทุนอัตโนมัติ → จ่ายงาน → "ทำเอกสารทางบัญชีลูกค้า บัญชีรถร่วม"
- FACT **Auto-Planning by Sub Contractor Price**: เลือกรถร่วมที่ "ราคาถูกสุดก่อนเสมอ" เพื่อความยุติธรรมและลดการทุจริต
- FACT **Auto-Revenue & Cost**: สร้างเที่ยวพร้อมค่าเที่ยวฝั่งรายได้และฝั่งต้นทุน
- FACT: ดึงงานที่จบแล้วเข้าวางบิลอัตโนมัติ พร้อม **flag กันวางบิลซ้ำ** ครอบคลุมใบแจ้งหนี้/ใบเสร็จ/**หัก ณ ที่จ่าย** อ้างว่า "ลดการหลุดวางบิลได้ 100%"
- FACT: P&L รายลูกค้า, ลูกค้าค้นด้วยเลข PO ของตัวเอง
- FACT: จ่ายเงินได้ทั้ง "รถร่วม / พขร.มีเงินเดือน / พขร.ไม่มีเงินเดือน" รวมงานตู้คอนเทนเนอร์
- ไม่พบข้อมูล: ราคา, การเชื่อมบัญชี, รีวิว

#### Hublink TMS — เพิ่มเติม ([hublinktms](https://hublinktms.com/))
- FACT: สำหรับงานสินค้าเบ็ดเตล็ดหลายสาขา และงานเหมาเที่ยว
- FACT: "ป้อนข้อมูลครั้งเดียว" แล้วออก **ใบคุมรถ**, ใบเสร็จ, ใบวางบิล, จ่ายค่าเที่ยว พขร. และค่าจ้างรถร่วม
- FACT: บาร์โค้ด, เซ็นรับบนมือถือ
- FACT: **offline แล้วส่งข้อมูลไปสาขาปลายทางเมื่อต่อเน็ตได้**
- FACT: "ไม่สามารถทำเป็น Demo ให้ลองใช้ได้"


### 2.2 SEA / อินเดีย

หมายเหตุของกลุ่มนี้:
- REA `capture_web_screenshot` ต้องมี CDP endpoint ของเบราว์เซอร์ที่เปิดอยู่ จึงใช้ภาพที่ดาวน์โหลดจากเว็บของผู้ขายแทน
- G2/Capterra/GetApp ตอบ 403 คะแนนรีวิวมาจาก snippet ของผลค้นหา ยังไม่ได้ตรวจกับหน้ารีวิวจริง
- Shipsy มี KB สาธารณะที่ knowledge.shipsy.ai (315 บทความ) เป็นแหล่งข้อมูล "how" ที่ดีที่สุดในงานนี้

#### Locus (locus.sh) — enterprise dispatch ฝั่ง shipper มีลูกค้าไทย

**0. Segment / ลูกค้าไทย / demo**
- FACT: วางตัวเป็น "agentic TMS" ลูกค้า 360+ องค์กร ใน 30+ ประเทศ รองรับ fleet แบบ captive/contracted/outsourced/hybrid ([llms.txt](https://locus.sh/llms.txt))
- FACT: Ingka (IKEA) ซื้อไปในปี 2025 ([itln](https://www.itln.in/logistics/ingka-group-acquires-ai-logistics-firm-locus-to-boost-ikea-deliveries-1356732))
- OPINION: เป็นเครื่องมือของ shipper (retail/FMCG) ส่วน transporter อยู่ในระบบในฐานะ vendor ของ shipper
- **FACT ลูกค้าไทย:** CP Axtra (Siam Makro) ([case](https://locus.sh/case-studies/siam-makro-cuts-route-planning-time/))
  - ใช้ 170+ สาขา ลดค่าโลจิสติกส์ 16.7%
  - เวลาจัด dispatch ต่อสาขาลดจาก 2 ชม. เหลือไม่ถึง 30 นาที
  - COD ผ่าน TrueMoney/QR พร้อม audit trail
  - บังคับถ่ายรูป POD ณ ตำแหน่งที่ถูกต้อง
  - planning wave ทุก 30 นาที
- Demo: ต้องขอผ่านฟอร์ม ไม่มี trial ([pricing blog](https://locus.sh/blogs/locus-pricing-2026/))

**1. โมดูลเด่น (FACT จาก OpenAPI สาธารณะ)** ([api](https://locus.sh/resources/api-references))
- **Order status:** OPEN/CONFIRMED/PLANNING/PLANNED/ASSIGNED/EXECUTING/COMPLETED/CANCELLED/PARKED
  - sub-status: PICKUP_ENROUTE, DROP_REACHED, ATTEMPT_FAILED, PARTIALLY_COMPLETED
- **Reason code งานค้าง:** UNALLOCATED_IN_PLAN, NO_DISPATCH_WAVE_MATCHED, CAPACITY_EXCEEDED, GEOCODING_ERROR, CARRIER_REJECTED, RESCHEDULES_EXHAUSTED, DELIVERY_WINDOW_EXHAUSTED
- **POD = checklist ที่ตั้งค่าได้**
  - ชนิด field: BOOLEAN/SINGLE_CHOICE/PHOTO/SIGNATURE/PIN/DATE/RATING
  - ผลตรวจ: PASSED/FAILED/PARTIALLY_VERIFIED
  - ภาพการตลาดแสดงคำเตือน "Marked completed 0.15 kms away"
- **Transporter / contract**
  - transporter type: OWNED/OUTSOURCED/THIRD_PARTY
  - Contract ผูกกับ transporter และรุ่นรถ มีวันเริ่ม/หมดอายุ, paymentTerms, workflow อนุมัติ DRAFT→PENDING_APPROVAL และเตือน NEAR_EXPIRY
  - cost function มี 40+ พารามิเตอร์ (DISTANCE/WEIGHT/NO_OF_DROP_POINTS/HALT_CHARGES/FUEL_SURCHARGE/FIXED…)
  - ทุก tour มี `freightCost` + `detailedCostContribution` แยกตามพารามิเตอร์
  - สถานะการคำนวณค่าขนส่ง: AVAILABLE / CONTRACT_MISSING / CALCULATION_FAILURE
- **Freight reconciliation** (case study ผู้ผลิตสีในอินเดีย 1,500+ invoice/เดือน) ([pdf](https://info.locus.sh/hubfs/Marketing_Collateral/Casestudies/lite/enterprise-paint-leader-automates-invoice-and-reconciliation.pdf), [pdf2](https://info.locus.sh/hubfs/Case%20Studies%20for%20Gartner/case%20study_Freight%20Reconciliation%20(2).pdf?hsLang=en))
  - เทียบยอดที่ transporter เคลมกับยอดจาก contract จับส่วนต่างได้ 5–6%
  - รอบจ่ายลดจาก 30–45 วัน เหลือ 7–10 วัน
  - vendor อัปโหลด invoice ผ่านพอร์ทัล หน้าอนุมัติแสดง **planned vs executed cost**
- **Offline:** มีแค่บล็อกปี 2019 ที่บอกว่าทำงานส่วนใหญ่ offline ได้ ([blog](https://locus.sh/blogs/hitting-the-road-running-can-technology-improve-the-life-of-the-delivery-executives/)) ข้อมูลอาจเก่าแล้ว

**2. ERP**
- FACT: `PUT /client/{clientId}/order/{orderId}` ให้**ฝั่งลูกค้ากำหนด ID เอง** ใช้แบบเดียวกันกับ master ทุกตัว
- FACT: ใช้ callback ที่ตั้งค่าได้ ได้แก่ order และ tour (FROZEN/DISPATCHED/STARTED/COMPLETED) ([blog](https://locus.sh/blogs/logistics-api-integrations-wms-erp-tms-connectivity/))
- ไม่พบข้อมูล: connector SAP แบบสำเร็จรูป, การ map เลขเอกสาร, การ re-sync

**3. Pricing**
- custom ตาม deployment ไม่มีราคาสาธารณะ ([blog](https://locus.sh/blogs/locus-pricing-2026/))

**4. UI** (OPINION จากภาพการตลาด ไม่ใช่ screenshot ระบบจริง)
- ตารางหนาแน่น พื้นขาว สีหลักฟ้า
- tab สถานะพร้อมตัวนับ (All Tours 66 / Created 15 / Ready for Dispatch 12…)
- แผง "Amount Reconciliation" แสดงยอด $160 / 160
- timeline คู่แผนที่ ป้าย SLA breach สีส้ม
- ภาพ: `assets/locus-1.png` (timeline+map), `assets/locus-2.png` (tours+reconciliation), `assets/locus-3.png` (driver app)

**5. Reviews** (snippet)
- G2 ~4.5 จาก ~59 รีวิว ([g2](https://g2.com/products/locus-locus/reviews_and_filters?page=3))
- คำบ่น:
  - แอปคนขับกินแบต
  - "Integration had few hiccups"
  - "many configurations… hard to teach to the transporter admin" ([capterra uk](https://www.capterra.co.uk/reviews/176446/locus-dispatcher))
  - ไม่มี debug log ให้ลูกค้าดู ([softwareadvice](https://www.softwareadvice.com/crm/locus-profile/reviews/))

**6. Admin**
- FACT (จาก API): team/personnel master, shift tag, workflow stage ตั้งชื่อเองได้
- การตั้ง role/custom field ผ่าน UI: ไม่พบข้อมูล

#### Shipsy (shipsy.io → shipsy.ai) — ขายทั้ง shipper และ carrier/CEP มีลูกค้าในไทย

**0. Segment / ลูกค้า SEA / demo**
- FACT: ก่อตั้ง 2015 HQ อินเดีย มี RHQ ที่ Dubai และ Jakarta ([technode](https://technode.global/2022/02/22/indian-logistics-management-firm-shipsy-to-set-up-regional-hq-in-indonesia/))
- FACT: ระบุว่าเหมาะกับองค์กร ">100,000 shipments/month" ([llms.txt](https://shipsy.ai/llms.txt))
- FACT: Teleport (เครือ Capital A) ใช้ใน MY/SG/PH/**TH**/ID ([prn](https://technode.global/prnasia/teleport-enhances-real-time-last-mile-supply-chain-visibility-across-southeast-asia-partnering-with-shipsys-ai-powered-platform/))
- Demo: ต้องขอ ไม่มี trial

**1. โมดูลเด่น (FACT จาก KB)**
- **Planning → รถร่วม** ([trip creation](https://knowledge.shipsy.ai/help/vendor-and-indent-management/manual-and-automatic-trip-creation-for-vendors--6xwi-gmc))
  - Consignments > Unplanned > Create Route ส่ง optimiser พร้อมรุ่นรถของตัวเองและรุ่นรถของ vendor ที่ให้บริการ OD pair นั้น
  - **จัดรถของตัวเองก่อน** แล้วส่ง "indent" ให้ vendor
- **Allocation engine** ([engine](https://knowledge.shipsy.ai/help/vendor-and-indent-management/understanding-the-tms-allocation-engine--mq1cn7zo))
  - คัด vendor ตาม OD/route/trip type
  - จัดลำดับตามต้นทุนหรือแบบ static
  - ส่ง indent ให้ P1 ก่อน ถ้าปฏิเสธส่งต่อ P2 ไปเรื่อย ๆ
  - มีเพดานจำนวน trip ต่อ vendor ต่อรุ่นรถ
  - ถ้าไม่มีใครรับ trip ค้างอยู่ใน Trip Manager
- **Vendor Portal** ([acceptance](https://knowledge.shipsy.ai/help/vendor-and-indent-management/vendor-indent-acceptance--n58ie11l))
  - หน้า Vehicle Requests มี tab Pending/Assigned
  - กด Assign เพื่อใส่ทะเบียนรถและคนขับ (= รับงาน) หรือกด Reject
- **POD ของรถร่วมที่ไม่มีแอป**
  - vendor ค้นด้วยเลข invoice แล้วอัปโหลดรูป POD ได้ทั้งส่งสำเร็จและไม่สำเร็จ ([vendor pod](https://knowledge.shipsy.ai/help/vendor-and-indent-management/vendor-pod-upload--bywdy8da))
  - ลูกค้าอัปโหลดได้สูงสุด 5 ไฟล์ต่อ CN ([customer pod](https://knowledge.shipsy.ai/help/vendor-and-indent-management/customer-pod-upload--3hirv2t8))
- **Master ราคา/บริการของ vendor**
  - Rate/TAT/Serviceability master ใช้ key = ต้นทาง + ปลายทาง + รุ่นรถ มีค่า charge และ additional stop charge
  - **อัปเดตผ่าน CSV เท่านั้น** ([masters](https://knowledge.shipsy.ai/help/vendor-and-indent-management/rate-serviceability-and-tat-masters--himektbj))
  - vendor master มี vendor code และ parent code ([vendor-vehicle](https://knowledge.shipsy.ai/help/vendor-and-indent-management/vendor-vehicle-mapping--2np8kdnk))
- **Vendor Payout** ([payout](https://knowledge.shipsy.ai/help/rates-and-contracts/vendor-payout-calculation--j6fr9vrb), [api](https://knowledge.shipsy.ai/help/rates-and-contracts/external-apis-for-vendor-payout--imrxkypp))
  - Finance Ops > Vendor Payouts > Calculate กรองตาม vendor/ช่วงวันที่/hub
  - ได้ Excel 3 sheet (Summary / Vehicle charges / Trip charges) + PDF
  - รองรับทั้งเหมาวัน ("12hrs_01 days" = ค่ารถ + km + ชั่วโมง) และต่อเที่ยว
  - มี API คำนวณแบบ async
- **Reason master** ([reasons](https://knowledge.shipsy.ai/help/core-platform/how-to-add-undelivered-reasons--vcafcl8r))
  - Setup > App Flow Config > Undelivered/Rescheduled/Not Picked Up
  - แต่ละ reason มี checkbox "reschedule" สร้างนัดใหม่อัตโนมัติ
- **Driver app** ([rider flow](https://knowledge.shipsy.ai/help/mobile-application/delivery-flow-for-a-rider--zkf-fbzz))
  - ปิดงานเป็น Delivered (ระบุความสัมพันธ์ผู้รับ) / Undelivered / "Undelivered and Retain" (เก็บของไว้ส่งพรุ่งนี้)
  - offline: ไม่พบข้อมูล
- **Freight audit** ([recon](https://www.shipsy.ai/invoice-reconciliation), [vera](https://www.shipsy.ai/insights/vera-autonomous-freight-dispute-resolution))
  - เทียบ invoice ทุกบรรทัดกับ rate card
  - กฎ "No POD, no payment"
  - จัดหมวดส่วนต่างตามประเภทและความรุนแรง

**2. ERP**
- FACT: Integration Marketplace ในระบบ ([marketplace](https://knowledge.shipsy.ai/help/integration-marketplace/introduction-to-the-integration-marketplace--cyr7ybq7))
- FACT: Customer Invoice API แบบ async: generate → invoiceNumber → poll PENDING/PROCESSING/COMPLETED/ERROR → breakdown ราย CN (freight/fuel/COD/VAT) หรือลิงก์ CSV/PDF ([invoice api](https://knowledge.shipsy.ai/help/rates-and-contracts/external-apis-to-manage-invoices--tzwyaj9n))
- FACT: SAP API ที่มีเอกสารเป็นของ EXIM ไม่ใช่ domestic TMS ([sap](https://knowledge.shipsy.ai/help/exim/shipsy-sap-api-integration-details--lqxe0_vj))
- FACT: BI มี permission ระดับตาราง รวมถึง INBOUND EXTERNAL REQUEST LOG / CUSTOMER WEBHOOK LOGS ([perm](https://knowledge.shipsy.ai/help/core-platform/table-level-permissions--xhgtreym))
- การ map เลขเอกสาร/การ re-sync: ไม่พบข้อมูล

**3. Pricing**
- custom ไม่มี tier หรือ trial

**4. UI** (OPINION จากภาพ)
- สไตล์ Ant Design: ตารางขาว, tab สถานะพร้อม badge ตัวนับสี
- action แบบลิงก์ "+ Assign | Reject" อยู่ในแถว
- ข้อเสีย: ที่อยู่ยาวทำให้แถวสูงมาก
- ภาพ: `assets/shipsy-1.png` (Vendor Portal), `assets/shipsy-2.png` (POD upload), `assets/shipsy-3.png` (Excel payout)

**5. Reviews** (snippet)
- G2 4.5 จาก ~158 รีวิว ([g2](https://www.g2.com/products/shipsy-shipsy/reviews))
- คำบ่น: ไม่ทันกำหนดส่งมอบหรือการแก้ปัญหาที่รับปาก, ช้าช่วง peak
- Capterra ระบุภาษา EN/AR/HI ไม่มีภาษาไทย ([capterra.in](https://www.capterra.in/reviews/164099/shipsy))

**6. Admin (FACT)**
- ลูกค้าตั้งค่าเองได้: สร้าง role จาก permission ([roles](https://knowledge.shipsy.ai/help/core-platform/how-to-create-employee-type-and-add-permissions--njtx17ln)), เปิด/ปิด hub/vehicle/rider, ตั้ง reason, ตั้ง contract ตามช่วงเวลา ([contracts](https://knowledge.shipsy.ai/help/rates-and-contracts/time-period-based-contracts--v7lavp4n))
- config บางตัว เช่น FTL/PTL **ต้องให้ POC ของ Shipsy เป็นคนตั้ง**


### 2.3 อเมริกาเหนือ (carrier/broker TMS)

หมายเหตุของกลุ่มนี้:
- docs.alvys.com เปิดอ่านได้ครบ 373 หน้า เป็นแหล่งที่ละเอียดที่สุดของ research นี้
- help center ของ Turvo ต้อง login
- G2/Capterra ตอบ 403 คะแนนรีวิวจึงมาจาก snippet หรือเว็บรวมรีวิว
- ภาพทั้งหมดดาวน์โหลดจากรูปที่ฝังในเว็บของผู้ขาย

#### Rose Rocket (ปัจจุบันคือ "TMS.ai, a Rose Rocket company")

**0. Segment / demo**
- FACT: ขายให้ทั้ง carrier, broker และ 3PL มี Partner Portal, Customer Portal และ Driver App ([roles](https://help.roserocket.com/user-roles-and-permissions))
- FACT: นัด demo ได้ ไม่มี trial ([pricing](https://www.tms.ai/pricing))
- ไม่พบลูกค้าไทย/SEA

**1. โมดูลเด่น (FACT)**
- **Order → Leg → Manifest** ([dispatching](https://help.roserocket.com/dispatching-an-order))
  - สร้าง order ได้ 3 ทาง: manual, CSV หรือ PDF import
  - ในส่วน Tasks ระบบแตก order เป็น Legs
  - กด "+ Assign Carrier/Driver" → "Create New Manifest" → เปิด Manifest → "Send to Driver"
  - Manifest คือหน่วย dispatch ที่รวมหลาย leg จากหลาย order ได้
  - การ re-assign ต้องยืนยัน recall ก่อน ([re-assign](https://help.roserocket.com/re-assigning-a-manifest))
- **Allocation** ([driver settlement setup](https://help.roserocket.com/how-to-setup-driver-settlement))
  - "Manifest Allocated Cost Splitting": แบ่งต้นทุน manifest เช่น ตาม Actual Weight
  - "Order Allocated Revenue Splitting": แบ่งรายได้ order เป็น % ต่อ leg เช่น Pickup 25 / Linehaul 50 / Delivery 25
  - OPINION: เหมาะกับการคิดกำไรต่อ order เมื่อรถวิ่งรวมหลายงาน
- **Carrier bill (รถร่วม)** ([create](https://help.roserocket.com/create-a-carrier-bill), [approve](https://help.roserocket.com/how-to-approve-send-a-carrier-bill))
  - Accounting > Carriers → filter → ติ๊ก manifest → Create bill (สร้างใหม่หรือเพิ่มเข้าบิลเดิม)
  - ส่งได้ 3 แบบ: Send (ให้ vendor ตรวจก่อน) / Approve / Approve & send
- **Driver Settlement** ([driver settlement](https://help.roserocket.com/driver-settlement))
  - tab Outstanding แบ่งเป็น Manifests/Fuel/Recurring
  - Create bill + adjustment → Approve & send (ส่งเข้า Driver App) → Mark as Paid
  - สถานะบิล: In Review → Approved → Paid
- **Receivables** ([new receivables](https://help.roserocket.com/introduction-to-the-new-receivables))
  - tab Items แสดง order ที่ completed และพร้อมออกบิล
  - consolidated invoice หลาย order และย้าย order ระหว่าง invoice ได้
  - สร้าง invoice ที่ไม่ผูก order ได้
  - custom field 3 ช่อง (เช่น PO#)
  - มี credit memo ([credit memo](https://help.roserocket.com/create-a-credit-memo))
- **Customer Portal** ([portal](https://help.roserocket.com/customer-portal), [create order](https://help.roserocket.com/how-do-i-create-a-new-order-in-the-customer-portal))
  - ลูกค้าสร้าง order เลือก rate หรือขอ spot quote ได้
  - duplicate order, พิมพ์ BOL, ขอ ETA, สร้าง login ให้ทีมตัวเอง

**2. ERP/บัญชี (FACT)** ([integrations](https://help.roserocket.com/integrations))
- connector: QBO และ Xero
- **Item Types Mapping:** map freight/fuel/accessorial, pay terms, tax และ class ให้ครบก่อนจึง export ได้ ([mapping](https://help.roserocket.com/quickbooks-online-how-do-i-configure-my-invoice-item-types-mapping-to-export-to-quickbooks))
- **Custom Invoice ID** = prefix + Order ID/org sequence + shortcode ของ org หรือลูกค้า ([invoice id](https://help.roserocket.com/custom-invoice-id))
- auto export เมื่อกด "Send to Customer" ([auto export](https://help.roserocket.com/quickbooks-online-how-do-i-enable-invoice-auto-export-for-quickbooks-within-rose-rocket))
- ปุ่มที่เกี่ยวกับ sync
  - "DELETE INVOICE" ลบใน QBO จากฝั่ง Rose Rocket ([delete](https://help.roserocket.com/quickbooks-online-how-do-i-delete-an-invoice-from-quickbooks-from-within-rose-rocket))
  - "Sync invoices with QuickBooks" แบบ bulk ([sync all](https://help.roserocket.com/how-do-i-sync-all-invoices-in-rose-rocket-with-my-quickbooks-software))
- **Error**
  - แสดงเป็นข้อความสีแดงท้าย invoice และมีคู่มือแยกตาม error code ([errors](https://help.roserocket.com/how-do-i-resolve-a-quickbooks-export-error))
  - เช่น 6140 เลขซ้ำ ([6140](https://help.roserocket.com/quickbooks-error-code-6140))
- marketing: ดึงสถานะการจ่ายกลับจาก change feed ของ Intuit และ reconcile รายชั่วโมง ([qbo page](https://www.roserocket.com/integrations/quickbooks-online))
- การแก้ invoice หลัง sync: unverified

**3. Pricing (FACT)** ([pricing](https://www.tms.ai/pricing))
- Full Service Platform เริ่ม **$2,080/เดือน** ไม่จำกัด user
- Enterprise ราคาตามตกลง ได้ SSO และ API ไม่จำกัด

**4. UI**
- `assets/roserocket-1.png` (Settings / allocation), `assets/roserocket-2.png` (consolidated invoice)
- OPINION: UI รุ่น Classic ใช้ sidebar ไอคอน ปุ่มสีน้ำเงิน ดูทางการแต่ไม่ทันสมัย

**5. Reviews** (snippet) ([capterra](https://capterra.com/p/153047/Rose-Rocket/reviews))
- G2 4.8 จาก 15 รีวิว, Capterra 4.4 จาก 35 รีวิว
- คำบ่น: ทีมบัญชีต้องคีย์ซ้ำเพื่อสร้าง invoice ที่คล้ายกัน ([softwareadvice](https://www.softwareadvice.com/scm/rose-rocket-profile/))
- ผู้รีวิวขอ training รอบสองหลังเริ่มใช้งาน

**6. Admin (FACT)**
- role ตายตัว 4 แบบ: Admin, Manager (ทุกอย่างยกเว้น integration), Operations (เห็นการเงินเฉพาะงานตัวเอง), CSR (เห็นเฉพาะลูกค้าตัวเอง)
- ไม่พบ custom role
- แยก portal เป็น Sales/Partner/Customer/Driver

#### Alvys — carrier/broker TMS ที่มีเอกสาร accounting ละเอียดที่สุด

**0. Segment / trial**
- FACT: ขายให้ carrier, broker, hybrid และ private fleet มี **trial 14 วัน** ([pricing](https://alvys.com/pricing))
- ไม่พบลูกค้าไทย/SEA

**1. โมดูลเด่น (FACT)**
- **Status lifecycle พร้อมกฎ revert (จุดที่ทำดีที่สุด)** ([statuses](https://docs.alvys.com/en/help/loads-trips/understanding-load-statuses-and-how-to-revert-them))
  - ลำดับ: Open → Covered → Dispatched → In Transit → Delivered → **Released** (ส่งให้บัญชี) → **Queued** (ออก invoice แล้ว) → Invoiced → Financed → Completed
  - stop ถือว่าเสร็จเมื่อมีทั้ง Time In และ Time Out
  - Release ต้องไม่มี stop ค้าง และต้องมี permission
  - ย้อนจาก Queued ได้เฉพาะ support ส่วน Financed/Completed ย้อนไม่ได้
  - แก้ rate ได้ในสถานะ Queued/Invoiced โดยไม่ต้องย้อนสถานะ
- **Lock Load:** ป้าย "Locked for Editing" คนอื่นเห็นเป็น read-only ต้องมี permission UnlockLoads ถึงปลดล็อกของคนอื่นได้ ([lock](https://docs.alvys.com/en/help/loads-trips/how-to-lock-and-unlock-a-load-for-editing))
- **Load → Trip:** load หนึ่งมีได้หลาย trip ([split](https://docs.alvys.com/en/help/loads-trips/optimize-split-trips-rearrange-stops), [two carriers](https://docs.alvys.com/en/help/loads-trips/how-to-assign-two-carriers-to-the-same-load))
  - Split ที่จุด handoff ได้ (Live หรือ Drop & Hook)
  - Rearrange stop ได้ ระบบกันลำดับผิด
  - ห้าม split ถ้าคนขับได้รับเงินแล้ว หรือ trip เลย delivered ไปแล้ว ยกเว้น Admin
- **Dispatch Planner v2** ([planner](https://docs.alvys.com/en/help/loads-trips/dispatch-planner))
  - ซ้ายเป็น Trips (Open/Planned) ขวาเป็น Drivers/Assets คลิกฝั่งหนึ่งแล้วอีกฝั่ง filter เฉพาะที่จับคู่ได้
  - availability = เวลา delivery ล่าสุด + dwell เฉลี่ย พร้อม "Available in" และ "Next planned at"
  - priority 4 ระดับ แสดงเป็นสีพื้นแถว
  - ปุ่ม **Assign** (→Covered) กับ **Assign and dispatch** (→Dispatched)
  - bulk actions 6 แบบ
  - ตั้งค่า 3 ชั้น: platform → company → fleet
- **รถร่วม (tender)** ([rate con](https://docs.alvys.com/help/loads-trips/how-to-send-the-rate-confirmation-to-a-carrier))
  - ส่ง rate confirmation แล้ว carrier รับ ปฏิเสธ หรือเซ็นผ่านลิงก์ได้**โดยไม่ต้องมี account**
  - ลิงก์หมดอายุใน 48 ชม.
  - เซ็นแล้ว driver ของ carrier ผูกเข้ากับ load อัตโนมัติ
  - มี preliminary rate con ที่ซ่อนที่อยู่
- **Carrier Settlements** ([settlements](https://docs.alvys.com/en/help/accounting-settlements/carrier-settlements))
  - tab Open/Drafts/Statements/Errors
  - payable item มีสถานะ Open/Approved/**Disputed** โดย dispute บล็อก approve
  - "Super Settle View" ดูเอกสารคู่ยอด
  - statement มีสถานะ Queued/Processed/Paid/Failed
- **Public Load Tracking:** ลิงก์มีแบรนด์บริษัท ลูกค้ากรอกเลข order แล้วดูสถานะได้ ([tracking](https://docs.alvys.com/en/help/loads-trips/public-load-tracking))

**2. ERP/บัญชี (FACT, ละเอียดที่สุด)** ([QBO overview](https://docs.alvys.com/help/integrations/quickbooks-online-integration-overview), [export & manage](https://docs.alvys.com/en/help/integrations/how-to-export-and-manage-transactions-in-quickbooks-online), [QBD](https://docs.alvys.com/help/integrations/how-to-export-and-modify-transactions-in-quickbooks-desktop))
- **Connectors:** QBO, QBD (ผ่าน Web Connector), NetSuite, Business Central, Sage Intacct
- **Multi-entity:** 1 QBO company ต่อ 1 subsidiary
  - invoice ไป subsidiary ใน "Invoice As" ส่วน bill ไป "Tender As"
  - เปิด Shared Billing แล้วสร้าง intercompany ให้อัตโนมัติ
- **เลขเอกสาร**
  - ต้องเปิด "Custom transaction numbers" ใน QBO ก่อน
  - invoice ใช้เลข load (+prefix) ส่วน summary invoice ใช้เลข S…
  - bill ใส่ load/settlement ID ในช่อง ref no.
  - **เลข invoice ของรถร่วมถูกต่อท้ายใน memo** เพื่อใช้กระทบยอด
  - ตั้งให้ต้องมีเอกสาร Carrier Invoice ก่อนจึง export ได้
- **Master matching:** จับคู่ลูกค้าด้วย "External Accounting Name" ถ้าไม่พบให้สร้างใหม่ และ Alvys เป็น source of truth (ชื่อที่แก้ใน QBO จะถูกทับ)
- **แก้หลัง sync**
  - "Alvys is the system of record" ห้ามลบใน QBO
  - แก้ได้จนกว่าจะรับชำระเต็ม
  - linehaul/fuel/accessorial/วันที่ อัปเดตไป QBO อัตโนมัติ ส่วนการแก้อื่นต้อง regenerate
  - เปลี่ยนลูกค้าได้ก่อนสถานะ Invoiced
  - summary invoice แก้ได้ด้วยการ revert แล้วระบบออกเลขใหม่
  - revert driver statement ระบบลบ bill ที่ยังไม่จ่ายให้
- **Error Transactions queue**
  - "-" หมายถึงรอคิว ไม่ใช่ error
  - เอกสารลงวันที่ในงวดที่ปิดแล้วถูกบล็อก ต้องเปิดงวดแล้ว re-export
  - payment sync กลับมาแบบ polling
- **ข้อควรระวังจาก docs:** ถ้าเปิดทั้ง settlement และ "Generate Carrier Invoice Separately" ใน subsidiary เดียวกัน จะ**จ่ายรถร่วมซ้ำ**
- **API:** public API + OpenAPI + webhook delivery monitor ([llms.txt](https://docs.alvys.com/llms.txt))

**3. Pricing (FACT)** ([pricing](https://alvys.com/pricing))
- คิดตาม**ปริมาณ load** ไม่จำกัด user ไม่มี setup fee ไม่มีสัญญา
- 3 แพ็กเกจ
  - Foundations: 1 subsidiary
  - Growth: 3 subsidiary + API + 2 EDI partner
  - Scale: subsidiary ไม่จำกัด + 5 EDI partner
- add-on: sandbox $100/เดือน, connector NetSuite/BC/Sage

**4. UI**
- `assets/alvys-1.png` (Carrier Settlements), `assets/alvys-2.png` (statement), `assets/alvys-3.png` (Generate Invoice)
- FACT จากภาพ: พื้นขาวเทาอ่อน, tabs, filter ต่อคอลัมน์, แผง Columns/Options ด้านขวา, คีย์ลัด (⌘K ค้นหา, ⌘^L สร้าง load ใหม่), ป้าย "New"
- OPINION: นี่คือแบบ "ทางการแต่สวย" ที่ควรเลียนแบบมากที่สุด ใช้สีน้ำเงินเป็น accent เดียว ตารางหนาแน่นแต่โล่ง

**5. Reviews** (snippet) ([capterra](https://capterra.com/p/249961/Alvys-TMS/reviews/))
- Capterra 4.4 จาก 51 รีวิว, G2 ~4.7 จาก 17 รีวิว
- คำบ่น
  - dispatch ฝั่ง OTR มีฟีเจอร์จำกัด
  - **ตัวเลขบน dashboard ไม่ตรงกับรายได้ลูกค้า**
  - planning/load board ยังต้องปรับปรุง
  - broker เห็น tab ของฝั่ง asset ที่ไม่จำเป็น
  - export ข้อมูลได้จำกัด

**6. Admin (FACT)** ([roles](https://docs.alvys.com/en/help/administration/user-roles-in-alvys), [rate perms](https://docs.alvys.com/help/administration/rates-permissions))
- role สำเร็จรูป 11 แบบ ลำดับชั้นกำหนดว่า "ใครจัดการใครได้" ไม่ได้กำหนดสิทธิ์
- ให้หรือถอน permission รายคนได้ (View/Edit Customer Rate, View Carrier Rate, Release Loads)
- **ถอนสิทธิ์แล้วบังคับ logout** เพิ่มสิทธิ์แล้วขึ้น banner ให้ refresh
- มี MFA และหลาย subsidiary

#### Turvo — collaborative TMS (help center ปิด ข้อมูลระดับ marketing)

**0. Segment / demo**
- FACT: ขายให้ broker/3PL/shipper/carrier ([what is turvo](https://turvo.com/what-is-turvo/))
- FACT: Lineage + Bay Grove ซื้อกิจการปี 2022 ([ajot](https://www.ajot.com/news/lineage-and-bay-grove-appoint-billy-sarracino-ceo-of-turvo))
- นัด demo ได้ ไม่มี trial

**1. โมดูล (FACT ระดับ marketing)**
- Order → Shipment ([orders](https://turvo.com/orders/))
  - 3 ขั้น: choose orders → verify routes → assign carriers
  - multi-leg ที่แต่ละ leg tender ให้ carrier ต่างกัน
- Collaboration ([collaboration](https://turvo.com/collaboration/), [shipments](https://turvo.com/shipments/))
  - share shipment ให้ลูกค้าหรือ carrier ผ่านลิงก์
  - partner upload และแก้เอกสารได้
  - แชทผูกกับ shipment
  - เชิญ partner ได้ "no additional cost"
- Turvo Pay (ข่าวปี 2019) ([truckinginfo](https://www.truckinginfo.com/339379/turvo-expands-logistics-platform-with-automated-payments-tools))
  - จ่าย carrier พร้อม reconcile และ remittance อัตโนมัติ

**2. ERP**
- FACT (ข่าว 2019): QuickBooks/NetSuite/Xero
- FACT: REST API + webhooks ([connect](https://turvo.com/connect/))
- API docs อยู่หลัง login ([apis.io](https://apis.io/providers/turvo/))
- การ map เลขเอกสาร: ไม่พบข้อมูล

**3. Pricing (FACT)** ([pricing](https://turvo.com/pricing/))
- "Plan, Execute and Settle Freight" เริ่ม **$5,000/เดือน**

**4. UI**
- `assets/turvo-1.png`
- รายการ shipment มีโลโก้ลูกค้า การ์ดมีแผนที่ + stepper ของ stop + ETA + แชทล่าสุด
- OPINION: สวยแบบ consumer แต่ข้อมูลไม่หนาแน่น เหมาะเป็นมุมมองลูกค้ามากกว่า dispatcher

**5. Reviews** (เว็บรวมรีวิว ตัวเลขขัดกันเอง) ([rfp.wiki](https://www.rfp.wiki/supply-chain-logistics-transportation/third-party-logistics/turvo), [selecthub](https://www.selecthub.com/tms-software/turvo-vs-carrier-logistics/))
- G2 4.4 จาก 20 รีวิว, Capterra 4.1–4.5
- คำบ่น: **ปรับให้เข้ากับ workflow เฉพาะไม่ได้**, learning curve ชัน, support ตอบช้า

**6. Admin**
- ไม่พบข้อมูล


### 2.4 ยุโรป + last-mile/ePOD

หมายเหตุของกลุ่มนี้:
- REA ใช้ไม่ได้ จึงไม่มี screenshot
- เว็บเหล่านี้ตอบ 403: cargoson.com, getapp, capterra.co.uk, help.optimoroute.com (ตัวบทความ) ข้อมูลส่วนนี้มาจาก snippet ของผลค้นหา

#### Dashdoc — TMS สำหรับ carrier/broker ในยุโรป

**0. Segment / demo**
- FACT: TMS สำหรับ carrier และ broker มี 3 แผน Essential/Advanced/Expert มี demo แต่ไม่มี free trial ([pricing](https://www.dashdoc.com/en/pricing))
- FACT: ออฟฟิศที่ Paris/Nantes/Madrid/Antwerp/Boston ลูกค้ามากกว่า 2,000 บริษัท ([team](https://www.dashdoc.com/en/team))
- ไม่พบลูกค้าไทย/SEA

**1. โมดูลเด่น (FACT)**
- **Planning board** ([scheduler](https://help.dashdoc.com/en/articles/4314081-the-scheduler-and-the-unplanned-pool), [plan collection](https://help.dashdoc.com/en/collections/14621909-plan-your-transports))
  - จอแบ่งเป็น order pool (ซ้าย) กับ scheduler (ขวา) ปรับขนาดได้ และลากงานข้ามแท็บเบราว์เซอร์ได้
  - Pool: เลือก ซ่อน หรือเรียงคอลัมน์ได้ และ group/sort ได้
  - Filter ที่ใช้อยู่แสดงเป็น badge สีน้ำเงิน บันทึกเป็น saved view ได้
  - View: Driver/Vehicle/Trailer/Charter และสร้าง custom view แบบ "drivers + charters" ได้
  - ปรับได้ว่าการ์ดงานแสดง field ไหน
  - Drag & drop แล้วกดยืนยัน
  - คลิกขวาที่แถวคนขับ: ใส่วันลา, ผูกหัวกับหาง, ใส่โน้ตรายวัน
  - เวลาขัดกันขึ้นสีแดงแต่ไม่บล็อก
  - checkbox "send to trucker" ส่งงานทั้งวันทีเดียว ปฏิทินขึ้นสีเขียวเมื่อส่งครบ
- **Subcontract (รถร่วม)** ([carriers](https://help.dashdoc.com/en/articles/4879494-carriers-subcontract-your-transports-in-dashdoc), [margin](https://help.dashdoc.com/en/articles/14472031-automatically-apply-a-subcontracting-margin))
  - Flow: Means → "Plan or subcontract" → เลือก carrier และใส่ Cost
  - ระบบแสดงราคา 5 ครั้งล่าสุดที่จ้าง carrier รายนี้ และ preview ใบ charter confirmation ก่อนส่งทาง email
  - สร้าง **parent/child transport**: ลูกค้าเห็นแค่ parent ส่วน update และเอกสารจาก child sync ขึ้น parent
  - Margin % ต่อ partner พร้อม Simulator และ badge "Margin" ถ้าเป็น trip แบ่ง margin ตามสัดส่วน km
- **AP / settlement** ([purchase invoices](https://help.dashdoc.com/en/articles/10627456-create-your-purchase-invoices))
  - filter ตาม carrier → กด "checked" ทีละงานหรือ bulk → สร้าง purchase invoice โดยใส่เลขใบแจ้งหนี้ของ partner
  - ถ้า partner ใช้ Dashdoc ด้วย ระบบเติมเลขให้อัตโนมัติ
  - มี AI purchase invoice และ self-billing
  - การจับคู่ยอดหรือส่วนต่าง: unverified
- **Invoicing (AR)** ([billing](https://help.dashdoc.com/en/articles/7122044-billing-in-dashdoc))
  - งานที่ verify แล้วเข้าคิว Receivables → "create draft invoices" ได้ PDF pro forma ที่อัปเดตตามการแก้
  - งานที่อยู่ใน draft ถูกล็อก
  - จัดบรรทัดได้แบบ Group/Merge/Single line
  - Finalize แล้วแก้ไม่ได้ ต้องออก credit note เท่านั้น
  - draft ไม่ถูกส่งเข้าโปรแกรมบัญชี
- **e-CMR** ([sign](https://help.dashdoc.com/en/articles/5491062-how-do-i-sign-a-waybill-on-dashdoc), [driver app](https://www.dashdoc.com/en/tms/mobile-application-drivers))
  - ในแอป: Confirm loading details → Validate and sign → ผู้รับเซ็น → ยืนยันด้วย OTP ทาง SMS/email
  - โหมดอื่น: contactless (ลิงก์ email), กระดาษ+รูป
  - Marketing บอกว่าแอปทำงาน offline ได้แล้ว sync ทีหลัง แต่ OTP ตอน offline: unverified

**2. ERP/บัญชี (FACT)**
- connector: Exact Online, Pennylane, Sage 100/50 และ public API ([integrations](https://www.dashdoc.com/en/integrations/billing))
- Billit/Winbooks มีปุ่ม "Synchronize VAT rates and invoice item catalog" invoice item กำหนด VAT ของบรรทัด และระบบจำ item ล่าสุดต่อลูกค้า ([invoice items](https://help.dashdoc.com/en/articles/8586609-managing-invoice-items-with-a-third-party-tool))
- export FEC ได้ทั้งขายและซื้อ พร้อม accounting codes
- API: เปลี่ยน carrier ของงาน charter ต้อง cancel child แล้ว charter ใหม่ ([dev docs](https://developer.dashdoc.com/docs/use-cases-and-tutorials/carriers/chartering-affretement))
- การ map เลขเอกสารสองฝั่งและการ re-sync: unverified

**3. Pricing (FACT)**
- คิด**ต่อ active driver** ถ้าเกินจำนวนในสัญญาคิดเพิ่ม 20% deactivate แล้วหยุดคิดเงิน ([active drivers](https://help.dashdoc.com/en/articles/12932928-better-understand-your-dashdoc-invoice-active-drivers-overages))
- ไม่เปิดเผยราคา add-on: route optimisation, shipper pack, EDI

**4. UI**
- OPINION: data grid แน่น แต่ลดความรกด้วย saved views, filter badges และการ์ดที่เลือก field ได้
- ไม่มี screenshot

**5. Reviews**
- FACT: G2 0 รีวิว ([g2](https://www.g2.com/sellers/dashdoc)), Capterra 0 รีวิว ([capterra](https://www.capterra.com/p/214820/Modash/))
- คำบ่น: ไม่พบข้อมูล

**6. Admin (FACT)**
- roles: Read-Only/Manager/Dispatcher/Admin/**Invoicer** ส่วน custom roles เป็นของแผน Expert ("coming soon") ([roles](https://help.dashdoc.com/en/articles/15705663-user-roles-in-dashdoc-new-features-upcoming-developments))
- หลายนิติบุคคลในบัญชีเดียว + group view ([setup](https://help.dashdoc.com/en/collections/3687085-set-up-your-account))

#### Cargoson — TMS ฝั่ง shipper (เรียนรู้เฉพาะบางเรื่อง)

**ข้อเท็จจริง**
- FACT (snippet): TMS สำหรับผู้ผลิตและผู้ค้าส่ง เป็น carrier-neutral ([pricing](https://www.cargoson.com/en/pricing))
- เชื่อม carrier มากกว่า 2,000 ราย ผ่าน API/EDI มี rate compare, booking, label/CMR ([rfp.wiki](https://www.rfp.wiki/vendors/cargoson), แหล่งนี้เขียนด้วย AI ความน่าเชื่อถือต่ำ)
- ไม่มี trial
- **ERP:** connector D365 F&O ([d365](https://www.cargoson.com/integrations/ct-cargo-s-r-o/d365fo))
  - Flow: ขอราคา → สร้าง transport order → ส่ง status กลับ ERP
  - เทียบใบแจ้งหนี้ค่าขนส่งกับยอดที่คำนวณไว้ก่อน
  - มี NetSuite/Odoo ด้วย
- **ราคา:** ตัวเลขขัดกันเอง
  - หน้า pricing ระบุ Basic $199/เดือน
  - อีกหน้าระบุ Standard €299 / Advanced €599 ([lp](https://www.cargoson.com/lp/nshift-alternative))
  - tier แบ่งตาม user และ shipment/เดือน
- **Reviews:** Capterra 4.8 จาก 52 รีวิว ([reviews](https://www.capterra.com/reviews/228964/Cargoson))
  - คำบ่น: คำนวณราคาอัตโนมัติไม่ได้เมื่อมี pallet/กล่องผสม, carrier ที่ไม่มี EDI ใช้ได้ไม่เต็มที่, submodule ต้องซื้อเพิ่ม

**OPINION:** เรียนแค่ 2 เรื่อง คือ pattern ERP→order→status กลับ และ rate engine ที่รองรับ handling unit ผสม

#### Track-POD — last-mile ePOD

**ข้อเท็จจริง**
- FACT: ePOD + route planning มี free trial ไม่ต้องใช้บัตร ([features](https://www.track-pod.com/features/))
- **ePOD:** ลายเซ็น, รูป, สแกน barcode
  - **Actual Quantity** สำหรับส่งของไม่ครบ
  - บันทึกเหตุผลที่สินค้าถูก reject
  - "matrix of reasons for non-signing documents" ตั้งได้บน dashboard
  - COD ต้องกรอกยอดเงิน
  - API มี catalog `RejectReason` ([api](https://github.com/api-evangelist/track-pod))
- **Offline:** "works offline and sync all data when connection is restored" แต่ไม่มีเอกสารเรื่อง conflict
- **Integration:** QuickBooks/Xero/Sage/MYOB, API + webhooks, Zapier ([api-integration](https://track-pod.com/api-integration/), [zapier](https://zapier.com/apps/track-pod/integrations/xero))
- **ราคา** (แหล่งรองจากคู่แข่งชื่อ Upper เพราะหน้าราคาทางการตอบ 404) ([upper](https://www.upperinc.com/blog/track-pod-pricing.txt))
  - ต่อคนขับ $49/$69/$89 ต่อเดือน ขั้นต่ำ 3 คน
  - หรือต่อ order: 1,500 orders = $285
- **Reviews:** 4.5 ทั้ง G2 และ Capterra (ตาม Upper)
  - คำบ่น: ฟีเจอร์ล็อกตาม tier, เพิ่มคนขับแพง, เพิ่มคนขับกลางสัญญาแล้วโดนเก็บเงินเต็มปี

#### Onfleet — last-mile dispatch

**ข้อเท็จจริง**
- **Failure reasons** ([complete task](https://support.onfleet.com/hc/en-us/articles/10373142665364-Complete-a-Task), [custom reasons](https://intercom.help/onfleet-4f83d83093ac/en/articles/15254791-custom-task-completion-reasons))
  - คนขับเลือก Failure แล้วเลือกเหตุผล เช่น ผู้รับไม่อยู่/ปฏิเสธ/หาที่ไม่เจอ/อุบัติเหตุ/Other
  - Dispatcher Force Complete ได้
  - Custom reasons ตั้งได้ที่ Settings > Driver App > Task Completion Reasons
    - แยกหมวด Success/Failed และลากเรียงได้
    - บังคับ notes ต่อเหตุผลได้
    - แก้เหตุผลแล้วไม่ย้อนไปเปลี่ยน task เก่า
    - เลือกแสดงบน tracking page ได้
    - ใช้ได้เฉพาะแผน Scale ขึ้นไป
- **Offline:** ปิดไว้เป็นค่าเริ่มต้น Admin เปิดได้ และมีผลใน session ถัดไปของคนขับ ([offline](https://intercom.help/onfleet-4f83d83093ac/en/articles/15254706))
- **ราคา** คิดตาม task ที่ completed user ไม่จำกัด ([pricing](https://onfleet.com/pricing))
  | แผน | ราคา/เดือน | task/เดือน |
  |---|---|---|
  | Launch | $619 | 2,500 |
  | Scale | $1,349 | 5,000 |
  | Enterprise | ตั้งแต่ ~$3,099 | 10,000+ |
  - เก็บข้อมูล 90 วัน / 1 ปี / ตลอดไป ตามแผน
- **Reviews:** G2 4.6 จาก 140 รีวิว ข้อเสียหลัก "limited/missing features" ([g2](https://www.g2.com/compare/onfleet)) Capterra บ่นว่าแพงสำหรับธุรกิจเล็ก ([capterra](https://www.capterra.com/p/142633/onfleet/))

#### OptimoRoute — route planning

**ข้อเท็จจริง**
- **ราคา:** Lite $35.10 / Pro $44.10 ต่อคนขับ/เดือน คิดเฉพาะคนขับที่ถูก plan ในเดือนนั้น trial 30 วัน ไม่ต้องใช้บัตร ([pricing](https://optimoroute.com/pricing/))
- **Planning UI** (snippet ของ help center) ([timeline](https://help.optimoroute.com/hc/en-us/articles/27713882472084-View-and-configure-the-timeline), [plan routes](https://help.optimoroute.com/hc/en-us/sections/27660907517332-Plan-routes))
  - timeline: คนขับอยู่ซ้าย route อยู่ขวา
  - ลากงานจาก map หรือ timeline แล้วเข้าโหมด Edit อัตโนมัติ
  - แผง "Unscheduled orders"
  - กด "Apply changes" เพื่อบันทึก
  - มีบทความ "Reasons for orders not being scheduled" คือระบบอธิบายว่าทำไม order ไม่ได้ลง route
- **ePOD:** Administration > Settings > Proof of Delivery ([pod](https://optimoroute.com/proof-of-delivery))
  - notes/signature/photo/barcode ตั้งเป็น Enabled หรือ **Required** ได้ทีละตัว
  - ใช้กับ failed orders ได้ด้วย
- **Offline:** ไม่พบเอกสาร
- **Reviews:** Capterra 4.6 จาก ~250 รีวิว ([reviews](https://capterra.com/p/161579/OptimoRoute/reviews/))
  - คำบ่น: "too rigid for real-world logistics", route ระหว่างจุดใกล้กันไม่แม่น


### 2.5 Open source

#### LogisticsX (suxrobGM/logistics-app) — open source, ดูเพื่อเรียนรู้โครง

ที่มา: อ่าน commit `c63226e` (2026-10-31) โดยไม่ build หรือรันอะไร ลิงก์ทั้งหมดชี้ไปที่ `https://github.com/suxrobGM/logistics-app/blob/main/...`
**ข้อจำกัด (FACT):** repo สาธารณะมีแค่ backend .NET 10 ส่วน Angular portals และ driver app (Kotlin Multiplatform) อยู่ใน private submodule จึงตรวจโค้ดไม่ได้ ([README](https://github.com/suxrobGM/logistics-app/blob/main/README.md), [.gitmodules](https://github.com/suxrobGM/logistics-app/blob/main/.gitmodules))
**License (FACT):** PolyForm Noncommercial ([COMMERCIAL-LICENSE.md](https://github.com/suxrobGM/logistics-app/blob/main/COMMERCIAL-LICENSE.md)) จึง **ห้าม copy โค้ด หยิบได้แค่แนวคิด**

**0. Segment / demo**
- FACT: เป็น carrier TMS สำหรับบริษัทรถบรรทุกเล็กในสหรัฐฯ และยุโรป
- FACT: มี live demo ที่ https://tms.logisticsx.app และ customer portal ที่ https://customer.logisticsx.app ([test-credentials](https://github.com/suxrobGM/logistics-app/blob/main/docs/getting-started/test-credentials.md))
- ไม่พบลูกค้าไทยหรือ SEA

**1. โครงและโมดูลเด่น**
- **สถาปัตยกรรม (FACT):** DDD monolith แบบ CQRS แยก Core / Infrastructure / Presentation
  - Application แบ่ง 6 module: Operations, Compliance, Financial, IdentityAccess, Integrations, Platform
  - แต่ละ feature เป็นโฟลเดอร์ `Commands/{Verb}{Entity}/{Command,Handler,Validator}`
  - pipeline: Validation → FeatureCheck (ตาม plan) → Handler
  - บังคับ layering ด้วย architecture tests
  - ที่มา: [module-layout.md](https://github.com/suxrobGM/logistics-app/blob/main/docs/architecture/module-layout.md), [overview.md](https://github.com/suxrobGM/logistics-app/blob/main/docs/architecture/overview.md)
- **Load (FACT):** งาน 1 ต้นทาง → 1 ปลายทาง ([Load.cs](https://github.com/suxrobGM/logistics-app/blob/main/src/Core/Logistics.Domain/Entities/Load/Load.cs), [LoadStatusMachine.cs](https://github.com/suxrobGM/logistics-app/blob/main/src/Core/Logistics.Domain/Entities/Load/LoadStatusMachine.cs))
  - status: Draft → Dispatched → PickedUp → Delivered และ Cancel ได้
  - คุม transition ด้วย state machine
  - มี timestamp แยกตามสถานะ
  - เก็บแหล่งที่มา `Source` (Manual/Email/Pdf/Api/Import) + `ExternalSourceId`
  - reason codes `LoadExceptionType` = Delay/Accident/WeatherDelay/MechanicalFailure/RouteChange/CustomerRequest/Other
- **Trip (FACT):** รวมหลาย Load ผ่าน `TripStop` (PickUp/DropOff, Order, ArrivedAt, DepartedAt) และมี Truck, Driver, SecondaryDriver, Trailer ([Trip.cs](https://github.com/suxrobGM/logistics-app/blob/main/src/Core/Logistics.Domain/Entities/Trip/Trip.cs))
  - สถานะ trip คำนวณจาก load
  - ยกเลิก trip จะยกเลิก load ตามไปด้วย ยกเว้น load ที่ส่งแล้ว
- **Billing (FACT):** ([invoices.md](https://github.com/suxrobGM/logistics-app/blob/main/docs/invoices.md), [Invoice.cs](https://github.com/suxrobGM/logistics-app/blob/main/src/Core/Logistics.Domain/Entities/Invoice/Invoice.cs))
  - draft invoice ถูกสร้างพร้อม load
  - เมื่อ load เปลี่ยนจะ rebuild เฉพาะบรรทัดที่ระบบสร้าง และเก็บบรรทัดที่ผู้ใช้เพิ่มเองไว้ ถ้า invoice เป็น paid หรือ cancelled จะไม่ rebuild
  - copy ราคา accessorial จาก catalog มาเก็บบน load เป็น snapshot
  - คิด detention จากเวลาที่คนขับกด arrive/depart
  - InvoiceStatus: Draft…Issued/Sent/PartiallyPaid/Paid/Overdue/Cancelled คำนวณจากผลรวมของ Payment
  - **ข้อสังเกต:** 1 LoadInvoice ต่อ 1 Load และใช้เลข `Number` identity ร่วมกันทุกประเภท
- **Settlement คนขับ/owner-operator (FACT):** ([Employee.cs](https://github.com/suxrobGM/logistics-app/blob/main/src/Core/Logistics.Domain/Entities/Employee.cs))
  - PayrollInvoice มีบรรทัด gross + บรรทัดหักติดลบ (lease/insurance/escrow/cash advance/fuel card)
  - มี approval flow ถ้า reject รายการหักจะถูกคืน
  - generate อัตโนมัติรายสัปดาห์และรายเดือน
  - SalaryType มี ShareOfGross/PerLoad/PerStop/RatePerDistance ฯลฯ
  - รถร่วมถูกเก็บเป็น Employee ไม่มี entity Carrier แยก

**2. ERP/บัญชี: QuickBooks Online (FACT)** ([accounting-quickbooks-setup.md](https://github.com/suxrobGM/logistics-app/blob/main/docs/accounting-quickbooks-setup.md), [QboEntityMapping.cs](https://github.com/suxrobGM/logistics-app/blob/main/src/Core/Logistics.Domain/Entities/Accounting/QboEntityMapping.cs), [IAccountingProviderService.cs](https://github.com/suxrobGM/logistics-app/blob/main/src/Core/Logistics.Application.Abstractions/Accounting/IAccountingProviderService.cs), [roadmap](https://github.com/suxrobGM/logistics-app/blob/main/docs/roadmap/quickbooks-sync.md))
- sync **ทางเดียว** ทุก 15 นาที + ปุ่ม Sync now
- ดึงแบบ incremental สูงสุด 500 รายการต่อชนิดต่อรอบ
- `SyncFromDate` กัน push ประวัติซ้ำ
- invoice ถูกยกเลิกหลัง push → void ฝั่ง QBO
- ตาราง mapping เก็บ LocalId/LocalEntityType/QboId/SyncToken/**LastSyncedHash**/LastSyncedAt/SyncStatus (Synced/Failed/Retired)/LastError
- port `Upsert{Customer,Vendor,Invoice,Payment,Expense,Bill}` + `Void*` + provider factory + Demo provider
- inbound webhook มี ledger `ProcessedWebhookEvent` unique(provider,eventKey)
- **ยังไม่ทำ:** ข้อมูลไม่ไหลกลับจาก QBO และ tax ส่งเป็นยอดรวม

**3. Pricing (FACT)**
- Starter/Professional/Enterprise คิดแบบ `BaseFee + PerTruckFee` ([domain-model.md](https://github.com/suxrobGM/logistics-app/blob/main/docs/architecture/domain-model.md))
- roadmap ระบุ Starter 1 คัน = $41/เดือน ([owner-operator-mode.md](https://github.com/suxrobGM/logistics-app/blob/main/docs/roadmap/owner-operator-mode.md))

**4. UI/UX**
- มี screenshot 37 ภาพใน [docs/images/tms-portal](https://github.com/suxrobGM/logistics-app/tree/main/docs/images/tms-portal)
- local copy: `assets/logisticsx-1.png` (Loads list), `assets/logisticsx-2.png` (Invoice dashboard), `assets/logisticsx-3.png` (Payroll)
- OPINION:
  - sidebar สีอ่อนแบ่งกลุ่ม Main/Dispatch/Fleet และมี Favorites
  - มี KPI card 3 ใบเหนือ filter
  - status chip มีสี และ route chip แบบ "A → B"
  - ใช้ spartan/ui + Tailwind ดูสะอาดและเป็นทางการ

**5. Reviews**
- N/A เพราะไม่มี listing บน G2/Capterra

**6. Multi-tenant / admin** ([multi-tenancy.md](https://github.com/suxrobGM/logistics-app/blob/main/docs/architecture/multi-tenancy.md), [Permissions.cs](https://github.com/suxrobGM/logistics-app/blob/main/src/Shared/Logistics.Shared.Identity/Policies/Permissions.cs), [TenantFeature.cs](https://github.com/suxrobGM/logistics-app/blob/main/src/Core/Logistics.Domain.Primitives/Enums/Tenant/TenantFeature.cs), [features.md](https://github.com/suxrobGM/logistics-app/blob/main/docs/features.md))
- FACT: แยก **DB ต่อ tenant** โดยมี master DB เก็บ Tenant/Plan/User
- FACT: หา tenant จาก header `X-Tenant` หรือ JWT claim และมี `UserTenantAccess` ให้ user คนเดียวเข้าได้หลาย tenant
- FACT: roles: owner/manager/dispatcher/driver/customer
- FACT: permission รูปแบบ `Permission.{Module}.{View|Manage}` มี 39 module ผูกกับ TenantRole ที่ tenant แก้เองได้
- FACT: feature gating = PlanFeature + TenantFeatureConfig override
- FACT: SuperAdmin impersonate ได้ และมี audit log
- FACT: tenant จัดการเองได้: roles, invitations, settings, accessorial catalog, integrations, setup checklist

**Driver app / offline**
- unverified เพราะโค้ดแอปเป็น private
- OPINION จาก backend: `ConfirmLoadStatusCommand` ใช้เวลาของ server และไม่มี idempotency key จึงน่าจะออกแบบให้ online เป็นหลัก ([ConfirmLoadStatusHandler.cs](https://github.com/suxrobGM/logistics-app/blob/main/src/Core/Logistics.Application/Modules/Operations/Loads/Commands/ConfirmLoadStatus/ConfirmLoadStatusHandler.cs))
- FACT: ปุ่มยืนยันสถานะกดได้เฉพาะใน geofence (`IsInProximity`) ([DriverController.cs](https://github.com/suxrobGM/logistics-app/blob/main/src/Presentation/Logistics.API/Controllers/DriverController.cs))

**Patterns to copy (OPINION)**
- module ตาม bounded context + โฟลเดอร์ commands/queries ต่อ use-case (`@nestjs/cqrs`)
- state machine เป็น map + timestamp แยกตามสถานะ
- แยก Load กับ Trip แล้วเชื่อมด้วย TripStop
- ราคาเป็น snapshot บน order
- invoice line มี `sourceType/sourceId` เพื่อ rebuild เฉพาะบรรทัดระบบ
- Payment แยกตาราง
- settlement = บรรทัด gross + บรรทัดหัก
- ตาราง ExternalMapping แบบ generic + hash + syncFromDate + หน้า Sync errors พร้อมปุ่ม Retry
- provider factory + Demo provider
- webhook ledger
- permission `{module}.{view|manage}` + plan feature flags (ต้องเช็คซ้ำใน cron job ด้วย)

**Patterns to avoid (OPINION)**
- DB-per-tenant: กับ Prisma ยุ่งยาก ใช้ shared schema + `tenantId` + RLS แทน
- เลขเอกสาร identity ตัวเดียว: ไทยต้องมี series แยกตามประเภท สาขา และปี
- 1 invoice : 1 load: ไทยวางบิลรวมหลาย DO
- assign งานให้รถแล้วหาคนขับจาก mainDriver: ควรเก็บ snapshot คนขับต่อเที่ยว
- รถร่วมเป็น Employee: ควรแยก entity Carrier ที่มีหัก ณ ที่จ่าย 1%
- driver API ไม่มี clientEventId หรือ occurredAt จากเครื่อง
- sync ทางเดียวที่ไม่ reconcile กลับ


---

## 3. สิ่งที่เราควรหยิบมาใช้ (OPINION จัดกลุ่มตามโมดูล)

ความยากหมายถึงความยากในการ implement บน NestJS/Prisma/PostgreSQL ของเรา แบ่งเป็น ต่ำ / กลาง / สูง

### 3.1 Platform / Auth

| # | สิ่งที่หยิบ | จากใคร | ปรับให้เข้ากับบริบทไทย/KRS | ความยาก |
|---|---|---|---|---|
| P1 | Shared schema + `tenantId` ทุกตาราง + Postgres RLS (ไม่ทำ DB-per-tenant) | ทำตรงข้ามกับ LogisticsX | ใช้ Prisma client extension ใส่ `tenantId` ให้อัตโนมัติ + RLS เป็นชั้นป้องกันที่สอง และตั้ง unique เป็น `(tenantId, docNo)` | กลาง |
| P2 | Permission รูปแบบ `{module}.{view\|manage}` + role เริ่มต้นที่ tenant แก้เองได้ | LogisticsX, Shipsy | role เริ่มต้น: เจ้าของ / ผู้จัดการ / dispatcher / **ฝ่ายวางบิล (Invoicer)** / บัญชี / คนขับ / รถร่วม / ลูกค้า โดยแยก "ฝ่ายวางบิล" ออกจาก dispatcher ตามแบบ Dashdoc | ต่ำ |
| P3 | Permission ระดับ field สำหรับราคา (ดูหรือแก้ราคาขาย, ดูราคารถร่วม) | Alvys | dispatcher มักไม่ควรเห็นราคาขาย ส่วนรถร่วมต้องไม่เห็นราคาขายเด็ดขาด | ต่ำ |
| P4 | ถอนสิทธิ์แล้วบังคับ logout ทันที | Alvys | ใช้ token version ต่อ user แล้วตรวจใน guard | ต่ำ |
| P5 | Feature flag ตาม plan + override ราย tenant (และต้องตรวจซ้ำใน cron job) | LogisticsX | ใช้ gate add-on เช่น รถร่วม, KRS adapter, route optimization | ต่ำ |
| P6 | Impersonation ของ support พร้อม audit log | LogisticsX | จำเป็นสำหรับ onboarding ลูกค้าไทยที่ต้องการให้ช่วยตั้งค่า | ต่ำ |
| P7 | Portal แยกตามผู้ใช้ภายนอก: รถร่วม / ลูกค้า / คนขับ | Rose Rocket, Shipsy | Partner portal สำหรับรถร่วมเริ่มจาก "ลิงก์ไม่ต้อง login" ก่อน (ดู PL4) | กลาง |
| P8 | Setup checklist + import master ด้วย Excel พร้อม dry-run | LogisticsX, Shipsy | ลูกค้าไทยมี master อยู่ใน Excel เกือบทั้งหมด | กลาง |
| P9 | หลายนิติบุคคลหรือหลายสาขาใน tenant เดียว | Dashdoc, Alvys (subsidiary) | ไทยต้องใช้สาขาตาม ภ.พ.20 (00000/00001) เพื่อออกใบกำกับภาษี และ map 1 สาขากับ 1 company ใน KRS | กลาง |

### 3.2 Master data

| # | สิ่งที่หยิบ | จากใคร | ปรับอย่างไร | ความยาก |
|---|---|---|---|---|
| M1 | แยก entity `Carrier` (รถร่วม) ออกจาก `Driver` และให้ vehicle มี `ownership = OWN\|SUBCONTRACT` | ตรงข้ามกับ LogisticsX, ตามแบบ Shipsy (vendor master + vehicle mapping) | Carrier เก็บ เลขผู้เสียภาษี, บุคคลหรือนิติบุคคล, บัญชีธนาคาร, อัตราหัก ณ ที่จ่าย (1%) และ parent vendor | ต่ำ |
| M2 | ประเภทคนขับ 3 แบบ: รถร่วม / พขร.มีเงินเดือน / พขร.ไม่มีเงินเดือน (รายเที่ยว) | Treasure TMS | ใช้ตัดสินวิธีคิดค่าเที่ยวและวิธีออกเอกสาร | ต่ำ |
| M3 | Rate card ใช้ key `(ต้นทาง, ปลายทาง, ประเภทรถ)` + วันเริ่ม/หมดอายุ + workflow อนุมัติ | Shipsy, Locus (contract), NOSTRA | มี 2 ฝั่ง คือ ราคาขาย (ลูกค้า) และราคาซื้อ (รถร่วม) ใช้โครงเดียวกัน แก้ได้ทั้งในฟอร์มและด้วย Excel import (Shipsy ทำได้แค่ CSV) | กลาง |
| M4 | สูตรคิดราคา: OD matrix / ตามระยะทางหรือน้ำหนัก / เหมาเที่ยว + "เกิน N จุดคิดเพิ่มต่อจุด" + fuel surcharge ตามช่วงเวลา | NOSTRA, Locus (cost params) | เริ่มด้วย 4 แบบที่ไทยใช้จริง: เหมาเที่ยว, ตามระยะทาง, ตามน้ำหนักหรือคิว, เหมาวัน (แบบ Shipsy "12hrs_01 days") | สูง |
| M5 | Catalog ค่าใช้จ่ายเพิ่ม (ค่าแรงลง, ค่ารอ, ค่าผ่านทาง) โดย**copy ราคาลง order เป็น snapshot** | LogisticsX | ป้องกันกรณีแก้ราคาแล้ว invoice เก่าเปลี่ยนตาม | ต่ำ |
| M6 | ตรวจว่าประเภทรถรับประเภทงานได้ไหม (ห้องเย็น, 6 ล้อ, 10 ล้อ, หัวลาก+หาง) | LogisticsX, NOSTRA | ใช้เป็น constraint ตอน assign | ต่ำ |
| M7 | Reason master ที่ tenant ตั้งเองได้: แยกหมวด (ค้างวางแผน / ส่งไม่สำเร็จ / ปฏิเสธรับ / ไม่เซ็นเอกสาร) + flag "บังคับรูป/โน้ต" + flag "auto-reschedule" | Onfleet, Shipsy, Track-POD | เก็บ snapshot ข้อความเหตุผลลงงาน (แก้ master แล้วไม่ย้อนแก้งานเก่าแบบ Onfleet) และมีชุดค่าเริ่มต้นภาษาไทย | ต่ำ |

### 3.3 Order intake

| # | สิ่งที่หยิบ | จากใคร | ปรับอย่างไร | ความยาก |
|---|---|---|---|---|
| O1 | Upsert order ด้วย **ID ภายนอก** (`PUT /orders/{externalId}`) แบบ idempotent | Locus | KRS adapter ส่ง DO/SO เลขของ KRS มาเป็น key โดยเก็บ `source` + `externalRef` ตามแบบ LogisticsX `LoadSource/ExternalSourceId` | ต่ำ |
| O2 | ที่มาของ order: Manual / Excel / KRS / Portal / API | LogisticsX, Rose Rocket | Excel import ต้องมาก่อน AI-PDF | ต่ำ |
| O3 | Customer portal ให้ลูกค้าสร้างงาน, duplicate งานเดิม และค้นสถานะด้วยเลข PO ของตัวเอง | Rose Rocket, Treasure | ทำเฟสหลัง โดยเริ่มจาก tracking link ก่อน | กลาง |
| O4 | Lock order ขณะกำลังแก้ (ป้าย "กำลังแก้ไขโดย…") | Alvys | ทีม dispatch ไทยมักแก้งานเดียวกันพร้อมกันหลายคน | ต่ำ |

### 3.4 Planning / Dispatch

| # | สิ่งที่หยิบ | จากใคร | ปรับอย่างไร | ความยาก |
|---|---|---|---|---|
| PL1 | **โมเดล Order (DO) ↔ Trip ↔ TripStop**: order หนึ่งแตกเป็นหลาย leg ได้ และ trip หนึ่งรวมหลาย order ได้ | Rose Rocket (Manifest), LogisticsX (TripStop), Alvys (split) | Trip = "ใบคุมรถ" (Hublink) เก็บ `driverId`/`vehicleId`/`trailerId` **เป็น snapshot ต่อเที่ยว** | กลาง |
| PL2 | Planning board แบบ split: ซ้ายเป็นงานค้าง (pool) ขวาเป็น scheduler ตามรถหรือคนขับ + drag & drop + saved views + filter badges | Dashdoc, OptimoRoute, Alvys | view เริ่มต้นคือ "รถบริษัท + รถร่วม" รวมในจอเดียว | สูง |
| PL3 | คลิกงานแล้วรถที่รับได้ถูกกรองให้อัตโนมัติ (และกลับกัน) + "ว่างเมื่อไหร่/ที่ไหน" = เวลาส่งเสร็จ + dwell | Alvys | เริ่มจากกฎง่าย ๆ ก่อน ยังไม่ต้องทำ optimizer | กลาง |
| PL4 | **จ่ายงานรถร่วม**: เลือกรถร่วม → แสดงราคา 5 ครั้งล่าสุด → preview ใบสั่งงาน → ส่งลิงก์ (LINE/SMS) → รถร่วมกดรับพร้อมใส่ทะเบียนรถและคนขับ หรือกดปฏิเสธ ลิงก์มีอายุ 48 ชม. | Dashdoc, Alvys, Shipsy | **ส่งผ่าน LINE** แทนอีเมล และรับงานได้โดยไม่ต้องมี account | กลาง |
| PL5 | Cascade หารถร่วม: จัดรถบริษัทก่อน → ส่งให้รถร่วม P1 → ถ้าปฏิเสธส่ง P2 + มีเพดานจำนวนเที่ยวต่อรถร่วม หรือกติกา "ถูกสุดก่อน" | Shipsy, Treasure, NOSTRA (quota) | ต้องบันทึกเหตุผลการเลือกให้ตรวจสอบย้อนได้ เพราะ Treasure ขายจุดนี้ว่าช่วย "ลดการทุจริต" | สูง |
| PL6 | Margin ต่อรถร่วม (%) + simulator, และงานที่จ้างรถร่วมเป็น parent/child (ลูกค้าเห็นแค่ parent) | Dashdoc | ใช้ child เก็บต้นทุนรถร่วมและ POD ของรถร่วม | กลาง |
| PL7 | Reason code มาตรฐานของ**งานค้างวางแผน** (ไม่มีรถว่าง / เกินความจุ / รถร่วมปฏิเสธ / ที่อยู่ผิด / หลุดช่วงเวลา) + แสดงเหตุผลว่าทำไมงานยังไม่ได้ลง | Locus, OptimoRoute | ตรงกับโจทย์ "ใบค้างและการแจ้งเหตุผล" โดยตรง ใช้แสดงเป็น badge บน pool | ต่ำ |
| PL8 | เวลาขัดกันขึ้นสีแดงแต่ไม่บล็อก + ส่งงานทั้งวันทีเดียว ("send to trucker") | Dashdoc | dispatcher ไทยมักวางงานตอนเย็นแล้วส่งตอนเช้า | ต่ำ |
| PL9 | Assign กับ Assign & dispatch แยกปุ่ม + bulk actions | Alvys | | ต่ำ |
| PL10 | แบ่งต้นทุน trip ตามน้ำหนัก/ระยะ และแบ่งรายได้ order ตาม % ต่อ leg | Rose Rocket, Dashdoc (margin ตามสัดส่วน km) | ใช้คิดกำไรต่อ DO/ต่อลูกค้า เมื่อรถรวมหลายงาน | กลาง |

### 3.5 Execution / POD / Driver app

| # | สิ่งที่หยิบ | จากใคร | ปรับอย่างไร | ความยาก |
|---|---|---|---|---|
| E1 | **Offline-first** โดยมี `clientEventId` (UUID) + `occurredAt` จากเครื่อง + GPS + outbox queue และ server ต้อง idempotent | NOSTRA/Track-POD/Dashdoc (ประกาศว่ามี offline), LogisticsX (ตัวอย่างที่**ไม่ควร**ทำ) | สัญญาณในต่างจังหวัด/โกดังไม่เสถียร จุดนี้จึงห้ามพลาด และควรเป็น setting ระดับ tenant แบบ Onfleet | สูง |
| E2 | POD config แบบ checklist: รูป/ลายเซ็น/โน้ต/barcode ตั้งเป็น Enabled หรือ Required ได้ทีละตัว แยกตามกรณีสำเร็จหรือไม่สำเร็จ | OptimoRoute, Locus | ตั้งได้ต่อลูกค้า เพราะลูกค้าแต่ละรายต้องการหลักฐานต่างกัน | กลาง |
| E3 | **Actual Quantity** (ส่งได้จริงเทียบกับแผน) + reject reason ต่อรายการ | Track-POD | ใช้กับ DO ที่มีหลายรายการสินค้า และส่งผลถึงวางบิลตามยอดส่งจริง | กลาง |
| E4 | ปุ่มถึงหรือออกจากจุดกดได้เฉพาะใน geofence + เตือนเมื่อปิดงานห่างจากจุด X กม. | EyeFleet, LogisticsX, Locus | ไม่บล็อกเด็ดขาด ให้เป็นการเตือนแล้วบังคับระบุเหตุผล เพราะพิกัดลูกค้าไทยมักไม่แม่น | ต่ำ |
| E5 | GPS จากมือถือคนขับแทนกล่อง GPS สำหรับรถร่วม | Logis Boy | อีกทางคือ connector ดึงข้อมูลจาก GPS หลายยี่ห้อแบบ NOSTRA | กลาง |
| E6 | ePOD สำหรับรถร่วมที่**ไม่ติดตั้งแอป**: ค้นด้วยเลข DO แล้วอัปโหลดรูปผ่านลิงก์ | Shipsy | จำเป็นมาก เพราะรถร่วมไทยหลายรายไม่ยอมลงแอป | ต่ำ |
| E7 | สถานะ "ส่งไม่สำเร็จแต่ของยังอยู่บนรถ" + auto-reschedule ตาม reason | Shipsy | | ต่ำ |
| E8 | หลายคนขับต่อเที่ยว (งานทางไกล) + เลขตู้คอนเทนเนอร์ | NOSTRA, LogisticsX, EyeFleet | | ต่ำ |
| E9 | Tracking link สาธารณะที่มีแบรนด์ ให้ผู้รับค้นด้วยเลข DO | Alvys, EyeFleet | | ต่ำ |
| E10 | Arrive/depart ต่อจุดใช้คำนวณ**ค่ารอ (detention)** อัตโนมัติ | LogisticsX | ตั้ง free time ต่อลูกค้าได้ | กลาง |

### 3.6 Billing (AR วางบิลลูกค้า + AP จ่ายรถร่วม/คนขับ)

| # | สิ่งที่หยิบ | จากใคร | ปรับอย่างไร | ความยาก |
|---|---|---|---|---|
| B1 | **ทุกเที่ยวมีทั้ง revenue line และ cost line** ตั้งแต่ตอนสร้าง (draft) | Treasure, LogisticsX | rebuild เฉพาะบรรทัดที่ระบบสร้าง และเก็บบรรทัดที่ผู้ใช้เพิ่มเองไว้ (LogisticsX) | กลาง |
| B2 | คิว "พร้อมวางบิล" → เลือกหลาย DO/เที่ยว → ใบวางบิล **draft (แก้ได้, ล็อกงานที่อยู่ในบิล)** → **finalize (immutable)** → แก้ด้วยใบลดหนี้/เพิ่มหนี้เท่านั้น | Dashdoc, Rose Rocket | ไทยต้องแยก **ใบวางบิล / ใบแจ้งหนี้ / ใบกำกับภาษี / ใบเสร็จ** และมีใบลดหนี้/เพิ่มหนี้ตามกฎหมาย | สูง |
| B3 | Flag "วางบิลแล้ว" + รายงานงานที่ยังไม่วางบิล เพื่อกันวางบิลซ้ำหรือหลุด | Treasure, Logis Boy (Delivery Slip control) | Unique constraint `(tripId/orderLineId)` ใน invoice line ที่ยัง active อยู่ | ต่ำ |
| B4 | **Status lifecycle ที่มีกฎ revert**: Delivered → Released (ส่งบัญชี) → Invoiced → Paid โดยกำหนด permission ต่อ transition และล็อกหลัง Paid | Alvys | ใช้ state machine เป็น map + timestamp ต่อสถานะ (LogisticsX) | กลาง |
| B5 | **Settlement รถร่วม**: ติ๊กเที่ยวที่ตรวจแล้ว → สร้างใบสำคัญจ่าย พร้อมใส่เลขใบแจ้งหนี้ของรถร่วม → ส่งให้รถร่วมตรวจก่อน → approve → จ่าย | Dashdoc, Rose Rocket, Alvys | **หัก ณ ที่จ่าย 1% + ออกหนังสือรับรอง 50 ทวิ** (Treasure), หักเงินเบิกล่วงหน้า/ค่าน้ำมัน/ค่าปรับเป็นบรรทัดติดลบ (LogisticsX) | สูง |
| B6 | สถานะ **Disputed** ต่อรายการจ่ายรถร่วม (dispute บล็อก approve) + หน้าจอเอกสารคู่ยอด | Alvys (Super Settle View), Locus (planned vs executed vs claimed) | ใช้กฎ "ไม่มี POD ไม่จ่าย" แบบ Shipsy เป็น option ได้ | กลาง |
| B7 | เงินเบิกล่วงหน้าคนขับ (Cash Advance) + เคลียร์บิลค่าใช้จ่าย | NOSTRA, LogisticsX | เป็นงานประจำวันของบริษัทขนส่งไทย | กลาง |
| B8 | รถร่วมหรือคนขับดูใบจ่ายเงินและค่าเที่ยวของตัวเองในแอปหรือลิงก์ | NOSTRA, Rose Rocket | ลดสายโทรถาม | ต่ำ |
| B9 | **Document sequence ต่อ (tenant, ประเภทเอกสาร, สาขา, งวด)** + prefix ตั้งเองได้ | ตรงข้ามกับ LogisticsX, Rose Rocket (Invoice ID builder) | ห้ามข้ามเลข ใช้ row lock ตอน finalize เท่านั้น (draft ไม่ต้องใช้เลข) | กลาง |
| B10 | ออกเอกสาร/คำนวณแบบ async job (สถานะ PENDING/COMPLETED/ERROR + ลิงก์ PDF/Excel) และ Excel ค่าจ้างรถร่วม 3 sheet | Shipsy | | ต่ำ |

### 3.7 Integration (ERP adapter, KRS เป็นตัวแรก)

| # | สิ่งที่หยิบ | จากใคร | ปรับอย่างไร | ความยาก |
|---|---|---|---|---|
| I1 | **Port/adapter**: interface `upsertCustomer/Vendor/Invoice/Payment/Bill`, `void*`, `getAccounts/getItems` + factory + **Demo provider** | LogisticsX | `KrsAdapter` เป็นตัวแรก ส่วน `StandaloneProvider` = no-op ทำให้ standalone ใช้ได้ทันที | กลาง |
| I2 | **ตาราง ExternalMapping** `(tenantId, provider, entityType, localId, externalId, externalDocNo, externalVersion, lastSyncedHash, lastSyncedAt, status: synced\|failed\|retired, lastError)` | LogisticsX | ใช้ hash ตรวจว่า payload เปลี่ยนจริงก่อน push | ต่ำ |
| I3 | **กติกาเดียว: TMS เป็น system of record สำหรับเอกสารขนส่ง** แก้ใน TMS แล้ว regenerate ห้ามแก้หรือลบใน ERP; field บางกลุ่ม sync อัตโนมัติ ส่วนที่เหลือต้อง regenerate; แก้ได้จนกว่าจะรับชำระ | Alvys | **ต้องตกลงกับ KRS ว่าใครเป็นเจ้าของอะไร**: ลูกค้า/ผังบัญชี/VAT = KRS, งานขนส่ง/ใบวางบิล = TMS | กลาง |
| I4 | Sync master จาก ERP ลงมา (invoice item / VAT / ผังบัญชี) แทนการตั้งซ้ำ | Dashdoc ("Synchronize VAT rates and invoice item catalog"), Rose Rocket (Item Types Mapping) | หน้า mapping "ประเภทค่าใช้จ่ายใน TMS ↔ รหัสสินค้าหรือบริการใน KRS" ต้องครบก่อนจึง export ได้ | กลาง |
| I5 | **เลขเอกสารสองฝั่ง**: เก็บเลข TMS ในช่อง ref ฝั่ง ERP และเก็บเลข ERP กลับใน mapping; เลขใบแจ้งหนี้ของรถร่วมใส่ใน memo เพื่อกระทบยอด | Alvys | ตรงกับโจทย์ "จัดการเลขเอกสารสองฝั่ง" | ต่ำ |
| I6 | **Error queue** แยก "รอคิว" กับ "ล้มเหลว" + ปุ่ม Retry + คู่มือแยกตาม error code + กรณี "งวดบัญชีปิดแล้ว" ต้อง re-export | Alvys, Rose Rocket, LogisticsX | หน้า "สถานะเชื่อม KRS" ที่ลูกค้าดูเองได้ (Shipsy มี request log ให้ลูกค้าดู) ช่วยลด ticket | กลาง |
| I7 | `syncFromDate` กัน push ประวัติซ้ำกับที่บัญชีคีย์ไว้แล้ว + incremental batch + void เมื่อยกเลิก | LogisticsX | สำคัญมากตอน go-live กลางงวดบัญชี | ต่ำ |
| I8 | ดึงสถานะรับชำระกลับจาก ERP (polling หรือ change feed) แล้ว reconcile | Alvys, Rose Rocket | LogisticsX ยังไม่มี **ต้องทำตั้งแต่แรก** | กลาง |
| I9 | Routing ตามนิติบุคคล/สาขา (Invoice As / Tender As) | Alvys | 1 tenant มีหลายบริษัทในเครือ | กลาง |
| I10 | Inbound webhook: tenant อยู่ใน URL, ตรวจ signature ก่อน, ledger `(provider, eventKey)` unique | LogisticsX | | ต่ำ |
| I11 | Integration Marketplace ในระบบให้ลูกค้าเปิด connector เอง | Shipsy | เฟสหลัง เมื่อมี adapter มากกว่า 1 ตัว (Express, PEAK, SAP B1) | กลาง |

### 3.8 Reports

| # | สิ่งที่หยิบ | จากใคร | ปรับอย่างไร | ความยาก |
|---|---|---|---|---|
| R1 | กำไรต่อเที่ยว/ต่อลูกค้า/ต่อรถ (revenue − cost line − ค่าใช้จ่ายคนขับ) | Treasure, EyeFleet (Executive Summary), Rose Rocket (allocation) | ตัวเลข dashboard ต้องมาจาก ledger เดียวกับบิล (ดูข้อ 4) | กลาง |
| R2 | Dashboard บิล: draft / ค้างวางบิล / ครบกำหนด / รับชำระบางส่วน | LogisticsX | | ต่ำ |
| R3 | แยกรายงาน "ส่งให้ลูกค้า" (รายวัน) กับ "วิเคราะห์ภายใน" (รายเดือน) | Logis Boy | | ต่ำ |
| R4 | ตั้งเวลาส่งรายงานอัตโนมัติ (อีเมล/LINE) ให้บัญชีและการเงิน | Cartrack | | ต่ำ |
| R5 | แผงกระทบยอดเงินสด/COD "เก็บได้/ต้องเก็บ" ต่อเที่ยว | Locus | | ต่ำ |

### 3.9 UI/UX: "ทางการแต่สวย" (OPINION จาก screenshot)

- **ต้นแบบหลักคือ Alvys** (`assets/alvys-1.png`, `assets/alvys-2.png`)
  - พื้นขาวหรือเทาอ่อน ใช้ accent สีเดียว (น้ำเงิน)
  - ตารางหนาแน่นแต่มีช่องไฟ
  - filter ต่อคอลัมน์ และแผงเลือกคอลัมน์ด้านขวา
  - คีย์ลัด ⌘K
- **องค์ประกอบที่ใช้ซ้ำในเกือบทุกตัว**
  - tab สถานะพร้อมตัวนับ เช่น `ทั้งหมด 66 | รอวางแผน 15 | ระหว่างขนส่ง 10 …` (Locus, Shipsy)
  - status chip สี
  - route chip แบบ "A → B" (LogisticsX)
  - KPI card 3–4 ใบเหนือตาราง (LogisticsX)
- **Saved views + filter badges** (Dashdoc) ช่วยให้จอข้อมูลแน่นยังดูไม่รก
- **Timeline + แผนที่** สำหรับติดตามเที่ยว (Locus) และ **การ์ด stepper** สำหรับมุมมองลูกค้า (Turvo, `assets/turvo-1.png`)
- **หลีกเลี่ยง**
  - admin template รุ่นเก่าแบบ sidebar ดำ (Logis Boy, `assets/logisboy-1.png`)
  - ที่อยู่ยาวจนแถวสูงมาก (Shipsy) ควรตัดเป็น 1 บรรทัดแล้วแสดงเต็มใน tooltip
- **Empty state:** ไม่พบตัวอย่างที่บันทึกได้จาก research รอบนี้ ต้องดูจาก demo (ข้อ 5)

---

## 4. สิ่งที่ไม่ควรทำ (จากคำบ่นของลูกค้าและบทเรียนจากโค้ด)

| # | อย่าทำ | หลักฐาน | สิ่งที่ควรทำแทน |
|---|---|---|---|
| X1 | **ผูกลูกค้าด้วยสัญญายาวพร้อมค่าปรับ** | Cartrack: "ยกเลิกก็เสียค่าปรับตามสัญญา 3 ปี" ([Play](https://play.google.com/store/apps/details?id=com.cartrack.fleet&hl=th&gl=TH)); Track-POD: เพิ่มคนขับกลางสัญญาแล้วโดนเก็บเงินเต็มปี ([upper](https://www.upperinc.com/blog/track-pod-pricing.txt)) | รายเดือน ไม่มีสัญญาแบบ Alvys และคิดตามคันหรือคนขับที่ active จริงในเดือนแบบ Dashdoc/OptimoRoute |
| X2 | **ล็อกฟีเจอร์พื้นฐานไว้ที่ tier สูง / ขาย submodule แยกจนลูกค้ารู้สึกโดนบีบ** | Track-POD, Cargoson, Onfleet (custom reasons มีเฉพาะ Scale ขึ้นไป) | ePOD, reason codes และวางบิลต้องอยู่ใน tier แรก ส่วน add-on ควรเป็นของที่ "เพิ่มมูลค่า" จริง เช่น optimizer หรือ ERP adapter |
| X3 | **ตัวเลข dashboard ไม่ตรงกับบิล** | Alvys: "dashboard numbers didn't match customer revenue" ([capterra](https://capterra.com/p/249961/Alvys-TMS/reviews/)) | รายงานทุกตัวคำนวณจาก invoice/settlement line เดียวกัน ไม่คำนวณแยกจาก order |
| X4 | **ให้ฝ่ายบัญชีคีย์ซ้ำ** | Rose Rocket: ต้องคีย์ซ้ำเพื่อสร้าง invoice ที่คล้ายกัน ([softwareadvice](https://www.softwareadvice.com/scm/rose-rocket-profile/)) | duplicate invoice/order, template บิลรายเดือน และดึงจาก DO อัตโนมัติ |
| X5 | **Config ซับซ้อนจนต้องให้ทีม vendor ตั้งให้** | Locus: "hard to teach to the transporter admin" ([capterra uk](https://www.capterra.co.uk/reviews/176446/locus-dispatcher)); Shipsy: config บางตัวต้องให้ POC ตั้ง | ค่าเริ่มต้นที่ใช้ได้ทันทีสำหรับบริษัทขนส่งไทย + setup checklist และทุก setting ต้องตั้งเองได้จาก UI |
| X6 | **ปรับให้เข้ากับ workflow ไม่ได้ / learning curve ชัน** | Turvo ([selecthub](https://www.selecthub.com/tms-software/turvo-vs-carrier-logistics/)); OptimoRoute: "too rigid for real-world logistics" | workflow step ต่อประเภทงานที่ config ได้ (NOSTRA) แต่จำกัดขอบเขต ไม่ทำเป็น workflow engine เต็มรูป |
| X7 | **ไม่มี log ให้ลูกค้าดูเองเมื่อ integration พัง** | Locus: ไม่มี debug log ([softwareadvice](https://www.softwareadvice.com/crm/locus-profile/reviews/)), "Integration had few hiccups" | หน้า "สถานะเชื่อม KRS" + error queue + retry (I6) |
| X8 | **แอปคนขับกินแบต / GPS ค้าง** | Locus (กินแบต), Cartrack ("gps ติดรถค้างบ่อย") | ส่ง location แบบ adaptive (ถี่ขึ้นเมื่อใกล้จุด) และใช้ background mode ที่ OS อนุญาต |
| X9 | **แอปคนขับคะแนนต่ำ** | NOSTRA ePOD 3.36/5, Monitoring 2.85/5 (iOS) แต่ดึงข้อความรีวิวไม่ได้ | ทำ usability test กับคนขับจริง: ปุ่มใหญ่ ภาษาไทยล้วน ขั้นตอนน้อย |
| X10 | **ไม่รองรับภาษาไทย** | Shipsy: Capterra ระบุภาษา EN/AR/HI ([capterra.in](https://www.capterra.in/reviews/164099/shipsy)) | ไทยเป็นภาษาหลัก ทั้ง PDF ใบวางบิล/ใบกำกับ ฟอนต์ไทย และปี พ.ศ. |
| X11 | **เปิด 2 ทางจ่ายรถร่วมพร้อมกันจนจ่ายซ้ำ** | Alvys เตือนเองใน docs ([QBD](https://docs.alvys.com/help/integrations/how-to-export-and-modify-transactions-in-quickbooks-desktop)) | ให้มีเส้นทางเดียวไปสู่ AP ของ ERP และเก็บ unique `(tripCostLineId)` ใน settlement |
| X12 | **โครงสร้างข้อมูลจาก LogisticsX ที่ไม่เหมาะกับไทย** | ดูหน้า LogisticsX | ไม่ใช้ DB-per-tenant, ไม่ใช้เลข identity เดียวทุกเอกสาร, ไม่ผูก 1 invoice : 1 load, ไม่เก็บรถร่วมเป็น Employee, ไม่หาคนขับจาก `truck.mainDriver`, ไม่ทำ driver API ที่ไม่มี idempotency, ไม่ทำ sync ทางเดียวที่ไม่ reconcile กลับ |
| X13 | **ทำ build แยกต่อลูกค้า** | Logis Boy มีแอปแยกชื่อลูกค้าบน Play (TMS THAIKK ฯลฯ) ซึ่งเป็น OPINION ว่าเป็น single-tenant/custom | multi-tenant ตัวเดียว ปรับแต่งด้วย config และ branding |
| X14 | **Support ช้า / ไม่ทันกำหนดที่รับปาก** | Turvo, Shipsy (G2), Cartrack ("ไม่มีทีมซัพพอร์ต 24/7") | in-app chat, help center ภาษาไทยแบบ step-by-step (เลียนแบบ docs.alvys.com) |

---

## 5. คำถามที่ยังตอบไม่ได้และต้องลอง demo เอง

**ลองได้ทันที (มี trial/demo เปิด):** Alvys (trial 14 วัน), Logis Boy (1 เดือน), Treasure TMS (15 วัน), OptimoRoute (30 วัน), Track-POD (free trial), LogisticsX (https://tms.logisticsx.app และ customer portal ใช้ test credentials ใน repo)

**ต้องนัด demo:** Dashdoc, Rose Rocket, NOSTRA, Shipsy, Locus

### ระบบไทย (สำคัญที่สุด เพราะไม่มี docs สาธารณะ)
1. **Logis Boy / Treasure / NOSTRA**
   - หน้าวางบิลจริงหน้าตาเป็นอย่างไร
   - รวมหลาย DO ได้ไหม และแยกใบวางบิล/ใบกำกับ/ใบเสร็จอย่างไร
   - ออก 50 ทวิ ให้รถร่วมได้ไหม
2. "Delivery Slip control" ของ Logis Boy และ flag กันวางบิลซ้ำของ Treasure ทำงานอย่างไรบนหน้าจอ
3. ทั้ง 3 ตัวเชื่อมโปรแกรมบัญชีไทยตัวไหนได้จริง (Express / FlowAccount / PEAK / SAP B1)
   - เป็นการ export ไฟล์หรือ API
   - ถ้าแก้ย้อนหลังแล้วทำอย่างไร
4. รถร่วมรับงานผ่านอะไร (แอป / LINE / โทร) และยืนยันทะเบียนรถอย่างไร
5. Offline ของ NOSTRA ePOD และ Hublink
   - ทำอะไรได้บ้างตอนไม่มีสัญญาณ
   - ถ้า sync ชนกันทำอย่างไร
6. reason code ของงานค้างหรือส่งไม่สำเร็จมีให้ตั้งไหม และค่าเริ่มต้นมีอะไร
7. ระดับที่ลูกค้าจัดการ user / role / สาขาได้เอง
8. ราคาจริงคิดต่อคันหรือต่อ user
9. Logis Boy เป็น single-tenant ต่อลูกค้าจริงหรือไม่ (OPINION ข้อ X13)

### ต่างประเทศ
10. **Alvys:** ลองสร้าง load → Release → invoice → แก้ rate หลัง sync เพื่อดู UX ของ "regenerate" และ error queue จริง
11. **Dashdoc**
    - ใช้ planning board ที่มีรถบริษัทกับรถร่วมรวมในจอเดียว
    - flow purchase invoice: จับคู่ยอดและจัดการส่วนต่างอย่างไร (ไม่มีใน docs)
    - การ map เลขเอกสารกับ Pennylane/Sage
    - e-CMR + OTP ทำงานตอน offline ได้หรือไม่
12. **Rose Rocket**
    - แก้ invoice หลัง sync QBO แล้วเกิดอะไร
    - ตัวเลือกของ "Invoice Num used"
    - flow ที่รถร่วมเซ็นใบสั่งงานใน Partner Portal
13. **Shipsy:** ลองใช้ Vendor Portal และ allocation cascade (P1→P2) ในมุมของรถร่วม
14. **Locus:** การ map เลขเอกสารกับ SAP และการ replay callback
15. **Turvo:** แทบทุกอย่างระดับ flow เพราะ help center ปิด (ความสำคัญต่ำ)

### UX
16. Empty state, onboarding ครั้งแรก และหน้า settings ของแต่ละตัว ไม่มีข้อมูลเลยในรอบนี้
17. จับ screenshot ระบบจริงด้วย REA เมื่อ REA ใช้ได้แล้ว
    - restart MCP client → `rea doctor` → เปิด Chrome พร้อม remote debugging
    - เป้าหมาย: planning board ของ Alvys/Dashdoc, หน้าวางบิลของระบบไทย และ driver app

### คำถามฝั่งเราเอง (ต้องคุยกับ KRS)
18. KRS รับเอกสารแบบไหน (ใบแจ้งหนี้ / ใบกำกับ / AP voucher) และมี API ไหม หรือต้อง import ไฟล์
19. ใครเป็นเจ้าของเลขเอกสาร: TMS ออกเลขแล้ว KRS ใช้ตาม หรือ KRS ออกเลขแล้วส่งกลับ
20. งวดบัญชีปิดใน KRS แล้ว TMS ควรบล็อกการแก้หรือออกใบลดหนี้อัตโนมัติ
