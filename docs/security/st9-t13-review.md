# ST9-T13 ตรวจความปลอดภัย — รอบแรก (22 พ.ย. 2569)

> งาน: `plan/01` ST9-T13 · อ้างอิง: docs/04 A1/A3/J (Security), spec/11 §2–3, §12, §14 · รอบสุดท้ายจะรันซ้ำหลัง ST8-T12
> สถานะ: **PASS ตามเกณฑ์ตรวจรับ** — ไม่พบ defect ระดับ Critical/High · coverage ข้าม tenant = **100% ของ route (523/523)**
> ผู้ตรวจ: Claude Code (lane lx, branch `st9/t13-security-review`, ฐาน `origin/main` f82c3d36)

รูปแบบ: แต่ละข้อแยก **FACT** (สิ่งที่โค้ด/test แสดงจริง พร้อม `ไฟล์:บรรทัด` หรือชื่อ test) กับ **ข้อเสนอ** (สิ่งที่ควรทำ — ยังไม่ได้ทำ)
ระดับ: Critical / High (ต้องปิดก่อนจบเฟส) · Medium · Low · Info

## 0. สรุป

| ระดับ | พบ | ปิดใน PR นี้ | ค้าง |
|---|---|---|---|
| Critical | 0 | — | 0 |
| High | 0 | — | 0 |
| Medium | 3 | 0 (M-02 ปิดภายหลังใน `fix/d67-stepup-extension` — D-67) | 2 (M-01 รอ ADR hosting, M-03 รอ ADR hosting) |
| Low | 7 | 1 (L-00) | 6 |

สิ่งที่เพิ่มใน PR นี้ (FACT):
- `apps/api/test/route-inventory.ts` — ตัวอ่าน route ทั้งแอปจาก metadata ของ Nest (ใช้ร่วมกับ harness เดิม) + ตาราง action ของลิงก์ต่อ purpose
- `apps/api/test/route-inventory.test.ts` — **route inventory gate**: ทุก route ต้องอยู่ในหมวดที่มีหลักฐาน (ไม่เข้าหมวด = test แดง), deny-by-default, action ลิงก์ไม่ชนกันข้าม purpose, ไม่มี field ราคาใน response ของ `/v1/public/*`, ไม่มี credential → 401 ทุก route, security header ของ API
- `apps/api/test/isolation.test.ts` (4) — **ทุก GET ที่ไม่มี path param** (list/summary/รายงาน/export) เรียกด้วย token ของ B หลังสร้างข้อมูลทุกชนิดใน A → ไม่มี id ของแถวใดใน A (ตรวจทั้งรูป uuid และ id ภายนอก `xxx_<hex>`)
- `apps/api/test/magic-link-matrix.test.ts` — ลิงก์ทุก purpose × ทุก route ลิงก์: จำกัด action, ปลอม/หมดอายุ/เพิกถอน/purpose อื่น/tenant ระงับ → 404 เดียวกัน + no-store + noindex + no-referrer + ไม่สะท้อน id
- `apps/api/src/app.module.ts` — `X-Robots-Tag: noindex, nofollow` + `Referrer-Policy: no-referrer` ขยายจาก `/v1/public/tracking/*` เป็น**ทุก** `/v1/public/*` (L-00, NFR-135)

## 1. Coverage ข้าม tenant (ทุก endpoint)

**FACT** — ผลจาก `route-inventory.test.ts` "ทุก route อยู่ในหมวดที่มีหลักฐานแยก tenant/ยืนยันตัวตน — coverage 100%":

```
[route-inventory] 523/523 routes covered (100.0%)
{"tenant:id":278,"tenant:list":162,"tenant:external":24,"tenant:static":1,"link":17,"platform":20,"public":21}
```

| หมวด | จำนวน | กลไกแยก tenant | หลักฐาน (test) | สถานะ |
|---|---|---|---|---|
| `tenant:id` — token ลูกค้า + `:id` | 278 | `@TenantResource` + RLS | `isolation.test.ts` (2) ทุก route มี resource + fixture · (3) token B เรียก resource A → 404 problem+json + เจ้าของเรียกได้ 200 | PASS |
| `tenant:list` — token ลูกค้า ไม่มี path param | 162 | tenant จาก token + RLS | `isolation.test.ts` (1) ทุกตารางที่มี `tenant_id` เปิด RLS+FORCE+policy · **(4) ใหม่** GET ทุกตัวด้วย token B ไม่มี id ของ A (มีตัวควบคุม: เจ้าของเห็น id ตัวเอง) | PASS |
| `tenant:external` — `/external/:externalId` | 24 | ค้นด้วย (tenant, externalId) | `external-id-conformance.test.ts` (4) "… 404/412/422 · แยก tenant" | PASS |
| `tenant:static` — param ไม่ใช่ข้อมูล tenant | 1 | — (`GET /v1/imports/kinds/:kind/template` ไฟล์คงที่) | รายการ `OTHER_PARAM` ใน inventory | PASS |
| `link` — `@LinkAction` + `:token` | 17 | tenant + entity มาจากแถว `magic_link` | `magic-link-matrix.test.ts` + test ของแต่ละโมดูล (§5) | PASS |
| `platform` — `@PlatformAuth` | 20 | token Console แยก (ทีม Innovera) | inventory "… token ลูกค้าเรียก Console → 401" ทุก route · `platform.test.ts` "login แยก … token Console ใช้กับ route ลูกค้าไม่ได้ (และกลับกัน)" | PASS |
| `public` — `@Public` ที่ไม่ใช่ลิงก์ | 21 | กลไกแทน token ต่อ route (รหัสผ่าน, URL ลายเซ็น HMAC, METRICS_TOKEN, token ขาเข้า) | ตาราง `PUBLIC_ROUTES` ใน `route-inventory.test.ts` (เหตุผล + test อ้างอิงทุกแถว; แถวค้าง = test แดง) | PASS |

route ที่มี param รองหลัง `:id` (เช่น `/settlements/:id/lines/:lineId/...`, `/orders/:id/source-changes/:changeId/...`) — harness (3) ใช้ `:id` ของ tenant A แล้วได้ 404 ก่อนถึง param รอง; param รองค้นใต้ RLS ของ tenant ของ token

**FACT เพิ่ม (ด่านอัตโนมัติ):**
- ไม่มี credential → **401 ทุก route** ที่ต้อง login ด้วย token ลูกค้า (465 route) · token ลูกค้าเรียก Console → 401 (20 route) · token ลิงก์ปลอม → 404 (17 route) — `route-inventory.test.ts` "ไม่มี credential → 401 …"
- **deny by default (NFR-132)**: route ที่ใช้ token ลูกค้าแต่ไม่มี `@RequireScope` ต้องอยู่ใน `SELF_AUTHORIZED` พร้อมเหตุผล (`/me/*`, `/auth/step-up`, `/saved-views*`, `/imports*` ตรวจตามชนิดใน handler, `GET /jobs/:id` ตรวจผู้สั่งใน handler) — test "deny by default (NFR-132)"
- route ใหม่ใต้ `/v1/public/` ต้องเป็นลิงก์หรืออยู่ใน `PUBLIC_ROUTES` — มิฉะนั้น UNCLASSIFIED (แดง)

**ข้อเสนอ:** NFR-207 (canary tenant ยิงข้าม tenant ใน production ทุก 15 นาที) เป็นงาน deploy — ยังไม่มี environment

## 2. Input validation / upload / MIME

| ข้อ | FACT (หลักฐาน) | สถานะ |
|---|---|---|
| schema ทุก API | `ValidationPipe` global `whitelist` + `forbidNonWhitelisted` + `transform` (`src/common/validation.ts:20-23`) · lint DTO (`scripts/lint-dto.mjs` "76 controllers OK") | PASS |
| ขนาด body | JSON 1 MB, อัปโหลด raw 10 MB เฉพาะ URL ลายเซ็นถูก (อ่าน body หลังตรวจลายเซ็น), webhook ขาเข้า 256 KB (`src/bootstrap.ts:95-106`) · `documents.test.ts` "review S1: ลายเซ็นผิด → 404 โดยไม่อ่าน body" | PASS |
| MIME จริง (magic bytes) | `sniffMime` PDF/PNG/JPEG/WebP/XLSX/CSV, ปฏิเสธ markup (HTML/SVG/XML) ที่ปลอมเป็น CSV (`src/modules/documents/mime.ts:26`) · เทียบกับที่ประกาศ (`documents.controller.ts:377`) · `documents.test.ts` "ไฟล์ปลอมนามสกุล … → 422 mime_mismatch", "ขนาด: เกินที่ประกาศ → 422 …" | PASS |
| path traversal ที่เก็บไฟล์ | key สร้างจาก server เท่านั้น `tenantId/sha256.ext` + regex tenant/ext (`src/pdf/file-store.ts:29-31`), `get` ปฏิเสธ `..` (`:47`), เขียน `wx` ไม่ทับ | PASS |
| ดาวน์โหลด | `attachment` + `nosniff` + `no-store`, ชื่อไฟล์ถูก sanitize (`documents.controller.ts:410-424`) · URL ลายเซ็น HMAC ผูก action/tenant/id/exp | PASS |
| CSV/formula injection (NFR-164) | `safe()`/`csvCell()` ทุกการส่งออก CSV (`src/modules/master/export.ts:44`, `exports.service.ts:81-85`) | PASS |
| SSRF (webhook/connector) | resolve DNS แล้วบล็อก private/loopback/link-local/metadata, ไม่ตาม redirect, https เท่านั้นนอก dev (`src/modules/webhooks/ssrf.ts:63-75`, `webhook-http.ts:62-64`) — ใช้กับ AccountSystem/KRS ด้วย | PASS |
| query param ซ้ำ/array บน URL ลายเซ็น | `verifyDocumentUrl` ตรวจรูปแบบ `exp` + ความยาว + `timingSafeEqual` → ค่าแปลกคืน null (404) | PASS |

**L-05 (Low, ค้าง):** ยังไม่มีสแกนมัลแวร์ไฟล์ PDF และไม่เสิร์ฟไฟล์จากโดเมนแยก `files.<domain>` (NFR-163 [PROPOSED]) — **FACT** ลดความเสี่ยงด้วย attachment + nosniff + CSP `default-src 'none'` บน origin ของ API · **ข้อเสนอ:** ทำพร้อม object storage (plan/02 T-09) — presigned URL โดเมนแยก + สแกนก่อนเปลี่ยนเป็น READY

## 3. CSRF / XSS

| ข้อ | FACT | สถานะ |
|---|---|---|
| รูปแบบ auth | API ทั้งหมดใช้ `Authorization: Bearer` (header) — ไม่ใช้ cookie ยืนยันตัวตน · access token อยู่ในหน่วยความจำ ไม่ลง localStorage (`apps/web/src/auth/session.ts:5`) | PASS |
| cookie refresh | `tms_rt` httpOnly + `Secure` (นอก dev) + **SameSite=Strict** + `Path=/v1/oauth` (`src/auth/auth.controller.ts:148-156`) · cookie จำอุปกรณ์ `tms_td` เหมือนกัน (`mfa.controller.ts:23-27`) | PASS |
| CORS | ไม่เปิด — origin อื่นอ่านคำตอบไม่ได้ (`route-inventory.test.ts` "security headers …" ตรวจ preflight ไม่มี `Access-Control-Allow-Origin`) | PASS |
| XSS เว็บ | ไม่มี `dangerouslySetInnerHTML` / `innerHTML` / `new Function` ใน `apps/web/src` (grep) · `?next=` รับเฉพาะ path ภายใน (`public/Login.tsx:43-44`, `console/ConsoleApp.tsx:97-98`) | PASS |
| XSS ใน PDF | ทุกค่าผ่าน `escapeHtml` (`src/pdf/pdf-renderer.ts:182`) · Chromium บล็อกทุก request ที่ไม่ใช่ `data:`/`about:` (`:150`) · `invoice-pdf.test.ts`, `trip-sheet-pdf.test.ts`, `settlement-pdf.test.ts` ใส่ `<script>` แล้วต้องถูก escape | PASS |
| XSS ในอีเมล | `layout()` escape ทุกค่า (`src/modules/email/templates.ts:12-29`) | PASS |

**L-03 (Low, ค้าง):** `POST /v1/oauth/token` (grant refresh_token) และ `/v1/oauth/revoke` ไม่ตรวจ `Origin` (NFR-162 ขอ "ตรวจ Origin + header กำหนดเอง") — **FACT** SameSite=Strict + ไม่มี CORS + path จำกัด ทำให้ cross-site POST ไม่แนบ cookie และอ่านผลไม่ได้ · **ข้อเสนอ:** ตรวจ `Origin` ∈ `WEB_BASE_URL` เมื่อมี cookie (defense in depth)

## 4. Security headers

| ข้อ | FACT | สถานะ |
|---|---|---|
| API | helmet: CSP `default-src 'none'; frame-ancestors 'none'`, HSTS 1 ปี + includeSubDomains + preload, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `nosniff`, CORP same-site, ไม่มี `X-Powered-By` (`src/bootstrap.ts:70,86-94`) — `route-inventory.test.ts` "security headers ของ API (NFR-161) …" | PASS |
| ลิงก์สาธารณะ (API) | `Cache-Control: no-store` ทุก `/v1/public/*` (`public-rate-limit.middleware.ts`) · **PR นี้:** `X-Robots-Tag: noindex, nofollow` + `Referrer-Policy: no-referrer` ทุก `/v1/public/*` (`src/app.module.ts:531-539`) — `magic-link-matrix.test.ts` ตรวจทุก route ลิงก์ | PASS (L-00 ปิดแล้ว) |
| เว็บ (SPA) | `<meta name="referrer" content="no-referrer">` ทั้งแอป (`apps/web/index.html:7`) | บางส่วน |

**M-01 (Medium, ค้าง — รอ ADR hosting, PLAN §1.1):** **FACT** repo ยังไม่มีค่าตั้ง hosting ของเว็บ (static) — ไม่มี CSP / `X-Frame-Options`/`frame-ancestors` / HSTS / `nosniff` บน HTML ของเว็บ (docs/04 J "Security headers" P0, NFR-161) → หน้าเว็บถูกฝังใน iframe ได้ (clickjacking) และไม่มี CSP กัน XSS ชั้นสอง
**ข้อเสนอ** (ใส่ใน config ของ hosting/CDN ตอน deploy staging): `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` (ตรวจ `unsafe-inline` ของ style กับ build จริงก่อน) · `X-Frame-Options: DENY` · `Strict-Transport-Security: max-age=31536000; includeSubDomains` · `X-Content-Type-Options: nosniff` · `Referrer-Policy: no-referrer` (token อยู่ใน URL `/link/*`) — ยกเว้น frame-ancestors ของหน้าติดตามถ้าลูกค้าขอ embed (NFR-161 allowlist)

**L-01 (Low, ค้าง):** หน้าเว็บลิงก์รถร่วม (`OfferLink`, `PodLink`, `SettlementLink`, `CarrierDocsLink`) ไม่ใส่ `<meta name="robots" content="noindex">` — มีเฉพาะหน้าติดตาม (`apps/web/src/public/Tracking.tsx:52-65`) (NFR-135 [PROPOSED]) · **ข้อเสนอ:** ย้าย `usePrivacyMeta` เป็น hook กลางแล้วเรียกในทุกหน้าลิงก์ (ไม่เปลี่ยนหน้าตา) หรือให้ hosting ส่ง `X-Robots-Tag` สำหรับ `/link/*`

## 5. Magic link (หมดอายุ / จำกัด action / เพิกถอน / ไม่รั่วราคา)

**กลไก (FACT):** token `ml1.<id>.<exp>.<HMAC-SHA256>` (`src/modules/links/magic-link.service.ts`) — `resolve` (`:161`) ตรวจลายเซ็นแบบ constant-time, `exp` ใน token ต้องตรงกับแถว, หมดอายุ, `revokedAt`, action อยู่ใน `actions` ของแถว, tenant ต้อง TRIAL/ACTIVE (`:182`) → ไม่ผ่านด้วยเหตุใดตอบ **404 เดียวกัน** · AuthGuard ตรวจลิงก์ก่อน `@Public` เสมอ (`src/auth/auth.guard.ts:115-131`) · ทุก controller ลิงก์ตรวจ `purpose` + `entityType` ซ้ำ (เช่น `pod-link.controller.ts:45-49`, `subcon-offer.controller.ts:99`, `settlement-review.controller.ts:67`, `carrier-docs.controller.ts:147`, `trip-sheets.controller.ts:232`, `tracking.service.ts:198`) · ออกลิงก์ที่มี scope ราคาขายไม่ได้ (`:95`) และ `resolve` กรอง `prices.sell*` ออกอีกชั้น (`:195`) · `PriceFieldInterceptor` ตัด field ราคาขายทุกคำตอบของ principal ภายนอก (`src/common/price-fields.ts:48,61`)

| purpose (route) | หมดอายุ | จำกัด action | เพิกถอน | ไม่รั่วราคา | หลักฐาน |
|---|---|---|---|---|---|
| ทุก purpose (generic) | ✔ | ✔ | ✔ | ✔ | `magic-link.test.ts` 4 test · **`magic-link-matrix.test.ts`** (ใหม่) |
| `trip_offer` — `/public/offers/:token` (48 ชม.) | ✔ | ✔ view/respond | ✔ ออกใหม่/ยกเลิกเที่ยว/จ้างใหม่ | ✔ เห็นเฉพาะราคาซื้อของตัวเอง ไม่มีราคาขาย/ที่อยู่ลูกค้า | `subcon-offer-link.test.ts` "จ้าง → ลิงก์ 48 ชม. …", "ลิงก์: ผิด/ปลอม/หมดอายุ/purpose อื่น → 404 …", "จ้างรายใหม่ … ลิงก์ของรายเดิมถูกเพิกถอน" |
| `pod` — `/public/pod/:token` (เที่ยวจบ + 7 วัน) | ✔ | ✔ view/event/capture | ✔ | ✔ | `subcon-link-status.test.ts` "เพิกถอน: ยกเลิกเที่ยว … เที่ยวจบเกิน 7 วัน → 404", "จุดของเที่ยวอื่น / บริษัทอื่น … → 404" · `subcon-link-pod.test.ts` "เพิกถอน/หมดผล → 404 ทุก endpoint …", "… ไม่มี PIN/ราคา/ที่อยู่" |
| `settlement_review` — `/public/settlements/:token` (+ ดูอย่างเดียว D-59) | ✔ | ✔ view/respond · ดูอย่างเดียว = respond/จองรูป 404 | ✔ เรียกกลับ/ออกใหม่ | ✔ เฉพาะราคาซื้อของตัวเอง | `settlement-review.test.ts` "เกณฑ์ตรวจรับ …", "ลิงก์หมดอายุ → 404 …", "เรียกกลับ … ลิงก์เดิม 404", "D-59 … ลิงก์ดูอย่างเดียว (ตอบ/จองรูป 404)" |
| `tracking` — `/public/tracking/:token` (7 วันหลังส่ง) | ✔ | ✔ | ✔ เหตุผลบังคับ | ✔ ไม่มี field ราคา (recursive) | `tracking-link.test.ts` "เกณฑ์ตรวจรับ … ไม่มี field ราคา (recursive) · noindex/no-referrer/no-store", "เพิกถอน … / token ปลอม / หมดอายุ → 404" |
| `carrier_docs` — `/public/carrier-docs/:token` | ✔ | ✔ view/upload | ✔ เหตุผล + audit | ✔ ไม่มีราคา | `carrier-docs.test.ts` "เปิดลิงก์ … ไม่มีราคา", "ลิงก์หมดอายุ / เพิกถอน / ลายเซ็นผิด → 404", "PUT เนื้อไฟล์หลังลิงก์ถูกเพิกถอน → 404" |
| `trip_sheet` — `/public/trip-sheets/:token` (72 ชม.) | ✔ (matrix) | ✔ | ✔ ออกใหม่/ยกเลิกเที่ยว/เปลี่ยนคนขับ | ✔ ใบคุมรถไม่มีราคา (OpenAPI gate) | `trip-sheets.test.ts` "ส่งให้คนขับ … เพิกถอน/ผิด → 404", "ลิงก์คนขับ: ยกเลิกเที่ยว → เพิกถอน …" · matrix (หมดอายุ) |
| `settlement_view` | N/A — ชื่อสงวนตั้งแต่ ST1-T06 ไม่มีผู้ออก/route (ใบจ่ายเงินใช้ `settlement_review` ดูอย่างเดียว) — ออกลิงก์ไม่มี action ไม่ได้ (matrix) | | | | |
| `carrier_pay` | N/A — ยังไม่ merge ใน main (รอบสุดท้ายหลัง ST8-T12 ต้องเพิ่มใน `PURPOSE_ACTIONS` — inventory จะแดงถ้าลืม) | | | | |

**FACT (matrix ใหม่):** `magic-link-matrix.test.ts`
1. "จำกัด action …" — ลิงก์ทุก purpose × action ของทุก route ลิงก์: `resolve` ผ่าน**เฉพาะ** action ของ purpose ตัวเอง
2. "ทุก route ลิงก์: ปลอม / หมดอายุ / เพิกถอน / purpose อื่น / tenant ระงับ → 404 เดียวกัน …" — 17 route × (4 แบบ + ลิงก์ที่ยังใช้ได้ของอีก 5 purpose) → 404 `not_found` problem+json, no-store, noindex, no-referrer, ไม่บอกเหตุผล, ไม่สะท้อน id ลิงก์
3. ตัวควบคุม: ลิงก์ที่ยังใช้ได้ resolve ได้จริง
และใน inventory: "magic link: ทุก action ของ route ลิงก์เป็นของ purpose เดียว …" (static) · "ไม่รั่วราคา (OpenAPI): response ของ /v1/public/* ไม่มี field ราคาขาย · ลิงก์ผู้รับ/คนขับ/เอกสารรถไม่มีราคาซื้อด้วย" (มีตัวควบคุม: เจอ `buyAmount` ในหน้าข้อเสนองาน)

**Info:** ลิงก์งาน (`pod`) แสดงราคาซื้อของรถร่วม (scope `prices.buy:read` — ตามต้นแบบแท็บ "งาน", A3 Carrier portal "เฉพาะของตัวเอง") — ถ้ารถร่วมส่งต่อลิงก์ให้คนขับ คนขับจะเห็นค่าจ้าง (A3 Driver "ห้าม") · เป็นพฤติกรรมตามออกแบบ ไม่ใช่ defect — แจ้งไว้ให้ PO ทราบ

## 6. Secret ใน log

| ข้อ | FACT | สถานะ |
|---|---|---|
| pino redact | password/token/accessToken/refreshToken/secret/otp/mfaToken/backupCode/stepUp/apiKey/authorization/cookie/nationalId/bankAccount/taxId/credentials/config (`src/common/logger.ts:5-50`) — ใช้ใน `main.ts`/`worker.ts` | PASS |
| ไม่มี access log ของ URL | ไม่มี middleware log URL · metrics ใช้แม่แบบ route ไม่ใช่ URL จริง (`src/modules/monitoring/http-metrics.ts:94-102`) · ลิงก์ลืมรหัสผ่านใช้ `#token` (fragment ไม่ถึง server) | PASS |
| อีเมล | log เฉพาะผู้รับ (mask) + หัวเรื่อง "(body hidden)" (`src/modules/email/transport.ts:41`) · เนื้อหาที่มี token ลบจาก `email_outbox` หลังส่ง | PASS |
| integration/webhook log | ตัดค่า header เพิ่มเติมของผู้ใช้, `redactSecrets` กับข้อความ error ของ connector (`connectors.service.ts`, `inbound-webhook.service.ts:323-376`, `erp-adapter.sink.ts:229-251`) | PASS |

**M-03 (Medium, ค้าง — deploy):** **FACT** token ของลิงก์อยู่ใน **path** (`/v1/public/<purpose>/<token>`, เว็บ `/link/*`), URL ลายเซ็นไฟล์อยู่ใน query (`?sig=`), token webhook ขาเข้าอยู่ใน path (`/v1/inbound/:provider/:token`) — reverse proxy/CDN/load balancer จะเก็บลง access log ตามค่าเริ่ม (docs/04 J "ไม่เก็บ … token") · **ข้อเสนอ:** checklist deploy (ST9 go-live): ตั้ง log format ของ proxy ให้ตัด path หลัง `/v1/public/*/`, `/link/*/`, `/v1/inbound/*/` และ query `sig`/`t` ทิ้ง; retention ของ access log ≤ 30 วัน

**L-02 (Low, ค้าง):** โมดูลส่วนใหญ่ใช้ `Logger` ของ Nest (ConsoleLogger) ไม่ผ่าน pino redact · `ProblemFilter` log stack เต็มของ error ที่ไม่รู้จัก (`src/common/problem.filter.ts` สาขาสุดท้าย) — error validation ของ Prisma ใส่ค่า argument ในข้อความ (อาจมี hash/ค่าเข้ารหัส) · **ข้อเสนอ:** ให้ Nest ใช้ pino เป็น logger (`app.useLogger`) และ log เฉพาะชื่อ/รหัส error + requestId สำหรับ `PrismaClientValidationError`

**L-06 (Low, ค้าง):** CI มี CVE gate (`pnpm audit --audit-level=critical` — `scripts/ci-local.sh:41`, `.github/workflows/ci.yml:80`) แต่ยังไม่มี secret scanning (gitleaks — NFR-154 [PROPOSED]) · **ข้อเสนอ:** เพิ่ม gitleaks ใน `ci:local` (ไม่ต้องใช้เครือข่าย)

## 7. Rate limit

| ข้อ | FACT | สถานะ |
|---|---|---|
| login | ผิด 5 ครั้ง/15 นาที ต่อบัญชีและ IP → ล็อก 15 นาที ใช้ร่วมกับ 2FA/step-up (`src/auth/throttle.ts:9-10`) — `auth.test.ts`, `mfa.test.ts` | PASS |
| oauth/token | ต่อ IP ทุก grant + ต่อ client id (`auth.controller.ts:227-242`) | PASS |
| public / Console login | 120 ครั้ง/นาที ต่อ IP (`public-rate-limit.middleware.ts:17`, `app.module.ts:530,541`) · ลิงก์งาน/ใบจ่าย/เอกสารรถ มีเพดานเขียนต่อลิงก์ · ติดตามพัสดุ 5 ครั้งผิด/ชม. ต่อ IP (`tracking-rate-limit.ts`) — `rate-limit.test.ts`, `tracking-link.test.ts` "คำขอพร้อมกัน …", `subcon-link-pod.test.ts` "… rate limit 30 คำขอเขียน/นาที ต่อลิงก์ → 429" | PASS |
| API key / tenant / user | ST7-T08 ตัวจำกัดกลาง (`src/http/rate-limit/`) — `rate-limit.test.ts` | PASS |

**L-04 (Low, ค้าง):** เพดาน public 120/นาที/IP สูงกว่า NFR-1106 [PROPOSED] (60/นาที/IP + 30/นาที/token สำหรับอ่าน) — ตั้งผ่าน env `PUBLIC_RATE_LIMIT_PER_MIN` ได้ · **ข้อเสนอ:** ตั้ง 60 ใน production หรือ PO ยืนยันค่า 120
**L-07 (Info/Low, ค้าง):** `POST /v1/auth/invitations/inspect` ไม่มี rate limit (token สุ่ม 256 bit — เดาไม่ได้จริง) · **ข้อเสนอ:** ใส่ใน `PublicRateLimitMiddleware` เดียวกับ `/auth/*` ที่ไม่ล็อกตามบัญชี

## 8. สิทธิ์เทียบตาราง A3 (docs/04 A3 ↔ `packages/domain/src/permissions.ts`)

**FACT:** เทียบ 15 แถว × 8 role ภายใน (Owner, Admin, Planner, Dispatcher, Invoicer, Accounting, Approver, Viewer) = 120 ช่อง กับ `SYSTEM_ROLES` (`permissions.ts:98`) → **ไม่พบช่องที่ขัดกัน**

| แถว A3 | การแปลงในโค้ด | ผล |
|---|---|---|
| user / role / 2FA policy | `users:*` → owner, admin | ตรง |
| ตั้งค่าองค์กร / connector / API key | `settings:*` → owner, admin | ตรง |
| Master data (Planner แก้, อื่นอ่าน) | `master:write` planner; `master:read` dispatcher/invoicer/accounting/approver/viewer | ตรง |
| ราคาขาย (Planner/Viewer "เลือกได้" = ไม่ให้, Dispatcher ไม่เห็น, Approver อ่าน) | `prices.sell:*` invoicer/accounting; `:read` approver; ไม่มีใน planner/dispatcher/viewer | ตรง |
| ราคาซื้อ (Approver อ่าน, Viewer เลือกได้) | `prices.buy:read` planner/dispatcher/invoicer/accounting/approver; viewer ไม่มี | ตรง |
| Order ดู/จัด/ยกเลิก | planner `orders:read/write/cancel`; อื่น `orders:read` | ตรง |
| Trip assign/dispatch/ปิด (Planner assign) | planner `trips:assign`; dispatcher assign/dispatch/close; อื่น `trips:read` | ตรง |
| Invoice/ใบวางบิล draft/finalize (Approver อ่าน/✔) | invoicer/accounting read+draft+finalize; approver read+finalize; viewer read | ตรง |
| ใบลดหนี้/เพิ่มหนี้ ขอ/อนุมัติ (Admin ✔/ว่าง) | admin ไม่มี `credit-notes:approve`; invoicer/accounting request; approver approve | ตรง |
| Settlement สร้าง/อนุมัติ/จ่าย | dispatcher/invoicer create; accounting create/approve/pay; approver approve; viewer read | ตรง |
| Integration log / retry (Viewer อ่าน) | invoicer/accounting/approver read+retry; viewer read | ตรง |
| รายงานการเงิน (Viewer เลือกได้) | invoicer/accounting/approver | ตรง |
| รายงานปฏิบัติการ | ทุก role | ตรง |
| Export | planner/invoicer/accounting (+owner/admin) | ตรง |
| Audit log (Accounting อ่านของบัญชี) | `audit:read` owner/admin; `audit.accounting:read` accounting | ตรง |

กฎเพิ่มเติม A3: ผู้สร้างใบแจ้งหนี้ finalize ใบตัวเองไม่ได้ → `invoice_self_finalize` (`src/modules/invoices/invoice-finalize.service.ts:221`) · เปลี่ยน role ต้อง step-up → `@RequireStepUp` (`src/modules/users/users.controller.ts:125`) · Carrier portal = principal `link` แยก ไม่นับ seat ✔ · คอลัมน์ Driver (แอป P1) / Customer portal (P2) — N/A เฟส 0 (plan/01 §หมายเหตุ 11)
ส่วนที่ docs ไม่ระบุแต่โค้ดตัดสินไว้แล้ว (มีใน spec/12 §3 / plan/05 แล้ว — ไม่ใช่ mismatch): role `manager` (D-12), `prices.buy:write`, `orders:unlock`, `trips:override`, `deliveries:revert`, `invoices:void`, `payments:*` (D-57), scope ที่ API key ขอไม่ได้, ใบวางบิลไม่แบ่งผู้สร้าง/ผู้ออก (spec/12 §3 แถว ST5-T11)

**M-02 (Medium) — ปิดแล้ว (D-67, PO 22 พ.ย. 2569; branch `fix/d67-stepup-extension` — รอ merge):** step-up 2FA ขยายครบ 6 ข้อ — `X-Step-Up` กลไกเดิม (5 นาที, 403 `step_up_required`): `@RequireStepUp()` ที่ `POST /api-keys`, `/api-keys/{id}/rotate`, `POST /webhooks`, `/webhooks/{id}/rotate-secret`, `PUT /connectors/{id}/credentials`, `/connectors/{id}/inbound-token/rotate` · `@RequireHumanStepUp()` (API key ข้าม — คุมด้วย scope) ที่ `POST /invoices/{id}/void` · `assertHumanStepUp()` แบบมีเงื่อนไข: `POST /connectors` ที่มี credentials, ผู้รับเหมาเปลี่ยนบัญชีธนาคารจริง + `reveal` `bankAccountNo` + `POST /imports/{id}/commit` ของไฟล์ผู้รับเหมาที่จับคู่คอลัมน์บัญชี, `POST /billing-notes/{id}/cancel` ของใบ ISSUED, ส่งออกทั้งบริษัท (`accounting-*` / ไม่มีตัวกรอง — `GET /{master}/export`, `POST /exports`) · test `apps/api/test/step-up-d67.test.ts` · ค้าง: Platform Console ไม่มี step-up (#70 [OPEN]) · ช่องโหว่ที่รู้: ส่งออกที่ใส่ตัวกรองกว้างไม่ถาม step-up (spec/12 §3) · _บันทึกเดิม:_ **(ค้าง — [OPEN — PO] คำถามค้าง #70):** **FACT** step-up 2FA บังคับเฉพาะ: เปลี่ยน role, เชิญผู้ใช้, ออกรหัสสำรองใหม่, อนุมัติใบสำคัญจ่าย, ลดค่าความปลอดภัยในตั้งค่า (`users.controller.ts:125`, `invitations.controller.ts:112`, `mfa.controller.ts:239`, `settlements.controller.ts:550`, `settings.controller.ts:79-82`) — **ไม่มี** step-up ที่: สร้าง/หมุน API key, หมุน secret webhook, ตั้ง credential connector, แก้/ดูเลขบัญชีธนาคารรถร่วม, export ทั้งบริษัท, ยกเลิกใบแจ้งหนี้ที่ออกแล้ว (spec/11 NFR-107 [PROPOSED]; docs/04 A3 บังคับเฉพาะเปลี่ยน role) · ผลกระทบ: ผู้ที่ขโมย access token (15 นาที) ได้ สร้าง API key ถาวรไว้ใช้ต่อได้ · ต้นแบบไม่มีกล่องยืนยัน 2FA ในจุดเหล่านี้ → เป็นการตัดสินใจของ PO (ขอบเขต + UI) · **ข้อเสนอ:** อย่างน้อยสร้าง/หมุน API key และ credential connector ต้อง step-up (ใช้กล่อง step-up เดียวกับเปลี่ยน role)

## 9. รายการที่ต้องรันซ้ำในรอบสุดท้าย (หลัง ST8-T12)

1. `pnpm --filter @tms/api exec vitest run test/route-inventory.test.ts test/isolation.test.ts test/magic-link-matrix.test.ts` — คัดเลข coverage จากบรรทัด `[route-inventory]` มาแทนในตาราง §1
2. purpose ลิงก์ใหม่ (เช่น `carrier_pay`) → เพิ่มใน `LINK_PURPOSES` + `PURPOSE_ACTIONS` (`test/route-inventory.ts`) — ไม่เพิ่ม = test แดง
3. ปิด M-01/M-03 ใน config ของ hosting จริง แล้วตรวจ header ของเว็บ staging ด้วย `curl -I`
4. ~~ทบทวนคำตอบ #70 (M-02)~~ — ทำแล้ว (D-67) · เหลือ [OPEN] step-up ของ Platform Console
