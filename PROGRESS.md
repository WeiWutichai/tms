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
| ST1 Platform และองค์กร | **กำลังทำ** 6/24 · T01, T04 (บางส่วน), T12 (ยกเว้น step-up), T14, T15, T22 เสร็จ | 10 พ.ย. | — | ตารางงาน ST1 ด้านล่าง |
| ST2–ST9 | ยังไม่เริ่ม | | | |

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

### งาน ST1 (เกณฑ์ตรวจรับใน `plan/01-phase0-backlog.md`)

| งาน | สถานะ | หลักฐาน / ที่ยังขาด |
|---|---|---|
| T01 Login อีเมล + รหัสผ่าน | เสร็จ | argon2id; ผิด 5 ครั้ง/15 นาที (ต่อบัญชีและต่อ IP) → ครั้งที่ 6 ได้ 429 + Retry-After; อีเมลไม่มี/รหัสผิดตอบเหมือนกัน; อีเมลหลายบริษัท → 409 ให้เลือก; หน้า login + เลือกบริษัทตามต้นแบบ (`apps/web/src/public/`) · `test/auth.test.ts` 12 ข้อ + E2E 3 ข้อ |
| T04 Session | เสร็จ (บางส่วน) | Auth Code + PKCE, access 15 นาที, refresh 7 วัน httpOnly หมุนทุกครั้ง + ตรวจใช้ซ้ำ, idle 8 ชม., `tokenVersion` ตรวจทุก request · **ยังไม่ทำ:** จำอุปกรณ์ 30 วัน (ผูกกับ 2FA — ทำใน T05), banner "เพิ่มสิทธิ์ให้ refresh" (ทำพร้อม T12), ค่า idle ตั้งได้ (T17) |
| T12 Role/permission | เสร็จ (ยกเว้น step-up) | 9 role ระบบ = A3 + manager (D-12) ใน `packages/domain/src/permissions.ts`; scope `resource:verb` ใน token = union ของ role; guard รับหลาย scope แบบ any-of; `GET /v1/users`, `GET /v1/roles`; เมนู/หน้า/ปุ่มซ่อนตามสิทธิ์ + หน้า "ไม่มีสิทธิ์"; seed ผู้ใช้ 1 คน/role (`<role>@demo-a.test`) · test: ตาราง A3 ระดับ scope 28 แถว + ระดับ endpoint ด้วย login จริง (`test/roles.test.ts`) · **ยังไม่ทำ:** เปลี่ยน role (ต้อง step-up 2FA → T05), banner เพิ่มสิทธิ์ (T04) |
| T14 นิติบุคคล + สาขา | เสร็จ (ยกเว้นโลโก้/ลายเซ็น) | `/v1/branches` CRUD (ไม่มีลบ), checksum เลขภาษี 422, รหัสสาขา 5 หลักไม่ซ้ำต่อนิติบุคคล, default 1 ต่อนิติบุคคล, "ใช้ออกใบกำกับ" = hq_prints_for_all ต่อสาขา (PO ตอบ); หน้า ตั้งค่า → นิติบุคคลและสาขา + drawer · โลโก้/ลายเซ็นรอ T08 ไฟล์แนบ |
| T15 เลขเอกสาร | เสร็จ | ตาราง `document_series` (prefix/reset ต่อประเภท) + `document_sequence` (ตัวนับต่อสาขา×งวด, unique NULLS NOT DISTINCT); `issueNumber()` ล็อกแถวด้วย UPDATE…RETURNING · test 50 request พร้อมกันได้ 1–50 ไม่ซ้ำไม่ข้าม, rollback ไม่กินเลข; เอกสารภาษีต้องมี `{BR}`; หน้า ตั้งค่า → เลขที่เอกสาร |
| T22 Audit log | เสร็จ (ส่วนแกน + API) | `AuditService` เขียนใน transaction เดียวกับการแก้ข้อมูล, diff เฉพาะ field ที่เปลี่ยน, ตัด field secret; trigger ปฏิเสธ UPDATE/DELETE ทุก role; `GET /v1/audit-logs` (Accounting เห็นเฉพาะ entity บัญชี) · **ยังไม่ทำ:** แท็บประวัติต่อ entity + หน้ารวมใน UI (ต้นแบบมีแท็บ "กิจกรรม" ใน drawer — ทำพร้อมหน้าเอกสาร ST2+), job ลบเมื่อครบ 5 ปี |
| T05 2FA TOTP | เสร็จ (ยกเว้นหน้าตั้งเองของ role ที่ไม่บังคับ) | TOTP + backup 10 ชุด + จำอุปกรณ์ 30 วัน + step-up; บังคับ owner/admin/accounting; เปลี่ยน role (`PUT /v1/users/{id}/roles`) ต้อง step-up + bump tokenVersion + ห้ามเหลือ owner 0 · `test/mfa.test.ts` 8 ข้อ + E2E · ผู้ใช้เดโม owner/admin/accounting ใช้ secret `JBSWY3DPEHPK3PXP` ในแอป Authenticator · หน้า 2FA ยังไม่มีในต้นแบบ [OPEN] |
| T17 ตั้งค่าองค์กร | เสร็จ | ตาราง `tenant_setting` + registry มี type (`apps/api/src/modules/settings/registry.ts`, 13 key: org/tax/billing/security); `GET/PATCH /v1/settings` (ค่าผิด type → 422 ทั้งก้อน, audit ต่อ key); auth อ่าน `security.require2faAll` และ idle timeout; หน้า องค์กร/ภาษี/ความปลอดภัย ตามต้นแบบ + ปุ่มบันทึกลอย · `test/settings.test.ts` 5 ข้อ + E2E · ภาพเทียบ `design/compare/st1-settings-{org,tax,sec}-1440.png` |
| T16 Routing เอกสารตามนิติบุคคล | เสร็จ (ส่วน resolver) | `resolveDocumentEntity()` (`apps/api/src/modules/routing/document-routing.ts`): override → ลูกค้า/รถร่วม → ค่า tenant (`routing.invoiceAsCompanyId` / `routing.tenderAsCompanyId`) → นิติบุคคลเดียว; คืน taxBranch = สำนักงานใหญ่เมื่อสาขาไม่ออกเอง · `test/routing.test.ts` 6 ข้อ · ช่องตั้งค่าในหน้าจอยังไม่มีในต้นแบบ [OPEN] |
| T10 ระงับ/เปิดใช้/ลบผู้ใช้ | เสร็จ (ส่วน API) | `POST /v1/users/{id}/suspend` `/activate` `/delete` (เหตุผลบังคับ, audit): ระงับ = bump tokenVersion + เพิกถอน refresh → หลุดทันที; ลบ = anonymize (ชื่อ/อีเมล/เบอร์/รหัส/2FA) เก็บแถวให้ audit แสดง "ผู้ใช้ที่ลบแล้ว"; owner จัดการได้เฉพาะโดย owner; ทำกับตัวเองไม่ได้ · หน้าจอไม่มีในต้นแบบ [OPEN] |
| T11 ประวัติ login | เสร็จ (ส่วน API) | `GET /v1/login-history?userId=` (users:read) สำเร็จ/ผิด/ล็อก + IP + อุปกรณ์; worker ลบที่เก่ากว่า 1 ปีวันละครั้ง (`src/auth/maintenance.ts`) · หน้าดูของ admin ไม่มีในต้นแบบ [OPEN] |
| T13 Field permission ราคา | เสร็จ (โครงพื้นฐาน) | `@PriceField('sell'|'buy')` + `PriceFieldInterceptor` (global นอกสุด) ตัด field ราคาที่ serializer ตาม `prices.sell:read` / `prices.buy:read` รวม nested/array และ response ที่ replay จาก Idempotency-Key · principal ภายนอกไม่มี scope ราคาขาย · `src/common/price-fields.test.ts` + `test/price-fields.test.ts` · DTO ที่มีราคา (ST2+) ต้องติด decorator |
| T20 bootstrap ค่าเริ่มต้นไทย | เสร็จ | `createTenantWithDefaults()` / `bootstrapTenant()` (`apps/api/src/modules/tenants/bootstrap.ts`): role ระบบ + ชุดเลข 11 ประเภท + ค่าภาษี/วางบิลเป็นแถวจริง (snapshot) ใน transaction เดียว; registry ให้ ST2 เพิ่มขั้น (ประเภทรถ, accessorial, reason) · `test/bootstrap.test.ts` · รูปแบบเอกสาร PDF มาพร้อม ST5 |
| T02 นโยบายรหัสผ่าน | เสร็จ (ส่วน API) | ≥ 12 ตัว, HIBP k-anonymity (`HIBP_ENABLED=true` ใน production; เรียกไม่ได้ = ปล่อยผ่าน + log), ห้ามซ้ำ 5 ครั้งล่าสุด (`password_history`); `POST /v1/me/password` (รู้รหัสเดิม, session อื่นหลุด, audit) · `PasswordPolicy` ใช้ซ้ำใน T03/T07 · `test/password-policy.test.ts` · หน้าเปลี่ยนรหัสไม่มีในต้นแบบ (รอ T09 โปรไฟล์) |
| T18 Feature flag ตามแพ็กเกจ | เสร็จ | ตาราง `plan`, `plan_entitlement` (ข้อมูลตัวอย่างจาก `design/prototype/plans.js` — ราคา/โควตายังไม่สรุป), `tenant.plan_code`, `tenant_entitlement_override` (grant/revoke/set_limit + หมดอายุ); `EntitlementService` (cache 60 วิ) + `@RequireFeature()` → 403 `feature_not_in_plan` (PLT-078); job ที่ผูกฟีเจอร์ถูกข้าม (`SKIPPED`) + `tenantsWith()` สำหรับ cron; `/v1/me` คืน `features`/`plan`/`lockedIn`; เมนูนอกแพ็กเกจแสดง 🔒 และเปิดเป็นหน้า "ไม่รวมในแพ็กเกจ" (PLT-076); tenant ถูกระงับ = ไม่มีฟีเจอร์; constraint FK/CHECK ที่ฐาน; demo-b อยู่แพ็กเกจเริ่มต้น · แอปแก้แพ็กเกจ/override ไม่ได้ (Console T24) · `test/entitlements.test.ts` |
| T08 ไฟล์แนบ | เสร็จ (ส่วน API) | `POST /v1/documents` (จอง: ชนิด/ขนาด ≤ 10 MB) → `PUT` เนื้อไฟล์ผ่าน URL มีลายเซ็น (หมดอายุ 15 นาที) → ตรวจขนาด + MIME จริงจาก magic bytes (PDF/PNG/JPEG/WebP) → ready; `GET /v1/documents/{id}` คืน URL ดาวน์โหลดหมดอายุ 5 นาที; ไฟล์เก็บเขียนครั้งเดียว (sha256); `clientDocumentId` กันอัปโหลดซ้ำ; สิทธิ์ `documents:read/write` (Viewer อ่านอย่างเดียว) · URL อัปโหลดให้เฉพาะผู้จอง; ลายเซ็นผิดไม่อ่าน body · **ค้างให้โมดูลเจ้าของ:** ตอนนี้ทุก role ภายในอ่านเอกสารได้ด้วย id — ST2-T17 (เอกสารรถ), ST6 (50 ทวิ) ต้องจำกัดตามชนิด/entity + audit การเข้าถึงเอกสารอ่อนไหว (docs/01) — **รวมลายเซ็นผู้ใช้ (SIGNATURE) ให้อ่านได้เฉพาะเจ้าของ/ตัวสร้าง PDF** · local disk (`FILES_ROOT`) ในเครื่อง — S3 presigned ใน production (plan/02 T-09) · `test/documents.test.ts` |
| T09 โปรไฟล์ | เสร็จ (ส่วน API + ภาษา) | `GET/PATCH /v1/me/profile`: ชื่อ เบอร์ ภาษา (th/en/zh) timezone ลายเซ็น (เอกสาร SIGNATURE ของตัวเองที่ ready — อ่านกลับผ่าน URL ดาวน์โหลด) + audit; ปุ่มสลับภาษาบน header บันทึกลงโปรไฟล์และใช้ภาษาจากโปรไฟล์ตอนเข้าระบบ · หน้าโปรไฟล์ไม่มีในต้นแบบ [OPEN] · `test/profile.test.ts` + E2E |
| T06 Magic link | เสร็จ (โครงพื้นฐาน) | `MagicLinkService.issue/revoke/resolve` (`src/modules/links/`): token `ml1.<id>.<exp>.<sig>` เซ็น HMAC + หมดอายุ; action ต่อลิงก์ + เพิกถอนอยู่ในตาราง `magic_link` (ลบไม่ได้); route ติด `@LinkAction()` ยืนยันด้วยลิงก์ → ทำงานใต้ RLS ของ tenant, principal `link` (ราคาขายถูกตัดเสมอ; ห้ามออกลิงก์ที่มี scope ราคาขาย); ผิดทุกกรณี → 404; `/v1/public/*` rate limit ต่อ IP (120/นาที) · `test/magic-link.test.ts` · หน้าลิงก์จริงมาใน ST3-T23 (ข้อเสนองาน), ST4 (POD) |
| T03 ลืมรหัสผ่าน + อีเมล | เสร็จ | `POST /v1/auth/password/forgot` → 202 เสมอ (อีเมลมี/ไม่มี/ถูกระงับตอบเหมือนกัน; สร้างแถว token ทุกครั้ง) · เพดาน 3 ครั้ง/15 นาทีต่ออีเมล + 10 ต่อ IP → 429 · `POST /v1/auth/password/reset` ลิงก์ 30 นาที ใช้ครั้งเดียว (รหัสไม่ผ่านนโยบาย → 422 token ยังใช้ได้) ตั้งรหัสใหม่ทุกบริษัทที่ใช้อีเมลนี้ + เพิกถอน session + audit `auth.password_reset` · อีเมลผ่าน outbox (`email_outbox`, worker ส่ง, ลองใหม่ backoff, ลบเนื้อหาหลังส่ง, เก็บ 90 วัน) + transport `log`(dev)/`smtp` — ผู้ให้บริการยังไม่เลือก (D-32) · template TH/EN · ลิงก์ใช้ `PUBLIC_WEB_BASE_URL` (ไม่ใช้ Host header) และ token อยู่ใน fragment · หน้า /forgot ตามต้นแบบ, หน้า /reset-password [OPEN] · role แอปเขียน outbox ได้อย่างเดียว (อ่านเนื้ออีเมลไม่ได้) · **พฤติกรรมที่ยอมรับไว้ก่อน (ถาม PO ได้):** ตั้งรหัสใหม่ไม่ปลดล็อก login ที่ผิด 5 ครั้ง (รอ 15 นาที); บัญชีที่ปิดอยู่/บริษัทที่ระงับไม่ถูกเปลี่ยนรหัส (เปิดคืนแล้วรหัสเดิมยังใช้ได้); worker ส่งอีเมลกับ job สลับกันในลูปเดียว; เวลาตอบของอีเมลที่มีจริงช้ากว่าราว 1–2 ms (insert outbox) — ยอมรับได้เพราะมีเพดาน 3 ครั้ง/15 นาทีต่ออีเมล · `test/password-reset.test.ts` (20 ข้อ) + E2E |
| T07 เชิญผู้ใช้ | เสร็จ | `POST /v1/users/invitations` (users:write + step-up; มอบ owner ได้เฉพาะ owner) สร้างผู้ใช้ INVITED + role + ลิงก์อีเมล 7 วัน (outbox) · นับ seat จาก entitlement `users` (ACTIVE+INVITED; limit null = ไม่จำกัด ตาม plan/00b) → 409 `seat_limit_reached` · อีเมลซ้ำ → 409 `already_member` · `GET` รายการ, `/{id}/resend` (ลิงก์เดิมใช้ไม่ได้), `/{id}/revoke` (เหตุผล; anonymize ผู้ใช้ที่ยังไม่รับ) · public `POST /v1/auth/invitations/inspect|accept`: ผู้ใช้ใหม่ตั้งรหัส (นโยบาย T02) / มีบัญชีบริษัทอื่นใช้รหัสเดิม (นับเพดานผิด login) · ใช้ครั้งเดียว, บริษัทระงับใช้ไม่ได้ · audit `user.invited/joined/invitation_resent/invitation_revoked` · ตาราง `user_invitation` (RLS) · UI drawer เชิญ + หน้า /invite [OPEN] · `test/invitations.test.ts` + E2E |
| T23 แจ้งเตือน | เสร็จ | `NotificationService.notify(tx, {to: userIds/roles, template, vars, link, entity, channels})` ใน transaction ของงาน (rollback = ไม่แจ้ง) · render ตามภาษาผู้รับ · ช่อง `in_app` + `email` (outbox T03; worker อัปเดตสถานะ SENT/FAILED) · interface `NotificationChannel` + `register()` สำหรับ push/line/sms · job ที่ enqueue ด้วย `notify` แจ้งผู้สั่งเมื่อสำเร็จ/ล้มครบครั้ง (template `job.succeeded/failed` — ใช้ใน T19) · API `GET /v1/me/notifications`, `/unread-count`, `POST /read-all`, `/{id}/read` (เห็นเฉพาะของตัวเอง) · ตาราง `notification` (RLS; role แอปแก้ได้แค่สถานะอ่าน, ไม่มี delete) · UI กระดิ่ง + toast ตามต้นแบบ, แผงรายการ [OPEN] · `test/notifications.test.ts` + E2E · review: job ที่ lease หมดถูกหยิบซ้ำไม่แจ้งซ้ำ/ไม่ทับผล (อัปเดตแบบมีเงื่อนไข), job SKIPPED แจ้ง `job.skipped`, label ตัด URL/โดเมน (`common/safe-text.ts` ใช้ร่วมกับคำเชิญ), สถานะช่องอีเมลอัปเดตในคำสั่งเดียวกับ outbox, ส่งเป็นชุด (createMany), ลบผู้ใช้ → ยกเลิกอีเมลที่รอส่งและลบที่อยู่จริง, กระดิ่งอ่านเฉพาะที่แสดง · QA: cursor แบ่งหน้าไม่ข้ามแถวเวลาเดียวกัน (`created_at` ms — migration 0027), ตรวจ `notify` ตอน enqueue + ตัด `_notify` จาก payload, กล่องแจ้งเตือนเฉพาะ principal ผู้ใช้, toast ตัด 4 บรรทัด/ไม่ล้นจอ 390 · **ค่าที่เลือกไว้ก่อน (เปลี่ยนได้):** เก็บแจ้งเตือน 1 ปี (เท่าประวัติ login) · ยังไม่ทำ: ตั้งค่ารับต่อผู้ใช้, สรุปรายวัน 08:00 (docs/04 I) |
| T19 นำเข้า Excel (framework) | เสร็จ (รอ review/QA) | `ImportSpec` ต่อ entity + `ImportRegistry` (entity จริงลงใน ST2-T23/ST3-T04; dev/test มี spec `sample`) · อัปโหลดด้วย `/v1/documents` kind `IMPORT` (.xlsx/.csv ตรวจจากเนื้อไฟล์) → `POST /v1/imports` dry-run (ไม่เรียก commit) → `PATCH` จับคู่คอลัมน์/ตัวเลือกแล้วตรวจใหม่ → `POST /{id}/commit` ตรวจซ้ำแล้วเขียนใน transaction เดียว (`all_or_nothing` มีแถวผิด → 409 `import_has_errors`) · `/{id}/errors` .xlsx แถวผิด + คอลัมน์ผลตรวจ · `/kinds/{kind}/template` · `/{id}/cancel` · > 1,000 แถว = job + แจ้งเตือน (T23) · CSV UTF-8/TIS-620, ≤ 5,000 แถว, ตัวช่วย `parseImportDate` (พ.ศ.) และ `normalizeTaxId` (เติม 0) · ผลตรวจหมดอายุ 24 ชม. · ตาราง `import_job` (RLS, ไม่มี delete) · UI wizard ตามต้นแบบ (หน้า `/dev/import` เฉพาะ dev จนกว่าจะมีหน้าข้อมูลหลัก) · `test/imports.test.ts` (1,000 แถวผิด 3) + E2E · review: CSV นับเพดานเฉพาะแถวที่มีค่า + เลขแถวตาม record, xlsx จำกัดขนาดหลังแตก zip 50 MB (อ่าน central directory) และ ≤ 100 คอลัมน์, job นำเข้า transaction 5 นาที + ล้มแล้วปิดเป็น failed พร้อมเหตุผล (`JobQueue.register` รับ `timeoutMs`/`onFinalFailure`), ยืนยันแล้วตรวจซ้ำพบแถวผิด → คืน validated พร้อมผลใหม่ (ไม่ 409 ที่ทำให้ผลหาย), audit ผู้ทำ = ผู้กดยืนยัน, ยกเลิกต้องมีเหตุผล + audit, ตรวจฟีเจอร์ในแพ็กเกจ (`ImportSpec.feature`), `checkFile` ระดับไฟล์ (โควตา), แจ้งเตือนเฉพาะงานนำเข้า 5 แบบ, รายการประวัติไม่ส่ง issues, ไฟล์แถวผิดสร้างจากการตรวจใหม่ (ครบทุกแถว), ข้อความ error ไทยใน wizard · QA: ไฟล์มีแต่หัวคอลัมน์/เครื่องหมายคำพูดไม่ปิด → ไฟล์ผิด, สูตรไม่มีค่าที่คำนวณ = ว่าง, ขนาดหลังแตก zip ≤ 20 MB, ผลตรวจหมดอายุแล้ว PATCH/ยกเลิกไม่ได้, หัวคอลัมน์เดียวจับคู่ได้ฟิลด์เดียว, ปุ่ม "นำเข้า N แถว" = จำนวนแถวที่ผ่าน, ปิด wizard ระหว่าง job ไม่บอกว่าสำเร็จ 0 แถว, Esc ปิด/โฟกัส dialog · **ค้าง (ไม่ขวาง):** แสดงคำเตือน (เช่น เติม 0 เลขภาษี) และสรุปผ่าน/เตือน/ผิดก่อนยืนยัน รอคำตอบข้อ 18, เลือก sheet ตามชื่อ template (MD-280), focus trap ใน dialog, timeout ของ transaction แสดงเป็น 429 `rate_limited` (mapping เดิมจาก T03) · **ค้าง:** rollback 24 ชม. (MD-287 = P1), geocode (MD-288), quota (MD-289) ทำพร้อม entity ใน ST2 |
| T21 setup checklist | เสร็จ (รอ review/QA) | `GET /v1/setup-checklist` (settings:write) คำนวณทุกขั้นจากข้อมูลจริงทุกครั้ง (PLT-040): องค์กร/ภาษี = เคยแก้ค่ากลุ่มนั้น (audit `tenant_setting.updated`) หรือกดบันทึกโดยไม่เปลี่ยนค่า (= ยืนยันค่าเริ่มต้น → `POST /v1/setup-checklist/reviewed`), สาขา = ทุกสาขามีที่อยู่ครบ, เลขเอกสาร = เคยแก้ชุดเลข หรือผู้ตั้งค่าเปิดหน้าเลขที่เอกสาร (ค่าที่เลือกไว้ก่อน — หน้านี้ไม่มีปุ่มบันทึก), นำเข้า = มีงานนำเข้าที่เขียนข้อมูลหรือมีข้อมูลหลัก, ทีม = ผู้ใช้ ≥ 2, connector = ข้าม (เหตุผล + audit) · ครบขั้นบังคับ → `completed_at` + audit `setup.completed` การ์ดหายถาวร (PLT-041) · ซ่อน/แสดงต่อผู้ใช้ · ตาราง `setup_checklist_state` (RLS) migration 0029 · UI การ์ดบนหน้าภาพรวมตามต้นแบบ, ขั้นตาม backlog [OPEN ข้อ 19] · review: ครบแล้วไม่คำนวณซ้ำ, ครบ/ข้ามพร้อมกันได้ audit ครั้งเดียว (updateMany มีเงื่อนไข), ซ่อนพร้อมกันไม่ทับกัน (แก้ array ใน SQL), ใช้ index ของ audit_log, ผู้ไม่มีสิทธิ์ไม่เรียก API, a11y สถานะขั้น · QA: tenant ใหม่เปิดหลายแท็บพร้อมกันไม่ได้ 409 (INSERT ON CONFLICT), ทีมไม่นับคำเชิญที่หมดอายุ/เพิกถอน, ที่อยู่สาขาตัดช่องว่าง, toast หลังซ่อน · ค้าง (ไม่ขวาง): event `setup.step_completed` (ยังไม่มี event bus — ST7), ขั้นนำเข้านับข้อมูลหลักที่ปิดใช้ด้วย · migration 0030 `reviewed_steps` · `test/setup-checklist.test.ts` + E2E |
| T24 | ยังไม่เริ่ม | admin portal |

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
| 12 | role บัญชี (Accounting) ดูหน้า "เลขที่เอกสาร"/ตั้งค่าภาษีได้ไหม — docs/04 A3 ให้เฉพาะ owner/admin แต่ spec/01 §12 ให้ Accounting ดู (ภาษีแก้ได้) · ตอนนี้ยึด docs (ไม่ได้) | 10 พ.ย. | หน้าตั้งค่าภาษี ST1-T17 | รอ |
| 13 | รูปแบบเลขเอกสารรายปี: ตอนนี้ปี 2 หลัก (`CN-00000-69-0001` ตามหัวตารางต้นแบบ "{YY} = ปี พ.ศ. 2 หลัก") แต่ตัวอย่าง docs/04 A4 เป็น 4 หลัก (`INV-00001-2569-`) — ใช้แบบไหน | 10 พ.ย. | ก่อนออกเลขจริง ST5 | รอ |
| 14 | ตั้ง "รูปแบบปีในเอกสาร" เป็น ค.ศ. แล้ววันที่บน header ของแอปเป็น ค.ศ. ด้วย ("11 พ.ย. 2026") — ต้องการให้มีผลเฉพาะเอกสาร หรือทั้งแอป | 11 พ.ย. | ไม่ขวาง | รอ |
| 15 | ช่องตั้งค่า รอบวางบิล / free time / แยกเอกสาร VAT ไม่มีในต้นแบบ — ให้ Claude Design เพิ่มในหัวข้อไหน (spec/12 §3) | 11 พ.ย. | หน้าตั้งค่าครบตาม T17 | รอ |
| 16 | แพ็กเกจ/feature matrix ใช้ข้อมูลตัวอย่างจากต้นแบบ (`plans.js`: เริ่มต้น/มาตรฐาน/องค์กร) — ยืนยันรายการฟีเจอร์ต่อแพ็กเกจและโควตาสำหรับนำร่อง; tenant ใหม่ตั้งเป็น "มาตรฐาน" ไว้ก่อน | 11 พ.ย. | ก่อนเปิดขาย | รอ |
| 17 | PO ขอ (11 พ.ย.) "แจ้งเตือน app ผ่าน notification mobile app" — docs/04 E2/I: push FCM/APNs เป็น P1 ของแอปคนขับ (เฟส 2, ยังไม่มีแอป) · T23 ทำ interface `NotificationChannel` ให้เสียบ `push` ได้โดยไม่แก้แกน — ต้องการ (ก) รอเฟส 2 ตาม docs หรือ (ข) ดึงเข้าเฟส 0 เช่น Web Push บนมือถือสำหรับทีมภายใน (ต้องเพิ่ม backlog/ADR) | 11 พ.ย. | ไม่ขวาง ST1 | รอ |
| 18 | Wizard นำเข้า: ต้นแบบนำเข้าเฉพาะแถวที่ผ่านแล้วแสดงแถวผิดทีหลัง แต่ spec/02 §11 ให้ค่าเริ่มต้น "ทั้งหมดหรือไม่เลย" และเห็นเหตุผลก่อนยืนยัน — UI ตอนนี้ทำตามต้นแบบ (API รองรับทั้งสองแบบ) ต้องการแบบไหน | 11 พ.ย. | ไม่ขวาง (เปลี่ยนค่าใน UI ได้) | รอ |
| 19 | Setup checklist: ต้นแบบ/spec/01 §4 ใช้ 6 ขั้น (บริษัท รถ คนขับ ทีม SO แรก บัญชี) แต่ docs/04 A5 + backlog ใช้ 7 ขั้น (องค์กร สาขา เลขเอกสาร ภาษี import ทีม connector) — ตอนนี้ใช้ชุด docs ในหน้าตาต้นแบบ; เมื่อมีรถ/คนขับ/SO (ST2–ST3) จะรวมสองชุดไหม | 11 พ.ย. | ไม่ขวาง | รอ |
| 9 | ตารางต้องแสดงยอดรวม "จาก N" ไหม (ต้นแบบมี แต่ API เป็น cursor — `spec/12` §3) | 10 พ.ย. | ทุกหน้ารายการ ST1+ | รอ |
| 10 | push ขึ้น `WeiWutichai/tms` — repo ตอนนี้เป็น **Public** รอ PO เปลี่ยนเป็น private ก่อน push; reviewer ยังไม่มี | 10 พ.ย. | T03 จบ, CI รันจริง | รอ PO |
| 11 | footer หน้า public: ชื่อนิติบุคคลจริง + ข้อความที่ตั้งข้อมูล (D-16 ยังไม่ตัดสิน) | 10 พ.ย. | ก่อนเปิดให้ลูกค้าใช้ | รอ |
| 6 | คำถามนักบัญชี 33 ข้อ (`plan/06`) | ยังไม่ส่ง | ST5 | รอ PO ส่ง |
| 7 | คำถามทนาย/PDPA (`plan/07`) | ยังไม่ส่ง | ST1 ข้อความ consent, T-08 | รอ PO ส่ง |
| 8 | คำถามทีม KRS (`plan/08`) | ยังไม่ส่ง | ST8 | รอ PO ส่ง |

## Defect / Incident

- (11 พ.ย., พบจาก E2E ล้มบางครั้งระหว่าง T19 — แก้แล้วใน PR T19) **เปลี่ยนหน้าเร็วแล้วหลุด login** — request ต่ออายุ token ถูกตัดกลางทางตอนเปลี่ยนหน้า: server บันทึกว่าใช้ token เก่าแล้วแต่ยังสร้าง token ใหม่ไม่เสร็จ → หน้าถัดไปใช้ cookie เก่าภายใน grace 30 วิ แต่หา token ใหม่ไม่เจอจึงตอบ 400 · แก้: ระหว่างนั้นเทียบ IP + User-Agent กับเจ้าของ token เดิม (`auth.service.ts`) + เว็บลองซ้ำ 3 ครั้ง (0.4/1/2 วิ) · test `auth.test.ts` กรณี mid-rotation
- (11 พ.ย., พบระหว่าง T19) **role ระบบของ tenant ที่มีอยู่ไม่ได้สิทธิ์ใหม่อัตโนมัติ** — `ensureSystemRoles` รันแค่ตอนสร้าง tenant/seed; เมื่อโค้ดเพิ่ม permission (เช่น `documents:write` ใน T08) tenant เดิมไม่ได้ จนกว่าจะรัน seed · ฐาน dev แก้ด้วย seed แล้ว · ต้องมี sync ตอน deploy/บูต ก่อนมี tenant จริง (เสนอทำใน T24 admin portal หรือ migration step) 

## บันทึกรายวัน

### 10 พ.ย. 2569 (เที่ยงคืน — แก้ผล review/QA ของ ST1, เริ่มใช้ dev → review → QA)

- **วิธีทำงานใหม่ (PO อนุมัติ):** ทุก task ผ่าน agent review + agent QA แยกกันก่อน merge (`plan/10` §3)
- **Review รอบ 1 (หลัง merge PR #1–#2) → แก้แล้ว:** login ยิงพร้อมกันหลุดล็อก (จองช่องใน transaction สั้น + advisory lock ต่ออีเมล/IP แล้วตรวจ argon2 นอก transaction), tenant ระงับแล้ว session ยังอยู่ (guard/refresh/exchange ตรวจสถานะ tenant), audit แบ่งหน้าข้ามแถว (`audit_log.seq`), สาขา default ซ้อน (ล็อกแถวนิติบุคคล + partial unique index), เปลี่ยนรอบเลขเอกสารภาษีกลางงวด (422 `series_in_use`), token dev/cookie ไม่ Secure นอก dev (NODE_ENV ต้องเป็น development/test ชัด ๆ) — migration `0008_review_fixes`
- **Review รอบ 2 → แก้แล้ว:** refresh พร้อมกันจริงไม่เพิกถอน family, ภายใน 30 วินาที browser เดิม (IP + User-Agent ตรง) ได้ token ใหม่ (reload ตัด response กลางทาง), test ยิง login พร้อมกันพิสูจน์ "ตรวจรหัสพอดี 5 ครั้ง"
- **QA (ทดสอบกับแอปจริง) → ผ่านทุกเกณฑ์ของ T01/T04/T12/T14/T15/T22; แก้แล้ว:** 403 เป็น `permission_denied` + module/action (spec/01 PLT-132), ตัวอย่างเลขภาษีใน OpenAPI checksum ผิด, กลุ่มเมนู "ตั้งค่า" กางเมื่ออยู่หน้าลูก, ลิงก์ "ตั้งค่า" ท้าย sidebar ไม่พา role ที่ไม่มีสิทธิ์ไปหน้าปฏิเสธ, เรียงผู้ใช้ตาม role, เปิด drawer สาขาก่อนรายการโหลดเสร็จแล้วบันทึกไม่ได้
- **ตรวจ:** test 158 (api 103) · E2E 15/15 + settings/shell ซ้ำ 4 รอบ
- **minor ที่บันทึกไว้ (ยังไม่แก้):** TRUNCATE audit_log โดย role เจ้าของฐานยังทำได้ (test helper ใช้ TRUNCATE — ปิดตอนมี staging), PATCH ไม่ส่ง If-Match ยังรับ (ตามดีไซน์ ST0 — connector strict mode ภายหลัง), ชุดเลข "ไม่รีเซ็ต" ที่ใช้แล้วเปลี่ยนรูปแบบไม่ได้เลย, migration 0008 จะ fail ถ้าฐานมี default ซ้อนอยู่ก่อน (ยังไม่มีข้อมูลจริง), POST สาขาด้วย companyId ของ tenant อื่นได้ 422 (ไม่ใช่ 404 — ไม่รั่วข้อมูล), tenant เดโมยังไม่มี audit ของข้อมูล seed

### 10 พ.ย. 2569 (ดึก — ST1-T12/T14/T15/T22)

- **ทำ:** role + permission ตาม A3 (`packages/domain/src/permissions.ts`, `apps/api/src/auth/system-roles.ts`), `/v1/users`, `/v1/roles`, `/v1/branches`, `/v1/document-sequences`, `/v1/audit-logs`; migration `0007_st1_org` (document_series, unique ตัวนับแบบ NULLS NOT DISTINCT, trigger audit append-only, REVOKE DELETE ตัวนับ)
- **Web:** หน้า "ตั้งค่า" (`apps/web/src/features/settings/`) — นิติบุคคลและสาขา, เลขที่เอกสาร, ผู้ใช้และสิทธิ์ (ผู้ใช้ + ตารางสิทธิ์ A3 อ่านอย่างเดียว); หัวข้ออื่นในเฟส 0 แสดง "ยังไม่เปิดใช้" พร้อม stage; ภาพเทียบ `design/compare/st1-settings-*-1440.png`
- **PO ตอบ 3 ข้อ:** สวิตช์ "ใช้ออกใบกำกับ" = สาขาออกเอง/สำนักงานใหญ่ออกแทน · ฟอร์มสาขาเป็น drawer · ตารางสิทธิ์ตาม A3 อ่านอย่างเดียว (บันทึกใน `spec/12` §3)
- **ตัดสินเองตามลำดับเอกสาร (ให้ทบทวน):** ชุด role ใช้ 9 role ตาม D-12 ("ชุด docs + manager" ซึ่งมี Approver) — `plan/11` ข้อ 11 เขียนไว้ 8 role (ไม่มี approver) แก้ให้ตรงแล้ว · ชุดเลขตั้ง prefix/รีเซ็ตต่อประเภทเอกสาร (ตามตารางต้นแบบ) แต่นับแยกต่อสาขาสำหรับเอกสารภาษี (`plan/02` T-21)
- **ตรวจ:** lint/typecheck/build ผ่าน · test 147 (api 92, domain 39, ui 11, web 5) · E2E 15/15
- **ค้าง:** เปลี่ยน role + step-up (T05), banner เพิ่มสิทธิ์, โลโก้/ลายเซ็นนิติบุคคล (T08), UI ประวัติการแก้ไข, ปุ่ม "บันทึก" ลอยของต้นแบบ (หน้าตั้งค่าบันทึกทันทีต่อช่อง — [OPEN] ใน spec/12)

### 10 พ.ย. 2569 (ค่ำ — ST1-T01/T04 login + session)

- **ทำ:** API `POST /v1/auth/login` → `POST /v1/oauth/token` (authorization_code/refresh_token) → `POST /v1/oauth/revoke`; guard ตรวจ `tokenVersion` ทุก request; migration `0005_auth_login` + `0006_auth_rls` (ตาราง platform `login_attempt`, `auth_code`, `refresh_token`); `/v1/me` มี `user {name, email, roles}`; seed ผู้ใช้เดโม `owner@demo-a.test` / `owner@demo-b.test` (รหัสใน `apps/api/prisma/seed.ts`)
- **Web:** หน้า login/เลือกบริษัทตาม `TMS Signup.dc.html` (`apps/web/src/public/`), session ในหน่วยความจำ + refresh cookie (`src/auth/session.ts`), ทุกหน้าในระบบต้อง login (`RequireAuth`), ปุ่มออกจากระบบ + ชื่อ/role ใน sidebar; ลบ `dev:token`/`VITE_DEV_TOKEN` แล้ว — E2E login ผ่าน API จริงทุก test (`e2e/fixtures.ts`)
- **PO ตอบ (10 พ.ย.):** ซ่อนปุ่ม Google, ซ่อน "ทดลองใช้ฟรี 30 วัน", header เหลือโลโก้/footer เหลือแถวล่าง — บันทึกใน `spec/12` §3 แล้ว
- **ตัดสินระหว่างทำ (ให้ทบทวน):** access token HS256 ไปก่อน RS256 ใน ST7 (`plan/02` T-04); ล็อกต่อ IP ตามตัวอักษร docs อาจล็อกทั้งออฟฟิศที่ใช้ NAT
- **ผล:** lint/typecheck/build ผ่าน, test 95 ข้อ (api 70, ui 11, domain 9, web 5), E2E 12 ข้อผ่าน
- **ค้าง:** footer มีชื่อนิติบุคคล placeholder + "ข้อมูลเก็บในประเทศไทย" ที่ยังไม่ตัดสิน (`spec/12` §3 [OPEN]); ลิงก์ "ลืมรหัสผ่าน" ยังไปหน้า 404 จนกว่าจะทำ T03; ยังไม่ push GitHub (รอเปลี่ยน repo เป็น private)

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
