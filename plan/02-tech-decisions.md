# 02 — การตัดสินใจทางเทคนิค (ADR)

> สถานะ: ร่าง 10 พ.ย. 2569 · ใช้คู่กับ `docs/01-tms-architecture-and-integration.md` (ฐานสถาปัตยกรรม) และ `spec/11-nfr.md`
> ป้าย: **[ตัดสินแล้ว]** = อยู่ใน docs v2 แล้ว ทำตามได้เลย · **[เสนอ]** = ข้อเสนอของแผนนี้ รอเจ้าของ/หัวหน้าทีมยืนยันใน ST0 · **[เปิด]** = ยังต้องเลือก (มีค่าเริ่มต้นที่แนะนำ)

## สรุปสิ่งที่ต้องเคาะใน ST0

| # | เรื่อง | ค่าที่แนะนำ | ทำไมต้องเคาะก่อน |
|---|---|---|---|
| T-03 | Frontend framework | React + TypeScript + Vite | scaffold UI shell ทำครั้งเดียว เปลี่ยนทีหลังแพง |
| T-08 | Cloud / region | ผู้ให้บริการที่มี region ไทย ถ้าต้นทุนรับได้ ไม่งั้นสิงคโปร์ + ข้อตกลงโอนข้อมูลข้ามแดน | กระทบสัญญา PDPA, ต้นทุน, latency |
| T-09 | ที่เก็บไฟล์ (POD, PDF) | Object storage แบบ S3-compatible + presigned URL | โครง `document` ใช้ทุกโมดูล |
| T-13 | แผนที่/geocoding | เลือกผู้ให้บริการที่ใช้เชิงพาณิชย์ได้ ก่อน ST3 | ต้นแบบใช้ tile ฟรีที่ห้ามใช้เชิงพาณิชย์ |
| T-15 | ชื่อ field/enum: ยึด docs v2 หรือ spec | ยึด docs v2 (ดู `00a-reconcile-architecture.md`) | freeze schema |

## ADR

### T-01 Monorepo [ตัดสินแล้ว — ทำแล้ว 10 พ.ย. 2569 (ST0)]
- โครง: `apps/api` (NestJS), `apps/web` (UI), `apps/worker` (outbox, webhook, jobs — ใช้โค้ดร่วมกับ api), `packages/contracts` (OpenAPI spec + client ที่ generate), `packages/ui` (design system), `packages/domain` (enum, state machine, ตัวคำนวณภาษี — ไม่มี I/O ทดสอบง่าย), `infra/` (IaC, docker compose)
- เครื่องมือ: pnpm workspaces + Turborepo
- ที่ทำจริงต่างจากข้อเสนอ 1 จุด: worker อยู่ใน `apps/api/src/worker.ts` (process แยก รันด้วย `pnpm --filter @tms/api dev:worker`) แทน `apps/worker` เพราะใช้โมดูล Nest ชุดเดียวกันทั้งหมด — แยกเป็น app เมื่อ deploy ต่างกันจริง
- เหตุผล: UI ใช้ client ที่ generate จาก OpenAPI ของ api โดยตรง (หลัก API-first ของ docs/01 §1 ข้อ 2) และ Claude Code ทำงานข้าม api ↔ web ใน PR เดียวได้

### T-02 Backend [ตัดสินแล้ว — docs/01 §1–2]
- NestJS + Prisma + PostgreSQL; shared schema, ทุกตารางมี `tenant_id`, Prisma client extension ใส่ `tenant_id` อัตโนมัติ, RLS เป็นชั้นที่สอง, unique key ขึ้นต้นด้วย `tenant_id`, cross-tenant ตอบ 404
- OpenAPI 3.1 generate จากโค้ด และ CI ตรวจ breaking change
- เพิ่ม [เสนอ]: โมดูล NestJS ต่อ bounded context (platform, master, orders, planning, execution, billing, settlement, fleet, integration, reports); ห้าม import ข้ามโมดูลยกเว้นผ่าน service ที่ export

### T-03 Frontend [ตัดสินแล้ว 10 พ.ย. 2569 — React + TypeScript + Vite (D-15)]
| ตัวเลือก | ข้อดี | ข้อเสีย |
|---|---|---|
| **React + TypeScript + Vite (SPA)** + TanStack Query/Table + React Hook Form + zod | ecosystem ใหญ่สุด, ตาราง/ลากวาง/timeline มีไลบรารีพร้อม, AI coding agent ทำงานได้ดี, ใช้ type ร่วมกับ backend ง่าย | ต้องกำหนดแบบแผนเอง (routing, state) |
| Angular | แบบแผนครบในตัว, เหมาะฟอร์มองค์กร | ไลบรารี planning board/timeline น้อยกว่า; ถ้าทีมไม่ถนัดจะช้า |
- เกณฑ์ตัดสิน: ถ้าทีม Innovera มีระบบเดิมและคนที่ถนัด Angular อยู่แล้ว → Angular; ถ้าไม่มีข้อผูกมัด → React
- ไม่ใช้ SSR ในแอปหลัก (เป็นแอปหลัง login); หน้า landing/ราคา แยกเป็น static site ภายหลัง

### T-04 Auth [ตัดสินแล้ว — docs/04 A, G]
- UI: Authorization Code + PKCE (เซิร์ฟเวอร์ auth อยู่ใน NestJS เอง); JWT access 15 นาที + refresh 7 วัน (httpOnly); `tokenVersion` ต่อ user; argon2id; 2FA TOTP
- API: OAuth2 client credentials → JWT RS256 1 ชม. scope `resource:verb`; static key `tk_live_` / `tk_test_`
- Magic link เซ็น HMAC + หมดอายุ สำหรับรถร่วม/ผู้รับ
- [เปิด] ชื่อ prefix ของ key: docs ใช้ `tk_`, ดีไซน์รอบ 11 ใช้ `tms_` — ยึด docs (`tk_`) จนกว่าจะตั้งชื่อผลิตภัณฑ์
- [ทำแล้ว ST1-T01/T04, 10 พ.ย.] login อีเมล+รหัสผ่าน → `POST /v1/auth/login` (คืน authorization code ผูก PKCE S256) → `POST /v1/oauth/token` (`authorization_code` / `refresh_token`) → `POST /v1/oauth/revoke`; refresh หมุนทุกครั้ง ใช้ซ้ำ = เพิกถอนทั้ง family; cookie `tms_rt` httpOnly SameSite=Strict path `/v1/oauth`; access token เก็บในหน่วยความจำของ UI
- [ทำแล้ว] claim: `sub`, `tid`, `scope`, `pt` (`user`|`dev` — production ปฏิเสธ `dev`), `tv` (tokenVersion; guard ตรวจกับฐานข้อมูลทุก request ของ `pt=user`)
- [ตัดสินระหว่างทำ — ให้ PO/tech lead ทบทวน] เซ็น access token แบบ **HS256** ด้วย `AUTH_JWT_SECRET` ไปก่อน (มีผู้ตรวจ token แค่ API เอง) — เปลี่ยนเป็น RS256 + JWKS ใน ST7-T01 เมื่อมี client ภายนอก/ตัวตรวจอื่น
- [ตัดสินระหว่างทำ] ตาราง `login_attempt`, `auth_code`, `refresh_token` เป็นตาราง platform (ใช้ก่อนรู้ tenant): `tms_app` ไม่มีสิทธิ์, เปิด RLS ซ้อนไว้ตามกติกา; ล็อกนับ 5 ครั้งผิด/15 นาที **แยกต่อบัญชีและต่อ IP** ตามตัวอักษรของ docs/04 A1 — ⚠ ออฟฟิศที่ใช้ IP เดียวกัน (NAT) อาจโดนล็อกพร้อมกัน ถ้าเกิดจริงให้ปรับเพดานต่อ IP (ค่าคงที่ใน `auth.service.ts`)
- [ทำแล้ว ST1-T12, 10 พ.ย.] สิทธิ์ของผู้ใช้ใช้รูปแบบ scope `resource:verb` เดียวกับ API key/OAuth (แปลง `{module}.{view|manage}` ของ docs/04 เป็น `:read`/`:write` + verb ของแถวที่แยกการกระทำ เช่น `invoices:finalize`); สิทธิ์ราคาเป็น `prices.sell:*`/`prices.buy:read`; token ของผู้ใช้ = union ของ role ไม่มี `*`; ตารางอยู่ที่ `packages/domain/src/permissions.ts` ที่เดียว
- [เสนอ] ทำ auth เองใน NestJS (ไม่ใช้ IdP ภายนอกในเฟส 0) แต่แยกเป็นโมดูลที่เปลี่ยนเป็น IdP ได้ (SSO เป็น P1)

### T-05 Multi-tenant และ RLS [ตัดสินแล้ว + รายละเอียดที่เสนอ]
- ทุก request: guard ตั้ง `SET LOCAL app.tenant_id` ใน transaction; role ของแอปไม่มี BYPASSRLS; งาน platform ใช้ role แยก
- [เสนอ] ทุกตารางใหม่ต้องมี (1) policy RLS (2) test แยกข้อมูลอัตโนมัติ — CI fail ถ้ามีตารางที่มี `tenant_id` แต่ไม่มี policy

### T-06 งานเบื้องหลังและ outbox [ตัดสินแล้ว — docs/01 §2, §6.2]
- `integration_outbox` เขียนใน transaction เดียวกับการเปลี่ยนสถานะ; worker หยิบด้วย `FOR UPDATE SKIP LOCKED`
- [ตัดสินแล้ว — ทำแล้วใน ST0-T11] เฟส 0 ใช้ PostgreSQL เป็นคิว (ตาราง `job` + `FOR UPDATE SKIP LOCKED` + round-robin ต่อ tenant) ไม่มี Redis/BullMQ — `apps/api/src/jobs/job-queue.service.ts`

### T-07 เลขเอกสาร [ตัดสินแล้ว — docs/01 §3.5]
- ออกเลขตอน finalize ด้วย row lock ใน transaction เดียวกัน; draft ไม่มีเลข; ไม่มี hard delete

### T-08 Cloud / region [เปิด]
- ตัวเลือก: (A) cloud ที่มี region ไทย (B) สิงคโปร์
- ค่าแนะนำ: A ถ้าบริการที่ต้องใช้ครบ (managed PostgreSQL, object storage, KMS); ไม่งั้น B พร้อมข้อความในนโยบายความเป็นส่วนตัวเรื่องโอนข้อมูลข้ามแดน (ถามทนาย — `07-questions-legal-pdpa.md`)
- [เสนอ] deploy ด้วย container บนบริการ managed (ไม่ตั้ง Kubernetes เองในเฟส 0); IaC ตั้งแต่วันแรก

### T-09 ไฟล์และ PDF [เสนอ]
- Object storage + presigned upload/download; ตาราง `document` กลาง (docs/01 ใช้ `*_document_id`)
- PDF: render จาก HTML template ด้วย headless Chromium ใน worker; ฟอนต์ Sarabun ฝังในไฟล์; **render ครั้งเดียวตอน ISSUED แล้วเก็บเป็นไฟล์ immutable** [ตัดสินแล้ว — docs/01 §1]
- รูป POD: ย่อฝั่ง client ก่อนอัปโหลด; เก็บต้นฉบับ + thumbnail

### T-10 ตัวคำนวณภาษีและราคา [เสนอ]
- อยู่ใน `packages/domain` เป็นฟังก์ชันล้วน (ไม่มี I/O): pricing จาก rate card, แยกฐานยกเว้น/7%, VAT, WHT ต่อบรรทัด, ปัดเศษ
- มี golden test จากตัวอย่างที่นักบัญชีเซ็นรับ (ดู `03-test-plan.md` §4) — ห้าม merge ถ้า golden test แดง

### T-11 i18n [ตัดสินแล้ว 10 พ.ย. 2569 — ไทย + โครง i18n (D-11)]
- ทำแล้ว: catalog `apps/web/src/i18n/th.ts` (ไทย = ต้นแบบ), EN/中文 generate จากพจนานุกรม `design/prototype/i18n.js` (`pnpm --filter @tms/web i18n:build`), key ที่ไม่มีคำแปล → แสดงไทย; lint ห้ามข้อความไทย hard-code และห้าม key ที่ไม่มีใน th
- docs/04 วางไทยเป็น P0 อังกฤษ P1; งานดีไซน์ทำ 3 ภาษา (TH/EN/中文) — แผนนี้เสนอ: เฟส 0 ส่งมอบภาษาไทย แต่วางโครง i18n ให้เพิ่มภาษาได้โดยไม่แก้โค้ด
- ไทยเป็นหลัก; ทุกข้อความผ่าน key; วันที่ พ.ศ. ในโหมดไทย; เอกสารภาษีมีไทยเสมอ
- [เสนอ] ข้อความ error จาก API ส่ง `code` คงที่ + ข้อความไทย/อังกฤษ; UI แปลจาก `code`

### T-12 การทดสอบและ CI [เสนอ]
- ทุก PR: lint, type-check, unit, integration (PostgreSQL จริงใน container), tenant-isolation suite, OpenAPI diff, build
- E2E (Playwright) รันเส้นทางหลักทุกคืนและก่อน release
- รายละเอียดใน `03-test-plan.md`

### T-13 แผนที่ / geocoding / ระยะทาง [เปิด]
- ต้องใช้: geocode ที่อยู่ไทย, ระยะทาง/เวลาระหว่างจุด (ใช้กับ rate card ตามระยะทาง), แผนที่แสดงผล
- ค่าแนะนำ: ทำ interface `MapProvider` แล้วเลือกผู้ให้บริการ 1 รายที่มีข้อมูลไทยดีและเงื่อนไขเชิงพาณิชย์ชัด; เฟส 0 ใช้แค่ geocode + ระยะทาง (หน้าติดตามรถบนแผนที่เป็น P1 ตาม docs/04 E)
- [เพิ่ม 10 พ.ย.] ถ้าจะทำโหมด 3 มิติ (T-18) ในเฟสหลัง ผู้ให้บริการที่เลือกควรมีครบ 4 อย่างในเจ้าเดียวหรือเข้ากันได้: (1) **vector tile** สไตล์ MapLibre (ต้องมีถึงจะมีอาคาร 3 มิติและภาพคมตอนเอียงกล้อง — raster tile ที่ต้นแบบใช้ทำไม่ได้) (2) **routing API** ที่คืน geometry ตามถนน (3) **map matching** สำหรับปรับจุด GPS ให้ติดถนนตอนย้อนดู (4) เงื่อนไขเชิงพาณิชย์ที่อนุญาตเก็บ geometry ที่คืนมา (บางรายห้าม cache เกิน 30 วัน) — เลือกครั้งเดียวใน D-31 ไม่ต้องย้ายทีหลัง

### T-14 ข้อความ SMS / LINE / อีเมล [เปิด]
- เฟส 0 ต้องส่งลิงก์ให้รถร่วม (LINE/SMS) และอีเมลเชิญผู้ใช้
- ค่าแนะนำ: interface `Notifier`; อีเมลผ่านผู้ให้บริการ transactional; SMS ผ่าน gateway ไทย 1 ราย; LINE เริ่มจาก "คัดลอกลิงก์/แชร์ไป LINE" (ไม่ต้องมี LINE OA) แล้วค่อยทำ LINE OA เป็น P1

### T-15 แบบแผนชื่อ [ตัดสินแล้ว — ทำตามค่าแนะนำใน ST0]
- docs/01: ตาราง/คอลัมน์ `snake_case`, สถานะตัวพิมพ์ใหญ่ (`ISSUED`); API ส่ง lowercase (`status: issued`)
- spec/10: ชื่อ entity แบบ PascalCase, field camelCase, enum lowercase
- ค่าแนะนำ: DB = snake_case ตาม docs; Prisma model = PascalCase map ไปตาราง snake_case; API JSON = camelCase + enum lowercase (ตาม docs/04 G "K19 ไม่ใช้ PascalCase"); รายการที่ต่างกันจริงดู `00a-reconcile-architecture.md`

### T-16 แอปคนขับ [เลื่อน — ไม่อยู่ในเฟส 0]
- docs/02 §6: Flutter หรือ React Native เลือกก่อนเริ่มเฟสขาย 2; เฟส 0 ใช้หน้าเว็บผ่านลิงก์ (M10) เท่านั้น
- สิ่งที่เฟส 0 ต้องทำเผื่อ: stop event แบบ idempotent (`clientEventId`, `occurredAt`/`receivedAt`) และ endpoint กลุ่ม `/driver/*` ตาม docs/01 §5.5 ออกแบบไว้แต่ยังไม่ต้อง implement ครบ

### T-17 สิ่งที่ตั้งใจไม่ใส่ในเฟส 0 [ตัดสินแล้ว — docs/04 K + แผนนี้]
- DB-per-tenant, build แยกลูกค้า, VRP ของตัวเอง, XML e-Tax เอง, GL/ผังบัญชี, Kubernetes ที่ดูแลเอง, microservices, Redis (จนกว่าจำเป็น), AI/MCP, custom fields, self-signup + payment gateway, หน้าติดตามรถบนแผนที่ (2 มิติและ 3 มิติ — ดู T-18)

### T-18 หน้าติดตามรถโหมด 3 มิติ [เสนอ — นอกเฟส 0; เฟส 0 เผื่อข้อมูลไว้เท่านั้น]

ที่มา: ต้นแบบรอบ 19 (`research/design-briefs.md`) ทำหน้า "ติดตามรถ" เป็นแผนที่เอียง + รถบรรทุก 3 มิติ ตามแนวคิด digital twin ของ BC WareHouse (ใช้เป็นแนวคิดเท่านั้น repo ไม่มี license) · ผลตรวจต้นแบบ: ใช้งานได้ แต่รถเล็กเกิน, เส้นทางเป็นเส้นตรงไม่ตามถนน, แถบล่างล้นจอ, ป้ายซ้อนกันที่ซูมระดับประเทศ — 4 ข้อนี้เป็นข้อจำกัดของ "ข้อมูล" และ "tile" ไม่ใช่แค่หน้าตา จึงต้องตัดสินในชั้นเทคนิค

**ข้อเท็จจริงที่กำหนดแนวทาง**
1. โหมด 3 มิติเป็น **ชั้นแสดงผล** ของข้อมูลชุดเดียวกับหน้า 2 มิติ (`vehicle_position`, เที่ยว, stop, เส้นทางแผน) — ถ้าข้อมูลไม่มี 3 มิติก็สวยไม่ได้ (ต้นแบบต้องจำลองทุกอย่าง)
2. ของที่ทำให้ "ว้าว" ในตัวอย่างโกดัง (วัตถุใหญ่ อยู่ในพื้นที่ปิดไม่กี่ร้อยเมตร) ไม่มีในงานขนส่งระดับประเทศ: รถยาว 12 ม. บนแผนที่ 800 กม. เป็นจุดเดียว จึงต้องใช้ **ขนาดรถตามระดับซูม** (ขยายเกินจริงเมื่อซูมออก ขนาดจริงเมื่อซูมเข้า) และ **รวมกลุ่มป้าย/รถ** เมื่อซูมออก
3. เส้นทางตามถนน ต้องมาจาก routing API ตอนวางแผน (เก็บ geometry ลงเที่ยว) และ map matching ตอนย้อนดู — ไม่ใช่จาก frontend
4. ประวัติ GPS ต้องเก็บจริง (`vehicle_position` append-only, 90 วันตาม docs/04 J) ไม่งั้นย้อนดูเส้นทางไม่ได้
5. raster tile ไม่มีอาคาร 3 มิติและเบลอตอนเอียง — ต้อง vector tile (เงื่อนไขใน T-13)

**ทางเลือกเทคนิคฝั่ง web**
| ทางเลือก | ข้อดี | ข้อเสีย | แนะนำ |
|---|---|---|---|
| A. MapLibre GL JS + custom layer three.js (glTF low-poly 3 แบบ: 6 ล้อ / 10 ล้อ / หัวลาก+หาง) | ควบคุมโมเดลได้เต็มที่, อาคาร 3 มิติจาก vector tile ได้ฟรี, ชุมชนใหญ่, ต้นแบบใช้แนวนี้อยู่แล้ว | ต้องเขียน sync กล้อง/projection เอง, สองไลบรารีใน bundle (~600 KB gzip) | **ใช่** |
| B. deck.gl (ScenegraphLayer) บน MapLibre | จัดการ instancing/คัดกรองวัตถุนับพันให้, API ประกาศเป็น layer | หนักกว่า, ปรับแต่งโมเดลและ label ยากกว่า | สำรองถ้ารถ > 2,000 คันพร้อมกัน |
| C. fill-extrusion ของ MapLibre ล้วน (กล่องแทนรถ) | เบาสุด ไม่มี three.js | ดูเป็นกล่อง ไม่ "ว้าว" | ใช้เป็น fallback เครื่องช้า |

**การตัดสินใจที่เสนอ**
- โครงสร้าง: `apps/web` แยก route-level chunk `tracking-3d` โหลดเมื่อเปิดหน้า; โหมด 2 มิติเป็นค่าเริ่มต้นบนมือถือ/เครื่องไม่มี WebGL2; สลับโหมดจำต่อผู้ใช้
- โมเดลรถ: glTF 3 ชิ้น ≤ 50 KB/ชิ้น ทำเอง (ห้ามใช้โมเดลที่ไม่มี license เชิงพาณิชย์); สีตามสถานะผ่าน material ไม่ใช่โมเดลแยก; ขนาด = `max(จริง, 1.2 × พิกเซลที่ต้องการ ÷ มาตราส่วนซูม)`
- ป้าย: ใช้ symbol layer ของ MapLibre (ชน-ซ่อนอัตโนมัติ) + cluster รถที่ซูม < 10 แทน DOM label ที่ต้นแบบใช้
- เส้นทาง: เที่ยวเก็บ `planned_route` (GeoJSON LineString จาก routing API ตอน dispatch, คำนวณใหม่เมื่อ stop เปลี่ยน); เส้นวิ่งจริง = `vehicle_position` ผ่าน map matching เป็นชุด ๆ ทุก 5 นาทีใน worker ไม่ทำบน client
- สตรีม: SSE ต่อ tenant (`GET /v1/tracking/stream`) ส่ง diff ตำแหน่ง ≤ 1 ครั้ง/10 วิ/รถ (ตรงกับ spec EXE-012); client interpolate ระหว่างจุด (ตรงนี้คือ "รถวิ่ง" ของต้นแบบ)
- layout: แผนที่ใช้ความสูง `100dvh − header` และแถบล่างอยู่ในพื้นที่แผนที่ (แก้ข้อแถบล้นจอ); banner ทดลองใช้ซ้อนทับไม่ดันความสูง
- งบประสิทธิภาพ: ≤ 30 fps cap, pixel ratio ≤ 2, หยุด render เมื่อแท็บซ่อน, bundle ของหน้านี้ ≤ 1 MB gzip รวมโมเดล, รองรับรถพร้อมกัน 500 คันที่ 30 fps บนโน้ตบุ๊กกลาง ๆ
- ทดสอบ: Playwright + WebGL ใน Chromium headless (screenshot เปรียบเทียบที่ 3 ระดับซูม), unit test ตัวคำนวณขนาด/interpolation ใน `packages/domain`

**สิ่งที่เฟส 0 ต้องทำเผื่อ (เพิ่มเข้า ST3/ST4 ต้นทุน ≈ 1–2 วัน ไม่เพิ่ม task ใหม่)**
- `trip.planned_route` (jsonb, nullable) + `trip.planned_distance_m` — ST3-T11 (ตอน dispatch เรียก `MapProvider.route()` ถ้ามี provider; ไม่มีก็ null)
- ตาราง `vehicle_position` ตาม spec/04 §1 ข้อ 4 สร้าง schema + RLS + retention 90 วัน (ST9-T14 มีแล้ว) แต่ **ยังไม่มีตัวป้อน** จนกว่าจะมีแอปคนขับ/GPS connector
- `stop_event` มีพิกัด + accuracy อยู่แล้ว (ST4-T01) — ใช้เป็นจุดวิ่งจริงหยาบ ๆ ได้ในหน้า 2 มิติเฟสแรก
- ห้ามเริ่มเขียนโค้ดหน้า 3 มิติในเฟส 0 แม้มีเวลาเหลือ — เข้าคิว "ผู้สมัครเพิ่ม" ข้อ 22 ใน `plan/01` §5

**ขนาดหยาบ (เมื่อทำจริง):** หน้า 2 มิติ + สตรีม + ETA/ธงผิดปกติ ≈ 2 L (ผู้สมัคร #10) → โหมด 3 มิติเพิ่ม ≈ 3–4 L (โมเดล, custom layer, cluster, ย้อนดู, ทดสอบหลายเครื่อง) + งาน routing/map matching ใน worker ≈ 1 L — รวม ≈ 6–7 L ไม่นับ GPS connector

### T-19 รุ่นของ dependency และการอัปเกรด [ตัดสินแล้ว 10 พ.ย. 2569]
- ใช้ major ที่ทีมคุ้นและปิดช่องโหว่ critical/high ได้: NestJS 11 (Express 5), @nestjs/swagger 11, Prisma 6.19, React 18.3, Vite 6.4, Vitest 4.1, TypeScript 5.x, Node 20
- รุ่นล่าสุด ณ วันนี้สูงกว่า (Nest 12, Prisma 7, React 19, Vite 8, TypeScript 7) — อัปเกรดเป็นงานแยกทีละตัวหลังจบ ST1 (Prisma 7 เปลี่ยนวิธีต่อฐานข้อมูล ต้องทดสอบ RLS ใหม่ทั้งชุด)
- override ชั่วคราว: `deepmerge-ts ^8` (ช่องโหว่ใน CLI ของ Prisma 6) — ถอดเมื่อขึ้น Prisma 7
- CI มี `pnpm audit --audit-level=critical`; ช่องโหว่ high ต้องมี issue + วันแก้

### T-20 จุดที่ต่างจาก docs/01 §5.1 โดยรู้ตัว [บันทึก 10 พ.ย. 2569]
- OpenAPI ที่ generate เป็น **3.0** (ข้อจำกัดของ @nestjs/swagger 11) ไม่ใช่ 3.1 ตาม docs — ใช้งานได้กับ generator/diff ทุกตัว; แปลงเป็น 3.1 เมื่อเปิด Open API สาธารณะ (เฟสขาย 2, D-05)
- ID ใน API = `<prefix>_<uuid 32 hex>` (เช่น `cmp_…`) — ยาวกว่าตัวอย่างใน docs แต่ opaque ตามข้อกำหนด
- ตาราง `idempotency_key` คืน 409 `idempotency_in_progress` เมื่อคำขอเดิมยังทำงาน (docs ไม่ระบุกรณีนี้)

### T-21 เลขเอกสาร [ทำแล้ว ST1-T15, 10 พ.ย. 2569 — ให้ทบทวน]
- ค่า prefix/รีเซ็ตตั้งต่อประเภทเอกสาร (`document_series`, ตรงกับตารางในต้นแบบ) · ตัวนับจริงต่อ (ประเภท × สาขา × งวด) ใน `document_sequence`; เอกสารที่ไม่ใช่ภาษีนับรวมทั้ง tenant (`branch_id` null)
- เอกสารภาษี (INV, TXINV, RCP, CN, DN, WHT) นับแยกต่อสาขาผู้ออก และ prefix ต้องมี `{BR}` กันเลขซ้ำข้ามสาขา — ค่าเริ่มต้น `INV-{BR}-` + `{YY}{MM}-` + 4 หลัก (รอคำตอบนักบัญชีข้อ 4 ถ้าต้องการชุดเดียวทั้งบริษัท)
- ออกเลขด้วย `INSERT … ON CONFLICT DO NOTHING` + `UPDATE … RETURNING` ใน transaction ของผู้เรียก (ล็อกแถวจนจบ transaction); งวดคิดตามเวลาไทย; ปีตาม `tenant.year_style`
