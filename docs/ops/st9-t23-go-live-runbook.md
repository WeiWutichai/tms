# ST9-T23 — Checklist ขึ้นใช้งานจริง + Runbook (ร่าง)

> ร่าง 24 พ.ย. 2569 (lane me, `docs/uat-runbook-drafts`) · เอกสารทีม (แบบเดียวกับ `docs/perf/`, `docs/security/`) ไม่ใช่ docs v2 ของเจ้าของสินค้า
> ที่มา: `plan/01` ST9-T18/T19/T21/T22/T23 · `plan/09` §2–§5 · `plan/03` §6 · `plan/templates/release-checklist.md` · `plan/legal/` (ST9-T16) · `docs/security/st9-t13-review.md`, `st9-t15-retention.md` · `infra/monitoring/` (ST9-T19) · CLAUDE.md
> ป้าย: **FACT** = มีในโค้ด/เอกสารแล้ว · **[DECISION — lead 24 พ.ย. เพื่อ UAT, ย้อนได้]** · **[DECISION — lead 25 พ.ย. 2569, ย้อนได้]** · **[รอ cloud decision]** = เฉพาะส่วนที่ขึ้นกับผู้ให้บริการ (บัญชี/region, VM, registry, object storage off-site, secret manager, DNS, อีเมล/SMS) — เติมเมื่อตัดสินแล้ว
> 25 พ.ย. 2569 (lane ops, `ops/st0-t03-st9-t18-selfhost`): ST0-T03/ST9-T18 ทำแบบ cloud-agnostic แล้ว — container + compose + deploy/rollback + backup/restore + ซ้อมกู้คืนในเครื่อง (`plan/sign-offs/st9-t18-restore-drill.md`) · ใช้ได้กับ cloud ใดก็ได้ที่ให้ VM Linux + Docker

## 1. Checklist ขึ้นใช้งานจริง (ประตูสุดท้าย — `plan/01` ST9-T23: ติ๊กครบ + เจ้าของเซ็นก่อนเปิด production ให้ pilot)

| # | รายการ | หลักฐาน / ที่มา | เจ้าของ | ✔ |
|---|---|---|---|---|
| G-1 | เกณฑ์ go-live `plan/03` §6 ครบ: ไม่มี defect "ขวางงาน" ค้าง · "ลำบาก" มีทางเลี่ยงเขียนไว้ · tenant isolation เขียว 100% | ผล `pnpm ci:local` / GitHub CI รอบ release | Tech lead | ☐ |
| G-2 | ชุดตรวจ ST5-T25 เซ็นแล้ว + ข้อ ⏸ [ถามนักบัญชี] ปิดกับนักบัญชีของ tenant นำร่อง | `plan/sign-offs/st5-t25-ar-ap-checklist.md` | PO + นักบัญชี | ☐ |
| G-3 | UAT (ข) Standalone เซ็นแล้ว (รอบ 1 กับ tenant นำร่อง) | `plan/sign-offs/st9-t22-uat-standalone.md` | PO + นักบัญชี | ☐ |
| G-4 | UAT (ก) KRS 2 งวดผ่าน (เฉพาะ tenant KRS) | `plan/sign-offs/st9-t21-uat-krs.md` | ผู้ใช้ KRS + PO | ☐ |
| G-5 | ซ้อมกู้คืนจาก backup สำเร็จ 1 ครั้ง (จับเวลา RPO ≤ 1 ชม. / RTO ≤ 4 ชม.) | §4.4 · ST9-T18 · ซ้อมในเครื่องผ่านแล้ว 25 พ.ย. (`plan/sign-offs/st9-t18-restore-drill.md`) — ต้องซ้อมซ้ำบนเครื่อง production จริงด้วยคำสั่งชุดเดียวกัน (ดึง backup จาก off-site) | DevOps | ☐ [รอ cloud decision — เฉพาะการซ้อมซ้ำบน cloud] |
| G-6 | Monitoring + alert ทำงานบน production: จำลองคิวค้าง → ทีมได้ alert ใน 5 นาที | §4.5 · ST9-T19 | DevOps | ☐ |
| G-7 | Runbook 4 เรื่องของ `plan/09` §3: ระบบล่ม (§4.6) · connector ล้ม (§4.7) · เลขเอกสารผิด (§4.8) · ขอลบข้อมูล (§4.10) | ไฟล์นี้ | Tech lead | ☐ |
| G-8 | เลขเริ่มต้นทุกชุดเอกสารตั้งถูก (ทดสอบออก 1 ใบใน tenant ทดสอบที่คัดลอกค่า) | §3 ขั้น O-5 | PO + นักบัญชี | ☐ |
| G-9 | ผู้ใช้ทุกคนเข้าได้ · 2FA ครบทุก role ที่บังคับ (D-78) | ตั้งค่า → ผู้ใช้และสิทธิ์ คอลัมน์ "ยืนยันตัวตน 2 ชั้น" | admin ของ tenant | ☐ |
| G-10 | เอกสารสัญญา/PDPA: เงื่อนไขนำร่อง, privacy notice, DPA (`plan/legal/01-03`) ผ่านทนาย | #7, #59 | PO | ☐ |
| G-11 | ตาราง system-of-record ที่ตกลง + `syncFromDate` (tenant ที่มี connector) | §5 | PO + ลูกค้า | ☐ |
| G-12 | อบรมผู้ใช้ตามบทบาท (สคริปต์ UAT ใช้เป็นคู่มือ) + ช่องทาง support (ตอบใน 4 ชม.ทำการ — `plan/09` §2 ขั้น 6) | รายชื่อผู้เข้าอบรม | PO | ☐ |
| G-13 | แผนถอย (`plan/09` §5) แจ้งลูกค้าแล้ว: 2 สัปดาห์แรกคู่ขนานส่วนเอกสาร; export Excel ได้ตลอด | §4.9 | PO | ☐ |
| G-14 | ค่า env production ไม่มีค่าเดโม: `NODE_ENV=production`, ไม่รัน seed, `ERP_DEMO_ADAPTERS` ไม่ตั้ง, `EMAIL_TRANSPORT` จริง, `TRIP_COSTING_ENABLED` ไม่ปิด, ไม่ใช้กุญแจตัวอย่าง | `scripts/deploy/check-env.sh production` ผ่าน (deploy.sh เรียกให้ทุกครั้ง) · แม่แบบ `infra/deploy/env/*.example` | DevOps | ☐ (ค่า SMTP รอเลือกผู้ให้บริการอีเมล D-32) |

ลงนามเจ้าของ: PO ______ · Tech lead ______ · วันที่ ______

## 2. Deploy / Rollback / Migration

**FACT** ขั้นตอน release = `plan/templates/release-checklist.md` (คัดลอกต่อ release) · CI ต้องเขียวก่อน push (`pnpm ci:local`; GitHub CI รันด้วยมือ)

| ขั้น | ทำ | หมายเหตุ |
|---|---|---|
| D-1 | backup production ก่อน deploy ทุกครั้ง + ยืนยันว่าเสร็จ | `scripts/deploy.sh` ทำ base backup (`scripts/backup/base-backup.sh`) ก่อน migrate ให้เอง — ล้ม = หยุด deploy |
| D-2 | migration: service `migrate` (image `tms/migrate:<tag>`) = `prisma migrate deploy` + `bootstrap-tenants` (เท่ากับ `db:migrate:prod`) — `deploy.sh` รันให้ | **ห้าม** `prisma migrate reset` / `migrate dev` / `db:reset` บนฐานที่มีข้อมูล (CLAUDE.md) · migration ต้อง expand-only (release checklist) · ทุกตารางใหม่มี `tms_enable_tenant_rls` |
| D-3 | deploy image API + worker + web (tag เดียวกัน) + proxy · ตรวจ `/v1/readyz` = 200 | `scripts/deploy.sh <profile> <tag>` · worker ต้องขึ้นด้วย (PDF/outbox/แจ้งเตือน/reconcile) |
| D-4 | smoke: `GET /v1/health` · login · กระดานวางแผน · สร้าง SO ใน tenant demo · ออก PDF 1 ใบ · webhook test | release checklist |
| D-5 | ดู error rate / latency 15 นาที | Prometheus / alert §4.5 |
| R-1 | **Rollback = ถอย image** ไปเวอร์ชันก่อน: `scripts/deploy.sh <profile> --rollback [tag]` (ไม่ใส่ tag = tag ก่อนหน้าจาก `infra/deploy/state/<profile>.history`; ไม่รัน migration) (migration expand-only ทำให้โค้ดเก่ายังใช้ schema ใหม่ได้) — **ไม่ย้อน migration ด้วยการลบ** | ถ้า migration เสีย: เขียน migration ใหม่แก้ (forward-fix) · กู้ backup เฉพาะเมื่อข้อมูลเสียหาย (§4.4) และต้องตัดสินโดย Tech lead + PO |
| R-2 | บันทึก incident note: เวลา เหตุ ผลกระทบ | `PROGRESS.md` §Defect / Incident |

### 2.1 Environment และการติดตั้ง (ST0-T03 — cloud-agnostic)

**สิ่งที่ต้องมีบนเครื่องปลายทาง:** VM Linux (x86_64 หรือ arm64) ≥ 4 vCPU / 8 GB / ดิสก์ SSD ≥ 100 GB + Docker Engine + compose v2.17+ [DECISION — lead 25 พ.ย. 2569, ย้อนได้] (ขนาดจากผลวัด ST9-T17 + backup 30 วัน) · ผู้ให้บริการ/region ไทย [รอ cloud decision]

| ชิ้น | ไฟล์ | หมายเหตุ |
|---|---|---|
| image API + worker | `infra/deploy/api.Dockerfile` target `runtime` → `tms/api:<tag>` | worker = image เดียวกัน คำสั่ง `node dist/worker.js` · มี Chromium headless สำหรับ PDF · รันเป็นผู้ใช้ `node` |
| image migrate | target `migrate` → `tms/migrate:<tag>` | `prisma migrate deploy` + `bootstrap-tenants` เท่านั้น — ไม่มี seed / migrate dev / reset |
| image web | `infra/deploy/web.Dockerfile` → `tms/web:<tag>` | SPA เสิร์ฟด้วย Caddy + security header ของ ST9-T13 M-01 (CSP, X-Frame-Options, nosniff, Referrer-Policy) |
| ชุดบริการ | `infra/deploy/docker-compose.prod.yml` | postgres 16 (WAL archive) · backup · migrate · api · worker · web · proxy (Caddy: TLS อัตโนมัติ, `/v1/*` → api, อื่น ๆ → web, ปิด `/v1/metrics` จากภายนอก, log ตัด token — M-03) |
| ค่า env | `infra/deploy/env/db.env.example`, `app.env.example` → `infra/deploy/<profile>.db.env`, `<profile>.env` (ไม่ commit, สิทธิ์ 600) | `scripts/deploy/gen-secrets.sh <profile>` สุ่มกุญแจทั้งหมด + กุญแจ OAuth ในเครื่อง · `scripts/deploy/check-env.sh <profile>` ตรวจ G-14 |
| build | `scripts/deploy/build-images.sh [tag] [--push]` | tag = git sha · `-dirty` ห้ามใช้กับ production · push ต้องมี registry [รอ cloud decision] |
| deploy / rollback | `scripts/deploy.sh <profile> <tag>` · `scripts/deploy.sh <profile> --rollback [tag]` | D-1 → D-2 → D-3 + readyz · ประวัติ tag `infra/deploy/state/<profile>.history` |

**staging กับ production** = profile ของไฟล์ env ชุดเดียวกัน (compose project `tms-staging` / `tms-production`) [DECISION — lead 25 พ.ย. 2569, ย้อนได้]:
staging: `NODE_ENV=staging`, ตั้ง `ERP_DEMO_ADAPTERS=1` ได้, กุญแจ/ฐานแยกจาก production ทั้งหมด (ห้ามคัดลอก secret ข้าม) · production: `NODE_ENV=production`, ห้าม demo adapter · แนะนำคนละ VM (ถ้าเครื่องเดียวกันต้องเปลี่ยน `HTTP_PORT/HTTPS_PORT`)

**ติดตั้งครั้งแรก (ต่อ profile):**
1. `git clone` repo ที่ commit ของ release → `scripts/deploy/gen-secrets.sh production` → กรอก `TMS_DOMAIN`, `ACME_EMAIL`, `PUBLIC_*_BASE_URL`, SMTP → `scripts/deploy/check-env.sh production`
2. **สำรองไฟล์ env + `infra/deploy/keys-production/` ไว้นอกเครื่องทันที** (FIELD_ENCRYPTION_KEYS / BLIND_INDEX_KEY หาย = ข้อมูลเข้ารหัสในทุก backup อ่านไม่ได้) — ที่เก็บ: secret manager [รอ cloud decision]; ระหว่างนี้ password manager ของทีม [DECISION — lead 25 พ.ย. 2569, ย้อนได้]
3. `scripts/deploy/build-images.sh` (หรือ pull จาก registry) → `scripts/deploy.sh production <tag>`
4. สร้างผู้ใช้ Platform Console คนแรก (ST1-T24): `dc --profile migrate run --rm -e FIELD_ENCRYPTION_KEYS=<ค่าจาก production.env> migrate sh -c 'SWC_NODE_PROJECT=tsconfig.json node -r @swc-node/register scripts/platform-user.ts <email> "<ชื่อ>" SUPER_ADMIN'` (ใช้ alias `dc` ด้านล่าง — พิมพ์รหัสผ่านชั่วคราว + otpauth ครั้งเดียว) · **ห้ามรัน seed บน production**
5. DNS ของโดเมนชี้ IP ของ VM + เปิดพอร์ต 80/443 เท่านั้น (ฐานข้อมูลไม่เปิดออกนอก — ไม่มี port mapping) [รอ cloud decision: DNS/firewall ของผู้ให้บริการ]

**คำสั่งดูแลประจำ** (ตั้ง alias `dc='docker compose -p tms-production -f infra/deploy/docker-compose.prod.yml --env-file infra/deploy/production.db.env --env-file infra/deploy/production.env'` และ export `TMS_TAG=<tag ปัจจุบัน>` `TMS_APP_ENV_FILE=$PWD/infra/deploy/production.env`):
`dc ps` · `dc logs -f --since 15m api worker` · `dc restart worker` · `dc exec postgres psql -U tms -d tms` · `dc exec backup sh /scripts/check-backup.sh`

## 3. Onboard tenant (`plan/09` §2)

| ขั้น | ทำ | ที่ไหน (FACT) | ผู้ทำ |
|---|---|---|---|
| O-1 | สร้าง tenant + แพ็กเกจ | Platform Console `/console` (SUPER_ADMIN) → `POST /v1/platform/tenants`; หรือ signup self-serve | Innovera |
| O-2 | นิติบุคคล/สาขา (เลขผู้เสียภาษี 13 หลัก, สาขา 5 หลัก, ผู้ออกเริ่มต้น) | ตั้งค่า → นิติบุคคลและสาขา | Innovera + ลูกค้า |
| O-3 | เชิญผู้ใช้ + role (ตาราง A3) · บังคับ 2FA (D-78) | ตั้งค่า → ผู้ใช้และสิทธิ์ → เชิญผู้ใช้ | admin ลูกค้า |
| O-4 | ค่าภาษีประมาณการ (`tax.*`, ขั้นต่ำ WHT ตามคำตอบ ACC-9) · ค่าบริการเสริม (VAT/WHT ต่อรายการ) | ตั้งค่า → ภาษี · ข้อมูลหลัก → ค่าบริการเสริม | Innovera + นักบัญชี |
| O-5 | เลขที่เอกสาร: เริ่มต่อจากเล่มเดิมหรือชุดใหม่ (นักบัญชีเลือก) → ทดสอบออก 1 ใบใน tenant ทดสอบ | ตั้งค่า → เลขที่เอกสาร | นักบัญชี |
| O-6 | นำเข้าข้อมูลหลักจาก Excel: dry-run → แก้แถวผิด → commit (ลูกค้า จุดส่ง รถ คนขับ รถร่วม rate card) | หน้าข้อมูลหลักแต่ละหน้า (นำเข้า) | ลูกค้า (เราช่วย) |
| O-7 | (ถ้ามี) connector: credential, `syncFromDate` = วันแรกของงวด, mapping รหัสครบ, ทดสอบ | ตั้งค่า → การเชื่อมต่อ | Innovera |
| O-8 | ซ้อมคู่ขนาน 3–5 วัน (รับงาน → POD → วางบิลทดลองไม่ส่งลูกค้า) | สคริปต์ UAT | ลูกค้า |
| O-9 | ตัดระบบวันแรกของงวด · งานค้างระบบเดิมไม่ย้าย (ยกเว้นยอดลูกหนี้ยกมาถ้าต้องการ aging) | — | ทั้งสองฝ่าย |
| O-10 | ประคอง 4 สัปดาห์: ช่องทางตรง ตอบใน 4 ชม.ทำการ · ประชุมสั้นรายสัปดาห์ | — | Innovera |

## 4. Runbook

### 4.1 ช่องทางและบทบาท
On-call ฝั่ง Innovera รับ alert จาก §4.5 · ช่องทาง support ลูกค้า [DECISION — lead 24 พ.ย. เพื่อ UAT, ย้อนได้]: LINE กลุ่มต่อ tenant + อีเมล support ระหว่างนำร่อง; ระดับ "ขวางงาน" ต้องปิดใน 1 วันทำการ (`plan/09` §4)

### 4.2 ระดับเหตุ
ขวางงาน (ทำงานหลักไม่ได้ / เอกสารเงินผิด) → แจ้ง PO ทันที · ลำบาก (มีทางเลี่ยง) → แก้ใน release ถัดไป · เล็กน้อย → backlog · ข้อมูลรั่ว → §4.10 + `plan/legal/04-breach-response-72h.md`

### 4.3 สุขภาพระบบ
`GET /v1/health` · `healthz` / `readyz` / `metrics` (Prometheus) · Console: `/v1/platform/monitoring/{status,alerts,availability}` (ST9-T19) · หน้า Health/Dashboard เชื่อมต่อ (ST9-T04)

### 4.4 Backup / restore (ST9-T18)
เป้า (FACT `plan/01` ST9-T18): snapshot ทุก 6 ชม. + WAL เก็บ 30 วัน · ไฟล์ (PDF/POD) versioned · RPO 1 ชม. / RTO 4 ชม. · ซ้อมกู้ลง environment ใหม่ + บันทึกผล

**กลไก (FACT — `infra/deploy/docker-compose.prod.yml`, `scripts/backup/`):**
- WAL archive ต่อเนื่อง: `archive_command` = `infra/deploy/postgres/archive-wal.sh` → volume `pgbackup:/backup/wal/*.gz` · `archive_timeout=60` วิ [DECISION — lead 25 พ.ย. 2569, ย้อนได้] → ข้อมูลที่อาจหายเมื่อเครื่องล่ม ≈ ≤ 1 นาที (ถ้า archive อยู่นอกเครื่องแล้ว)
- container `backup` (`scripts/backup/backup-loop.sh`) ทุก 15 นาที: `files-sync.sh` สำเนาไฟล์ใหม่ (POD/ไฟล์แนบ) → `/backup/files-mirror` (RPO ของไฟล์ ≤ 15 นาที) · ทุก 6 ชม.: `base-backup.sh` (pg_basebackup `-Ft -z -X stream` + SHA256SUMS + meta) → `files-backup.sh` (snapshot `FILES_ROOT` = ไฟล์ versioned ตามรอบ) → `prune.sh` (เก็บ 30 วัน: base ทุกชุดในช่วง + ชุดก่อนเส้นตัด 1 ชุด, WAL ตัดด้วย `pg_archivecleanup`) → `BACKUP_OFFSITE_CMD`
- **คัดลอกออกนอกเครื่อง (off-site) [รอ cloud decision]:** ตั้ง `BACKUP_OFFSITE_CMD` ให้ sync `/backup` → object storage ของ cloud (เปิด versioning + lock/retention 30 วัน, region ไทย) และ sync WAL ถี่กว่ารอบ base (cron ทุก 5 นาที) — **ก่อนตั้งค่านี้ backup อยู่บนดิสก์เดียวกับฐาน: กันข้อมูลเสีย/ลบผิด ได้ แต่ไม่กันเครื่อง/ดิสก์หาย** → ห้าม go-live ก่อนมี off-site
- ตรวจความสด: `dc exec backup sh /scripts/check-backup.sh` (exit 1 ถ้า base > 7 ชม. หรือ WAL > 15 นาที) — ตั้ง cron/monitor ของ cloud เรียกทุก 15 นาที แล้วส่ง alert [รอ cloud decision: ช่องทาง alert]
- ไฟล์ env + กุญแจ (§2.1 ข้อ 2) ไม่อยู่ใน backup นี้ — ต้องกู้จากที่เก็บ secret แยก

**กู้คืน / ซ้อมกู้คืน (คำสั่งจริง — ซ้อมแล้ว 25 พ.ย. 2569 ดูผลใน `plan/sign-offs/st9-t18-restore-drill.md`):**
ผลซ้อมในเครื่อง (ฐาน 1.27 GB): **RPO 41 วิ · RTO 3 นาที 17 วิ** · ข้อมูลก่อนจุดกู้ครบ · ไฟล์ checksum ตรง
1. เลือกเวลาเป้า: ล่าสุด (ไม่ใส่ `--target-time`) หรือก่อนเหตุ (`--target-time '2026-11-25 10:00:00+07' --base <ชุดที่เริ่มก่อนเวลานั้น>`) — ตัดสินโดย Tech lead + PO (R-1)
2. เครื่อง/environment ใหม่: วางไฟล์ env + กุญแจชุดเดิมของ profile (รหัสผ่าน role อยู่ในฐานที่กู้ และกุญแจเข้ารหัสต้องตรงกับข้อมูล) · ดึง `/backup` จาก off-site มาไว้ในโฟลเดอร์ [รอ cloud decision: คำสั่งดาวน์โหลด]
3. `TMS_PROJECT=tms-<profile> scripts/backup/restore-env.sh <profile> --from <โฟลเดอร์ backup>` → ตรวจ checksum, เตรียม PGDATA, กู้ไฟล์จาก snapshot ล่าสุด + เติมจาก files-mirror, เริ่ม postgres → replay WAL → promote → `verify-restore.sh` (migration, จำนวนแถว, เลขเอกสารถัดไปต่อชุด) · ปฏิเสธถ้า pgdata ของ project นั้นมีข้อมูล
4. `scripts/deploy.sh <profile> <tag เดิม> --skip-backup` (migration ต้องไม่มีค้าง) → smoke D-4 + เทียบเลขเอกสารที่ออกล่าสุดกับหลักฐานต้นทาง (§4.8 — เอกสารที่ออกหลังจุดกู้ต้องตามกลับ ห้ามออกเลขซ้ำ)
5. บันทึกเวลาเริ่ม/จบ (RTO) + ข้อมูลที่หาย (RPO) ลง incident note / sign-off
**FACT:** เอกสารที่ออกเลขแล้วห้ามหาย (DELETE ถูกปฏิเสธในฐาน — `docs/security/st9-t15-retention.md`) · กู้แล้วต้องตรวจว่าเลขเอกสารไม่ซ้ำกับที่ออกหลังจุดกู้ (§4.8)
**ถ้าเลือก managed PostgreSQL ที่มี PITR** [รอ cloud decision]: ใช้ backup/PITR ของผู้ให้บริการแทน service `postgres`/`backup` (ตั้ง retention 30 วัน) แต่ยังใช้ `files-backup.sh` + ขั้น 4–5 และต้องซ้อมซ้ำ

### 4.5 Monitoring / alert (FACT ST9-T19 — `infra/monitoring/alert-rules.yml`)
| alert | หมายถึง | ทำอะไรก่อน |
|---|---|---|
| `TmsApiDown` / `TmsReadyzFailing` | API ไม่ตอบ / ฐานหรือ dependency ไม่พร้อม | §4.6 |
| `TmsHigh5xxRate` | 5xx สูง | ดู log ตาม `requestId` · release ล่าสุด → พิจารณา R-1 |
| `TmsWorkerDown` / `TmsJobLag` / `TmsEmailLag` | worker ไม่ทำงาน / งานค้าง | restart worker · ดูงานที่ล้มซ้ำ |
| `TmsOutboxLag` / `TmsOutboxBacklogAge` / `TmsWebhookFailureRate` | outbox/webhook ค้าง | §4.7 |
| `TmsConnectorUnhealthy` / `TmsConnectorLag` | connector ERP ล้ม | §4.7 |
| `TmsDiskUsage` | ดิสก์ใกล้เต็ม | `docker system df -v` · ตัวใหญ่ปกติ = volume `pgbackup` (ตรวจว่า prune ทำงาน — log ของ `backup`) และ image เก่า (`docker image prune` เฉพาะ tag ที่ไม่อยู่ใน history 3 รุ่นล่าสุด) · **ห้ามลบ WAL/base/ไฟล์เอกสารด้วยมือ** · ขยายดิสก์ [รอ cloud decision] |
| `TmsAvailabilityBelowTarget` | ต่ำกว่า 99.5% | รายงาน PO |
ปลายทาง alert: อีเมลผ่าน `MONITOR_ALERT_EMAILS` (FACT ST9-T19 — ต้องมี SMTP จริง D-32) [รอ cloud decision: ผู้ให้บริการอีเมล] · Prometheus (ถ้าใช้) เรียก `api:4410/v1/metrics` ในเครือข่าย compose ด้วย `METRICS_TOKEN` — proxy ตอบ 404 ให้ภายนอก

### 4.6 ระบบล่ม
1. ยืนยันจาก `/v1/health` + alert + `dc ps` / `dc logs --since 15m api worker postgres` (§2.1) · 2. แจ้ง tenant นำร่อง (ข้อความที่ PO อนุมัติ) · 3. ตรวจฐาน/ดิสก์/release ล่าสุด → R-1 ถ้าเกิดหลัง deploy · 4. ระหว่างล่ม: ลูกค้าใช้วิธีเดิม (แผนถอย) · ข้อมูลจากอุปกรณ์/ลิงก์ที่ส่งไม่สำเร็จ ส่งซ้ำได้ (`clientEventId` กันซ้ำ, เก็บ `occurredAt`) · 5. หลังกลับ: ตรวจคิว outbox/งานค้าง + incident note

### 4.7 Connector / ERP ล่ม (FACT ST7-T16/T19, ST8-T09/T11)
- TMS ทำงานต่อแบบ standalone เสมอ — เอกสารใหม่รอใน outbox/คิว ไม่ต้องหยุดวางบิล
- ตั้งค่า → การเชื่อมต่อ → หยุดชั่วคราว ถ้าปลายทางล่มนาน (กันคิวล้มซ้ำ) → เปิดใหม่เมื่อพร้อม
- คิวเชื่อมระบบบัญชี (`/erp`): แท็บ ล้มเหลว → ส่งซ้ำ / "ส่งซ้ำทั้งหมดที่รอ" · ล้มถาวร → ข้ามพร้อมเหตุผล / กรอกเลขเอง · AUTH → เปลี่ยน credential ("เปลี่ยน key") · ผลไม่ชัด (timeout) ระบบตรวจซ้ำก่อนส่งใหม่ (กันเอกสารซ้ำ)
- หลังกลับ: รอบ reconcile (หลัง push / รายคืน / ก่อนปิดงวด) → แท็บ "ไม่ตรง" ปิดให้ครบก่อนสิ้นเดือน · ระหว่างล่มนาน: "ส่งออกให้นักบัญชี" ให้บัญชีคีย์เอง (`plan/09` §5)

### 4.8 เลขเอกสารผิด
- ใบออกเลขแล้วแก้ไม่ได้ (CLAUDE.md) → ยกเลิกคงเลข + ออกฉบับใหม่แทน (D-20; ใบที่ส่งลูกค้า/รับชำระแล้วตามกติกาที่ PO/นักบัญชีตัดสินใน ACC-37) — ห้ามแก้เลขในฐานข้อมูลตรง
- ชุดเลขเริ่มผิด (ยังไม่ออกใบ) → แก้ที่ ตั้งค่า → เลขที่เอกสาร · ออกไปแล้ว → ปรึกษานักบัญชี บันทึกเหตุผลใน audit + incident note

### 4.9 แผนถอย (FACT `plan/09` §5)
2 สัปดาห์แรกคู่ขนานส่วนเอกสาร · ปิด connector ได้โดย TMS ยังทำงาน · export Excel ทุกตารางหลักได้ตลอดนำร่อง

### 4.10 คำขอ PDPA / เหตุข้อมูลรั่ว
- **FACT** (`plan/legal/README.md`): เครื่องมือ DSAR อัตโนมัติ = P1 — เฟส 0 ทำ**ด้วยมือตาม DPA ข้อ 7** (`plan/legal/01-dpa.md`) · Innovera = ผู้ประมวลผล, tenant = ผู้ควบคุม → คำขอจากเจ้าของข้อมูลส่งผ่าน tenant
- ขั้นตอน [DECISION — lead 24 พ.ย. เพื่อ UAT, ย้อนได้]: (1) tenant ยืนยันตัวผู้ขอ (2) ค้นข้อมูลตาม RoPA (`plan/legal/02-ropa.md`) (3) เข้าถึง/สำเนา: ส่งออกจากหน้าข้อมูลหลัก (4) ลบ/ระงับ: ผู้ใช้ → `POST /v1/users/{id}/delete` (เหตุผล + audit); คนขับ/รถร่วม → ปิดใช้งาน; **ข้อมูลในเอกสารที่ออกเลขแล้วลบไม่ได้** (หน้าที่ตามกฎหมาย — research §5.1 ม.87/3 ≥ 5 ปี) แจ้งเหตุผลกลับ (5) ปิดภายในกรอบเวลาตาม DPA และบันทึกทะเบียนคำขอ
- เหตุรั่ว: `plan/legal/04-breach-response-72h.md` (แจ้ง สคส. ใน 72 ชม. — research §5.4)

### 4.11 รีเซ็ต 2FA (FACT #81)
- ฝั่งบริษัท: admin/owner → `POST /v1/users/{id}/reset-2fa` (สิทธิ์ `users:write` + step-up 2FA ของผู้ทำ + เหตุผล; ทำกับตัวเองไม่ได้; reset owner ต้องเป็น owner) — หน้าเว็บยังไม่มีปุ่ม: ใช้ API key/Open API [DECISION — lead 24 พ.ย. เพื่อ UAT, ย้อนได้]
- ฝั่ง Innovera (เมื่อ admin ของ tenant ล็อกเอง): Console `/console` → tenant → สมาชิก → reset 2FA = `POST /v1/platform/tenants/{id}/users/{userId}/reset-2fa` (SUPER_ADMIN + step-up + เหตุผล ≥ 10) · **ต้องยืนยันตัวผู้ขอนอกระบบก่อน** (โทรกลับเบอร์ที่ลงทะเบียน/ผู้มีอำนาจของ tenant ยืนยันเป็นลายลักษณ์อักษร) [DECISION — lead 24 พ.ย. เพื่อ UAT, ย้อนได้]
- ผล: ล้าง TOTP + รหัสสำรอง, เพิกถอน session/อุปกรณ์ที่จำ, อีเมลแจ้งผู้ใช้, audit `user.2fa_reset` → login ครั้งถัดไปต้องตั้ง 2FA ใหม่

## 5. ตาราง system-of-record (ร่างต่อ tenant — กรอกตอน O-7)

| ข้อมูล | เจ้าของ (FACT ค่าตั้งต้น) | ตกลงกับลูกค้า |
|---|---|---|
| SO / งานขนส่ง | TMS (KRS: ต้นทาง SO = KRS, แก้หลังวางแผน → ใบค้าง) | |
| เลขใบแจ้งหนี้ / ใบวางบิล / ใบสำคัญจ่าย | TMS ออกเองเสมอ (D-55) | |
| เอกสารภาษี (ใบกำกับ ใบเสร็จ ใบลด/เพิ่มหนี้ 50 ทวิ) | ระบบบัญชี (D-55/D-56/D-58) | |
| สถานะรับชำระ | TMS (บันทึกเอง) หรือดึงจาก ERP (ST7-T21) | |
| ข้อมูลหลักลูกค้า/รหัส ERP | TMS + mapping (`external_mapping`) | |
| `syncFromDate` | วันแรกของงวดที่ตัดระบบ | |
