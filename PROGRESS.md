# PROGRESS — สถานะงานและบันทึกความคืบหน้า

> อัปเดตทุกครั้งที่จบ session งาน (คนหรือ AI) และทุกศุกร์ · ใหม่สุดอยู่บน · เขียนสั้น ชี้ไปไฟล์ที่มีรายละเอียด
> วิธีส่งต่องานให้คนใหม่/AI session ใหม่ อยู่ใน `HANDOFF.md`

## สถานะรวม (ณ 10 พ.ย. 2569)

| เรื่อง | สถานะ | ที่อยู่ |
|---|---|---|
| ระยะ | **ST0 กำลังทำ** — เริ่ม 10 พ.ย. 2569 (Claude Code ทำ, ยังไม่มีทีมคน) | ตาราง ST0 ด้านล่าง |
| เฟส 0 ทางเลือกขอบเขต | **C: standalone ก่อน แล้วต่อ KRS** (ตัดสิน 10 พ.ย.) | `PLAN.md` §6 |
| คำตัดสินแล้ว | D-04 KRS ในเฟส 0 = ใช่ · D-11 ไทย + โครง i18n · D-15 React + TS + Vite | `plan/05` |
| คำตัดสินที่ยังรอ | D-07 เตือน/บล็อก (ก่อน ST3) · D-14 tenant นำร่อง (ก่อนจบ ST2) · D-51 เฟสของ 3D (ไม่ขวาง) | `plan/05` |
| ขวางการจบ ST0 | ที่เก็บโค้ด remote + CI รันจริง, บัญชี cloud (staging), ADR ผู้ให้บริการภายนอก, คำตอบนักบัญชี/KRS, ตัวอย่างเอกสารจริง | `PLAN.md` §1.1 ข้อ 9, 10, 11–12, 14, 16, 20 |
| คำถามถึงคนนอก | **ยังไม่ส่ง** ทั้ง 3 ชุด (นักบัญชี, ทนาย, KRS) | `plan/06`–`08` |
| ต้นแบบ UI | Claude Design รอบ 1–19 เสร็จ; **export แล้ว 10 พ.ย.** เปิดจากเครื่องได้ | `design/README.md` |
| โค้ด | monorepo + API plumbing + RLS + web shell + PDF engine — test 73 ข้อผ่าน, ยังไม่ commit | `README.md` §เริ่มพัฒนา |

## Stage

| Stage | สถานะ | เริ่ม | จบ | หมายเหตุ |
|---|---|---|---|---|
| ST0 เตรียมการและ freeze | **กำลังทำ** 16/19 เสร็จ · T01, T03 บางส่วน (รอเลือกผู้ให้บริการ/cloud) · T18 รอ PO | 10 พ.ย. | — | ดูตารางงาน ST0 ด้านล่าง |
| ST1–ST9 | ยังไม่เริ่ม | | | |

### งาน ST0 (เกณฑ์ตรวจรับใน `plan/01-phase0-backlog.md`)

| งาน | สถานะ | หลักฐาน / ที่ยังขาด |
|---|---|---|
| T01 ADR | **บางส่วน** | ตัดสินแล้ว: frontend, monorepo, job queue, PDF engine, i18n, ชื่อ, รุ่น dependency (`plan/02` T-19/T-20) · ยังเปิด: cloud/region, object storage, แผนที่, อีเมล/SMS, LINE OA |
| T02 Monorepo | เสร็จ | `pnpm install && pnpm build && pnpm test` ผ่าน; template PR ใน `.github/` |
| T03 CI/CD + env | **บางส่วน** | CI บน GitHub (container Playwright 1.65): lint, typecheck, test, OpenAPI check/diff, build, **E2E**, CVE gate · ยังไม่มี staging/production และ error tracking (รอ cloud) |
| T04 multi-tenant + RLS | เสร็จ | `test/rls.test.ts` 6 ข้อ: ไม่ตั้ง session = 0 แถว, raw SQL ข้าม extension ก็โดน RLS, WITH CHECK, append-only |
| T05 harness แยก tenant | เสร็จ | `test/isolation.test.ts`: ตาราง/route ใหม่ที่ไม่มี RLS หรือ fixture → แดง (ลองทำพังโดยตั้งใจแล้ว จับได้) |
| T06 API plumbing 1 | เสร็จ | `/v1`, problem+json + code + requestId, ID prefix, ext:, validation 422 errors[], lint DTO |
| T07 Idempotency | เสร็จ | replay + header, 422 mismatch, 409 in-progress, ไม่จำคำขอที่ error, แยก tenant |
| T08 list/ETag | เสร็จ | เดิน cursor 10,000 แถวไม่ซ้ำไม่ตก, fields, updatedAfter, sort, If-Match 412 |
| T09 OpenAPI | เสร็จ | `/v1/openapi.json`, `openapi:check` + diff gate, `@tms/contracts` client ที่ web ใช้ · หมายเหตุ: ออกเป็น 3.0 ไม่ใช่ 3.1 (T-20) |
| T10 state machine | เสร็จ | history + domain_event ใน transaction เดียว, 409 transition ผิด, เหตุผลบังคับ |
| T11 Job framework | เสร็จ | round-robin 2 tenant, pending→running→succeeded ผ่าน API, retry/failed |
| T12 Security baseline | เสร็จ (ส่วน API) | header (HSTS/CSP/frame/referrer), log redaction, AES-256-GCM หมุน key · cookie/CSRF ยังไม่มีเพราะ ST0 ใช้ bearer token — ทำพร้อม login ใน ST1 |
| T13 UI shell | เสร็จ | sidebar/header/หัวหน้าตรงต้นแบบ (เทียบภาพแล้ว), routing, client ที่ generate, หน้า error/404/ยังไม่เปิด · ยังไม่ได้ขึ้น staging |
| T14 UI patterns | เสร็จ | `@tms/ui`: ปุ่ม 4 แบบ, input, badge 115 ป้าย, KPI, tab, chip, empty, ตาราง (แถวกรอง/rail/กะทัดรัด/bulk/เมนูแถว/แบ่งหน้า), drawer + test 11 ข้อ; ตัวอย่าง list→drawer→form เรียก `/v1/companies` จริง |
| T15 i18n | เสร็จ | TH ครบ, EN/中文 จากพจนานุกรมต้นแบบ 106/227 (ที่เหลือแสดงไทยตาม D-11), lint ห้ามไทย hard-code, วันที่ พ.ศ./ค.ศ. |
| T16 Seed | เสร็จ | tenant เดโม 2 ราย, รัน 2 ครั้งข้อมูลเท่าเดิม (test) |
| T17 PDF engine | เสร็จ (macOS) | Chromium + Sarabun ฝังในไฟล์, A4, เก็บแบบ immutable, golden ภาพผ่าน · golden ของ Linux ต้องสร้างใน CI ครั้งแรก |
| T18 คำถามภายนอก | **รอ PO** | ยังไม่ได้ส่ง `plan/06`–`08` |
| E2E (plan/03 §3) | เริ่มแล้ว | `apps/web/e2e`: shell/เมนู/ภาษา/404/ย่อเมนู + นิติบุคคล list→drawer→form ผ่าน API จริง 9 ข้อ (ฐาน `tms_e2e`) — เส้นทาง E2E 8 เส้นของ plan/03 เพิ่มตาม stage |
| T19 Reconcile + schema v0 | เสร็จ (ST1–ST2 freeze, ST3–ST4 ร่าง) | ตารางตัดสิน 21 ข้อ (`plan/11`, 5 ข้อ ★ รอ PO/นักบัญชี/KRS) · migration `0004_schema_v0` 29 ตาราง + RLS ครบ + CHECK constraint (`test/schema-v0.test.ts`) · contract KRS `packages/contracts/krs/*.schema.json` + test |

## สัปดาห์นี้ (สัปดาห์ 10–14 พ.ย. 2569)

งานที่หยิบ: ยังไม่มี task โค้ด · งานเอกสาร: เสร็จตามบันทึกด้านล่าง
สิ่งที่ PO ต้องทำ: ดู `PLAN.md` §8 (เรียงตามลำดับแล้ว)

## คำถามค้าง (ต้องการคำตอบจาก PO / คนนอก)

| # | คำถาม | ถามเมื่อ | ขวางอะไร | สถานะ |
|---|---|---|---|---|
| 1 | D-07 กฎจัดรถ: เตือน + เหตุผล หรือ บล็อก + อนุมัติ | 10 พ.ย. | ST3 | รอ |
| 2 | D-14 tenant standalone ที่จะนำร่องคือใคร | 10 พ.ย. | ST2 ปลาย, ตัวอย่างเอกสารจริง | รอ |
| 3 | ตัวอย่างเอกสารจริง 1 บริษัท (ใบวางบิล, ใบกำกับ/ใบเสร็จ, ใบลดหนี้, ใบคุมรถ, 50 ทวิ, settlement) | 10 พ.ย. | ST0-T17, ST5 golden test | รอ |
| 4 | ใครเป็น TL / Dev กี่คน / เริ่มวันไหน | 10 พ.ย. | ทุกอย่าง | รอ |
| 5 | ส่งรอบแก้ต้นแบบ 3D (4 จุด) ใน Claude Design ไหม — เป็นการจำลองล้วน | 10 พ.ย. | ไม่ขวาง | รอ |
| 9 | ตารางต้องแสดงยอดรวม "จาก N" ไหม (ต้นแบบมี แต่ API เป็น cursor — `spec/12` §3) | 10 พ.ย. | ทุกหน้ารายการ ST1+ | รอ |
| 10 | commit/push โค้ด: ใช้ GitHub org ไหน, ชื่อ repo, ใครเป็น reviewer | 10 พ.ย. | T03 จบ, ทีมทำงานร่วม | รอ |
| 6 | คำถามนักบัญชี 33 ข้อ (`plan/06`) | ยังไม่ส่ง | ST5 | รอ PO ส่ง |
| 7 | คำถามทนาย/PDPA (`plan/07`) | ยังไม่ส่ง | ST1 ข้อความ consent, T-08 | รอ PO ส่ง |
| 8 | คำถามทีม KRS (`plan/08`) | ยังไม่ส่ง | ST8 | รอ PO ส่ง |

## Defect / Incident

ยังไม่มี (เริ่มใช้เมื่อมี staging)

## บันทึกรายวัน

### 10 พ.ย. 2569 (เย็น — ปิดงานรอบแรก + ขึ้น GitHub)
- T19: แก้ตาราง `plan/11` ข้อ 5–6 ให้ตรง docs/01 §4.3–4.4 (ร่างแรกตั้งชื่อสถานะเอง ผิดหลัก docs ชนะ) · schema v0 29 ตาราง · contract KRS
- E2E Playwright 9 ข้อ — เจอบั๊กจริง 1 ข้อ: drawer ปิดเองเมื่อแถวหลุดจากตัวกรองหลังเปลี่ยนสถานะ → แก้แล้ว
- CI รันใน container Playwright 1.65 (amd64) และใช้ golden ของ Linux ที่สร้างจาก image เดียวกัน (ตรวจด้วยตาแล้ว)
- ผลในเครื่อง: lint/typecheck/build ผ่าน, test 82 ข้อ (api 58, ui 11, domain 9, web 4), E2E 9 ข้อ (รัน 2 รอบผลเดิม)

### 10 พ.ย. 2569 (บ่าย — เริ่ม ST0)
- PO สั่ง "เริ่มทำได้เลย": ทำ ST0 T02, T04–T17 (ดูตาราง ST0) · test ผ่าน: api 49, ui 11, domain 9, web 4
- ปัญหาที่เจอและแก้: (1) docker compose ใช้ชื่อโปรเจกต์ `infra` ซ้ำกับ PropSpace ทำให้ container `propspace-postgres` (หยุดอยู่) ถูกแทนที่ — ข้อมูล volume `infra_postgres-data` ไม่หาย, สร้าง container คืนจาก compose ของ PropSpace แล้ว, ตั้ง `name: tms` + พอร์ต 54329 · (2) พอร์ต 3000/3100/5433 มีโปรเจกต์อื่นใช้ → API 4410, web 4420 · (3) Prisma บล็อก `migrate reset` (ต้องให้คนยืนยัน) → ใช้ migration ใหม่แทน · (4) นาฬิกา app/DB ต่างกัน ~75 ms ทำให้ job ไม่ถูกหยิบ → `run_at` ให้ DB ใส่เอง · (5) dependency รุ่นแรกที่เลือกมีช่องโหว่ critical/high → อัปเป็น Nest 11, Vitest 4.1, Vite 6.4, Prisma 6.19 + override (เหลือ moderate 2)
- UI ทำตามต้นแบบเคร่งครัด: ดึงค่าจาก inline style/script ของ `TMS v4` (สถานะ badge 115 ป้าย, META หัวหน้า, ตาราง T.*, drawer P.*) แล้วเปิดเทียบภาพ shell กับต้นแบบ — ตรง · ข้อขัดกันใหม่ 5 รายการบันทึกใน `spec/12` §3
- ยังไม่ commit — รอ PO บอก remote (คำถามค้าง #10)
- PO สั่ง "ทำตาม Design อย่างเคร่งครัด": เปลี่ยนสถานะต้นแบบจาก "ภาพอ้างอิง" เป็น "ข้อกำหนดด้านหน้าตาและการใช้งาน" — แก้ `CLAUDE.md`, `design/README.md` (ตารางกติกา + ข้อยกเว้น), `plan/00-source-of-truth.md`, `spec/README.md`, `spec/12` §3, `plan/04` R10, `plan/10` DoD/QA, templates PR/QA, `HANDOFF.md`
- PO สั่ง "เริ่มทำได้เลย": `pnpm install` ราก + `packages/domain` test ผ่าน 9/9 (money, tax, state machine) · เขียน config `apps/api` (package.json, tsconfig, vitest) แล้วหยุดที่ install ตามที่ PO กดปฏิเสธ — ยังไม่มีโค้ด api
- PO สั่ง export ต้นแบบ: Claude Design → Share → Export → Project HTML → Project archive → `design/prototype/` (100 ไฟล์, 11 MB) + zip สำรอง `design/claude-design-export-2026-11-10.zip` · เปิดผ่าน http บนเครื่องได้ (ตรวจ TMS v4, Print, Driver App) · เขียน `design/README.md` (ไฟล์ไหนใช้ตอนไหน, ฉบับเก่าที่ไม่ใช้, ข้อควรระวัง) · landing page อยู่ใน `TMS Signup.dc.html`

### 10 พ.ย. 2569
- ตรวจผลรอบ 19 (หน้าติดตามรถ 3D) ใน Claude Design: ใช้งานได้ มี 4 จุดควรแก้ (รถเล็ก, เส้นทางตรง, แถบล่างล้นจอ, ป้ายซ้อน) → บันทึกใน `research/design-briefs.md`
- เพิ่ม `PLAN.md` §1.1 รายการความพร้อมเริ่ม dev 22 ข้อ และเรียง §8 ใหม่
- เทคนิค 3D: `plan/02` T-18 (ADR), `plan/05` D-51/D-52, `plan/01` ผู้สมัคร #22, `plan/04` R16/R17, `spec/04` §1.1 (EXE-013–019b), `spec/12` §3
- PO ตัดสิน: D-15 React, D-04 KRS ใช่, D-11 ไทย + โครง i18n, ทางเลือก C → บันทึกใน `plan/05`, `PLAN.md`
- เริ่ม ST0-T02 ไปบางส่วนก่อนได้รับคำสั่ง "อย่าเพิ่งเริ่ม dev": `git init`, ไฟล์ราก (`package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.gitignore`, `.editorconfig`, `.nvmrc`, `.prettierrc`, `.env.example`), `infra/docker-compose.yml` + `infra/postgres/init/01-roles.sql`, `packages/domain` (money/tax/state-machine + test) — **ยังไม่ได้ `pnpm install`, ยังไม่ได้รัน test, ยังไม่ commit** · โฟลเดอร์ว่าง `apps/*`, `packages/contracts`, `packages/ui`, `.github/workflows` ถูกสร้างไว้ด้วย · จะทำต่อหรือลบเมื่อ PO สั่งเริ่ม ST0
- เขียน `plan/10-engineering-loop.md` (Plan → Dev → Review → QA → Deploy → Operate), templates ใน `plan/templates/` (PR, task card, release checklist, QA checklist, CI draft), `plan/sign-offs/`
- เขียน `PROGRESS.md` (ไฟล์นี้) และ `HANDOFF.md`

### 9 พ.ย. 2569
- เขียน `spec/` 13 ไฟล์ (~8,300 บรรทัด) จากต้นแบบ — ภายหลังพบว่าไม่ได้อ่าน `docs/` v2 จึงติดป้ายลำดับความสำคัญทุกไฟล์
- Claude Design รอบ 14–18: AI/MCP, API/MCP แบบ TRCloud (ปรับไม่ลอก), landing page + hero

### 3–8 พ.ย. 2569 (สรุป)
- `docs/` v2 โดย PO (3–4 พ.ย.): สถาปัตยกรรม, product/commercial, design brief, functional requirements
- Claude Design รอบ 1–13: design system, Driver App, Fleet 15 หน้า, planning board, Open API, custom fields, one-platform
- research: ภาษีไทย, API benchmark, ราคา, payment gateway, ตรวจบริษัท, TRCloud, AI/MCP plan
- 10 พ.ย. ช่วงเช้า: `PLAN.md`, `CLAUDE.md`, `plan/00`–`09` (reconcile, backlog 204 งาน, ADR, test plan, risk, decisions 50 ข้อ, คำถาม 3 ชุด, pilot)
