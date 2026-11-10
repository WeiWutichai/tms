# One Platform: สมัครเอง, จัดการผู้ใช้ และแพ็กเกจ

> วันที่ทำ research: 3 พ.ย. 2569
> โจทย์: ทำ TMS เป็น "one platform" (อ้างอิงแนวทาง Shipsy) ที่ลูกค้าสมัครใช้งานเองได้ ทีมเราจัดการลูกค้าและผู้ใช้ได้ทั้งหมด ฝั่งกลาง (platform admin) กำหนดแพ็กเกจได้ และลูกค้าดูแพ็กเกจที่ตัวเองสมัครได้
> ข้อจำกัด: **REA MCP เปิดไม่ขึ้น** (error "REA could not start" แม้มี CDP endpoint ให้แล้ว) ข้อมูลรอบนี้จึงมาจาก Chrome (อ่านหน้าเว็บและฟอร์มสมัครจริงโดยไม่กดส่ง) และโค้ด LogisticsX ที่ clone ไว้
> สัญลักษณ์: **FACT** = มีแหล่งอ้างอิง, **OPINION** = ความเห็นของผู้ทำ research

---

## 1. ข้อค้นพบ (FACT)

### Shipsy: ความหมายของ "one platform" ในแบบของเขา
- **FACT:** ข้อความหลักของหน้า TMS คือ "One TMS from planning to settlement" รวม planning, execution, tracking และ settlement ไว้ในระบบเดียว ([shipsy TMS](https://www.shipsy.ai/transportation-management-system))
- **FACT:** แยกขายเป็นโมดูลภายใต้แพลตฟอร์มเดียวกัน ได้แก่ Transportation Management, Warehouse Management, Route Optimization, Last/First/Mid Mile, Multi-Carrier, Freight Procurement, Shipment/Live Tracking, Geocoding และชั้น AI (AgentFleet / AgentFlow) (เมนู Solutions บนหน้าเดียวกัน)
- **FACT:** หน้า Platform ระบุแนวคิดของระบบไว้ 3 ข้อ ([platform](https://www.shipsy.ai/platform)):
  - "Configuration, Not Code": business rules, workflow และ UI ปรับด้วยการตั้งค่า ไม่ต้องเขียนโค้ดเพิ่ม
  - มี integration สำเร็จรูป 240+ ตัว และ REST API + webhooks
  - multi-region และ uptime SLA 99.9%
- **FACT:** **ไม่มีการสมัครใช้งานเอง** ทุกปุ่มพาไปที่ "Talk to Shipsy" (`/request-a-demo`) และราคาเป็นแบบ custom ([llms.txt](https://shipsy.ai/llms.txt))
- **FACT (KB):** ในระบบ ลูกค้าจัดการผู้ใช้เองได้ ([KB index](https://knowledge.shipsy.ai/)):
  - สร้าง employee type แล้วเลือก permission
  - ผูก role ให้พนักงาน
  - เปิด/ปิด hub และ rider
  - permission ระดับตารางใน BI
- **OPINION:** ส่วนที่หยิบจาก Shipsy ได้คือ "โครงโมดูล + configuration" ส่วนการสมัครเองและแพ็กเกจต้องดูจากตัวอื่น

### Alvys: แพ็กเกจและการสมัครเองที่ใกล้เคียงโจทย์ที่สุด ([pricing](https://alvys.com/pricing))
- **FACT แพ็กเกจ:** มี 3 ชุด ทุกชุดคิดราคาตามปริมาณ load ไม่คิดตามจำนวน user ไม่มีค่า setup ไม่มีสัญญา ยกเลิกได้ทุกเมื่อ และอัปเกรดได้โดยไม่มีค่าปรับ
  - **Foundations:** ทดลองใช้ฟรี 14 วัน
  - **Growth:** ติดต่อฝ่ายขาย
  - **Scale:** ติดต่อฝ่ายขาย
- **FACT ตารางเปรียบเทียบ:** แบ่งเป็นหมวด (Core operations / Driver app / Billing / Reporting / Maintenance / Integrations / EDI / Developer & API / System & account / Customer success) แต่ละเซลล์มี 3 แบบ คือ
  - ✓ (รวมในแพ็กเกจ)
  - "Add-on" หรือ "Add-on ($100/mo)" (ซื้อเพิ่ม)
  - ตัวเลขโควตา เช่น Subsidiaries 1 / 3 / Unlimited, Offices 1 / Unlimited, EDI partners 2 / 5
- **FACT การ onboarding และ support ต่างกันตามแพ็กเกจ:**
  - Onboarding: Self-serve / Virtual / Custom
  - Support: Self-serve / Chat & email / Chat, email & phone
- **FACT ฟอร์มสมัคร** ([register](https://app.alvys.com/register), เปิดดูอย่างเดียว ไม่ได้กดส่ง):
  - มี 3 ขั้น (เห็นจุดบอกขั้นด้านบน)
  - ขั้นแรกกรอก ชื่อ, นามสกุล, เบอร์โทร, อีเมลบริษัท, ประเภทเลขทะเบียน (MC/DOT) + เลข
  - มีส่วน "Compliance" ที่ "verify every MC to keep fraud out of the network" แล้วส่งรหัสยืนยันทาง SMS ไปที่เบอร์ซึ่งผูกกับเลขทะเบียน
  - ฝั่งขวาของฟอร์มแสดงตัวเลขผลลัพธ์ที่ลูกค้าได้ (social proof)

### OptimoRoute: การสมัครแบบสั้นที่สุด ([pricing](https://optimoroute.com/pricing/), [signup](https://my.optimoroute.com/signup))
- **FACT:** ฟอร์มสมัครมีแค่ 3 ช่อง คือ ชื่อบริษัท, อีเมล, รหัสผ่าน + ติ๊กยอมรับ Terms
- **FACT:** หัวฟอร์มเขียนว่า "Plan your first routes in just 7 minutes" และใต้ฟอร์มมี "How it works" 3 ขั้น: Add drivers → Import orders → See routes
- **FACT:** ทดลองใช้ 30 วันโดยไม่ต้องใช้บัตร คิดเงินต่อคนขับเฉพาะคนที่ active ในเดือนนั้น (ข้อมูลจาก research ครั้งก่อน)

### LogisticsX: โครงข้อมูล tenant / แพ็กเกจที่ทำงานได้จริง (โค้ด commit `c63226e`)
- **FACT Master DB:** ([domain-model.md](https://github.com/suxrobGM/logistics-app/blob/main/docs/architecture/domain-model.md), [Tenant.cs](https://github.com/suxrobGM/logistics-app/blob/main/src/Core/Logistics.Domain/Entities/Tenant.cs))
  - Master DB เก็บ `Tenant`, `Subscription` (1:1 กับ tenant), `SubscriptionPlan` (tier), `PlanFeature` (feature ที่แพ็กเกจนั้นได้), `TenantFeatureConfig` (admin เปิด/ปิดเพิ่มรายบริษัท)
  - `Tenant.IsSubscriptionRequired = false` ใช้กับ tenant ภายในหรือ demo
- **FACT SubscriptionStatus:** Active, Incomplete, IncompleteExpired, Trialing, PastDue, Cancelled, Unpaid ([SubscriptionStatus.cs](https://github.com/suxrobGM/logistics-app/blob/main/src/Core/Logistics.Domain.Primitives/Enums/Subscription/SubscriptionStatus.cs))
- **FACT การบังคับใช้สถานะ:** ([multi-tenancy.md](https://github.com/suxrobGM/logistics-app/blob/main/docs/architecture/multi-tenancy.md))
  - ทุก request ตรวจว่าสถานะเป็น Active หรือ Trialing
  - endpoint `/payments/methods` และ `/subscriptions` ได้รับยกเว้น เพื่อให้ลูกค้าที่หมดอายุยังเข้าไปจ่ายเงินได้
- **FACT ทดลองใช้:** subscription แรกทดลองใช้ 30 วันโดยไม่ใช้บัตร คิดราคาแบบ ค่าฐาน + ต่อคันรถ ผ่าน Stripe ([CreateSubscriptionHandler](https://github.com/suxrobGM/logistics-app/tree/main/src/Core/Logistics.Application/Modules/IdentityAccess/Subscriptions/Commands/CreateSubscription), [pricing-launch-polish.md](https://github.com/suxrobGM/logistics-app/blob/main/docs/roadmap/pricing-launch-polish.md))
- **FACT Admin portal** มีเมนู Tenants (สร้าง/แก้, presets, ดู users และแพ็กเกจ), Plans (จัดการแพ็กเกจ + ดู subscription ที่ใช้อยู่), Users & admins ข้ามทุกบริษัท, Feature flags รายบริษัท, impersonate พร้อม audit log ([features.md](https://github.com/suxrobGM/logistics-app/blob/main/docs/features.md))
- **FACT ฝั่งลูกค้า** มี invitations, roles, setup checklist (profile → รถคันแรก → ทีม → ลูกค้าแรก → load แรก → payouts → ELD) และ "solo mode" preset
- **FACT การสมัคร:** ในโค้ดเจอ `CreateTenant` (admin เป็นผู้สร้าง) และ `DemoRequests` แต่**ไม่พบ command ให้สมัครเองแบบสาธารณะ**
- **FACT ปัญหาที่เขาบันทึกไว้เอง:** ราคาอยู่ 3 ที่ (seeder, `pricing.ts` ของเว็บ, Stripe Prices) แก้ด้วยมือแยกกันและ "still drift" ([pricing-launch-polish.md](https://github.com/suxrobGM/logistics-app/blob/main/docs/roadmap/pricing-launch-polish.md))

### เพิ่มจาก research ก่อนหน้า
- **Dashdoc:** คิดต่อ active driver และคิดเพิ่ม 20% ถ้าเกินโควตา custom role มีเฉพาะแผน Expert มีหลายนิติบุคคลในบัญชีเดียว
- **Onfleet:** คิดตามจำนวน task ไม่จำกัด user ระยะเก็บข้อมูลต่างกันตามแผน และ offline เป็น setting ที่ admin เปิดเอง
- **Cartrack:** มีคำบ่นเรื่องสัญญา 3 ปีและค่าปรับยกเลิก ซึ่งเป็นสิ่งที่**ไม่ควรทำ**

---

## 2. แบบที่แนะนำสำหรับเรา (OPINION)

### 2.1 ระบบแบ่งเป็น 3 ส่วน
| ส่วน | ใครใช้ | หน้าที่ |
|---|---|---|
| **หน้าเว็บสาธารณะ** (ราคา + สมัคร) | คนทั่วไป | ตารางแพ็กเกจ (ดึงจาก DB), สมัคร, ยืนยันตัวตน |
| **แอปลูกค้า** (TMS ที่ออกแบบอยู่) | บริษัทขนส่ง | ใช้งาน + หน้า "แพ็กเกจและการเรียกเก็บเงิน" + จัดการผู้ใช้ในบริษัท |
| **Platform Console** | ทีมเรา (super admin, sales, support, บัญชี) | จัดการลูกค้าทุกราย, แพ็กเกจ, add-on, การชำระเงิน, อนุมัติการสมัคร, impersonate |

### 2.2 แพ็กเกจ = โมดูล + โควตา + add-on (แนวคิดจาก Shipsy + Alvys)
- **โมดูล** (เปิด/ปิดได้):
  - งานขนส่ง (SO/DO/วางแผน) เป็นแกนหลักที่ทุกแพ็กเกจได้
  - ติดตามรถ, จ่ายงานรถร่วม, วางบิลและรับชำระ, Settlement รถร่วม
  - Driver app (offline)
  - รายงาน
  - Connector บัญชี/ERP (Express / PEAK / FlowAccount / KRS / SAP B1 / API)
  - Customer portal
- **โควตา (limit):** รถ active ต่อเดือน, ผู้ใช้ (หรือไม่จำกัดแบบ Alvys), นิติบุคคล/สาขา, connector, พื้นที่เก็บรูป POD, ระยะเก็บข้อมูล
- **Add-on:** connector ERP เพิ่ม, SMS/LINE แจ้งเตือนเกินโควตา, รถเกินโควตา (คิดต่อคัน), onboarding แบบมีคนช่วย
- **หน่วยคิดเงิน:** ต่อ "รถ active ในเดือน" (คล้าย Dashdoc/OptimoRoute) ซึ่งตรงกับกลุ่ม 10–200 คัน และนับรถร่วมที่วิ่งจริงด้วย
- **ตัวอย่างแพ็กเกจ** (ตัวเลขเป็นตัวอย่าง ยังไม่ได้ทำ pricing research ไทย):
  | | เริ่มต้น | มาตรฐาน | องค์กร |
  |---|---|---|---|
  | รถ active | ≤ 20 | ≤ 80 | ไม่จำกัด / ตกลง |
  | โมดูล | งานขนส่ง, DO/POD, วางบิล, driver app | + รถร่วม, Settlement, ติดตามรถ, รายงาน | + customer portal, หลายนิติบุคคล, API |
  | Connector บัญชี | export ไฟล์ | 1 ตัว | ไม่จำกัด |
  | Support | self-serve | แชต/อีเมล | ผู้ดูแลเฉพาะ |
  | ทดลองใช้ | 30 วัน ไม่ใช้บัตร | 30 วัน | demo |

### 2.3 Data model (Prisma, shared schema)
- `Plan` (code, ชื่อ, คำอธิบาย, สถานะ draft/active/archived, แสดงบนเว็บไหม)
- `PlanVersion` (ราคาต่อเดือน/ปี, หน่วยคิดเงิน, วันมีผล) **กันไม่ให้การเปลี่ยนราคากระทบลูกค้าเดิม**
- `Feature` (key เช่น `subcontract.dispatch`, หมวด, ชื่อไทย) → `PlanEntitlement` (planVersionId, featureKey, enabled, limit)
- `AddOn` + `SubscriptionAddOn`
- `Tenant` (ชื่อ, เลขผู้เสียภาษี 13 หลัก, สาขา, สถานะ: pending_verification / trialing / active / past_due / read_only / suspended / cancelled)
- `Subscription` (tenantId, planVersionId, รอบบิล, trialEndsAt, currentPeriodEnd, cancelAtPeriodEnd)
- `TenantEntitlementOverride` (เปิด/ปิด/เพิ่ม limit รายลูกค้า + เหตุผล + ผู้อนุมัติ) ตามแบบ LogisticsX `TenantFeatureConfig`
- `UsageRecord` (tenantId, metric = active_vehicles / pod_storage_gb / sms, period, value) นับจากเที่ยวที่วิ่งจริง
- `PlatformInvoice` + `PlatformPayment` เป็น**ใบกำกับภาษีที่เราออกให้ลูกค้า** (VAT 7% สำหรับค่าบริการซอฟต์แวร์) แยกจากเอกสารในระบบของลูกค้า
- `PlatformUser` (ทีมเรา, role: owner/sales/support/finance) แยกจาก `User` ของลูกค้า ผูกกับ tenant ด้วย `Membership` (user คนเดียวอยู่ได้หลายบริษัท ตามแบบ LogisticsX `UserTenantAccess`)
- `ImpersonationLog`, `AuditLog`
- **กติกาหลัก:**
  - ตรวจสิทธิ์ใช้งานใน guard ตัวเดียว (`plan entitlement ∪ override − suspended`) และต้องตรวจซ้ำใน cron job
  - หน้าเว็บราคา**ต้องดึงจาก `Plan/PlanVersion` ใน DB** (ป้องกันราคา 3 ที่ไม่ตรงกันแบบ LogisticsX)

### 2.4 Flow การสมัคร
- **ขั้น 1:** ชื่อ, อีเมลบริษัท, เบอร์มือถือ, รหัสผ่าน (หรือ Google) แล้ว OTP มือถือ
  - สั้นแบบ OptimoRoute และยืนยันตัวตนแบบ Alvys
- **ขั้น 2:** ข้อมูลบริษัท
  - ชื่อนิติบุคคล, เลขผู้เสียภาษี 13 หลัก, รหัสสาขา, จำนวนรถบริษัท/รถร่วมโดยประมาณ, ใช้โปรแกรมบัญชีอะไร (ไม่มี / Express / PEAK / FlowAccount / KRS / อื่น)
  - **ตรวจเลขนิติบุคคลกับข้อมูลเปิดของกรมพัฒนาธุรกิจการค้า (DBD) แล้วเติมชื่อและที่อยู่ให้อัตโนมัติ** (OPINION: ต้องเช็ก API/เงื่อนไขของ DBD ก่อน)
- **ขั้น 3:** เลือกแพ็กเกจ (ค่าเริ่มต้นคือทดลองใช้ 30 วัน ไม่ต้องใส่บัตร) → เข้าแอป → setup checklist
  - checklist: ตั้งค่าบริษัท → เพิ่มรถ (import Excel) → เพิ่มคนขับ → เชิญทีม → สร้าง SO แรก → (ถ้ามี) เชื่อมระบบบัญชี
- **กลไกกันสแปม/ทุจริต:**
  - เลขผู้เสียภาษีซ้ำต้องเข้าคิว "รออนุมัติ" ใน Platform Console
  - เปิดเป็นนโยบายได้ว่าจะ "อนุมัติอัตโนมัติ" หรือ "ต้องให้ทีมตรวจ"

### 2.5 วงจรสถานะของลูกค้า (ห้ามลบข้อมูลลูกค้าเอง)
`ทดลองใช้` → (จ่ายเงิน) `ใช้งาน` → (ค้างจ่าย) `ค้างชำระ` (มี grace period 7–14 วัน แสดง banner) → `อ่านอย่างเดียว` (ดู/export ได้ สร้างงานใหม่ไม่ได้ หน้าชำระเงินยังเข้าได้) → `ระงับ` → `ยกเลิก` (เก็บข้อมูลตามนโยบาย และให้ export ได้)

### 2.6 หน้า "แพ็กเกจของฉัน" ฝั่งลูกค้า
- การ์ดแพ็กเกจปัจจุบัน: ชื่อ, ราคา, รอบบิล, วันต่ออายุ, ทดลองใช้เหลือ X วัน
- แถบโควตา: รถ active 12/20, ผู้ใช้, พื้นที่ POD, connector
- ตารางโมดูล: ✓ มี / 🔒 อยู่ในแพ็กเกจสูงกว่า (ปุ่มดูรายละเอียด) / add-on ที่ซื้อแล้ว
- ปุ่ม เปลี่ยนแพ็กเกจ (แสดงยอดเปรียบเทียบและคิดตามสัดส่วน), ซื้อ add-on, ยกเลิกเมื่อครบรอบ
- ประวัติใบกำกับภาษีและใบเสร็จ (ดาวน์โหลด PDF), วิธีชำระ (บัตร / PromptPay QR / โอน + แนบสลิป)
- **ข้อควรระวังจาก X1–X2 ของ research หลัก:** ไม่ผูกสัญญายาว และไม่ล็อกฟีเจอร์พื้นฐาน (POD, วางบิล) ไว้ที่แพ็กเกจสูง

### 2.7 Platform Console (ทีมเรา)
- **ภาพรวม:**
  - ลูกค้าตามสถานะ (ทดลอง / ใช้งาน / ค้างชำระ / ระงับ)
  - MRR, ทดลองใช้ที่ใกล้หมดใน 7 วัน, อัตราเปลี่ยนจากทดลองเป็นจ่ายจริง, รถ active รวม
- **ลูกค้า (tenants):** ตารางแสดง บริษัท, เลขผู้เสียภาษี, แพ็กเกจ, สถานะ, รถ active/โควตา, วันต่ออายุ, ยอดค้าง, ผู้ดูแล (sales)
  - หน้ารายละเอียดมี tab: ภาพรวม · Subscription · การใช้งาน · ผู้ใช้ · สิทธิ์พิเศษ (override) · ใบแจ้งหนี้ · log
  - การกระทำ: เปลี่ยนแพ็กเกจ, ขยายทดลองใช้, ให้ส่วนลด, ระงับ/ปลดระงับ, **เข้าใช้งานแทน (impersonate) ต้องกรอกเหตุผลและเก็บ log**
- **คิวอนุมัติการสมัคร:** ข้อมูล DBD เทียบกับที่กรอก, เลขซ้ำ, อนุมัติ/ปฏิเสธพร้อมเหตุผล
- **แพ็กเกจ:**
  - รายการแพ็กเกจและเวอร์ชัน
  - **ตัวแก้ feature matrix** (แถว = feature แบ่งหมวด, คอลัมน์ = แพ็กเกจ, เซลล์ = ✓ / add-on / ตัวเลข limit ตามแบบตารางของ Alvys)
  - ราคา, ตั้งค่าแสดงบนเว็บ, preview หน้าราคา
  - การเปลี่ยนราคาสร้างเวอร์ชันใหม่ ลูกค้าเดิมคงราคาเดิม (มีปุ่ม "ย้ายลูกค้าเดิม" พร้อมแจ้งล่วงหน้า)
- **Add-on, คูปอง/ส่วนลด**
- **การเงินของแพลตฟอร์ม:** ใบกำกับภาษีที่ออกให้ลูกค้า, การชำระ, ตรวจสลิปโอน, ค้างชำระ
- **ผู้ใช้ทีมเรา + สิทธิ์:** owner / sales / support / finance (support impersonate ได้ แต่แก้แพ็กเกจไม่ได้)
- **Audit log** ทุกการกระทำของทีมเรา

### 2.8 ความยาก
| งาน | ความยาก |
|---|---|
| Plan / PlanVersion / Entitlement + guard | กลาง |
| สมัคร + OTP + checklist | กลาง |
| ตรวจเลขนิติบุคคลกับ DBD | กลาง (ขึ้นกับ API ที่มีให้) |
| นับรถ active ต่อเดือน + คิดเงินตามการใช้ | กลาง |
| ออกใบกำกับภาษีของแพลตฟอร์ม + PromptPay/บัตร (Omise / 2C2P / GB Prime Pay) | สูง |
| Platform Console | กลาง |
| Impersonation + audit | ต่ำ |

---

## 3. คำถามที่ต้องตัดสินใจ
1. หน่วยคิดเงิน: ต่อรถ active (แนะนำ) หรือต่อเที่ยว หรือต่อ user
2. สมัครแล้วใช้ได้ทันที หรือต้องรอทีมอนุมัติก่อน
3. Payment gateway ไทยตัวไหน และจะรับโอน + แนบสลิปด้วยหรือไม่
4. ราคาและโควตาจริงของแต่ละแพ็กเกจ (ต้องทำ pricing research ตลาดไทยเพิ่ม เพราะเจ้าไทยไม่มีใครเปิดราคา)
5. ระยะ grace period และระยะเก็บข้อมูลหลังยกเลิก
