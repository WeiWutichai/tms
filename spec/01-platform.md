# 01 — Platform: Tenant, สมัคร, แพ็กเกจ, การเรียกเก็บเงิน, Platform Console, ผู้ใช้และสิทธิ์, ตั้งค่าองค์กร

> ⚠️ **ลำดับความสำคัญ (10 พ.ย. 2569):** ไฟล์นี้เขียนโดยไม่ได้อ่าน `docs/` (v2) เมื่อเนื้อหาขัดกับ `docs/` ให้ยึด `docs/` — ดู `plan/00-source-of-truth.md` และรายการจุดที่ขัดกันใน `plan/00a-reconcile-architecture.md`, `plan/00b-reconcile-requirements.md` · ป้าย P0/P1/P2 ในไฟล์นี้เป็นมาตราส่วนของ spec ไม่ใช่ "เฟส 0" ของแผนพัฒนา

> รหัสข้อกำหนด: `PLT-nnn` · สถานะ: ร่าง v0.1 (9 พ.ย. 2569)
> แหล่งที่มา: `research/design-briefs.md` รอบ 4, 13, 14, 15B, 16 (รอบหลังทับรอบก่อน) · `research/one-platform.md` §2 · `research/decisions.md` ข้อ 1–5 และ 6–13 · `research/company-verification-th.md` §6–7 · `research/payment-gateway-th.md` §6
> ป้าย: [FACT] [DECISION] [PROPOSED] [OPEN] ตาม 00-overview · ตัวเลขราคา/โควตา/จำนวนวันทุกตัวในไฟล์นี้เป็น **ข้อมูล config** (Plan/PlanVersion/PlatformSetting) ไม่ใช่ค่าคงที่ในโค้ด (D8)

## 0. ภาพรวมโมดูล

| ส่วน | ผู้ใช้ | หัวข้อในไฟล์นี้ |
|---|---|---|
| หน้าเว็บสาธารณะ (ราคา, สมัคร, เข้าสู่ระบบ) | คนทั่วไป, ผู้ใช้ลูกค้า | §2, §3 |
| แอปลูกค้า (TMS) — ส่วน platform | ผู้ดูแลระบบของลูกค้า, ผู้ใช้ทุกคน (banner) | §4, §5, §6–§9, §12, §13 |
| Platform Console (แอปแยกของทีมเรา) | owner / sales / support / finance | §10, §11 |

Entity หลักของโมดูล (รายละเอียดเต็มใน 10-data-model): `Tenant`, `TenantVerification`, `CompanyLookup`, `User`, `Membership`, `Invitation`, `Role`, `RolePermission`, `Plan`, `PlanVersion`, `Feature`, `PlanEntitlement`, `AddOn`, `Subscription`, `SubscriptionAddOn`, `TenantEntitlementOverride`, `Coupon`, `UsageRecord`, `UsageDaily`, `PlatformInvoice`, `PlatformPayment`, `PaymentMethod`, `SlipVerification`, `PlatformUser`, `ImpersonationSession`, `AuditLog`, `PlatformSetting`, `SetupChecklistState`

กติกาข้ามทุกหัวข้อ:
- **PLT-001** [DECISION] ทุก request ฝั่งลูกค้าผ่าน guard เดียว `AccessGuard` ที่ตรวจ 3 อย่างตามลำดับ: (1) สถานะ tenant (§1 ตาราง 1.6) (2) entitlement = `PlanEntitlement(planVersion) ∪ SubscriptionAddOn ∪ TenantEntitlementOverride` (3) สิทธิ์ role ของผู้ใช้ (§12) — ห้ามตรวจกระจายในแต่ละ controller
- **PLT-002** [DECISION] ราคา โควตา และรายการฟีเจอร์ในทุกหน้า (หน้าราคาสาธารณะ, หน้าแพ็กเกจลูกค้า, Console, landing) อ่านจาก `Plan/PlanVersion/PlanEntitlement` ผ่าน API เดียว `GET /public/plans` — ห้ามพิมพ์ตัวเลขในโค้ดหน้าใด (D8)
- **PLT-003** [DECISION] ห้ามลบข้อมูลลูกค้าด้วยมือ (D7) — การลบจริงทำโดย retention job เท่านั้น (§1 PLT-016)
- **PLT-004** การกระทำของทีมเราที่กระทบลูกค้า และการกระทำสำคัญของลูกค้า (เปลี่ยนแพ็กเกจ, ผู้ใช้, สิทธิ์, key) บันทึก `AuditLog` เสมอ; การกระทำที่ต้องใส่เหตุผล บังคับเหตุผล ≥ 10 ตัวอักษร (00-overview §6)

---

## 1. Tenant และวงจรสถานะ

1. **จุดประสงค์** — กำหนดสถานะของบริษัทลูกค้า 1 ราย สิ่งที่ทำได้ในแต่ละสถานะ และการเปลี่ยนสถานะอัตโนมัติ/ด้วยมือ
2. **ผู้ใช้/สิทธิ์** — ระบบ (cron รายวัน 00:30 เวลาไทย) เปลี่ยนสถานะตามเวลา; Console: owner/sales/support/finance ตามตาราง §11.4; ลูกค้า: ผู้ดูแลระบบ (ยกเลิก/ชำระเงิน)
3. **หน้าจอ** — ไม่มีหน้าเฉพาะ: แสดงผลผ่าน banner (§5), หน้าแพ็กเกจ (§8), Console ลูกค้า (§10.2)
4. **ฟิลด์ `Tenant`**

| ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|
| id | string `tnt_…` | ✓ | — | |
| legalNameTh / legalNameEn | string(200) | TH ✓ | — | prefill จาก RD/DBD แก้ได้ก่อนอนุมัติ |
| taxId | string(13) | ✓ | ตัวเลข 13 หลัก + checksum mod 11 (PLT-020) | |
| branchCode | string(5) | ✓ | `00000` = สำนักงานใหญ่ หรือ 5 หลัก | unique `(taxId, branchCode)` |
| entityType | enum `juristic` / `individual` | ✓ | หลักแรก `0` = juristic | |
| status | enum (ข้อ 6) | ✓ | | |
| verificationStatus | enum `unverified` `auto_vat` `pending_manual` `approved` `rejected` | ✓ | | แยกจาก status |
| statusChangedAt, statusReason | datetime, text | | | |
| trialEndsAt | datetime | | | |
| pastDueSince | date | | | วัน 0 ของ dunning |
| cancelRequestedAt, cancelEffectiveAt | datetime | | | ยกเลิกเมื่อครบรอบ |
| dataPurgeAt | datetime | | = cancelledAt + `retention.operationalDays` | |
| fleetSizeOwn / fleetSizeSubcon | int | | 0–5000 | จากขั้นสมัคร ใช้ใน Console/sales |
| accountingSoftware | enum `none` `express` `flowaccount` `krs` `peak` `sapb1` `other` | | | ข้อมูล lead เท่านั้น ไม่เปิด connector เอง (D2) |
| salesOwnerId | PlatformUser | | | |
| defaultLocale | `th` `en` `zh` | ✓ | | |
| isInternal | bool | | | tenant ทดสอบ/demo ไม่คิดเงิน ไม่นับ KPI |
| mode | `live` / `test` | ✓ | | sandbox tenant คู่กัน (07 §INT Open API) |

5. **กฎธุรกิจ**
- **PLT-010** [DECISION] สถานะมี 7 ค่า: `pending_verification` รอยืนยัน · `trialing` ทดลองใช้ · `active` ใช้งาน · `past_due` ค้างชำระ · `read_only` อ่านอย่างเดียว · `suspended` ระงับ · `cancelled` ยกเลิก — ป้ายไทยเดียวกันทุกแอป
- **PLT-011** [PROPOSED] ระยะเวลา dunning นับจากวันครบกำหนดชำระ = วัน 0: `past_due` วัน 0–7 → `read_only` วัน 8–21 → `suspended` วัน 22–60 → `cancelled` วัน 61 (config `dunning.pastDueDays=7`, `dunning.readOnlyUntilDay=21`, `dunning.suspendUntilDay=60`)
- **PLT-012** [PROPOSED] trial หมดโดยไม่มีวิธีชำระ/ไม่เลือกแพ็กเกจ → `read_only` ทันที 14 วัน → `suspended` ถึงวัน 60 นับจาก trialEndsAt → `cancelled` (ใช้ config ชุดเดียวกับ PLT-011 โดยวัน 0 = trialEndsAt และข้ามช่วง past_due)
- **PLT-013** ชำระสำเร็จในสถานะ `past_due` / `read_only` / `suspended` → `active` ทันที (ภายใน 1 นาทีหลังได้ webhook/อนุมัติสลิป) ไม่มีค่าปรับหรือค่าเปิดใหม่ (D4)
- **PLT-014** `pending_verification` ใช้งานแบบ trial จำกัด [PROPOSED]: รถ active ≤ 5, ออกใบกำกับภาษี/ใบเสร็จในระบบไม่ได้ (ร่างได้), เปิด Open API/MCP/connector ไม่ได้, นับวัน trial ตามปกติ
- **PLT-015** ยกเลิกโดยลูกค้า = `cancelAtPeriodEnd` ใช้งานได้ถึงสิ้นรอบที่จ่ายแล้ว แล้วเป็น `cancelled`; ทีมเรายกเลิกทันทีได้เฉพาะ owner พร้อมเหตุผล
- **PLT-016** [PROPOSED] หลัง `cancelled`: ระบบสร้างไฟล์ export อัตโนมัติ (เอกสารภาษี PDF + CSV ทุกโมดูล + รูป POD zip) ส่งลิงก์ให้ผู้ดูแลระบบทุกคน, เก็บข้อมูลปฏิบัติการ 90 วัน (`retention.operationalDays`) แล้ว purge; ก่อน purge 14 และ 3 วันส่งเตือน; purge job มี dry-run + log + หลักฐานว่าส่ง export แล้ว
- **PLT-017** [FACT] ใบกำกับภาษี/ใบเสร็จที่ **เราออกให้ลูกค้า** (`PlatformInvoice/Payment`) เก็บ ≥ 5 ปี (ประมวลรัษฎากร ม.87/3, ม.105 ทวิ) · [PROPOSED] เก็บ 7 ปี ใน storage แยกที่ purge job ไม่แตะ
- **PLT-018** reactivation: ลูกค้า `cancelled` ที่ยังไม่ถึง dataPurgeAt กลับมาชำระได้ → `active` ข้อมูลเดิมครบ; หลัง purge ต้องสมัครใหม่
- **PLT-019** การเปลี่ยนสถานะทุกครั้งบันทึก `TenantStatusHistory(from, to, reason, actorType: system|platform_user|tenant_user, actorId)`

6. **สถานะ — ตารางการเปลี่ยน**

| จาก → ไป | เงื่อนไข | ใครทำ | ผลข้างเคียง |
|---|---|---|---|
| (ใหม่) → `trialing` | สมัครครบ 3 ขั้น + ตรวจ `auto_vat` ผ่าน + ไม่ซ้ำ | ระบบ | trialEndsAt = +30 วัน [PROPOSED]; สร้าง sandbox tenant; อีเมลต้อนรับ |
| (ใหม่) → `pending_verification` | ตรวจไม่ผ่าน/ไม่พบ/RD ล่ม/ชื่อไม่ตรง/ขอเข้าร่วมบริษัทเดิม | ระบบ | เข้าคิวอนุมัติ (§10.3); trial จำกัด (PLT-014) |
| `pending_verification` → `trialing` | อนุมัติ | sales/support/owner | ปลด PLT-014; trialEndsAt คงเดิม (ขยายได้) |
| `pending_verification` → `cancelled` | ปฏิเสธ + เหตุผล | sales/support/owner | อีเมลแจ้งเหตุผล; retention ตาม PLT-016 |
| `trialing` → `active` | ชำระงวดแรกสำเร็จ / Console เปลี่ยนเป็นจ่ายแล้ว | ระบบ/finance | ออก PlatformInvoice |
| `trialing` → `read_only` | ถึง trialEndsAt ไม่มี subscription ที่ชำระ | ระบบ | banner แดง; อีเมล |
| `active` → `past_due` | ใบแจ้งหนี้ครบกำหนดยังไม่ชำระ / ตัดบัตรไม่ผ่านครบ retry | ระบบ | pastDueSince; อีเมล+LINE วัน 1, 3, 6 |
| `past_due` → `read_only` | ถึงวัน 8 | ระบบ | แจ้ง sales ใน Console; อีเมลวัน 8, 14, 20 |
| `read_only` → `suspended` | ถึงวัน 22 | ระบบ | ปิด API/MCP/webhook ขาออก; อีเมลวัน 22, 45, 55 |
| `suspended` → `cancelled` | ถึงวัน 61 | ระบบ | PLT-016 |
| `past_due`/`read_only`/`suspended` → `active` | ชำระครบ | ระบบ/finance | PLT-013; เปิด API/webhook คืน |
| ทุกสถานะ (ยกเว้น cancelled) → `suspended` | ละเมิดเงื่อนไข/ทุจริต + เหตุผล | owner/support (support ต้องให้ owner อนุมัติ) | เหมือนแถว read_only → suspended |
| `suspended` (ด้วยมือ) → สถานะก่อนหน้า | ปลดระงับ + เหตุผล | owner | |
| `active`/`trialing` → `cancelled` | ครบรอบหลังลูกค้ากดยกเลิก | ระบบ | PLT-016 |
| `cancelled` → `active` | PLT-018 | ระบบ/finance | |

**ตาราง 1.6 — ความสามารถตามสถานะ** (✓ ได้ · ✗ ไม่ได้ · L จำกัด)

| ความสามารถ | pending_verification | trialing | active | past_due | read_only | suspended | cancelled |
|---|---|---|---|---|---|---|---|
| login เข้าแอป | ✓ | ✓ | ✓ | ✓ | ✓ | L (เฉพาะหน้าแพ็กเกจ/ชำระเงิน/ขอ export) | L (ขอ export ถึง dataPurgeAt) |
| ดู/ค้นหา/พิมพ์/export ข้อมูลเดิม | ✓ | ✓ | ✓ | ✓ | ✓ | ขอ export ได้ | ขอ export ได้ |
| สร้าง/แก้ SO, DO, เที่ยว, เอกสาร | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| ออกใบกำกับภาษี/ใบเสร็จ | ✗ (ร่างได้) | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| แอปคนขับปิดงานที่จ่ายไปแล้ว + POD | ✓ | ✓ | ✓ | ✓ | ✓ (งานที่ออกวิ่งก่อนเปลี่ยนสถานะ) [PROPOSED] | ✗ | ✗ |
| Open API/MCP | ✗ | ตามแพ็กเกจ | ตามแพ็กเกจ | ตามแพ็กเกจ | อ่านอย่างเดียว | ✗ | ✗ |
| Webhook ขาออก / connector sync | ✗ | ✓ | ✓ | ✓ | ✗ (คิวพัก ส่งต่อเมื่อ active) | ✗ | ✗ |
| หน้าแพ็กเกจ/ชำระเงิน | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

API ที่ยกเว้นจาก guard สถานะเสมอ: `/auth/*`, `/billing/*`, `/payments/*`, `/exports/*` (อ่านอย่างเดียว), `/me`

7. **Event** — `tenant.created`, `tenant.status_changed {from,to,reason}`, `tenant.trial_ending {daysLeft: 7|3|1}`, `tenant.cancel_requested`, `tenant.data_export_ready`, `tenant.purge_scheduled`, `tenant.purged` (audit/internal เท่านั้น ไม่ส่งเป็น webhook ของลูกค้า)
8. **กรณีผิดปกติ** — cron ไม่รัน 1 วัน → รันย้อนตามวันจริง (idempotent ต่อ tenant/วัน); ชำระสำเร็จขณะ cron กำลังเปลี่ยนเป็น read_only → ใช้ row lock บน Tenant, การชำระชนะเสมอ; ผู้ใช้กำลังกรอกฟอร์มแล้วสถานะเปลี่ยนเป็น read_only → บันทึกไม่ได้ แสดง error `tenant_read_only` พร้อมปุ่มชำระเงิน และเก็บร่างในเครื่อง; คนขับอยู่ระหว่างเที่ยวตอน suspended → แอปแจ้ง "บริษัทถูกระงับ ติดต่อผู้จัดรถ" และเก็บ POD ไว้ในคิวออฟไลน์ไม่ทิ้ง
9. **เกณฑ์ตรวจรับ**
- Given tenant `active` ใบแจ้งหนี้ครบกำหนด 1 พ.ย. ไม่ชำระ When cron 9 พ.ย. Then สถานะ = `read_only` และ POST `/orders` ได้ 403 `tenant_read_only`
- Given tenant `suspended` When ชำระด้วย PromptPay สำเร็จ Then ภายใน 1 นาทีสถานะ = `active` และ webhook ที่พักไว้เริ่มส่ง
- Given tenant `cancelled` 1 ต.ค. When ถึง 30 ธ.ค. Then purge ข้อมูลปฏิบัติการ แต่ PlatformInvoice ยังดาวน์โหลดได้จาก Console
10. **เฟส** — P0 (ทั้งหมด) · export อัตโนมัติวันยกเลิก P1

---

## 2. สมัครใช้งานเอง (Self-signup)

1. **จุดประสงค์** — ให้บริษัทขนส่งสมัคร ทดลองใช้ได้ภายใน ~1 นาทีเมื่อตรวจผ่าน และกันสแปม/เลขซ้ำด้วยการตรวจเลขผู้เสียภาษี (Hybrid) [PROPOSED ตาม decisions ข้อ 2]
2. **ผู้ใช้/สิทธิ์** — คนทั่วไป (ไม่ login); ผู้สมัครกลายเป็น `owner` ของ tenant ใหม่
3. **หน้าจอ** (TMS Signup, ไม่มี sidebar, 3 ภาษา, responsive 390px)
   - หน้าราคา: toggle รายเดือน/รายปี, การ์ดแพ็กเกจจาก `GET /public/plans` (แพ็กเกจที่ `showOnWeb=true`), ป้าย "ทดลอง 30 วัน ไม่ต้องใช้บัตร", ตารางเปรียบเทียบแบ่งหมวด (เซลล์ ✓ / "ซื้อเพิ่ม" / ตัวเลขโควตา / —), ตัวคำนวณราคา (จำนวนรถ → ราคา/เดือน, บรรทัดรายปี, ระบุ "ราคายังไม่รวม VAT"), FAQ
   - สมัคร 3 ขั้น: stepper ด้านบน, แผงขวา "เริ่มใช้งานได้ใน 3 ขั้น"
   - หน้าผล: "เริ่มใช้งาน" (เข้าแอป) หรือ "เราได้รับข้อมูลแล้ว จะแจ้งภายใน 1 วันทำการ" (pending ที่ตั้งนโยบายให้รอ) หรือ "ส่งคำขอเข้าร่วมบริษัทแล้ว"
4. **ฟิลด์**

| ขั้น | ฟิลด์ | ชนิด | บังคับ | กฎตรวจ | หมายเหตุ |
|---|---|---|---|---|---|
| 1 | firstName, lastName | string(100) | ✓ | | |
| 1 | email | email | ✓ | รูปแบบ, ยังไม่มีในระบบ หรือถ้ามีให้ไป login | ส่งลิงก์ยืนยันอีเมลแบบไม่บล็อก |
| 1 | mobile | E.164 `+66…` | ✓ | เบอร์มือถือไทย 9 หลักหลัง +66 | |
| 1 | password | string | ✓ (ถ้าไม่ใช้ Google) | ≥ 10 ตัว, ไม่อยู่ในรายการรหัสที่รั่ว [PROPOSED] | |
| 1 | otp | 6 หลัก | ✓ | อายุ 5 นาที, ขอใหม่ได้หลัง 60 วิ, ผิด 5 ครั้งล็อก 15 นาที | ทาง SMS |
| 2 | taxId | 13 หลัก | ✓ | checksum (PLT-020) | ปุ่ม "ค้นหา" |
| 2 | branchType + branchCode | `hq` / `branch` + 5 หลัก | ✓ | hq ⇒ `00000` | |
| 2 | legalName, address (แยกฟิลด์: เลขที่ หมู่ ซอย ถนน แขวง/ตำบล เขต/อำเภอ จังหวัด รหัสไปรษณีย์) | | ✓ | | prefill + ป้ายแหล่งข้อมูลจริง ("ข้อมูลจากกรมสรรพากร" หรือ "ข้อมูลจากกรมพัฒนาธุรกิจการค้า") แก้ได้ |
| 2 | fleetSizeOwn, fleetSizeSubcon | int | ✓ | 0–5000 | |
| 2 | accountingSoftware | enum | ✓ | | ตัวเลือกเรียง "ไม่มี" ก่อน แล้วตามตัวอักษร |
| 2 | certificateFile | pdf/jpg/png ≤ 10 MB | เมื่อ pending_manual | | หนังสือรับรองบริษัท |
| 2 | acceptTerms, acceptPrivacy | bool | ✓ | | เก็บเวอร์ชันเอกสาร + เวลา + IP |
| 3 | planCode | enum | ✓ | ค่าเริ่มต้น = trial ของแพ็กเกจที่ตั้ง `trialPlan` | ปุ่ม "เริ่มใช้งาน" |

5. **กฎธุรกิจ**
- **PLT-020** [FACT] ตรวจ checksum 13 หลักฝั่ง client และ server: ผลรวม(หลัก i × (14−i)), i=1..12 → `(11 − sum mod 11) mod 10` = หลักที่ 13 (company-verification §6) — ไม่ผ่าน = ปฏิเสธที่ UI ไม่เรียก API
- **PLT-021** [PROPOSED] ลำดับการตรวจ: dedup `(taxId, branchCode)` → RD VAT Service (prefill, `auto_vat`) → ถ้าไม่พบแต่ RD TIN Service ยืนยันว่ามีเลข → กรอกเอง + อัปโหลดหนังสือรับรอง (`pending_manual`) → DBD เป็น enrichment แบบ async ไม่บล็อก (timeout 3 วิ)
- **PLT-022** [PROPOSED] นโยบายผลการตรวจ (ตั้งใน Console, ไม่ hardcode):

| เคส | ผล |
|---|---|
| checksum ไม่ผ่าน | ปฏิเสธที่ UI |
| VAT พบ + ชื่อที่กรอกตรง (normalize คำนำหน้า/ช่องว่าง) | `auto_vat` → `trialing` |
| VAT พบแต่ชื่อไม่ตรง / TIN มีแต่ไม่จด VAT / DBD สถานะไม่ใช่ "ยังดำเนินกิจการอยู่" | `pending_verification` |
| `(taxId, branchCode)` ซ้ำ tenant เดิม | ไม่สร้าง tenant ใหม่ → เสนอ "ส่งคำขอเข้าร่วมบริษัท" (ส่งถึงผู้ดูแลระบบของ tenant เดิม) หรือ "ติดต่อเรา" (เข้าคิวอนุมัติ) |
| taxId เดียวกัน branchCode ต่าง | สร้างได้ แต่ flag ให้ sales ดู (อาจเป็นสาขาของลูกค้าเดิม — แนะนำเพิ่มสาขาใน tenant เดิมแทน) |
| RD timeout/5xx ติดกัน 5 ครั้ง | circuit breaker 5 นาที → ทุกเคส `pending_verification` |
| หลักแรก ≠ 0 (บุคคลธรรมดา) | เส้นทางบุคคล + Privacy Notice เฉพาะ → `pending_verification` เสมอ [OPEN: ฐานกฎหมาย PDPA] |
| นโยบาย "ต้องให้ทีมตรวจทุกราย" เปิดอยู่ | ทุกเคส `pending_verification` |

- **PLT-023** cache ผลค้นหาใน `CompanyLookup` 24 ชม. (พบ) / 1 ชม. (ไม่พบ); เก็บ raw response 90 วัน; log ทุกครั้งว่าส่งเลขใดไปหน่วยงานใด (PDPA accountability); เรียก RD จาก server เท่านั้น concurrency ≤ 2
- **PLT-024** สมัครด้วย Google ยังต้องยืนยันเบอร์มือถือด้วย OTP
- **PLT-025** สร้างครบในธุรกรรมเดียว: `User` + `Tenant` + `Membership(role=owner)` + `Subscription(status=trialing)` + sandbox tenant + `SetupChecklistState`; ล้มเหลวกลางทาง = rollback ทั้งหมด
- **PLT-026** rate limit การสมัคร: ≤ 5 ครั้ง/IP/ชม., OTP ≤ 5 ครั้ง/เบอร์/วัน; มี bot protection (เช่น Turnstile) ที่ขั้น 1 [PROPOSED]
6. **สถานะ** — `SignupSession`: `account_pending_otp` → `account_verified` → `company_submitted` → `completed` | `abandoned` (ไม่เคลื่อน 7 วัน, ลบข้อมูลส่วนบุคคลใน 30 วัน) — เก็บเพื่อให้กลับมาทำต่อได้และวัด funnel
7. **Event** — `signup.started`, `signup.otp_verified`, `signup.company_lookup {result}`, `signup.completed {tenantId, verificationStatus}`, `signup.join_requested`
8. **กรณีผิดปกติ** — OTP ผิด/หมดอายุ → ข้อความ + ปุ่มขอใหม่หลังนับถอยหลัง; ไม่พบเลขใน RD → ให้กรอกเอง + แจ้ง "จะตรวจภายหลัง"; ปิดเบราว์เซอร์กลางทาง → login แล้วกลับมาขั้นที่ค้าง; อีเมลมีบัญชีแล้ว → "เข้าสู่ระบบเพื่อเพิ่มบริษัทใหม่" (ผู้ใช้เดิมสร้าง tenant ที่สองได้ ใช้ขั้น 2–3); SMS gateway ล่ม → ให้ยืนยันทางอีเมลแทนชั่วคราว [PROPOSED]
9. **เกณฑ์ตรวจรับ**
- Given เลข 0105567153766 สาขา 00000 พบใน RD และชื่อตรง When กด "เริ่มใช้งาน" Then เข้าแอปภายใน 60 วิ สถานะ `trialing` trialEndsAt = วันนี้ + 30
- Given เลขเดียวกับ tenant ที่มีอยู่ When กด "ค้นหา" Then ไม่แสดงปุ่มสร้างบริษัท แสดง "ส่งคำขอเข้าร่วมบริษัท" / "ติดต่อเรา"
- Given checksum ผิด When พิมพ์ครบ 13 หลัก Then แสดง error ทันทีและไม่มี request ไป RD
10. **เฟส** — P0 (สมัคร + RD lookup + คิวอนุมัติ) · Google sign-in, DBD enrichment P1 · BDEX P2

---

## 3. เข้าสู่ระบบ, ลืมรหัสผ่าน, หลายบริษัท, เชิญผู้ใช้

1. **จุดประสงค์** — ยืนยันตัวตนผู้ใช้ลูกค้า และให้ผู้ใช้ 1 คนอยู่หลายบริษัทด้วย role ต่างกัน
2. **ผู้ใช้/สิทธิ์** — ผู้ใช้ทุกคน; เชิญ/ปิดผู้ใช้ = สิทธิ์ `users.manage` (owner/admin)
3. **หน้าจอ** — เข้าสู่ระบบ (อีเมล+รหัสผ่าน / Google / "เข้าด้วย OTP มือถือ" สำหรับคนขับ — ดู 04), ลืมรหัสผ่าน, ตั้งรหัสใหม่, หน้า 2FA, หน้าเลือกบริษัท (เมื่อมี membership > 1), เมนูสลับบริษัทที่หัว sidebar (แสดงชื่อ + สาขา + ป้ายสถานะถ้าไม่ใช่ active), หน้ารับคำเชิญ
4. **ฟิลด์**

| Entity.ฟิลด์ | ชนิด | บังคับ | กฎ | หมายเหตุ |
|---|---|---|---|---|
| User.email | email | ✓ (ยกเว้นคนขับ) | unique ทั้งระบบ | |
| User.mobile | E.164 | | unique ทั้งระบบ | |
| User.passwordHash | argon2id | | | |
| User.totpSecret, recoveryCodes | encrypted | | | §13.6 |
| User.locale | th/en/zh | ✓ | | |
| Membership.(userId, tenantId) | | ✓ | unique คู่ | |
| Membership.roleIds | Role[] | ✓ | ≥ 1 role | |
| Membership.status | `invited` `active` `disabled` | ✓ | | |
| Membership.branchScope | Branch[] / all | | | จำกัดเห็นข้อมูลเฉพาะสาขา [PROPOSED P1] |
| Invitation.email, roleIds, expiresAt, invitedBy | | ✓ | หมดอายุ 7 วัน | token ใช้ครั้งเดียว |

5. **กฎธุรกิจ**
- **PLT-030** session = access token (JWT, 15 นาที) + refresh token (rotating, 30 วัน, ผูกอุปกรณ์); token มี `tenantId` ของบริษัทที่เลือกปัจจุบัน — สลับบริษัท = ออก token ใหม่ ห้ามใช้ token เดียวข้าม tenant
- **PLT-031** login ผิด 5 ครั้งใน 15 นาที → ล็อกบัญชี 15 นาที + อีเมลแจ้ง; ข้อความผิดพลาดไม่บอกว่าอีเมลมีอยู่หรือไม่
- **PLT-032** ลืมรหัสผ่าน: ลิงก์อายุ 30 นาที ใช้ครั้งเดียว; ตั้งรหัสใหม่แล้วเพิกถอน refresh token ทุกอุปกรณ์
- **PLT-033** หน้าเลือกบริษัท: เรียงตามใช้ล่าสุด; จำบริษัทล่าสุดต่อผู้ใช้; บริษัทที่ membership `disabled` ไม่แสดง; บริษัทสถานะ suspended/cancelled แสดงพร้อมป้ายและพาไปหน้าแพ็กเกจ
- **PLT-034** ผู้ใช้ไม่ถูกนับเงิน (user ไม่จำกัดทุกแพ็กเกจ) [PROPOSED ตาม decisions ข้อ 4]
- **PLT-035** เชิญผู้ใช้ที่มีบัญชีแล้ว → เพิ่ม membership เมื่อกดรับ; ยังไม่มีบัญชี → ตั้งรหัส + OTP แล้วเข้า tenant
- **PLT-036** ปิดผู้ใช้ (disable) = เพิกถอน session ของ tenant นั้นทันที, API key/MCP connection ที่ผู้ใช้สร้างยังทำงานต่อจนกว่าผู้ดูแลจะเปลี่ยนเจ้าของหรือเพิกถอน (แสดงคำเตือนพร้อมรายการ) [PROPOSED]
- **PLT-037** owner คนสุดท้ายของ tenant ปิด/ลดสิทธิ์ตัวเองไม่ได้ ต้องโอน owner ก่อน
6. **สถานะ** — Membership: `invited` → `active` (รับคำเชิญ) · `active` ↔ `disabled` (ผู้ดูแล + เหตุผล) · `invited` → (หมดอายุ) ลบคำเชิญ ส่งใหม่ได้
7. **Event** — `user.invited`, `user.joined`, `user.disabled`, `user.role_changed`, `auth.login_failed`, `auth.locked`, `auth.password_reset` (audit; ไม่เป็น webhook)
8. **กรณีผิดปกติ** — คำเชิญหมดอายุ → ขอส่งใหม่; อีเมลเชิญซ้ำกับสมาชิกเดิม → แจ้ง "เป็นสมาชิกแล้ว"; ผู้ใช้ไม่มีบริษัท active เลย → หน้า "ยังไม่มีบริษัท" + ปุ่มสร้างบริษัท
9. **เกณฑ์ตรวจรับ** — Given ผู้ใช้อยู่ 2 บริษัท (บริษัท A = dispatcher, B = viewer) When สลับไป B Then เมนูสร้าง SO ไม่แสดงปุ่มสร้าง และ request ด้วย token เดิมของ A ไปยังข้อมูล B ได้ 404
10. **เฟส** — P0 · branchScope P1

---

## 4. Setup checklist

1. **จุดประสงค์** — พาลูกค้าใหม่ตั้งค่าจนใช้งานจริงได้
2. **ผู้ใช้/สิทธิ์** — แสดงเฉพาะผู้มีสิทธิ์ `settings.manage` หรือ owner
3. **หน้าจอ** — การ์ดบนหน้าภาพรวม: แถบ progress "3/6", รายการขั้น + ปุ่มไปหน้าที่เกี่ยวข้อง, ปุ่ม "ซ่อน" (ซ่อนต่อผู้ใช้; เปิดคืนได้จากเมนูช่วยเหลือ)
4. **ฟิลด์ / ขั้น**

| # | ขั้น | ตรวจว่าเสร็จจาก | บังคับ |
|---|---|---|---|
| 1 | ตั้งค่าบริษัท | Tenant มีที่อยู่ครบ + โลโก้ + ตั้งค่าภาษีแล้ว (05) | ✓ |
| 2 | เพิ่มรถ (นำเข้า Excel ได้) | Vehicle ≥ 1 | ✓ |
| 3 | เพิ่มคนขับ | Driver ≥ 1 | ✓ |
| 4 | เชิญทีม | Membership active ≥ 2 | ✓ |
| 5 | สร้าง SO แรก | Order ≥ 1 (ไม่นับ sandbox) | ✓ |
| 6 | เชื่อมระบบบัญชี | Connector active ≥ 1 หรือกด "ไม่เชื่อม ใช้ TMS ออกเอกสารเอง" | ไม่บังคับ |

5. **กฎธุรกิจ** — **PLT-040** สถานะแต่ละขั้นคำนวณจากข้อมูลจริง (ไม่ใช่ติ๊กเอง) ยกเว้นขั้น 6 ที่เลือก "ไม่เชื่อม" ได้ · **PLT-041** ครบขั้นบังคับทั้ง 5 → การ์ดหายถาวรและบันทึก `setup.completed` (ใช้วัด activation ใน Console) · **PLT-042** ขั้น 6 ห้ามแนะนำ connector ใดเป็นพิเศษ (D2) — ลิงก์ไปหน้าการเชื่อมต่อที่ค่าเริ่มต้น "ไม่เชื่อม"
6. **สถานะ** — ต่อขั้น: `todo` / `done` / `skipped` (ขั้น 6 เท่านั้น)
7. **Event** — `setup.step_completed {step}`, `setup.completed`
8. **กรณีผิดปกติ** — ลบรถคันเดียวหลังขั้น 2 เสร็จ → ขั้นกลับเป็น todo ถ้า checklist ยังไม่ completed
9. **เกณฑ์ตรวจรับ** — Given tenant ใหม่ When นำเข้ารถ 12 คันจาก Excel Then ขั้น 2 เป็น ✓ และ progress 1→2/6 โดยไม่ต้อง refresh
10. **เฟส** — P0

---

## 5. Banner สถานะ

1. **จุดประสงค์** — บอกผู้ใช้ทุกหน้าเมื่อบัญชีต้องการการกระทำ
2. **ผู้ใช้/สิทธิ์** — ทุกคนเห็น; ปุ่ม "ชำระเงิน/เลือกแพ็กเกจ" แสดงเฉพาะสิทธิ์ `billing.manage`; คนอื่นเห็น "แจ้งผู้ดูแลระบบ"
3. **หน้าจอ** — แถบบนสุดทุกหน้าของแอปลูกค้า (เหนือ top bar) สูง 40px; แอปคนขับไม่แสดง (ยกเว้น suspended — ดู §1.8)
4. **ฟิลด์ / ข้อความ**

| เงื่อนไข | สี | ข้อความ (TH) | ปุ่ม | ปิดได้ |
|---|---|---|---|---|
| trialing, เหลือ > 7 วัน | กำลังทำ (ฟ้า) | ทดลองใช้เหลือ {n} วัน | เลือกแพ็กเกจ | ✓ (กลับมาวันถัดไป) |
| trialing, เหลือ ≤ 7 วัน | รอ (เหลือง) | ทดลองใช้เหลือ {n} วัน — เลือกแพ็กเกจเพื่อใช้งานต่อ | เลือกแพ็กเกจ | ✗ |
| pending_verification | รอ | กำลังตรวจสอบข้อมูลบริษัท ออกใบกำกับภาษีได้หลังอนุมัติ | ดูสถานะ | ✗ |
| past_due | รอ | ค้างชำระ เหลือ {n} วันก่อนเป็นอ่านอย่างเดียว | ชำระเงิน | ✗ |
| read_only | ผิดพลาด (แดง) | บัญชีเป็นอ่านอย่างเดียว สร้างงานใหม่ไม่ได้ ดูและ export ได้ | ชำระเงิน | ✗ |
| cancelAtPeriodEnd | ร่าง (เทา) | แพ็กเกจจะสิ้นสุด {date} | ยกเลิกการยกเลิก | ✓ |
| quota ≥ 90% (§7) | รอ | ใช้ {metric} ไปแล้ว {x}/{limit} | ซื้อเพิ่ม/อัปเกรด | ✓ |
| impersonation | ส้ม (§11.5) | กำลังใช้งานแทน {บริษัท} · ออก | ออก | ✗ |

5. **กฎธุรกิจ** — **PLT-050** แสดงได้ทีละ 1 banner ตามลำดับความสำคัญ: impersonation > read_only > past_due > pending_verification > trial ≤7 > quota > trial >7 > cancelAtPeriodEnd · **PLT-051** ค่า {n} คำนวณตามเวลาไทย ปัดลง
6. **สถานะ** — ไม่มี (คำนวณจาก Tenant/Subscription/Usage)
7. **Event** — ไม่มี
8. **กรณีผิดปกติ** — ผู้ใช้ไม่มีสิทธิ์ billing กดปุ่ม → dialog แสดงรายชื่อผู้ดูแลระบบ + ปุ่ม "ส่งอีเมลแจ้ง"
9. **เกณฑ์ตรวจรับ** — Given past_due วันที่ 3 และ impersonation อยู่ When เปิดหน้าใด Then เห็นเฉพาะแถบส้ม impersonation
10. **เฟส** — P0

---

## 6. แพ็กเกจ, เวอร์ชัน, Entitlement, Add-on, Override

1. **จุดประสงค์** — นิยามว่าลูกค้าแต่ละรายได้อะไร ในราคาเท่าไร จากข้อมูลชุดเดียว
2. **ผู้ใช้/สิทธิ์** — แก้ได้เฉพาะ Console owner (sales ดูได้); ลูกค้าอ่านอย่างเดียว
3. **หน้าจอ** — Console §10.4 (ตัวแก้), หน้าราคาสาธารณะ §2, หน้าแพ็กเกจลูกค้า §8
4. **ฟิลด์**

| Entity | ฟิลด์หลัก | หมายเหตุ |
|---|---|---|
| `Plan` | code (เช่น `starter`), nameTh/En/Zh, descriptionI18n, status `draft` `active` `archived`, showOnWeb, sortOrder, badge (เช่น "นิยม"), isContactSales | |
| `PlanVersion` | planId, version (int), pricePerVehicleMonthly (decimal 2), annualDiscountPct, minimumMonthly, volumeTiers `[{fromVehicle, discountPct}]`, trialDays, currency `THB`, vatMode `exclusive`, effectiveFrom, status `draft` `published` `retired` | publish แล้วแก้ไม่ได้ (immutable) |
| `Feature` | key (เช่น `subcon.settlement`), category, nameI18n, type `boolean` `limit` `metered`, unit, isBasic (bool), sortOrder | catalog กลาง เพิ่มโดย dev ผ่าน migration |
| `PlanEntitlement` | planVersionId, featureKey, mode `included` `addon` `not_available`, limit (int/null=ไม่จำกัด) | เซลล์ใน feature matrix |
| `AddOn` | code, nameI18n, featureKey, unitPrice, unit (`per_vehicle`, `per_connector`, `per_1000_credits`, `per_10gb`, `one_time`), billing `recurring` `one_time`, availableForPlanCodes[] | |
| `SubscriptionAddOn` | subscriptionId, addOnId, quantity, priceSnapshot, startAt, endAt | |
| `TenantEntitlementOverride` | tenantId, featureKey, mode `grant` `revoke` `set_limit`, limit, reason (≥10), approvedBy, expiresAt | |
| `Subscription` | tenantId, planVersionId, billingCycle `monthly` `annual`, status `trialing` `active` `past_due` `cancelled`, trialEndsAt, currentPeriodStart/End, cancelAtPeriodEnd, couponId, committedVehicles (รายปี), paymentMethodId, nextPlanVersionId (downgrade รอมีผล) | |

**Feature catalog ขั้นต่ำ** (คอลัมน์ "พื้นฐาน" = isBasic, ล็อกไม่ได้)

| หมวด | featureKey | ชนิด | พื้นฐาน |
|---|---|---|---|
| งานขนส่ง | `core.orders` (SO/DO), `core.trips`, `core.planning_board`, `core.locations`, `core.rate_cards` | boolean | ✓ |
| ปฏิบัติการ | `driver_app`, `pod.capture`, `tracking.public_link`, `exceptions` | boolean | ✓ |
| ปฏิบัติการ | `tracking.live_map`, `customer_notifications` (SMS/LINE ตามโควตา `notifications.monthly`) | boolean/limit | |
| บัญชี | `billing.invoices`, `billing.tax_documents`, `billing.receipts`, `billing.credit_notes`, `billing.payments`, `billing.accountant_export` | boolean | ✓ |
| รถร่วม | `subcon.payment`, `subcon.wht_50tawi` | boolean | ✓ [PROPOSED] |
| รถร่วม | `subcon.dispatch_link`, `subcon.settlement_review` | boolean | [OPEN] |
| รายงาน | `reports.basic` | boolean | ✓ |
| รายงาน | `reports.profit`, `reports.scheduled` | boolean | |
| Fleet | `fleet.basic` (ทะเบียนรถ เอกสารรถ ใบสั่งซ่อม), `fleet.full` (ยาง อะไหล่ ถังน้ำมัน ลีสซิ่ง) | boolean | basic ✓ |
| องค์กร | `org.legal_entities` (limit), `org.branches` (limit), `org.custom_roles`, `org.approval_flows`, `org.sso` | | |
| ฟิลด์ | `custom_fields.per_entity` | limit | |
| เชื่อมต่อ | `connectors.accounting` (limit), `api.open_api`, `api.write`, `api.rate_limit_per_min` (limit), `api.monthly_calls` (limit), `api.log_retention_days` (limit), `webhooks.endpoints` (limit), `mcp.server` | | |
| AI | `ai.enabled`, `ai.credits_monthly` (limit) | | |
| พื้นที่ | `storage.pod_gb` (limit) | metered | |
| การคิดเงิน | `vehicles.active` (limit; null = ไม่จำกัด) | metered | |

5. **กฎธุรกิจ**
- **PLT-060** [DECISION] การเปลี่ยนราคาหรือ entitlement = สร้าง `PlanVersion` ใหม่; ลูกค้าเดิมอยู่บนเวอร์ชันเดิม (grandfather) จนกว่าจะย้ายด้วยปุ่ม "ย้ายลูกค้าเดิม" ที่กำหนดวันมีผลซึ่งต้อง ≥ วันแจ้ง + `planMigration.noticeDays` (ค่าเริ่ม 30 วัน [PROPOSED]) และส่งอีเมลแจ้ง
- **PLT-061** [DECISION] featureKey ที่ `isBasic=true` บังคับ `mode=included` ทุก PlanVersion — ตัวแก้ matrix ล็อกเซลล์ และ API ปฏิเสธ (D4)
- **PLT-062** entitlement ที่มีผล = `PlanEntitlement` → ทับด้วย `SubscriptionAddOn` (เพิ่ม limit/เปิด) → ทับด้วย `TenantEntitlementOverride` ที่ยังไม่หมดอายุ (grant/revoke/set_limit) → ถ้า tenant สถานะจำกัด (ตาราง 1.6) ตัดออกอีกชั้น; คำนวณใน service เดียว `EntitlementService.resolve(tenantId)` cache 60 วิ ล้าง cache เมื่อมีการเปลี่ยน
- **PLT-063** [PROPOSED ราคา — decisions ข้อ 4] ค่าเริ่มต้นสำหรับ seed (ไม่ใช่ค่าคงที่): Starter 249 / Growth 399 / Business 499 บาท/รถ active/เดือน ก่อน VAT, Enterprise ตกลง; ขั้นต่ำ 2,490 / 3,990 / 9,980; ส่วนลดปริมาณคันที่ 51–100 −10%, 101+ −20%; รายปี −10% / −15% / −15%; trial 30 วัน ไม่ใช้บัตร เปิดฟีเจอร์ระดับ Growth ≤ 20 คัน · ต้นแบบใช้ 3 แพ็กเกจ ฿390/฿690/ติดต่อฝ่ายขาย เป็น placeholder [OPEN: จำนวน tier 3 หรือ 4 และตัวเลขสุดท้าย]
- **PLT-064** [PROPOSED] โควตาเริ่มต้นตามต้นแบบรอบ 13–14 (ปรับใน matrix): custom fields/entity 5 / 20 / ไม่จำกัด; AI credit 200 / 1,000 / ตกลง; webhook endpoints 0 / 3 / ไม่จำกัด; API rate limit — / 300 / 1,000 req/นาที/key; connector บัญชี 0 (export ไฟล์) / 1 / ไม่จำกัด; พื้นที่ POD [OPEN: 20/100 GB ตามต้นแบบ หรือ 5/25/100 GB ตาม decisions]
- **PLT-065** add-on ซื้อได้เฉพาะ `availableForPlanCodes` ที่ตรงกับแพ็กเกจปัจจุบัน; add-on ที่ซื้อแล้วแต่แพ็กเกจใหม่รวมไว้แล้ว → ยกเลิก add-on อัตโนมัติเมื่อเปลี่ยนแพ็กเกจ (คืนตามสัดส่วนเป็นเครดิต)
- **PLT-066** override ต้องมีเหตุผล ≥ 10 ตัว และผู้อนุมัติ (owner ถ้าผู้ขอเป็น sales/support); แสดงในแท็บ "สิทธิ์พิเศษ" ของลูกค้าและในหน้าแพ็กเกจลูกค้าเป็นป้าย "สิทธิ์พิเศษ" (ไม่แสดงเหตุผลภายใน)
6. **สถานะ** — Plan: `draft` → `active` → `archived` (ไม่รับลูกค้าใหม่ ลูกค้าเดิมคงอยู่) · PlanVersion: `draft` → `published` (มีผลตั้งแต่ effectiveFrom) → `retired` (เมื่อไม่มี subscription อ้างถึงและมีเวอร์ชันใหม่กว่า)
7. **Event** — `plan.version_published`, `plan.migration_scheduled`, `subscription.plan_changed`, `subscription.addon_added/removed`, `entitlement.override_set/expired`
8. **กรณีผิดปกติ** — override หมดอายุขณะใช้งาน → ฟีเจอร์ล็อกในรอบ cache ถัดไป, ข้อมูลไม่หาย; ลด limit ต่ำกว่าที่ใช้อยู่ (เช่น custom fields 12 ตัว ลดเหลือ 5) → ไม่ลบของเดิม แต่สร้างใหม่ไม่ได้และแสดง "เกินโควตา 7"
9. **เกณฑ์ตรวจรับ**
- Given PlanVersion v1 ราคา 399 มีลูกค้า 10 ราย When owner บันทึกราคา 449 Then เกิด v2, ลูกค้า 10 รายยังเห็น 399, หน้าราคาสาธารณะแสดง 449
- Given featureKey `billing.tax_documents` When พยายามตั้ง `addon` ในแพ็กเกจใด Then API ตอบ 422 `basic_feature_locked`
10. **เฟส** — P0 (Plan/Version/Entitlement/Override/guard) · Add-on ซื้อเองในแอป P1 · volume tiers P1

---

## 7. รถ active และการนับการใช้งาน (Usage metering)

1. **จุดประสงค์** — นับหน่วยคิดเงินและโควตาอย่างตรวจสอบได้
2. **ผู้ใช้/สิทธิ์** — ระบบนับ; ลูกค้าดูรายการรถที่ถูกนับ (`billing.view`); Console ดูทุกราย
3. **หน้าจอ** — หน้าแพ็กเกจ §8 แถบ "รถ active" → drawer รายการทะเบียนที่ถูกนับ + เที่ยว/DO แรกที่ทำให้นับ
4. **ฟิลด์** — `UsageRecord(tenantId, metric, period YYYY-MM, value, finalizedAt, detailRef)`; `ActiveVehicleUsage(tenantId, period, plateNormalized, vehicleId?, subcontractorId?, firstClosedDocType, firstClosedDocId, firstClosedAt)` unique `(tenantId, period, plateNormalized)`; `UsageDaily(tenantId, date, metric, value)`

| metric | หน่วย | นับจาก | รีเซ็ต |
|---|---|---|---|
| `vehicles.active` | คัน | ข้อ PLT-070 | รายเดือนปฏิทิน |
| `storage.pod_gb` | GB (ทศนิยม 2) | ขนาดไฟล์ POD + เอกสารแนบทั้งหมด (สะสม) | ไม่รีเซ็ต |
| `api.calls` | ครั้ง | REST + MCP (แยก source) ที่ได้ 2xx/4xx (ไม่นับ 429/5xx) | รายเดือน |
| `ai.credits` | credit | `AiUsage` (08) | รายเดือน |
| `notifications.sms`, `notifications.line` | ข้อความ | การส่งแจ้งลูกค้าปลายทาง | รายเดือน |
| `custom_fields` | ตัว/entity | นับสด | — |
| `connectors.accounting` | ตัว | connector สถานะ active | — |

5. **กฎธุรกิจ**
- **PLT-070** [PROPOSED — decisions ข้อ 1] รถ active = ทะเบียนรถ 1 ทะเบียน (normalize: ตัดช่องว่าง/ขีด, รวมจังหวัด) ทั้งรถบริษัทและรถร่วม ที่ปรากฏบน Trip หรือ DO ที่ **ปิดสถานะ** (ส่งสำเร็จ / ปิดงาน / ยกเลิกหลังออกวิ่ง) ≥ 1 ใบในเดือนปฏิทิน นับ ณ 23:59:59 วันสุดท้ายของเดือน (Asia/Bangkok)
- **PLT-071** ไม่นับ: Trip ร่าง/ยังไม่ออกวิ่ง, งานใน sandbox, งานที่ยกเลิกก่อนออกวิ่ง; ทะเบียนที่ถูกลบกลางเดือนแต่มีงานปิดแล้ว **ยังนับ**
- **PLT-072** ผูกการนับกับ **ทะเบียนบนเอกสารที่ปิดงาน** ไม่ใช่ master รถ (กันการยุบหลายคันลงทะเบียนเดียว); หางลาก (trailer) ไม่นับแยก [PROPOSED]
- **PLT-073** [PROPOSED] รถร่วมคิดเต็มราคาเท่ารถบริษัท [OPEN: decisions ข้อ 9/12 — เต็มหรือครึ่งราคา และใครจ่าย]
- **PLT-074** นับแบบ real-time (insert `ActiveVehicleUsage` เมื่อเอกสารปิดครั้งแรกของเดือน) และ finalize วันที่ 1 เวลา 02:00 ของเดือนถัดไป → `UsageRecord.finalizedAt`; หลัง finalize แก้ได้เฉพาะ finance ใน Console พร้อมเหตุผล
- **PLT-075** เอกสารถูก reopen แล้วไม่มีเอกสารปิดอื่นของทะเบียนนั้นในเดือน → ลบออกจากการนับก่อน finalize เท่านั้น
6. **สถานะ** — UsageRecord: `open` → `finalized` → `invoiced`
7. **Event** — `usage.threshold_reached {metric, pct: 80|90|100}`, `usage.period_finalized`
8. **กรณีผิดปกติ** — ทะเบียนพิมพ์ต่างกันเล็กน้อย (กข-1234 / กข1234) → normalize รวมเป็นคันเดียว; ทะเบียนว่างบนเอกสารรถร่วม → นับด้วย `subcontractorId+driverId` และ flag ให้ลูกค้าเติม; เอกสารปิดช่วง 23:59–00:01 ข้ามเดือน → ใช้ `closedAt` ตามเวลาไทย
9. **เกณฑ์ตรวจรับ** — Given รถ 1 คันปิด DO 10 ใบในเดือน และรถอีกคันมีแค่ Trip ร่าง When finalize Then `vehicles.active = 1`
10. **เฟส** — P0

### 7.1 การบังคับโควตาและการล็อกฟีเจอร์

- **PLT-076** [DECISION] เมนูของโมดูลที่ไม่มีในแพ็กเกจ **แสดงพร้อมไอคอน 🔒 ไม่ซ่อน**; เปิดแล้วเป็นหน้าแนะนำโมดูล (ภาพ + 3 ประโยชน์ + แพ็กเกจที่มี + ปุ่ม "อัปเกรด"/"ซื้อ add-on" สำหรับผู้มีสิทธิ์ billing หรือ "แจ้งผู้ดูแลระบบ")
- **PLT-077** ฟีเจอร์พื้นฐาน (isBasic) ไม่แสดง 🔒 ในทุกกรณี; ข้อจำกัดเดียวที่ใช้กับฟีเจอร์พื้นฐานคือสถานะ tenant (ตาราง 1.6)
- **PLT-078** API ที่เรียกฟีเจอร์ที่ไม่มีสิทธิ์ตอบ 403 problem+json `code: feature_not_in_plan` พร้อม `featureKey`
- **PLT-079** [PROPOSED] โควตาแบบ limit (custom fields, webhooks, connectors, branches) = **hard limit**: สร้างรายการใหม่ไม่ได้ dialog เสนอ add-on/อัปเกรด
- **PLT-080** [PROPOSED] `vehicles.active` = **soft limit**: เมื่อจ่ายงานให้ทะเบียนที่ยังไม่ถูกนับเดือนนี้และจะทำให้เกิน limit → dialog เตือน (ผู้จัดรถกด "จ่ายงานต่อ" ได้ ไม่หยุดงานขนส่ง) แจ้งผู้ดูแลระบบ; ส่วนที่เกินคิดตาม add-on "รถเกินโควตา" ต่อคันในใบแจ้งหนี้ถัดไป [OPEN: soft หรือ hard]
- **PLT-081** AI credit หมด → ฟีเจอร์ AI ปิดชั่วคราว งานด้วยมือทำได้ปกติ (08); API เกิน `api.monthly_calls` → 429 `quota_exceeded` จนสิ้นเดือนหรือซื้อเพิ่ม
- **PLT-082** แจ้งเตือนผู้ดูแลระบบเมื่อ metric ถึง 80% / 90% / 100% (อีเมล + ในแอป) ครั้งเดียวต่อระดับต่อเดือน
- เกณฑ์ตรวจรับ: Given แพ็กเกจไม่มี `fleet.full` When คลิกเมนู "ยาง" Then เห็นหน้าแนะนำโมดูลพร้อม 🔒 และไม่มีข้อมูลยางรั่วผ่าน API (403)

---

## 8. หน้า "แพ็กเกจและการเรียกเก็บเงิน" (ฝั่งลูกค้า)

1. **จุดประสงค์** — ให้ลูกค้าเห็นและจัดการแพ็กเกจ การใช้งาน การชำระ และเอกสารที่เราออกให้
2. **ผู้ใช้/สิทธิ์** — `billing.view` (owner, admin, accounting ค่าเริ่มต้น), `billing.manage` (owner, admin)
3. **หน้าจอ** (ตั้งค่า → แพ็กเกจและการเรียกเก็บเงิน)
   - การ์ดแพ็กเกจปัจจุบัน: ชื่อ, ราคาต่อรถ (ตามเวอร์ชันของลูกค้า), รอบบิล, วันต่ออายุ, สถานะ, trial เหลือ X วัน, ป้าย "ราคาเดิม" ถ้า grandfathered
   - การใช้งานเดือนนี้: แถบ รถ active `12/20` (คลิก → drawer รายการทะเบียน), พื้นที่ POD, connector, API calls (REST/MCP), ฟิลด์เพิ่มเติม, SMS/LINE, AI credit — สีแถบ: <80% accent, 80–99% รอ, ≥100% ผิดพลาด
   - ประมาณการบิลเดือนนี้: จำนวนรถ × ราคา, ขั้นต่ำ, ส่วนลด, add-on, VAT
   - ตารางโมดูล: ✓ มี / 🔒 ในแพ็กเกจสูงกว่า (ปุ่ม ดูรายละเอียด) / "add-on" ที่ซื้อแล้ว / "สิทธิ์พิเศษ"
   - ปุ่ม: เปลี่ยนแพ็กเกจ (dialog เทียบแพ็กเกจ + ยอดตามสัดส่วน), ซื้อ add-on, ยกเลิกเมื่อครบรอบ, ยกเลิกการยกเลิก
   - วิธีชำระ: บัตร (แสดง 4 หลักท้าย/หมดอายุ), PromptPay QR, โอน + แนบสลิป (แสดงเลขบัญชีเรา)
   - ใบแจ้งหนี้/ใบกำกับภาษี/ใบเสร็จที่ **เราออกให้ลูกค้า** (ตาราง: เลขที่, วันที่, ยอด, สถานะ, PDF) — หัวข้อแยกชัดว่า "เอกสารจากผู้ให้บริการระบบ" ไม่ปนกับเอกสารที่ลูกค้าออกให้ลูกค้าของเขา (05)
   - ข้อมูลผู้ซื้อบนใบกำกับ: ชื่อ ที่อยู่ เลขผู้เสียภาษี สาขา (ค่าเริ่มจาก Tenant แก้ได้) + อีเมลรับเอกสาร
4. **ฟิลด์** — `PaymentMethod(type card|promptpay|bank_transfer, providerCustomerId, providerCardId, last4, expMonth/Year, isDefault)` ไม่เก็บ PAN · `BillingContact(name, email[], taxId, branchCode, address)`
5. **กฎธุรกิจ**
- **PLT-090** [PROPOSED] รอบบิลรายเดือนคิดย้อนหลังตามการใช้: ออกใบแจ้งหนี้วันที่ 1 สำหรับเดือนก่อน = max(รถ active × ราคาตาม volume tiers, minimumMonthly) + add-on − ส่วนลด/คูปอง + VAT 7%; ครบกำหนด 7 วัน [OPEN: คิดล่วงหน้าหรือย้อนหลัง]
- **PLT-091** [PROPOSED] รายปีจ่ายล่วงหน้าตาม `committedVehicles` × ราคา × 12 × (1 − ส่วนลด); รถ active เกิน committed คิดรายเดือนย้อนหลังที่ราคารายปี
- **PLT-092** เปลี่ยนแพ็กเกจ: **อัปเกรด** มีผลทันที ค่าบริการเดือนนั้นแบ่งตามวัน (`วันในแพ็กเกจ/วันในเดือน` × ราคาของแต่ละแพ็กเกจ × รถ active); **ดาวน์เกรด** มีผลรอบถัดไป (`nextPlanVersionId`) และ dialog แสดงฟีเจอร์/โควตาที่จะเสีย + จำนวนรายการที่เกินโควตาใหม่ · dialog แสดงยอดประมาณการก่อนยืนยันเสมอ
- **PLT-093** ยกเลิก: มีผลสิ้นรอบที่จ่ายแล้ว; dialog ถามเหตุผล (ตัวเลือก + ข้อความ) และบอกระยะเก็บข้อมูล (90 วัน) + การ export; ไม่มีค่าปรับ (D4)
- **PLT-094** [PROPOSED] ช่องทางชำระ — บัตร (Opn, ตัดอัตโนมัติวันออกใบแจ้งหนี้, retry +1/+3/+5 วัน), PromptPay (QR อายุ ≤ 24 ชม. สร้างใหม่เมื่อเปิดหน้า), โอน + สลิป (ยอดมีเศษสตางค์เฉพาะใบเพื่อช่วยจับคู่) — ผ่าน interface `PaymentProvider` สลับผู้ให้บริการได้
- **PLT-095** [PROPOSED] สลิป: ตรวจอัตโนมัติ (เช่น EasySlip) 4 ข้อ: API ยืนยัน valid, บัญชีผู้รับเป็นของเรา, ยอด = ใบแจ้งหนี้ (±0.00), `transRef` ไม่เคยใช้ (unique) → ผ่านครบ = ชำระแล้วอัตโนมัติ; ไม่ผ่านข้อใด → `review` เข้าคิว finance (ห้ามปฏิเสธอัตโนมัติ)
- **PLT-096** [FACT] ใบกำกับภาษีค่าบริการของเรา: VAT 7% แยกบรรทัด, มีเลขผู้เสียภาษี + สาขาของผู้ซื้อ, เลขที่รันต่อเนื่องไม่ย้อน, เก็บ PDF ที่ render ณ วันออก (immutable) · [PROPOSED] ออกใบกำกับภาษี/ใบเสร็จเมื่อได้รับชำระ (จุดความรับผิดของบริการ) — ก่อนชำระออกเป็น "ใบแจ้งหนี้" [OPEN: ยืนยันกับนักบัญชีของเรา]
- **PLT-097** [OPEN] ลูกค้านิติบุคคลหักภาษี ณ ที่จ่ายค่าบริการของเราหรือไม่/อัตราใด — ถ้าหัก: ยอดรับชำระ = ยอด − WHT, ลูกค้าอัปโหลด 50 ทวิ, finance ยืนยัน
- **PLT-098** e-Tax Invoice ค่าบริการของเราผ่าน service provider [PROPOSED P2]
6. **สถานะ** — `PlatformInvoice`: `draft` → `open` (ส่งแล้ว) → `paid` | `partially_paid` | `void` (finance + เหตุผล) ; ครบกำหนดยังไม่จ่าย = `open` + `overdue` flag · `PlatformPayment`: `pending` → `succeeded` | `failed` | `review` (สลิป) → `succeeded` | `rejected`
7. **Event** — `platform_invoice.issued`, `platform_invoice.paid`, `platform_payment.failed`, `platform_payment.slip_review`, `subscription.cancel_requested`, `subscription.renewed`
8. **กรณีผิดปกติ** — webhook gateway มาช้า/ไม่มา → poll charge pending ทุก 15 นาที; ลูกค้าโอนแต่ไม่แนบสลิป → finance จับคู่จาก statement ด้วยมือ; โอนยอดไม่ตรง → `review`; บัตรหมดอายุ → อีเมลล่วงหน้า 14 วัน; จ่ายซ้ำ 2 ช่องทาง → ยอดเกินเป็นเครดิตใบถัดไป (คืนเงินผ่าน finance)
9. **เกณฑ์ตรวจรับ**
- Given แพ็กเกจ 20 คัน ใช้ 12 When เปิดหน้า Then แถบแสดง 12/20 และคลิกแล้วเห็นทะเบียน 12 รายการพร้อมเอกสารแรกที่นับ
- Given สลิปยอดตรง บัญชีถูก transRef ใหม่ When อัปโหลด Then ใบแจ้งหนี้ `paid` และสถานะ tenant `active` ภายใน 1 นาที
- Given อัปเกรดวันที่ 16 ของเดือน 30 วัน When ยืนยัน Then dialog แสดงสัดส่วน 15/30 ต่อแพ็กเกจ และฟีเจอร์ใหม่ใช้ได้ทันที
10. **เฟส** — P0: หน้าดูแพ็กเกจ/การใช้งาน, โอน+สลิป (ตรวจด้วยคนได้), ใบกำกับภาษี PDF · P1: บัตร/PromptPay อัตโนมัติ, ตรวจสลิปอัตโนมัติ, เปลี่ยนแพ็กเกจเอง, add-on เอง · P2: e-Tax

---

## 9. นโยบายและค่าตั้งของแพลตฟอร์ม (`PlatformSetting`)

| key | ค่าเริ่มต้น | ป้าย |
|---|---|---|
| `trial.days` | 30 | [PROPOSED] |
| `trial.vehicleLimit` | 20 | [PROPOSED] |
| `pendingVerification.vehicleLimit` | 5 | [PROPOSED] |
| `signup.approvalPolicy` | `auto_when_verified` (`manual_all`) | [PROPOSED] |
| `dunning.pastDueDays` / `readOnlyUntilDay` / `suspendUntilDay` | 7 / 21 / 60 | [PROPOSED] |
| `dunning.reminderDays` | past_due 1,3,6 · read_only 8,14,20 · suspended 22,45,55 | [PROPOSED] |
| `trialExpiry.readOnlyDays` | 14 | [PROPOSED] |
| `retention.operationalDays` | 90 | [PROPOSED] |
| `retention.platformTaxDocsYears` | 7 (ขั้นต่ำตามกฎหมาย 5) | [FACT]+[PROPOSED] |
| `retention.auditLogYears` | 2 | [PROPOSED] |
| `planMigration.noticeDays` | 30 | [PROPOSED] |
| `impersonation.maxMinutes` | 60 | [PROPOSED] |
| `invoice.dueDays` | 7 | [PROPOSED] |

**PLT-099** แก้ค่าเหล่านี้ได้เฉพาะ Console owner พร้อมเหตุผล และบันทึก audit; ค่าใหม่มีผลกับเหตุการณ์ถัดไป ไม่ย้อนหลัง

---

## 10. Platform Console (แอปของทีมเรา)

กติการ่วม: แอปแยก (โดเมน/route แยก), แถบบนสี navy `#13213F` + ป้าย "PLATFORM CONSOLE"; sidebar: ภาพรวม · ลูกค้า · คิวอนุมัติ · แพ็กเกจ · Add-on และคูปอง · การเงิน · การใช้งาน API/AI · ทีมงาน · Audit log · ตั้งค่าแพลตฟอร์ม; login แยกจากลูกค้า (`PlatformUser`) บังคับ 2FA ทุกคน; ทุกการกระทำที่เปลี่ยนข้อมูลลูกค้าต้องมีเหตุผล ≥ 10 ตัว + audit (PLT-004)

### 10.1 ภาพรวม
1. **จุดประสงค์** — เห็นสุขภาพธุรกิจและงานที่ต้องทำวันนี้
2. **ผู้ใช้/สิทธิ์** — ทุก role (finance เห็นตัวเงินครบ; support ไม่เห็น MRR [PROPOSED])
3. **หน้าจอ** — KPI: ลูกค้าตามสถานะ (คลิกกรอง), MRR, ทดลองใกล้หมด 7 วัน, อัตราเปลี่ยนเป็นจ่ายจริง (30/90 วัน), รถ active รวม, ค้างชำระรวม; กราฟ MRR 6 เดือน; รายการต้องจัดการวันนี้ (คิวอนุมัติ, สลิปรอตรวจ, trial หมดพรุ่งนี้, read_only ใหม่, webhook/connector ล้มเหลวมาก)
4. **ฟิลด์ / นิยาม KPI**

| KPI | นิยาม |
|---|---|
| MRR | ผลรวมยอดก่อน VAT ของรอบรายเดือนล่าสุดที่ finalize (รายปี ÷ 12) ของ tenant `active`/`past_due`, ไม่รวม isInternal |
| อัตราเปลี่ยนเป็นจ่ายจริง | tenant ที่ trial จบในช่วง และมี PlatformPayment succeeded ≤ 14 วันหลัง trialEndsAt ÷ tenant ที่ trial จบในช่วง |
| รถ active รวม | Σ `vehicles.active` เดือนปัจจุบัน (real-time) |
| ค้างชำระรวม | Σ PlatformInvoice open ที่เกินกำหนด |

5. **กฎธุรกิจ** — **PLT-100** KPI คำนวณจาก snapshot รายชั่วโมง (ไม่ query สด) และแสดงเวลาที่คำนวณ
6–8. สถานะ/Event/ผิดปกติ — ไม่มีเฉพาะ; snapshot ล้มเหลว → แสดงค่าล่าสุดพร้อมป้าย "ข้อมูล ณ …"
9. **เกณฑ์ตรวจรับ** — Given tenant isInternal 3 ราย When ดู MRR Then ไม่ถูกนับ
10. **เฟส** — P0 (KPI นับลูกค้า/รถ) · กราฟ/conversion P1

### 10.2 ลูกค้า (Tenants)
1. **จุดประสงค์** — ค้นหาและจัดการลูกค้าทุกราย
2. **ผู้ใช้/สิทธิ์** — ดู: ทุก role; การกระทำตามตาราง §11.4
3. **หน้าจอ** — ตาราง: บริษัท, เลขผู้เสียภาษี/สาขา, แพ็กเกจ (+ราคาเวอร์ชันจริง), สถานะ, รถ active/โควตา, วันต่ออายุ, ยอดค้าง, sales ผู้ดูแล; ตัวกรองใต้หัวคอลัมน์; drawer/หน้ารายละเอียด แท็บ:

| แท็บ | เนื้อหา |
|---|---|
| ภาพรวม | ข้อมูลบริษัท, ผลการตรวจ (RD/DBD snapshot), สถานะ + ประวัติสถานะ, ผู้ติดต่อ, checklist progress, โปรแกรมบัญชีที่แจ้ง |
| Subscription | แพ็กเกจ/เวอร์ชัน, รอบบิล, trial, add-on, คูปอง, วันต่ออายุ, cancelAtPeriodEnd |
| การใช้งาน | metric ทุกตัว 6 เดือน, รายการรถ active ต่อเดือน, active users 30 วัน |
| ผู้ใช้ | membership, role, login ล่าสุด, 2FA เปิดไหม (ไม่เห็นรหัส/secret) |
| สิทธิ์พิเศษ | override ทั้งหมด + เหตุผล + ผู้อนุมัติ + หมดอายุ |
| ใบแจ้งหนี้ | PlatformInvoice/Payment ของรายนี้ |
| API / AI | การเรียก REST/MCP, error rate, rate limit ปัจจุบัน, AI credit/ค่าใช้จ่าย, สวิตช์ปิด |
| Log | audit ของทีมเรากับลูกค้ารายนี้ + impersonation sessions |

   การกระทำ (เมนู ⋯ / ปุ่ม): เปลี่ยนแพ็กเกจ, ขยายทดลองใช้ (สูงสุด +30 วัน/ครั้ง [PROPOSED]), ให้ส่วนลด/คูปอง, ตั้ง override, ระงับ/ปลดระงับ, ปิด/เปิด API, ปรับ rate limit, ปิด/เปิด AI, เปลี่ยน sales ผู้ดูแล, เข้าใช้งานแทน, ทำเครื่องหมาย isInternal, แก้ข้อมูลบริษัท (taxId/branch แก้ได้เฉพาะ owner)
5. **กฎธุรกิจ** — **PLT-101** ทุกการกระทำเปิด dialog: สรุปผลกระทบ + ช่องเหตุผล ≥ 10 ตัว + (ถ้าระบุในตาราง §11.4) ผู้อนุมัติ · **PLT-102** การเปลี่ยนแพ็กเกจจาก Console ใช้กติกาเดียวกับ PLT-092 แต่เลือก "มีผลทันที/รอบถัดไป" ได้ · **PLT-103** แจ้งลูกค้าทางอีเมลอัตโนมัติเมื่อ: เปลี่ยนแพ็กเกจ, ขยาย trial, ระงับ/ปลด, ปิด API/AI
7. **Event** — `platform.tenant_action {action, tenantId, reason}`
8. **กรณีผิดปกติ** — สองคนแก้ลูกค้ารายเดียวพร้อมกัน → optimistic lock (version) แจ้ง "ข้อมูลถูกเปลี่ยนโดย …"
9. **เกณฑ์ตรวจรับ** — Given support When กด "เปลี่ยนแพ็กเกจ" Then ปุ่มไม่แสดง (ตาม §11.4) และ API 403
10. **เฟส** — P0 (ตาราง, แท็บภาพรวม/Subscription/ผู้ใช้/Log, ระงับ, ขยาย trial, เปลี่ยนแพ็กเกจ) · แท็บ API/AI, คูปอง P1

### 10.3 คิวอนุมัติการสมัคร
1. **จุดประสงค์** — ตรวจผู้สมัครที่ตรวจอัตโนมัติไม่ผ่าน
2. **ผู้ใช้/สิทธิ์** — อนุมัติ/ปฏิเสธ: owner, sales, support
3. **หน้าจอ** — ตารางรายการ `pending_verification` เรียงตามเวลารอ (SLA 1 วันทำการ — แถวเกิน SLA สีรอ); drawer: ตารางเทียบ 3 คอลัมน์ **ที่กรอก | RD | DBD** (ชื่อ, ที่อยู่, สาขา, สถานะกิจการ, วันจด VAT, TSIC) ไฮไลต์ช่องที่ต่าง, ไฟล์หนังสือรับรอง, คำเตือนเลขซ้ำ (ลิงก์ tenant เดิม), ประวัติการสมัครจาก IP/อีเมลเดียวกัน, ปุ่ม อนุมัติ / ปฏิเสธ / ขอข้อมูลเพิ่ม; ตั้งค่านโยบาย "อนุมัติอัตโนมัติเมื่อตรวจผ่าน / ต้องให้ทีมตรวจทุกราย"
4. **ฟิลด์** — `TenantVerification(tenantId, source[], snapshotRd, snapshotDbd, diffFields[], decision approved|rejected|info_requested, reason, decidedBy, decidedAt)`
5. **กฎธุรกิจ** — **PLT-105** ปฏิเสธ/ขอข้อมูลเพิ่มต้องมีเหตุผล ≥ 10 ตัว ส่งอีเมลถึงผู้สมัคร · **PLT-106** อนุมัติแล้วแก้ชื่อ/ที่อยู่ให้ตรงข้อมูลทางการได้ในขั้นเดียวกัน · **PLT-107** คำขอ "เข้าร่วมบริษัทเดิม" ส่งให้ owner ของ tenant เดิมตัดสินก่อน; ไม่ตอบใน 3 วันทำการ → เข้าคิวนี้
6. **สถานะ** — `pending` → `approved` | `rejected` | `info_requested` → (ผู้สมัครตอบ) `pending`
7. **Event** — `verification.approved`, `verification.rejected`, `verification.info_requested`
8. **กรณีผิดปกติ** — DBD/RD ไม่มีข้อมูล → คอลัมน์แสดง "ไม่พบ/เรียกไม่สำเร็จ" + ลิงก์ค้นด้วยมือ
9. **เกณฑ์ตรวจรับ** — Given ชื่อที่กรอก "บจก. ศรีไทยขนส่ง" RD "ศรีไทย ทรานสปอร์ต จำกัด" When เปิด drawer Then ช่องชื่อถูกไฮไลต์ต่าง
10. **เฟส** — P0

### 10.4 แพ็กเกจ (ตัวแก้ feature matrix)
1. **จุดประสงค์** — สร้าง/แก้แพ็กเกจและราคาแบบมีเวอร์ชัน
2. **ผู้ใช้/สิทธิ์** — แก้: owner; ดู: sales, finance
3. **หน้าจอ** — รายการแพ็กเกจ + เวอร์ชัน (สถานะ, จำนวนลูกค้าต่อเวอร์ชัน); ตัวแก้: แถว feature แบ่งหมวด × คอลัมน์แพ็กเกจ, เซลล์ = toggle ✓ / "ซื้อเพิ่ม" / — / ช่องตัวเลข limit (ว่าง = ไม่จำกัด); เซลล์ฟีเจอร์พื้นฐานล็อก ✓; ส่วนราคา (ต่อรถ, ขั้นต่ำ, ส่วนลดรายปี, volume tiers, trial days), ชื่อ/คำอธิบาย 3 ภาษา, badge, แสดงบนเว็บ; ปุ่ม "Preview หน้าราคา"; ปุ่ม "บันทึกเป็นเวอร์ชันใหม่" (dialog: วันมีผล, สรุป diff); ปุ่ม "ย้ายลูกค้าเดิม" (เลือกจากเวอร์ชัน → ไปเวอร์ชัน, วันมีผล, ข้อความแจ้งลูกค้า)
5. **กฎธุรกิจ** — PLT-060, PLT-061 · **PLT-108** preview ใช้ endpoint เดียวกับหน้าราคาจริงแต่อ่าน draft · **PLT-109** การย้ายลูกค้าที่ทำให้ราคาเพิ่มต้องแจ้งล่วงหน้า ≥ `planMigration.noticeDays`; ลดราคาย้ายทันทีได้
7. **Event** — `plan.version_published`, `plan.migration_scheduled`, `plan.migration_executed`
9. **เกณฑ์ตรวจรับ** — Given owner แก้ limit `custom_fields.per_entity` ของ Growth จาก 20 → 30 When บันทึก Then เกิดเวอร์ชันใหม่, หน้าราคา preview แสดง 30, ลูกค้าเดิมยัง 20
10. **เฟส** — P0 (Plan/Version/matrix) · ย้ายลูกค้าเดิมแบบตั้งเวลา P1

### 10.5 Add-on และคูปอง
- หน้าจอ: ตาราง add-on (ชื่อ, หน่วย, ราคา, แพ็กเกจที่ซื้อได้, จำนวน tenant ที่ใช้) และคูปอง (code, ประเภท `percent`/`amount`, ค่า, ใช้กับแพ็กเกจ, จำนวนรอบบิลที่มีผล, วันหมดอายุ, จำนวนครั้งสูงสุด, ใช้ไปแล้ว)
- **PLT-110** add-on ตัวอย่าง [PROPOSED]: รถเกินโควตา (ต่อคัน/เดือน), connector บัญชีเพิ่ม (ต่อตัว/เดือน), SMS/LINE แจ้งลูกค้าเกินโควตา, AI credit (ต่อ 1,000), พื้นที่ POD (ต่อ 10 GB), onboarding มีคนช่วย (ครั้งเดียว), archive ข้อมูลหลังยกเลิก
- **PLT-111** คูปอง 1 ใบต่อ subscription; ส่วนลดคำนวณก่อน VAT; คูปองหมดอายุไม่กระทบรอบที่ใช้ไปแล้ว; แก้ราคา add-on = มีผลกับการซื้อใหม่ (ของเดิมเก็บ priceSnapshot)
- สิทธิ์: สร้าง/แก้ owner; ให้คูปองกับลูกค้า sales (ส่วนลด ≤ 20% [PROPOSED]) เกินนั้นต้อง owner อนุมัติ
- Event: `coupon.applied`, `addon.price_changed` · เฟส: P1

### 10.6 การเงินแพลตฟอร์ม
1. **จุดประสงค์** — ออก/ติดตามเอกสารที่เราออกให้ลูกค้า และรับชำระ
2. **ผู้ใช้/สิทธิ์** — finance (แก้), owner (แก้), sales (ดู)
3. **หน้าจอ** — แท็บ: ใบแจ้งหนี้/ใบกำกับ (ตาราง + PDF, void พร้อมเหตุผล), การชำระ (ทุกช่องทาง + สถานะ provider), **คิวตรวจสลิป** (รูปสลิปซ้าย; ขวา ยอดสลิป vs ยอดใบแจ้งหนี้, บัญชีผู้รับ, วันเวลาโอน, transRef, ผลตรวจอัตโนมัติ 4 ข้อ; ปุ่ม ยืนยัน / ปฏิเสธ + เหตุผล / จับคู่กับใบอื่น), **ค้างชำระ (aging)** 0–7 / 8–21 / 22–60 / >60 วัน + ปุ่มส่งเตือน, กระทบยอด statement (นำเข้า CSV ธนาคาร → จับคู่อัตโนมัติด้วยยอด+เศษสตางค์)
5. **กฎธุรกิจ** — PLT-095–PLT-097 · **PLT-112** เลขที่ PlatformInvoice/ใบกำกับรันต่อเนื่องต่อปีภาษี ไม่ reuse แม้ void · **PLT-113** แก้ใบกำกับที่ออกแล้วไม่ได้ ต้องออกใบลดหนี้/เพิ่มหนี้ของแพลตฟอร์ม
6. **สถานะ** — `SlipVerification`: `auto_passed` | `review` → `confirmed` | `rejected` | `rematched`
7. **Event** — `platform_payment.confirmed`, `platform_payment.rejected`, `dunning.reminder_sent`
8. **กรณีผิดปกติ** — สลิปเดียวใช้ 2 ใบแจ้งหนี้ → transRef ซ้ำ → `review` พร้อมลิงก์ใบที่ใช้แล้ว; รูปอ่าน QR ไม่ออก → `review`
9. **เกณฑ์ตรวจรับ** — Given สลิปยอด 5,000.37 ใบแจ้งหนี้ 5,000.73 When ตรวจอัตโนมัติ Then `review` ไม่ปฏิเสธ และแสดงผลต่าง 0.36
10. **เฟส** — P0 (ใบกำกับ PDF, คิวสลิปด้วยคน, aging) · ตรวจสลิปอัตโนมัติ, กระทบยอด statement P1

### 10.7 การใช้งาน API และ AI ราย tenant
- หน้าจอ: ตารางทุก tenant — calls 30 วัน แยก REST/MCP, error rate 5xx/4xx, p95 latency, 429 ที่ถูกตัด, rate limit ปัจจุบัน, AI credit ใช้/โควตา, ต้นทุน AI (บาท) [finance/owner เท่านั้น], สวิตช์ "ปิด API" และ "ปิด AI"
- **PLT-115** ปิด API = เพิกถอนการใช้ key/MCP token ชั่วคราว (ตอบ 403 `api_disabled_by_platform`) ไม่ลบ key; ปิด AI = ทุกฟีเจอร์ AI ของ tenant ปิด (08); ทั้งสองต้องมีเหตุผล + แจ้งลูกค้า
- **PLT-116** ปรับ rate limit รายลูกค้า = override `api.rate_limit_per_min` (PLT-066)
- สิทธิ์: ปิด/เปิด owner, support · ปรับ limit owner · เฟส P1

### 10.8 ทีมงานและสิทธิ์ (PlatformUser)
- หน้าจอ: ตารางทีม (ชื่อ, อีเมล, role, 2FA, login ล่าสุด, สถานะ), เชิญ, ปิด
- **PLT-118** PlatformUser แยกตารางจาก User ของลูกค้า; บัญชีเดียวกันห้ามเป็นทั้งสองแบบด้วยอีเมลเดียวกัน [PROPOSED]
- ตาราง 11.4 กำหนดสิทธิ์ · เฟส P0

---

## 11. Impersonation, Audit log และสิทธิ์ทีมเรา

### 11.1–11.3 เข้าใช้งานแทน (Impersonation)
1. **จุดประสงค์** — ให้ทีม support เห็นสิ่งที่ลูกค้าเห็นเพื่อช่วยแก้ปัญหา โดยตรวจสอบย้อนหลังได้
2. **ผู้ใช้/สิทธิ์** — owner, support (sales/finance ไม่ได้)
3. **หน้าจอ** — ปุ่ม "เข้าใช้งานแทน" ในหน้าลูกค้า → dialog: เลือกผู้ใช้ของลูกค้าที่จะสวม (ค่าเริ่ม = สิทธิ์ admin แบบอ่านอย่างเดียว), โหมด `read_only` (ค่าเริ่ม) / `full`, เหตุผล ≥ 10 ตัว, เลข ticket (ไม่บังคับ) → เปิดแอปลูกค้าแท็บใหม่ พร้อม **แถบส้มติดบนสุดตลอดเวลา** "กำลังใช้งานแทน บจก. … ในนาม {ผู้ใช้} · เหลือ {mm} นาที · ออก"
4. **ฟิลด์** — `ImpersonationSession(id, platformUserId, tenantId, asUserId, mode, reason, ticketRef, startedAt, endedAt, endReason manual|timeout|revoked, ip, userAgent)`
5. **กฎธุรกิจ**
- **PLT-120** [DECISION] บังคับเหตุผล; ไม่มีเหตุผล = เริ่มไม่ได้
- **PLT-121** [PROPOSED] หมดอายุอัตโนมัติ `impersonation.maxMinutes` (60); ต่ออายุ = เริ่มใหม่พร้อมเหตุผล
- **PLT-122** [PROPOSED] ระหว่าง impersonate ห้ามเสมอ (แม้โหมด full): ดู/สร้าง/หมุน API key secret, เปลี่ยนรหัสผ่าน/2FA/อีเมลของผู้ใช้, เปลี่ยนแพ็กเกจ/วิธีชำระ, ออกใบกำกับภาษี, ลบข้อมูล, เพิกถอนการเชื่อมต่อ MCP; โหมด `full` ต้องให้ owner อนุมัติก่อน
- **PLT-123** ทุก request ระหว่าง session บันทึก audit ด้วย `actor = platformUser`, `onBehalfOf = asUserId`, `impersonationSessionId`; ข้อมูลที่สร้างแสดงผู้สร้างเป็น "{ผู้ใช้} (ทีมสนับสนุน: {ชื่อ})"
- **PLT-124** [PROPOSED] ลูกค้าเห็นรายการ impersonation sessions ใน ตั้งค่า → ความปลอดภัย (เวลา, ทีมงาน, เหตุผล) [OPEN: ต้องขอความยินยอมลูกค้าก่อนเข้าทุกครั้งหรือไม่ — ตั้งเป็นตัวเลือกของ tenant?]
- **PLT-125** ห้าม impersonate ผ่าน AI/MCP ใด ๆ
6. **สถานะ** — `active` → `ended` (manual / timeout / revoked โดย owner)
7. **Event** — `impersonation.started`, `impersonation.ended`
8. **กรณีผิดปกติ** — ปิดแท็บโดยไม่กดออก → session หมดตาม timeout; impersonate tenant ที่ suspended → เข้าได้โหมด read_only เท่านั้น
9. **เกณฑ์ตรวจรับ** — Given support impersonate โหมด read_only When กดสร้าง SO Then 403 `impersonation_read_only` และ audit บันทึกความพยายาม
10. **เฟส** — P0 (read_only) · โหมด full + การอนุมัติ P1

### 11.4 ตารางสิทธิ์ทีมเรา

| การกระทำ | owner | sales | support | finance |
|---|---|---|---|---|
| ดูลูกค้า/การใช้งาน | ✓ | ✓ | ✓ | ✓ |
| อนุมัติ/ปฏิเสธการสมัคร | ✓ | ✓ | ✓ | — |
| ขยาย trial | ✓ | ✓ | ✓ (≤ 14 วัน) | — |
| เปลี่ยนแพ็กเกจลูกค้า | ✓ | ✓ | — | — |
| ให้คูปอง/ส่วนลด | ✓ | ✓ (≤ 20%) | — | — |
| ตั้ง override | ✓ | ขอ (owner อนุมัติ) | ขอ (owner อนุมัติ) | — |
| ระงับ / ปลดระงับ | ✓ / ✓ | — | ขอ / — | — |
| ปิด API/AI, ปรับ rate limit | ✓ | — | ✓ (ปิด/เปิด) | — |
| เข้าใช้งานแทน | ✓ | — | ✓ | — |
| แก้แพ็กเกจ/ราคา/add-on/ค่าตั้งแพลตฟอร์ม | ✓ | — | — | — |
| ใบกำกับ/การชำระ/ตรวจสลิป/void | ✓ | ดู | — | ✓ |
| แก้ usage หลัง finalize | ✓ | — | — | ✓ |
| จัดการทีมงาน | ✓ | — | — | — |
| ดู audit log | ✓ | ของลูกค้าที่ดูแล | ✓ | ✓ |

### 11.5 Audit log
1. **จุดประสงค์** — บันทึกว่าใครทำอะไร กับลูกค้ารายไหน เมื่อไร เพราะอะไร
2. **ผู้ใช้/สิทธิ์** — Console ตาม §11.4; ลูกค้าเห็น audit ของ tenant ตัวเองใน ตั้งค่า → ความปลอดภัย (`audit.view`)
3. **หน้าจอ** — ตาราง: เวลา, ผู้กระทำ (ประเภท + ชื่อ), การกระทำ, tenant, object (ลิงก์), เหตุผล, IP, impersonation session; ตัวกรอง; drawer แสดง before/after (diff); export CSV
4. **ฟิลด์** — `AuditLog(id, at, actorType user|platform_user|api_key|mcp_connection|system, actorId, onBehalfOf, tenantId, action, objectType, objectId, before json, after json, reason, ip, userAgent, requestId, impersonationSessionId)`
5. **กฎธุรกิจ** — **PLT-126** append-only (ไม่มี API แก้/ลบ; DB role ของแอปไม่มีสิทธิ์ UPDATE/DELETE ตารางนี้) · **PLT-127** ข้อมูลอ่อนไหว (รหัสผ่าน, secret, token, เลขบัตร) ไม่เก็บใน before/after · **PLT-128** เก็บ 2 ปี [PROPOSED] แล้ว archive
7. **Event** — เป็นปลายทางของ event ทั้งหมด
9. **เกณฑ์ตรวจรับ** — Given sales เปลี่ยนแพ็กเกจลูกค้า When เปิด audit Then เห็นแถวพร้อมเหตุผล และ diff planVersion
10. **เฟส** — P0

---

## 12. ผู้ใช้, Role และตารางสิทธิ์ (ฝั่งลูกค้า)

1. **จุดประสงค์** — กำหนดว่าผู้ใช้แต่ละคนทำอะไรได้ในบริษัท
2. **ผู้ใช้/สิทธิ์** — `users.manage`, `roles.manage` (owner/admin)
3. **หน้าจอ** — ตั้งค่า → ผู้ใช้: ตาราง (ชื่อ, อีเมล/เบอร์, role, สาขา, สถานะ, 2FA, login ล่าสุด), เชิญ (อีเมลหลายรายการ + role), ปิด/เปิด, เปลี่ยน role, โอน owner · ตั้งค่า → บทบาทและสิทธิ์: รายการ role (ระบบ + กำหนดเอง), ตารางสิทธิ์ **โมดูล × การกระทำ** (ดู / สร้าง / แก้ / ลบ / อนุมัติ / export) แบบ checkbox, ปุ่ม "คัดลอกเป็น role ใหม่"
4. **ฟิลด์** — `Role(id, tenantId|null=system, code, nameI18n, isSystem)`, `RolePermission(roleId, module, action, constraint json)` (เช่น วงเงินอนุมัติ ≤ 50,000)

**ตารางสิทธิ์ค่าเริ่มต้น** (D=ดู C=สร้าง E=แก้ X=ลบ A=อนุมัติ O=export · — ไม่มี)

| โมดูล | owner/admin | manager | dispatcher | accounting | fleet | approver | developer | viewer |
|---|---|---|---|---|---|---|---|---|
| ข้อมูลหลัก (ลูกค้า สถานที่ สินค้า rate card) | DCEXO | DCEO | D | D | D (ผู้ขาย/อู่ DCE) | D | D | D |
| SO / DO / เที่ยว / กระดานวางแผน | DCEXAO | DCEXAO | DCEO | DO | D | DA | D | D |
| จ่ายงานรถร่วม | DCEXAO | DCEAO | DCE | D | — | D | — | D |
| Override กฎห้ามจ่ายงาน | A | A | — | — | — | — | — | — |
| ติดตาม / POD / ข้อยกเว้น | DCEO | DCEO | DCEO | D | D | D | D | D |
| วางบิล / ใบกำกับ / รับชำระ / ใบลด-เพิ่มหนี้ | DCEXAO | DAO | D | DCEAO | — | DA | — | D |
| Settlement รถร่วม / เงินเบิก | DCEXAO | DAO | DC (เงินเบิก) | DCEAO | — | DA | — | D |
| Fleet (รถ เอกสาร ซ่อม ยาง อะไหล่ น้ำมัน) | DCEXAO | DCEAO | D | D | DCEXO | DA | — | D |
| รายงาน | DO | DO | D (ปฏิบัติการ) | D (บัญชี) O | D (fleet) | D | — | D |
| ตั้งค่าบริษัท / เลขเอกสาร / ภาษี / แจ้งเตือน | DE | D | — | D (ภาษี DE) | — | — | — | — |
| ผู้ใช้และสิทธิ์ | DCEX | D | — | — | — | — | — | — |
| แพ็กเกจและการเรียกเก็บเงิน | DE | — | — | D | — | — | — | — |
| การเชื่อมต่อ / Open API / Webhook / Mapping / MCP | DCEX | D | — | D (connector) | — | — | DCEX | — |
| ฟิลด์เพิ่มเติม | DCEX | D | — | — | — | — | DCEX | — |
| ตั้งค่า AI / ประวัติ AI | DE | D | — | — | — | — | D | — |
| Audit log | D | D | — | — | — | — | — | — |

5. **กฎธุรกิจ**
- **PLT-130** ผู้ใช้มีได้หลาย role ต่อ tenant; สิทธิ์ = union ของ role
- **PLT-131** role ระบบ (ตารางข้างบน) แก้ไม่ได้ ลบไม่ได้; role กำหนดเองสร้างจากการคัดลอก — ใช้ได้เมื่อมี `org.custom_roles` [PROPOSED: Growth ขึ้นไป] — ไม่มีก็ยังมอบ role ระบบได้ครบ
- **PLT-132** สิทธิ์ตรวจทั้ง UI (ซ่อน/disable ปุ่ม) และ API (403 `permission_denied` + `module`, `action`); UI ห้ามเป็นด่านเดียว
- **PLT-133** constraint วงเงิน: approver อนุมัติได้เฉพาะเอกสารที่ยอด ≤ วงเงินของ role (ใบสั่งซ่อม — 06; ใบลดหนี้ — 05)
- **PLT-134** สิทธิ์ระดับ field (ซ่อนราคาขาย/ต้นทุนจาก dispatcher) [PROPOSED P1; feature `org.field_permissions`]
- **PLT-135** คนขับและรถร่วมไม่ใช่ role ในตารางนี้: คนขับใช้ `DriverAccount` (04) รถร่วมใช้ลิงก์/LINE (04)
- **PLT-136** การเปลี่ยน role มีผลใน request ถัดไป (ล้าง permission cache ของผู้ใช้นั้น) — ไม่ต้อง login ใหม่
6. **สถานะ** — Role: `active` / `archived` (role กำหนดเองที่ไม่มีผู้ใช้แล้วลบได้ = archive)
7. **Event** — `role.created`, `role.permissions_changed`, `user.role_changed` (audit)
8. **กรณีผิดปกติ** — ลบ role ที่ยังมีผู้ใช้ → บังคับย้ายผู้ใช้ไป role อื่นก่อน; admin ลดสิทธิ์ตัวเองจนไม่มี `users.manage` → เตือนก่อนยืนยัน
9. **เกณฑ์ตรวจรับ** — Given dispatcher When เรียก `POST /v1/invoices/{id}/finalize` ผ่าน UI token Then 403 `permission_denied`
10. **เฟส** — P0 (role ระบบ + ตาราง) · role กำหนดเอง, field-level, branchScope P1

---

## 13. ตั้งค่าองค์กร

ทุกหน้าใน ตั้งค่า ใช้สิทธิ์ตามตาราง §12; ทุกการบันทึกเขียน audit

### 13.1 ข้อมูลบริษัท
- ฟิลด์: ชื่อนิติบุคคล TH/EN (แก้หลังอนุมัติ = ต้องผ่าน Console [PROPOSED]), ชื่อทางการค้า, เลขผู้เสียภาษี (ล็อก), ที่อยู่สำนักงานใหญ่ (แยกฟิลด์), โทร, อีเมล, เว็บไซต์, โลโก้ (PNG/SVG ≤ 2 MB ใช้บน A4/หน้าติดตาม), ภาษาเริ่มต้น, เขตเวลา (ค่าเริ่ม Asia/Bangkok), รูปแบบปี (พ.ศ./ค.ศ. ตามภาษา — 00 §6)
- **PLT-140** ชื่อ/ที่อยู่/เลขผู้เสียภาษีบนเอกสารภาษีที่ออกแล้วใช้ snapshot ณ วันออก — การแก้ข้อมูลบริษัทไม่เปลี่ยนเอกสารเก่า
- เฟส P0

### 13.2 สาขาและนิติบุคคล
- ฟิลด์ `Branch`: branchCode (5 หลัก, unique ต่อ legal entity), ชื่อ, ที่อยู่, ผู้ติดต่อ, เป็นสำนักงานใหญ่ไหม, สถานะ ใช้งาน/ปิด; `LegalEntity` (หลายนิติบุคคล — feature `org.legal_entities`): taxId ของตัวเอง, สาขา, ชุดเลขเอกสารและตั้งค่าภาษีแยก
- **PLT-141** ทุก tenant มีอย่างน้อย 1 LegalEntity + 1 Branch (`00000` หรือสาขาที่สมัคร); เอกสารภาษีอ้าง branch ผู้ออกเสมอ
- **PLT-142** ปิดสาขาที่มีเอกสารแล้วได้ (ไม่ลบ); จำนวนสาขา/นิติบุคคลตามโควตา (PLT-079)
- เฟส: สาขา P0 · หลายนิติบุคคล P1 [OPEN: นิติบุคคลเพิ่ม = tenant เดียวหรือหลาย tenant ภายใต้ "กลุ่มบริษัท"]

### 13.3 เลขที่เอกสาร → ดู 05-billing (§เลขที่เอกสาร)
- หน้า ตั้งค่า → เลขที่เอกสาร อยู่ในกลุ่มตั้งค่าองค์กร แต่กฎทั้งหมด (prefix, รอบรีเซ็ต, ต่อสาขา, ใครออกเลขเมื่อมี connector) กำหนดใน 05 และ 07 (INT connector "ผู้ออกเลขเอกสาร")

### 13.4 ตั้งค่าภาษี → ดู 05-billing (§VAT, §หัก ณ ที่จ่าย)
- จดทะเบียน VAT ไหม, วันที่จด, อัตรา VAT, การแยกค่าขนส่ง (ยกเว้น) / บริการประกอบ (7%), อัตราหัก ณ ที่จ่ายค่าเริ่มต้น — รายละเอียดใน 05

### 13.5 การแจ้งเตือน
1. **จุดประสงค์** — เลือกว่าใครได้รับแจ้งเรื่องใด ทางช่องทางใด
2. **ผู้ใช้/สิทธิ์** — ผู้ดูแลระบบตั้งค่าบริษัท; ผู้ใช้แต่ละคนปิดช่องทางของตัวเองได้ (ยกเว้นเรื่องบังคับ)
3. **หน้าจอ** — แท็บ "ภายในทีม": ตาราง event × ผู้รับ (role/ผู้ใช้) × ช่องทาง (ในแอป / อีเมล / LINE / SMS) · แท็บ "แจ้งลูกค้า" (ลูกค้าปลายทาง — สเปกใน 04) · แท็บ "ช่องทาง": เชื่อม LINE OA ของบริษัท, อีเมลผู้ส่ง (ชื่อแสดง/reply-to), ผู้ส่ง SMS
4. **ฟิลด์** — `NotificationRule(tenantId, eventKey, recipients{roles[], userIds[]}, channels[], quietHours?)`
5. **กฎธุรกิจ** — **PLT-145** event ขั้นต่ำ: เอกสารรถใกล้หมด (60/30/7 วัน — 06), ข้อยกเว้นใหม่ (04), POD ไม่ผ่าน, ใบแจ้งหนี้เกินกำหนด, connector/webhook ล้มเหลว (07), API key ใกล้หมดอายุ/IP ใหม่ (07), AI credit ใกล้หมด (08), สถานะบัญชี/การชำระ (บังคับส่ง owner + billing ปิดไม่ได้), quota 80/90/100% · **PLT-146** SMS/LINE ที่ส่งหาลูกค้าปลายทางนับโควตา `notifications.*`; แจ้งภายในทีมไม่นับ [PROPOSED]
10. **เฟส** — ในแอป + อีเมล P0 · LINE/SMS P1

### 13.6 ความปลอดภัย
1. **จุดประสงค์** — ควบคุมการเข้าถึงบัญชีของบริษัท
2. **ผู้ใช้/สิทธิ์** — owner/admin
3. **หน้าจอ** — 2FA (สถานะต่อผู้ใช้ + นโยบายบังคับ), session ที่ใช้งานอยู่ (อุปกรณ์, IP, เมือง, ล่าสุด, ปุ่มออกจากระบบ / ออกทุกอุปกรณ์), IP allowlist สำหรับเข้าเว็บ, นโยบายรหัสผ่าน/หมดเวลา session, ประวัติ impersonation (PLT-124), audit log (§11.5)
4. **ฟิลด์ / กฎ**

| การตั้งค่า | ค่า | ค่าเริ่ม | หมายเหตุ |
|---|---|---|---|
| 2FA | TOTP (แอป authenticator) + recovery codes 10 ชุด | ไม่บังคับ | |
| บังคับ 2FA สำหรับ role | เลือก role | owner, admin, accounting [PROPOSED] | ผู้ใช้ที่ยังไม่ตั้งถูกพาไปตั้งตอน login |
| หมดเวลาไม่ใช้งาน | 15 นาที – 7 วัน | 12 ชม. | |
| อายุ refresh token | 1–30 วัน | 30 วัน | |
| IP allowlist (เว็บ) | รายการ CIDR | ปิด | ไม่ใช้กับแอปคนขับ/หน้ารถร่วม/หน้าติดตาม; API key มี allowlist ของตัวเอง (07) |
| SSO (SAML/OIDC) | | — | feature `org.sso` P2 |

5. **กฎธุรกิจ** — **PLT-150** เปิด IP allowlist ต้องมี IP ปัจจุบันของผู้ตั้งอยู่ในรายการ (กันล็อกตัวเอง) · **PLT-151** reset 2FA ของผู้ใช้อื่นได้เฉพาะ owner + เหตุผล; ทีมเรา reset ได้ผ่าน Console หลังยืนยันตัวตน owner [PROPOSED] · **PLT-152** ออกจากระบบทุกอุปกรณ์ = เพิกถอน refresh token ทั้งหมดของผู้ใช้ใน tenant นั้น
7. **Event** — `security.2fa_enabled/disabled`, `security.session_revoked`, `security.ip_blocked`
8. **กรณีผิดปกติ** — ผู้ใช้ทำโทรศัพท์หาย → ใช้ recovery code หรือให้ owner reset; IP เปลี่ยนกลางวัน (เน็ตมือถือ) → แนะนำไม่เปิด allowlist สำหรับ role ภาคสนาม
9. **เกณฑ์ตรวจรับ** — Given บังคับ 2FA สำหรับ accounting When ผู้ใช้ accounting login Then ต้องตั้ง TOTP ก่อนเข้าหน้าใด
10. **เฟส** — 2FA, sessions P0 · IP allowlist P1 · SSO P2

---

## 14. Event ของโมดูลนี้ (สรุป)

ทั้งหมดเป็น event ภายใน/audit — **ไม่** อยู่ในรายการ webhook สาธารณะของลูกค้า (07) ยกเว้นที่ระบุ

| กลุ่ม | Event |
|---|---|
| Tenant | `tenant.created`, `tenant.status_changed`, `tenant.trial_ending`, `tenant.cancel_requested`, `tenant.data_export_ready`, `tenant.purged` |
| Signup | `signup.started`, `signup.otp_verified`, `signup.company_lookup`, `signup.completed`, `signup.join_requested`, `verification.approved/rejected/info_requested` |
| Subscription | `subscription.plan_changed`, `subscription.addon_added/removed`, `subscription.cancel_requested`, `subscription.renewed`, `entitlement.override_set/expired`, `usage.threshold_reached`, `usage.period_finalized` |
| Billing | `platform_invoice.issued/paid`, `platform_payment.failed/slip_review/confirmed/rejected`, `dunning.reminder_sent` |
| ผู้ใช้/ความปลอดภัย | `user.invited/joined/disabled/role_changed`, `role.*`, `auth.*`, `security.*`, `impersonation.started/ended` |
| Plan | `plan.version_published`, `plan.migration_scheduled/executed` |

## 15. รายการ [OPEN] ของไฟล์นี้

| # | คำถาม | อ้างอิง |
|---|---|---|
| O-PLT-1 | จำนวน tier (3 ตามต้นแบบ หรือ 4 ตาม decisions) และราคา/ขั้นต่ำสุดท้าย | PLT-063 |
| O-PLT-2 | โควตาพื้นที่ POD ต่อแพ็กเกจ (20/100 GB หรือ 5/25/100 GB) | PLT-064 |
| O-PLT-3 | รถร่วมคิดเต็มราคาหรือครึ่ง และใครเป็นผู้จ่าย | PLT-073 |
| O-PLT-4 | `vehicles.active` เป็น soft limit (คิดส่วนเกิน) หรือ hard limit | PLT-080 |
| O-PLT-5 | คิดเงินรายเดือนล่วงหน้าหรือย้อนหลังตามการใช้ | PLT-090 |
| O-PLT-6 | จุดออกใบกำกับภาษีค่าบริการของเรา (เมื่อรับชำระ) — ยืนยันกับนักบัญชี | PLT-096 |
| O-PLT-7 | ลูกค้าหักภาษี ณ ที่จ่ายค่าบริการซอฟต์แวร์ของเราหรือไม่ อัตราใด | PLT-097 |
| O-PLT-8 | ฐานกฎหมาย PDPA และ flow สำหรับผู้สมัครบุคคลธรรมดา | PLT-022 |
| O-PLT-9 | ต้องขอความยินยอมลูกค้าก่อน impersonate ทุกครั้งหรือไม่ | PLT-124 |
| O-PLT-10 | หลายนิติบุคคล = tenant เดียวหรือกลุ่ม tenant | §13.2 |
| O-PLT-11 | `subcon.dispatch_link` / `subcon.settlement_review` เป็นฟีเจอร์พื้นฐานหรือล็อกตามแพ็กเกจ (ต้นแบบวางไว้มาตรฐาน; decisions ระบุจ่ายรถร่วม+50 ทวิ ต้องมีทุกแพ็กเกจ) | §6 catalog |
| O-PLT-12 | การเก็บเอกสาร VAT ของเราบน cloud ต้องแจ้งกรมสรรพากรหรือไม่ (ท.ป.116/2545) | PLT-017 |
