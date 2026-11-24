# ST9-T13 ตรวจความปลอดภัย — รอบสุดท้าย (24 พ.ย. 2569)

> งาน: `plan/01` ST9-T13 (รอบสุดท้าย หลัง ST8-T12) · รอบแรก: `docs/security/st9-t13-review.md` (PR #165) · อ้างอิง: docs/04 A1/A3/A6/J, spec/11 §2–3, §12, §14, D-67/D-73/D-77/D-78/D-79/D-80
> สถานะ: **PASS ตามเกณฑ์ตรวจรับ** — ไม่พบ Critical/High · coverage ข้าม tenant = **100% ของ route (558/558)**
> ผู้ตรวจ: Claude Code (lane md, branch `st9/t13-security-final`, ฐาน `origin/main` 016a7110)
> คำสั่ง PO 24 พ.ย. 2569 (ก่อน UAT): แก้ทุกข้อที่มีทางแก้ปลอดภัย — ที่ docs ไม่ระบุเลือกทางระมัดระวัง + บันทึก **[DECISION — lead 24 พ.ย. เพื่อ UAT, ย้อนได้]** · ค้างเฉพาะงานที่ต้องพึ่งภายนอก (hosting/cloud/ดาวน์โหลด dependency)

รูปแบบเดียวกับรอบแรก: **FACT** (สิ่งที่โค้ด/test แสดงจริง) กับ **ข้อเสนอ** · ระดับ Critical / High / Medium / Low / Info
รหัสข้อของรอบนี้ขึ้นต้น `R2-` · ข้อค้างของรอบแรก (M-01, M-03, L-01…L-07) ทบทวนใน §3

## 0. สรุป

| ระดับ | พบใหม่รอบนี้ | ข้อค้างรอบแรกที่ทบทวน | ปิดใน PR นี้ | ค้าง (ภายนอก) |
|---|---|---|---|---|
| Critical | 0 | — | — | 0 |
| High | 0 (1 advisory ของ dependency ฝั่ง build — ดู R2-L03) | — | — | 0 |
| Medium | 2 (R2-M01, R2-M02) | 2 (M-01, M-03) | 2 (R2-M01, R2-M02) | 2 (M-01, M-03 — รอ ADR hosting) |
| Low | 3 (R2-L01, R2-L02, R2-L03) | 6 (L-01…L-07 ยกเว้น L-00 ที่ปิดแล้ว) | 2 ใหม่ + 5 ของรอบแรก (L-01, L-02, L-03, L-04, L-06, L-07 — L-04 ด้วยค่าเริ่มนอก dev) | 2 (R2-L03 รอดาวน์โหลด dependency · L-05 รอ object storage) |
| Info | 3 | — | — | — |

## 1. ตารางข้อค้นพบ

| รหัส | ระดับ | เรื่อง | สถานะ | แก้ที่ / หลักฐาน |
|---|---|---|---|---|
| R2-M01 | Medium | กุญแจเข้ารหัส field (`FIELD_ENCRYPTION_KEYS`) และ `BLIND_INDEX_KEY` ตัวอย่างอยู่ใน `.env.example` + `ci.yml` — ระบบนอก dev/test ยอมเริ่มด้วยค่านี้ (ต่างจาก `API_KEY_PEPPER` ที่ปฏิเสธค่า dev อยู่แล้ว) → คัดลอก `.env.example` ไป deploy = เลขบัตร/บัญชี/credential/TOTP ถอดได้ด้วยค่าใน repo | **ปิด** | `src/common/crypto.ts` `assertNoDevKeys()` + ตรวจใน `FieldCipher`/`BlindIndex` constructor (นอก dev/test) · เรียกตอนบูต `bootstrap.ts` และ `worker.ts` · test `src/common/crypto.test.ts` |
| R2-M02 | Medium | Console "เข้าใช้งานแทน" (`POST /v1/platform/tenants/{id}/impersonate`) ไม่ต้อง step-up — token Console ที่ถูกขโมย (8 ชม.) เปิดดูข้อมูลทั้งบริษัทของลูกค้าได้ 60 นาที (D-77 ครอบเฉพาะ credential/ค่าตั้ง connector) | **ปิด** — [DECISION — lead 24 พ.ย. เพื่อ UAT, ย้อนได้] | `@StepUpAlways('platform')` + `assertStepUp()` หลัง 404/สถานะ (`platform-tenants.controller.ts`) · เว็บ Console แนบ `consoleStepUpHeaders()` → ไม่มี/หมดอายุ = กล่อง StepUpBox เดิมของ `ActionDialog` (ไม่เพิ่ม UI ใหม่) · OpenAPI: header ไม่บังคับใน schema (แบบ D-77 — ไม่ breaking) · test `platform.test.ts` "เข้าใช้งานแทน …" (ไม่ส่ง/ปลอม → 403 ไม่สร้าง session) |
| R2-L01 | Low | `?next=` หลัง login ยอม `/\evil.com` — เบราว์เซอร์แปลง `\` เป็น `/` → open redirect (react-router < 7.18 GHSA-wrjc-x8rr-h8h6 ทำให้ `navigate()` ไม่กัน) | **ปิด** | `apps/web/src/public/Login.tsx` `safeNextPath()` (ห้าม `\`, อักขระควบคุม/ช่องว่าง, `//`) · test `src/public/loginNext.test.ts` · Console ใช้ prefix `/console/` อยู่แล้ว (ปลอดภัย) |
| R2-L02 | Low | `ProblemFilter` log `PrismaClientKnownRequestError` ที่ไม่รู้จักทั้งก้อน — ข้อความมีค่า argument/ค่าที่ชน (ส่วนหนึ่งของ L-02 รอบแรก) | **ปิด** | `prismaSummary()` log เฉพาะชื่อ/รหัส/ชื่อ field + บรรทัด stack ของโค้ดเรา (ทั้ง KnownRequest และ Validation) · test `problem.filter.test.ts` "log ไม่รั่วค่า argument ของ Prisma" |
| R2-L03 | Low (advisory High) | `pnpm audit`: `effect` ≤ 3.22.0 ReDoS (GHSA-7589-6fvf-x4pw — ผ่าน `prisma` CLI → `@prisma/config`, ใช้ตอน build/migrate เท่านั้น ไม่อยู่ใน runtime ของ API) · `react-router` 6.30.6 moderate 2 ข้อ (open redirect ด้วย `\` — ลดผลแล้วด้วย R2-L01; SSR hydration — ไม่ใช้ SSR) | **ค้าง (ภายนอก)** — ต้องดาวน์โหลดแพ็กเกจใหม่ (lane นี้ห้ามใช้เครือข่ายนอกจาก `pnpm audit`; store ในเครื่องมีแค่ effect 3.21.0) | **ข้อเสนอ:** `pnpm.overrides` `"effect": "^3.22.1"` (หรืออัปเดต prisma) ในงานถัดไปที่มีเครือข่าย · react-router 7 = major upgrade แยกงาน · CI gate `--audit-level=critical` ยังเขียว |
| I-01 | Info | API key ถือ `credit-notes:approve` ได้ (ไม่อยู่ใน `API_KEY_DENIED_SCOPES`) แต่ route อนุมัติใหม่ทั้งหมด (คิว ST8-T13 approve, reconcile overwrite approve/reject, reconcile run, ปิดรายการ) เรียก `assertHuman()` + ผู้อนุมัติ ≠ ผู้ขอ (`erp_replace_self_approval`) | ไม่ใช่ defect | `connector-queue.ts` `approve`, `reconcile-close.service.ts` `prepare` |
| I-02 | Info | ส่งออก reconcile-period-close ไม่อยู่ในรายการ "ทุกครั้ง" แต่ query ไม่มี `ids` (ส่ง `ids` = 422 forbidNonWhitelisted) → step-up ทุกครั้งโดยปริยาย | ไม่ใช่ defect | `auth/step-up.ts` `exportNeedsStepUp` + `exports.service.ts:284-285` |
| I-03 | Info | Console ระงับ/เปิดใช้ tenant, pause/resume connector ไม่ต้อง step-up (SUPER_ADMIN + เหตุผล + audit) — ย้อนได้ ไม่เปิดข้อมูล | ไม่เปลี่ยน | — |

## 2. ผลตาม checklist (รันซ้ำ + ขยายพื้นผิวใหม่)

### 2.1 Coverage ข้าม tenant
**FACT** `route-inventory.test.ts`:
```
[route-inventory] 558/558 routes covered (100.0%) {"public":21,"tenant:list":169,"tenant:id":298,"tenant:static":1,"platform":23,"tenant:external":27,"link":19}
```
(รอบแรก 523 → +35 route: connector metrics/sync-log/queue ×8, reconcile ×9, carrier erp-codes ×2, carrier pay-link ×3, invoices external ×2 + erp-posted, payments external, revenue report, accounting-export summary, `/me/badges`, users reset-2fa, Console step-up/health/reset-2fa)
- `isolation.test.ts` 5/5 ผ่าน — ทุก route `:id` ใหม่มี `@TenantResource` + fixture (gate (2) แดงถ้าลืม) · token B → 404
- param รอง: `connectors/:id/queue/:commandId/*` ค้นด้วย `targetId = connector` ใต้ RLS (`connector-queue.ts` `command()`), `carriers/:id/erp-codes/:connectorId` ใต้ RLS, `public/carrier-pay/:token/settlements/:settlementId/pdf` ผูก `carrierId` ของลิงก์ (`paidSettlement(carrierId, sid)`)
- `magic-link-matrix.test.ts` 3/3 — purpose `carrier_pay` อยู่ใน `PURPOSE_ACTIONS` แล้ว (รอบแรก §5 แถวค้าง)

### 2.2 RBAC / scope / API key
- deny-by-default ผ่าน (inventory) · route ใหม่ทุกตัวมี `@RequireScope` (ยกเว้น `/me/badges` = SELF_AUTHORIZED กรองตาม scope ใน handler `nav-badges.controller.ts:143`)
- `API_KEY_DENIED_SCOPES` = users:read/write, settings:write, settlements:approve, pii.national_id:read (D-73) · route ที่ต้องเป็นคน (D-79 บัญชีธนาคาร, คิว override/approve, reconcile ปิด/อนุมัติ/run, connector) ใช้ `assertHuman()` / `bank_change_requires_user`
- reconcile PAYMENT_STATUS ต้อง `settings:write` ตรวจใน handler (`reconcile.controller.ts`)
- impersonation = `pt: imp` อ่านอย่างเดียว · ไม่ได้เลขบัตรเต็มในไฟล์ส่งออก (`nationalIdAllowed` รับเฉพาะ user/dev) · ไม่เห็นราคาขาย (`redactPrices` ถือ imp เป็นภายนอก)

### 2.3 Step-up
ครบตาม D-67/D-77/D-78/#81: API key สร้าง/แก้/หมุน, webhook สร้าง/หมุน/แก้ url+header, connector credential/settings/inbound token, ยกเลิกใบแจ้งหนี้, บัญชีธนาคาร, ส่งออก, รีเซ็ต 2FA (ทั้งบริษัทและ Console) · **เพิ่ม R2-M02 เข้าใช้งานแทน** · `two-factor-d77-d79.test.ts` 11/11, `platform.test.ts` 7/7

### 2.4 ข้อมูลส่วนบุคคล / secret รั่ว
| ช่องทาง | FACT | สถานะ |
|---|---|---|
| erp_sync_log | `scrubBody`: `maskPii` (ชื่อคนขับ/เลขภาษี/บัตร) + `redactSecrets` + `redactNationalIds` (D-80 ช่วงตัวเลข ≥ 6) + ตัด 16 KB · URL ตัด query/user:pass · KRS ปิด `carPerson` ทั้ง request (`redactKrsBody`) และ response (`maskKrsPersonText`) · body ที่มียอดเงินซ่อนเมื่อไม่มี `prices.*:read` (`bodyPriceScopes`) | PASS |
| outbox payload | D-80 เลขบัตรใส่ ณ ตอนส่งเท่านั้น ไม่เก็บใน `integration_outbox` · hash ใช้ blind index | PASS |
| reconcile / period-close / revenue | ช่องเงิน `@PriceField('sell'|'buy')` · ไฟล์ส่งออกเลือกคอลัมน์ตาม scope | PASS |
| ส่งออกให้นักบัญชี | เลขบัตรเต็มเฉพาะ `pii.national_id:read` + คนที่ login · audit `export.pii_included` ต่อไฟล์ | PASS |
| Console health/commands | ตัวนับ/รหัสเท่านั้น ไม่มี payload/ยอดเงิน | PASS |
| log ของโมดูล | **แก้ในรอบนี้** — Nest `Logger` ออกทาง pino (`PinoNestLogger` ใน main/worker → requestId/tenantId + redact ของ object) · Prisma error ไม่ log ข้อความ (R2-L02) | PASS (L-02 ปิด) |
| อีเมลรีเซ็ต 2FA | `safeName` กับชื่อ/เหตุผล · ไม่มี token | PASS |

### 2.5 SSRF / URL ขาออก
ทุก adapter (KRS push/fetch/replace/SO, AccountSystem) + webhook ใช้ `safeHttpRequest` (ตรวจรูป URL → resolve DNS → ต่อด้วย IP ที่ตรวจแล้ว, ไม่ตาม redirect, https นอก dev, จำกัดขนาด/เวลา) · `allowPrivate` มาจาก env dev/test เท่านั้น (`allowPrivateTargets`) · `fetch` ตรงเหลือ 2 จุดที่ URL มาจาก env (availability probe, ผู้ให้บริการ SMS/LINE) — PASS

### 2.6 Raw SQL
`$queryRawUnsafe`/`$executeRawUnsafe` ทั้งหมด: SAVEPOINT คงที่, ชื่อตารางจาก allowlist (`CODE_TABLES`/`REF_TABLES`/enum ในโค้ด) + ค่าผ่าน `$1` · `Prisma.raw` เฉพาะ alias `c_${i}` จาก index · ที่เหลือเป็น tagged template (parameterized) — PASS ไม่มี injection

### 2.7 Rate limit (auth/2FA)
login/2FA/step-up ร่วมเพดานล็อก 5/15 นาที · step-up ของ Console นับรวม login Console + `platform/auth/*` ต่อ IP · **แก้ในรอบนี้:** `auth/invitations/*` อยู่ใต้เพดานต่อ IP (L-07) · `/v1/public/*` ค่าเริ่ม 60/นาที/IP นอก dev/test (L-04)

### 2.8 Dependency / secret ใน repo
- `pnpm audit` (24 พ.ย.): high 1 (effect — build-time), moderate 2 (react-router) → R2-L03 · ไม่มี critical (CI gate เขียว)
- สแกน secret: **เพิ่ม `scripts/scan-secrets.mjs`** (ไม่ใช้เครือข่าย; private key, AWS, GitHub, Slack, Google, Stripe, `tk_live_`, base64 ยาว) รันใน `pnpm lint` (ทั้ง ci:local และ GitHub CI) — 2,234 ไฟล์ไม่พบ (L-06 ปิด) · ค่า dev ใน `.env.example` ถูกปฏิเสธนอก dev/test แล้ว (R2-M01, pepper, signing key)

## 3. ข้อค้างของรอบแรก — ทบทวน

| รหัส | เดิม | รอบนี้ |
|---|---|---|
| M-01 | header ของเว็บ static (CSP/frame-ancestors/HSTS/nosniff) | **ค้าง (ภายนอก)** — repo ยังไม่มี config hosting (ADR hosting, PLAN §1.1) · ค่าที่เสนอคงเดิมตามรอบแรก §4 |
| M-03 | token ใน URL → access log ของ proxy | **ค้าง (ภายนอก)** — checklist deploy (ตัด path `/v1/public/*/`, `/link/*/`, `/v1/inbound/*/`, query `sig`/`t`) |
| L-01 | หน้าลิงก์ไม่มี meta noindex | **ปิด** — `PrivateLinkLayout` (`apps/web/src/public/privacyMeta.tsx`) ครอบ `/link/*` + `/invite` `/reset-password` `/impersonate` (หน้าติดตามมีเดิม) · ไม่เปลี่ยนหน้าตา · test `privacyMeta.test.tsx` |
| L-02 | Nest Logger ไม่ผ่าน pino + Prisma error | **ปิด** (R2-L02 + `PinoNestLogger`) · test `logger.test.ts` |
| L-03 | ไม่ตรวจ Origin ที่ grant ที่ใช้ cookie | **ปิด** — `oauth/token` (refresh/authorization_code) ปิดไปแล้วใน review T-1 · รอบนี้เพิ่ม `oauth/revoke` (`assertCookieGrantSameSite`) · test `auth.test.ts` "ออกจากระบบ …" (cross-site → 403) |
| L-04 | เพดาน public 120/นาที/IP | **ปิด** — นอก dev/test ค่าเริ่ม 60 (NFR-1106) [DECISION — lead 24 พ.ย. เพื่อ UAT, ย้อนได้ ด้วย env `PUBLIC_RATE_LIMIT_PER_MIN`] · dev/test คง 120 |
| L-05 | สแกนมัลแวร์ / โดเมนไฟล์แยก | **ค้าง (ภายนอก)** — ทำพร้อม object storage (plan/02 T-09) |
| L-06 | ไม่มี secret scanning | **ปิด** — `scripts/scan-secrets.mjs` ใน `pnpm lint` |
| L-07 | `auth/invitations/inspect` ไม่มี rate limit | **ปิด** — `PublicRateLimitMiddleware` ที่ `auth/invitations/*` · test `invitations.test.ts` (header `RateLimit-Limit`) |

## 4. รายการที่ต้องทำต่อ (นอก repo / ต้องใช้เครือข่าย)
1. hosting จริง: ใส่ header M-01 + ตั้ง log format M-03 แล้ว `curl -I` ตรวจบน staging
2. dependency: override `effect` ≥ 3.22.1 (หรือ prisma รุ่นใหม่) แล้ว `pnpm audit` ซ้ำ · แผน react-router 7
3. object storage + สแกนไฟล์ (L-05)
4. deploy: ตั้ง `FIELD_ENCRYPTION_KEYS` / `BLIND_INDEX_KEY` / `API_KEY_PEPPER` / signing key จาก secret manager — ค่า dev จะทำให้ API/worker ไม่ยอมเริ่ม (R2-M01)
