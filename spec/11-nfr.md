# 11 — ข้อกำหนดที่ไม่ใช่ฟังก์ชัน (NFR)

> ⚠️ **ลำดับความสำคัญ (10 พ.ย. 2569):** ไฟล์นี้เขียนโดยไม่ได้อ่าน `docs/` (v2) เมื่อเนื้อหาขัดกับ `docs/` ให้ยึด `docs/` — ดู `plan/00-source-of-truth.md` และรายการจุดที่ขัดกันใน `plan/00a-reconcile-architecture.md`, `plan/00b-reconcile-requirements.md` · ป้าย P0/P1/P2 ในไฟล์นี้เป็นมาตราส่วนของ spec ไม่ใช่ "เฟส 0" ของแผนพัฒนา

> สถานะ: ร่าง v0.1 · 9 พ.ย. 2569
> ขอบเขต: ความปลอดภัย, การแยก tenant, PDPA, audit, 3 ภาษา, accessibility, ประสิทธิภาพ, มือถือ/เบราว์เซอร์, ความพร้อมใช้งาน, backup, observability, rate limit, การเก็บ/ลบข้อมูล, ไฟล์, environment, การทดสอบ
> แหล่ง: `research/decisions.md`, `research/thai-tax-docs-research.md` §5, `research/tms-api-benchmark.md` §9, `research/ai-mcp-plan.md` §3, `research/design-briefs.md` รอบ 5, 11, 13, 14, `10-data-model.md`
> ตัวเลขที่ติด [PROPOSED] เป็นข้อเสนอ ต้องยืนยันก่อนใช้เป็นเกณฑ์ตรวจรับ; รหัส `NFR-nnn` ใช้อ้างอิงใน test case

---

## 1. สรุปเป้าหมายหลัก

| เรื่อง | เป้าหมาย | ป้าย |
|---|---|---|
| ความปลอดภัยแอป | OWASP ASVS 4.0.3 **Level 2** ทุก endpoint; pentest ภายนอกก่อนเปิดขาย (P1) และทุก 12 เดือน | [PROPOSED] |
| การแยก tenant | ไม่มีการรั่วข้าม tenant แม้ 1 แถว — test อัตโนมัติครอบ 100% ของตาราง tenant และ endpoint ที่รับ id | [DECISION] |
| ความพร้อมใช้งาน | 99.5% ต่อเดือน (Starter/Growth), 99.9% (Business/Enterprise) | [PROPOSED] |
| RPO / RTO | ≤ 15 นาที / ≤ 4 ชั่วโมง | [PROPOSED] |
| API list p95 | ≤ 300 ms (หน้า ≤ 50 แถว) | [PROPOSED] |
| กระดานวางแผน 200 คัน × 7 วัน | โหลดครั้งแรก ≤ 2 วินาที p95 | [PROPOSED] |
| แอปคนขับออฟไลน์ | ทำงานต่อได้ ≥ 72 ชั่วโมง ไม่สูญข้อมูล | [PROPOSED] |
| Accessibility | WCAG 2.1 AA | [DECISION] |
| ภาษา | TH / EN / 中文 ครบทุกหน้า (เอกสารภาษีเป็นไทยหรือไทย+อังกฤษ) | [DECISION] |
| เอกสารภาษี | เก็บ ≥ 5 ปี ห้ามแก้หลังออก | [FACT] ม.87/3, 105 ทวิ |

---

## 2. ความปลอดภัย

### 2.1 การยืนยันตัวตน (authentication)

| รหัส | ข้อกำหนด | ป้าย |
|---|---|---|
| NFR-101 | รหัสผ่าน: ยาว ≥ 10 ตัวอักษร (สูงสุด 128), ไม่บังคับผสมชนิดตัวอักษร, ห้ามรหัสที่อยู่ในรายการรั่ว (ตรวจแบบ k-anonymity กับ HIBP หรือรายการ top 100k ในเครื่อง), ห้ามมีอีเมล/เบอร์/ชื่อบริษัท; ไม่บังคับเปลี่ยนตามรอบเวลา | [PROPOSED] ตาม NIST 800-63B |
| NFR-102 | เก็บรหัสผ่านด้วย argon2id (memory ≥ 19 MiB, iterations ≥ 2, parallelism 1) — ปรับให้ใช้เวลา ~250 ms บนเครื่อง production | [PROPOSED] |
| NFR-103 | ล็อกอินผิด: ครั้งที่ 3 ขึ้นแสดง CAPTCHA; ผิด 5 ครั้งใน 15 นาที → ล็อกบัญชี 15 นาที (แจ้งอีเมล/SMS เจ้าของบัญชี); ข้อความ error ไม่บอกว่าอีเมลมีอยู่จริงหรือไม่ | [PROPOSED] |
| NFR-104 | OTP (สมัคร, ล็อกอินคนขับ, ผูกเครื่องใหม่, รีเซ็ตรหัส): 6 หลัก สุ่มด้วย CSPRNG, หมดอายุ 5 นาที, ใส่ผิดได้ 5 ครั้งต่อรหัส, ขอใหม่ได้หลัง 60 วินาที (ตามต้นแบบ), จำกัด 5 ครั้ง/ชั่วโมง และ 10 ครั้ง/วัน ต่อเบอร์ และ 20 ครั้ง/ชั่วโมง ต่อ IP; เก็บเฉพาะ hash | [PROPOSED] |
| NFR-105 | Google sign-in: OpenID Connect + PKCE, รับเฉพาะ `email_verified=true`; ถ้าอีเมลตรงกับบัญชีรหัสผ่านเดิม ต้องยืนยันรหัสผ่าน/OTP ก่อนผูก (กันยึดบัญชี) | [PROPOSED] |
| NFR-106 | 2FA: TOTP (RFC 6238) + recovery code 10 ชุด; **บังคับ** สำหรับ PlatformUser ทุกคน; tenant admin เปิด "บังคับ 2FA ทุกคนในบริษัท" ได้ (ยกเว้น role driver); แนะนำแรงสำหรับ owner | [PROPOSED] |
| NFR-107 | Step-up (ยืนยันรหัส/2FA ซ้ำภายใน 5 นาทีล่าสุด) ก่อน: สร้าง/หมุน API key, แก้ webhook secret, ตั้งค่า connector credential, แก้บัญชีธนาคาร, เปลี่ยน role ผู้ใช้, export ข้อมูลทั้งบริษัท, ยกเลิกเอกสารภาษี | [PROPOSED] |
| NFR-108 | Token เว็บ: access token JWT (ES256) อายุ 15 นาที มี claim `sub, tenantId, membershipId, tokenVersion, scopes`; refresh token แบบ opaque เก็บใน cookie `HttpOnly; Secure; SameSite=Lax; Path=/auth` หมุนทุกครั้งที่ใช้ (reuse → revoke ทั้ง family); idle timeout 12 ชั่วโมง, absolute 30 วัน | [PROPOSED] |
| NFR-109 | ถอนสิทธิ์/เปลี่ยนรหัส/ลบสมาชิก → เพิ่ม `tokenVersion`; guard ตรวจกับ cache (TTL ≤ 60 วินาที) → ผู้ใช้ถูกเตะออกภายใน 60 วินาที | [PROPOSED] |
| NFR-110 | หน้า "อุปกรณ์และการเข้าใช้งาน" ให้ผู้ใช้เห็นและเพิกถอน session ของตัวเอง; admin เพิกถอน session ของสมาชิกได้ | [PROPOSED] |
| NFR-111 | ผู้ใช้หลายบริษัท: สลับบริษัท = ออก access token ใหม่ที่ `tenantId` ใหม่ (ไม่ใช้ token เดิมข้ามบริษัท) | [DECISION] |

**Device binding ของแอปคนขับ**

| รหัส | ข้อกำหนด | ป้าย |
|---|---|---|
| NFR-121 | บัญชีคนขับ 1 คน active ได้ **1 เครื่อง** (`UserDevice`); login เครื่องใหม่ต้องผ่าน OTP ไปเบอร์คนขับ และแจ้งฝ่ายจัดรถ | [PROPOSED] |
| NFR-122 | เครื่องเดิมเปลี่ยนเป็น `replaced`: token ใช้ได้เฉพาะ endpoint อัปโหลดคิวค้าง (`/sync/upload`) อีก 72 ชั่วโมง เพื่อไม่ให้ POD ที่ยังไม่ส่งหาย จากนั้น revoke | [PROPOSED] |
| NFR-123 | Refresh token ของแอปอายุ 90 วันแบบ sliding เก็บใน Keychain/Keystore; access token หมดอายุระหว่างออฟไลน์ไม่ทำให้บันทึกงานไม่ได้ — คิวรอส่งจนกว่าจะต่อเน็ตและ refresh สำเร็จ | [PROPOSED] |
| NFR-124 | session หมดอายุจริง (เกิน 90 วัน/ถูก revoke) → แสดงจอ "session หมดอายุ" ให้ OTP ใหม่ โดย **ไม่ลบคิวค้าง** ในเครื่อง | [DECISION] รอบ 5 |
| NFR-125 | ฐานข้อมูลในเครื่อง (SQLite/Realm) เข้ารหัส (SQLCipher หรือเทียบเท่า) key อยู่ใน secure enclave/keystore; ตรวจ root/jailbreak แล้วแสดงคำเตือน (ไม่บล็อก) | [PROPOSED] |

### 2.2 การกำหนดสิทธิ์ (authorization)

| รหัส | ข้อกำหนด |
|---|---|
| NFR-131 | ลำดับการตรวจทุก request: authn → ตั้ง tenant context (`SET LOCAL app.tenant_id`) → สถานะ tenant (read_only/suspended อนุญาตเฉพาะอ่าน, export, ชำระเงิน) → entitlement แพ็กเกจ → permission ของ role (`module.action`) → branch scope → field permission (ซ่อนราคา) → RLS ในฐานข้อมูล |
| NFR-132 | Deny by default: endpoint ที่ไม่มี decorator permission ต้อง build ไม่ผ่าน (lint rule ใน CI) |
| NFR-133 | ทุก id จาก tenant อื่น/ไม่มีสิทธิ์ ตอบ **404** (ไม่ใช่ 403) เพื่อไม่ยืนยันว่ามีอยู่ (api-benchmark §9.5) |
| NFR-134 | Field permission บังคับที่ serializer ฝั่ง server (ไม่พึ่ง UI ซ่อน) — รถร่วมต้องไม่เห็นราคาขาย, dispatcher ตั้งได้ว่าไม่เห็นราคาขาย |
| NFR-135 | ลิงก์ไม่ต้อง login (`AccessLink`): token สุ่ม 256 bit, เก็บ hash, อายุตาม purpose (ใบเสนองาน 48 ชม., อัปโหลด POD 7 วัน, ติดตามผู้รับ 7 วันหลังส่งสำเร็จ, ใบจ่ายเงินรถร่วม 30 วัน + OTP), เข้าถึงได้เฉพาะ subject ของลิงก์, หน้าใส่ `noindex` และ `Referrer-Policy: no-referrer` [PROPOSED] |
| NFR-136 | การใช้งานแทน (impersonate): เฉพาะ PlatformUser role owner/support, บังคับเหตุผล, อายุ session 60 นาที, แถบเตือนตลอดเวลา, ห้ามทำ step-up action (NFR-107) ระหว่าง impersonate, แจ้ง owner ของ tenant ทางอีเมลภายใน 24 ชม. [PROPOSED] |

### 2.3 API key, OAuth (MCP) และ webhook

| รหัส | ข้อกำหนด | ป้าย |
|---|---|---|
| NFR-141 | API key: secret สุ่ม 32 bytes (base62) รูปแบบ `tk_live_<prefix>_<secret>`; DB เก็บ `HMAC-SHA256(pepper, secret)` + prefix; เทียบแบบ constant-time; แสดง secret ครั้งเดียว | [DECISION] รอบ 11 |
| NFR-142 | Key มี scope (`resource:verb`), IP allowlist (ไม่บังคับ), วันหมดอายุ (30/90/365/ไม่หมด), rotate โดย key เก่าใช้ต่อได้ 24 ชม. | [DECISION] รอบ 11 |
| NFR-143 | แจ้งเตือน admin เมื่อ: key ใกล้หมดอายุ 14 และ 3 วัน, key ถูกใช้จาก IP ใหม่, อัตรา 4xx/5xx ของ key > 20% ใน 15 นาที | [PROPOSED] |
| NFR-144 | ตรวจ secret รั่วสาธารณะ: ลงทะเบียน pattern `tk_live_` กับ GitHub secret scanning partner program (เมื่อมีผู้ใช้พอ) และ revoke อัตโนมัติเมื่อได้รับแจ้ง | [PROPOSED] P2 |
| NFR-145 | MCP ใช้ OAuth 2.1: Authorization Code + PKCE (S256) บังคับ, รองรับ Dynamic Client Registration (RFC 7591) และ Protected Resource Metadata ตาม MCP authorization spec, token ผูก audience `https://mcp.<domain>` (RFC 8707); access token 1 ชม., refresh 30 วันหมุนทุกครั้ง | [PROPOSED] |
| NFR-146 | หน้า consent แสดงชื่อ client, scope เป็นภาษาคน, บริษัทที่จะให้สิทธิ์; สิทธิ์จริง = role ผู้ใช้ ∩ scope; tool ระดับ "ร่าง" ไม่สามารถยืนยันเองได้ (D5) | [DECISION] |
| NFR-147 | Webhook ขาออก: เซ็น `HMAC-SHA256(secret, "{t}.{rawBody}")` ใน `X-TMS-Signature`, tolerance 5 นาที; https เท่านั้น; ป้องกัน SSRF — resolve DNS แล้วปฏิเสธ IP private/loopback/link-local/metadata (169.254.169.254) ทั้งตอนบันทึกและตอนส่ง, ไม่ตาม redirect, timeout 10 วินาที, ตอบกลับอ่านไม่เกิน 64 KB | [DECISION] api-benchmark §9.4 · SSRF [PROPOSED] |
| NFR-148 | Webhook ขาเข้า (connector/LINE/payment): ตรวจ signature ก่อน parse, ledger `(provider, eventKey)` unique กันประมวลผลซ้ำ | [DECISION] |

### 2.4 Secret และการเข้ารหัส

| รหัส | ข้อกำหนด | ป้าย |
|---|---|---|
| NFR-151 | ส่งข้อมูลด้วย TLS 1.2 ขึ้นไป (เปิด 1.3), HSTS `max-age=31536000; includeSubDomains`; การเชื่อม DB/Redis/queue ภายในใช้ TLS | [PROPOSED] |
| NFR-152 | Encryption at rest: ดิสก์ DB, backup, object storage เข้ารหัส AES-256 (managed KMS) | [PROPOSED] |
| NFR-153 | Field-level encryption (DM-018) แบบ envelope: data key ต่อ tenant เข้ารหัสด้วย master key ใน KMS; หมุน master key ทุก 12 เดือน; การถอดรหัสเลขบัตร/บัญชีเพื่อแสดงเต็มต้องมีสิทธิ์และบันทึก AuditLog | [PROPOSED] |
| NFR-154 | Credential ของ connector, webhook secret, pepper, signing key อยู่ใน secret manager (ไม่อยู่ใน DB เป็น plaintext, ไม่อยู่ใน env file ใน repo); CI มี secret scanning (gitleaks) บล็อก merge | [PROPOSED] |
| NFR-155 | JWT signing key หมุนทุก 90 วัน เผยแพร่ผ่าน JWKS (`kid`) รองรับ 2 key พร้อมกัน | [PROPOSED] |

### 2.5 ความปลอดภัยของเว็บและไฟล์

- NFR-161: Header มาตรฐาน — CSP แบบไม่มี `unsafe-inline` สำหรับ script (nonce), `X-Content-Type-Options: nosniff`, `frame-ancestors 'none'` (ยกเว้นหน้าติดตามที่ลูกค้าเลือกให้ embed ได้ — allowlist โดเมน), `Referrer-Policy: strict-origin-when-cross-origin`
- NFR-162: CSRF — API ใช้ Bearer token ใน header; endpoint `/auth/refresh` ที่ใช้ cookie ตรวจ `Origin` + header กำหนดเอง
- NFR-163: Upload — ตรวจ magic bytes (ไม่เชื่อนามสกุล), whitelist ชนิด (§12), สแกนมัลแวร์ไฟล์ PDF/Office ก่อนให้ดาวน์โหลด, เสิร์ฟไฟล์จากโดเมนแยก (`files.<domain>`) ผ่าน signed URL อายุ 15 นาที พร้อม `Content-Disposition` ที่ถูกต้อง
- NFR-164: Export Excel/CSV ป้องกัน formula injection (ขึ้นต้นด้วย `= + - @` → ใส่ `'` นำหน้า)
- NFR-165: ช่องโหว่จาก scan/pentest แก้ภายใน: critical 7 วัน, high 30 วัน, medium 90 วัน [PROPOSED]
- NFR-166: Dependency scanning ทุก PR + รายสัปดาห์; ห้ามใช้ package ที่มี CVE critical ที่ไม่มีทางแก้โดยไม่มีบันทึกยกเว้น

---

## 3. การแยก tenant (guarantee และการทดสอบ)

| รหัส | การรับประกัน | วิธีพิสูจน์ |
|---|---|---|
| NFR-201 | ทุกตารางชั้น tenant มี `tenant_id NOT NULL` + RLS `ENABLE` + `FORCE` + policy `tenant_isolation` | CI รัน query `pg_class`/`pg_policies` หลัง migrate: ตารางที่มี `tenant_id` แต่ไม่มี policy → build fail |
| NFR-202 | ไม่มี tenant context = ไม่เห็นข้อมูล (fail closed) | test: query ทุกตารางโดยไม่ set `app.tenant_id` ต้องได้ 0 แถว |
| NFR-203 | อ่าน/แก้/ลบข้าม tenant ไม่ได้ในระดับ DB | test generate จาก Prisma DMMF: seed A กับ B แล้ว SELECT/UPDATE/DELETE ในบริบท B ต้องได้ 0 แถว, INSERT `tenantId=A` ในบริบท B ต้อง error |
| NFR-204 | ทุก endpoint ที่รับ id ไม่คืนข้อมูลของ tenant อื่น | test suite สร้างจาก OpenAPI: เรียกทุก path ด้วย id ของ tenant อื่น → 404; list endpoint ต้องไม่มีแถวของ tenant อื่น |
| NFR-205 | Background job, webhook, export, รายงาน, AI/MCP, search, cache ไม่ปนกัน | test ต่อ worker ว่า payload ไม่มี `tenantId` → reject; cache key lint (`t:{tenantId}:`); MCP test ใช้ token tenant A ค้นข้อมูล B |
| NFR-206 | ไฟล์ข้าม tenant ไม่ได้ | test ขอ signed URL ด้วย fileId ของ tenant อื่น → 404 |
| NFR-207 | ตรวจใน production ต่อเนื่อง | synthetic tenant "canary-A/B" ยิง probe ข้าม tenant ทุก 15 นาที; พบรั่ว = แจ้งเตือน Sev-1 ทันที |
| NFR-208 | role `tms_platform` (BYPASSRLS) ใช้ได้เฉพาะ service ที่กำหนด | connection string แยก, network policy, ทุก query ถูก log พร้อมเหตุผล; ห้าม import ในโมดูล tenant (lint) |
| NFR-209 | เหตุรั่วข้าม tenant | จัดเป็น Sev-1: หยุด deploy, แจ้ง tenant ที่กระทบภายใน 24 ชม., ประเมินแจ้ง สคส. ภายใน 72 ชม. (§4) |

---

## 4. PDPA (พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562)

### 4.1 บทบาท

| ข้อมูล | ผู้ควบคุม (controller) | ผู้ประมวลผล (processor) |
|---|---|---|
| ข้อมูลคนขับ, ผู้ติดต่อลูกค้า, ผู้รับสินค้า, รถร่วม ที่ tenant บันทึก | tenant (บริษัทขนส่ง) | เรา — ต้องมี DPA ใน Terms ของ SaaS [OPINION] thai-tax §5.4 |
| บัญชีผู้ใช้ของ tenant, ข้อมูลการสมัคร/ชำระเงิน, PlatformUser | เรา | ผู้ให้บริการของเรา (sub-processor) |

### 4.2 Inventory ข้อมูลและฐานกฎหมาย [PROPOSED — ให้ฝ่ายกฎหมายยืนยัน]

| ข้อมูล | เจ้าของข้อมูล | วัตถุประสงค์ | ฐาน | ระยะเก็บ |
|---|---|---|---|---|
| ชื่อ เบอร์ รูป ใบขับขี่ | คนขับ | จัดงาน, ตรวจคุณสมบัติตามกฎหมาย | สัญญา + หน้าที่ตามกฎหมาย | ตามข้อมูลปฏิบัติการ (DM §7) |
| ตำแหน่ง GPS จากแอป | คนขับ | ติดตามการขนส่ง, ETA, ความปลอดภัย, ค่ารอ | สัญญา + ประโยชน์โดยชอบด้วยกฎหมาย (ไม่ใช้ consent) | [OPEN] DM-OPEN-1 |
| เลขบัตรประชาชน | คนขับ/รถร่วมบุคคล | 50 ทวิ, ภ.ง.ด.3 | หน้าที่ตามกฎหมาย | ตามเอกสารภาษี |
| ชื่อ ลายเซ็น รูปหน้างาน | ผู้รับสินค้า | หลักฐานการส่งมอบ | สัญญา (ระหว่าง tenant กับลูกค้า) / ประโยชน์โดยชอบ | ตามข้อมูลปฏิบัติการ |
| เบอร์/LINE ผู้รับ | ผู้รับสินค้า | แจ้งสถานะ | ประโยชน์โดยชอบ (ปิดได้ต่อลูกค้า) | 90 วันหลังส่ง [PROPOSED] |
| ข้อความ/ไฟล์ส่งให้ AI | ผู้ใช้/คู่ค้า | สร้างร่าง SO, OCR | ประโยชน์โดยชอบ + ตามสัญญา tenant | input 90 วัน (DM §7) |

### 4.3 ข้อกำหนด

| รหัส | ข้อกำหนด | ป้าย |
|---|---|---|
| NFR-301 | แอปคนขับจอ M10: แสดง Privacy Notice (วัตถุประสงค์, ฐาน, ข้อมูลที่เก็บ, ระยะเก็บ, ผู้รับข้อมูล, สิทธิ) 3 ภาษา + ขอสิทธิ์ตำแหน่ง/กล้อง/แจ้งเตือนพร้อมเหตุผล; บันทึก `privacyNoticeVersion` + เวลารับทราบ; notice เปลี่ยน = แสดงใหม่ | [DECISION] รอบ 5 |
| NFR-302 | เก็บตำแหน่ง **เฉพาะช่วงปฏิบัติงาน**: ตั้งแต่รับเที่ยว/เริ่มเที่ยวจนจบเที่ยว (`trip_end`) — ไม่ track นอกเวลางาน; แอปแสดงไอคอน "กำลังส่งตำแหน่ง" ตลอดเวลาที่ track; คนขับดูประวัติตำแหน่งเที่ยวของตัวเองได้ | [PROPOSED] |
| NFR-303 | Minimization: เลขบัตรประชาชนไม่บังคับสำหรับคนขับพนักงาน (บังคับเฉพาะผู้รับเงินที่ต้องออก 50 ทวิ); สำเนาบัตรที่อัปโหลดต้องปิดทับศาสนา/หมู่เลือด (ข้อมูลอ่อนไหว ม.26) ก่อนบันทึก — ระบบมีเครื่องมือปิดทับ | [PROPOSED] |
| NFR-304 | Masking: UI แสดงเลขบัตร/บัญชี/ใบขับขี่เป็น `•••• 1234`; log/APM/error tracking ปิดบัง PII อัตโนมัติ (เบอร์, อีเมล, เลข 13 หลัก, token) | [PROPOSED] |
| NFR-305 | หน้าติดตามผู้รับ (สาธารณะ): แสดงชื่อเล่นคนขับ + ทะเบียน + ตำแหน่งโดยประมาณระหว่างวิ่งงานนั้นเท่านั้น; ไม่แสดงเบอร์คนขับเต็ม (ใช้ปุ่มโทรผ่านเบอร์บริษัท) | [PROPOSED] |
| NFR-306 | สิทธิ์เจ้าของข้อมูล (DSR): tenant admin มีเครื่องมือค้น/ส่งออก/แก้/ลบ (anonymize) ข้อมูลของบุคคล; บันทึกใน `DataSubjectRequest`; เป้าหมายดำเนินการ ≤ 30 วัน; ข้อมูลที่ต้องเก็บตามกฎหมายภาษีไม่ลบแต่จำกัดการใช้ | [FACT] ม.30 (30 วัน) · เครื่องมือ [PROPOSED] |
| NFR-307 | เหตุละเมิดข้อมูล: เราแจ้ง tenant ที่กระทบภายใน 24 ชม. หลังยืนยันเหตุ (ให้ tenant แจ้ง สคส. ทัน 72 ชม.); ข้อมูลที่เราเป็นผู้ควบคุม เราแจ้ง สคส. ภายใน 72 ชม. | [FACT] 72 ชม. · 24 ชม. [PROPOSED] |
| NFR-308 | Sub-processor: เผยแพร่รายการบนเว็บ (cloud, อีเมล, SMS, LINE, แผนที่, AI, Opn, EasySlip, error tracking) + แจ้งล่วงหน้า 30 วันก่อนเพิ่มราย; มี DPA กับทุกราย | [PROPOSED] |
| NFR-309 | ผู้ให้บริการ AI: สัญญาแบบไม่ใช้ข้อมูลฝึกโมเดลและเก็บข้อมูลให้น้อยที่สุด (zero data retention ถ้ามี); tenant ปิด AI ได้ทั้งบริษัท; toggle ปิดบังเลขบัตร/เบอร์ก่อนส่ง (ค่าเริ่มต้นเปิด) | [DECISION] ai-mcp-plan §3 |
| NFR-310 | การส่งข้อมูลออกนอกประเทศ (ม.28–29): ระบุประเทศปลายทางของ sub-processor แต่ละรายใน Privacy Notice และใช้ข้อสัญญามาตรฐาน/มาตรการคุ้มครองที่เหมาะสม; ภูมิภาคหลักของข้อมูล = [OPEN] NFR-OPEN-1 | [FACT] ม.28 · [OPEN] |
| NFR-311 | บันทึกรายการกิจกรรมการประมวลผล (ROPA) ของเราในฐานะ processor และ controller; ทบทวนทุก 12 เดือน | [FACT] PDPA ม.39–40 |
| NFR-312 | ส่งเลข 13 หลักไป RD ตอนสมัคร: ระบุใน Privacy Notice ของการสมัคร; raw response เก็บ 90 วัน | [DECISION] decisions §2 |

---

## 5. Audit log

| รหัส | ข้อกำหนด |
|---|---|
| NFR-401 | **ต้องบันทึก**: ล็อกอินสำเร็จ/ล้มเหลว/ล็อก, เปลี่ยนรหัส/2FA, เชิญ/ลบ/เปลี่ยน role สมาชิก, แก้สิทธิ์ role, ออก/ยกเลิกเอกสารภาษี, ใบลด/เพิ่มหนี้, รับชำระ/void, อนุมัติ settlement/จ่าย, override กฎห้ามจ่ายงาน, override ราคา, ยกเลิก SO/DO/Trip, แก้เลขไมล์ด้วยมือ, สร้าง/หมุน/เพิกถอน API key, แก้ webhook, ตั้งค่า connector, export/print เอกสารภาษี, ถอดรหัสดูข้อมูลอ่อนไหว, ยืนยัน/ปฏิเสธผล AI, เครื่องมือ MCP ที่เขียนข้อมูล, ทุกการกระทำของ PlatformUser และระหว่าง impersonate, คำขอ DSR, purge |
| NFR-402 | แต่ละรายการมี: ใคร (ประเภท + id + ชื่อ snapshot), ทำอะไร, กับอะไร (entity + เลขเอกสาร), diff ก่อน/หลัง, เหตุผล (บังคับเมื่อยกเลิก/override/อนุมัติ ≥ 10 ตัวอักษร — 00-overview §6), เวลา, IP, request id, impersonation id |
| NFR-403 | **Immutability**: append-only (สิทธิ์ DB เฉพาะ INSERT/SELECT), hash chain ต่อ tenant ต่อวัน (DM `AuditLog.hash`), ส่งสำเนารายวันไป object storage แบบ WORM (object lock) แยก account [PROPOSED]; job ตรวจ chain รายวัน แจ้งเตือนเมื่อไม่ต่อเนื่อง |
| NFR-404 | ระยะเก็บ 2 ปี; เหตุการณ์ของเอกสารภาษีเก็บเท่าตัวเอกสาร (DM §7) [PROPOSED] |
| NFR-405 | การดู: tenant admin ดู audit ของบริษัทตัวเอง (กรองตามผู้ใช้/ช่วงเวลา/ประเภท/เอกสาร); Platform Console ดูทุก tenant; export CSV ได้ (แพ็กเกจที่มี `audit.export`) |
| NFR-406 | การเขียน audit ต้องอยู่ใน transaction เดียวกับการเปลี่ยนข้อมูล (ไม่มีกรณีข้อมูลเปลี่ยนแต่ audit หาย) ยกเว้น login/read event ที่เขียนแบบ async ได้ |

---

## 6. หลายภาษา (TH / EN / 中文)

| รหัส | ข้อกำหนด | ป้าย |
|---|---|---|
| NFR-501 | UI ทุกหน้า (web, แอปคนขับ, หน้ารถร่วม, หน้าติดตาม, Signup, Console) รองรับ `th`, `en`, `zh-Hans`; ภาษาเริ่มต้นจาก tenant, ผู้ใช้เลือกเองได้ (เก็บใน `User.locale`); หน้า public เลือกจาก `Accept-Language` | [DECISION] |
| NFR-502 | ข้อความแปลอยู่ในไฟล์ resource ต่อภาษา (ICU MessageFormat รองรับพหูพจน์/ตัวแปร); ห้าม hard-code ข้อความในโค้ด (lint); key ที่ขาด fallback → `th` แล้วรายงานเข้า monitoring; CI ตรวจว่าทุก key มีครบ 3 ภาษา | [PROPOSED] |
| NFR-503 | ข้อความ error/validation จาก API มี `code` คงที่ + `message` ตามภาษาของผู้เรียก (`Accept-Language`); custom field label/validation ใช้ข้อความ 3 ภาษาที่ tenant ตั้ง | [DECISION] |
| NFR-504 | **ปี**: โหมดไทยแสดง พ.ศ. (ค.ศ. + 543) เช่น `9 พ.ย. 2569`, `09/11/2569`; โหมด EN/中文 แสดง ค.ศ. (`9 Nov 2026`, `2026年11月9日`); ฐานข้อมูลและ API เก็บ/รับ ค.ศ. ISO 8601 เสมอ | [DECISION] 00-overview §6 |
| NFR-505 | Date picker แสดงปีตามโหมด แต่ส่ง ค.ศ.; ช่องพิมพ์วันที่ในโหมดไทยรับ พ.ศ.; import CSV/Excel ระบุยุคปีใน mapping (`date_be_to_ce`) — ถ้าไม่ระบุ: ปี ≥ 2400 ถือเป็น พ.ศ. และแสดงคำเตือนให้ยืนยันก่อน commit | [PROPOSED] |
| NFR-506 | เอกสารภาษีพิมพ์ภาษาไทย (บังคับ) หรือ ไทย+อังกฤษ; วันที่บนเอกสารภาษีภาษาไทยใช้ พ.ศ.; มี **จำนวนเงินตัวอักษรภาษาไทย** ("หนึ่งพันสองร้อยห้าสิบบาทถ้วน", "…บาทห้าสิบสตางค์") และอังกฤษเมื่อเลือก 2 ภาษา — มี golden test (§15) | [PROPOSED] |
| NFR-507 | ตัวเลข: เลขอารบิก, คั่นหลักพันด้วย `,`, ทศนิยม `.`, เงิน 2 ตำแหน่ง, tabular-nums, ชิดขวา, ฿ ที่หัวคอลัมน์; ไม่ใช้เลขไทยในระบบ (เลือกได้บน A4 ในอนาคต) | [DECISION] รอบ 6 |
| NFR-508 | เวลาแสดงตาม `Asia/Bangkok` (ไม่มี DST) รูปแบบ 24 ชม. `14:30 น.` (ไทย) | [DECISION] |
| NFR-509 | การตัดคำไทย: ข้อความไทยไม่มีช่องว่างระหว่างคำ — เว็บใช้ `word-break: normal; overflow-wrap: anywhere` เฉพาะ cell แคบ, หัวข้อใหญ่ใช้ `Intl.Segmenter('th', {granularity:'word'})` แทรก `<wbr>` เพื่อไม่ตัดกลางคำ; ตัวสร้าง PDF ต้องตัดบรรทัดตามพจนานุกรมไทย (ICU) และวางสระ/วรรณยุกต์ถูกตำแหน่งด้วยฟอนต์ Sarabun (OpenType GPOS/GSUB) — ตรวจด้วย visual snapshot | [DECISION] รอบ 17 · วิธี [PROPOSED] |
| NFR-510 | ค้นหาไทย: normalize Unicode NFC, ตัด zero-width space, รวม "ำ" รูปแบบต่าง, ค้นแบบ trigram (`pg_trgm`); เรียงชื่อด้วย ICU collation `th-TH-x-icu` | [PROPOSED] |
| NFR-511 | ฟอนต์: IBM Plex Sans Thai Looped (ไทย), IBM Plex Sans (ละติน), Noto Sans SC (จีน) โหลดแบบ subset + `font-display: swap`; A4 ใช้ Sarabun ฝังในไฟล์ PDF | [DECISION] รอบ 6 |

---

## 7. Accessibility

| รหัส | ข้อกำหนด |
|---|---|
| NFR-601 | เป้าหมาย WCAG 2.1 AA ทุกหน้า web และแอปคนขับ |
| NFR-602 | Contrast ข้อความ ≥ 4.5:1 (ชุดสีปัจจุบันออกแบบ ≥ 5:1), ข้อความใหญ่/ไอคอน/ขอบ input ≥ 3:1; ห้ามข้อความอ่อนกว่า `#59606B` ยกเว้น disabled (รอบ 2) |
| NFR-603 | สถานะไม่สื่อด้วยสีอย่างเดียว — จุดสี + ข้อความเสมอ; กระดานวางแผนใช้ลาย hatch + ป้ายเหตุผลสำหรับรถติดกฎ (รอบ 9) |
| NFR-604 | Touch target ≥ 44×44 px (web มือถือ) และ ≥ 48×48 dp ในแอปคนขับ; ปุ่มหลักแอปคนขับสูง ≥ 52 px (รอบ 5); ระยะห่างระหว่าง target ≥ 8 px |
| NFR-605 | Keyboard: ทุกฟังก์ชันใน web ทำได้ด้วยคีย์บอร์ด, focus มองเห็นชัด (ขอบ `#9DB6E3` ≥ 2 px), ลำดับ tab ตามลำดับสายตา, drawer/dialog กัก focus และปิดด้วย Esc; **การลากวางในกระดานวางแผนต้องมีทางเลือกที่ไม่ใช่การลาก** (เมนู "จัดเข้าเที่ยว…" / "ย้ายไปรถอื่น") |
| NFR-606 | ทางลัด ⌘K/Ctrl+K เปิดค้นหา; ทางลัดอื่นแสดงในหน้าช่วยเหลือ |
| NFR-607 | ARIA: role/label ครบ 3 ภาษา, ตาราง header ผูกกับ cell, toast ประกาศผ่าน `aria-live`; แอปคนขับรองรับ VoiceOver/TalkBack ในจอหลัก (M1–M4, POD) |
| NFR-608 | ขนาดตัวอักษรขั้นต่ำ 12 px (web), 16 px เนื้อหาหลักในแอปคนขับ; รองรับ OS text scaling ถึง 200% ในแอปโดยไม่ตัดปุ่มสำคัญ; เคารพ `prefers-reduced-motion` |
| NFR-609 | แอปคนขับใช้กลางแดด: โหมดสว่าง contrast สูง, ไม่มีข้อมูลสำคัญเป็นสีอ่อน, ปุ่มกดได้ด้วยมือข้างเดียว (ส่วนล่างจอ) |

---

## 8. ประสิทธิภาพ [PROPOSED ทั้งหมด]

วัดบน production-like (staging) ด้วยข้อมูล tenant ใหญ่จำลอง: 200 คัน, 150 คนขับ, 2 ปีย้อนหลัง (~150,000 SO, ~220,000 DO, 120 ล้านจุด GPS)

| รหัส | รายการ | เป้าหมาย |
|---|---|---|
| NFR-701 | หน้าเว็บโหลดแรก (LCP) | ≤ 2.5 วินาที p75 (desktop broadband และ 4G); INP ≤ 200 ms; CLS ≤ 0.1 |
| NFR-702 | JS เริ่มต้น | ≤ 300 KB gzip; เปลี่ยนหน้าในแอป ≤ 1 วินาที |
| NFR-703 | API list (≤ 50 แถว, มีกรอง/เรียง) | p95 ≤ 300 ms, p99 ≤ 800 ms |
| NFR-704 | API อ่านรายการเดียว | p95 ≤ 200 ms |
| NFR-705 | API เขียนทั่วไป | p95 ≤ 500 ms |
| NFR-706 | ออกเอกสารภาษี (จองเลข + บันทึก) | p95 ≤ 1 วินาที; render PDF แบบ async พร้อมดาวน์โหลด ≤ 10 วินาที |
| NFR-707 | ค้นหา ⌘K | p95 ≤ 300 ms |
| NFR-708 | **กระดานวางแผน 200 คัน × 7 วัน** (~1,400 การ์ดเที่ยว + 500 SO รอจัด) | API ≤ 800 ms p95, payload ≤ 300 KB gzip, แสดงผลครั้งแรก ≤ 2 วินาที p95; render แบบ virtualized เลื่อน ≥ 50 fps; ตรวจกฎตอนลาก (สี เขียว/แดง) ฝั่ง client ≤ 100 ms; บันทึกการจัด ≤ 500 ms; การเปลี่ยนแปลงจากผู้ใช้อื่นปรากฏ ≤ 3 วินาที |
| NFR-709 | แผนที่ติดตามรถ | 200 marker แสดง ≤ 1 วินาที (cluster เมื่อซูมออก); ตำแหน่งใหม่ถึงเบราว์เซอร์ (WebSocket/SSE) ≤ 5 วินาทีหลัง server รับ |
| NFR-710 | ความถี่ส่งตำแหน่งจากแอป | ทุก 30 วินาที หรือเคลื่อนที่ ≥ 200 ม. ขณะวิ่ง; ทุก 5 นาทีขณะจอด; ส่งเป็น batch; GPS provider ดึงทุก 30–60 วินาที |
| NFR-711 | Sync หลังกลับมาออนไลน์ | คิว 100 เหตุการณ์ + 30 รูป ส่งครบ ≤ 2 นาที บนเน็ต 1 Mbps; ingest batch 50 เหตุการณ์ p95 ≤ 300 ms; เหตุการณ์ปรากฏบนเว็บ ≤ 10 วินาทีหลังรับ |
| NFR-712 | รายงานมาตรฐาน (≤ 12 เดือน) | ≤ 5 วินาที; เกินกว่านั้นเป็น async job + แจ้งเมื่อเสร็จ |
| NFR-713 | Import | 5,000 แถว ≤ 2 นาที (dry-run รวม) |
| NFR-714 | Webhook | ส่งครั้งแรก p95 ≤ 30 วินาทีหลังเหตุการณ์ |
| NFR-715 | AI order intake | ร่าง SO จากข้อความ ≤ 10 วินาที p90; OCR ใบเสร็จ ≤ 15 วินาที p90 (แสดง progress) |
| NFR-716 | ขีดความสามารถ | ออกแบบรองรับ 1,000 tenant / 30,000 คัน; load test ที่ 2× ปริมาณคาดการณ์ของปีแรก (200 tenant / 8,000 คัน / 1,500 ผู้ใช้พร้อมกัน) ก่อนเปิดขาย |

---

## 9. อุปกรณ์และเบราว์เซอร์ที่รองรับ

| ช่องทาง | รองรับ | หมายเหตุ |
|---|---|---|
| แอปลูกค้า (TMS web) desktop | Chrome / Edge 2 เวอร์ชันหลักล่าสุด, Firefox 2 เวอร์ชันล่าสุด, Safari 16+ (macOS) | จอ ≥ 1280×720; กระดานวางแผน desktop เท่านั้น |
| แอปลูกค้าบนมือถือ/แท็บเล็ต | iOS Safari 15+, Android Chrome 100+ | หน้า responsive ถึง 390 px: ภาพรวม, อนุมัติ, ติดตาม, drawer อ่าน, ศูนย์ข้อยกเว้น |
| หน้ารถร่วม (ลิงก์ LINE), หน้าติดตามผู้รับ, อัปโหลด POD, Signup | iOS Safari 15+, Android Chrome 100+, **LINE in-app browser** (iOS/Android เวอร์ชันปัจจุบัน), Samsung Internet 2 เวอร์ชันล่าสุด | ทดสอบใน LINE in-app ทุก release เพราะลิงก์ส่งทาง LINE; รองรับกล้องผ่าน `<input capture>` |
| แอปคนขับ | iOS 15+, Android 8.0 (API 26)+ [PROPOSED] | เครื่อง Android RAM 2 GB ต้องใช้ได้ลื่น; ขนาดติดตั้ง ≤ 50 MB; เทคโนโลยีแอป = [OPEN] NFR-OPEN-2 |
| Platform Console | Chrome / Edge 2 เวอร์ชันล่าสุด | desktop เท่านั้น |
| IE / Edge legacy / Opera Mini | ไม่รองรับ | แสดงหน้าแจ้งเบราว์เซอร์ |

**แอปคนขับออฟไลน์**

| รหัส | ข้อกำหนด | ป้าย |
|---|---|---|
| NFR-801 | ทำงานออฟไลน์ได้ ≥ 72 ชั่วโมง: ดูงานที่ดาวน์โหลดแล้ว, ถึง/ออกจุด, POD, ส่งไม่สำเร็จ, ค่าใช้จ่าย, ตรวจรถ, แจ้งปัญหา | [PROPOSED] |
| NFR-802 | คิวในเครื่องรองรับ ≥ 1,000 เหตุการณ์ และรูป ≥ 300 รูป (เพดานพื้นที่ 300 MB); เต็ม 80% เตือนคนขับ | [PROPOSED] |
| NFR-803 | ดาวน์โหลดงานล่วงหน้า: เที่ยววันนี้และพรุ่งนี้ + ข้อมูลจุดส่ง + POD profile ของลูกค้า | [PROPOSED] |
| NFR-804 | ออฟไลน์ > 24 ชม. แจ้งเตือนคนขับและแสดงสถานะ "ไม่ได้ซิงก์" ในเว็บของฝ่ายจัดรถ | [PROPOSED] |
| NFR-805 | ทุกเหตุการณ์มี `clientEventId`, `occurredAt`, `seqOnDevice`; server idempotent (DM `DriverEvent`); ปิดแอป/รีสตาร์ต/แบตหมดแล้วคิวไม่หาย (เขียนลง DB ก่อนแสดงว่าบันทึกแล้ว) | [DECISION] |
| NFR-806 | อัปโหลดรูปแบบ resumable (chunk 256 KB) ต่อจากจุดที่ขาดได้ | [PROPOSED] |
| NFR-807 | แบตเตอรี่: tracking ขณะวิ่งใช้ ≤ 5% ต่อชั่วโมงบนเครื่องอ้างอิง | [PROPOSED] |
| NFR-808 | เวอร์ชันแอป: server รองรับแอป N-2 เวอร์ชัน; ต่ำกว่า `minSupportedVersion` แสดงจอบังคับอัปเดต แต่ **ยังส่งคิวค้างได้ก่อน** | [PROPOSED] |

---

## 10. ความพร้อมใช้งาน, backup และกู้คืน

| รหัส | ข้อกำหนด | ป้าย |
|---|---|---|
| NFR-901 | SLA uptime รายเดือน: 99.5% (Starter/Growth), 99.9% (Business/Enterprise) วัดจาก synthetic check ในไทยทุก 1 นาที ที่หน้า login + API health + ingest แอปคนขับ | [PROPOSED] |
| NFR-902 | Maintenance ตามแผน ≤ 4 ชม./เดือน ช่วง อาทิตย์ 01:00–05:00 น. แจ้งล่วงหน้า ≥ 72 ชม. — ไม่นับใน SLA; แอปคนขับทำงานออฟไลน์ระหว่างนั้น | [PROPOSED] |
| NFR-903 | Support response: Business ตอบภายใน 4 ชม. ทำการ (decisions §4); Enterprise 24×7 ตามสัญญา; Starter/Growth 1 วันทำการ | [PROPOSED] |
| NFR-904 | สถาปัตยกรรม: app stateless ≥ 2 instance กระจาย ≥ 2 AZ; PostgreSQL managed แบบ multi-AZ (failover อัตโนมัติ ≤ 2 นาที); queue/Redis แบบ HA | [PROPOSED] |
| NFR-905 | Backup DB: PITR (WAL ต่อเนื่อง) ย้อนได้ 35 วัน + snapshot รายวัน; สำเนาข้ามภูมิภาคตามนโยบาย residency (NFR-OPEN-1) | [PROPOSED] |
| NFR-906 | Object storage: versioning 30 วัน + replication; bucket PDF เอกสารภาษีใช้ object lock (compliance mode) | [PROPOSED] |
| NFR-907 | **RPO ≤ 15 นาที, RTO ≤ 4 ชั่วโมง** สำหรับการล่มทั้ง region; การล่ม AZ เดียว RTO ≤ 15 นาที | [PROPOSED] |
| NFR-908 | ฝึกกู้คืน (restore drill) ทุกไตรมาส บันทึกเวลาจริงเทียบ RTO; กู้ข้อมูลราย tenant (logical restore ไป schema ชั่วคราวแล้วคัดเฉพาะ tenant) ได้ภายใน 2 วันทำการ ย้อนหลังไม่เกิน 35 วัน | [PROPOSED] |
| NFR-909 | Status page สาธารณะ (แยกโครงสร้างจากระบบหลัก) แจ้ง incident ภายใน 15 นาทีหลังยืนยัน | [PROPOSED] |
| NFR-910 | Service credit เมื่อต่ำกว่า SLA | [OPEN] NFR-OPEN-4 |

---

## 11. Observability

| รหัส | ข้อกำหนด |
|---|---|
| NFR-1001 | Log แบบ JSON มี `timestamp, level, service, requestId, tenantId, userId, route, durationMs`; ห้าม log body ที่มี PII/secret (redaction middleware); log เก็บ 30 วัน (hot), security log 1 ปี (cold) [PROPOSED] |
| NFR-1002 | Distributed tracing (OpenTelemetry) จาก web → API → DB/queue/worker → webhook/connector; `requestId` = trace id แสดงให้ลูกค้าแจ้ง support |
| NFR-1003 | Metrics RED ต่อ endpoint + ต่อ tenant (rate, error, duration), queue lag, DB (connections, slow query > 500 ms), ingest lag แอปคนขับ, webhook success rate, connector sync failure rate, AI latency/cost |
| NFR-1004 | Alert (on-call): 5xx > 1% นาน 5 นาที; p95 เกินเป้า 2 เท่านาน 10 นาที; queue lag > 5 นาที; ingest lag แอป > 2 นาที; replication lag > 60 วินาที; disk > 80%; cert หมดอายุ < 14 วัน; isolation canary ล้มเหลว (Sev-1 ทันที); hash chain audit ไม่ต่อเนื่อง |
| NFR-1005 | Error tracking web + แอปคนขับ (crash-free sessions ≥ 99.5%) พร้อมลบ PII ก่อนส่ง |
| NFR-1006 | RUM ฝั่ง web (Core Web Vitals) แยกตามหน้า; dashboard ต่อ tenant ใน Platform Console (การใช้งาน API/AI/ข้อผิดพลาด) |
| NFR-1007 | ทุก incident Sev-1/2 มี postmortem ภายใน 5 วันทำการ |

---

## 12. Rate limiting

| รหัส | ขอบเขต | ค่า | ป้าย |
|---|---|---|---|
| NFR-1101 | Login | 5 ครั้ง/นาที ต่อบัญชี, 20 ครั้ง/นาที ต่อ IP | [PROPOSED] |
| NFR-1102 | OTP | ตาม NFR-104 | [PROPOSED] |
| NFR-1103 | Open API ต่อ key | ตามแพ็กเกจ (ต้นแบบ: 60 / 300 / 1,000 req/นาที — ค่าจริงจาก `PlanVersion`) | [DECISION] D8 |
| NFR-1104 | ต่อ tenant (เพดานรวมทุก key + MCP) | 50 req/วินาที burst 100 (token bucket); endpoint หนัก (bulk, invoice run, finalize) 5 req/วินาที | [PROPOSED] api-benchmark §9.8 |
| NFR-1105 | UI ภายใน | 20 req/วินาที ต่อผู้ใช้ (กัน script) | [PROPOSED] |
| NFR-1106 | หน้า public (ติดตาม, ลิงก์รถร่วม) | 60 req/นาที ต่อ IP, 30 req/นาที ต่อ token | [PROPOSED] |
| NFR-1107 | Ingest แอปคนขับ | 10 req/วินาที ต่อเครื่อง (batch) | [PROPOSED] |
| NFR-1108 | AI | ตาม AI credit รายเดือน + 30 คำขอ/นาที ต่อผู้ใช้ | [PROPOSED] |

- ตอบ 429 แบบ problem+json `code: rate_limited`, `scope: tenant|key|endpoint` + header `RateLimit-Limit/Remaining/Reset` และ `Retry-After`
- Console ปรับ limit ราย tenant/ราย key ได้ และปิด API ของ tenant ที่ละเมิดได้ (รอบ 11)

---

## 13. การเก็บและลบข้อมูล

| รหัส | ข้อกำหนด | ป้าย |
|---|---|---|
| NFR-1201 | ตารางระยะเก็บรายกลุ่มข้อมูลตาม 10-data-model §7 | — |
| NFR-1202 | เอกสารภาษีที่ tenant ออก: ไม่ลบระหว่างใช้งาน; หน้าที่เก็บ ≥ 5 ปีเป็นของ tenant (ม.87/3) | [FACT] |
| NFR-1203 | Tenant ยกเลิก: วันยกเลิกสร้าง export ครบชุดอัตโนมัติ (เอกสารภาษี PDF + CSV ทุกโมดูล + รูป POD เป็น zip) ส่งลิงก์ให้ owner (ลิงก์อายุ 30 วัน ต่ออายุได้ภายในระยะเก็บ); ข้อมูลเก็บ **90 วัน** แล้ว purge | [PROPOSED] decisions §5 |
| NFR-1204 | ใบกำกับภาษีที่เราออกให้ลูกค้า เก็บ 7 ปี ไม่ลบเมื่อลูกค้ายกเลิก | [FACT] ≥ 5 ปี · [PROPOSED] 7 ปี |
| NFR-1205 | Purge ไม่ย้อนคืน: dry-run 7 วันก่อน, แจ้ง owner 30 และ 7 วันก่อน purge, บันทึกหลักฐาน; ข้อมูลใน backup หมดไปตามรอบ ≤ 35 วัน | [PROPOSED] |
| NFR-1206 | ไม่มีปุ่มลบ tenant ในแอปลูกค้า (D7); การลบก่อนกำหนดตามคำขอเป็นลายลักษณ์อักษร ทำผ่าน Console โดย owner ของเรา + เหตุผล | [DECISION] |
| NFR-1207 | Export ข้อมูลระหว่างใช้งานได้ทุกเมื่อ (ทุกสถานะรวม read_only/suspended) — ไม่ล็อกข้อมูลลูกค้า | [DECISION] |

---

## 14. ไฟล์และพื้นที่เก็บ

| รหัส | ชนิดไฟล์ | ข้อจำกัด | ป้าย |
|---|---|---|---|
| NFR-1301 | รูปจากแอปคนขับ/ลิงก์ (POD, ตรวจรถ, ค่าใช้จ่าย, อุบัติเหตุ) | ย่อในเครื่องก่อนส่ง: ด้านยาว 1,600 px, JPEG quality 0.75 (~200–400 KB); ไม่เก็บต้นฉบับ; server สร้าง thumbnail 320 px; ลบ EXIF ออกจากไฟล์ (พิกัด/เวลาเก็บในฐานข้อมูลแล้ว); HEIC แปลงเป็น JPEG; ยอมรับสูงสุด 5 MB หลังย่อ | [PROPOSED] |
| NFR-1302 | ลายเซ็น | PNG ≤ 200 KB, พื้นโปร่ง | [PROPOSED] |
| NFR-1303 | เอกสารแนบ (PDF/รูปสแกน: เอกสารรถ, ใบแจ้งหนี้อู่, สลิป) | ≤ 20 MB ต่อไฟล์, ≤ 20 ไฟล์ต่อรายการ | [PROPOSED] |
| NFR-1304 | Import | CSV/XLSX ≤ 10 MB หรือ ≤ 20,000 แถวต่อไฟล์ | [PROPOSED] |
| NFR-1305 | Input ให้ AI | ≤ 20 MB, ≤ 20 หน้าต่อคำขอ | [PROPOSED] |
| NFR-1306 | ชนิดที่ยอมรับ | jpg, jpeg, png, webp, heic, pdf, xlsx, xls, csv (+ ตรวจ magic bytes) | [PROPOSED] |
| NFR-1307 | โควตาพื้นที่ POD ตามแพ็กเกจ (`pod.storage_gb`) | เตือนที่ 80% และ 100%; **เกินโควตาไม่บล็อกการอัปโหลด POD** (ฟีเจอร์พื้นฐาน D4) — แจ้งให้ซื้อ add-on/อัปเกรด และนับ usage | [PROPOSED] |
| NFR-1308 | PDF ที่ระบบสร้าง | เอกสารภาษี render ครั้งเดียวตอนออก, ≤ 1 MB ต่อหน้าโดยประมาณ, ฝังฟอนต์, PDF/A-2b [PROPOSED] เพื่อเก็บระยะยาว | [PROPOSED] |

---

## 15. Environment

| Environment | ใช้ทำอะไร | ข้อมูล | ผู้ให้บริการภายนอก | Deploy |
|---|---|---|---|---|
| local | นักพัฒนา (docker compose: Postgres+PostGIS, Redis, MinIO, mock SMS/LINE/RD) | seed สังเคราะห์ | mock ทั้งหมด | — |
| dev | รวมงานทุก PR ที่ merge | สังเคราะห์ (reset ได้) | test key / mock | อัตโนมัติจาก `main` |
| staging | ทดสอบก่อนปล่อย, load test, UAT ภายใน, pentest | สังเคราะห์ขนาด tenant ใหญ่ (§8) — **ห้ามคัดลอกข้อมูล production ลงมา** | sandbox ของ Opn/LINE/SMS, RD mock + RD จริงแบบอ่าน | release candidate |
| sandbox (ลูกค้า) | Open API ทดสอบของลูกค้า (`tk_test_`) | tenant `mode=sandbox` ใน cluster production (DM-029) แยก RLS | webhook ส่งจริง; ไม่ส่ง SMS/LINE จริง; ไม่ตัดเงิน | ตาม production |
| production | ลูกค้าจริง | จริง | live | release ที่อนุมัติ |

- NFR-1401: config ต่อ environment ผ่าน env/secret manager; feature flag ปิดฟีเจอร์ใหม่ได้ต่อ tenant
- NFR-1402: Migration แบบ expand → migrate → contract ไม่มี downtime; ทุก migration ต้องผ่านบน staging ด้วยข้อมูลขนาดใหญ่ก่อน; เปลี่ยน enum/คอลัมน์ต้องเข้ากันกับแอปคนขับ N-2
- NFR-1403: Release ปกติ ≥ 1 ครั้ง/สัปดาห์ นอกเวลางานหนักของลูกค้า (ไม่ deploy 06:00–10:00 น. ที่ฝ่ายจัดรถวางงาน) [PROPOSED]; rollback ภายใน 15 นาที

---

## 16. กลยุทธ์การทดสอบ

| ระดับ | ขอบเขต | เกณฑ์ |
|---|---|---|
| Unit | domain logic: คำนวณราคา/rate card, VAT/WHT, state machine ทุกเอกสาร, นิยามรถ active, ค่ารอ, กฎห้ามจ่ายงาน, ตัวแปลง พ.ศ./ค.ศ., จำนวนเงินตัวอักษร | coverage ≥ 80% ในโมดูล billing/pricing/dispatch-rules/usage; ทั้งระบบ ≥ 60% [PROPOSED] |
| **Golden test ภาษี** | ชุด fixture (input → ยอด, บรรทัด, PDF snapshot) ครอบอย่างน้อย: ค่าขนส่งยกเว้น + บริการประกอบ 7% ในใบเดียว; ลูกค้าหัก ณ ที่จ่าย 1%; ปัดเศษแบบรายบรรทัด vs รายเอกสาร; รับชำระบางส่วนหลายงวด + WHT; ใบลดหนี้/เพิ่มหนี้ (มูลค่าเดิม/ใหม่/ผลต่าง/สาเหตุ); ยกเลิกแล้วออกใหม่อ้างเลขเดิม; สาขา 00000/00001; เลขเอกสารปี พ.ศ.; 50 ทวิ ภ.ง.ด.3/53; settlement หักเงินเบิก/ค่าปรับ | ทุกเคสต้องตรง 100%; การเปลี่ยนผลลัพธ์ golden ต้องมีนักบัญชีลงนามใน PR |
| เลขเอกสาร | 100 คำขอออกเอกสารพร้อมกันใน series เดียว | ไม่มีเลขซ้ำ ไม่มีเลขข้าม |
| Isolation | ตาม §3 (DB + API + worker + file + MCP) | 100% ผ่านเป็น gate ของทุก PR |
| Integration | Testcontainers (Postgres+RLS จริง, Redis, MinIO); connector แต่ละตัวมี contract test กับ mock server ตามเอกสารผู้ให้บริการ; webhook signature/retry | ทุก PR |
| API contract | OpenAPI diff (breaking change → ต้อง bump major); fuzz ด้วย schema-based testing บน staging | ทุก PR / รายสัปดาห์ |
| E2E web | Playwright: สมัคร → ตั้งค่า → SO → จัดเที่ยว (กระดาน) → POD → วางบิล → ออกใบกำกับ → รับชำระ → settlement + 50 ทวิ; ทุก flow รันใน TH และสุ่ม EN/中文 | ทุก release candidate |
| E2E แอปคนขับ | Maestro/Detox บนเครื่องจริง iOS 15 + Android 8 (RAM 2 GB): เปิดโหมดเครื่องบิน → ทำงานทั้งเที่ยว → ปิดแอปกลางคัน → ต่อเน็ต → ข้อมูลครบและไม่ซ้ำ | ทุก release แอป |
| Offline sync | property-based test: ส่งเหตุการณ์สลับลำดับ/ซ้ำ/ล่าช้า → สถานะสุดท้ายเหมือนกัน (deterministic) | ทุก PR ที่แตะ ingest |
| Performance | k6 ตามเป้า §8 บน staging | ก่อนทุก release รายเดือน; ถดถอย > 20% บล็อก release |
| Security | SAST + dependency + secret scan ทุก PR; DAST (OWASP ZAP) บน staging รายสัปดาห์; pentest ภายนอกก่อน P1 และรายปี | ตาม NFR-165 |
| Accessibility | axe-core ใน E2E (0 violation ระดับ serious/critical); ตรวจ screen reader ด้วยมือในหน้าหลักทุก release ใหญ่ | |
| i18n | ตรวจ key ครบ 3 ภาษา; visual snapshot หน้าไทย (ตัดคำ, สระลอย) และ A4 | ทุก PR ที่แตะ UI/template |
| AI eval | ชุดทดสอบภาษาไทย 200–500 ตัวอย่าง (ใบสั่งงาน LINE, ใบเสร็จ, POD — ได้รับอนุญาต) วัดความแม่นระดับช่อง | เปิดฟีเจอร์เมื่อความแม่นระดับช่อง ≥ 90% และไม่มีช่องเงิน/จำนวนผิดแบบมั่นใจสูง [PROPOSED] |
| UAT | ลูกค้านำร่อง 1–2 ราย ใช้งานจริงคู่ระบบเดิม ≥ 2 สัปดาห์ก่อนเปิดขาย | ไม่มี bug Sev-1/2 ค้าง |

---

## 17. ประเด็นที่ยังต้องตัดสินใจ

| รหัส | คำถาม | ข้อเสนอเบื้องต้น |
|---|---|---|
| NFR-OPEN-1 | Data residency / ภูมิภาค cloud: เก็บข้อมูลในไทย (Bangkok region) หรือสิงคโปร์ — กระทบ PDPA ม.28, latency, ราคา, ข้อขาย Enterprise, ท.ป.116/2545 | เลือก region ในไทยถ้าผู้ให้บริการมี managed Postgres + object lock ครบ; ระบุใน Privacy Notice |
| NFR-OPEN-2 | เทคโนโลยีแอปคนขับ (native, React Native, Flutter หรือ PWA) — กระทบ OS ขั้นต่ำ, background location, offline DB | cross-platform ที่มี background location + SQLite เข้ารหัส; PWA ไม่พอสำหรับ background tracking บน iOS |
| NFR-OPEN-3 | ผู้ให้บริการแผนที่/geocoding (Google Maps, Longdo Map, OSM self-host) — ต้นทุนต่อ tenant, ความแม่นที่อยู่ไทย, การส่งพิกัดออกนอกประเทศ | ทดสอบความแม่น geocode ที่อยู่ไทย 200 ตัวอย่างก่อนเลือก |
| NFR-OPEN-4 | Service credit เมื่อต่ำกว่า SLA และ SLA ของ Starter | Business/Enterprise: เครดิต 10% ของค่าบริการเดือนนั้นเมื่อต่ำกว่า 99.9%; Starter/Growth เป็น "เป้าหมาย" ไม่มีเครดิต |
| NFR-OPEN-5 | ต้องแต่งตั้ง DPO หรือไม่ (การติดตามตำแหน่งคนขับจำนวนมากอาจเข้าข่าย "ติดตามอย่างเป็นระบบในปริมาณมาก" ม.41) | ถามฝ่ายกฎหมาย; ระหว่างนี้กำหนดผู้รับผิดชอบ privacy และช่องทางติดต่อ |
