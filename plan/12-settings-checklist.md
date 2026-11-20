# ST9-T12 Checklist ค่าตั้งองค์กร (K5) + ภาษา + PDF

ที่มา: docs/04 I "ตั้งค่าองค์กร" (P0), K5 "ทุก setting ตั้งได้จาก UI", K10, spec/01 §13 · ตรวจเมื่อ 19 พ.ย. 2569 (branch `st9/t12-completeness`)
ตรวจอัตโนมัติ: `apps/api/test/settings-checklist.test.ts` — key ใหม่ใน `apps/api/src/modules/settings/registry.ts` ที่ไม่อยู่ในตาราง §1 = test แดง; สถานะ `UI` ต้องมีโค้ดใน `apps/web/src` ที่ใช้ key นั้น

**FACT / ข้อเสนอ:** ตาราง §1–§2 เป็น FACT จากโค้ด ณ วันที่ตรวจ · คอลัมน์ "ต่อไป" เป็นข้อเสนอ

สถานะ: `UI` = ตั้งได้จากหน้าจอ · `API-only` = ตั้งได้ผ่าน `PATCH /v1/settings` เท่านั้น เพราะ**ต้นแบบไม่มีช่อง** (ห้ามออกแบบเอง — CLAUDE.md; รอ Claude Design ตาม spec/12 §3) · `ไม่มี` = ยังไม่มีทั้ง API และ UI

## 1. ค่าใน registry `tenant_setting` (`GET/PATCH /v1/settings`)

| # | ค่าตั้ง (docs/04 I) | key | หน้าจอ (ตั้งค่า → …) | สถานะ | หมายเหตุ / spec/12 §3 |
|---|---|---|---|---|---|
| 1 | ชื่อองค์กร | `org.name` | องค์กร → ชื่อองค์กร | UI | เก็บที่ `tenant.name` |
| 2 | timezone | `org.timezone` | องค์กร → Timezone | UI | ค่าเดียว Asia/Bangkok (ค่าเริ่มต้นไทย) |
| 3 | พ.ศ./ค.ศ. | `org.yearStyle` | องค์กร → รูปแบบปีในเอกสาร | UI | ค่าเริ่ม พ.ศ. (D-30) |
| 4 | VAT default | `tax.vatDefault` | ภาษี → VAT ค่าเริ่มต้น | UI | กฎภาษีไม่เปลี่ยน — ตรวจแค่ว่าตั้งได้ |
| 5 | โหมด tax point | `tax.invoiceModePolicy` | ภาษี → โหมดออกใบกำกับภาษี | UI | |
| 6 | WHT default (1%) | `tax.wht1Enabled` | ภาษี → หัก ณ ที่จ่าย 1% | UI | |
| 7 | WHT default (3%) | `tax.wht3Enabled` | ภาษี → หัก ณ ที่จ่าย 3% | UI | |
| 8 | แยก/รวมเอกสาร VAT | `tax.separateVatDocs` | — | API-only | แถว "ตั้งค่า: รอบวางบิลเริ่มต้น, free time ค่ารอ, แยก/รวมเอกสาร VAT" [OPEN] |
| 9 | รอบวางบิล (ค่าเริ่มต้นลูกค้าใหม่) | `billing.cycleDefault` | — (ต่อรายลูกค้าตั้งได้ที่ ข้อมูลหลัก → ลูกค้า → รอบวางบิล) | API-only | แถวเดียวกับ #8 |
| 10 | free time ค่ารอ (ค่าเริ่มต้น) | `billing.freeTimeMinutes` | — (ต่อรายลูกค้าตั้งได้ที่ drawer ลูกค้า → free time) | API-only | แถวเดียวกับ #8 |
| 11 | ออกบิลในนาม (ค่าเริ่มต้น) | `routing.invoiceAsCompanyId` | — | API-only | แถว "ออกบิลในนาม / จ้างในนาม" [OPEN]; tenant นิติบุคคลเดียวไม่ต้องตั้ง |
| 12 | จ้างในนาม (ค่าเริ่มต้น) | `routing.tenderAsCompanyId` | — | API-only | แถวเดียวกับ #11 |
| 13 | รถร่วมไม่ตอบภายใน N ชม. | `dispatch.subconResponseHours` | — | API-only | แถว "หมดเวลาข้อเสนองาน" (ST3-T24) |
| 14 | นัดส่งใหม่อัตโนมัติสูงสุด | `dispatch.maxAutoReschedules` | — | API-only | แถว "นัดส่งใหม่อัตโนมัติ" (ST4-T12) |
| 15 | POD checklist default | `pod.checklist` | POD checklist (หัวข้อเพิ่ม — [DECISION] ST4-T05) | UI | ลูกค้า override ที่ drawer ลูกค้า |
| 16 | เบอร์บริษัทบนหน้าติดตาม | `tracking.contactPhone` | — | API-only | แถว ST9-T12 ใหม่ |
| 17 | แสดง POD บนหน้าติดตาม | `tracking.showPod` | — | API-only | แถว ST9-T12 ใหม่ |
| 18 | อายุลิงก์ติดตาม (วัน) | `tracking.linkDays` | — | API-only | แถว ST9-T12 ใหม่ |
| 19 | บังคับ 2FA ทุกคน | `security.require2faAll` | ความปลอดภัย → บังคับ 2FA สำหรับผู้ใช้ทุกคน | UI | ลดความปลอดภัย = step-up |
| 20 | ออกจากระบบอัตโนมัติ | `security.autoLogout` | ความปลอดภัย → ออกจากระบบอัตโนมัติ… | UI | |
| 21 | Session timeout | `security.idleTimeoutMinutes` | ความปลอดภัย → Session timeout | UI | 30 นาที / 1 ชม. / 8 ชม. |
| 22 | ระยะเก็บ audit log (ปี) | `retention.auditLogYears` | — | API-only | ST9-T14 — ต้นแบบไม่มีช่อง; ลดค่า = step-up · ขั้นต่ำ 5 ปี |
| 23 | ระยะเก็บ integration log (เดือน) | `retention.integrationLogMonths` | — | API-only | ST9-T14 — ต้นแบบไม่มีช่อง; ลดค่า = step-up · ขั้นต่ำ 24 เดือน · job ยังไม่ลบ (archive = [OPEN — PO] ST7-T22) |
| 24 | ระยะเก็บประวัติ login (เดือน) | `retention.loginLogMonths` | — | API-only | ST9-T14 — ต้นแบบไม่มีช่อง; ลดค่า = step-up · ขั้นต่ำ 12 เดือน |
| 25 | ระยะเก็บไฟล์ POD (ปี) | `retention.podFileYears` | — | API-only | ST9-T14 — ต้นแบบไม่มีช่อง; ลดค่า = step-up · ขั้นต่ำ 2 ปี · job ยังไม่ลบ ([OPEN — PO/นักบัญชี] ม.87/3) |
| 26 | ระยะเก็บ GPS log (วัน) | `retention.gpsLogDays` | — | API-only | ST9-T14 — ต้นแบบไม่มีช่อง; ลดค่า = step-up · ขั้นต่ำ 90 วัน |
| 27 | วงเงิน step-up อนุมัติใบสำคัญจ่ายรถร่วม (บาท) | `settlement.approvalStepUpAmount` | — | API-only | ST6-T07 — ต้นแบบไม่มีช่อง; ค่าเริ่ม 100,000 · null = ไม่บังคับ · เพิ่มค่า/ปิด = step-up |
| 28 | ต้องให้รถร่วมตรวจใบสำคัญจ่ายก่อนอนุมัติ | `settlement.carrierReviewRequired` | — | API-only | ST6-T05 — ต้นแบบไม่มีช่อง; ค่าเริ่ม ปิด · เปิด = ร่างอนุมัติตรงไม่ได้ (409 `settlement_review_required`) · ปิดจากที่เปิด = step-up |
| 29 | ส่วนต่างที่บัญชีตัดยอดเองได้ต่อการรับชำระ (บาท) | `payments.maxDifferenceAmount` | — | API-only | ST5-T13 review M1 (spec/05 BIL-059) — ต้นแบบไม่มีช่อง; ค่าเริ่ม 10 · เกินต้องมี `payments:reverse` (ผู้จัดการ) · เพิ่มค่า = step-up |
| 30 | ขั้นต่ำหัก ณ ที่จ่าย (บาท — ยอดประมาณการ) | `tax.whtMinimumAmount` | — | API-only | ST5-T02 (D-54) — ต้นแบบไม่มีช่อง; ค่าเริ่ม 0 · รอนักบัญชี (docs/01 §8.2 ข้อ 7) — เพิ่มแถวใน ST5-T13 (test checklist แดงจาก T02) |
| 31 | ให้ผู้สร้างร่างออกเอกสารใบแจ้งหนี้เองได้ | `billing.allowSelfFinalize` | — | API-only | ST5-T09 (A3) — ต้นแบบไม่มีช่อง; ค่าเริ่ม ปิด · แก้ได้เฉพาะ owner + step-up — เพิ่มแถวใน ST5-T13 |

## 2. ค่าตั้งองค์กรที่เป็น resource แยก (ไม่อยู่ใน registry)

| ค่าตั้ง (docs/04 I / spec/01 §13) | API | หน้าจอ | สถานะ |
|---|---|---|---|
| นิติบุคคล / สาขา (เลขผู้เสียภาษี ที่อยู่ สาขาออกใบกำกับเอง) | `/v1/companies`, `/v1/branches` | นิติบุคคลและสาขา | UI |
| prefix + รอบรีเซ็ตเลขเอกสาร | `/v1/document-sequences` | เลขที่เอกสาร | UI (กฎเลขเอกสารไม่เปลี่ยน) |
| ผู้ใช้ / บทบาท / เชิญ | `/v1/users`, `/v1/roles`, `/v1/users/invitations` | ผู้ใช้และสิทธิ์ | UI |
| เหตุผล (reason codes) | `/v1/reason-codes` | เหตุผล | UI |
| การแจ้งเตือน (ของผู้ใช้เอง) | `/v1/me/notification-preferences` | การแจ้งเตือน | UI |
| **โลโก้** (spec/01 §13.1 PNG/SVG ≤ 2 MB บน A4/หน้าติดตาม) | ไม่มี | องค์กร → ปุ่ม "เปลี่ยนโลโก้" (ต้นแบบมี, ตอนนี้กดไม่ได้) | ไม่มี — ต้องทำ API (ไฟล์ ST1-T08 มีแล้ว) + ใช้บน PDF → เสนอเป็นผู้สมัครเพิ่ม (PLAN ภาคผนวก) |
| IP allowlist | — | ต้นแบบมี | P1 (spec/01 §13.6) — ไม่ทำในเฟส 0 |
| ภาษาเริ่มต้นขององค์กร | — | — | D-11: เฟส 0 ไทยอย่างเดียว — ไม่ต้องมี |
| Setup checklist (K5: องค์กร → สาขา → เลขเอกสาร → ภาษี → import → เชิญทีม → connector, % บนหน้าแรก) | `/v1/setup` (ST1-T21) | หน้าแรก → setup checklist | มี |
| จด VAT ไหม (spec/01 §13.4) | `company.vatRegistered` | นิติบุคคลและสาขา (สวิตช์ "ใช้ออกใบกำกับ") | มี |
| วันที่จด VAT (spec/01 §13.4) | ไม่มีฟิลด์ | — | ไม่มี — ต้นแบบไม่มีช่อง (กฎภาษีไม่แตะ; spec/12 §3 แถว ST9-T12) |
| ชื่อทางการค้า / โทร / อีเมล / เว็บไซต์ (spec/01 §13.1) | ไม่มีฟิลด์ใน `company` | — | ไม่มี — ต้นแบบไม่มีช่อง (spec/12 §3 แถว ST9-T12) |
| บังคับ 2FA **ราย role** (spec/01 §13.6 "เลือก role") | บังคับคงที่ owner/admin/accounting + `security.require2faAll` | ความปลอดภัย (มีแค่ "บังคับทุกคน") | ไม่มี — docs/spec ขัดกับต้นแบบ → spec/12 §3 แถว ST9-T12 |
| อายุ refresh token 1–30 วัน (spec/01 §13.6 ค่าเริ่ม 30 วัน) | ไม่มีค่าตั้ง — คงที่ 7 วัน (`REFRESH_TTL_MS`, `apps/api/src/auth/auth.service.ts`) | — | ไม่มี — docs/spec ขัดกับต้นแบบ → spec/12 §3 แถว ST9-T12 |
| รายการ session ที่ใช้งาน + ออกจากระบบทุกอุปกรณ์ (spec/01 §13.6, P0) | ไม่มี API รายการ session | — | ไม่มี — ต้นแบบไม่มีหน้า (spec/12 §3 แถว ST9-T12) |
| กฎผู้รับแจ้งเตือนระดับบริษัท `NotificationRule` (spec/01 §13.5) | — (ผู้รับตามสิทธิ์ role; ผู้ใช้ตั้งของตัวเองได้) | — | ผู้สมัครเพิ่ม #29 |

**สรุป:** 26 key ใน registry → UI 11 / API-only 15 (ทุกตัวไม่มีช่องในต้นแบบ — รวม retention.* 5 key ของ ST9-T14) · resource แยก 5/5 มี UI + setup checklist + จด VAT · ขาด: โลโก้ (#31), วันที่จด VAT, ชื่อทางการค้า/ติดต่อ, 2FA ราย role, อายุ refresh token, รายการ session, NotificationRule (#29) · ค่าเริ่มต้นไทยพร้อมใช้ (K5): ทุก key มี default (Asia/Bangkok, พ.ศ., VAT 7%, WHT เปิด, รอบรายเดือน ฯลฯ) จึงใช้งานได้โดยไม่ต้องให้ Innovera ตั้ง — ค่าที่เป็น API-only ปรับได้ผ่าน Open API ระหว่างรอดีไซน์

## 3. ภาษา (D-11 ทับ "TH/EN ครบ" ของ backlog)

- backlog ST9-T12 เขียน "ข้อความ TH/EN ครบทุกหน้า" แต่ D-11 (plan/05, ตัดสิน 10 พ.ย. 2569) = **ไทย + โครง i18n; EN/中文 เติมภายหลัง** → ยึด D-11: ตรวจว่า**ไทยครบ** และ EN **ตกกลับเป็นไทย** (ไม่แสดงชื่อ key)
- ตรวจอัตโนมัติ: `apps/web/scripts/lint-i18n.mjs` (`pnpm lint`) + `apps/web/src/i18n/completeness.test.tsx` (`pnpm test`)
  - key ใน `t('…')` / `'…' as MessageKey` / template `` `pre.${x}` `` / `enumLabel(t,'pre.')` ต้องมีใน `th.ts` · ห้ามข้อความไทย hard-code
  - error code ทุกตัวของ API (`apps/api/src/common/problem.ts`) ต้องมี `problem.<code>` — **พบขาด 27 ตัว แก้แล้ว** (ข้อความ = `PROBLEMS[code].th`)
  - ค่า enum ใน OpenAPI ที่หน้าจอแสดงเป็นป้าย (สถานะ SO/DO/เที่ยว, รอบวางบิล, ประเภทรถ ฯลฯ 20 ชุด) มีป้ายไทยครบ
  - EN: ทุก key เมื่อเลือก EN ได้ข้อความจริง (EN 1,100 / 4,046 key, ที่เหลือแสดงไทย)

## 4. PDF ทุกชนิดเป็นไทย

- ชนิดที่ระบบออกในตอนนี้: ใบคุมรถ / ใบงานประจำวัน (ST3-T20) — เอกสารภาษี (ใบแจ้งหนี้/ใบกำกับ/50 ทวิ) ยังไม่ถึง (ST5–ST6)
- `apps/api/test/pdf-thai.test.ts`: ข้อความไทยทุกบรรทัดใช้ Sarabun ที่ฝังมา, ใน PDF มีแต่ฟอนต์ Sarabun และ ToUnicode ของอักษรไทย (ค้น/คัดลอกได้), ทั้ง พ.ศ./ค.ศ. · โมดูลใหม่ที่เรียก `PdfRenderer.pdf` ต้องเพิ่มชนิดใน `KINDS` (test บังคับ)
- ข้อควรระวังที่พบ: อักขระนอกชุด Sarabun (เช่น `→`) ตกไปฟอนต์เครื่อง → template ต้องเลี่ยง (เอกสารตัวอย่าง engine `sample-template.ts` มี `→` อยู่ — ไม่ใช่เอกสารลูกค้า, golden เดิมไม่แก้)
