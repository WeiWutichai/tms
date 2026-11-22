# ST9-T17 รายงานทดสอบประสิทธิภาพ (เทียบเป้า NFR Performance)

> สถานะ: **เครื่องมือ + วิธีวัดเสร็จ · ตัวเลขผลจริงยังไม่ได้วัด (รอเครื่องว่าง)** — 22 พ.ย. 2569
> ที่มาของเป้า: `docs/04` §J NFR "Performance" (ตัวตัดสิน) · `spec/11` §8 (NFR-703–714, ทั้งหมด [PROPOSED] ใช้ประกอบ)
> แยก **FACT** (สิ่งที่วัด/อ่านจากโค้ดหรือ EXPLAIN จริง) กับ **ข้อเสนอ** ชัดเจนในแต่ละหัวข้อ

## 1. สรุป

| # | เป้า (docs/04) | ผล | สถานะ |
|---|---|---|---|
| 1 | ตาราง 10,000 แถว < 2 วิ (cursor paging) | รอวัด | **ยังไม่ได้วัด** |
| 2 | finalize invoice 500 DO < 5 วิ | รอวัด | **ยังไม่ได้วัด** |
| 3 | invoice run 2,000 DO (job) < 2 นาที | รอวัด | **ยังไม่ได้วัด** |
| 4 | API p95 < 300 ms | รอวัด | **ยังไม่ได้วัด** |
| 5 | webhook ส่งภายใน 5 วิหลัง event | รอวัด | **ยังไม่ได้วัด** |

**FACT — ทำไมยังไม่มีตัวเลข:** ตลอดช่วงที่ทำงานนี้ (22 พ.ย. 10:19–13:22) เครื่องพัฒนา (Apple M2 8 core, 16 GB) มี load average
13–115 (CI ของ lead + agent อีก 3 lane, swap เกือบเต็ม) — เกินเพดานที่ตั้งไว้ (≤ 12 ต่อส่วน, lead กำหนดใหม่: load 5 นาที < 8)
lead สั่งหยุดการวัดและจะนัดรันบนเครื่องว่าง · ตัวเลขที่ได้จากการลองสคริปต์ช่วง load 50–95 **"วัดขณะเครื่องโหลดสูง — ใช้ไม่ได้"**
จึงไม่ใส่ในตารางผล (ดู §6 เฉพาะสิ่งที่ยังใช้เป็นหลักฐานได้)

**FACT — สิ่งที่พบและแก้แล้วระหว่างเตรียมการวัด (ไม่ขึ้นกับโหลดเครื่อง):** query ของคิวพร้อมวางบิล (`GET /v1/invoices/queue`,
และ `readyForRun` ของ invoice run) เป็น O(n²) — แก้ใน PR นี้ (§4.1)

## 2. วิธีวัด (รันซ้ำได้)

```
pnpm --filter @tms/api perf            # seed แล้ววัดครบ (ค่าเริ่ม)
pnpm --filter @tms/api perf seed       # ลบ/สร้างฐาน *_perf ใหม่ + ข้อมูลตั้งต้น
pnpm --filter @tms/api perf run        # วัด (ธง: --only=lists,mixed,webhook,finalize,run,web · --web · --force · --max-load=12 · --out=ไฟล์)
```

- **ไม่อยู่ใน `pnpm ci:local`** (ใช้เวลาหลายนาที + ผลขึ้นกับโหลดเครื่อง) · ต้องมี PostgreSQL จาก `pnpm db:up` และ `.env`
- ฐาน: `<ฐาน dev>_perf` (เช่น `tms_perf`, lane lv = `tms_lv_perf`) — สคริปต์ปฏิเสธฐานที่ชื่อไม่ลงท้าย `_perf` · ไม่แตะฐาน dev/test/e2e
- พอร์ต: API = `API_PORT`+2 · ตัวรับ webhook = +3 · เว็บ (เฉพาะ `--web`) = +4 · ไม่มีคำขอออกนอกเครื่อง
- ไฟล์: `apps/api/scripts/perf/{cli.mjs,lib.ts,seed.ts,run.ts,web.ts}` · ผล JSON + log ของ API/worker อยู่ที่ `apps/api/.data/perf/` (ไม่ commit)

### 2.1 ข้อมูลตั้งต้น (`seed.ts`) — ผลเท่าเดิมทุกครั้ง (ไม่มีค่าสุ่ม)

1. สร้างฐานใหม่ → `db:migrate` (ทางเดียวกับทุกที่) → tenant ผ่าน `createTenantWithDefaults`
2. **ผ่าน API จริง (role แอป + RLS):** ลูกค้า 46 ราย, จุดรับ-ส่ง, rate card (อนุมัติ), รถ + คนขับ 20 ชุด, งานตัวอย่าง 2 ใบเต็มวงจร
   (ใบสั่ง → DO → เที่ยว → assign/dispatch → ถึง/ส่งสำเร็จ → ส่งบัญชี) และร่าง → ออกใบแจ้งหนี้จริง 1 ใบ (รวม render PDF)
3. **ขยายด้วย bulk insert (connection เจ้าของฐาน):** clone แถวตัวอย่างด้วย `jsonb_populate_record` — id ใหม่ = `md5(id ตัวอย่าง + ลำดับ)`
   จึงได้ทุกคอลัมน์/snapshot แบบที่ระบบสร้างเอง · ใบแจ้งหนี้ย้อนหลังเขียนด้วย `session_replication_role = replica`
   (trigger ของเอกสารไม่ยอมให้เขียนใบที่ออกแล้วตรง ๆ) · จบด้วย `ANALYZE`

| ชุดข้อมูล (tenant เดียว) | จำนวน | ใช้วัด |
|---|---|---|
| ใบสั่งขนส่ง = DO = เที่ยว (1:1:1) + จุด/บรรทัด/ราคา/บรรทัดรายได้ | 10,002 ต่อชนิด | รายการ 10,000 แถว, API p95 |
| — รอบ A: DO ส่งบัญชีแล้ว พร้อมวางบิล (do_date ต.ค. 2569) ลูกค้า MONTHLY 24 ราย | 2,000 | invoice run |
| — รอบ B: DO พร้อมแต่ยังไม่ส่งบัญชี (ก.ย. 2569) ลูกค้าชุดเดียวกัน | 2,000 | invoice run แบบ `releaseDeliveryOrders` |
| — ลูกค้า "ใบใหญ่ 500" / "ใบใหญ่ 200" (MANUAL — ไม่เข้ารอบ) | 500 / 200 | finalize |
| — ประวัติ: PLANNED 10% · DISPATCHED 10% · POD_PENDING 10% · BILLED 70% (ลูกค้า 20 ราย) | 5,300 | รายการ/ตัวกรอง |
| ใบแจ้งหนี้ย้อนหลัง (DRAFT 5% · CANCELLED 5% · ISSUED 35% · PARTIALLY_PAID 5% · PAID 50%) + บรรทัด 13,711 | 10,001 | รายการ invoices |

การกระจายลูกค้าของรอบวางบิล: 2 ราย × 450 DO (ใกล้ใบ KRS จริง 446 รายการ) + 22 ราย × 50 DO · `updated_at` ห่างกันแถวละ 30 วินาที
(keyset ไม่มีค่าซ้ำ และสร้าง cursor ลึกได้โดยไม่ต้องไล่หน้า)

### 2.2 การวัด (`run.ts`)

เปิด **API + worker เป็น process แยก** (โค้ดเดียวกับ dev: `src/main.ts`, `src/worker.ts`; `NODE_ENV=development`, rate limit **เปิด**
ตามค่าเริ่ม, `MONITOR=off`) แล้วยิง HTTP จริงด้วย dev token ของ tenant ทดสอบ — เวลา = ส่งคำขอ → อ่าน body ครบ (รวม JSON ทั้งก้อน)

| ส่วน | วิธี | เทียบเป้า |
|---|---|---|
| `lists` | orders / delivery-orders / trips / invoices: หน้าแรก 50 · ล่าสุดก่อน 10 (ค่าที่หน้าเว็บใช้) · cursor ลึก (แถวที่ 9,000) · กรองสถานะ/ลูกค้า/ช่วงวันที่/รถ · หน้า 200 · `/summary` · คิวพร้อมวางบิล 3 แบบ · ค้นหา ⌘K — อุ่น 2 + วัด 20 ครั้งต่อแบบ ห่าง 75 ms · และไล่ครบ 10,000 แถวหน้าละ 200 (ข้อมูลประกอบ) | ทุกแบบ max < 2 วิ และ p95 < 300 ms |
| `mixed` | ผู้ใช้ 3 คนพร้อมกัน 40 วิ (~40 คำขอ/วิ — ใต้เพดาน rate limit ต่อบริษัท 50/วิ): รายการ 30% · รายการ+กรอง 23% · คิว 3% · อ่านรายการเดียว 35% · summary/master/ค้นหา 9% — ลำดับคำขอกำหนดตายตัว (LCG) | p95 รวม < 300 ms, ไม่มี error |
| `webhook` | endpoint จริง (`POST /v1/webhooks`) ชี้ตัวรับ HTTP ในเครื่อง → `POST /v1/orders` 12 ครั้ง → เวลา "API ตอบ 201 → ตัวรับได้ `order.created`" (+ นับจากส่งคำขอ และจาก `domain_event.created_at`) · เก็บเวลา `invoice.finalized` / `job.completed` จากส่วนถัดไปด้วย | max < 5 วิ, ไม่มีรายการตกหล่น |
| `finalize` | ผู้เตรียม: `POST /invoices` 200 DO + `POST /invoices/{id}/delivery-orders` 200 + 100 → ผู้ออก (คนละคน — กฎแบ่งหน้าที่): `POST /finalize` · แยกเวลา: คำขอ→`issued_at`, `issued_at`→PDF ต้นฉบับเก็บ, งาน `invoice.render_pdf` (สำเนา — เวลา render 1 ฉบับล้วน), ดาวน์โหลด PDF · ทำซ้ำกับใบ 200 DO | `POST /finalize` < 5 วิ (รายงาน PDF แยก) |
| `run` | `POST /v1/invoice-runs` (MONTHLY) → poll `/v1/jobs/{id}` — รอบ A (ส่งบัญชีแล้ว) และรอบ B (`releaseDeliveryOrders: true`) · ตรวจว่า DO เข้าร่างครบ 2,000 · แยกเวลารอคิว/ทำงาน | สั่ง → จบ < 2 นาที |
| `web` (`--web`) | vite dev + Chromium: login ผู้ใช้ viewer → หน้า `/so` `/do` `/trips` `/bill` จับเวลา "เริ่มนำทาง → แถวแรกของตารางแสดง" ทั้งโหลดเต็มหน้าและเปลี่ยนหน้าในแอป (5 ครั้ง) — vite dev ไม่ minify จึงเป็นขอบบน | < 2 วิ |

- **กันผลเพี้ยน:** ก่อนแต่ละส่วนรอจน load average 1 นาที ≤ `--max-load` (ค่าเริ่ม 12; lead กำหนดให้รันจริงเมื่อ load 5 นาที < 8 →
  ใช้ `--max-load=8`) สูงสุด 10 นาที · ผลทุกส่วนบันทึก load ก่อน/หลัง + สเปกเครื่อง + รุ่น Node/PostgreSQL ลง JSON
- **หา query ช้า:** seed ตั้ง `log_min_duration_statement = 150` เฉพาะฐาน perf → อ่านจาก `docker logs tms-postgres` แล้ว
  `EXPLAIN (ANALYZE, BUFFERS)` ด้วย role `tms_app` + `set_config('app.tenant_id', …)` (ผ่าน RLS เหมือนแอป)
- **รันซ้ำ:** `finalize` และ `run` ใช้ข้อมูลหมดไป (สคริปต์จำไว้ใน `state.json` และปฏิเสธรันซ้ำ) → รันใหม่ = `perf all`

### 2.3 ข้อจำกัดของวิธีนี้ (FACT)

- เครื่องเดียวรันทั้ง PostgreSQL (Docker), API, worker, ตัวยิง — ไม่มี network latency จริง ไม่มี TLS/proxy · `shared_buffers` 128 MB,
  `work_mem` 4 MB (ค่าเริ่มของ image) · ผลเป็นของเครื่อง dev ไม่ใช่ staging (`spec/11` §16 กำหนด k6 บน staging ก่อน release)
- tenant เดียว — ยังไม่ได้วัด "100 tenant / 50,000 order ต่อเดือน" (docs/04 NFR ขนาด) → ticket P-4
- งานอ่านเท่านั้นใน `mixed` (ไม่มีงานเขียนแทรก) · หน้าเว็บวัดด้วย vite dev
- ข้อมูลประวัติเป็น clone: ไม่มี stop_event / audit / POD ต่อแถว (หน้า detail ของแถว clone เบากว่าของจริงเล็กน้อย),
  ทุกใบสั่งมี 1 บรรทัด 2 จุด, เที่ยวละ 1 DO

## 3. ผลเทียบเป้า — รอวัด

เติมจากผลของ `perf run` (ตาราง markdown ที่สคริปต์พิมพ์ + JSON) เมื่อรันบนเครื่องว่าง:

| รายการ | ผล (p50 / p95 / max) | เป้า | ผ่าน | load ขณะวัด |
|---|---|---|---|---|
| รายการ orders / delivery-orders / trips / invoices (8 แบบต่อรายการ) | _รอวัด_ | max < 2 วิ · p95 < 300 ms | – | – |
| คิวพร้อมวางบิล (4,700 DO พร้อม) | _รอวัด_ (หลังแก้ §4.1) | เดียวกัน | – | – |
| API p95 งานอ่านผสม | _รอวัด_ | p95 < 300 ms | – | – |
| Webhook event → ผู้รับ | _รอวัด_ | < 5 วิ | – | – |
| Finalize 500 DO / 200 DO (+ PDF แยก) | _รอวัด_ | < 5 วิ | – | – |
| Invoice run 2,000 DO (A / B) | _รอวัด_ | < 2 นาที | – | – |
| เว็บ: ตาราง 4 หน้า | _รอวัด_ | < 2 วิ | – | – |

เกณฑ์ตรวจรับของ task ("รายงานผลเทียบเป้าทุกข้อ; ข้อที่ไม่ผ่านมี ticket + แผนแก้") **ยังไม่ครบ** จนกว่าจะเติมตารางนี้

## 4. สิ่งที่พบ

### 4.1 คิวพร้อมวางบิลเป็น O(n²) — **แก้แล้วใน PR นี้** (ticket P-1)

**FACT (EXPLAIN จริง, ฐาน perf, role `tms_app` + RLS, DO ที่ส่งถึงแล้ว 5,231 ใบ / พร้อมวางบิล 4,701 ใบ):**
`readinessCte` ของ `BillingQueueService` รวมบรรทัดรายได้ของ DO ทุกใบใน CTE `rl` (GROUP BY) แล้ว `LEFT JOIN rl ON rl.id = d0.id`
planner ประเมินจำนวนแถวต่ำ จึงเลือก nested loop ที่**คำนวณ `rl` ทั้งก้อนซ้ำต่อ DO**:

```
->  Nested Loop Left Join (actual time=2590.301..56793.272 rows=4701 loops=1)
      Join Filter: (l.delivery_order_id = d_1.id)
      Rows Removed by Join Filter: 12321789
      ->  GroupAggregate (actual time=0.554..10.250 rows=2622 loops=4701)
Execution Time: 59051.575 ms        (Buffers: shared hit=68848 read=944)
```

หลังแก้ (บรรทัดรายได้ต่อ DO ด้วย `LEFT JOIN LATERAL` — ใช้ index `revenue_line(tenant_id, delivery_order_id)` ต่อแถว):

```
->  Aggregate (actual time=0.021..0.021 rows=1 loops=4701)
      ->  Index Scan using revenue_line_tenant_id_delivery_order_id_idx on revenue_line l (rows=1 loops=4701)
Execution Time: 461.441 ms
```

- เวลาทั้งสองค่าวัดติดกันขณะ load ~65–95 (**ค่าสัมบูรณ์ใช้ไม่ได้** — ต้องวัดใหม่) แต่**รูปแผน**และจำนวนแถวที่ทิ้ง 12.3 ล้านแถว
  ไม่ขึ้นกับโหลด: งานโตตามกำลังสองของจำนวน DO ที่ส่งถึงแล้วยังไม่วางบิล
- ผลกระทบเดิม: `GET /v1/invoices/queue` (หน้าคิว + การ์ด "ค้างวางบิล" ของ Dashboard บิล — query นี้รัน 2 รอบต่อคำขอ: หน้า + ยอดรวม),
  `readyForRun` ของ invoice run, `readiness` ตอนส่งบัญชี/ดึง DO เข้าร่าง · ตอนลองสคริปต์ API ตอบ 503 `service_busy` กับคิวไม่กรองลูกค้า
- แก้: `apps/api/src/modules/invoices/billing-queue.service.ts` — ผลลัพธ์เท่าเดิม (aggregate ไม่มี GROUP BY คืน 1 แถวเสมอ:
  ไม่มีบรรทัด → `n = 0`, `total/prov/locked` = NULL → `coalesce` เดิมครอบแล้ว) · ไม่มี migration
- **ค้างตรวจ:** test ที่ครอบ (`billing-queue`, `invoice-runs`, `billing-dashboard`, `invoices-draft`, `billing-lifecycle`) รันแล้ว
  **ล้มที่ `beforeAll` timeout 60 วิ ทั้ง 5 ไฟล์เพราะเครื่องโหลดสูง (ไม่มี test ใดได้รัน)** — ต้องรันใหม่บนเครื่องว่างก่อน merge

### 4.2 จุดเสี่ยงที่อ่านพบจากโค้ด — ยังไม่ได้วัด (ไม่นับเป็น "ไม่ผ่าน" จนกว่าจะมีตัวเลข)

| # | FACT จากโค้ด | ส่วนที่จะบอกผล |
|---|---|---|
| R-1 | คิวพร้อมวางบิลประเมินความพร้อมของ DO ที่ส่งถึงแล้ว**ทุกใบ**ก่อน `ORDER BY … LIMIT` และรัน CTE เดิมอีกรอบเพื่อยอดรวมต่อลูกค้า — หลังแก้ §4.1 ยังเป็น O(n) ต่อคำขอ (461 ms ต่อรอบขณะเครื่องโหลด) | `lists` คิว |
| R-2 | `InvoicesService.verifyReady` วนทีละ DO: `readiness` (1 query) + `pod.checkCurrent` (1 query) → ดึง 200 DO = ≥ 400 query ใน transaction เดียว | `finalize` (ขั้นร่าง), `run` |
| R-3 | `POST /finalize` render PDF ต้นฉบับ**ในคำขอ** (หลัง commit การออกเลข) — เวลา 5 วิรวม render ใบ 500 บรรทัด · `spec/11` NFR-706 เสนอให้ PDF เป็น async | `finalize` |
| R-4 | invoice run: ร่างละ transaction, อ่านคิวใหม่ทุกกลุ่ม (`stillReady`), แบบ `releaseDeliveryOrders` ส่งบัญชีทีละ DO ใน savepoint | `run` A/B |
| R-5 | `DbService.withTenant` timeout 15 วิ (ค่าเริ่ม) — ขั้นออกเลขของ finalize ใช้ค่านี้ · ใบใหญ่บนเครื่องช้าอาจ rollback | `finalize` |
| R-6 | keyset ของ `keysetArgs` เป็นรูป `updated_at > u OR (updated_at = u AND id > i)` (ไม่ใช่ row comparison) | `lists` cursor ลึก |

### 4.3 เป้า 500 DO กับเพดาน 200 DO (FACT — ส่งเป็นคำถาม PO #71)

- `POST /v1/invoices` และ `POST /v1/invoices/{id}/delivery-orders` รับ ≤ 200 DO ต่อคำขอ (ใบ 500 DO ทำได้ด้วย 3 คำขอ — สคริปต์วัดทางนี้)
- invoice run แบ่งร่างที่ 200 DO (`MAX_PER_DOC`) → ลูกค้า 446 DO ได้ **3 ร่าง** ไม่ใช่ใบเดียวแบบ KRS

## 5. Ticket + แผนแก้

| Ticket | เรื่อง | สถานะ | แผน |
|---|---|---|---|
| P-1 | คิวพร้อมวางบิล O(n²) (§4.1) | **แก้แล้วใน PR นี้** — รอ test + วัดยืนยัน | LATERAL ต่อ DO |
| P-2 | **วัดผลจริงบนเครื่องว่าง** แล้วเติม §3 (ส่วนที่เหลือของ ST9-T17) | เปิด — lead นัดรัน | `pnpm --filter @tms/api perf -- --max-load=8 --web` → เติมตาราง · ข้อที่ไม่ผ่านเปิด ticket ตาม R-1…R-6 |
| P-3 | คิวพร้อมวางบิลยังคำนวณทุก DO ต่อคำขอ + ยอดรวมซ้ำ (R-1) | เปิดเมื่อ §3 ยืนยันว่าเกิน 300 ms | **ข้อเสนอ:** (ก) รวมหน้า + ยอดรวมเป็น query เดียว (ข) กรอง DO ด้วย partial index `delivery_order(tenant_id, updated_at, id) WHERE status IN (DELIVERED, POD_PENDING, UNBILLED) AND billing_status IN (UNBILLED, CREDITED)` — migration เลข **0157** (สูงสุดบน origin/main 0153 + 4) (ค) ถ้ายังไม่พอ: cache ยอดรวมต่อลูกค้า |
| P-4 | ทดสอบขนาด 100 tenant / 50,000 order ต่อเดือน + k6 บน staging (docs/04 NFR ขนาด, spec/11 §16) | เปิด — ต้องมี staging | ต่อยอด `seed.ts` ให้รับจำนวน tenant; รันก่อน release ตาม spec/11 |
| P-5 | N+1 ตอนดึง DO เข้าร่าง (R-2) | เปิดเมื่อ §3 ยืนยัน | **ข้อเสนอ:** `readiness` รับหลาย id ใน query เดียว (CTE รองรับ `ids[]` อยู่แล้ว) + อ่าน POD ล่าสุดเป็นชุด |

P-3, P-4, P-5 ลงใน `plan/01-phase0-backlog.md` ภาคผนวก "ผู้สมัครเพิ่ม" #36–#38 แล้ว

## 6. บันทึกการลองสคริปต์ (ไม่ใช่ผล)

- seed ทำงานครบ: `sales_order 10,002 · delivery_order 10,002 · trip 10,002 · revenue_line 10,002 · invoice 10,001 · invoice_line 13,711`
  (ใช้ 1,059 วิ ขณะ load 40–80 — ส่วนใหญ่คือ migrate 153 ชุด; บนเครื่องว่างยังไม่ได้จับเวลา)
- ส่วน `lists` รันจบ 1 รอบขณะ load 80–95 (ก่อนแก้ §4.1): endpoint อื่นตอบ 200 ทุกแบบ, ไล่ cursor ได้รวม 10,002 แถว/รายการ (นับจำนวน ไม่ได้ตรวจแถวซ้ำ) — ตัวเลขเวลา
  **วัดขณะเครื่องโหลดสูง — ใช้ไม่ได้** · คิวไม่กรองลูกค้าตอบ 503 ทั้ง 2 แบบ
- ส่วน `mixed` / `webhook` / `finalize` / `run` / `web` **ยังไม่เคยรัน** (เขียนแล้ว ยังไม่ผ่านการลองจริง — รอบแรกบนเครื่องว่างอาจต้องแก้สคริปต์)
