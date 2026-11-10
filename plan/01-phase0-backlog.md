# 01 — Backlog เฟส 0 (KRS pilot + Standalone core)

> ร่าง 10 พ.ย. 2569 · ฐานขอบเขต = `docs/04` (แถว P0 ทุกแถว) + `docs/01` (data model / state machine / API) + `docs/02` §7 (เกณฑ์ผ่านเฟส 0) · `spec/` ใช้เสริมรายละเอียดจอ/ฟิลด์เท่านั้น
> เกณฑ์ผ่านเฟส 0 (docs/02 §7): **(ก)** KRS ปิดงวด 2 เดือนติดโดย MISMATCH ค้าง = 0 **(ข)** tenant standalone ออกใบกำกับภาษี + 50 ทวิ ครบ 1 รอบเดือนโดยนักบัญชีของเขายอมรับ

## 1. วิธีอ่าน

- **รหัสงาน** `ST3-T07` = stage 3 งานที่ 7 · stage ใช้รหัส ST0–ST9 (ไม่ใช้ M เพราะ M1–M18 คือชื่อจอแอปคนขับ) · เลขงานไม่ใช่ลำดับทำ — ลำดับดูจากคอลัมน์ "ต้องเสร็จก่อน"
- **ขนาด** S ≈ ≤ 1 วันทำงาน · M ≈ 2–3 วัน · L ≈ 1 สัปดาห์ ของนักพัฒนา 1 คนที่ทำงานคู่กับ AI coding agent — **เป็นค่าประมาณ ต้อง re-baseline หลังจบ ST1** (เทียบเวลาจริงกับขนาดที่ตั้งไว้แล้วปรับตัวคูณทั้ง backlog)
- **งาน** = vertical slice: API + ข้อมูล + UI + test (ถ้าเกี่ยว) · UI เรียก `/v1` ชุดเดียวกับลูกค้าเสมอ (docs/01 §1 ข้อ 2)
- **อ้างอิง**: `A1 Login` = แถวใน docs/04 (โมดูล + ชื่อแถว) · `01§4.2` = docs/01 หัวข้อ 4.2 · `01 A.3` = docs/01 Appendix A · `02§7` = docs/02 · `spec05§3` = spec/05 หัวข้อ 3
- **ต้องเสร็จก่อน** = รหัสงานที่ต้องเสร็จก่อนเริ่ม · รหัสสั้น `T05` = งานใน stage เดียวกัน · ข้าม stage เขียนเต็ม `ST1-T05` (ระบุเฉพาะตัวที่ผูกตรง)
- **ตัดได้?** "ใช่" = เลื่อนไปหลังเฟส 0 ได้โดยเกณฑ์ (ก)(ข) ยังผ่าน และไม่ทำให้ข้อมูลจริงของ pilot เสี่ยง · "ไม่" = ขาดแล้วเกณฑ์ไม่ผ่านหรืองานอื่นเดินไม่ได้ · งาน "ใช่" ยังเป็น P0 ของ docs/04 (ต้องมีก่อนขายรายแรก) แค่ไม่บล็อกเกณฑ์ผ่านเฟส 0
- **ชื่อ entity ยึด docs/01**: `company`/`branch` (= `legal_entity`/`company_branch` ใน docs/04), `sales_order` (= "Order" ใน docs/04, API `orders`), `delivery_order` (DO), `customer_site` (= location), `service_item` (= accessorial catalog), `reason_code`, `trip_cost` (= cost line), `stop_event` — จุดที่สองเอกสารต่างกันรวมไว้ในข้อ 3.1 และต้องเคาะใน ST0-T19
- **หลัก ERP-agnostic**: core ห้ามรู้จัก KRS — ทุกอย่างที่เกี่ยวกับ KRS อยู่ใน ST8 เท่านั้น; ST3–ST7 ทดสอบด้วย `StandaloneProvider`/`DemoProvider`

---

## 2. งานราย stage (ST0–ST9)

## ST0 — เตรียมการและ freeze

**เป้าหมาย:** ตัดสินใจเทคนิคครบ มี repo + CI + environment + แกน API/multi-tenant/UI ที่งานทุก stage ต่อยอดได้ทันที
และมีคำตอบ (หรือค่า default ที่เจ้าของรับ) ของคำถามที่กระทบ schema ก่อน freeze

**สิ่งที่ต้องมีก่อนเริ่ม:** เจ้าของยืนยันขอบเขตเฟส 0 ตามไฟล์นี้ (และคำตอบกลุ่ม A ใน `plan/05-decisions-needed.md`) · ร่าง ADR ใน `plan/02-tech-decisions.md` · ผลเทียบ docs ↔ spec ใน `plan/00a`, `plan/00b` · ชุดคำถาม `plan/06-questions-accountant.md`, `plan/08-questions-krs.md` พร้อมผู้ตอบ (นักบัญชี, ทีม KRS)

| ID | งาน | อ้างอิง | ขนาด | ต้องเสร็จก่อน | เกณฑ์ตรวจรับ | ตัดได้? |
|---|---|---|---|---|---|---|
| ST0-T01 | เคาะ ADR: frontend framework, เครื่องมือ monorepo, job queue, PDF engine, object storage, cloud/region ในไทย, ผู้ให้บริการแผนที่/geocode, อีเมล/SMS, รูปแบบ LINE OA | J Data residency; docs/04 "สิ่งที่ยังต้องตัดสินใจ"; spec12 Q-D1, Q-D3, Q-D5 | S | — | ADR ทุกข้ออยู่ใน repo สถานะ "ตัดสินแล้ว" ไม่มี TBD | ไม่ — บล็อกทุก stage |
| ST0-T02 | Monorepo scaffold: api (NestJS), web, worker, package ร่วม, lint/format/test runner, `CLAUDE.md` + แม่แบบ task สำหรับ AI agent (นิยาม "เสร็จ" ต่อ slice) | 01§1 ข้อ 2; 01§2 | S | T01 | clone ใหม่แล้ว install + build + test ผ่านด้วยคำสั่งเดียว | ไม่ — ฐานของทุกงาน |
| ST0-T03 | CI/CD + environment dev/staging/production (region ไทย), migration ย้อนกลับได้, สแกน CVE ทุก build, structured log มี requestId/tenantId, error tracking | J Dependency scanning, Data residency; NFR Environments, Deploy | M | T02 | merge เข้า main แล้ว deploy staging อัตโนมัติ; CVE ระดับ critical ทำ build แดง | ไม่ — ต้องมีที่ deploy |
| ST0-T04 | ฐาน multi-tenant: ตาราง `tenant`, `tenant_id` ทุกตาราง, Prisma extension ใส่ tenant อัตโนมัติ, ตัวสร้าง RLS policy ผูก `app.tenant_id`, unique key ขึ้นต้นด้วย `tenant_id` | J Tenant isolation; 01§1 ข้อ 3; 02§4 | M | T02 | query ที่ไม่ตั้ง session var ได้ 0 แถว; test ยืนยัน RLS กันได้แม้ข้าม Prisma extension | ไม่ — ข้อมูลลูกค้าจริง |
| ST0-T05 | Harness ทดสอบแยก tenant อัตโนมัติ: (1) ทุกตารางต้องมี `tenant_id` + RLS (2) วนทุก route ที่ลงทะเบียนไว้ ใช้ token ของ tenant B เรียก resource ของ tenant A ต้องได้ 404 | J Tenant isolation; G1 Error (404 ข้าม tenant); spec11§3 | M | T04, T06 | เพิ่มตารางหรือ route ที่ไม่มี RLS/ไม่ถูกทดสอบ → CI แดง | ไม่ — ข้อมูลลูกค้าจริง |
| ST0-T06 | API plumbing 1: โครง `/v1`, camelCase, ID prefix, รูปแบบเงิน/เวลา, exception filter `application/problem+json` + catalog `code` + `requestId`, schema validation ทุก DTO | G1 URL & naming, Error RFC 9457; J Input validation; 01§5.1 | M | T02 | ทุก 4xx/5xx ของ endpoint ตัวอย่างเป็น problem+json มี `code`; DTO ไม่มี schema → lint แดง | ไม่ — ทุก endpoint ใช้ |
| ST0-T07 | API plumbing 2: middleware `Idempotency-Key` (ตาราง `idempotency_key` 24 ชม.) | G1 Idempotency; 01§3.7 | M | T06 | POST ซ้ำ key+body เดิมได้ response เดิม + `Idempotent-Replayed`; body ต่าง 422; กำลังทำอยู่ 409 | ไม่ — กันสร้างซ้ำ |
| ST0-T08 | API plumbing 3: ตัวช่วย list — cursor (keyset `updatedAt,id`), filter/sort/`fields`/`expand`, `updatedAfter` + ETag/`If-Match` จาก `version` | G1 Pagination, Concurrency; 01§5.1 | M | T06 | เดิน cursor ผ่าน 10,000 แถว seed ไม่ซ้ำไม่ตก; `If-Match` ไม่ตรง → 412 | ไม่ — ทุกตารางใช้ |
| ST0-T09 | OpenAPI 3.1 สร้างจาก decorators ที่ `GET /v1/openapi.json` + CI diff gate + generate TS client ให้ web | G1 OpenAPI & SDK (ส่วน generate); NFR Deploy | S | T06 | PR ที่ลบ field ออกจาก response ทำ CI แดง; web ใช้ client ที่ generate | ไม่ — UI ผูกกับ client นี้ |
| ST0-T10 | ตัวช่วย state machine: เขียน `doc_status_history` + `domain_event` ใน transaction เดียวกับการเปลี่ยนสถานะ; transition ผิด → 409 `invalid_state_transition` | 01§4, 01§3.7, 01§6.2 | M | T04, T06 | เอกสารตัวอย่างเปลี่ยนสถานะแล้วมี history + event 1 แถว; transition ผิดได้ 409 | ไม่ — ทุกเอกสารใช้ |
| ST0-T11 | Job framework: queue, ตาราง job, `GET /v1/jobs/{id}` (สถานะ + progress), scheduler รายเวลา, หยิบงาน round-robin ต่อ tenant | G1 Bulk/async (ฐาน); 02§4 Fairness | M | T04, T06 | job ตัวอย่างของ 2 tenant ถูกหยิบสลับกัน; อ่านสถานะ pending→running→succeeded ผ่าน API | ไม่ — import/invoice run ใช้ |
| ST0-T12 | Security baseline: TLS/HSTS, cookie `Secure HttpOnly SameSite`, CSP/X-Frame-Options/Referrer-Policy, กัน CSRF, ตัด secret ออกจาก log, ตัวช่วยเข้ารหัส AES-256-GCM (key ใน KMS, หมุน key ได้) | J ขนส่งข้อมูล, เก็บข้อมูลลับ, Secret ใน log, Security headers | M | T03 | สแกน header ผ่าน; test ยืนยัน log ไม่มี password/token; ค่าเข้ารหัสอ่านตรงจาก DB ไม่ได้ | ไม่ — ข้อมูลลูกค้าจริง |
| ST0-T13 | UI shell: design tokens, sidebar (กลุ่มเมนู + ตัวนับ), top bar, layout, routing, ต่อ API client, หน้า error/empty | I UI pattern มาตรฐาน; spec00§6; docs/03 | M | T01, T09 | เปิด staging เห็น shell + เมนูจำลอง; เรียก endpoint ตัวอย่างผ่าน client ที่ generate | ไม่ — ทุกหน้าจออยู่ในนี้ |
| ST0-T14 | ชุด pattern UI: ตาราง (filter ใต้หัวคอลัมน์, เลือกคอลัมน์, cursor paging, tab สถานะ + ตัวนับ, KPI card), drawer, ฟอร์ม (แสดง `errors[]` จาก problem+json), status chip, route chip "A → B", ที่อยู่บรรทัดเดียว + tooltip | I UI pattern มาตรฐาน; spec00§6 | L | T13 | หน้าตัวอย่าง "รายการ → drawer → ฟอร์ม" ใช้ component ชุดนี้ล้วน มี test ต่อ component | ไม่ — ลดงานทุกหน้าหลังจากนี้ |
| ST0-T15 | i18n: catalog TH/EN/中文, สลับภาษาต่อผู้ใช้, วันที่ พ.ศ./ค.ศ., รูปแบบเงิน, lint ห้าม hard-code ข้อความ | I ภาษา; NFR Localization; spec11§6 | S | T13 | CI แดงเมื่อ key ขาดใน TH หรือ EN; สลับภาษาบนหน้าตัวอย่างได้ | ไม่ — แก้ย้อนหลังแพง |
| ST0-T16 | Seed/demo: tenant 2 ราย (ใช้ทดสอบ isolation) + บริษัทขนส่งตัวอย่าง รันซ้ำได้; ทุก stage เพิ่ม seed ของตัวเอง | NFR Environments | S | T04 | รัน seed 2 ครั้งข้อมูลเท่าเดิม; staging มี tenant เดโมพร้อมใช้ | ไม่ — เดโมและ test ใช้ |
| ST0-T17 | PDF engine: HTML → PDF ฟอนต์ไทย, พ.ศ./ค.ศ., A4, เก็บไฟล์แบบ immutable, golden-file test | F1 ภาษาไทย/ฟอนต์ (ฐาน); J เอกสารภาษี (PDF ณ วันออก) | M | T01, T03 | PDF ตัวอย่างสระ/วรรณยุกต์ไม่ลอย เทียบ golden ผ่านใน CI | ไม่ — เอกสารภาษีทุกใบใช้ |
| ST0-T18 | ชุดคำถามภายนอก: นักบัญชี (01§8.2 12 ข้อ + spec12 กลุ่ม Q-B) และ KRS (01 A.6 17 ข้อ) — ส่ง ติดตาม บันทึกคำตอบ; ข้อที่ยังไม่ตอบกำหนด "ค่า default + สวิตช์ตั้งค่า" | 01§8.2; 01 A.6; docs/04 "สิ่งที่ยังต้องตัดสินใจ" | S | — | ตารางคำถาม → คำตอบ → ผลต่อ schema ครบทุกข้อ มีผู้ตอบ/วันที่ หรือ default ที่เจ้าของเซ็นรับ | ไม่ — freeze schema บัญชี |
| ST0-T19 | Reconcile docs ↔ spec แล้ว freeze: ตารางตัดสินชื่อ/enum/ขอบเขตที่ต่างกัน (ข้อ 3.1) → Prisma schema v0 (ตาราง ST1–ST4 freeze, ST5–ST6 เป็นร่าง) + contract ของ mock KRS เป็น JSON schema | 01§3–4; 01 A.1, A.3; spec10; spec12§3–4 | M | T18 | เอกสารตัดสินครบทุกข้อใน 3.1; `prisma validate` ผ่าน; schema mock KRS อยู่ใน repo | ไม่ — กันรื้อ schema |

**เสร็จ stage เมื่อ**
- CI เขียว: unit + integration + harness แยก tenant (ครอบทุกตาราง/route ที่มี)
- deploy staging อัตโนมัติจาก main และ rollback migration ได้ 1 ขั้น
- `GET /v1/openapi.json` ใช้งานได้ และ diff gate ทำงานใน PR
- ADR ไม่มีข้อ "เปิด" ค้าง; ตารางคำถามนักบัญชี/KRS มีคำตอบหรือ default ที่เซ็นรับ
- schema v0 และตารางตัดสินชื่อ/enum ถูก merge
- หน้าตัวอย่างบน UI shell มีข้อความ TH/EN ครบ (中文 fallback เป็น EN ได้)

**เดโมท้าย stage**
1. เปิด PR ที่ลบ field จาก response → CI แดงเพราะ OpenAPI diff
2. เรียก endpoint ตัวอย่างด้วย token ของ tenant B กับข้อมูล tenant A → 404 แบบ problem+json
3. POST ซ้ำด้วย `Idempotency-Key` เดิม → ได้ response เดิม
4. เปิด staging: หน้าตัวอย่างตาราง → drawer → ฟอร์ม สลับ TH/EN และ พ.ศ./ค.ศ.
5. ดาวน์โหลด PDF ตัวอย่างฟอนต์ไทย

---

## ST1 — Platform และองค์กร

**เป้าหมาย:** ผู้ใช้เข้าระบบได้อย่างปลอดภัย มีสิทธิ์ตาม role มีนิติบุคคล/สาขา/เลขเอกสาร และมี audit log
ทีม Innovera สร้าง tenant และเข้าช่วยลูกค้าได้จาก admin portal ขั้นต่ำ

**สิ่งที่ต้องมีก่อนเริ่ม:** ST0 ครบ · ผู้ให้บริการอีเมลพร้อมใช้ (ST0-T01) · คำตอบนักบัญชีข้อ 4 (ชุดเลขต่อสาขา/ต่อปี หรือเดียวทั้งบริษัท — 01§8.2) หรือ default ที่เซ็นรับ

| ID | งาน | อ้างอิง | ขนาด | ต้องเสร็จก่อน | เกณฑ์ตรวจรับ | ตัดได้? |
|---|---|---|---|---|---|---|
| ST1-T01 | Login อีเมล + รหัสผ่าน: schema user/membership, argon2id, rate limit 5 ครั้ง/15 นาที ต่อบัญชีและ IP, ล็อก 15 นาที, หน้า login | A1 Login; J Rate limiting (ส่วน login); spec01§3 | M | ST0-T04, ST0-T06, ST0-T13 | ผิดครั้งที่ 6 ใน 15 นาทีถูกล็อก; hash ใน DB เป็น argon2id | ไม่ — ทางเข้าระบบ |
| ST1-T02 | นโยบายรหัสผ่าน: ≥ 12 ตัว, ตรวจ HIBP แบบ k-anonymity, ห้ามซ้ำ 5 ครั้งล่าสุด, ไม่บังคับเปลี่ยนตามเวลา | A1 นโยบายรหัสผ่าน | S | T01 | รหัสที่อยู่ใน HIBP หรือซ้ำของเดิมถูกปฏิเสธพร้อมข้อความไทย | ใช่ — ผู้ใช้ pilot มีน้อย |
| ST1-T03 | อีเมล transactional (adapter + template TH/EN) และลืมรหัสผ่าน: ลิงก์ 30 นาที ใช้ครั้งเดียว ไม่เผยว่ามีอีเมลในระบบ | A1 ลืมรหัสผ่าน | M | T01 | อีเมลที่มี/ไม่มีในระบบได้ response เดียวกัน; ลิงก์ใช้ซ้ำหรือเกิน 30 นาทีใช้ไม่ได้ | ไม่ — ผู้ใช้ต้องกู้บัญชีเองได้ |
| ST1-T04 | Session: access JWT 15 นาที + refresh 7 วัน (httpOnly), idle 8 ชม. ตั้งได้, จำอุปกรณ์ 30 วัน, `tokenVersion` ใน JWT — bump แล้วทุก session หลุดทันที; เพิ่มสิทธิ์ขึ้น banner ให้ refresh | A1 Session, Token version ต่อ user | M | T01 | bump `tokenVersion` แล้ว request ถัดไปของ session เดิมได้ 401 | ไม่ — ถอนสิทธิ์ต้องมีผลทันที |
| ST1-T05 | 2FA TOTP: ลงทะเบียน, backup code 10 ชุด, บังคับ owner/accounting ที่อนุมัติได้/Innovera admin, ตั้งบังคับทั้งองค์กร, guard "step-up 2FA" ใช้ซ้ำได้ | A1 2FA TOTP; A3 กฎเพิ่มเติม (step-up) | M | T04 | role ที่ถูกบังคับเข้าไม่ได้จนกว่าจะตั้ง TOTP; backup code ใช้ได้ครั้งเดียว | ไม่ — impersonate บนข้อมูลจริง |
| ST1-T06 | Magic-link infrastructure: token เซ็น HMAC + หมดอายุ + จำกัด action ต่อลิงก์ + เพิกถอนได้, route group `/public/*` มี rate limit, serializer ที่ไม่ส่งราคาขายออกทางลิงก์ | A1 เข้าถึงโดยไม่ login; J Magic link; 01§5.5 | M | T01, ST0-T12 | ลิงก์หมดอายุ/ถูกเพิกถอน/ทำ action นอกรายการ → 404; payload ไม่มี field ราคาขาย (test) | ไม่ — M10 และ settlement ใช้ |
| ST1-T07 | เชิญผู้ใช้: อีเมลลิงก์ 7 วัน กำหนด role ตอนเชิญ นับ seat ตาม plan | A2 เชิญผู้ใช้ | M | T03, T12 | เชิญ → รับลิงก์ → ตั้งรหัส → เข้าได้ด้วย role ที่กำหนด; เกิน seat ถูกปฏิเสธ | ไม่ — ทีมลูกค้าต้องเข้าได้ |
| ST1-T08 | ไฟล์แนบ: ตาราง `document`, object storage, presigned upload/download หมดอายุ, 10 MB/ไฟล์, ตรวจ MIME จริง; `POST /documents`, `GET /documents/{id}` | I ไฟล์แนบ; G2 #4 documents (ฐาน); 01§5.2 | M | ST0-T06 | อัปโหลดไฟล์ปลอมนามสกุลถูกปฏิเสธ; URL ดาวน์โหลดหมดอายุตามเวลา | ไม่ — POD/ลายเซ็น/PDF ใช้ |
| ST1-T09 | โปรไฟล์: ชื่อ เบอร์ ภาษา timezone ลายเซ็นดิจิทัล (ใช้บนเอกสาร/50 ทวิ) | A2 โปรไฟล์ | S | T01, T08 | เปลี่ยนภาษาแล้ว UI เปลี่ยน; ลายเซ็นที่อัปโหลดอ่านกลับได้ | ไม่ — 50 ทวิ ใช้ลายเซ็น |
| ST1-T10 | ระงับ / เปิดใช้ / ลบผู้ใช้: ระงับ = bump `tokenVersion`; ลบ = anonymize ใน audit แต่เก็บ record | A2 ระงับ/เปิดใช้/ลบ | S | T04 | ระงับแล้ว session ที่เปิดอยู่หลุดทันที; ผู้ใช้ที่ลบยังเห็นใน audit แบบ anonymize | ไม่ — พนักงานออกต้องตัดสิทธิ์ |
| ST1-T11 | ประวัติ login: เวลา IP อุปกรณ์ ผล + job ลบเมื่อครบ 1 ปี + หน้าดูของ admin | A2 ประวัติ login | S | T01 | login สำเร็จ/ล้มเหลวเกิดแถวประวัติ; กรองตามผู้ใช้ได้ | ใช่ — ไม่กระทบเอกสาร |
| ST1-T12 | Role และ permission `{module}.{view/manage}` + permission พิเศษ; seed role มาตรฐานตามตาราง A3; guard ฝั่ง API; UI ซ่อนตามสิทธิ์; เปลี่ยน role ต้อง step-up | A3 Role และ permission; spec01§12 | L | T01, T05 | test ตามตาราง A3: แต่ละ role เรียก endpoint ตัวแทนของแต่ละแถวได้/ไม่ได้ตรงตาราง | ไม่ — แยกหน้าที่บัญชี/จัดรถ |
| ST1-T13 | Field permission ราคาขาย/ราคาซื้อ: ตัด field ที่ชั้น serializer (ไม่ใช่ซ่อนที่ UI); principal ของ carrier ไม่มีทางเห็นราคาขาย | A3 ดู/แก้ราคาขาย, ดูราคาซื้อรถร่วม | M | T12 | Dispatcher (default) เรียก API แล้ว response ไม่มี field ราคาขาย | ไม่ — กันราคารั่วทางลิงก์ |
| ST1-T14 | `company` + `branch`: ชื่อจดทะเบียน, เลขผู้เสียภาษี 13 หลัก (ตรวจ checksum), สถานะจด VAT, โลโก้/ลายเซ็น, รหัสสาขา 5 หลัก, ที่อยู่ ภ.พ.20, `hq_prints_for_all`, สาขาออกเอกสาร default; หน้า "นิติบุคคลและสาขา" | A4 legal_entity, company_branch; 01§3.1 | M | T12, T08 | เลข 13 หลักผิด checksum → 422; สร้าง 2 นิติบุคคล + สาขา 00000/00001 ได้ | ไม่ — หัวเอกสารภาษี |
| ST1-T15 | `document_sequence`: ต่อ (นิติบุคคล × สาขา × ประเภทเอกสาร × งวด), prefix ตั้งเอง (พ.ศ./ค.ศ.), ฟังก์ชันออกเลขด้วย row lock ใน transaction ของผู้เรียก, หน้าตั้งค่า | A4 Number series; 01§3.5 | M | T14 | ออกเลขพร้อมกัน 50 request ได้เลขเรียงไม่ซ้ำไม่ข้าม; rollback แล้วเลขไม่ถูกใช้ | ไม่ — เลขใบกำกับต้องเรียง |
| ST1-T16 | Routing เอกสารตามนิติบุคคล: resolver "ออกบิลในนาม" / "จ้างในนาม" (default ระดับ tenant; override ที่ลูกค้า/carrier เพิ่มใน ST2-T01, T05) | A4 Routing เอกสารตามนิติบุคคล | S | T14 | resolver คืน company/branch ตามลำดับ override → default (unit test 4 กรณี) | ไม่ — KRS ออกบิลคนละบริษัท |
| ST1-T17 | ตั้งค่าองค์กร: registry `tenant_setting` แบบมี type + หน้า UI (timezone, พ.ศ./ค.ศ., VAT/WHT default, รอบวางบิล, free time, นโยบาย 2FA/session, โหมด tax point, แยก/รวมเอกสาร VAT) — stage ถัดไปลงทะเบียน key เพิ่ม | I ตั้งค่าองค์กร; spec01§13 | M | T14 | แก้ค่าใน UI แล้ว API อ่านค่าใหม่; ค่าผิด type ถูกปฏิเสธ | ไม่ — กฎภาษีอ่านจากที่นี่ |
| ST1-T18 | Feature flag ตาม plan + override ต่อ tenant + ตรวจซ้ำใน cron job | A5 Feature flag ตาม plan | M | ST0-T11 | ปิด flag แล้ว endpoint ที่ gate ได้ 403 และ cron ของ tenant นั้นข้าม | ใช่ — pilot มี 2 tenant |
| ST1-T19 | Framework นำเข้า Excel แบบ dry-run: อัปโหลด → preview ทุกแถว → รายงานแถวผิดพร้อมเหตุผล → ยืนยัน commit; template .xlsx ดาวน์โหลดได้; ไฟล์ใหญ่วิ่งเป็น job; interface `ImportSpec` ต่อ entity | A5 Import Excel dry-run; I Import/Export (ขา import); spec02§11 | L | T08, ST0-T11 | ไฟล์ 1,000 แถวมีผิด 3 แถว: dry-run ระบุ 3 แถว + เหตุผล และไม่มีข้อมูลถูกเขียนจนกดยืนยัน | ไม่ — ย้ายข้อมูล KRS/ลูกค้า |
| ST1-T20 | กลไก bootstrap ค่าเริ่มต้นภาษาไทยตอนสร้าง tenant (ชุดเลขเอกสาร, VAT/WHT default, รูปแบบเอกสาร; master เพิ่มชุดของตัวเองใน ST2) | A5 ค่าเริ่มต้นภาษาไทยพร้อมใช้ | S | T15, T17 | สร้าง tenant ใหม่แล้วมีชุดเลขและค่าภาษี default ครบโดยไม่ต้องตั้ง | ไม่ — K5 ห้ามให้เราตั้งให้ |
| ST1-T21 | Setup checklist: องค์กร → สาขา → เลขเอกสาร → ภาษี default → import master → เชิญทีม → (เลือก) connector; แสดง % บนหน้าแรก ตรวจขั้นที่เสร็จเอง | A5 Setup checklist; I Onboarding wizard; spec01§4 | M | T14, T15, T17, T07, T19 | tenant ใหม่เห็น 0%; ทำครบแต่ละขั้นแล้ว % เพิ่มเองโดยไม่ต้องติ๊ก | ใช่ — เราตั้ง pilot ให้เอง |
| ST1-T22 | Audit log: ทุก create/update/delete ทุก entity (ใคร อะไร diff jsonb เวลา IP เหตุผล override), append-only ระดับ DB, แท็บประวัติต่อ entity + หน้ารวม, เก็บ 5 ปี | A7 Audit log; I ประวัติการแก้ไขต่อเอกสาร; spec11§5 | L | ST0-T10, T12 | แก้ record แล้วมี diff ใน audit; คำสั่ง UPDATE/DELETE บนตาราง audit ถูก DB ปฏิเสธ | ไม่ — หลักฐานเอกสารการเงิน |
| ST1-T23 | แกนแจ้งเตือน: ตาราง notification + กระดิ่ง in-app + ช่องอีเมล + interface ช่องทาง (LINE/SMS เสียบใน ST3-T21) | I การแจ้งเตือน (ฐาน) | M | T03 | เรียก `notify()` แล้วผู้รับเห็นใน in-app และได้อีเมล | ไม่ — เตือนหมดเวลา/MISMATCH |
| ST1-T24 | Admin portal ขั้นต่ำ: route group + login แยก บังคับ 2FA, `platform_user` (super_admin / support / billing), สร้าง/ระงับ tenant, ตั้ง plan/quota รถ, impersonate (claim `act`, audit, อีเมลแจ้ง owner ทุกครั้ง) | A6 Innovera platform admin; 02§5 (Tenants); 01§5.4 | L | T05, T22 | สร้าง tenant จาก portal ได้; impersonate แล้ว audit มีทั้ง `sub` และ `act` และ owner ได้อีเมล | ไม่ — สร้าง tenant pilot |

**เสร็จ stage เมื่อ**
- test เขียวทั้งหมด รวม test ตามตารางสิทธิ์ A3
- harness แยก tenant ครอบตารางใหม่ทุกตัว (user, company, branch, document_sequence, document, audit, notification ฯลฯ)
- OpenAPI อัปเดตและ diff gate ผ่าน; ไม่มี endpoint ที่ UI ใช้แต่ไม่อยู่ใน spec (ยกเว้น auth flow)
- ข้อความ TH/EN ครบทุกหน้าและทุกอีเมล
- ทดสอบออกเลขพร้อมกัน (concurrency) ผ่าน
- ทุก action ใน stage นี้ปรากฏใน audit log

**เดโมท้าย stage**
1. ทีม Innovera สร้าง tenant ใหม่จาก admin portal → owner ได้อีเมลเชิญ ตั้งรหัส + TOTP
2. owner เพิ่มนิติบุคคล 2 ราย + สาขา ตั้ง prefix เลขเอกสาร แล้วเชิญ Dispatcher
3. Dispatcher login: ไม่เห็นเมนูบัญชี และ API ไม่ส่ง field ราคาขาย
4. owner ระงับ Dispatcher → หน้าจอของ Dispatcher หลุดทันที
5. เปิด audit log เห็นทุกขั้นข้างต้น + support impersonate แล้ว owner ได้อีเมลแจ้ง

---

## ST2 — Master data + Fleet P0

**เป้าหมาย:** ข้อมูลหลักครบพอให้รับงาน คิดราคา (ขาขาย/ขาซื้อ) และจัดรถได้ โดยทุกตัวมี external id, import Excel, ประวัติ
ทะเบียนรถมีเอกสารและการเตือนต่ออายุ รถร่วมมีเอกสารบังคับก่อนรับงาน

**สิ่งที่ต้องมีก่อนเริ่ม:** ST1 ครบ (สิทธิ์, company/branch, import framework, audit) · คำตอบนักบัญชีข้อ 2 (ค่าน้ำมัน/ทางด่วน/ค่ารอ เป็นค่าขนส่งหรือค่าบริการ — กำหนด default ของ `service_item`) · เลือกผู้ให้บริการ geocode (ST0-T01) · ตัวอย่างข้อมูล master ของ KRS และ tenant standalone

| ID | งาน | อ้างอิง | ขนาด | ต้องเสร็จก่อน | เกณฑ์ตรวจรับ | ตัดได้? |
|---|---|---|---|---|---|---|
| ST2-T01 | ลูกค้า (slice ต้นแบบของ master ทุกตัว: ค้นหา/กรอง, สร้าง/แก้/ปิดใช้ ไม่ลบถ้ามีเอกสารอ้างถึง, `externalId` + `PUT /customers/external/{id}`, export, ประวัติ) ฟิลด์: เลข 13 หลัก, รหัสสาขา 5 หลัก, ที่อยู่ออกใบกำกับ, ผู้ติดต่อ, เครดิตวัน, `billing_cycle`, ออกบิลในนาม, สถานะจด VAT, รับ e-Tax ได้ไหม, `tax_invoice_mode`, free time | B (กฎร่วมทุก master), B ลูกค้า; 01§3.2; spec02§0–1 | L | ST1-T12, ST1-T16, ST1-T22 | เลข 13 หลักผิด → 422; ลูกค้าที่มีเอกสารอ้างถึงลบไม่ได้แต่ปิดใช้ได้; upsert ด้วย external id ซ้ำได้ 200 ไม่เกิดแถวใหม่ | ไม่ — ผู้ซื้อบนใบกำกับ |
| ST2-T02 | สถานที่ `customer_site`: ชื่อ ที่อยู่ พิกัด รัศมี geofence เวลาเปิด-ปิด ประเภทรถที่เข้าได้ service time ผู้ติดต่อ หมายเหตุ alias หลายตัว | B จุดส่ง/สถานที่; 01§3.2; spec02§2 | M | T01 | สร้างจุดส่งที่มี alias 2 ตัวแล้วค้นด้วย alias เจอ | ไม่ — ต้นทาง/ปลายทางของงาน |
| ST2-T03 | Geocode/distance provider (interface เลือกผู้ให้บริการผ่าน config) + geocode อัตโนมัติ + คนยืนยัน + สถานะ `FAILED` ส่งต่อใบค้าง | G4 Map/geocode; B จุดส่ง (geocode) | M | T02, ST0-T01 | ที่อยู่จริงได้พิกัดและรอคนยืนยัน; ที่อยู่มั่วได้ `geocode_status = FAILED`; test ใช้ provider จำลอง | ใช่ — กรอกพิกัด/ระยะมือได้ |
| ST2-T04 | ประเภทรถ + capability tags (ห้องเย็น ติดเครน ลากตู้) + seed ภาษาไทย | B รถ; A5 ค่าเริ่มต้น (เนื้อหา) | S | ST1-T20 | tenant ใหม่มีประเภทรถไทยพร้อมใช้ แก้/เพิ่มได้ | ไม่ — key ของ rate card |
| ST2-T05 | Carrier (รถร่วม): บุคคล/นิติบุคคล, เลขผู้เสียภาษี/บัตรประชาชน, สาขา, บัญชีธนาคาร (เข้ารหัส), อัตรา WHT default 1%, เงื่อนไขจ่าย, parent carrier, LINE/เบอร์, จ้างในนาม, เพดานเที่ยว/วัน, priority, `require_pod_to_pay`; เป็น principal แยกไม่นับ seat | B Carrier; A3 กฎเพิ่มเติม (principal แยก); 01§3.2 | M | T01, ST0-T12 | เลขบัญชีธนาคารเข้ารหัสใน DB และแสดงแบบปิดบางส่วน; carrier ไม่ใช่ driver (ตารางแยก) | ไม่ — ผู้รับ 50 ทวิ |
| ST2-T06 | รถ: ทะเบียน จังหวัด ประเภท น้ำหนัก/ปริมาตร ownership OWN/SUBCONTRACT (+carrier บังคับ) GPS สถานะ พร้อม/ซ่อม/จอด/ปลดระวาง + ทะเบียนรถขยาย (เลขตัวถัง/เครื่อง ยี่ห้อ/รุ่น/ปี สี น้ำหนักเปล่า/บรรทุก เชื้อเพลิง ความจุถัง เลขไมล์ หัวลาก–หาง ต้นทุนซื้อ/วันซื้อ/วิธีคิดค่าเสื่อม รูปรถ); นับรถ active | B รถ; B2.1 ส่วน 1 ทะเบียนรถขยาย; 01§3.2, 01§3.8; spec06§1 | L | T04, T05 | รถ SUBCONTRACT ที่ไม่ระบุ carrier → 422; จับคู่หัวลาก–หางแล้วเห็นทั้งสองฝั่ง; เลขไมล์ถอยหลังถูกปฏิเสธ | ไม่ — รถบนเที่ยวและใบแจ้งหนี้ |
| ST2-T07 | หน้าทะเบียนรถ + โปรไฟล์พื้นฐาน: tab สถานะพร้อมตัวนับ, คอลัมน์ badge เอกสารใกล้หมด, โปรไฟล์ (ข้อมูลรถ + เอกสาร) — ไม่รวม timeline/ต้นทุน (P1) | B2.2 ทะเบียนรถ/โปรไฟล์รถ | M | T06 | เปลี่ยนสถานะรถแล้วตัวนับ tab เปลี่ยน; เปิดโปรไฟล์เห็นเอกสารของคันนั้น | ไม่ — หน้าหลักของรถ |
| ST2-T08 | คนขับ: ชื่อ เบอร์ บัตรประชาชน (เข้ารหัส) ใบขับขี่ + ประเภท + วันหมดอายุ ประเภทคนขับ 3 แบบ (+carrier) รถประจำ สถานะ | B คนขับ; 01§3.2 | M | T05, T06 | เลขบัตรไม่แสดงเต็มใน API; คนขับของ carrier ต้องผูก carrier | ไม่ — snapshot บนเที่ยว |
| ST2-T09 | เส้นทาง (OD pair: ต้นทาง ปลายทาง ระยะทาง เวลามาตรฐาน ค่าผ่านทาง) + คลัง/ต้นทาง (ชื่อ ที่อยู่ พิกัด ช่องโหลด เวลาทำการ) | B เส้นทาง, B คลัง/ต้นทาง | M | T02 | สร้าง OD ซ้ำคู่เดิมถูกปฏิเสธ; ระยะทางถูกใช้โดย pricing (ST2-T15) | ไม่ — key ของ rate card |
| ST2-T10 | สินค้า/หน่วย: รหัส ชื่อ หน่วย น้ำหนัก/ปริมาตร อุณหภูมิ สินค้าอันตราย `externalId` | B สินค้า/หน่วย | S | T01 | CRUD + upsert ด้วย external id ผ่าน test ต้นแบบ master | ไม่ — รายการใน order |
| ST2-T11 | `service_item` (accessorial catalog): รหัส ชื่อ ราคา default หน่วย `vat_type` (EXEMPT_TRANSPORT/VAT_7/ZERO_RATED) `wht_rate` (1%/3%) ฝั่ง (ขาย/ซื้อ/ทั้งคู่) + ตัวช่วย snapshot ลงเอกสาร + seed ไทย | B Accessorial catalog; A5 ค่าเริ่มต้น (เนื้อหา); 01§3.2; spec02§6 | M | ST1-T20, ST0-T18 | แก้ราคา/VAT ใน catalog แล้ว snapshot ที่ copy ไว้ก่อนหน้าไม่เปลี่ยน | ไม่ — VAT/WHT ต่อบรรทัด |
| ST2-T12 | `reason_code`: หมวด (ค้างวางแผน/ส่งไม่สำเร็จ/ปฏิเสธรับ/ไม่เซ็นเอกสาร/ล่าช้า/dispute), ธงต่อ reason (บังคับรูป บังคับโน้ต auto-reschedule แสดงบน tracking), รหัสระบบลบไม่ได้, seed ไทย, snapshot ข้อความลงงาน | B Reason master; A5 ค่าเริ่มต้น (เนื้อหา); 01§3.2 | M | ST1-T20 | tenant ใหม่มีชุดเหตุผลไทยครบทุกหมวด; ลบรหัสระบบ → 409 | ไม่ — ใบค้าง/ใบลดหนี้ใช้ |
| ST2-T13 | Rate card ขาขาย (ต่อลูกค้า): key (ต้นทาง, ปลายทาง, ประเภทรถ), วันเริ่ม-หมดอายุ ห้ามซ้อนช่วง, สถานะ DRAFT → ACTIVE → EXPIRED (เฟส 0 Admin เปิดใช้ทันที), ธง NEAR_EXPIRY 30 วัน, แก้ในฟอร์ม | B Rate card ขาขาย; 01§3.2; spec02§5 | L | T01, T04, T09, T11 | สร้าง rate ช่วงเวลาซ้อน key เดิม → 422; rate หมดอายุไม่ถูกเลือกใช้ | ไม่ — ราคาบนใบแจ้งหนี้ |
| ST2-T14 | Rate card ขาซื้อ (ต่อ carrier) โครงเดียวกัน + endpoint "ราคา 5 ครั้งล่าสุดที่จ้างรายนี้" | B Rate card ขาซื้อ | M | T13, T05 | ใช้ component/ตัวตรวจชุดเดียวกับขาขาย (`side = BUY`); endpoint คืนรายการว่างเมื่อยังไม่เคยจ้าง | ไม่ — ฐาน cost line |
| ST2-T15 | Pricing engine (ฟังก์ชันล้วน ใช้ทั้งสองฝั่ง): เหมาเที่ยว, ตามระยะทาง + ขั้นต่ำ, ตามน้ำหนัก/ปริมาตร/ชิ้น + ขั้นต่ำ, เกิน N จุดคิดเพิ่มต่อจุด, `pricingStatus` AVAILABLE / RATE_MISSING / CALCULATION_FAILURE + breakdown | B1 FLAT_TRIP, PER_DISTANCE, PER_UNIT, เกิน N จุด, สถานะคำนวณ | L | T13 | test แบบตาราง ≥ 20 กรณี รวมตัวอย่างไทยใน B1 (4,500 / 18 บาทต่อ กม. ขั้นต่ำ 1,500 / 350 ต่อตัน / จุดที่ 4 +300) ตรงทุกกรณี | ไม่ — ยอดเงินทุกเอกสาร |
| ST2-T16 | Vehicle-type compatibility: matrix ประเภทรถ × ประเภทงาน/สินค้า/จุดส่ง + ฟังก์ชันคืนรายการคำเตือน | B Vehicle-type compatibility | M | T04, T10, T02 | กฎ "ห้องเย็นเท่านั้น" คืนคำเตือนเมื่อเลือกรถธรรมดา (unit test) | ใช่ — เป็นคำเตือนไม่บล็อก |
| ST2-T17 | เอกสารรถ `vehicle_document`: ประกันภัย (บริษัท เลขกรมธรรม์ ชั้น ทุน เบี้ย วันเริ่ม–หมด), พ.ร.บ., ภาษีประจำปี, ตรอ., ใบอนุญาตประกอบการ, ใบรับรอง GPS DLT; แนบไฟล์; ต่ออายุ = แถวใหม่อ้างฉบับเก่า; ค่าต่ออายุลง `vehicle_cost` หมวด DOCUMENT | B2.1 ส่วน 2 เอกสารและต่ออายุ; 01§3.8; spec06§3 | M | T06, ST1-T08 | ต่ออายุแล้วฉบับเก่ายังอยู่ในประวัติ; ค่าใช้จ่ายเกิดแถว `vehicle_cost` | ใช่ — ไม่กระทบเอกสารภาษี |
| ST2-T18 | เตือนต่ออายุ 60/30/7 วัน: job รายวันตั้งสถานะใกล้หมด/หมด + แจ้ง in-app/อีเมล ไม่เตือนซ้ำ — ใช้กับเอกสารรถ ใบขับขี่ และ rate card ใกล้หมด | B2.1 ส่วน 2 (เตือน); B คนขับ (เตือนหมดอายุ); B Rate card (NEAR_EXPIRY) | M | T17, ST1-T23 | test เลื่อนเวลา: เอกสารหมดใน 30 วันได้การเตือนครั้งเดียวที่จุด 30 วัน | ใช่ — pilot ดูหน้าจอแทนได้ |
| ST2-T19 | หน้าเอกสารรถรวม: ตารางทุกคัน × ทุกประเภท เรียงตามวันหมด, filter "หมดใน 30/60 วัน", อัปโหลดต่ออายุจากหน้าเดียว, export | B2.2 เอกสารรถรวม | M | T17 | filter 30 วันแสดงเฉพาะเอกสารที่หมดใน 30 วัน; ต่ออายุจากหน้านี้ได้ | ใช่ — ดูจากโปรไฟล์รถได้ |
| ST2-T20 | รถร่วมแบบย่อ: เอกสารบังคับก่อนรับงาน (ประกันภัย พ.ร.บ. ใบขับขี่คนขับ) + ฟังก์ชัน `isAssignable()` คืนเหตุบล็อก (override โดย admin พร้อมเหตุผล — ใช้ใน ST3-T14) | B2.1 รถร่วม (SUBCONTRACT) | S | T17, T08 | รถร่วมที่ พ.ร.บ. หมดอายุ → `isAssignable()` คืน false พร้อมเหตุ | ใช่ — pilot ตรวจเอกสารมือได้ |
| ST2-T21 | Carrier อัปโหลดเอกสารรถ/ใบขับขี่เองผ่านลิงก์ (magic link) | B2.1 รถร่วม (อัปโหลดผ่านลิงก์) | S | T20, ST1-T06 | เปิดลิงก์บนมือถือ อัปโหลดไฟล์แล้วขึ้นรอ admin ยืนยัน | ใช่ — admin อัปโหลดแทนได้ |
| ST2-T22 | ค่าเสื่อมรายเดือน (เส้นตรง N ปี) ลง `vehicle_cost` ด้วย job | B2.1 ส่วน 1 (ค่าเสื่อม → vehicle_cost) | S | T06, ST0-T11 | รัน job เดือนเดียวกันซ้ำไม่เกิดแถวซ้ำ; ยอด = ต้นทุนซื้อ ÷ (N × 12) | ใช่ — รายงานต้นทุนเป็น P1 |
| ST2-T23 | Import Excel ทุก master (ลูกค้า จุดส่ง carrier รถ คนขับ เส้นทาง rate card service_item สินค้า) บน framework ST1-T19 + template | A5 Import Excel (เนื้อหา); B (กฎร่วม: import/export) | L | ST1-T19, T01, T02, T05, T06, T08, T09, T10, T11, T13 | import ไฟล์ตัวอย่างของแต่ละ master ผ่าน dry-run และ commit ได้; แถวผิดมีเหตุผลภาษาไทย | ไม่ — ย้าย master ของ pilot |

**เสร็จ stage เมื่อ**
- test เขียว รวม test ตารางของ pricing engine
- harness แยก tenant ครอบตาราง master/fleet ใหม่ทุกตัว
- OpenAPI อัปเดต: ทุก master มี CRUD + `PUT /external/{id}` + list แบบ cursor
- ข้อความ TH/EN ครบ; seed ภาษาไทย (ประเภทรถ, service_item, reason_code) มากับ tenant ใหม่
- import ข้อมูลตัวอย่างจริงของ pilot ผ่าน dry-run ครบทุก master
- ทุก master มีแท็บประวัติจาก audit log

**เดโมท้าย stage**
1. สร้าง tenant ใหม่ → มีประเภทรถ / ค่าบริการเสริม / เหตุผล ภาษาไทยพร้อมใช้
2. import ลูกค้า + จุดส่งจาก Excel: dry-run แสดงแถวผิด แก้แล้ว commit
3. สร้าง rate card ขาขายและขาซื้อ แล้วเรียกคำนวณราคา เห็น breakdown และกรณี RATE_MISSING
4. เพิ่มรถร่วม + เอกสาร พ.ร.บ. ที่หมดอายุ → ขึ้น badge และ `isAssignable()` เป็น false
5. เปิดหน้าเอกสารรถรวม filter "หมดใน 30 วัน"

---

## ST3 — Order intake และ Planning/Dispatch

**เป้าหมาย:** งานเข้าจากทุกทางผ่าน domain service เดียว งานที่จัดไม่ได้มี reason code เสมอ
ผู้จัดรถวางแผนบน planning board จ่ายงานรถบริษัทและรถร่วม (ผ่านลิงก์ไม่ต้อง login) ได้ครบ

**สิ่งที่ต้องมีก่อนเริ่ม:** ST2 ครบ (อย่างน้อย T01–T15) · ตัดสินชุด reason code ของใบค้างและสถานะ trip (ST0-T19 — docs/04 กับ docs/01 ใช้ชื่อต่างกัน) · LINE OA พร้อมทดสอบ (ถ้าไม่ตัด ST3-T21) · คำตอบ spec12 Q-D10 (ช่วงเวลาบนกระดาน) และ Q-E1 (เวลารอตอบของรถร่วม)

| ID | งาน | อ้างอิง | ขนาด | ต้องเสร็จก่อน | เกณฑ์ตรวจรับ | ตัดได้? |
|---|---|---|---|---|---|---|
| ST3-T01 | `sales_order` + line + domain service เดียว `upsertOrder()` + source (MANUAL/EXCEL/API/PORTAL/ERP:{connector}) + `externalRef` + badge ทุกหน้า + เลข SO + state machine | C Source ของ order; D1 Order (DO); 01§3.3, 01§4.1 | L | ST2-T01, ST2-T02, ST2-T10, ST2-T15, ST1-T15 | ทุกทางเข้า (UI/import/API/connector) เรียก service เดียวกัน (test ตรวจ call path); order ใหม่มี `pricingStatus` | ไม่ — จุดเริ่มทุก flow |
| ST3-T02 | ฟอร์มกรอกมือฟอร์มเดียว + duplicate จาก order เดิม + template งานประจำ (บันทึก/สร้างจาก template; ตั้งเวลาอัตโนมัติเป็น P1) | C กรอกมือ; spec03§2 | M | T01 | สร้าง order ใหม่จาก duplicate ได้ภายใน 3 คลิก ข้อมูลครบเท่าต้นฉบับ | ไม่ — standalone ไม่มี ERP |
| ST3-T03 | API orders: `POST /orders` (+Idempotency-Key), GET list/one, PATCH, `PUT /orders/external/{externalId}` idempotent; field ที่แก้ไม่ได้หลัง in_transit → 409 | C Upsert ด้วย external id, รับจาก Open API; 01§5.2 #1 | M | T01 | PUT external id เดิม 2 ครั้ง = 1 order; แก้ field ต้องห้ามหลัง in_transit ได้ 409 | ไม่ — ทางเข้าของ connector |
| ST3-T04 | Import order จาก Excel (template + dry-run + รายงานแถวผิด) เรียก `upsertOrder()` | C Import Excel | S | T01, ST1-T19 | ไฟล์ 200 แถวมีผิด 2 แถว: dry-run ชี้ 2 แถว commit ได้ 198 order | ใช่ — คีย์มือ/API แทนได้ |
| ST3-T05 | ทางเข้าจาก connector: port `pullOrders` ที่เรียก upsert เดียวกับ API (ไม่มีทางลัด) ทดสอบด้วย puller จำลอง; ทุกใบเข้าระบบเสมอ | C รับจาก ERP connector; 01§6.1 | S | T03 | puller จำลองส่ง 10 ใบ (3 ใบลูกค้าไม่รู้จัก) → มี 10 order โดย 3 ใบอยู่ ON_HOLD | ไม่ — ทางเข้า SO ของ KRS |
| ST3-T06 | จับคู่อัตโนมัติ: ลูกค้า (externalId), ต้นทาง/ปลายทาง (ข้อความ → site ด้วย alias + fuzzy), rate card → `pricingStatus`; เรียนรู้ alias เมื่อคน map ครั้งแรก | C จับคู่อัตโนมัติ, เรียนรู้ alias | L | T01, ST2-T02, ST2-T15 | map ข้อความปลายทางครั้งแรกด้วยมือ → order ถัดไปข้อความเดิมจับคู่เอง | ไม่ — ลดใบค้างของ KRS |
| ST3-T07 | หน้าใบค้าง: ตารางเดียวของ order ที่ ON_HOLD, badge reason code ครบชุด (12 รหัสใน C), action เคลียร์ต่อรหัส (map ลูกค้า, เลือกจุดส่ง, เพิ่ม rate ฯลฯ) | C หน้าใบค้าง + reason code ครบชุด; 01§4.1 | L | T06, ST2-T12 | order ที่ `CUSTOMER_UNMAPPED` เคลียร์จากหน้านี้แล้วกลับ RECEIVED; ไม่มี order ค้างที่ไม่มี reason code (constraint) | ไม่ — งานต้องมองเห็นเสมอ |
| ST3-T08 | Edit lock: ป้าย "กำลังแก้ไขโดย …" คนอื่น read-only, หมดอายุ 10 นาทีไม่ activity, permission `orders.unlock` | C Edit lock | M | T02 | ผู้ใช้ B เปิด order ที่ A แก้อยู่ → read-only; ครบ 10 นาที lock หลุด | ใช่ — ทีม pilot เล็ก |
| ST3-T09 | `delivery_order` + line จาก SO, แยกเป็นหลาย DO/หลายเที่ยว, รวมหลาย order ของลูกค้าเดียวในเที่ยวเดียว, state machine | C แยก/รวม order; D1 Order (DO); 01§3.3, 01§4.3 | M | T01 | แยก SO เป็น 2 DO แล้วยอดรวมปริมาณเท่าเดิม; DO มีสถานะตาม 01§4.3 | ไม่ — DO คือหน่วยวางบิล |
| ST3-T10 | ยกเลิก/คืนสถานะพร้อม reason; order ที่มี trip ต้องถอดก่อน; ต้นทางแก้หลังวางแผน → `SOURCE_CHANGED_AFTER_PLAN` + เก็บ diff ไม่ทับอัตโนมัติ + หน้ารับ/ไม่รับ diff | C ยกเลิก/คืนสถานะ; 01§3.3 | M | T09 | upsert ที่เปลี่ยนปลายทางหลัง PLANNED ไม่ทับข้อมูล แต่ขึ้นใบค้างพร้อม diff | ไม่ — KRS แก้ SO ระหว่างวัน |
| ST3-T11 | `trip` + `trip_stop`: snapshot รถ/คนขับ/คนขับสำรอง/หาง/carrier ต่อเที่ยว, เลขเที่ยว, ลำดับจุด + planned window, state machine + action API (`/assign`, `/offer`, `/dispatch`, `/complete`, `/cancel`); ยกเลิก trip ปล่อย order ที่ยังไม่ส่ง | D1 Trip, TripStop, สถานะ trip; 01§3.3, 01§4.2, 01§5.2 #3 | L | T09, ST2-T06, ST2-T08 | เปลี่ยนคนขับประจำของรถหลังสร้าง trip แล้ว trip เดิมไม่เปลี่ยน; transition ผิดได้ 409 | ไม่ — หน่วยปฏิบัติการ |
| ST3-T12 | Planning board: pool งานค้างจัดด้านซ้าย (กรอง/group/sort + badge) / timeline รถ × วันด้านขวา ลากวาง ปรับขนาดได้; เที่ยวซ้อนเวลาบนรถเดียวขึ้นแดงแต่บันทึกได้ | D2 จอ split, เวลาขัดกันขึ้นแดงไม่บล็อก; spec03§5 | L | T11, ST0-T14 | ลาก order ลงรถ → เกิด trip PLANNING; ลากซ้อนเวลา → แถบแดงและบันทึกสำเร็จ | ไม่ — เครื่องมือหลักของผู้จัดรถ |
| ST3-T13 | View บนกระดาน: ตามรถ / ตามคนขับ / ตาม carrier / "รถบริษัท + รถร่วม" (default) + ปรับ field บนการ์ดงาน | D2 View | M | T12 | สลับ view แล้วข้อมูลชุดเดียวกันจัดกลุ่มใหม่; ค่าที่เลือกจำต่อผู้ใช้ | ใช่ — ใช้ view default ได้ |
| ST3-T14 | Constraint ตอนจัด: น้ำหนัก/ปริมาตร, compatibility, ใบขับขี่, เอกสารรถหมดอายุ, ชั่วโมงขับ, จุดส่งไม่รับประเภทรถ → เตือน + override พร้อมเหตุผล (ลง audit); badge เอกสารบนการ์ดรถ; รถร่วมเอกสารบังคับหมด = บล็อก (admin override); รถ "ซ่อม/จอด" ไม่ขึ้นใน filter รถว่าง | D2 ตรวจ constraint ตอนจัด; B2.3 D Planning & Dispatch (เอกสาร); spec03§6 | L | T11, ST2-T16, ST2-T20 | จัดงานเกินน้ำหนัก → คำเตือน; override ต้องใส่เหตุผลและปรากฏใน audit; รถร่วม พ.ร.บ. หมด assign ไม่ได้ถ้าไม่ใช่ admin | ไม่ — กันน้ำหนักเกิน/รถผิดประเภท |
| ST3-T15 | Filter รถที่รับได้สองทาง: คลิก order → รถ/คนขับที่ผ่าน constraint ถูกเน้น; คลิกรถ → order ที่รับได้ถูกเน้น | D2 Filter รถที่รับได้สองทาง | M | T12, T14 | คลิก order ห้องเย็น → เน้นเฉพาะรถห้องเย็นที่น้ำหนักพอ | ใช่ — คำเตือนตอนจัดยังทำงาน |
| ST3-T16 | Multi-drop: เรียงลำดับ stop ด้วยมือ, คำนวณระยะ/เวลารวม, กันลำดับผิด (ส่งก่อนรับ) | D2 Multi-drop | M | T12 | ย้ายจุดส่งไปก่อนจุดรับของ DO เดียวกัน → ถูกปฏิเสธพร้อมข้อความ | ไม่ — เที่ยวหลายจุดเป็นปกติ |
| ST3-T17 | ปุ่ม Assign (ผูกรถ/คนขับ → ASSIGNED) แยกจาก Assign & dispatch (→ DISPATCHED) + bulk action | D2 Assign vs Dispatch แยกปุ่ม | M | T11, T12 | Assign แล้วสถานะ ASSIGNED ยังไม่ส่งงาน; Dispatch แล้ว DO ทุกใบในเที่ยวเป็น DISPATCHED | ไม่ — ปล่อยงานจริง |
| ST3-T18 | Send all: checkbox ส่งงานทั้งวันของทุกรถทีเดียว + ปฏิทินขึ้นเขียวเมื่อส่งครบ | D2 Send all | S | T17 | กด Send all แล้วทุก trip ของวันนั้นเป็น DISPATCHED และวันนั้นเป็นสีเขียว | ใช่ — กดทีละเที่ยวได้ |
| ST3-T19 | ตารางรถ/คนขับรายวัน: ภาระงาน ว่าง ซ่อม ลา (คลิกขวาใส่วันลา/โน้ต) | D2 ตารางรถ/คนขับรายวัน | M | T11 | ใส่วันลาคนขับแล้วคนขับไม่ขึ้นเป็น "ว่าง" ในวันนั้น | ใช่ — ดูจากกระดานได้ |
| ST3-T20 | ใบงานประจำวัน: PDF ใบคุมรถต่อเที่ยว/ต่อวัน ดาวน์โหลดหรือส่งให้คนขับ | D2 ใบงานประจำวัน; spec03§9 | M | T11, ST0-T17 | PDF แสดงจุดแวะตามลำดับ เลข DO สินค้า ผู้ติดต่อ เป็นภาษาไทยถูกต้อง | ไม่ — เฟส 0 ไม่มีแอปคนขับ |
| ST3-T21 | ช่องส่ง LINE Messaging API + SMS หลังแกนแจ้งเตือน: ส่งลิงก์ตาม template, เก็บ log การส่ง, fallback "คัดลอกลิงก์" | G4 LINE OA / Messaging API; I การแจ้งเตือน (LINE สำหรับรถร่วม) | M | ST1-T23, ST0-T01 | ส่งลิงก์เข้า LINE ทดสอบได้ และมี log; LINE ล่ม → ผู้ใช้ยังคัดลอกลิงก์ได้ | ใช่ — คัดลอกลิงก์ส่งเองได้ |
| ST3-T22 | จ้างรถร่วม: เลือก carrier + แสดง rate card ขาซื้อ + ราคา 5 ครั้งล่าสุด, ใส่ราคาซื้อ → `trip_cost` (CARRIER_FEE), preview ใบสั่งงาน, เก็บ `selectionReason` | D3 เลือก carrier + ราคาซื้อ, บันทึกเหตุผลการเลือก | M | T11, ST2-T14 | จ้าง carrier ที่ไม่ใช่ราคาถูกสุดต้องใส่เหตุผล; ทุกการจ้างมี `selectionReason` ไม่ว่าง | ไม่ — ต้นทางของ settlement |
| ST3-T23 | ลิงก์ข้อเสนองาน (M10 ส่วนรับ/ปฏิเสธ): trip → OFFERED, ลิงก์อายุ 48 ชม., หน้า public responsive: กดรับ + ใส่ทะเบียนรถ + ชื่อ/เบอร์คนขับ หรือปฏิเสธ + เหตุผล; ซ่อนราคาขาย/ที่อยู่ลูกค้า | D3 ส่งลิงก์ LINE/SMS ไม่ต้อง login; E2.3 D3/PL4; 01§4.2, 01§5.5 | L | T22, ST1-T06 | เปิดลิงก์บนมือถือโดยไม่ login กดรับ → trip เป็น ASSIGNED พร้อมทะเบียน/คนขับ; ปฏิเสธ → SO กลับใบค้าง `CARRIER_REJECTED` | ไม่ — ต้องมีตาม docs/02 §7 |
| ST3-T24 | หมดเวลา: ไม่ตอบใน N ชม. → แจ้ง dispatcher + ปุ่ม "ส่งรายถัดไป"; ลิงก์หมดอายุ → EXPIRED | D3 หมดเวลา → แจ้ง dispatcher | S | T23, ST1-T23 | test เลื่อนเวลา: ครบ N ชม. dispatcher ได้แจ้งเตือน 1 ครั้ง | ใช่ — โทรตามแทนได้ |
| ST3-T25 | เปลี่ยน carrier: ยกเลิกการจ้างเดิมแล้วจ้างใหม่ ประวัติคงอยู่ | D3 เปลี่ยน carrier | S | T23 | เปลี่ยน carrier แล้ว history มีทั้งรายเดิม (ยกเลิก) และรายใหม่; `trip_cost` เดิมถูกกลับรายการ | ไม่ — กันจ่ายผิดราย |

**เสร็จ stage เมื่อ**
- test เขียว รวม test state machine ของ SO / DO / trip ทุก transition (ถูกและผิด)
- harness แยก tenant ครอบ `sales_order`, `delivery_order`, `trip`, `trip_stop`, `trip_cost` และ endpoint public (token ของ tenant อื่นใช้ไม่ได้)
- OpenAPI อัปเดต: orders, delivery-orders, trips พร้อม action
- ข้อความ TH/EN ครบ รวมหน้า public ของรถร่วม (ไทยเป็นหลัก)
- ไม่มี order ใดอยู่ในสถานะที่มองไม่เห็น: ทุกใบอยู่ใน pool, ใบค้าง (มี reason) หรือ trip
- หน้า public ไม่ส่ง field ราคาขายใน payload (test อัตโนมัติ)

**เดโมท้าย stage**
1. ส่ง order 3 ใบผ่าน `PUT /orders/external/{id}` (1 ใบลูกค้าไม่รู้จัก) + คีย์มือ 1 ใบ → เห็น badge source และใบค้าง 1 ใบ
2. เคลียร์ใบค้างด้วยการ map ลูกค้า → order ถัดไปของลูกค้านั้นเข้าเองไม่ค้าง
3. ลาก 2 order ลงรถบริษัทบน planning board เรียงจุด แล้ว Assign & dispatch → ดาวน์โหลดใบงาน PDF
4. จ้างรถร่วมสำหรับอีก 1 order → เปิดลิงก์บนมือถือ กดรับ ใส่ทะเบียน/คนขับ → trip เป็น ASSIGNED
5. จัดงานเกินน้ำหนัก → คำเตือน + override พร้อมเหตุผล แล้วดูใน audit

---

## ST4 — Execution และ POD

**เป้าหมาย:** ทุกการเปลี่ยนสถานะหน้างานเป็น event ที่ idempotent (`clientEventId`) จากเว็บหรือจากลิงก์รถร่วม
POD ครบตาม checklist ของลูกค้า ยอดส่งจริงและค่าใช้จ่ายหน้างานพร้อมส่งต่อให้วางบิล

**สิ่งที่ต้องมีก่อนเริ่ม:** ST3 ครบ (trip/DO/ลิงก์ข้อเสนองาน) · ST1-T06 magic link, ST1-T08 ไฟล์แนบ · ตัดสินว่าใช้ `stop_event` เป็นตารางแยกตาม 01§3.9 (ST0-T19) · มือถือทดสอบจริง (Android ราคาประหยัด + iPhone + LINE)

| ID | งาน | อ้างอิง | ขนาด | ต้องเสร็จก่อน | เกณฑ์ตรวจรับ | ตัดได้? |
|---|---|---|---|---|---|---|
| ST4-T01 | `stop_event` (append-only): ชนิด arrive / depart / complete (outcome delivered / partial / failed / undelivered_retain) / fail; ทุก event มี `clientEventId`, `occurredAt`, `receivedAt`, GPS, accuracy, แหล่ง (app/web/link/api); action `POST /stops/{id}/arrive`, `/depart`, `/complete`, `/fail` | E1 Stop event; 01§3.9, 01§5.2 #3 | L | ST3-T11 | ส่ง arrive → depart → complete ผ่าน API แล้วมี event 3 แถวพร้อมเวลาสองชุด | ไม่ — แหล่งความจริงของการส่ง |
| ST4-T02 | Server idempotent: unique `(tenantId, clientEventId)` ซ้ำ → คืนผลเดิม; event สลับลำดับ → เรียงด้วย `occurredAt` + ตรวจ state machine; ขัดแย้ง → เก็บทั้งคู่ + ธงให้ dispatcher ตัดสิน (หน้ารายการธง) | E1 Idempotent server | M | T01 | ส่ง event เดิม 2 ครั้ง = 1 แถว; ส่ง depart ก่อน arrive (เวลาเครื่องถูก) → สถานะสุดท้ายถูก; กรณีขัดแย้งขึ้นธง | ไม่ — ลิงก์/เน็ตหลุดส่งซ้ำ |
| ST4-T03 | ไล่สถานะ: stop event → `trip_stop` → trip (IN_PROGRESS / COMPLETED) → DO (DELIVERED / FAILED) → SO; เขียน `domain_event` (`stop.*`, `trip.completed`, `delivery_order.status_changed`); อัปเดตเลขไมล์รถเมื่อจบเที่ยว | D1 สถานะ trip (ส่วนคำนวณจาก stops); B2.1 ส่วน 1 (เลขไมล์จาก DO ที่ปิด); 01§4.1–4.3 | M | T01 | ปิด stop สุดท้าย → trip COMPLETED, DO DELIVERED, SO DELIVERED ใน transaction เดียว | ไม่ — เปิดทางให้วางบิล |
| ST4-T04 | อัปเดตสถานะผ่านเว็บ: admin/หน้าคลังบันทึก arrive/depart/complete แทนคนขับ พร้อมเวลาและผู้บันทึก; หน้ารายละเอียดเที่ยวแบบ stepper | E2 อัปเดตสถานะผ่านเว็บ | M | T03 | บันทึกย้อนเวลาได้ (ใส่ `occurredAt`) และเห็นชื่อผู้บันทึกใน timeline | ไม่ — วิธีหลักของ KRS |
| ST4-T05 | POD checklist config (แกน): field PHOTO / SIGNATURE / NOTE / BOOLEAN ตั้ง Disabled / Enabled / Required; default ของ tenant + override ต่อลูกค้า (`customer.pod_requirements`); ตัวตรวจ POD | E2 POD checklist config ต่อลูกค้า; 01§3.2 | M | ST2-T01, ST1-T17 | ลูกค้า A บังคับรูป + ลายเซ็น: ปิดงานโดยไม่มีรูปถูกปฏิเสธ; ลูกค้า B ใช้ค่า default | ไม่ — เกณฑ์ "POD ครบ" ของบิล |
| ST4-T06 | POD checklist ชนิดเพิ่ม: BARCODE / SINGLE_CHOICE / PIN / RATING + ชุดแยกสำหรับสำเร็จ vs ไม่สำเร็จ | E2 POD checklist config ต่อลูกค้า | S | T05 | ตั้งชุด "ไม่สำเร็จ" บังคับรูป → ปิดงานแบบ failed ต้องมีรูป | ใช่ — 4 ชนิดหลักพอสำหรับ pilot |
| ST4-T07 | ePOD ผ่านเว็บ: อัปโหลดรูป/ลายเซ็น/ไฟล์, น้ำหนักชั่ง, เลขอ้างอิงลูกค้า, ผู้รับ + ความสัมพันธ์; คำนวณ `pod_status` (NONE/PARTIAL/COMPLETE) → DO เป็น POD_PENDING หรือ UNBILLED | E2 ePOD ผ่านเว็บ; 01§4.3 | M | T04, T05, ST1-T08 | อัปโหลด POD ครบตาม checklist → DO เป็น UNBILLED; ไม่ครบ → POD_PENDING | ไม่ — หลักฐานส่งมอบ |
| ST4-T08 | M10 ลิงก์รถร่วม (ส่วนสถานะ): ลิงก์ต่อ trip → ค้นด้วยเลข DO → กดถึง/ออก; ใช้ event model เดียวกัน (แหล่ง = link) ส่ง `clientEventId` ทุกครั้ง ไม่มี outbox (ต้องออนไลน์) | E2 ePOD ผ่านลิงก์; E2.1 M10; E2.2 Offline-first (ข้อยกเว้น M10); E แถว Driver app (ส่วน M10); 01§5.5 | M | T02, ST3-T23 | เปิดลิงก์บนมือถือ ค้นเลข DO กดถึง → เว็บฝั่ง dispatcher เห็นสถานะทันที; กดซ้ำไม่เกิด event ซ้ำ | ไม่ — ต้องมีตาม docs/02 §7 |
| ST4-T09 | M10 ลิงก์รถร่วม (ส่วน POD): อัปโหลดรูป ≤ 5 ไฟล์/stop → ลายเซ็นบนจอ → actual qty → ปิดงาน; responsive มือถือ | E2 ePOD ผ่านลิงก์; E2.1 M10 | L | T08, T07 | ปิดงานจากมือถือพร้อมรูป 2 ใบ + ลายเซ็น แล้ว DO เป็น UNBILLED; รูปที่ 6 ถูกปฏิเสธ | ไม่ — ต้องมีตาม docs/02 §7 |
| ST4-T10 | Actual quantity + reject reason ต่อรายการ: planned vs delivered vs rejected + reason (หมวด "ปฏิเสธรับ"); ตั้งต่อลูกค้าว่าวางบิลตามยอดส่งจริง | E2 Actual quantity + reject reason | M | T07, ST2-T12 | ส่งจริงน้อยกว่าแผนโดยไม่เลือกเหตุผล → ถูกปฏิเสธ; ลูกค้าที่ตั้ง "ตามยอดจริง" ได้ยอดเงินตามปริมาณส่งจริง | ไม่ — ยอดบนใบแจ้งหนี้ |
| ST4-T11 | ตีกลับบางส่วน/ทั้งหมด: จาก actual qty → สร้างงานส่งซ้ำ (DO ใหม่อ้าง `redelivery_of`) หรือคืนคลัง (RETURNED) | E2 ตีกลับบางส่วน/ทั้งหมด; 01§4.3 | M | T10 | ของถูกปฏิเสธ 10 ชิ้น → เลือก "ส่งซ้ำ" ได้ DO ใหม่ 10 ชิ้นอ้างใบเดิม | ใช่ — สร้างงานใหม่มือแทนได้ |
| ST4-T12 | Undelivered-retain + auto-reschedule: outcome "ส่งไม่สำเร็จ ของยังอยู่บนรถ"; reason ที่ติ๊ก auto-reschedule สร้าง stop ใหม่วันถัดไป; นับครั้ง → `RESCHEDULES_EXHAUSTED` | E2 Undelivered-retain + auto-reschedule | M | T03, ST2-T12 | ปิดจุดด้วย reason แบบ auto-reschedule → มี stop ใหม่วันถัดไป; เกินจำนวนครั้ง → ขึ้นใบค้าง | ใช่ — จัดใหม่มือแทนได้ |
| ST4-T13 | เหตุล่าช้า/ค่าใช้จ่ายหน้างาน (รอคิว ค้างคืน ทางด่วน ยกของ) → `do_surcharge` (ฝั่งขาย) และ/หรือ `trip_cost` (ฝั่งซื้อ) พร้อมรูปใบเสร็จ; snapshot VAT/WHT จาก `service_item` | E2 บันทึกเหตุล่าช้า/ค่าใช้จ่ายหน้างาน; 01§3.3 | M | T04, ST2-T11 | เพิ่ม "ค่ารอ" 500 บาท → มีบรรทัดฝั่งขาย `VAT_7` พร้อมรูป รอ Invoicer ยืนยัน | ไม่ — บรรทัด VAT 7% ของใบกำกับ |
| ST4-T14 | Tracking link สาธารณะ: หน้ามีแบรนด์ tenant; ผู้รับกรอกเลข DO/PO → สถานะแบบ stepper, ETA, POD (ถ้าเปิด); ไม่เผยราคา; rate limit | E2 Tracking link สาธารณะ; 01§5.2 #4; spec04§4 | M | T03, ST1-T06 | ค้นด้วยเลข PO ของลูกค้าเห็นสถานะล่าสุด; response ไม่มี field ราคา (test) | ใช่ — ไม่กระทบเอกสาร/reconcile |
| ST4-T15 | ทดสอบหน้า public บนมือถือจริง: Chrome Android, Safari iOS, LINE in-app browser (ข้อเสนองาน, POD, tracking) | NFR Browser/device | S | T09 | checklist ทดสอบ 3 browser × 3 หน้า ผ่านทุกช่อง หรือมี defect ที่ปิดแล้ว | ไม่ — รถร่วมใช้มือถือ 100% |

**เสร็จ stage เมื่อ**
- test เขียว รวม test idempotency (ซ้ำ/สลับลำดับ/ขัดแย้ง) ของ `stop_event`
- harness แยก tenant ครอบ `stop_event`, POD, `do_surcharge` และลิงก์ public (ลิงก์ของ trip หนึ่งเข้าถึง trip อื่นไม่ได้)
- OpenAPI อัปเดต: stops + action, documents, tracking
- ข้อความ TH/EN ครบ; หน้า public ไทยเป็นหลัก ปุ่มใหญ่ใช้นิ้วกดได้
- DO เดินครบ DISPATCHED → DELIVERED → POD_PENDING/UNBILLED ตาม 01§4.3 โดยไม่มีสถานะตกหล่น
- ทดสอบบนมือถือจริงผ่าน (ST4-T15)

**เดโมท้าย stage**
1. Dispatcher บันทึกถึง/ออก/ปิดงานของรถบริษัทผ่านเว็บ แนบ POD → DO เป็น UNBILLED
2. รถร่วมเปิดลิงก์ใน LINE บนมือถือ: ค้นเลข DO → กดถึง → ถ่ายรูป + เซ็นบนจอ → ใส่ยอดส่งจริงน้อยกว่าแผนพร้อมเหตุผล → ปิดงาน
3. กดปิดงานซ้ำ (จำลองเน็ตหลุด) → ไม่เกิด event ซ้ำ
4. เพิ่มค่ารอ + รูปใบเสร็จ → เห็นบรรทัดค่าใช้จ่ายรอวางบิล
5. ผู้รับเปิด tracking link ค้นด้วยเลข PO เห็นสถานะและ POD โดยไม่เห็นราคา

---

## ST5 — Billing AR

**เป้าหมาย:** ออกเอกสารขายครบชุดตามกฎหมายไทยได้เองโดยไม่มี ERP: ใบแจ้งหนี้ ใบวางบิล ใบกำกับภาษี ใบเสร็จ ใบลดหนี้ ใบเพิ่มหนี้
VAT/WHT ต่อบรรทัด tax point ตอนรับชำระ เอกสารที่ออกเลขแล้วแก้ไม่ได้ เลขเรียงไม่ข้าม

**สิ่งที่ต้องมีก่อนเริ่ม:** ST4 ครบ (DO ที่ UNBILLED + ค่าใช้จ่ายหน้างาน) · **คำตอบนักบัญชี 01§8.2 ข้อ 1–5, 8, 9** (หรือ default + สวิตช์ที่เซ็นรับ) — schema ST5 freeze หลังได้คำตอบ · แบบเอกสารจาก design brief (docs/03) · นักบัญชีของ tenant standalone พร้อมตรวจตัวอย่าง

| ID | งาน | อ้างอิง | ขนาด | ต้องเสร็จก่อน | เกณฑ์ตรวจรับ | ตัดได้? |
|---|---|---|---|---|---|---|
| ST5-T01 | Revenue line: จาก rate card snapshot + `do_surcharge` snapshot; `sourceType/sourceId` ต่อบรรทัด; rebuild เฉพาะบรรทัดระบบเมื่อ order เปลี่ยน เก็บบรรทัดที่คนเพิ่มเอง; ไม่ rebuild หลัง finalize | F3 Revenue line ตั้งแต่สร้าง order; D1 Order (revenue line); 01§3.3–3.4 | M | ST3-T09, ST4-T10, ST4-T13 | แก้ปริมาณ order → บรรทัดระบบเปลี่ยน บรรทัดที่คนเพิ่มยังอยู่; หลัง finalize ไม่เปลี่ยน | ไม่ — ฐานของใบแจ้งหนี้ |
| ST5-T02 | เครื่องคำนวณภาษีต่อบรรทัด (ฟังก์ชันล้วน): `vat_type` EXEMPT_TRANSPORT / VAT_7 / ZERO_RATED, ยอดก่อน VAT แยกยกเว้น/7%, VAT, การปัดเศษ, `wht_rate` ต่อบรรทัด (1%/3%) + ยอด WHT ที่คาดว่าจะถูกหัก + กฎขั้นต่ำ 1,000 (ตั้งได้ตามคำตอบนักบัญชี) | F1 ค่าขนส่งยกเว้น VAT, บริการประกอบ VAT 7%, WHT 1%/3%; 01§1 [ภาษี] | L | T01, ST0-T18 | ชุด test ≥ 30 กรณีที่นักบัญชีตรวจแล้วผ่านทั้งหมด (ยกเว้นล้วน / 7% ล้วน / ปน / ปัดเศษ / WHT) | ไม่ — ความถูกต้องทางภาษี |
| ST5-T03 | เอกสารที่มี VAT ปน: ตั้งต่อ tenant ว่าใบเดียวแยกบรรทัดยกเว้น หรือแยก 2 เอกสาร; ชื่อเอกสารตามเนื้อหา (มีแต่ EXEMPT → "ใบแจ้งหนี้/ใบเสร็จรับเงิน" ไม่มีคำว่าใบกำกับภาษี); นิติบุคคลไม่จด VAT ออกใบกำกับไม่ได้ | F1 ค่าขนส่งยกเว้น VAT, บริการประกอบ VAT 7% | M | T02 | tenant โหมด "2 เอกสาร": DO ที่มีค่าขนส่ง + ค่ารอ ได้ 2 ใบ; โหมดใบเดียวได้ 1 ใบแยกบรรทัด | ไม่ — KRS ต้องแยกใบตาม VAT |
| ST5-T04 | คิว "พร้อมวางบิล": DO ที่ส่งแล้ว POD ครบตาม checklist และ `pricingStatus = AVAILABLE`; กรองลูกค้า/ช่วงวัน; option "ไม่มี POD ไม่วางบิล"; ขั้นส่งบัญชี (RELEASED) | F3 คิวพร้อมวางบิล; spec05§2 | M | T01, ST4-T07 | DO ที่ POD ไม่ครบไม่ขึ้นคิวเมื่อเปิด option; ที่ `RATE_MISSING` ไม่ขึ้นคิว | ไม่ — ทางเข้าของการวางบิล |
| ST5-T05 | กันวางบิลซ้ำ: unique partial index บน `invoice_line.delivery_order_id` (invoice ที่ยัง active) + `billingStatus` UNBILLED / IN_DRAFT / INVOICED / CREDITED | F3 Flag กันวางบิลซ้ำ; 01§3.3 | S | T04 | 2 request พร้อมกันดึง DO เดียวเข้า 2 draft → สำเร็จ 1 อีก 1 ได้ 409 | ไม่ — กันรายได้ซ้ำ |
| ST5-T06 | Lifecycle และ revert rules: DELIVERED → RELEASED → IN_DRAFT → INVOICED → PAID/CREDITED, สิทธิ์ต่อ transition, timestamp แยก (`releasedAt`, `invoicedAt`, `paidAt`), ย้อน DELIVERED ได้ใน 24 ชม. โดย Dispatcher, INVOICED ย้อนไม่ได้ | F4 Lifecycle และ revert rules | M | T05 | Dispatcher ย้อนหลัง 24 ชม. ถูกปฏิเสธ; พยายามแก้ stop/qty หลัง RELEASED → 409 | ไม่ — กันแก้ข้อมูลหลังวางบิล |
| ST5-T07 | Invoice draft: สร้างจาก DO หลายใบของลูกค้าเดียว, เพิ่ม/ลด/รวม/แยกบรรทัด (Group / Merge / Single), ส่วนลด, ย้าย order ระหว่าง draft, order ใน draft ล็อกราคา, pro forma PDF, ไม่มีเลข ไม่เข้า outbox | F3 Draft (แก้ได้); F2 ใบแจ้งหนี้ (ฟิลด์/กฎ 1 ใบ : หลาย DO); spec05§3 | L | T05, T02 | สร้าง draft จาก 5 DO แก้บรรทัดได้; draft ไม่มี `invoice_no`; DO ใน draft แก้ราคาที่ order ไม่ได้ | ไม่ — ขั้นก่อนออกเลข |
| ST5-T08 | แบบ PDF ใบแจ้งหนี้ภาษาไทย: หัวเอกสารผู้ออก/ผู้ซื้อ + สาขา ("สำนักงานใหญ่" / "สาขาที่ 00001"), ยอดแยกยกเว้น/7%, WHT ที่คาดว่าจะถูกหัก, due date, PO ลูกค้า, พ.ศ./ค.ศ. | F2 ใบแจ้งหนี้; F1 สาขาผู้ออกและผู้ซื้อ, ภาษาไทย/บาท/ฟอนต์ไทย; spec05§16 | M | T07, ST0-T17 | golden-file ของใบตัวอย่าง 3 แบบ (ยกเว้นล้วน / ปน / หลายหน้า) ผ่าน และนักบัญชีรับแบบ | ไม่ — เอกสารที่ลูกค้าได้รับ |
| ST5-T09 | Finalize (immutable): ตรวจลูกค้ามีเลขฯ + สาขา, ทุกบรรทัดมี vatTreatment, separation of duties (ผู้สร้าง finalize เองไม่ได้ เว้น tenant ปิดกฎ); ออกเลขด้วย row lock; render + เก็บ PDF; `customer_snapshot`; event `invoice.finalized` ใน transaction เดียว; หลังนี้ไม่มี PUT/PATCH | F3 Finalize (immutable); F1 เลขเอกสารเรียงลำดับ, สาขาผู้ออกและผู้ซื้อ; A3 กฎเพิ่มเติม (finalize ใบตัวเอง); 01§4.4 | L | T07, T08, ST1-T15 | finalize 20 ใบพร้อมกันเลขเรียงไม่ข้าม; PATCH หลัง finalize ได้ 409; ลูกค้าไม่มีรหัสสาขา finalize ไม่ได้ | ไม่ — หัวใจของเกณฑ์ (ข) |
| ST5-T10 | ยกเลิกใบ: draft → ลบร่าง (DO กลับ UNBILLED); ใบที่ออกแล้วยังไม่ส่งลูกค้า/ยังไม่รับชำระ → CANCELLED คงเลข ฉบับใหม่อ้างเลขเดิม + event void | F3 ยกเลิกใบ; F1 เลขเอกสาร (ยกเลิกอ้างฉบับเดิม); 01§4.4 | M | T09 | ยกเลิกใบแล้ว record และเลขยังอยู่ สถานะ CANCELLED; เลขนั้นไม่ถูกใช้ซ้ำ; DO กลับมาวางบิลใหม่ได้ | ไม่ — แก้ใบผิดช่วง pilot |
| ST5-T11 | ใบวางบิล (`billing_note`): สรุปใบแจ้งหนี้ค้างของลูกค้า + ยอดรวม + วันนัดรับเช็ค/โอน + ผู้รับวางบิล; DRAFT → ISSUED → COLLECTED; PDF; ไม่กระทบภาษี | F2 ใบวางบิล; 01§3.4 | M | T09 | รวม 3 ใบแจ้งหนี้เป็นใบวางบิล 1 ใบ ยอดรวมตรง; ใบแจ้งหนี้เดียวอยู่ 2 ใบวางบิลที่ active ไม่ได้ | ไม่ — วิธีเก็บเงินแบบไทย |
| ST5-T12 | Invoice run (async): รอบตาม `billing_cycle` สร้าง draft ทุกลูกค้า (รวมใบวางบิลอัตโนมัติ) เป็น job + ลิงก์ผลลัพธ์ + event `job.completed` | F3 Invoice run (async); F2 ใบวางบิล (สร้างอัตโนมัติ) | M | T07, T11, ST0-T11 | รัน run ของลูกค้ารายเดือน 3 ราย → ได้ 3 draft; job รายงาน progress และจบ succeeded | ใช่ — สร้าง draft มือได้ |
| ST5-T13 | บันทึกรับชำระ: `payment` + `payment_allocation` ต่อใบแจ้งหนี้/ใบวางบิล — วันที่, วิธี, ยอดรับ, WHT ที่ถูกหัก, ค่าธรรมเนียม, ส่วนต่าง; รับบางส่วนได้; แก้ด้วย reversal | F5 บันทึกรับชำระ; 01§3.4; spec05§4 | L | T09 | รับชำระ 99% + WHT 1% → ใบเป็น PAID; รับบางส่วน → PARTIALLY_PAID; reverse แล้วยอดค้างกลับมา | ไม่ — tax point ของบริการ |
| ST5-T14 | ใบเสร็จรับเงิน: ออกทันทีที่รับเงินทุกกรณี (รวมค่าขนส่งยกเว้น VAT), เลขชุด RCP, อ้างใบแจ้งหนี้/ใบกำกับ, วิธีชำระ, ฟอร์มรวม "ใบเสร็จรับเงิน/ใบกำกับภาษี", PDF | F2 ใบเสร็จรับเงิน; 01§3.4 | M | T13 | บันทึกรับชำระ 1 ครั้ง → มีใบเสร็จ 1 ใบเลขเรียง; ยอดบนใบเสร็จ = ยอดที่รับ + WHT | ไม่ — เอกสารขาย 6 ชนิด |
| ST5-T15 | ใบกำกับภาษีเต็มรูป: เลขชุด TXINV, คำว่า "ใบกำกับภาษี", รายการยกเว้นแยกบรรทัด, VAT แยกชัด, "เอกสารออกเป็นชุด", "สาขาที่ออกใบกำกับภาษีคือ…"; ออกได้เฉพาะนิติบุคคลจด VAT และเอกสารที่มีบรรทัด VAT_7; PDF | F2 ใบกำกับภาษี (เต็มรูป ม.86/4); 01§3.4 | L | T09, T03 | ใบที่มีบรรทัด VAT_7 ได้ `tax_invoice_no`; ใบที่ยกเว้นล้วนไม่มี; ข้อความบังคับครบตาม checklist นักบัญชี | ไม่ — หัวใจของเกณฑ์ (ข) |
| ST5-T16 | Tax point + trigger: default รับชำระ → ออกใบเสร็จ (+ ใบกำกับภาษีถ้ายังไม่ออกและมี VAT_7) อัตโนมัติ; โหมดออกก่อน (`ON_ISSUE`) ต่อลูกค้า; วันที่ใบกำกับ = วันเกิด event | F1 Tax point บริการ = เมื่อรับชำระ; F5 Trigger เอกสาร; 01§3.2 `tax_invoice_mode` | M | T14, T15 | ลูกค้าโหมด default: ใบกำกับลงวันที่วันรับเงิน ไม่ใช่วันส่งของ; โหมด ON_ISSUE: ออกพร้อมใบแจ้งหนี้ | ไม่ — วันที่ใบกำกับต้องถูก |
| ST5-T17 | บันทึกรับ 50 ทวิ จากลูกค้า (`wht_certificate` ทิศ RECEIVED): เลขที่ วันที่ ยอดหัก ไฟล์แนบ → ปิดยอดค้าง 1%; รายการ "WHT รอ 50 ทวิ" | F2 บันทึกรับ 50 ทวิ จากลูกค้า; 01§3.6 | M | T13 | รับชำระที่ถูกหัก 1% โดยยังไม่มี 50 ทวิ → ขึ้นรายการรอ; แนบ 50 ทวิ แล้วหายจากรายการ | ไม่ — นักบัญชีกระทบ WHT |
| ST5-T18 | สถานะ invoice คำนวณจาก payment: ISSUED → PARTIALLY_PAID → PAID / OVERDUE / CANCELLED + ธง "ส่งลูกค้าแล้ว" + job ตั้ง OVERDUE | F5 สถานะ invoice; 01§4.4 | S | T13 | ใบเลย due date ที่ยังไม่จ่ายเป็น OVERDUE หลัง job รัน; จ่ายครบเป็น PAID | ไม่ — สถานะที่ทุกหน้าจออ่าน |
| ST5-T19 | ใบลดหนี้ (ม.86/10): อ้างใบกำกับภาษีเดิม (FK บังคับ), มูลค่าเดิม/ที่ถูกต้อง/ผลต่าง, VAT คืน, `reasonCode` ตาม ETDA CDNS, เหตุที่ไม่เข้า ม.82/10 → บล็อก + แนะนำเอกสารปรับปรุงภายใน, ขั้นขอ → อนุมัติ, ออกเลข, PDF; invoice เป็น ADJUSTED/VOIDED | F2 ใบลดหนี้; A3 (ใบลดหนี้: ขอ/อนุมัติ); 01§3.4, 01§4.4 | L | T15 | สร้างใบลดหนี้โดยไม่อ้างใบเดิมไม่ได้; ลดเต็มใบ → invoice VOIDED และ DO กลับ UNBILLED | ไม่ — ทางเดียวที่แก้ใบที่ออกแล้ว |
| ST5-T20 | ใบเพิ่มหนี้ (ม.86/9): โครงเดียวกับใบลดหนี้ VAT เพิ่ม `reasonCode` ตาม CDNG | F2 ใบเพิ่มหนี้ | M | T19 | ออกใบเพิ่มหนี้แล้วยอดค้างของ invoice เพิ่มตาม; ใช้เลขชุด DN แยก | ไม่ — เอกสารขาย 6 ชนิด |
| ST5-T21 | ส่งเอกสาร: อีเมล PDF ถึงลูกค้า + ไฟล์รวมชุด "ใบวางบิล + ใบแจ้งหนี้ + ใบกำกับ" (ดาวน์โหลดรายใบมีอยู่แล้วในงานของแต่ละเอกสาร; customer portal เป็น P2) | F3 พิมพ์/ส่งเอกสาร | M | T11, T15, ST1-T03 | กดส่งแล้วลูกค้าทดสอบได้อีเมลพร้อมไฟล์รวม 1 ไฟล์เรียงตามลำดับ | ใช่ — ดาวน์โหลดแล้วส่งเองได้ |
| ST5-T22 | Aging 0–30 / 31–60 / 61–90 / > 90 ต่อลูกค้า + เตือนครบกำหนดชำระ | F5 Aging; spec05§10 | M | T18 | ยอดรวม aging ทุกช่วง = ยอดค้างรวมของ invoice ที่ยังไม่ปิด (test เทียบ) | ใช่ — ไม่กระทบการออกเอกสาร |
| ST5-T23 | รายงานภาษีขายต่อสถานประกอบการ: ลำดับ, วันที่, เลขที่ใบกำกับ, ผู้ซื้อ, เลขฯ 13 หลัก, สาขา, มูลค่า, VAT, หมายเหตุ (ยกเลิก/ลดหนี้) + รายงาน "รายได้ยกเว้น" สำหรับ ภ.พ.30; export | F9 รายงานภาษีขาย; 01§8.2 ข้อ 9 | M | T15, T19 | ยอด VAT รวมของรายงานเดือน = ผลรวม VAT ของใบกำกับ ± ใบลด/เพิ่มหนี้ของเดือนนั้น (test เทียบ) | ไม่ — นักบัญชีใช้ยื่น ภ.พ.30 |
| ST5-T24 | ตรวจว่าข้อมูล map เป็น ETDA CII ได้: ฟังก์ชันแปลงเอกสารเป็นโครงข้อมูลตามฟิลด์บังคับ (document id/date, TXID + สาขาสองฝ่าย, lines, tax breakdown, reference doc, reason code) — ไม่สร้าง XML/XAdES (K16) | F9 Data model map เป็น ETDA CII ได้ | S | T19 | เอกสารตัวอย่างทุกชนิดแปลงได้โดยไม่มี field บังคับว่าง (test) | ใช่ — e-Tax เป็น P1 |
| ST5-T25 | ชุดตรวจนักบัญชี (AR): สร้างเอกสารตัวอย่างทุกชนิดจาก seed → นักบัญชีตรวจตาม checklist → แก้ defect | 02§7 เกณฑ์ผ่าน (ข); 01§8.2 | S | T20, T23 | นักบัญชีเซ็นรับ PDF ทุกชนิด (6 ชนิด + รายงานภาษีขาย) หรือ defect ทุกข้อปิดแล้ว | ไม่ — เกณฑ์ (ข) โดยตรง |

**เสร็จ stage เมื่อ**
- test เขียว รวมชุด test ภาษีที่นักบัญชีตรวจ และ test ออกเลขพร้อมกัน
- harness แยก tenant ครอบ invoice, invoice_line, billing_note, payment, receipt, adjustment note, wht_certificate
- OpenAPI อัปเดต: invoices (+`/finalize`, `/cancel`), invoice-runs, billing-notes, credit-notes, debit-notes, payments, receipts
- ข้อความ TH/EN ครบบน UI; PDF ทุกชนิดเป็นไทย ผ่าน golden-file
- ไม่มี API/DB path ที่ลบหรือแก้เอกสารที่ออกเลขแล้ว (test พยายามแก้ต้องล้มเหลว)
- ทำงานครบโดยไม่มี connector เปิด (`StandaloneProvider`)
- นักบัญชีเซ็นรับชุดตัวอย่าง (ST5-T25)

**เดโมท้าย stage**
1. จากคิวพร้อมวางบิล เลือก DO 5 ใบของลูกค้าเดียว (ค่าขนส่ง + ค่ารอ) → draft → ผู้ใช้อีกคน finalize → ได้เลขและ PDF
2. พยายามแก้ใบที่ออกแล้ว → ถูกปฏิเสธ; ออกใบลดหนี้อ้างใบเดิมแทน
3. รวมใบแจ้งหนี้เป็นใบวางบิล → บันทึกรับชำระที่ถูกหัก 1% → ได้ใบเสร็จ + ใบกำกับภาษี (เฉพาะส่วน VAT 7%) ลงวันที่วันรับเงิน
4. แนบ 50 ทวิ ที่ลูกค้าให้มา → รายการ "WHT รอ 50 ทวิ" ว่าง
5. เปิดรายงานภาษีขายของเดือน ยอดตรงกับเอกสาร

---

## ST6 — Settlement AP

**เป้าหมาย:** จ่ายรถร่วมครบวงจรเส้นทางเดียว: cost line → คิวจ่าย → ใบสำคัญจ่าย → ตรวจ/โต้แย้ง → อนุมัติ → จ่าย → หัก ณ ที่จ่าย + ออก 50 ทวิ
ไม่มีทางจ่ายซ้ำ (unique `trip_cost` ต่อ settlement line)

**สิ่งที่ต้องมีก่อนเริ่ม:** ST3-T22 (ราคาซื้อบน trip), ST4 (trip COMPLETED + POD), ST5-T02 (เครื่องคำนวณภาษี) · **คำตอบนักบัญชี 01§8.2 ข้อ 6–7** (ภ.อ.11 สำหรับ 50 ทวิ PDF; ฐาน WHT และขั้นต่ำ 1,000 นับอย่างไร) · แบบฟอร์ม 50 ทวิ ทางการ

| ID | งาน | อ้างอิง | ขนาด | ต้องเสร็จก่อน | เกณฑ์ตรวจรับ | ตัดได้? |
|---|---|---|---|---|---|---|
| ST6-T01 | Cost line (`trip_cost`) ตั้งแต่สร้าง trip: จาก rate card ขาซื้อ snapshot + accessorial ฝั่งซื้อ; `sourceType/sourceId`; rebuild เฉพาะบรรทัดระบบ; trip → COSTED เมื่อต้นทุนครบ | F6 Cost line ตั้งแต่สร้าง trip; D1 Trip (cost line); 01§3.3, 01§4.2 | M | ST3-T22, ST4-T13 | trip รถร่วมมีบรรทัด CARRIER_FEE ตั้งแต่สร้าง; แก้ rate card ภายหลังแล้ว snapshot ไม่เปลี่ยน | ไม่ — ฐานของ settlement |
| ST6-T02 | คิวจ่ายรถร่วม: trip COMPLETED ของ carrier ที่ยังไม่อยู่ใน settlement; option "ไม่มี POD ไม่จ่าย"; กรอง carrier/ช่วงวัน | F6 คิวจ่ายรถร่วม | M | T01 | trip ที่ POD ไม่ครบไม่ขึ้นคิวเมื่อ carrier ตั้ง `require_pod_to_pay`; trip ที่อยู่ใน settlement แล้วไม่ขึ้น | ไม่ — ทางเข้าของการจ่าย |
| ST6-T03 | ติ๊กเที่ยว → ใบสำคัญจ่าย (settlement draft): รวมหลาย trip, เลขใบแจ้งหนี้/ใบเสร็จของรถร่วม, บรรทัดหักติดลบ (เงินเบิกล่วงหน้า ค่าน้ำมันที่เราจ่าย ค่าปรับ ค่าเสียหาย — กรอกมือ), unique `trip_cost_id` กันจ่ายซ้ำ | F6 ติ๊กเที่ยว → ใบสำคัญจ่าย; 01§3.6; spec05§11 | L | T02 | ใส่ `trip_cost` เดียวกันใน 2 settlement → ใบที่สองได้ 409; ยอดสุทธิ = รวม − หัก | ไม่ — K11 เส้นทางเดียวสู่ AP |
| ST6-T04 | PDF ใบสำคัญจ่ายภาษาไทย (รายการเที่ยว ยอด หัก WHT สุทธิ) | F6 ติ๊กเที่ยว → ใบสำคัญจ่าย; 01§5.2 #12 | S | T03, ST0-T17 | golden-file ผ่าน; ยอดบน PDF ตรงกับ API | ไม่ — เอกสารประกอบการจ่าย |
| ST6-T05 | รถร่วมตรวจผ่านลิงก์: ส่งลิงก์ → เห็นรายการเที่ยว/ยอด/หัก → กด "ยอมรับ" หรือ "โต้แย้ง" รายการพร้อมเหตุผล/รูป | F6 รถร่วมตรวจผ่านลิงก์; 01§4.5 | M | T03, ST1-T06 | carrier เปิดลิงก์เห็นเฉพาะเที่ยวของตัวเองและราคาซื้อของตัวเอง; กดโต้แย้งแล้วรายการติดธง | ใช่ — ข้ามขั้นนี้ได้ตาม 01§4.5 |
| ST6-T06 | Dispute: สถานะรายการ OPEN / DISPUTED / APPROVED; dispute บล็อก approve ทั้งใบจนเคลียร์; หน้าเทียบ planned vs executed vs claimed + POD | F6 Dispute | M | T05 | settlement ที่มีรายการ DISPUTED กด approve ไม่ได้ (409) จนแก้/เคลียร์ | ใช่ — ไปคู่กับ T05 |
| ST6-T07 | Approve แบบ separation of duties: ผู้สร้างอนุมัติเองไม่ได้; step-up 2FA เกินวงเงินที่ตั้ง; ออกเลขชุด STL | F6 Approve (separation of duties); A3 (Settlement: สร้าง/อนุมัติ/จ่าย) | M | T03, ST1-T05 | ผู้สร้างกดอนุมัติใบตัวเอง → 403; เกินวงเงินต้องยืนยัน TOTP | ไม่ — ควบคุมการจ่ายเงิน |
| ST6-T08 | คำนวณ WHT: ยอดก่อนหัก × `whtRate` ของ carrier (default 1%; บรรทัดค่าบริการ 3%); ขั้นต่ำ 1,000/สัญญา (ตั้งได้); จัดประเภท ภ.ง.ด.3 (บุคคล) / ภ.ง.ด.53 (นิติบุคคล) | F6 คำนวณ WHT + ออก 50 ทวิ (ส่วนคำนวณ); F1 WHT (ฝั่งจ่ายคำนวณจริง); 01§3.6 | M | T03, ST5-T02 | ชุด test ≥ 15 กรณีที่นักบัญชีตรวจแล้วผ่าน (1% / 3% / ปน / ต่ำกว่าขั้นต่ำ / มีบรรทัดหัก) | ไม่ — ยอดบน 50 ทวิ |
| ST6-T09 | บันทึกจ่าย: วันโอน เลขอ้างอิง ธนาคาร → สถานะ PAID, trip เป็น SETTLED, event `settlement.paid` (ไฟล์โอนธนาคารเป็น P1) | F6 จ่าย | S | T07, T08 | บันทึกจ่ายได้เฉพาะใบที่ APPROVED; จ่ายแล้ว trip ไม่กลับเข้าคิว | ไม่ — จุดออก 50 ทวิ |
| ST6-T10 | ออก 50 ทวิ (`wht_certificate` ทิศ ISSUED): เลขชุด WHT แยก, 2 ฉบับในไฟล์เดียว, ลายเซ็นสแกน, snapshot ผู้จ่าย/ผู้ถูกหัก, แบบฟอร์มทางการ, ส่งทางอีเมล/LINE, ใบแทน 50 ทวิ | F6 คำนวณ WHT + ออก 50 ทวิ (ส่วนออกเอกสาร); 01§3.6; spec05§11.10 | L | T09, ST1-T09 | บันทึกจ่ายแล้วได้ 50 ทวิ เลขเรียง PDF 2 ฉบับ ข้อมูลตรงกับ settlement; นักบัญชีรับแบบฟอร์ม | ไม่ — หัวใจของเกณฑ์ (ข) |
| ST6-T11 | ลิงก์ "ค่าเที่ยวของฉัน" สำหรับรถร่วม: เที่ยวที่จบ ยอด สถานะจ่าย ดาวน์โหลด 50 ทวิ | F7 คนขับ/รถร่วมดูค่าเที่ยวของตัวเอง (ลิงก์) | M | T10, ST1-T06 | carrier เปิดลิงก์เห็นเฉพาะของตัวเองและดาวน์โหลด 50 ทวิ ได้ | ใช่ — ส่ง PDF ให้เองได้ |
| ST6-T12 | ชุดตรวจนักบัญชี (AP): ใบสำคัญจ่าย + 50 ทวิ ตัวอย่าง + กรณีคำนวณ WHT → นักบัญชีตรวจ → แก้ defect | 02§7 เกณฑ์ผ่าน (ข); 01§8.2 ข้อ 6–7 | S | T10 | นักบัญชีเซ็นรับ 50 ทวิ และวิธีคำนวณ หรือ defect ทุกข้อปิดแล้ว | ไม่ — เกณฑ์ (ข) โดยตรง |

**เสร็จ stage เมื่อ**
- test เขียว รวมชุด test WHT ที่นักบัญชีตรวจ และ test กันจ่ายซ้ำ
- harness แยก tenant ครอบ carrier_settlement, settlement_line, wht_certificate และลิงก์ของ carrier (carrier A เปิดของ carrier B ไม่ได้)
- OpenAPI อัปเดต: settlements (+`/send-to-carrier`, `/dispute`, `/approve`, `/pay`), wht-certificates
- ข้อความ TH/EN ครบ; PDF ใบสำคัญจ่ายและ 50 ทวิ เป็นไทย
- state machine 01§4.5 ทดสอบครบทุก transition
- นักบัญชีเซ็นรับ (ST6-T12)

**เดโมท้าย stage**
1. เปิดคิวจ่ายรถร่วม ติ๊ก 3 เที่ยวของ carrier เดียว → ใบสำคัญจ่าย ใส่บรรทัดหักค่าน้ำมัน
2. ส่งลิงก์ให้รถร่วม → รถร่วมโต้แย้ง 1 รายการ → approve ถูกบล็อก → แก้แล้วรถร่วมยอมรับ
3. ผู้ใช้อีกคนอนุมัติ (ผู้สร้างอนุมัติเองไม่ได้) → บันทึกจ่าย
4. ระบบออก 50 ทวิ 2 ฉบับ ยอดหัก 1% ถูกต้อง → รถร่วมดาวน์โหลดจากลิงก์
5. พยายามนำเที่ยวเดิมไปจ่ายซ้ำ → ถูกปฏิเสธ

---

## ST7 — Open API สาธารณะ และ Integration framework

**เป้าหมาย:** เปิด API ชุดเดียวกับที่ UI ใช้ให้ client ภายนอก (OAuth2/API key, webhook, sandbox) และมีชั้น integration ที่ไม่ผูก ERP ใด:
`ErpAdapter` + outbox + `external_mapping` + error queue ที่ลูกค้าดูเอง — พิสูจน์ด้วย `StandaloneProvider` และ `DemoProvider`

**สิ่งที่ต้องมีก่อนเริ่ม:** ST5 (event `invoice.finalized`, payment) และ ST6 (settlement) · plumbing ST0 (T06–T11) · ตัดสิน webhook retry/auto-disable (spec12 Q-D6) · ตัดสินว่า mapping ไม่ครบ "บล็อก finalize" (docs/04 G3) หรือ "ออกเอกสารได้แต่ outbox ล้มเหลว" (01§7.4) — ข้อ 3.1 · งานกลุ่ม integration (T03, T13–T20) เริ่มขนานกับ ST5/ST6 ได้ถ้ามีคน

| ID | งาน | อ้างอิง | ขนาด | ต้องเสร็จก่อน | เกณฑ์ตรวจรับ | ตัดได้? |
|---|---|---|---|---|---|---|
| ST7-T01 | OAuth2 client credentials (`POST /oauth/token` → JWT RS256 1 ชม., scope `resource:verb`) + API key `tk_live_`/`tk_test_` (หลาย key, scope/expiry/IP allowlist ต่อ key, rotation `revokeAt` ≤ 7 วัน, `lastUsedAt`) + หน้าจัดการ key; principal เดียวกับ JWT ของ UI | G1 Auth; G2 #10 api-keys; 01§5.1; spec07§6 | L | ST1-T12 | key ที่ไม่มี scope `orders:write` เรียก POST /orders ได้ 403; key ที่หมุนแล้วใช้ได้ถึง `revokeAt` เท่านั้น | ใช่ — เฟส 0 ไม่มี client ภายนอก |
| ST7-T02 | External id ทุก resource: ตัวแปลง path `ext:{externalId}` + `PUT/PATCH /{resource}/external/{externalId}` (201/200) + test conformance วนทุก resource P0 | G1 External id | M | ST0-T09 | test conformance: ทุก resource ใน G2 รับ `ext:` และ upsert ซ้ำได้ 200 | ใช่ — orders/customers มีแล้วใน ST2–ST3 |
| ST7-T03 | `integration_outbox` + worker: event ภายใน → outbox ใน transaction เดียว; หยิบด้วย `FOR UPDATE SKIP LOCKED` + lease; serialize ต่อ (connector, ลูกค้า); round-robin ต่อ tenant | G3 Outbox; 01§3.7, 01§6.2 | L | ST0-T10, ST0-T11 | ฆ่า worker กลางงาน → lease หมดแล้วงานถูกหยิบใหม่ ไม่ส่งซ้ำ (idempotency key); ไม่มี event ที่สถานะเปลี่ยนแต่ไม่มี outbox | ไม่ — ทางออกเดียวไป ERP |
| ST7-T04 | Webhook dispatcher: `webhook_endpoint` CRUD, envelope + header ตามมาตรฐาน, HMAC-SHA256 (`t.rawBody`, tolerance 5 นาที), หมุน secret ส่ง 2 ลายเซ็น 24 ชม., timeout 10 วิ, retry 8 ครั้ง, at-least-once, auto-disable หลังล้มเหลว 50 ครั้งติด + อีเมล, verification `challenge` | G1 Webhook; G2 #2 webhooks/events; 01§5.3; spec07§10 | L | T03 | endpoint ทดสอบตรวจลายเซ็นผ่าน; endpoint ที่ตอบ 500 ถูก retry ตามตาราง 8 ครั้งแล้วเป็น EXHAUSTED | ใช่ — เฟส 0 ไม่มีผู้รับ webhook |
| ST7-T05 | Webhook ops: `GET /webhook-deliveries?eventId=`, `POST /webhook-deliveries/{id}/retry`, `POST /events/{id}/redeliver`, เก็บ 30 วัน, `GET /webhooks/event-types` + หน้า UI | G1 Webhook ops; G2 #2 webhook-deliveries/event-types | M | T04 | ดู delivery ที่ล้มเหลวแล้วกด retry สำเร็จจาก UI และ API | ใช่ — ไปคู่กับ T04 |
| ST7-T06 | ทะเบียน event สาธารณะครบตาม 01§5.3 (order / trip / stop / delivery_order / invoice / payment / settlement / connector / job) + JSON schema ต่อ event + contract test | 01§5.3; G1 Webhook (ชื่อ event) | M | T03 | ทุก event ใน 01§5.3 ที่เป็นของเฟส 0 ถูกยิงจริงใน e2e test และตรง schema | ใช่ — event ภายในมีแล้วจาก ST3–ST6 |
| ST7-T07 | Versioning: `X-Api-Version` (default = วันสร้าง tenant), กลไก header `Deprecation`/`Sunset`/`Link`, test ว่า client ทน enum ที่ไม่รู้จัก | G1 Versioning | S | ST0-T09 | request ที่ pin วันที่เก่าได้พฤติกรรมเดิมใน test ตัวอย่าง 1 กรณี | ใช่ — เฟส 0 มีเวอร์ชันเดียว |
| ST7-T08 | Rate limit: 50 req/s ต่อ tenant (burst 100), 20/s ต่อ key, write หนัก 5/s, header `RateLimit-*` + `Retry-After`, `rateLimitProfile` ต่อ plan | G1 Rate limit; J Rate limiting | M | T01 | ยิงเกิน limit ได้ 429 พร้อม `Retry-After`; tenant อื่นไม่ถูกกระทบ | ใช่ — login มี limit แล้ว (ST1-T01) |
| ST7-T09 | Sandbox: tenant mode `test` ใน cluster เดียว, key `tk_test_`, webhook ส่งจริง, `POST /test/events/trigger` | G1 Sandbox | M | T01, T04 | key test มองไม่เห็นข้อมูล live; trigger event จำลองแล้ว webhook ถูกส่ง | ใช่ — staging ใช้แทนได้ |
| ST7-T10 | Bulk/async สาธารณะ: `POST /orders:bulk` ≤ 200 → 207 multi-status; งานหนัก → 202 `{jobId,statusUrl}`; webhook `job.completed`; job เก็บ 7 วัน; รับ Idempotency-Key | G1 Bulk/async; G2 #10 jobs | M | ST0-T11, ST3-T03 | bulk 200 ใบที่มีผิด 2 ใบได้ 207 ระบุผลรายใบ; ส่งซ้ำ key เดิมไม่สร้างซ้ำ | ใช่ — KRS เข้าทีละใบผ่าน poller |
| ST7-T11 | Conformance ของ resource เฟสแรก: orders (+`/cancel`, `/documents`, `/tracking`, `/events`), stops, documents, customers, locations, invoices / invoice-runs / payments (`POST /payments` จาก ERP), trips, drivers / vehicles / carriers — endpoint ขั้นต่ำ + scope + ตัวอย่างใน OpenAPI + contract test; เติม endpoint ที่ขาด | G2 #1, #3, #4, #5, #6, #7, #8; 01§5.2 | L | T01, T02 | ตาราง G2 ทุกแถว P0 มี contract test เขียวที่เรียกด้วย API key (ไม่ใช่ session ของ UI) | ใช่ — UI ใช้ endpoint เหล่านี้อยู่แล้ว |
| ST7-T12 | เอกสาร API: docs site + llms.txt + `.md` ทุกหน้า + Postman collection + เผยแพร่ TypeScript SDK | G1 OpenAPI & SDK (ส่วนเอกสาร/SDK); spec07§9 | M | T11 | คนนอกทีมทำตาม quickstart สร้าง order ใน sandbox ได้ภายใน 15 นาที | ใช่ — docs/02 วางไว้เฟส 2 |
| ST7-T13 | `ErpAdapter` interface + `capabilities()` + connector registry ต่อ tenant (`connector`: adapter_key, company, capabilities ที่เปิด, config เข้ารหัส) + routing ตามนิติบุคคล (company/branch ↔ company ใน ERP; Invoice As / Tender As) ; UI แสดงเฉพาะ capability ที่รองรับ | G3 Interface ErpAdapter + capabilities, Routing ตามนิติบุคคล; 01§6.1, 01§3.7 | M | ST1-T14, ST0-T12 | core ไม่ import adapter ใดตรง ๆ (lint rule); tenant ที่มี 2 นิติบุคคลชี้ connector ต่างกันได้ | ไม่ — สัญญากลางของทุก ERP |
| ST7-T14 | `StandaloneProvider` (no-op, default ทุก tenant) + `DemoProvider` (ERP จำลองในหน่วยความจำ: pull order, รับ invoice, fetch, สถานะรับชำระ, ฉีด error ได้) | G3 Provider factory + StandaloneProvider + DemoProvider | M | T13 | tenant ไม่มี connector: invoice เดิน ISSUED → PAID โดยไม่มีสถานะ sync; tenant demo: finalize แล้วเอกสารไปถึง DemoProvider | ไม่ — standalone ต้องไม่พึ่ง ERP |
| ST7-T15 | `external_mapping` (ทุก entity, hash ของ payload ล่าสุด, เลขเอกสารฝั่ง ERP) + canonical payload (invoice / line / adjustment / settlement) + validation ก่อนเข้า outbox + ส่งเลข TMS ไปช่อง ref ของ ERP | G3 ตาราง external_mapping, เลขเอกสารสองฝั่ง; 01§3.7, 01§7 | L | T13, ST5-T09 | payload เดิม hash เท่าเดิม → ไม่ push ซ้ำ (SKIPPED); push สำเร็จแล้วเก็บ `externalDocNo` | ไม่ — กันส่งซ้ำ + ฐาน reconcile |
| ST7-T16 | Push pipeline: `pushInvoice` หลัง finalize, void, fallback ใบลด/เพิ่มหนี้ตาม capability; ErrorClass + retry policy (TRANSIENT / AMBIGUOUS / DUPLICATE / VALIDATION / AUTH / NOT_FOUND / PERIOD_CLOSED / CAPABILITY); ประตู `syncFromDate`; sync log 1 แถวต่อ 1 HTTP call (ตัด secret) | G3 syncFromDate; 01§6.1–6.4 | L | T03, T14, T15 | ฉีด error ทีละ class ใน DemoProvider แล้วสถานะ outbox/mapping ตรงตาราง 01§6.3; เอกสารก่อน `syncFromDate` ไม่ถูก push | ไม่ — ท่อส่ง invoice ไป KRS |
| ST7-T17 | System-of-record rules ต่อ connector: ใครเป็นเจ้าของลูกค้า/เอกสารภาษี (`taxDocumentOwner`), กลุ่ม field auto-sync vs ต้อง regenerate, แก้ได้จนรับชำระ — เป็น config ที่ service บังคับใช้ + แม่แบบตารางตกลงกับลูกค้าก่อน go-live | G3 System-of-record rules; 01§1 ข้อ 4; 01§8.1 | M | T13 | connector ที่ตั้ง `taxDocumentOwner = ERP` → TMS ไม่ออก `tax_invoice_no`; มีแม่แบบตาราง SoR ใน repo | ไม่ — ต้องตกลงกับ KRS ก่อน go-live |
| ST7-T18 | Sync master ลงมา: `erp_master_code` ต่อ connector (หน่วย พนักงานขาย ผังบัญชี รหัสสินค้า/บริการ อัตรา VAT) ผ่าน adapter หรือ import CSV + หน้า mapping "ค่าบริการ/ประเภทรายได้ TMS ↔ รหัส ERP"; mapping ไม่ครบและ connector เปิด → กันก่อน export | G3 Sync master ลงมา; B ผังรหัส ERP (master code); 01§7.4 | M | T13, ST2-T11 | `service_item` ที่ยังไม่ map → เอกสารถูกกันตามกฎที่ตัดสิน พร้อมลิงก์ไปหน้า mapping | ไม่ — KRS ปฏิเสธรหัสที่ไม่รู้จัก |
| ST7-T19 | Error queue ที่ลูกค้าดูเอง: หน้า "สถานะเชื่อม {connector}" แยก รอคิว / ล้มเหลว / สำเร็จ, Retry รายตัว/ทั้งหมด, Skip พร้อมเหตุผล, กรอก external id มือ, คู่มือต่อ error code, กรณี "งวดบัญชีปิด", ดู request/response log (ตัด secret) | G3 Error queue ลูกค้าดูเอง; 01§6.4; spec07§2 | L | T16 | error ที่ฉีดจาก DemoProvider ขึ้นในแท็บ "ล้มเหลว" พร้อมคำแนะนำ; กด Retry แล้วสำเร็จย้ายไป "สำเร็จ" | ไม่ — K7 และงานประจำของบัญชี KRS |
| ST7-T20 | หน้าจัดการ connector (tenant): เปิด/ปิด, credential เข้ารหัส, healthCheck, feature flag, `syncFromDate`, ลิงก์ไป mapping/log + หน้า Connectors ใน admin portal (เปิด connector ต่อ tenant, ใส่/หมุน key, ดู outbox/sync log ข้าม tenant) | G3 หน้าจัดการ connector; 02§5 (Connectors) | M | T13, ST1-T24 | Innovera เปิด connector demo ให้ tenant จาก admin portal; tenant เห็นสถานะและกด healthCheck ได้; credential ไม่แสดงเต็ม | ไม่ — ตั้งค่า connector ของ pilot |
| ST7-T21 | Payment status pull: scheduler ตาม capability → สร้าง `payment` (source CONNECTOR) → reconcile กับ payment ใน TMS; ส่วนต่างขึ้น MISMATCH (ทดสอบด้วย DemoProvider) | G3 Payment status pull; F5 Payment status จาก ERP | M | T14, ST5-T13 | DemoProvider แจ้งว่าใบ X จ่ายแล้ว → เกิด payment ใน TMS; ยอดต่าง → ขึ้น MISMATCH | ใช่ — KRS ไม่มี capability นี้ (01 A.1) |
| ST7-T22 | Inbound webhook ledger: URL มี tenant token, ตรวจ signature ก่อน, `processed_webhook_event (provider, eventKey)` unique กัน replay | G3 Inbound webhook ledger | S | T13 | ส่ง inbound event เดิม 2 ครั้ง → ประมวลผลครั้งเดียว; signature ผิด → 401 | ใช่ — connector เฟส 0 ไม่มี inbound |
| ST7-T23 | CSV generic export: ส่งออกเอกสารทุกชนิดตาม layout กลาง (ผ่าน `FileExportAdapter`) ดาวน์โหลดได้ | G4 CSV generic; 01§6.1 | M | T15 | export ใบแจ้งหนี้ของเดือนเป็น CSV ยอดรวมตรงกับรายงาน; เปิดใน Excel อ่านไทยได้ | ใช่ — นักบัญชีใช้ PDF/รายงานได้ |

**เสร็จ stage เมื่อ**
- test เขียว รวม contract test ของ resource/event และ test ฉีด error ทุก ErrorClass
- harness แยก tenant ครอบ api_key, webhook_endpoint, webhook_delivery, connector, external_mapping, integration_outbox, sync log
- OpenAPI อัปเดตครบทุก resource P0 และ diff gate ผ่าน
- ข้อความ TH/EN ครบในหน้า connector / error queue / API key / webhook
- ไม่มีชื่อ ERP ใด (รวม KRS) ใน core — มี lint rule ห้าม core import adapter
- tenant standalone (ไม่มี connector) ทำ flow ST3–ST6 ได้เหมือนเดิมทุกขั้น

**เดโมท้าย stage**
1. เปิด connector demo ให้ tenant จาก admin portal → finalize invoice → เห็นเอกสารใน DemoProvider และ `externalDocNo` กลับมา
2. ฉีด error "รหัสไม่รู้จัก" → ขึ้น error queue พร้อมคำแนะนำ → map รหัสแล้วกด Retry สำเร็จ
3. tenant standalone finalize invoice เดียวกัน → ไม่มีสถานะ sync ใด ๆ ปรากฏ
4. สร้าง API key → `PUT /orders/external/{id}` จาก curl → webhook `order.created` ถึง endpoint ทดสอบพร้อมลายเซ็นถูกต้อง
5. เปิดหน้า webhook deliveries กด redeliver

---

## ST8 — KRS connector

**เป้าหมาย:** `KrsAdapter` ทำงานครบตาม 01 Appendix A บน framework ของ ST7 โดย core ไม่เปลี่ยน: ดึง SO → ส่ง invoice → reconcile → หน้า MISMATCH
พัฒนากับ mock จาก contract ก่อน แล้วซ้อมด้วยข้อมูลจริง 1 เดือน

**สิ่งที่ต้องมีก่อนเริ่ม:** ST7 กลุ่ม integration (T03, T13–T20) · **คำตอบทีม KRS (01 A.6)** อย่างน้อย: แหล่ง SO + read-only login, รหัสลูกค้า NSF ↔ PP, รายการ master code, VAT ต่อรายการ, วิธียกเลิกใบ, มี staging หรือไม่, ใครเป็นเจ้าของเอกสารภาษี · API key ของ api-pueanphet (ทดสอบ) · ตัวอย่างข้อมูลจริง 1 เดือน

| ID | งาน | อ้างอิง | ขนาด | ต้องเสร็จก่อน | เกณฑ์ตรวจรับ | ตัดได้? |
|---|---|---|---|---|---|---|
| ST8-T01 | Mock KRS API จาก contract: `POST/PUT/GET /invoice` ตรวจ whitelist ฟิลด์ (ส่งเกิน = 400), 401, 404, 409 `tmsVoucherNo` ซ้ำ, สวิตช์ 503/timeout, จำลอง "บัญชีกดบันทึกแล้วรายการถูกเขียนใหม่" | 01 A.1, A.3, A.5; NFR Environments (mock KRS) | M | ST0-T19 | mock ตอบตรงตาราง A.1 ทุก error code; เปิดสวิตช์เขียนทับแล้ว GET ได้รายการที่เปลี่ยน | ไม่ — KRS อาจไม่มี staging |
| ST8-T02 | Mock แหล่ง SO: SQL Server (docker) + view `vw_TMS_SalesOrder` + ข้อมูลตัวอย่าง (หรือ stub `GET /salesorder?since=` ตามคำตอบ KRS) | 01 A.4 | S | ST0-T19 | poller ชี้มาที่ mock แล้วอ่าน SO ตัวอย่างได้ รวมแถวที่ถูกยกเลิก/แก้ไข | ไม่ — พัฒนา poller ได้ก่อน |
| ST8-T03 | โครง `KrsAdapter`: capabilities `{pullOrders, pushInvoice, fetchDocument, replaceDocument, ownsDocumentNumber}`, config (base URL, `X-API-Key` เข้ารหัส, SQL login read-only), `healthCheck` (503 → หยุดคิวของ connector) | G4 KRS; 01 A.2 | M | ST7-T13, T01 | เปิด connector KRS ให้ tenant ทดสอบแล้ว healthCheck เขียว; ปิด mock → คิวหยุดและขึ้นสถานะ ERROR | ไม่ — เกณฑ์ (ก) |
| ST8-T04 | SO poller: ทุก 5 นาที watermark → แปลงเป็น CanonicalOrder → `PUT /v1/orders/external/KRS-{company}-{soNo}`; เก็บแถวดิบ; view/คอลัมน์หาย → SO ค้าง `SOURCE_ERROR` + connector ERROR | 01 A.2, A.4; C รับจาก ERP connector (ตัวจริง) | M | T02, T03, ST3-T05 | SO ใหม่ใน mock ปรากฏเป็น order ภายใน 1 รอบ; รัน poll ซ้ำไม่เกิด order ซ้ำ | ไม่ — เกณฑ์ (ก) |
| ST8-T05 | Mapping ลูกค้า NSF ↔ PP ใน `external_mapping` (รหัสสำหรับ poll และ `custOrSuppCode`) + SO ที่ KRS ยกเลิก (ยกเลิกถ้ายังไม่มี DO มิฉะนั้นแจ้งเตือน) + SO ที่แก้หลังวางแผน (ไม่ทับ เก็บ diff) | 01 A.4; C ยกเลิก/คืนสถานะ (กรณี ERP) | M | T04, ST7-T15 | SO ลูกค้าใหม่ค้าง `CUSTOMER_UNMAPPED`; map ครั้งเดียวได้ mapping 2 รหัส; SO ที่ยกเลิกใน mock ถูกยกเลิกใน TMS | ไม่ — เกณฑ์ (ก) |
| ST8-T06 | รหัส master ของ KRS → `erp_master_code` (หน่วย, พนักงานขาย, itemCode, accountCode) ผ่าน import/รายการที่ KRS ให้ + ตั้ง mapping | 01 A.3; B ผังรหัส ERP (ส่วน KRS) | S | ST7-T18 | หน่วย "เที่ยว/ตัน/กม." map ครบ; ค่าที่ไม่มีใน master ถูกกันก่อนเข้า outbox | ไม่ — KRS ตอบ 400 ถ้ารหัสผิด |
| ST8-T07 | Payload builder ตาม A.3: หัวเอกสาร + รายการ (1 รายการ = 1 DO), whitelist ฟิลด์, วันที่ `YYYY-MM-DD`, `lineId` เป็น int, แบ่งใบถ้าเกิน 50 MB, ตรวจ master code; unit test เทียบ JSON schema ของ contract | 01 A.3, 01§7 | L | T03, ST7-T15 | ใบ 446 รายการสร้าง payload ผ่าน schema; ใส่ field นอก whitelist แล้ว test แดง | ไม่ — เกณฑ์ (ก) |
| ST8-T08 | `pushInvoice`: `POST /invoice` โดย `tmsVoucherNo` = เลขใบแจ้งหนี้; 201 → เก็บ `transactionNo` + `voucherNo`; แยกใบตาม `vat_type` (สัญญา KRS ไม่มี VAT ต่อรายการ); SO อยู่บริษัท NSF ใบออกบริษัท PP (routing) | 01 A.2, A.6; G4 KRS | M | T07, ST7-T16 | finalize ใน TMS → mock ได้ POST 1 ครั้ง → mapping มี `transactionNo`/`voucherNo` | ไม่ — เกณฑ์ (ก) |
| ST8-T09 | จัดการ error ตาม A.5: 409 DUPLICATE (ไม่ POST ซ้ำ; error queue ให้กรอก `transactionNo` มือ), 503 TRANSIENT (backoff + หยุดคิว), timeout AMBIGUOUS, 400 VALIDATION, 401 AUTH (หยุด connector), 404 NOT_FOUND → REMOTE_MISSING; concurrency 3, serialize ต่อลูกค้า | 01 A.5; 01§6.3 | L | T08 | ทุกแถวของตาราง A.5 มี test กับ mock และผลตรงคอลัมน์ "ทำอะไร" | ไม่ — เกณฑ์ (ก) |
| ST8-T10 | `fetchDocument`: `GET /invoice/{transactionNo}` → แปลงกลับเป็น canonical จับคู่รายการด้วย `flowNo` (= เลข DO) | 01 A.2; 01§6.5 | M | T07 | push แล้ว fetch กลับได้ canonical เท่าต้นฉบับ (round-trip test) | ไม่ — ฐานของ reconcile |
| ST8-T11 | Reconcile engine (ทั่วไป ไม่ผูก KRS): 4 รอบ AFTER_PUSH (+60 นาที) / NIGHTLY 02:00 / PRE_CLOSE / MANUAL; เทียบระดับ HEADER / LINE_COUNT / TOTAL / LINE_FIELD / EXTRA_LINE; `reconcile_result` + `diff_hash` กันแจ้งซ้ำ; invoice → ACCEPTED / MISMATCH | 01§6.5, 01§4.4; G3 (K12 ห้าม sync ทางเดียวไม่ reconcile) | L | T10 | จำลองเขียนทับใน mock (79 → 30 รายการ) → รอบถัดไปขึ้น MISMATCH ระบุรายการที่หาย; รันซ้ำไม่แจ้งซ้ำ | ไม่ — เกณฑ์ (ก) โดยตรง |
| ST8-T12 | หน้า MISMATCH: รายการตาม severity, diff รายบรรทัดสองฝั่ง, ปิดได้ 3 ทาง (แก้ที่ TMS ด้วยใบลด/เพิ่มหนี้ / ส่งทับด้วย approval / ack พร้อมเหตุผล) บันทึกคนและเหตุผล; severity MONEY แจ้งหัวหน้าบัญชีทันที + สรุป 08:00 | 01§6.5; 02§7 | L | T11 | MISMATCH ตัวอย่างปิดได้ครบ 3 ทาง และแต่ละทางมีบันทึกผู้ทำ/เหตุผลใน audit | ไม่ — เกณฑ์ (ก) โดยตรง |
| ST8-T13 | Fallback ใบลด/เพิ่มหนี้สำหรับ KRS: สร้างภาพ invoice "หลังปรับ" → `PUT /invoice/{transactionNo}`; ต้องผ่าน approval ถ้ากดปุ่ม "ลงบัญชีแล้ว" หรืออายุใบเกิน N วัน; กรณียกเลิกใบ (KRS ไม่มี DELETE) ทำตามคำตอบ KRS | 01 A.2, A.6; 01§6.1 | M | T10, ST5-T19 | ออกใบลดหนี้ใน TMS → mock ได้ PUT ยอดหลังปรับ; ใบที่ติดธง "ลงบัญชีแล้ว" ต้องมีผู้อนุมัติก่อนส่ง | ไม่ — แก้ใบระหว่างงวด pilot |
| ST8-T14 | รายงานปิดงวด: MISMATCH ค้าง ณ สิ้นเดือน (ต้อง = 0), รายการที่ ack พร้อมเหตุผล, เอกสารที่ยังไม่ถูกส่ง | 02§7 เกณฑ์ผ่าน (ก) | S | T12 | รายงานของเดือนทดสอบแสดง 0 ค้างเมื่อปิดครบ และ export ได้ | ไม่ — หลักฐานของเกณฑ์ (ก) |
| ST8-T15 | ซ้อมข้อมูลจริง 1 เดือนบน staging: ดึง SO จริง (สำเนา) → วางบิล → push เข้า mock/staging ของ KRS → reconcile → บันทึกปัญหา | 02§7; 01 A.6 (Staging) | M | T12, T13 | ซ้อมครบ 1 เดือน: ทุกใบถูกส่ง, MISMATCH ทุกรายการอธิบายได้, รายการ defect ปิดก่อน go-live | ไม่ — ลดความเสี่ยง go-live |

**เสร็จ stage เมื่อ**
- test เขียว รวม test ทุกแถวของตาราง A.5 และ round-trip ของ payload
- harness แยก tenant ครอบ reconcile_result, erp_master_code และข้อมูล connector KRS
- โค้ด KRS อยู่ใน adapter เท่านั้น: ปิด connector แล้ว tenant เดิมยังทำงานแบบ standalone ได้ (test)
- OpenAPI อัปเดต: reconcile-results, reconcile-runs
- ข้อความ TH/EN ครบในหน้า MISMATCH และคู่มือ error ของ KRS
- คำถาม KRS ใน 01 A.6 ทุกข้อมีคำตอบหรือทางเดินชั่วคราวที่ KRS รับทราบ
- ซ้อมข้อมูลจริง 1 เดือนผ่าน (ST8-T15)

**เดโมท้าย stage**
1. เพิ่ม SO ใน mock KRS → ภายใน 5 นาทีขึ้นใน TMS (1 ใบค้างเพราะลูกค้าไม่รู้จัก → map แล้วเข้า)
2. จัดรถ → ปิดงาน → finalize invoice → เห็น `voucherNo` ของ KRS กลับมาและสถานะ ACCEPTED
3. จำลองบัญชี KRS กดบันทึกแล้วรายการหาย → reconcile ขึ้น MISMATCH ระบุบรรทัดที่หาย
4. ปิด MISMATCH ด้วยการส่งทับ (ผ่าน approval) → รายงานปิดงวดแสดงค้าง 0
5. ปิด mock (503) → คิวหยุดเอง แจ้งเตือน admin → เปิดกลับแล้วคิวเดินต่อไม่ส่งซ้ำ

---

## ST9 — Reports, cross-cutting, security/NFR, UAT

**เป้าหมาย:** dashboard/รายงานที่อ่านจากบรรทัดเอกสารชุดเดียวกับบิล งานร่วมที่เหลือ (แจ้งเตือน ค้นหา export) และการพิสูจน์ความปลอดภัย/ประสิทธิภาพ/สำรองข้อมูล
ปิดท้ายด้วย UAT ตามเกณฑ์ผ่านเฟส 0 ทั้งสองข้อและ checklist ขึ้นใช้งานจริง

**สิ่งที่ต้องมีก่อนเริ่ม:** ST5–ST8 ครบ (งานรายงาน T01–T07 เริ่มได้ทันทีที่ ST5/ST6 เสร็จ) · tenant standalone ทดสอบตัวจริง + นักบัญชีของเขา (docs/02 §8) · ตกลง SLA/ช่วงเวลา UAT กับ KRS · production environment ใน region ไทยพร้อม

| ID | งาน | อ้างอิง | ขนาด | ต้องเสร็จก่อน | เกณฑ์ตรวจรับ | ตัดได้? |
|---|---|---|---|---|---|---|
| ST9-T01 | Dashboard ปฏิบัติการ: วันนี้ — order รอจัด (ตาม reason code), trip กำลังวิ่ง, ส่งแล้ว, ล้มเหลว, รถว่าง/ใช้งาน/ซ่อม, งานรถร่วมรอตอบ | H Dashboard ปฏิบัติการ; spec09§1 | M | ST4-T03 | ตัวเลขแต่ละการ์ด = จำนวนแถวเมื่อคลิกเข้าไปดูรายการ (test เทียบ) | ใช่ — ดูจากหน้ารายการได้ |
| ST9-T02 | Dashboard บิล: draft / ค้างวางบิล (มูลค่า) / ออกแล้วรอชำระ / ครบกำหนด / รับชำระบางส่วน / WHT รอ 50 ทวิ; เดือนนี้ vs เดือนก่อน — จากตาราง invoice/payment | H Dashboard บิล | M | ST5-T18 | ยอดบน dashboard = ผลรวมจากเอกสารจริง (test เทียบกับ query เอกสาร) | ใช่ — ไม่กระทบการออกเอกสาร |
| ST9-T03 | Dashboard AP รถร่วม: รอตรวจ / disputed / รออนุมัติ / รอจ่าย / จ่ายแล้ว; 50 ทวิ ที่ยังไม่ออก | H Dashboard AP รถร่วม | S | ST6-T10 | ตัวเลขตรงกับจำนวน settlement ตามสถานะ | ใช่ — ดูจากคิว settlement ได้ |
| ST9-T04 | Dashboard เชื่อมต่อ (ต่อ connector: คิว ล้มเหลว lag health) + หน้า Health ใน admin portal (คิวค้าง, MISMATCH เปิดอยู่, poller ล่าสุด, error rate 7 วัน ต่อ tenant) | H Dashboard เชื่อมต่อ; 02§5 (Health) | M | ST7-T19, ST8-T12 | หยุด mock KRS แล้ว dashboard แสดง health แดงและ lag เพิ่มภายใน 5 นาที | ไม่ — docs/02 §7 ต้องมี health |
| ST9-T05 | รายงานรายได้: ต่อลูกค้า / เส้นทาง / รถ / ประเภทรถ / นิติบุคคล / เดือน — จาก invoice line ที่ finalize แล้ว; export CSV/Excel/PDF | H รายได้; K3 | M | ST5-T09 | ยอดรวมรายงานเดือน = ผลรวม invoice ที่ออกในเดือน ± ใบลด/เพิ่มหนี้ | ใช่ — เกณฑ์ไม่ได้ใช้ |
| ST9-T06 | รายงาน "DO ยังไม่วางบิลเกิน N วัน" (+ ส่งอีเมลให้ Invoicer อัตโนมัติ) และรายงานค้างชำระ/aging ต่อลูกค้า + รายการ 50 ทวิ ที่ยังไม่ได้รับ; export | H DO ยังไม่วางบิลเกิน N วัน, ค้างชำระ/aging | M | ST5-T05, ST5-T22 | DO ที่ส่งแล้วเกิน N วันและยังไม่อยู่ในใบใดขึ้นรายงาน; ยอด aging ตรงกับ ST5-T22 | ใช่ — เกณฑ์ไม่ได้ใช้ |
| ST9-T07 | รายงานภาษี: หน้าเดียวรวมภาษีขายต่อสาขา + รายได้ยกเว้น VAT (จาก ST5-T23) + สรุป WHT ถูกหัก (รับ) + สรุป WHT ที่หัก (จ่าย) รายเดือนแยกบุคคล/นิติบุคคล (ไฟล์ RD Prep เป็น P1) | H รายงานภาษี; spec09§7 | M | ST5-T23, ST6-T10 | สรุป WHT ที่หักของเดือน = ผลรวม 50 ทวิ ที่ออกในเดือน (test เทียบ) | ไม่ — นักบัญชีใช้ยื่น ภ.ง.ด.3/53 |
| ST9-T08 | ศูนย์แจ้งเตือน: ต่อ event P0 ครบ (ใบค้างใหม่, รถร่วมหมดเวลา, dispute, ขออนุมัติ, เอกสารรถ/ใบขับขี่/rate card ใกล้หมด, connector ล่ม, DO ยังไม่วางบิล, ครบกำหนดชำระ), ผู้ใช้ตั้งว่ารับอะไรทางไหน, สรุปรายวัน 08:00 | I การแจ้งเตือน | L | ST1-T23 | ผู้ใช้ปิดการรับ event หนึ่งทางอีเมลแล้วไม่ได้อีเมลนั้นแต่ยังเห็น in-app; สรุป 08:00 ส่งครั้งเดียว | ใช่ — การเตือนหลักต่อไว้แล้วราย stage |
| ST9-T09 | ค้นหา global (⌘K): เลข order/trip/invoice, ทะเบียน, ลูกค้า, เลข PO → กระโดดไปเอกสาร | I ค้นหา global | M | ST5-T09 | พิมพ์เลข DO บางส่วนแล้วเจอและเปิดเอกสารได้; ไม่เห็นผลของ tenant อื่น (test) | ใช่ — ค้นในแต่ละหน้าได้ |
| ST9-T10 | Export ตาม filter ทุกหน้ารายการ/เอกสาร; งานใหญ่เป็น background job + แจ้งเมื่อเสร็จ | I Import/Export (ขา export) | M | ST0-T11 | export 50,000 แถวเป็น job แล้วได้ลิงก์ดาวน์โหลดทางแจ้งเตือน; ไฟล์ตรงกับ filter | ใช่ — master มี export แล้ว |
| ST9-T11 | Saved views: บันทึกชุด filter/คอลัมน์ต่อผู้ใช้บนตารางและรายงาน | I UI pattern มาตรฐาน (saved views); H (บันทึก filter) | S | ST0-T14 | บันทึก view แล้วเปิดใหม่ได้ filter/คอลัมน์เดิม | ใช่ — ความสะดวก |
| ST9-T12 | ตรวจความครบ: ทุก setting ในแถว "ตั้งค่าองค์กร" ตั้งได้จาก UI (K5) + ข้อความ TH/EN ครบทุกหน้า + PDF ทุกชนิดเป็นไทย | I ตั้งค่าองค์กร, ภาษา; K5, K10 | S | ST1-T17 | checklist setting ครบทุกข้อ; สแกนไม่พบ key ภาษาที่ขาด | ไม่ — กันต้องให้เราตั้งให้ |
| ST9-T13 | ตรวจความปลอดภัยรอบสุดท้าย: รายงาน coverage ของ test ข้าม tenant (ทุก endpoint), validation/upload/MIME, CSRF/XSS, security headers, secret ใน log, ทดสอบ magic link (หมดอายุ/จำกัด action/เพิกถอน/ไม่รั่วราคา), ทบทวนสิทธิ์ตามตาราง A3 | J Security ทุกแถว P0 (ตรวจซ้ำ); spec11§2–3 | M | ST8-T12 | checklist ผ่านทุกข้อ หรือ defect ระดับสูงทุกข้อปิดแล้ว; coverage ข้าม tenant = 100% ของ route | ไม่ — ข้อมูลจริงของ pilot |
| ST9-T14 | Retention: ตั้งระยะเก็บต่อ tenant (ไม่ต่ำกว่าขั้นต่ำ) + job ลบ/archive — audit 5 ปี, integration log 24 เดือน, login log 1 ปี, ไฟล์ POD 2 ปี, GPS log 90 วัน (ยังไม่มีข้อมูลในเฟส 0) | J Retention (audit/integration/login/POD/GPS) | M | ST1-T22 | ตั้งค่าต่ำกว่าขั้นต่ำถูกปฏิเสธ; test เลื่อนเวลา: log เกินอายุถูกลบ เอกสารภาษีไม่ถูกแตะ | ใช่ — ยังไม่มีข้อมูลครบอายุ |
| ST9-T15 | เอกสารภาษี ≥ 5 ปี: ยืนยันไม่มี hard-delete (guard ระดับ DB), retention default 7 ปี, PDF ที่เก็บ ณ วันออกไม่ถูก render ใหม่ (เทียบ hash) | J เอกสารภาษี ≥ 5 ปี | S | ST5-T09, ST6-T10 | คำสั่ง DELETE บนตารางเอกสารภาษีถูก DB ปฏิเสธ; hash ของ PDF ไม่เปลี่ยนหลังแก้ template | ไม่ — ข้อกฎหมาย |
| ST9-T16 | ชุด PDPA เฟส 0: DPA ในสัญญา, Record of Processing, privacy notice template ให้ tenant, ขั้นตอนแจ้งเหตุละเมิด 72 ชม., ทบทวนการเก็บเลขบัตรคนขับ (เครื่องมือ DSAR เป็น P1) | J PDPA | S | — | เอกสาร 4 ชิ้นผ่านการทบทวนของเจ้าของ และแนบในสัญญา pilot | ไม่ — มีข้อมูลบุคคลจริง |
| ST9-T17 | ทดสอบประสิทธิภาพ: ตาราง 10,000 แถว < 2 วิ; finalize invoice 500 DO < 5 วิ; invoice run 2,000 DO < 2 นาที; API p95 < 300 ms; webhook ภายใน 5 วิ — สคริปต์รันซ้ำได้ | NFR Performance, ขนาด; spec11§8 | M | ST5-T12, ST7-T04 | รายงานผลเทียบเป้าทุกข้อ; ข้อที่ไม่ผ่านมี ticket + แผนแก้ | ไม่ — ใบ KRS มี 446 รายการ |
| ST9-T18 | Backup/restore: snapshot ทุก 6 ชม. + WAL เก็บ 30 วัน, ไฟล์ versioned, ซ้อมกู้คืนจริงวัด RPO 1 ชม. / RTO 4 ชม. | NFR Backup | M | ST0-T03 | ซ้อมกู้คืนลง environment ใหม่สำเร็จภายใน 4 ชม. ข้อมูลหายไม่เกิน 1 ชม. มีบันทึกผล | ไม่ — เอกสารภาษีห้ามหาย |
| ST9-T19 | Monitoring + alert: uptime, error rate, คิว outbox/webhook, connector lag, job queue, disk; alert ถึงทีม Innovera; วัด availability 99.5% | NFR Monitoring, Availability | M | ST7-T03 | จำลองคิวค้างเกินเกณฑ์ → ทีมได้ alert ภายใน 5 นาที | ไม่ — pilot ใช้งานจริง |
| ST9-T20 | Accessibility + browser: contrast WCAG 2.1 AA, ใช้คีย์บอร์ดในตาราง/ฟอร์ม, ทดสอบ Chrome/Edge/Safari จอ ≥ 1280 | NFR Accessibility, Browser/device | S | ST0-T14 | รายงานตรวจหน้าหลัก 10 หน้า; defect ระดับสูงปิดแล้ว | ใช่ — ไม่กระทบเกณฑ์ |
| ST9-T21 | UAT ชุด (ก) KRS: สคริปต์รอบเดือน — ดึง SO → จัดรถ → POD → วางบิล → push → reconcile → ปิด MISMATCH → รายงานปิดงวด; ทำ 2 งวดติด; แบบฟอร์มเซ็นรับ | 02§7 เกณฑ์ผ่าน (ก) | M | ST8-T15 | ผู้ใช้ KRS ทำครบสคริปต์เองได้; งวดที่ 1 และ 2 ปิดด้วย MISMATCH ค้าง = 0 และมีลายเซ็นรับ | ไม่ — เกณฑ์ (ก) โดยตรง |
| ST9-T22 | UAT ชุด (ข) Standalone: สคริปต์รอบเดือน — รับงาน → จัดรถ (รวมรถร่วม) → POD → ใบแจ้งหนี้/ใบวางบิล → รับชำระ → ใบเสร็จ/ใบกำกับภาษี → settlement → 50 ทวิ → รายงานภาษี; นักบัญชีของ tenant ตรวจ | 02§7 เกณฑ์ผ่าน (ข); spec12§1 เกณฑ์ผ่าน P0 | M | ST5-T25, ST6-T12 | นักบัญชีของ tenant เซ็นรับเอกสารของรอบเดือนจริง 1 รอบ | ไม่ — เกณฑ์ (ข) โดยตรง |
| ST9-T23 | Checklist ขึ้นใช้งานจริง + runbook: ขั้นตอน onboard tenant, ตัดสิน `syncFromDate`, ตาราง system-of-record ที่ตกลงแล้ว, เลขเริ่มต้นของชุดเอกสาร, อบรมผู้ใช้, ช่องทาง support, แผนถอยกลับ | 02§7; G3 System-of-record, syncFromDate | S | T21, T22 | checklist ถูกติ๊กครบและเซ็นรับโดยเจ้าของก่อนเปิด production ให้ pilot | ไม่ — ประตูสุดท้าย |

**เสร็จ stage เมื่อ**
- test เขียวทั้ง repo; test เทียบ "ยอดรายงาน = ยอดเอกสาร" ผ่านทุกรายงาน (K3)
- harness แยก tenant ครอบ 100% ของตารางและ route (รายงานแนบใน ST9-T13)
- OpenAPI ฉบับสุดท้ายของเฟส 0 ถูก tag; ไม่มี breaking change ค้าง
- ข้อความ TH/EN ครบทุกหน้า (ST9-T12)
- ผลทดสอบประสิทธิภาพและซ้อมกู้คืนถูกบันทึก ผ่านเป้าหรือมีแผนแก้
- UAT (ก) และ (ข) มีลายเซ็นรับ; checklist ขึ้นใช้งานจริงครบ
- ไม่มี defect ระดับสูงเปิดค้าง

**เดโมท้าย stage**
1. เปิด dashboard บิลและคลิกลงไปถึงเอกสาร — ยอดตรงกันทุกการ์ด
2. เปิดรายงานภาษีของเดือน (ภาษีขาย + WHT) เทียบกับเอกสารจริง
3. แสดงผลซ้อมกู้คืนฐานข้อมูลและรายงานทดสอบข้าม tenant 100%
4. เดินสคริปต์ UAT (ข) ย่อ: งาน 1 ใบจากรับงานถึง 50 ทวิ ภายในเดโมเดียว
5. แสดงรายงานปิดงวดของ KRS (MISMATCH ค้าง 0) และ checklist ขึ้นใช้งานจริง

---

## 3. ตารางตรวจความครบ (docs/04 แถว P0 → งาน)

ทุกแถว P0 ของ docs/04 มีเจ้าของ 1 stage (คอลัมน์ Stage) · งานในวงเล็บ = งานเสริมจาก stage อื่น (ฐานที่ทำไว้ก่อน หรือการตรวจซ้ำ) · `†n` = มีจุดกำกวม ดูข้อ 3.1 ข้อ n · แถวที่มี 2 ระดับ (เช่น P0/P1) นับเฉพาะส่วน P0

| โมดูล | แถว P0 | Stage | งาน |
|---|---|---|---|
| A1 | Login อีเมล + รหัสผ่าน | ST1 | ST1-T01 |
| A1 | นโยบายรหัสผ่าน | ST1 | ST1-T02 |
| A1 | ลืมรหัสผ่าน | ST1 | ST1-T03 |
| A1 | 2FA TOTP | ST1 | ST1-T05 |
| A1 | Session | ST1 | ST1-T04 |
| A1 | Token version ต่อ user | ST1 | ST1-T04 |
| A1 | เข้าถึงโดยไม่ login (magic link) | ST1 | ST1-T06 |
| A2 | เชิญผู้ใช้ | ST1 | ST1-T07 |
| A2 | โปรไฟล์ | ST1 | ST1-T09 |
| A2 | ระงับ / เปิดใช้ / ลบ | ST1 | ST1-T10 |
| A2 | ประวัติ login | ST1 | ST1-T11 |
| A3 | Role และ permission (ตารางสิทธิ์ + กฎเพิ่มเติม) †11 | ST1 | ST1-T12, ST1-T13 (ST5-T09, ST5-T19, ST6-T07) |
| A4 | `legal_entity` ใน tenant †1 | ST1 | ST1-T14 |
| A4 | `company_branch` ต่อนิติบุคคล †1 | ST1 | ST1-T14 |
| A4 | Number series | ST1 | ST1-T15 |
| A4 | Routing เอกสารตามนิติบุคคล | ST1 | ST1-T16 (ST2-T01, ST2-T05, ST7-T13) |
| A5 | Setup checklist | ST1 | ST1-T21 |
| A5 | Import Excel ทุก master แบบ dry-run | ST1 | ST1-T19 (ST2-T23) |
| A5 | ค่าเริ่มต้นภาษาไทยพร้อมใช้ | ST1 | ST1-T20 (ST2-T04, ST2-T11, ST2-T12) |
| A5 | Feature flag ตาม plan + override | ST1 | ST1-T18 |
| A6 | Innovera platform admin (ส่วน P0) †12 | ST1 | ST1-T24 (ST7-T20, ST9-T04) |
| A7 | Audit log | ST1 | ST1-T22 |
| B | กฎร่วมทุก master (ค้นหา, ปิดใช้, import, export, externalId, ประวัติ) | ST2 | ST2-T01, ST2-T23 |
| B | ลูกค้า | ST2 | ST2-T01 (ST4-T05 สำหรับ POD checklist) |
| B | Carrier (รถร่วม/ผู้รับเหมา) | ST2 | ST2-T05 |
| B | รถ | ST2 | ST2-T04, ST2-T06 |
| B | คนขับ †3 | ST2 | ST2-T08, ST2-T18 (ST3-T14 ตรวจใบขับขี่ตอน assign) |
| B | จุดส่ง / สถานที่ | ST2 | ST2-T02, ST2-T03 |
| B | เส้นทาง (route / OD pair) | ST2 | ST2-T09 |
| B | Rate card ขาขาย †3 | ST2 | ST2-T13, ST2-T18 |
| B | Rate card ขาซื้อ | ST2 | ST2-T14 |
| B | Accessorial catalog | ST2 | ST2-T11 |
| B | Reason master | ST2 | ST2-T12 |
| B | สินค้า / หน่วย | ST2 | ST2-T10 |
| B | คลัง / ต้นทาง | ST2 | ST2-T09 |
| B | Vehicle-type compatibility | ST2 | ST2-T16 (ST3-T14) |
| B | ผังรหัส ERP (master code) — P0 (KRS) | ST7 | ST7-T18 (ST8-T06) |
| B1 | เหมาเที่ยว (FLAT_TRIP) †3 | ST2 | ST2-T15 |
| B1 | ตามระยะทาง (PER_DISTANCE) | ST2 | ST2-T15 |
| B1 | ตามน้ำหนัก/ปริมาตร (PER_UNIT) | ST2 | ST2-T15 |
| B1 | เกิน N จุดคิดเพิ่มต่อจุด | ST2 | ST2-T15 |
| B1 | สถานะคำนวณ (`pricingStatus`) | ST2 | ST2-T15 |
| B2.1 | 1. ทะเบียนรถขยาย †15 | ST2 | ST2-T06, ST2-T22 (ST4-T03 เลขไมล์) |
| B2.1 | 2. เอกสารและต่ออายุ †15 | ST2 | ST2-T17, ST2-T18 |
| B2.1 | รถร่วม (SUBCONTRACT) แบบย่อ | ST2 | ST2-T20, ST2-T21 |
| B2.2 | ทะเบียนรถ / โปรไฟล์รถ (ตาราง + โปรไฟล์พื้นฐาน) | ST2 | ST2-T07 |
| B2.2 | เอกสารรถรวม | ST2 | ST2-T19 |
| B2.3 | D Planning & Dispatch — badge เอกสาร (ส่วน P0) | ST3 | ST3-T14 |
| C | Upsert ด้วย external id | ST3 | ST3-T03 |
| C | Source ของ order | ST3 | ST3-T01 |
| C | กรอกมือ | ST3 | ST3-T02 |
| C | Import Excel | ST3 | ST3-T04 |
| C | รับจาก ERP connector | ST3 | ST3-T05 (ST8-T04) |
| C | รับจาก Open API | ST3 | ST3-T03 |
| C | จับคู่อัตโนมัติ | ST3 | ST3-T06 |
| C | เรียนรู้ alias | ST3 | ST3-T06 |
| C | หน้าใบค้าง + reason code ครบชุด †4 | ST3 | ST3-T07 |
| C | Edit lock | ST3 | ST3-T08 |
| C | แยก / รวม order | ST3 | ST3-T09 |
| C | ยกเลิก / คืนสถานะ | ST3 | ST3-T10 (ST8-T05) |
| D1 | Order (DO) †1 | ST3 | ST3-T01, ST3-T09 (ST5-T01 revenue line) |
| D1 | Trip (ใบคุมรถ) | ST3 | ST3-T11 (ST6-T01 cost line) |
| D1 | TripStop | ST3 | ST3-T11 |
| D1 | สถานะ trip †2 | ST3 | ST3-T11 (ST4-T03) |
| D2 | จอ split: pool ซ้าย / scheduler ขวา | ST3 | ST3-T12 |
| D2 | View | ST3 | ST3-T13 |
| D2 | Filter รถที่รับได้สองทาง | ST3 | ST3-T15 |
| D2 | ตรวจ constraint ตอนจัด †20 | ST3 | ST3-T14 |
| D2 | เวลาขัดกันขึ้นแดงไม่บล็อก | ST3 | ST3-T12 |
| D2 | Multi-drop | ST3 | ST3-T16 |
| D2 | Assign vs Dispatch แยกปุ่ม | ST3 | ST3-T17 |
| D2 | Send all | ST3 | ST3-T18 |
| D2 | ตารางรถ/คนขับรายวัน | ST3 | ST3-T19 |
| D2 | ใบงานประจำวัน | ST3 | ST3-T20 |
| D3 | เลือก carrier + ราคาซื้อ | ST3 | ST3-T22 |
| D3 | ส่งลิงก์ LINE/SMS ไม่ต้อง login †13 | ST3 | ST3-T23 (ST3-T21) |
| D3 | หมดเวลา → แจ้ง dispatcher | ST3 | ST3-T24 |
| D3 | บันทึกเหตุผลการเลือก | ST3 | ST3-T22 |
| D3 | เปลี่ยน carrier †13 | ST3 | ST3-T25 |
| E1 | Stop event | ST4 | ST4-T01 |
| E1 | Idempotent server | ST4 | ST4-T02 |
| E2 | อัปเดตสถานะผ่านเว็บ | ST4 | ST4-T04 |
| E2 | POD checklist config ต่อลูกค้า | ST4 | ST4-T05, ST4-T06 |
| E2 | ePOD ผ่านเว็บ | ST4 | ST4-T07 |
| E2 | ePOD ผ่านลิงก์ (รถร่วม/คนขับไม่มีแอป) | ST4 | ST4-T08, ST4-T09 |
| E2 | Actual quantity + reject reason ต่อรายการ | ST4 | ST4-T10 |
| E2 | ตีกลับบางส่วน/ทั้งหมด | ST4 | ST4-T11 |
| E2 | Undelivered-retain + auto-reschedule | ST4 | ST4-T12 |
| E2 | บันทึกเหตุล่าช้า / ค่าใช้จ่ายหน้างาน | ST4 | ST4-T13 |
| E2 | Tracking link สาธารณะ | ST4 | ST4-T14 |
| E2 | Driver app — เฉพาะส่วน M10 (P0) | ST4 | ST4-T08, ST4-T09 (ST3-T23) |
| E2.1 | M10 ลิงก์รถร่วม (web ไม่ต้อง login) | ST4 | ST4-T08, ST4-T09 (ST3-T23 ส่วนรับ/ปฏิเสธ) |
| E2.2 | Offline-first — เฉพาะข้อ "M10 = P0 ไม่มี outbox แต่ส่ง `clientEventId`" | ST4 | ST4-T08 |
| E2.3 | D3 / PL4 จ่ายงานรถร่วม (M10 เป็น P0) | ST3 | ST3-T23 |
| F1 | ค่าขนส่งในราชอาณาจักรยกเว้น VAT | ST5 | ST5-T02, ST5-T03 |
| F1 | บริการประกอบเสีย VAT 7% | ST5 | ST5-T02, ST5-T03 |
| F1 | Tax point บริการ = เมื่อรับชำระ | ST5 | ST5-T16 |
| F1 | WHT 1% ค่าขนส่ง / 3% ค่าบริการ | ST5 | ST5-T02 (ST6-T08 ฝั่งจ่าย) |
| F1 | เลขเอกสารเรียงลำดับ ห้ามใช้ซ้ำ | ST5 | ST5-T09, ST5-T10 (ST1-T15) |
| F1 | สาขาผู้ออกและผู้ซื้อ | ST5 | ST5-T08, ST5-T09 |
| F1 | ภาษาไทย/บาท, ฟอนต์ไทย, พ.ศ./ค.ศ. | ST5 | ST5-T08 (ST0-T17) |
| F2 | ใบแจ้งหนี้ | ST5 | ST5-T07, ST5-T08 |
| F2 | ใบวางบิล | ST5 | ST5-T11, ST5-T12 |
| F2 | ใบกำกับภาษี (เต็มรูป) | ST5 | ST5-T15 |
| F2 | ใบเสร็จรับเงิน | ST5 | ST5-T14 |
| F2 | ใบลดหนี้ | ST5 | ST5-T19 |
| F2 | ใบเพิ่มหนี้ | ST5 | ST5-T20 |
| F2 | บันทึกรับ 50 ทวิ จากลูกค้า | ST5 | ST5-T17 |
| F3 | Revenue line ตั้งแต่สร้าง order | ST5 | ST5-T01 |
| F3 | คิว "พร้อมวางบิล" | ST5 | ST5-T04 |
| F3 | Flag กันวางบิลซ้ำ | ST5 | ST5-T05 (ST9-T06 รายงาน) |
| F3 | Draft (แก้ได้) | ST5 | ST5-T07 |
| F3 | Finalize (immutable) | ST5 | ST5-T09 |
| F3 | ยกเลิกใบ †7 | ST5 | ST5-T10 |
| F3 | Invoice run (async) | ST5 | ST5-T12 |
| F3 | พิมพ์/ส่งเอกสาร †17 | ST5 | ST5-T21 (PDF รายใบใน ST5-T08, T11, T14, T15, T19) |
| F4 | Lifecycle และ revert rules †6 | ST5 | ST5-T06 |
| F5 | บันทึกรับชำระ | ST5 | ST5-T13 |
| F5 | Trigger เอกสาร | ST5 | ST5-T16 |
| F5 | สถานะ invoice †5 | ST5 | ST5-T18 |
| F5 | Aging | ST5 | ST5-T22 |
| F5 | Payment status จาก ERP — P0 (KRS) †8 | ST7 | ST7-T21 |
| F6 | Cost line ตั้งแต่สร้าง trip | ST6 | ST6-T01 (ST3-T22) |
| F6 | คิวจ่ายรถร่วม | ST6 | ST6-T02 |
| F6 | ติ๊กเที่ยว → ใบสำคัญจ่าย †14 | ST6 | ST6-T03, ST6-T04 |
| F6 | รถร่วมตรวจผ่านลิงก์ †21 | ST6 | ST6-T05 |
| F6 | Dispute †3 †21 | ST6 | ST6-T06 |
| F6 | Approve (separation of duties) | ST6 | ST6-T07 |
| F6 | คำนวณ WHT + ออก 50 ทวิ | ST6 | ST6-T08, ST6-T10 |
| F6 | จ่าย (ส่วน P0; ไฟล์ธนาคารเป็น P1) | ST6 | ST6-T09 |
| F7 | คนขับ/รถร่วมดูค่าเที่ยวของตัวเอง (ลิงก์) †14 | ST6 | ST6-T11 |
| F9 | Data model map เป็น ETDA CII ได้ | ST5 | ST5-T24 |
| F9 | รายงานภาษีขาย | ST5 | ST5-T23 |
| G1 | URL & naming | ST0 | ST0-T06 |
| G1 | Auth | ST7 | ST7-T01 (ST1-T04 JWT ของ UI) |
| G1 | Idempotency | ST0 | ST0-T07 |
| G1 | External id | ST7 | ST7-T02 (ST2-T01, ST3-T03) |
| G1 | Concurrency (ETag) | ST0 | ST0-T08 |
| G1 | Webhook | ST7 | ST7-T04, ST7-T06 |
| G1 | Webhook ops | ST7 | ST7-T05 |
| G1 | Error RFC 9457 | ST0 | ST0-T06 |
| G1 | Pagination | ST0 | ST0-T08 |
| G1 | Versioning | ST7 | ST7-T07 |
| G1 | Rate limit | ST7 | ST7-T08 |
| G1 | Sandbox | ST7 | ST7-T09 |
| G1 | OpenAPI & SDK (ส่วน P0) †16 | ST7 | ST7-T12 (ST0-T09) |
| G1 | Bulk / async | ST7 | ST7-T10 (ST0-T11) |
| G2 | #1 `orders` | ST7 | ST7-T11 (ST3-T03) |
| G2 | #2 `webhooks`, `events`, `webhook-deliveries`, `event-types` | ST7 | ST7-T04, ST7-T05 |
| G2 | #3 `stops` | ST7 | ST7-T11 (ST4-T01) |
| G2 | #4 `documents` | ST7 | ST7-T11 (ST1-T08) |
| G2 | #5 `customers`, `locations` | ST7 | ST7-T11 (ST2-T01, ST2-T02) |
| G2 | #6 `invoices`, `invoice-runs`, `payments` | ST7 | ST7-T11 (ST5-T09, ST5-T12, ST5-T13) |
| G2 | #7 `trips` | ST7 | ST7-T11 (ST3-T11) |
| G2 | #8 `drivers`, `vehicles`, `carriers` | ST7 | ST7-T11 (ST2-T05, ST2-T06, ST2-T08) |
| G2 | #10 `jobs`, `api-keys`, `openapi.json` | ST7 | ST7-T01, ST7-T10 (ST0-T09, ST0-T11) |
| G3 | Interface `ErpAdapter` + capabilities | ST7 | ST7-T13 |
| G3 | Provider factory + StandaloneProvider + DemoProvider | ST7 | ST7-T14 |
| G3 | ตาราง `external_mapping` | ST7 | ST7-T15 |
| G3 | System-of-record rules | ST7 | ST7-T17 (ST9-T23) |
| G3 | Sync master ลงมา †9 | ST7 | ST7-T18 |
| G3 | เลขเอกสารสองฝั่ง | ST7 | ST7-T15 |
| G3 | Error queue ลูกค้าดูเอง | ST7 | ST7-T19 |
| G3 | `syncFromDate` | ST7 | ST7-T16 |
| G3 | Payment status pull †8 | ST7 | ST7-T21 |
| G3 | Routing ตามนิติบุคคล | ST7 | ST7-T13 (ST8-T08) |
| G3 | Inbound webhook ledger | ST7 | ST7-T22 |
| G3 | Outbox | ST7 | ST7-T03 (ST0-T10) |
| G3 | หน้าจัดการ connector | ST7 | ST7-T20 |
| G4 | KRS †8 | ST8 | ST8-T03 ถึง ST8-T13 |
| G4 | CSV generic | ST7 | ST7-T23 |
| G4 | LINE OA / Messaging API (วางก่อน ST7 เพราะ ST3 ต้องใช้) | ST3 | ST3-T21 |
| G4 | Map / geocode (วางก่อน ST7 เพราะ ST2 ต้องใช้) | ST2 | ST2-T03 |
| H | Dashboard ปฏิบัติการ | ST9 | ST9-T01 |
| H | Dashboard บิล | ST9 | ST9-T02 |
| H | Dashboard AP รถร่วม | ST9 | ST9-T03 |
| H | Dashboard เชื่อมต่อ | ST9 | ST9-T04 |
| H | รายได้ | ST9 | ST9-T05 |
| H | DO ยังไม่วางบิลเกิน N วัน | ST9 | ST9-T06 |
| H | ค้างชำระ / aging | ST9 | ST9-T06 (ST5-T22) |
| H | รายงานภาษี (ส่วน P0) †16 | ST9 | ST9-T07 (ST5-T23) |
| I | การแจ้งเตือน (ส่วน P0) †16 | ST9 | ST9-T08 (ST1-T23, ST3-T21) |
| I | ค้นหา global (⌘K) | ST9 | ST9-T09 |
| I | Import / Export | ST9 | ST9-T10 (ST1-T19 ขา import) |
| I | ไฟล์แนบ | ST1 | ST1-T08 |
| I | ตั้งค่าองค์กร | ST1 | ST1-T17 (ST9-T12) |
| I | UI pattern มาตรฐาน †16 | ST0 | ST0-T13, ST0-T14 (ST9-T11 saved views) |
| I | ประวัติการแก้ไขต่อเอกสาร | ST1 | ST1-T22 (ST0-T10) |
| I | ภาษา (ไทย = P0) †16 | ST0 | ST0-T15 (ST9-T12) |
| I | Onboarding wizard (= setup checklist) | ST1 | ST1-T21 |
| J | ขนส่งข้อมูล (HTTPS/HSTS/cookie) | ST0 | ST0-T12 (ST9-T13) |
| J | เก็บข้อมูลลับ (AES-256-GCM/KMS) | ST0 | ST0-T12 (ST2-T05, ST2-T08, ST7-T13) |
| J | Tenant isolation | ST0 | ST0-T04, ST0-T05 (ST9-T13) |
| J | Input validation | ST0 | ST0-T06 (ST1-T08, ST9-T13) |
| J | Rate limiting | ST7 | ST7-T08 (ST1-T01 ส่วน login) |
| J | Secret ใน log | ST0 | ST0-T12 (ST7-T16) |
| J | Magic link | ST1 | ST1-T06 (ST9-T13) |
| J | Dependency scanning | ST0 | ST0-T03 |
| J | Security headers | ST0 | ST0-T12 |
| J | เอกสารภาษี ≥ 5 ปี | ST9 | ST9-T15 (ST5-T09, ST0-T17) |
| J | Audit log 5 ปี / integration log 24 เดือน / login log 1 ปี / POD 2 ปี / GPS 90 วัน | ST9 | ST9-T14 |
| J | PDPA (ส่วน P0) †16 | ST9 | ST9-T16 |
| J | Data residency †18 | ST0 | ST0-T03 (ST0-T01) |
| NFR †19 | Availability | ST9 | ST9-T19 |
| NFR | Performance | ST9 | ST9-T17 |
| NFR | ขนาด (100 tenant / 50,000 order ต่อเดือน) | ST9 | ST9-T17 |
| NFR | Backup | ST9 | ST9-T18 |
| NFR | Monitoring | ST9 | ST9-T19 (ST0-T03) |
| NFR | Browser / device | ST4 | ST4-T15 (ST9-T20) |
| NFR | Mobile (Driver app E2) | — | นอกเฟส 0 (แอปคนขับเป็น P1) |
| NFR | Accessibility | ST9 | ST9-T20 |
| NFR | Localization | ST0 | ST0-T15 |
| NFR | Environments | ST0 | ST0-T03, ST0-T16 (ST8-T01 mock KRS) |
| NFR | Deploy | ST0 | ST0-T03, ST0-T09 |

### 3.1 จุดกำกวม/ขัดแย้งที่พบ (ต้องเคาะใน ST0-T19 — ระหว่างรอ ใช้ค่าในวงเล็บ)

1. **ชื่อ entity** — docs/04 ใช้ `legal_entity`/`company_branch` และ "Order (DO)" ชั้นเดียว; docs/01 ใช้ `company`/`branch` และแยก `sales_order` กับ `delivery_order` (ยึด docs/01)
2. **สถานะ trip** — docs/04 D1: PLANNED → ASSIGNED → DISPATCHED → IN_TRANSIT → COMPLETED; docs/01 §4.2: PLANNING / OFFERED / ASSIGNED / DISPATCHED / IN_PROGRESS / COMPLETED / COSTED / SETTLED (ยึด docs/01)
3. **enum ชื่อต่างกัน** — ประเภทคนขับ, ชื่อสูตรราคา (FLAT_TRIP/PER_DISTANCE/PER_UNIT กับ PER_TRIP/PER_KM/PER_TON/PER_CBM), สถานะ rate card (docs/04 มี PENDING_APPROVAL/ACTIVE; docs/01 มี APPROVED), สถานะ dispute รายการ (OPEN/DISPUTED/APPROVED กับ NONE/DISPUTED/RESOLVED), settlement (SENT กับ SENT_TO_CARRIER)
4. **Reason code ใบค้าง** — docs/04 C มี 12 รหัส (`LOCATION_UNMAPPED`, `GEOCODING_ERROR`, `RATE_MISSING`, `UNALLOCATED_NO_VEHICLE` …); docs/01 §4.1 ใช้ `ROUTE_PENDING`, `NO_VEHICLE` ฯลฯ — ต้องรวมเป็นชุดเดียวก่อน ST3-T07
5. **สถานะ invoice** — docs/04 F5: "SENT" = ส่งลูกค้าแล้ว และมี OVERDUE; docs/01 §4.4: "SENT" = connector push สำเร็จ, ไม่มี OVERDUE, มี ACCEPTED/MISMATCH/ADJUSTED/VOIDED (สถานะธุรกิจตาม docs/01 + ธง "ส่งลูกค้าแล้ว" + OVERDUE คำนวณ)
6. **สถานะฝั่งวางบิล 3 ชุด** — F4 (DELIVERED → RELEASED → IN_DRAFT → INVOICED → PAID/CREDITED), F3 `billingStatus` (UNBILLED/IN_DRAFT/INVOICED/CREDITED), docs/01 §4.3 ของ DO (POD_PENDING/UNBILLED/BILLED ไม่มี RELEASED)
7. **ยกเลิกใบที่ออกเลขแล้ว** — docs/04 F3 ให้เป็น CANCELLED คงเลข (ถ้ายังไม่ส่ง/ไม่รับชำระ); docs/01 §4.4 ให้ CANCELLED เฉพาะ draft ส่วนใบที่ออกแล้วใช้ใบลดหนี้เต็มใบ (VOIDED) และยังเป็นคำถามนักบัญชีข้อ 8
8. **ความสามารถของ KRS** — docs/04 G4 ระบุ voidInvoice / pullPaymentStatus / getMasters; docs/01 A.1–A.2 ยืนยันว่า KRS ไม่มี DELETE, ไม่มีสถานะรับชำระ, master code ต้องขอรายการ → แถว F5 "Payment status จาก ERP — P0 (KRS)" และ G3 "Payment status pull" ทำได้แค่ framework + DemoProvider (ST7-T21 จึงตัดได้)
9. **Mapping ไม่ครบ** — docs/04 G3 "บล็อก finalize"; docs/01 §7.4 "เอกสารออกได้ แต่ outbox เป็น FAILED_FINAL(VALIDATION)"
10. **ขอบเขต Open API สาธารณะ** — docs/04 G1–G2 เป็น P0 ทั้งชุด (เขียน/อ่าน, webhook, sandbox, docs, SDK) แต่ docs/02 §5 และ §7 วางหน้า Open API ของลูกค้า + API docs สาธารณะ + sandbox ไว้เฟส 2 และ spec12 §1 ให้ P0 แค่ "API อ่าน" → ST7-T01, T02, T04–T12 ติดป้ายตัดได้
11. **A3** — ข้อความบอก "role มาตรฐาน 10 แบบ" แต่ตารางมี 11 คอลัมน์ และ Driver (แอป = P1) / Customer portal (P2) ยังไม่มีผู้ใช้ในเฟส 0 (seed role ภายใน 8 แบบ + principal ของ carrier ผ่านลิงก์)
12. **A6** — ป้าย "P0 (impersonate) / P1 (allowlist)" ไม่บอกหน้าจอ (ยึด docs/02 §5, §7: tenant, connector, health)
13. **D3** — "ลิงก์ LINE/SMS" แต่ G4 มี P0 เฉพาะ LINE OA ไม่มี SMS gateway; "เปลี่ยน carrier: ยกเลิก child trip" อ้าง parent/child trip ซึ่งเป็น P1 (ทำเป็นยกเลิกการจ้างบน trip เดิม)
14. **F6/F7** — บรรทัดหัก "เงินเบิกล่วงหน้า" เป็น P0 แต่ cash advance เป็น P1 (กรอกมือ); "คนขับ/รถร่วมดูค่าเที่ยว (ลิงก์)" เป็น P0 แต่ค่าเที่ยวคนขับเป็น P1 (ทำเฉพาะรถร่วม)
15. **B2** — ค่าต่ออายุ/ค่าเสื่อม "ลง `vehicle_cost`" เป็น P0 ขณะที่รายงานต้นทุนเป็น P1 (เขียนแถวไว้ ยังไม่มีหน้ารายงาน); เตือนทาง LINE อ้างโมดูล I ซึ่ง LINE ทีมภายในเป็น P1; เลขไมล์จาก GPS เป็น P1
16. **แถวสองระดับที่ไม่บอกเส้นแบ่ง** — H รายงานภาษี, I การแจ้งเตือน, I ภาษา (อังกฤษ = P1 แต่ backlog นี้กำหนด string EN ใน DoD), J PDPA, G1 OpenAPI & SDK, F6 จ่าย; และ I UI pattern นับ saved views เป็น P0 ขณะที่ D2 Saved views เป็น P1
17. **F3 พิมพ์/ส่งเอกสาร** — อ้าง "ดาวน์โหลดจาก customer portal" ซึ่งเป็น P2 (เฟส 0 = PDF + อีเมล)
18. **Data residency** — docs/04 J "โฮสต์ในไทย" เป็น P0; spec12 Q-D1 ยังเปิด (ไทยหรือสิงคโปร์)
19. **ตาราง Non-functional ไม่มีป้าย P** (ถือเป็นเป้าของเฟส 0 ยกเว้นแถว Mobile)
20. **กฎตอนจัดงาน** — docs/04 D2 "เตือนไม่บล็อก" (ยกเว้นรถร่วมเอกสารหมด); spec03 §6 เป็น "กฎห้ามจ่ายงาน" แบบบล็อก + override (ยึด docs/04)
21. **Settlement dispute** — docs/04 F6 ให้ "รถร่วมตรวจผ่านลิงก์" และ "Dispute" เป็น P0 แต่ docs/02 §7 วาง "settlement dispute flow" ไว้เฟส 3 → ST6-T05, ST6-T06 ติดป้ายตัดได้ (01§4.5 มีทางข้าม DRAFT → APPROVED)

---

## 4. สรุปขนาด

สูตร: S = 1, M = 2.5, L = 5 วันทำงาน (นักพัฒนา 1 คน + AI coding agent) — ยังไม่รวมเวลารอคำตอบภายนอก, review, แก้ defect จาก UAT และ re-baseline หลัง ST1

| Stage | จำนวนงาน | S | M | L | วันทำงาน | ตัดได้ (งาน) | ตัดได้ (วัน) |
|---|---|---|---|---|---|---|---|
| ST0 | 19 | 6 | 12 | 1 | 41 | 0 | 0 |
| ST1 | 24 | 6 | 14 | 4 | 61 | 4 | 7 |
| ST2 | 23 | 5 | 13 | 5 | 62.5 | 8 | 15.5 |
| ST3 | 25 | 5 | 13 | 7 | 72.5 | 8 | 15.5 |
| ST4 | 15 | 2 | 11 | 2 | 39.5 | 4 | 8.5 |
| ST5 | 25 | 4 | 15 | 6 | 71.5 | 4 | 8.5 |
| ST6 | 12 | 3 | 7 | 2 | 30.5 | 3 | 7.5 |
| ST7 | 23 | 2 | 14 | 7 | 72 | 14 | 39.5 |
| ST8 | 15 | 3 | 8 | 4 | 43 | 0 | 0 |
| ST9 | 23 | 7 | 15 | 1 | 49.5 | 11 | 25.5 |
| **รวม** | **204** | **43** | **122** | **39** | **543** | **56** | **127.5** |

**งานที่ตัดได้ (scope-cut levers)** — รวม 56 งาน ≈ 127.5 วัน · ถ้าตัดทั้งหมด เหลือ ≈ 415.5 วัน

- **ST0**: ไม่มี
- **ST1** (4 งาน, 7 วัน): T02 (S), T11 (S), T18 (M), T21 (M)
- **ST2** (8 งาน, 15.5 วัน): T03 (M), T16 (M), T17 (M), T18 (M), T19 (M), T20 (S), T21 (S), T22 (S)
- **ST3** (8 งาน, 15.5 วัน): T04 (S), T08 (M), T13 (M), T15 (M), T18 (S), T19 (M), T21 (M), T24 (S)
- **ST4** (4 งาน, 8.5 วัน): T06 (S), T11 (M), T12 (M), T14 (M)
- **ST5** (4 งาน, 8.5 วัน): T12 (M), T21 (M), T22 (M), T24 (S)
- **ST6** (3 งาน, 7.5 วัน): T05 (M), T06 (M), T11 (M)
- **ST7** (14 งาน, 39.5 วัน): T01 (L), T02 (M), T04 (L), T05 (M), T06 (M), T07 (S), T08 (M), T09 (M), T10 (M), T11 (L), T12 (M), T21 (M), T22 (S), T23 (M)
- **ST8**: ไม่มี
- **ST9** (11 งาน, 25.5 วัน): T01 (M), T02 (M), T03 (S), T05 (M), T06 (M), T08 (L), T09 (M), T10 (M), T11 (S), T14 (M), T20 (S)

ข้อสังเกต: ก้อนใหญ่ที่สุดที่ตัดได้คือ **Open API สาธารณะใน ST7** (auth ภายนอก, webhook, sandbox, docs/SDK, conformance) ซึ่ง docs/02 เองวางไว้เฟส 2 — ถ้าเจ้าของยืนยันเลื่อน ชั้น integration ภายใน (outbox, adapter, error queue) ยังต้องทำครบเพราะ KRS ใช้

---

## 5. ภาคผนวก — ผู้สมัครเพิ่ม (ไม่อยู่ในเฟส 0 จนกว่าเจ้าของจะตัดสิน)

รายการที่ `spec/12-roadmap-open-questions.md` §1 จัดเป็น P0 แต่ docs/04 ไม่ได้ติดป้าย P0 — ขนาดเป็นค่าหยาบ (จำนวน L = สัปดาห์ของนักพัฒนา 1 คน)

| # | รายการ (spec) | สถานะใน docs/04 | ขนาดหยาบ |
|---|---|---|---|
| 1 | สมัครใช้งานเอง 3 ขั้น + OTP + ตรวจเลขผู้เสียภาษีกับ RD (spec01§2) | ไม่มี (docs/02 วาง trial อัตโนมัติไว้เฟส 1) | 2 L |
| 2 | วงจรสถานะ tenant + banner สถานะ (spec01§1, §5) | ไม่มี | 1 L |
| 3 | แพ็กเกจ / PlanVersion / entitlement / add-on + นับรถ active + หน้า "แพ็กเกจและการเรียกเก็บเงิน" (spec01§6–8) | มีแค่ feature flag ตาม plan (A5) | 3 L |
| 4 | Platform Console เต็ม: คิวอนุมัติการสมัคร, ตัวแก้แพ็กเกจ, การเงินแพลตฟอร์ม, ทีมงาน (spec01§10) | A6 + docs/02 ต้องการแค่ tenant / connector / health | 3 L |
| 5 | ผู้ใช้หนึ่งคนอยู่หลายบริษัท สลับได้ (spec01§3) | A2 = P1 | 1 L |
| 6 | Fuel surcharge + เวอร์ชัน/อนุมัติ rate card (spec02§5) | B1 fuel surcharge = P1; อนุมัติ rate = P1 | 1–2 L |
| 7 | ผู้ขาย/อู่ (Vendor) master (spec02§7) | ไม่มีใน P0 | S–M |
| 8 | กฎห้ามจ่ายงานแบบบล็อก + override ครบชุด (spec03§6) | D2 = เตือนไม่บล็อก | 1 L |
| 9 | แอปคนขับ M1–M18 + ออฟไลน์ (spec04§6–22) | E2 = P1 (เฟส 2) ยกเว้น M10 | 10–14 L (ทีมแยก) |
| 10 | หน้าติดตามรถบนแผนที่ + ตำแหน่งจากแอป (spec04§1) | E หน้าติดตามรถ = P1 | 2 L |
| 11 | ศูนย์ข้อยกเว้น (exception center) (spec04§2) | ไม่มีใน P0 | 2 L |
| 12 | แจ้งลูกค้าปลายทางทาง SMS/อีเมล (spec04§3) | E แจ้งลูกค้าปลายทาง = P1 | 1 L |
| 13 | เงินเบิกล่วงหน้าคนขับ (spec05§12) | F7 Cash advance = P1 | 2 L |
| 14 | ใบสั่งซ่อม + วงเงินอนุมัติ (spec06§5) | B2 ส่วน 4 = P1 | 2 L |
| 15 | ผลตรวจรถก่อนออก (spec06§6) | B2 ส่วน 9 / M7 = P2 | 1 L |
| 16 | อุบัติเหตุ/เคลม (spec06§11) | B2 ส่วน 8 = P1 | 1 L |
| 17 | บันทึกน้ำมัน + เลขไมล์จากแอป (spec06§9, §15) | B2 ส่วน 6 = P1 | 1–2 L |
| 18 | หางพ่วงเป็นทรัพย์สินแยก (spec06§2) | B2 ส่วน 1 มีแค่จับคู่หัวลาก–หาง | M |
| 19 | รายงานกำไรต่อเที่ยว/ลูกค้า/รถ + ต้นทุนรถร่วม (spec09§2, §4) | H กำไร = P1 | 2 L |
| 20 | Log การเรียก API ให้ลูกค้าดู (spec07§8) | ไม่มีแถว P0 (docs/02 วางไว้เฟส 2) | M |
| 21 | เนื้อหาภาษา EN และ 中文 ครบทุกหน้า (spec11§6) | I ภาษา: อังกฤษ = P1, ไม่มี 中文 | M (EN) + M (中文) |
| 22 | หน้าติดตามรถโหมด 3 มิติ (ต้นแบบรอบ 19; spec04§1.1) — ต่อยอดจาก #10, ต้องมี GPS/แอปคนขับป้อนตำแหน่ง, routing + map matching, vector tile | ไม่มี (E หน้าติดตามรถ = P1 และไม่ระบุ 3 มิติ) | 3–4 L + 1 L (worker) — รายละเอียด `plan/02` T-18 |

สิ่งที่เฟส 0 เผื่อไว้ให้ #10/#22 โดยไม่เพิ่ม task: `trip.planned_route` + `planned_distance_m` (ST3-T11), schema `vehicle_position` + RLS (ST4-T01 สร้างตารางพร้อม `stop_event` แต่ไม่มีตัวป้อน), retention GPS 90 วัน (ST9-T14) — ดู T-18

หมายเหตุทิศกลับ: spec12 §1 จัด "connector ตัวแรก" และ "API เขียน" เป็น P1 แต่ docs/04 จัด KRS connector และ API เขียนเป็น P0 — backlog นี้ยึด docs/04

---

## 6. ความเสี่ยงของ backlog นี้

1. **ขนาดรวมเกินกรอบ "+3 เดือน" ของ docs/02 มาก** — ≈ 543 วันคน ต้องใช้คนหลายคนขนานกัน หรือใช้ lever ในข้อ 4 หรือขยายกรอบเวลา; ตัวเลขยังไม่ถูกพิสูจน์จนกว่าจะ re-baseline หลัง ST1
2. **ผลิตภาพจริงของ "นักพัฒนา + AI agent" ยังไม่รู้** — งาน backend ตามแบบแผนอาจเร็วกว่าที่ตั้ง แต่ planning board (ST3-T12–T16) และ PDF เอกสารภาษี มักช้ากว่าเพราะต้องให้คนดู/ลองมือ
3. **คำตอบนักบัญชี** (01§8.2) — ถ้าข้อ 1, 2, 4, 7, 8 ตอบต่างจาก default จะกระทบ schema ของ ST5/ST6 หลังเริ่มเขียนแล้ว
4. **คำตอบ KRS** (01 A.6) — แหล่ง SO, รหัสลูกค้า NSF ↔ PP, VAT ต่อรายการ, วิธียกเลิกใบ, มี staging หรือไม่ ยังไม่รู้ทั้งหมด; ST8 ประเมินจาก contract ปัจจุบันเท่านั้น
5. **เกณฑ์ (ก) ขึ้นกับพฤติกรรมฝั่ง KRS** (บัญชีกดบันทึกแล้วรายการถูกเขียนใหม่) — MISMATCH = 0 อาจต้องใช้เวลาปฏิทินมากกว่างานพัฒนา และต้องการ 2 งวดจริง
6. **จุดกำกวม 21 ข้อในข้อ 3.1** — หลายข้อเปลี่ยนชื่อสถานะ/enum ที่กระจายทั้งระบบ ถ้าเคาะช้ากว่า ST0 จะเกิดงานรื้อ
7. **การพึ่งพาภายนอกที่ยังไม่เลือก** — frontend framework, ผู้ให้บริการแผนที่, LINE OA (ของ tenant หรือของเรา), SMS, cloud region ไทย
8. **ขนาดงาน "ชุดตรวจนักบัญชี" และ UAT เป็นเวลาปฏิทิน** ไม่ใช่วันพัฒนา — รอบแก้ defect จากนักบัญชีและผู้ใช้ KRS ไม่ได้รวมในตัวเลข
9. **งานที่ติดป้าย "ตัดได้" ยังเป็น P0 ของ docs/04** — ตัดแล้วต้องทำก่อนขายลูกค้ารายแรกอยู่ดี เป็นการเลื่อน ไม่ใช่การลบ
