# ST9-T20 รายงานตรวจ Accessibility + เบราว์เซอร์ (WCAG 2.1 AA)

> วันที่ตรวจ 19 พ.ย. 2569 · branch `st9/t20-accessibility` · เกณฑ์ตรวจรับ (plan/01 ST9-T20): รายงานหน้าหลัก 10 หน้า; defect ระดับสูงปิดแล้ว
> E2E ที่กันถอยหลัง: `apps/web/e2e/a11y.spec.ts` (CI ปกติ: chromium 1440) · เมทริกซ์เบราว์เซอร์: `pnpm --filter @tms/web e2e:a11y` (`playwright.a11y.config.ts`)

## 1. วิธีตรวจ

| ส่วน | วิธี |
|---|---|
| ตรวจอัตโนมัติ | axe-core 4.10 (`@axe-core/playwright`) แท็ก `wcag2a wcag2aa wcag21a wcag21aa` บนหน้าที่มีข้อมูลจริง (สร้างผ่าน `/v1` ใน spec: ลูกค้า, สถานที่ 2 แห่ง, รถ, คนขับ, SO 3 ใบ — 1 ใบมีเที่ยว, 1 ใบรอจัด, 1 ใบค้างจับคู่ลูกค้า) รวม drawer/dialog ที่เปิดจากหน้านั้น |
| คีย์บอร์ด | เดิน Tab 70 ครั้งต่อหน้า บันทึก element ที่ได้ focus + มีกรอบ focus หรือไม่ · Enter/Space/Esc บนแถวตาราง, drawer, ฟอร์ม, เมนู · กระดานวางแผน: ทำงานหลักโดยไม่ใช้เมาส์ |
| Contrast | คำนวณอัตราส่วนจาก design tokens จริง (`packages/ui/src/tokens.ts`, `ui.css`, สี inline ใน TSX) เทียบเกณฑ์ 1.4.3 (ข้อความ 4.5:1) และ 1.4.11 (ขอบ control / focus 3:1) + ผล color-contrast ของ axe |
| เบราว์เซอร์ | Playwright 1.65: Chromium (Chrome) และ WebKit 2388 (Safari engine) × ความกว้าง 1280 และ 1440 px |

**Edge:** เครื่องตรวจไม่มี Microsoft Edge (channel `msedge` ติดตั้งต้องใช้สิทธิ์ admin) — Edge ใช้ Blink ตัวเดียวกับ Chrome จึงครอบคลุมด้วยผล Chromium · เครื่องที่มี Edge รัน `A11Y_EDGE=1 pnpm --filter @tms/web e2e:a11y` (เพิ่ม project `msedge-1280/1440`) ก่อน pilot

## 2. หน้าที่ตรวจ (10 หน้า) และผล

| # | หน้า | path | สิ่งที่เปิดตรวจเพิ่ม | axe serious/critical (หลังแก้) | คีย์บอร์ด (หลังแก้) |
|---|---|---|---|---|---|
| 1 | เข้าสู่ระบบ | `/login` | error ของฟอร์ม (`role=alert`) | 0 | ผ่าน — label ผูกช่อง, Enter ส่งฟอร์ม, error ประกาศ |
| 2 | ภาพรวม (dashboard) | `/` | — | 0 | ผ่าน — KPI/ปุ่ม/แถวตาราง Tab ถึง |
| 3 | ใบสั่งขนส่ง (SO) | `/so` | drawer SO, drawer เที่ยวรถ | 0 | ผ่าน (แก้ H1, H2) |
| 4 | ใบค้าง | `/so/hold` | drawer จับคู่ลูกค้า | 0 | ผ่าน (แก้ H1, H2) |
| 5 | กระดานวางแผน | `/plan` | วาง SO ลงรถ, เลื่อนเวลาเที่ยว, เปิด drawer | 0 | ผ่าน (แก้ H3, H4) — เหลือ M4 |
| 6 | เที่ยวรถ / DO | (drawer เที่ยวรถ) | — | 0 | ผ่าน · หน้า `/trips`, `/do` ยังเป็นหน้ารอ stage (ไม่มีตาราง) จึงตรวจผ่าน drawer เที่ยวรถ/ใบคุมรถ แทน |
| 7 | ทะเบียนรถ | `/fleet/vehicles` | ฟอร์มเพิ่มรถ + error | 0 | ผ่าน — error ผูกช่องด้วย `aria-invalid` + `aria-describedby`, สรุปจำนวนช่องที่ผิดเป็น `role=alert` |
| 8 | คนขับและรถร่วม | `/fleet/drivers` | — | 0 | ผ่าน (แก้ H1) |
| 9 | ลูกค้า | `/master/customers` | ฟอร์มเพิ่มลูกค้า | 0 | ผ่าน (แก้ H1, H2) |
| 10 | ตั้งค่า | `/settings` | — | 0 | ผ่าน — เมนูหมวด/ฟอร์ม/radio group Tab ถึง |
| + | ศูนย์ข้อยกเว้น | `/exceptions` | — | 0 | ผ่าน |

ผลเหมือนกันทั้ง Chromium และ WebKit ที่ 1280 และ 1440 px (60 ชุดผล axe) · ที่ 1280 px ไม่มีเนื้อหาหลุดจอ/scroll แนวนอนของหน้า (ตารางกว้างเลื่อนในกรอบตารางเอง)

สิ่งที่ดีอยู่แล้ว (FACT จากการตรวจ): `<html lang>` เปลี่ยนตามภาษา, มี landmark `nav`/`main`, เมนูข้างมี `aria-current`/`aria-expanded`, tabs มี `role=tab`+`aria-selected`, ปุ่มไอคอนมี `aria-label`, ทุกปุ่ม/ช่องมีกรอบ focus (`outline 2px #2257C4` หรือ ring ของปุ่ม), toast เป็น `role=status`, Esc ปิดเฉพาะชั้นบนสุด (`useEscapeLayer`), ฟอร์ม master ใช้ `FormField` ที่ผูก error กับช่อง

## 3. Defect ที่พบ

ระดับ: **High** = ผู้ใช้คีย์บอร์ด/screen reader ทำงานหลักไม่ได้ หรือ axe critical/serious · **Medium** = ทำได้แต่ยาก/ผิดเกณฑ์ AA ในส่วนรอง · **Low** = ปรับปรุง

### High — ปิดแล้วทั้งหมด (ไม่เปลี่ยนหน้าตาปกติ)

| ID | เรื่อง | WCAG | หน้า | แก้ |
|---|---|---|---|---|
| H1 | แถวตารางคลิกเปิด drawer ได้แต่ Tab ไม่ถึงและไม่มี Enter — เปิด SO/ใบค้าง/รถ/คนขับ/ลูกค้าด้วยคีย์บอร์ดไม่ได้ | 2.1.1 | 2,3,4,7,8,9 | `DataTable`: แถวที่มี `onRowClick` ได้ `tabIndex=0` + Enter/Space (เฉพาะเมื่อ focus อยู่ที่แถว ไม่ชนปุ่มในแถว) · กรอบ focus `:focus-visible` 2px `#2257C4` (สีเดียวกับกรอบ focus ปุ่มของต้นแบบ แสดงเฉพาะตอนใช้คีย์บอร์ด) |
| H2 | drawer/ฟอร์ม drawer/dialog เหตุผล: เปิดแล้ว focus ไม่ย้ายเข้า, Tab หลุดไปหลัง scrim, ปิดแล้ว focus หาย; drawer ไม่มีชื่อ (screen reader อ่านว่า "dialog") | 2.4.3, 4.1.2 | 3,4,5,7,9 | `useModalFocus` ใหม่ (`packages/ui/src/focus.ts`) ใช้ใน `Drawer`, `FormDrawer`, `ReasonDialog`: ย้าย focus เข้า (ไม่แย่งช่อง autoFocus), Tab วนในชั้นบนสุด, คืน focus ปุ่ม/แถวที่เปิด · `aria-labelledby` = เลข/หัวข้อใน drawer |
| H3 | กระดานวางแผน: สร้างเที่ยว (ลาก SO ลงรถ) และเลื่อนเวลาเที่ยวทำได้ด้วยเมาส์เท่านั้น; การ์ด SO/เที่ยว Tab ไม่ถึง | 2.1.1 | 5 | การ์ด SO: Tab ถึง, Enter/Space = เลือก (เหมือนคลิก) → Enter บนแถว/ช่องรถ = วาง SO ลงรถ (ช่วงเวลาเดียวกับการปล่อยในมุมมอง 7 วัน — ต่อท้ายเที่ยวสุดท้ายของวัน) · การ์ดเที่ยว: Tab ถึง, Enter เปิด drawer SO (มุมมอง 7 วัน: เปิด popover), ←/→ เลื่อนเวลา 15 นาที (ใช้คำขอ `/schedule` เดียวกับการลาก — กฎ/คำเตือนเหมือนเดิม) |
| H4 | `aria-pressed` บน div ไม่มี role (การ์ด SO รอจัด — axe critical `aria-allowed-attr`); ช่องรถ `role=button` ซ้อนปุ่ม "ทำไม" เมื่อรถติดกฎ (axe serious `nested-interactive`); `aria-label` บนแถวรถ/ช่องวันที่ไม่มี role (axe serious `aria-prohibited-attr`) | 4.1.2 | 5 | การ์ด SO และช่องรถ: `role=group` + `aria-current` แทน `aria-pressed` (ใช้ `role=button` ไม่ได้เพราะมีปุ่มซ้อน) — Enter/Space เลือกเหมือนเดิม · แถว/ช่องวันของรถ: `role=group` |

### Medium

| ID | เรื่อง | WCAG | สถานะ |
|---|---|---|---|
| M1 | ขอบช่องกรอก/select `#C9CDC3` บนพื้นขาว = **1.61:1** (เกณฑ์ขอบ control 3:1) — token ของต้นแบบ (`.tms-input`, select, textarea) | 1.4.11 | **ไม่แก้เอง (เปลี่ยนหน้าตาต้นแบบ)** → spec/12 §3 [OPEN — ส่ง Claude Design] · บรรเทา: ทุกช่องมี label มองเห็นได้, ตอน focus ขอบเป็น `#2257C4` (6.5:1) |
| M2 | ข้อความคำอธิบาย `#8A9099` บนพื้นขาว = **3.22:1** (ต้องการ 4.5:1) — คำอธิบายธงในฟอร์มเหตุผล (ตั้งค่า → เหตุผล, `ReasonFormDrawer`) ค่าจากต้นแบบ | 1.4.3 | **ไม่แก้เอง** → spec/12 §3 [OPEN — ส่ง Claude Design] (เสนอ `#59606B` = text3 6.34:1) |
| M3 | ช่องเลือกแถวในตารางอ่านเป็น id ภายใน (`veh_1672…`) | 2.4.6, 1.3.1 | **ปิดแล้ว** — ชื่อ = ข้อความคอลัมน์แรกของแถว (`aria-labelledby`) |
| M4 | กระดานวางแผน: ปรับความยาวเที่ยว (ลากขอบ `role=separator`) ยังใช้เมาส์เท่านั้น; ย้ายเที่ยวไปรถอื่นด้วยคีย์บอร์ดได้เฉพาะเที่ยวที่มีลิงก์ "ย้ายไปรถอื่น" | 2.1.1 | ค้าง → ผู้สมัครเพิ่ม #32 (plan/01 §5) — งานหลัก (จัด SO ลงรถ/เลื่อนเวลา/เปิด drawer) ทำด้วยคีย์บอร์ดได้แล้ว |
| M5 | dialog ที่เขียนเฉพาะหน้า (ไม่ใช้ component กลาง) 15 ไฟล์ — เช่น `SendAllDialog`, `RuleDialogs`, `ScheduleDialog`, `BulkFailDialog`, dialog ย่อยใน `TripDrawer`, `Templates`, `SavedViewMenu`, `ImportWizard`, `ReturnDialog`, `SecretDialog` — Esc ปิดได้แต่ยังไม่ trap/คืน focus | 2.4.3 | ค้าง → ผู้สมัครเพิ่ม #32: ใช้ `useModalFocus` ตัวเดียวกัน (ทีละไฟล์ + unit test) |
| M6 | เมนู ⋯ (แถวตาราง, drawer) `role=menu`: เปิดแล้ว focus ไม่ย้ายเข้าเมนู, ไม่มีลูกศรขึ้น/ลง (รายการ Tab ถึงได้) — เมนูคลิกขวาของกระดานทำแล้ว | 2.1.1 (ใช้ได้) / ARIA APG | ค้าง → ผู้สมัครเพิ่ม #32 |

### Low

| ID | เรื่อง | หมายเหตุ |
|---|---|---|
| L1 | ไม่มีลิงก์ "ข้ามไปเนื้อหา" — Tab ผ่านเมนูข้าง ~24 รายการก่อนถึงเนื้อหา | 2.4.1 ผ่านด้วย landmark `nav`/`main`; การเพิ่มลิงก์ = เพิ่ม element ที่ต้นแบบไม่มี → ไม่ทำ |
| L2 | ไอคอนตกแต่ง `#C9CDC3` (empty state) / ปุ่ม disabled `#C9CDC3` | ยกเว้นตาม 1.4.3/1.4.11 (decorative / inactive) |
| L3 | Safari: คลิกเมาส์ไม่ focus ปุ่ม (พฤติกรรม WebKit) → ปิด drawer ที่เปิดด้วยเมาส์ focus กลับ body | ไม่ใช่ defect — เปิดด้วยคีย์บอร์ดคืน focus ถูก (ทดสอบใน WebKit) · Safari ต้องเปิด "Press Tab to highlight each item" เพื่อ Tab ถึงปุ่ม (ค่าระบบ) |

## 4. Contrast ของ tokens (FACT — คำนวณตามสูตร WCAG)

| คู่สี | อัตราส่วน | ผล |
|---|---|---|
| text `#101418` / ขาว | 18.50 | ผ่าน |
| text2 `#3B424C` / ขาว · / chip `#EBEDE8` | 10.15 · 8.61 | ผ่าน |
| text3 `#59606B` / ขาว · pageBg · appBg · chip | 6.34 · 5.80 · 5.53 · 5.38 | ผ่าน |
| accent `#2257C4` / ขาว · / accentSoft | 6.50 · 5.67 | ผ่าน |
| ขาว / accent (ปุ่มหลัก) · / accentHover | 6.50 · 8.58 | ผ่าน |
| ok/warn/err บน soft ของตัวเอง | 5.20 / 5.37 / 5.26 | ผ่าน |
| ok/warn/err บนขาว | 5.90 / 6.06 / 6.16 | ผ่าน |
| กรอบ focus `#2257C4` / ขาว | 6.50 | ผ่าน (≥ 3:1) |
| `#6B7280` / ขาว (หน้าติดตาม — นอก 10 หน้า) | 4.83 | ผ่าน |
| **`#8A9099` / ขาว** (คำอธิบายในฟอร์มเหตุผล) | **3.22** | **ไม่ผ่าน — M2** |
| **ขอบช่องกรอก `#C9CDC3` / ขาว** | **1.61** | **ไม่ผ่าน 1.4.11 — M1** |
| ขอบปุ่มรอง `#9DB6E3` / ขาว | 2.05 | ไม่ต้องผ่าน (ปุ่มระบุด้วยข้อความสี accent 6.5:1) |

## 5. ข้อจำกัดของการตรวจ

- axe ตรวจได้ ~30–40% ของเกณฑ์ WCAG; ส่วนคีย์บอร์ดตรวจด้วยสคริปต์ + E2E · ยังไม่ได้ทดสอบกับ screen reader จริง (VoiceOver/NVDA) — ผู้สมัครเพิ่ม #33
- color-contrast ที่ axe ตัดสินไม่ได้ ("incomplete" — พื้นหลังซ้อนบน drawer/การ์ดกระดาน) ตรวจแทนด้วยตาราง §4
- 3 ช่องทางเบราว์เซอร์จริง (Chrome/Edge/Safari บน macOS/Windows) ใช้ engine ของ Playwright เป็นตัวแทน
