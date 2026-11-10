# TMS — เอกสารโปรเจกต์

อัปเดตล่าสุด: 2026-11-10

**เริ่มอ่านที่ `PROGRESS.md`** (สถานะล่าสุด) → `PLAN.md` (แผนเฟส 0) → `plan/10-engineering-loop.md` (วิธีทำงาน) · คนใหม่/AI session ใหม่อ่าน `HANDOFF.md` · กติกาว่าเอกสารไหนใช้ตัดสินเรื่องอะไร: `plan/00-source-of-truth.md`

## โครงสร้าง

```
docs/            เอกสารออกแบบ v2 (ใช้ชุดนี้)
  01-tms-architecture-and-integration.md   สถาปัตยกรรม standalone-first + Open API, data model, state machine, integration layer, Appendix KRS
  02-tms-product-commercial.md             positioning, tier/ราคา, add-on, multi-tenant, portal, roadmap
  03-tms-design-brief.md                   design system + prompt สำหรับ Claude Design (อ้าง LogisticsX/Alvys)
  04-tms-functional-requirements.md        ฟังก์ชันครบ A–K พร้อม P0/P1/P2 และที่มา
docs/v1/         เอกสารรุ่นแรก (KRS-centric) เก็บไว้อ้างอิง
research/
  tms-product-learning.md     product ที่ควรเรียนรู้ (REA/Claude Code)
  thai-tax-docs-research.md   เอกสารบัญชี/ภาษีไทย, e-Tax, WHT, API โปรแกรมบัญชี
  tms-api-benchmark.md        เทียบ API 6 ราย + มาตรฐาน API ของเรา
  design-briefs.md            คำสั่งดีไซน์รอบ 1–18 ที่ส่งเข้า Claude Design + design tokens
  decisions.md, pricing-th.md, payment-gateway-th.md, company-verification-th.md   งานวิจัยฝั่ง one-platform
  one-platform.md, ai-mcp-plan.md, trcloud-api-mcp-learning.md                     แนวคิดสำหรับเฟสถัดไป
  assets/                     screenshot reference
spec/            Function Spec (9 พ.ย.) — รายละเอียดระดับหน้าจอ + โมดูลใหม่; เมื่อขัดกับ docs/ ให้ยึด docs/
plan/            แผนเฟส 0: backlog, เทียบ docs กับ spec, การตัดสินใจ, แผนทดสอบ, ความเสี่ยง, คำถามถึงนักบัญชี/ทนาย/KRS, แผนนำร่อง, loop วิศวกรรม (10) + templates/
PLAN.md          แผนพัฒนาเฟส 0 (v0.2 — PO เลือกทางเลือก C แล้ว)
PROGRESS.md      สถานะงาน คำถามค้าง บันทึกรายวัน
design/          ต้นแบบ UI ที่ export จาก Claude Design 10 พ.ย. (ภาพอ้างอิง ดู design/README.md)
HANDOFF.md       ส่งต่องานให้คนใหม่/AI session ใหม่
package.json, infra/, packages/domain   ไฟล์ตั้งต้น monorepo (หยุดไว้ รอ PO สั่งเริ่ม ST0)
CLAUDE.md        คำแนะนำสำหรับ Claude Code
```

## จุดยืนของระบบ (v2)

- TMS เป็นระบบหลักที่สมบูรณ์ในตัว ขาย standalone ให้ผู้ที่ไม่มี ERP ได้ทันที (ออกเอกสารภาษีไทยครบชุดในระบบ)
- Open API เป็น first-class: UI ของเราเรียก API ชุดเดียวกับลูกค้าและ connector ภายนอก
- ERP/โปรแกรมบัญชีเป็น connector: KRS (ตัวแรก, pilot), FlowAccount, PEAK (API), Express (file export)
- Multi-tenant shared schema + RLS, หลายนิติบุคคล/สาขา (ภ.พ.20) ใน tenant เดียว

## คำถามเปิดที่ต้องปิดก่อนเริ่ม dev

- เจ้าของสินค้า: `plan/05-decisions-needed.md` (52 ข้อ; ตอบแล้ว 10 พ.ย.: D-04, D-11, D-15 + ทางเลือก C; ยังรอ D-07, D-14)
- นักบัญชี: `plan/06-questions-accountant.md` (33 ข้อ พร้อมส่ง — รวม 12 ข้อเดิมจาก thai-tax-docs-research 6.2 แล้ว)
- ทนาย/PDPA: `plan/07-questions-legal-pdpa.md` (18 ข้อ)
- KRS: `plan/08-questions-krs.md` (18 ข้อ — รวม checklist จาก docs/01 Appendix A แล้ว)
- ราคา: ขอใบเสนอราคา Treasure / Logis Boy / NOSTRA มาเทียบก่อนประกาศ tier (ไม่ขวางเฟส 0)

## ขั้นต่อไป

1. ~~ส่ง prompt เข้า Claude Design~~ ทำแล้ว (ดีไซน์ 18 รอบ — research/design-briefs.md); ต้องเก็บต้นแบบก่อน Claude Design ปิด 14 ธ.ค.
2. ~~ทำ PLAN.md เฟส 0~~ v0.2 — PO เลือกทางเลือก C แล้ว 10 พ.ย.
3. ทำรายการ "สัปดาห์แรก" ใน PLAN.md §8 (ทีม, ที่เก็บโค้ด, ส่งคำถาม, ตัวอย่างเอกสารจริง) แล้ว PO สั่งเริ่ม ST0

## เริ่มพัฒนา (โค้ด ST0)

ต้องมี: Node 20, pnpm 10 (ผ่าน corepack), Docker

```bash
cp .env.example .env
pnpm install
pnpm db:up                                   # PostgreSQL 16 ที่ 127.0.0.1:54329 (compose project "tms")
pnpm --filter @tms/api db:migrate && pnpm --filter @tms/api db:seed
pnpm test                                    # ทุก package
pnpm --filter @tms/api dev                   # API http://localhost:4410/v1  (openapi: /v1/openapi.json)
pnpm --filter @tms/web dev:token && pnpm --filter @tms/web dev   # Web http://localhost:4420
```

โครง: `apps/api` (NestJS + Prisma, worker อยู่ใน `src/worker.ts`) · `apps/web` (React + Vite) · `packages/domain` (เงิน/ภาษี/state machine ไม่มี I/O) · `packages/ui` (design system จากต้นแบบ) · `packages/contracts` (OpenAPI + client ที่ generate) · `infra/` (docker compose + role ฐานข้อมูล) — รายละเอียดคำสั่งใน `CLAUDE.md`
