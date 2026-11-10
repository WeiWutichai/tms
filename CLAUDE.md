# TMS — คำแนะนำสำหรับ Claude Code

ระบบจัดการขนส่ง (TMS) แบบ SaaS หลายบริษัทในระบบเดียว สำหรับบริษัทขนส่งทางบกในไทย 10–200 คัน (รถบริษัท + รถร่วม) ของ Innovera · เริ่มเขียนโค้ด ST0 วันที่ 10 พ.ย. 2569 — monorepo อยู่ในโฟลเดอร์นี้ (`apps/`, `packages/`, `infra/`) ร่วมกับเอกสาร

## อ่านอะไรก่อน

1. `PROGRESS.md` — สถานะล่าสุด คำถามค้าง และบันทึกงานครั้งก่อน (อัปเดตทุกครั้งที่จบงาน)
2. `PLAN.md` — แผนพัฒนาเฟส 0, §1.1 สิ่งที่ยังขาด
3. `plan/10-engineering-loop.md` — วิธีทำงาน plan → dev → review → QA → deploy (Definition of Ready/Done, templates ใน `plan/templates/`)
4. `plan/00-source-of-truth.md` — เอกสารไหนใช้ตัดสินเรื่องอะไร
5. `plan/01-phase0-backlog.md` — งานทีละชิ้นพร้อมเกณฑ์ตรวจรับ
6. `HANDOFF.md` — เมื่อเริ่ม session ใหม่หรือมีคนใหม่เข้าทีม

## ลำดับความสำคัญของเอกสาร (เมื่อขัดกัน)

1. คำตอบที่ตัดสินแล้วใน `plan/05-decisions-needed.md`
2. `docs/` (v2, เจ้าของสินค้าเขียน) — สถาปัตยกรรม, data model, state machine, มาตรฐาน API, ลำดับความสำคัญ P0/P1/P2, รายการ "สิ่งที่ไม่ทำ"
3. `spec/` — รายละเอียดระดับหน้าจอ/ฟิลด์/เกณฑ์ตรวจรับ และโมดูลที่ docs ยังไม่มี (ดูรายการที่ขัดกันใน `plan/00a-*.md`, `plan/00b-*.md`)
4. `research/` — ที่มาและข้อเท็จจริง (กฎหมายภาษีอยู่ใน `research/thai-tax-docs-research.md`)
5. ต้นแบบ UI ใน `design/prototype/` (export จาก Claude Design) — **ต้องทำตามต้นแบบอย่างเคร่งครัดเรื่องหน้าตาและการใช้งาน** (PO สั่ง 10 พ.ย. 2569) แต่กฎธุรกิจ/ภาษี/สถานะ/สิทธิ์ยังยึด docs → spec — ดู `design/README.md` §กติกา

ถ้าพบว่าเอกสารขัดกันและยังไม่มีในรายการ reconcile: หยุด ถามผู้ใช้ และเพิ่มลงรายการ อย่าเลือกเอง

## หลักการที่ห้ามละเมิด

- **Standalone-first:** ทุก flow ทำจบได้โดยไม่มี connector; ห้าม hard-code ERP ใด (KRS เป็นแค่ adapter ตัวหนึ่งหลัง `ErpAdapter`)
- **API-first:** UI เรียก `/v1` ชุดเดียวกับลูกค้า ไม่มี endpoint ลับสำหรับ UI
- **Multi-tenant:** ทุกตารางมี `tenant_id` + RLS + test แยกข้อมูล; cross-tenant ตอบ 404
- **เอกสารภาษี:** `vat_type` และ `wht_rate` อยู่ที่บรรทัด; ออกเลขตอน finalize เท่านั้น; ออกแล้วแก้ไม่ได้ (แก้ด้วยใบลดหนี้/เพิ่มหนี้); ไม่มี hard delete; ห้ามแต่งกฎภาษีเอง — ไม่แน่ใจให้ดู research หรือถาม
- **สถานะเอกสารแยกจากสถานะซิงก์**
- เงินใช้ `numeric(14,2)` ห้ามใช้ float; เวลาเก็บ `timestamptz`; event จากอุปกรณ์เก็บทั้ง `occurredAt` และ `receivedAt`
- ทุกการยกเลิก/override/อนุมัติ ต้องมีเหตุผลและลง audit log
- เคารพรายการ "K สิ่งที่ไม่ทำ" ใน `docs/04`

## ทำ UI ตามต้นแบบอย่างเคร่งครัด (PO สั่ง 10 พ.ย. 2569)

- ทุกหน้าจอใน `apps/web` ต้องตรงกับ `design/prototype/` (ฉบับ `TMS v4`, `Print`, `Subcon`, `Tracking`, `Driver App`, `Signup`, `Platform Console`): layout, ลำดับและชื่อคอลัมน์/ฟิลด์, ข้อความ (ไทย), สี, ฟอนต์, ขนาด, ระยะ, radius, shadow, icon, สถานะ empty/loading/error, drawer/modal, ลำดับขั้นตอนและปุ่ม
- ใช้ค่าจากต้นแบบจริง (เปิดไฟล์ดู CSS/ข้อความ) ห้ามเดาหรือ "ทำให้สวยขึ้น" เอง; ไม่เพิ่มหน้า/ปุ่ม/ฟิลด์ที่ต้นแบบไม่มี และไม่ตัดของที่ต้นแบบมี (ยกเว้นข้อยกเว้นด้านล่าง)
- **ข้อยกเว้น — ยึด docs/spec แทนต้นแบบ** เฉพาะเรื่องที่ต้นแบบผิดกฎ: การคำนวณเงิน/ภาษี, ประเภทเอกสารภาษีและเวลาออก, state machine และสถานะ, สิทธิ์, validation, ขอบเขตเฟส (หน้าที่อยู่นอกเฟส 0 ยังไม่ทำ), ผู้ให้บริการภายนอก (เช่น tile แผนที่), ข้อมูลตัวอย่าง — รายการที่รู้แล้วอยู่ใน `spec/12` §3 และ `spec/04` §1.1 ข้อ 4 ในกรณีนี้ให้คงหน้าตาเดิมของต้นแบบไว้ เปลี่ยนเฉพาะส่วนที่ผิด
- เจอจุดที่ต้นแบบขัดกับ docs/spec แต่ยังไม่อยู่ในรายการ หรือต้นแบบไม่มีหน้าที่ต้องทำ → หยุด ถาม PO และเพิ่มลง `spec/12` §3 อย่าออกแบบเอง
- ทุก PR ที่มี UI ต้องแนบภาพเทียบ "ต้นแบบ | ของจริง" ขนาดจอเดียวกัน (1440 px และ 390 px สำหรับหน้า public)

## วิธีทำงาน

- ทำทีละ task ใน backlog ตามลำดับ stage (ST0 → ST9); task หนึ่ง = PR หนึ่ง = API + data + UI + test ครบ
- งานที่ไม่อยู่ใน backlog เฟส 0 → อย่าทำ ให้เสนอเพิ่มในภาคผนวก "ผู้สมัครเพิ่ม"
- ทุก PR ต้องมี: unit/integration test, test แยกข้อมูลของตารางใหม่, OpenAPI อัปเดต, ข้อความไทยครบ (อังกฤษ/จีนไม่บังคับ — D-11)
- งานที่แตะ billing/settlement ต้องผ่าน golden test ภาษี (`plan/03-test-plan.md` §4)
- เขียนเอกสารและข้อความถึงผู้ใช้เป็นภาษาไทย ศัพท์เทคนิคใช้อังกฤษได้; แยก FACT กับข้อเสนอให้ชัด
- จบงานทุกครั้ง: เพิ่มบันทึกใน `PROGRESS.md` (ทำอะไร ไฟล์ไหน ค้างอะไร) และแก้ตารางคำถามค้างถ้าเปลี่ยน

## คำสั่ง

ครั้งแรก: `cp .env.example .env && pnpm install && pnpm db:up && pnpm --filter @tms/api db:migrate && pnpm --filter @tms/api db:seed`

| ทำอะไร | คำสั่ง |
|---|---|
| ทั้ง repo | `pnpm build` · `pnpm typecheck` · `pnpm lint` · `pnpm test` (ต้องมี PostgreSQL จาก `pnpm db:up`) · `pnpm e2e` (Playwright: API 4510 + web 4520 + ฐาน `tms_e2e`) |
| API (พอร์ต 4410) | `pnpm --filter @tms/api dev` · worker: `pnpm --filter @tms/api dev:worker` |
| Web (พอร์ต 4420, proxy `/v1` → 4410) | `pnpm --filter @tms/web dev` — login ด้วยผู้ใช้เดโมใน `apps/api/prisma/seed.ts` |
| test ไฟล์เดียว | `cd apps/api && npx vitest run test/isolation.test.ts` |
| migration ใหม่ | แก้ `apps/api/prisma/schema.prisma` → สร้างโฟลเดอร์ `prisma/migrations/NNNN_name/migration.sql` จาก `prisma migrate diff` → **ต่อท้ายด้วย `SELECT tms_enable_tenant_rls('<table>');` ทุกตารางที่มี tenant_id** → `pnpm --filter @tms/api db:migrate` |
| OpenAPI | `pnpm --filter @tms/api openapi:export` (ต้องรันทุกครั้งที่ API เปลี่ยน แล้ว commit `packages/contracts/openapi.json`) |
| ข้อความภาษา | แก้ `apps/web/src/i18n/th.ts` → `pnpm --filter @tms/web i18n:build` |

กติกาโค้ดที่ตรวจด้วย test/lint (ห้ามปิด): E2E, harness แยก tenant (`apps/api/test/isolation.test.ts` — route ที่มี `:id` ต้องมี `@TenantResource` + fixture), lint DTO, lint i18n (ห้ามข้อความไทย hard-code), OpenAPI diff gate, PDF golden

ห้าม `prisma migrate reset`/`dev` บนฐานที่มีข้อมูล — ใช้ migration ใหม่เสมอ
