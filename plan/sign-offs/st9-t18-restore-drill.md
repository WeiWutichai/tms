# ST9-T18 — บันทึกซ้อมกู้คืน (restore drill) รอบที่ 1: ในเครื่อง (cloud-agnostic)

> ซ้อม 25 พ.ย. 2569 10:04–10:18 (เวลาไทย) · lane ops (`ops/st0-t03-st9-t18-selfhost`) · ผู้ทำ: Claude Code (lead lane ops)
> เกณฑ์ตรวจรับ (`plan/01` ST9-T18): "ซ้อมกู้คืนลง environment ใหม่สำเร็จภายใน 4 ชม. ข้อมูลหายไม่เกิน 1 ชม. มีบันทึกผล"
> **ผล: ผ่าน — RPO 41 วินาที · RTO 3 นาที 17 วินาที** (ฐาน 1.27 GB) · ขอบเขต: ซ้อมบน Docker ในเครื่อง dev ด้วย image/compose/สคริปต์ชุดเดียวกับที่จะใช้บน cloud — **ต้องซ้อมซ้ำบนเครื่อง production จริง 1 ครั้งก่อน go-live (G-5)** เพราะยังไม่มี off-site storage และเครื่องจริง [รอ cloud decision]

## 1. สภาพแวดล้อม (FACT)

| รายการ | ค่า |
|---|---|
| เครื่อง | Mac M2 8 core (arm64) · Docker Engine 29.5.2 · load average ระหว่างซ้อม 6–14 (lane อื่นรันงานพร้อมกัน — ตัวเลขเวลาจึงเป็นกรณีเครื่องไม่ว่าง) |
| image | `tms/api:drill`, `tms/migrate:drill`, `tms/web:drill` จาก `scripts/deploy/build-images.sh drill` (commit ฐาน `e64e330e` + งาน lane นี้) · ฐาน `node:20-bookworm-slim`, `postgres:16-alpine`, `caddy:2.11-alpine` |
| compose | `infra/deploy/docker-compose.prod.yml` · ต้นทาง project `tms-ops-drill-src` (proxy 127.0.0.1:6041) · ปลายทาง project `tms-ops-drill-rst` (127.0.0.1:6040) — ไม่แตะ container `tms-postgres` / ฐาน `tms` ของ dev |
| ค่า env | สร้างด้วย `scripts/deploy/gen-secrets.sh drill` (กุญแจสุ่มใหม่ทั้งหมด) · `NODE_ENV=staging` · `HIBP_ENABLED=false` (ไม่ส่งข้อมูลออกนอกเครื่อง) · ปลายทางใช้ secret ชุดเดียวกับต้นทาง (รหัสผ่าน role อยู่ในฐานที่กู้ + กุญแจเข้ารหัสต้องตรงกับข้อมูล) |
| ข้อมูล | seed เดโม (2 tenant, ผู้ใช้ 10, migration 160 ชุดถึง `0174`) + ตาราง `drill.filler` 12,000,000 แถว (เพื่อวัด throughput) + `drill.marker` (เขียน 1 แถว/~1.6 วิ เพื่อวัด RPO) → ขนาดฐาน **1,268 MB** |
| ตั้งค่า backup | WAL archive ต่อเนื่อง (`archive_timeout=60`) → `/backup/wal/*.gz` · base backup `pg_basebackup -Ft -z -X stream` · snapshot ไฟล์ `FILES_ROOT` |

## 2. ขั้นตอนและคำสั่งที่รันจริง

```bash
# 0) build + env
bash scripts/deploy/build-images.sh drill
bash scripts/deploy/gen-secrets.sh drill            # แล้วแก้ TMS_DOMAIN=:80, HTTP_BIND=127.0.0.1, HTTP_PORT=6041, PUBLIC_*_BASE_URL, SMTP ทดสอบ
bash scripts/deploy/check-env.sh drill              # ✓ env ของ drill ผ่าน

# 1) ขึ้นต้นทาง (deploy ปกติ: D-1 backup → D-2 migrate → D-3 up → readyz)
TMS_PROJECT=tms-ops-drill-src bash scripts/deploy.sh drill drill
#   [09:57:51] D-1 base backup ก่อน deploy … [09:57:54] D-2 migration … No pending migrations to apply.
#   [09:58:43] ตรวจ /v1/readyz → 200 {"status":"ok","db":"ok","migrations":"ok","worker":"ok","workerHeartbeatAgeSec":12}
#   seed (เฉพาะซ้อม — ห้ามบน production): dc --profile migrate run --rm -e NODE_ENV=development … migrate … prisma/seed.ts → seed ok { tenants: 2, companies: 3 }

# 2) ไฟล์ทดสอบใน FILES_ROOT + base backup + snapshot ไฟล์
dc exec -T api sh -c 'mkdir -p /data/files/drill && date -u +%FT%TZ > /data/files/drill/marker.txt && sha256sum /data/files/drill/marker.txt'
#   d1026a6c97cd710fbf1d35ba1ce580289df90fef734acd24fb09d1aff61cf296
dc exec -T backup sh /scripts/base-backup.sh
#   base-backup: /backup/base/20261125T030450Z (116 วิ, start WAL 0000000100000000000000AA) · SIZE_BYTES=710279168 (677 MB บีบอัด)
dc exec -T backup sh /scripts/files-backup.sh
#   files-backup: /backup/files/files-20261125T030815Z.tar.gz

# 3) งานเขียนหลัง base backup (ต้องกู้จาก WAL): marker ทุก ~1.6 วิ ตั้งแต่ 03:08:15Z
#    นับแถวก่อนเหตุ: audit_log=144 tenant=2 app_user=10 filler=12000000

# 4) เกิดเหตุ 03:11:26Z: SIGKILL postgres แล้วลบ volume ข้อมูลฐาน (จำลองดิสก์ฐานข้อมูลเสีย) — volume backup คงอยู่ (แทน off-site)
docker kill tms-ops-drill-src-postgres-1
dc stop api worker web proxy backup && dc rm -f postgres && docker volume rm tms-ops-drill-src_pgdata
#   marker สุดท้ายที่ commit สำเร็จก่อนเหตุ: 153 | 2026-11-25 03:11:26.636+00

# 5) กู้ลง environment ใหม่ (เริ่มจับ RTO 03:11:43Z)
TMS_PROJECT=tms-ops-drill-rst bash scripts/backup/restore-env.sh drill-restore --from-volume tms-ops-drill-src_pgbackup
#   ใช้ base 20261125T030450Z · base.tar.gz: OK · pg_wal.tar.gz: OK · backup_manifest: OK · ไฟล์: กู้จาก files-20261125T030815Z.tar.gz: OK
#   [10:13:42] เริ่ม postgres → replay WAL → promote   (log: redo starts at 0/AA28D2D0 … redo done at 0/C2006B88 elapsed: 16.93 s)
#   [10:14:05] promote แล้ว — verify-restore.sh: in_recovery=f timeline_id=2 · migration applied=160 broken=0 latest=0174_notification_regroup_fn
#              tenant tables=101 total rows=700 · tenant 2 · app_user 10 · audit_log 144
TMS_PROJECT=tms-ops-drill-rst bash scripts/deploy.sh drill-restore drill --skip-backup
#   No pending migrations to apply. · tenants:bootstrap — 2/2 tenant OK
#   [10:14:47] /v1/readyz → 200 {"status":"ok","db":"ok","migrations":"ok","worker":"ok","workerHeartbeatAgeSec":10}

# 6) smoke (D-4 บางส่วน) — Chromium ใน container api ผ่าน proxy (ตัดคำขอออกนอกเครื่อง)
curl http://127.0.0.1:6040/v1/healthz                       # {"status":"ok"} 200
#   login viewer@demo-a.test ผ่านหน้าเว็บ → ไปหน้า "ภาพรวม" ได้ (กระดาน/SO/DO/บัญชี ในเมนู) · ไม่มี error ของ CSP (มีแค่ 401 ของ refresh ก่อน login ซึ่งปกติ)
dc exec -T api sha256sum /data/files/drill/marker.txt       # d1026a6c…f296 ตรงกับต้นทาง
#   จบ RTO 03:15:00Z
```

## 3. ผลวัด

| ตัววัด | เป้า (plan/01) | ผล | หมายเหตุ |
|---|---|---|---|
| **RPO** (ข้อมูลที่หาย) | ≤ 1 ชม. | **41.1 วินาที** — marker ล่าสุดที่กู้ได้ 122 @ 03:10:45.538 เทียบที่ commit ก่อนเหตุ 153 @ 03:11:26.636 (หาย 31 แถว) | หายเฉพาะ WAL segment ปัจจุบันที่ยังไม่ archive — เพดาน ≈ `archive_timeout` 60 วิ · บน cloud = รอบ sync WAL ไป off-site (เสนอ ≤ 5 นาที) |
| **RTO** (เริ่มกู้ → ระบบใช้งานได้) | ≤ 4 ชม. | **197 วินาที (3 นาที 17 วิ)** | คัดลอก+ตรวจ checksum+แตก base 117 วิ · replay WAL ~383 MB + promote 23 วิ · deploy (migrate ไม่มีค้าง + ขึ้นแอป + readyz) 45 วิ · smoke 10 วิ |
| RPO ของไฟล์ | ≤ 1 ชม. | ≤ 15 นาที (รอบ `files-sync`) — ซ้อมย่อยข้อ 4.6 | ก่อนแก้ = ≤ 6 ชม. (รอบ snapshot) |
| ข้อมูลที่ไม่ควรหาย | ครบ | **ครบ** — audit_log 144 = 144, tenant 2 = 2, app_user 10 = 10, filler 12,000,000 = 12,000,000, migration 160 ไม่มีค้าง, ไฟล์ทดสอบ sha256 ตรง | งานเขียนก่อนจุด 03:10:45 ทุกแถวกลับมาครบ |
| base backup (1.27 GB) | ทุก 6 ชม. | pg_basebackup 116 วิ → 677 MB | รอบแรกใช้เวลารวม 205 วิ เพราะสคริปต์แตก tar 2 รอบหา START WAL — **แก้แล้ว** (อ่านจาก `pg_basebackup -v`): รอบถัดไปบนฐานที่กู้ 127 + 14 วิ, START WAL `0000000200000000000000C4` ถูกต้อง |
| rollback image (R-1) | — | 41 วิ (`deploy.sh drill-restore --rollback` → กลับ tag `drill` จาก `drill-b`, readyz 200) | ไม่รัน migration |

**ประมาณการขนาดที่ยังผ่าน RTO 4 ชม.** (ข้อเสนอ ไม่ใช่ FACT): ช่วงกู้ฐานในซ้อมนี้ ≈ 10.8 MB/วิ ของขนาดฐาน (เครื่องไม่ว่าง) + replay WAL ~23 MB/วิ → ฐานถึง ~100 GB + WAL 6 ชม. ยังอยู่ในกรอบ (กินเวลา ≈ 3 ชม.) · ขนาดคาดของ pilot (≤ 200 คัน) ต่ำกว่านี้หลายเท่า · ต้องวัดซ้ำบนเครื่องจริงเพราะความเร็วดิสก์/เครือข่ายดาวน์โหลดจาก off-site เป็นตัวกำหนด

## 4. สิ่งที่พบระหว่างซ้อมและแก้แล้ว (ใน lane นี้)

1. image ไม่มี `openssl` → Prisma โหลด engine ไม่ขึ้น (API unhealthy) → เพิ่ม openssl ทั้ง stage build/runtime
2. `ACME_EMAIL` ว่าง → Caddy อ่าน config ไม่ได้ (proxy restart วน) แต่ `deploy.sh` ยังรายงานสำเร็จ → ตั้งค่าเริ่มใน compose + `check-env.sh` บังคับเมื่อใช้โดเมนจริง + `deploy.sh` ตรวจ proxy → web หลัง readyz
3. `respond /v1/metrics 404` ไม่มีผลเพราะลำดับ directive → ย้ายเป็น `handle /v1/metrics` (ตรวจแล้ว: ภายนอกได้ 404)
4. base-backup ช้าเพราะแตก tar 2 รอบ → อ่าน START WAL จาก `pg_basebackup -v`
5. restore-env สร้าง volume `files` นอก compose (มีคำเตือน) → สร้าง volume ผ่าน compose ก่อน
6. (ทบทวนหลังซ้อม) snapshot ไฟล์ทุก 6 ชม. ทำให้ RPO ของไฟล์ที่ผู้ใช้อัปโหลด (POD/ไฟล์แนบ — render ใหม่ไม่ได้) สูงถึง 6 ชม. เกินเป้า 1 ชม. → เพิ่ม `scripts/backup/files-sync.sh` สำเนาไฟล์ใหม่ทุก 15 นาที (`FILES_SYNC_MINUTES`) และ `restore-env.sh` เติมไฟล์จาก mirror หลังแตก snapshot · **ซ้อมย่อยยืนยันแล้ว 10:21–10:22** (project `tms-ops-drill-mini` → `tms-ops-drill-minir`): ไฟล์ใน snapshot (`a.txt`) + ไฟล์ที่เพิ่มหลัง snapshot (`b.txt`, `sub/c.txt` โฟลเดอร์ย่อยใหม่) กลับมาครบ เจ้าของ uid 1000 · พบและแก้: busybox `cp -n` ข้ามโฟลเดอร์ที่มีอยู่แล้วทั้งก้อน → ไล่ทีละไฟล์

ตรวจเพิ่ม: header ของเว็บตาม ST9-T13 M-01 (CSP, X-Frame-Options DENY, nosniff, Referrer-Policy no-referrer, HSTS) มีจริงจาก `curl -I` · access log ของ proxy ตัด token (M-03): `/v1/public/tracking/REDACTED/x?sig=REDACTED&t=REDACTED&q=1`, `/link/pod/REDACTED` · `check-env.sh` ปฏิเสธ `NODE_ENV=development`, กุญแจ dev, `AUTH_DEV_SECRET` (rc=1) · `platform-user.ts` สร้างผู้ใช้ Console ผ่าน image migrate ได้

## 4.1 แก้ตาม review อิสระ (25 พ.ย. 10:30–10:45) และตรวจซ้ำบน Docker (project `tms-ops-drill-ck` / `-ckr`, image `t1` build ใหม่)

| ข้อ | แก้ | ตรวจอย่างไร / ผล |
|---|---|---|
| B1 `check-env.sh` ใช้ `stat -f %Lp` ก่อน → บน Linux (GNU) ได้ข้อมูล file system ไม่ใช่สิทธิ์ → deploy ล้มทุกครั้ง | ใช้ `stat -c %a` ก่อน แล้วค่อย BSD | รันใน `node:20-bookworm-slim` (stat GNU coreutils 9.1): ไฟล์ 600 → `✓ env ของ cktest ผ่าน` rc=0 · chmod 644 → `✗ … ควรมีสิทธิ์ 600 (ตอนนี้ 644)` rc=1 · macOS ยังผ่าน |
| B2 rollback หา "tag ปัจจุบัน" จาก history (บันทึกเฉพาะที่สำเร็จ) → deploy ล้มแล้ว rollback ข้าม / rollback ซ้ำเด้ง | อ่าน tag จาก image ของ container api ที่รันจริง (`docker inspect`) · history บันทึก `deploy`/`rollback`/`failed-*` · เป้า = เล่นซ้ำเป็น stack แล้วตัด tag ที่รันอยู่ · `--wait-timeout` (DEPLOY_WAIT_SEC 300) | deploy t1 ✓ → t2 ✓ → t3 (api พังโดยตั้งใจ) ล้ม rc=1 บันทึก `t3 failed-deploy`, api รัน `tms/api:t3` → `--rollback` = **t3 → t2** (readyz 200) → `--rollback` = **t2 → t1** (200) → `--rollback` = "ไม่พบ tag ก่อนหน้า (กำลังรัน: t1)" · ทดสอบ logic เพิ่ม 6 กรณี (รวม redeploy tag เดิม, rollback แล้ว deploy ใหม่) |
| registry อ่านจาก shell เท่านั้น | อ่านจาก `<profile>.db.env` ด้วย | ตรวจโค้ด |
| access log ไม่ตัด `/t/<token>` | เพิ่มใน regexp · `handle /v1/metrics*` | `/t/TRACKSECRET99` → log `"/t/REDACTED"` (ไม่พบ token ใน log) · `/v1/metrics` และ `/v1/metrics/x` → 404 |
| ค่า recovery ค้างใน `postgresql.auto.conf` หลัง promote | `restore-env.sh`: `ALTER SYSTEM RESET restore_command, recovery_target_*` + `pg_reload_conf()` · เพดานรอ `RESTORE_WAIT_SEC` (3600) | หลังกู้: `restore_command=''`, `recovery_target_time=''` (ที่เหลือ = ค่าเริ่มของ PostgreSQL) · ไม่มีบรรทัด recovery ใน auto.conf (0) |
| `files-sync` อาจสำเนาไฟล์ที่เขียนไม่เสร็จ (แล้วไม่ทับอีกเลย) | ข้ามไฟล์ที่แก้ < `FILES_SYNC_MIN_AGE_MIN` (2) นาที | ไฟล์ที่เพิ่งเขียน `fresh.txt` ถูกข้าม · ไฟล์เก่า `smoke.pdf` ถูกสำเนา |
| PDF ใน image api ยังไม่ได้ทดสอบ | — | `PdfRenderer.pdf(sampleDocument)` ใน container api: **ได้ PDF 32,302 byte (`%PDF-1.4`) ใน 3.8 วิ ฝังฟอนต์ Sarabun** — Chromium headless + ฟอนต์ใน image ใช้ได้ (ยังไม่ได้ทดสอบ PDF ของเอกสารจริงผ่าน worker job) |
| runbook ส่ง `FIELD_ENCRYPTION_KEYS` ทางบรรทัดคำสั่ง | export จากไฟล์ใน subshell + `-e ชื่อ` (ไม่มีค่า) | ตรวจโค้ด |
| nits | `.dockerignore` กัน `keys-*/`, `state/` · กุญแจ OAuth 700/600 เสมอ + แจ้ง `sudo chown 1000` บน Linux · prune `.inprogress-*` > 1 วัน | api/worker อ่านกุญแจ 700/600 บน Docker Desktop ได้ (deploy t1/t2 ผ่าน) |

**ข้อจำกัดที่ทราบ (ยังไม่แก้):** busybox `test \<` / `ls | grep` ในสคริปต์ backup (ชื่อไฟล์ระบบสร้างเอง) · การซ้อมใช้ volume backup บนเครื่องเดียวกันแทน off-site · ตัวเลขเวลาวัดขณะเครื่องไม่ว่าง · ไม่ได้ทดสอบ TLS จริง (ใช้ `TMS_DOMAIN=:80`)

## 5. เก็บกวาด

รอบ review: ลบ project `tms-ops-drill-ck`/`-ckr`, volume, image `tms/*:t1–t3`, ไฟล์ env/กุญแจ/state ของการตรวจแล้ว · `docker compose … down -v` ทั้ง 2 project + ลบ volume/network/image `tms/*:drill*` + ลบไฟล์ env/กุญแจของซ้อม · `tms-postgres` (dev) ยัง Up ตามเดิม

## 6. ยังต้องทำบน cloud (รอบที่ 2 — ก่อนติ๊ก G-5)

- ตั้ง `BACKUP_OFFSITE_CMD` + sync WAL ไป object storage (versioning/lock 30 วัน, region ไทย) [รอ cloud decision]
- ซ้อมซ้ำด้วยคำสั่งข้อ 5–6 บน VM ใหม่ โดยดึง backup จาก off-site (`restore-env.sh --from <dir>`) — จับเวลารวมช่วงดาวน์โหลด
- ตั้ง cron เรียก `check-backup.sh` + ส่ง alert [รอ cloud decision: ช่องทาง alert/อีเมล]

ลงนาม: DevOps ______ · Tech lead ______ · วันที่ ______
