# @tms/mock-krs — mock ของ KRS api-pueanphet (ST8-T01) + แหล่ง SO (ST8-T02)

mock server จาก contract `packages/contracts/krs/*.schema.json` (docs/01 Appendix A.1, A.3, A.5) สำหรับ dev / test / staging — **ไม่เรียก KRS จริง ไม่ต่อเครือข่ายภายนอก** และไม่มีโค้ดของ core ใดอ้างถึง (KRS เป็นแค่ adapter หนึ่งหลัง `ErpAdapter`)

## รัน

| ใช้ที่ไหน | วิธี |
|---|---|
| server แยก | `pnpm --filter @tms/mock-krs dev` → `http://127.0.0.1:4784/api` (พอร์ตเริ่มต้นทั่วไปของ mock — เปลี่ยนด้วย env `MOCK_KRS_PORT` ให้อยู่ในช่วงพอร์ตของ worktree/lane ตัวเอง; `MOCK_KRS_HOST`, `MOCK_KRS_API_KEY` — ค่าเริ่ม key `mock-krs-key`) |
| ใน test (in-process) | `const mock = await startMockKrs({ apiKey: 'k' })` → `mock.apiBaseUrl` (พอร์ตสุ่ม) … `await mock.stop()` |

### ค่าตั้ง (option ↔ env)

ทุก option ใช้ได้ทั้งใน test (`startMockKrs({...})` / `new MockKrs({...})`) และ CLI (env — ค่าผิดรูป = CLI ไม่ยอมเริ่ม; ไม่ตั้ง = ค่าเริ่ม)

| option | env | ค่าเริ่ม |
|---|---|---|
| — (พอร์ต / host) | `MOCK_KRS_PORT` / `MOCK_KRS_HOST` | 4784 / 127.0.0.1 |
| `apiKey` | `MOCK_KRS_API_KEY` | `mock-krs-key` |
| `basePath` | `MOCK_KRS_BASE_PATH` | `/api` |
| `schemaDir` | `MOCK_KRS_SCHEMA_DIR` | `packages/contracts/krs` |
| `transactionNoStart` | `MOCK_KRS_TRANSACTION_NO_START` | 100001 |
| `maxBodyBytes` | `MOCK_KRS_MAX_BODY_BYTES` | 52428800 (50 MB) |
| `oversizeStatus` | `MOCK_KRS_OVERSIZE_STATUS` | 400 |
| `timeoutMs` (fault timeout) | `MOCK_KRS_TIMEOUT_MS` | 30000 |
| `allowHeaderFaults` | `MOCK_KRS_HEADER_FAULTS` (`true`/`false`/`1`/`0`) | true |
| `voucherPeriodFrom` | `MOCK_KRS_VOUCHER_PERIOD_FROM` (`voucherDate`/`clock`) | `voucherDate` |
| `includeAmounts` | `MOCK_KRS_INCLUDE_AMOUNTS` | true |
| `amountRounding` | `MOCK_KRS_AMOUNT_ROUNDING` (`line-half-up`/`total-half-up`/`line-half-even`) | `line-half-up` |
| `putTmsVoucherNoChange` | `MOCK_KRS_PUT_TMS_VOUCHER_NO_CHANGE` (`accept`/`reject400`) | `accept` |
| `putCheckOrder` | `MOCK_KRS_PUT_CHECK_ORDER` (`validate-first`/`lookup-first`) | `validate-first` |
| `unsupportedMethodStatus` | `MOCK_KRS_UNSUPPORTED_METHOD_STATUS` (`404`/`405`) | 405 |
| `retryAfterSeconds` | `MOCK_KRS_RETRY_AFTER` (วินาที หรือ `none`) | 60 |
| `salesOrderSample` | `MOCK_KRS_SO_SAMPLE` (`true`/`false`/`1`/`0`) | true (ใส่ SO ตัวอย่างปลอมตอนเริ่ม/reset) |
| `now` (นาฬิกา) | — (in-process เท่านั้น) | เวลาจริง |

## Endpoint (ตาม contract)

| คำขอ | ผล |
|---|---|
| `POST /api/invoice` | 201 + `transactionNo` (เรียง 100001, 100002, …) + `voucherNo` `SA-S{YYMM}-{NNNN}` (เดินเลขต่อเดือนของ `voucherDate`) |
| `PUT /api/invoice/{transactionNo}` | 200 แทนที่ทั้งใบ (เลขเดิม) |
| `GET /api/invoice/{transactionNo}` | 200 ข้อมูลใบ + `amount` ต่อรายการ + `totalAmount` (KRS คำนวณ) |
| key ผิด/ไม่มี | 401 (ตรวจก่อน validate) |
| body ผิด schema / ฟิลด์นอก whitelist / ส่ง `voucherNo`/`transactionNo` เอง / JSON เสีย / เกิน 50 MB | 400 + `errors[]` (path, keyword, params — บอกชื่อฟิลด์) |
| `mainQuantity`/`unitPrice` หรือยอดต่อรายการเกิน ±1e13 (mock คำนวณยอดตรงตัวไม่ได้) | 400 `keyword: range` — ตรวจก่อนบันทึก ไม่เก็บใบ ([OPEN — KRS] ขีดจำกัดจริงไม่รู้) |
| `transactionNo` ไม่มี | 404 |
| `tmsVoucherNo` ซ้ำ (POST หรือ PUT ด้วยเลขของใบอื่น) | 409 (ไม่บอก `transactionNo` — ตาม A.5) |
| method อื่นบน `/invoice` (เช่น DELETE) | 405 + `Allow` (ค่าเริ่ม — [OPEN — KRS] ตั้ง `unsupportedMethodStatus: 404` ได้) · path อื่น (เช่น `/deliveryorder`, `/creditnote`) = 404 |
| 503 | มี `Retry-After: 60` (ค่าเริ่ม — [OPEN — KRS] `retryAfterSeconds`, `null` = ไม่ส่ง header) |

error body: `{ status, error, message, errors? }`

## แหล่ง SO (ST8-T02 — docs/01 A.4; plan/08 KRS-11 ทาง B)

แทน SQL Server view `vw_TMS_SalesOrder` ด้วย HTTP stub (SQL Server image ทางการไม่มี arm64 — ดู spec/12 §3 แถว ST8-T02) · **ชื่อ view/คอลัมน์/path อยู่ใน `packages/contracts/krs/salesorder-source.json` ที่เดียว** ([OPEN — KRS] ชื่อเสนอ) — client `apps/api/src/erp-adapters/krs/krs-so-source.ts` อ่านไฟล์เดียวกัน

| คำขอ | ผล |
|---|---|
| `GET /api/salesorder?since={watermark}&limit={n}` (+ `X-API-Key`) | 200 `{ view, rows[], next, hasMore }` — แถวที่ `row_ver > since` (ไม่รวม since) เรียง `row_ver` แล้ว `line_no` · 1 แถว = 1 รายการ (หัวใบซ้ำทุกแถว, `row_ver` เท่ากันทั้งใบ) · `limit` นับเป็นใบ 1–500 (ค่าเริ่ม 100) ไม่ตัดกลางใบ · ไม่มีแถว = `next` เท่ากับ since เดิม |
| since/limit ผิดรูป · key ผิด · method อื่น | 400 · 401 · 405 (+ fault 503/timeout ใช้ได้เหมือน `/invoice`) |

ค่าในแถว: วันที่ `YYYY-MM-DD` · `updated_at` รูป datetime2 ไม่มี offset (เวลาไทย) · `qty` สตริงทศนิยม · `is_cancelled` 0/1 · `row_ver` สตริงตัวเลข (เหมือน `rowversion` — ไม่ซ้ำ เพิ่มทุกครั้งที่ใบเปลี่ยน)

ข้อมูลตัวอย่าง (ปลอมทั้งหมด — `SAMPLE-` / "บริษัทตัวอย่าง"): `SAMPLE-SO-6911-0001` ปกติ · `-0002` 2 รายการ · `-0003` ลูกค้ายังไม่จับคู่ (`SAMPLE-C999`) · `-0004` ถูกแก้ (updated_at หลังวันที่ SO) · `-0005` **ถูกยกเลิก** (`is_cancelled = 1`)

| control | ทำอะไร |
|---|---|
| `GET /__mock/salesorders` · `GET /__mock/salesorders/{company}/{soNo}` | ดู SO (ชื่อเชิงตรรกะ) |
| `POST /__mock/salesorders` | เพิ่ม/แทนที่ทั้งใบ |
| `PATCH /__mock/salesorders/{company}/{soNo}` | แก้บางช่อง (เช่น `deliveryDate`, `lines`) — แก้ `company`/`soNo`/`rowVersion` ไม่ได้ |
| `POST /__mock/salesorders/{company}/{soNo}/cancel` | ยกเลิก (แถวยังอยู่ `is_cancelled = 1`) |

ทุกการเขียนได้ `row_ver` + `updated_at` ใหม่ → poller เห็นในรอบถัดไป · in-process ใช้ `mock.salesOrders.edit/cancel/upsert` ตรง ๆ ได้

**[OPEN — KRS]** ทางที่ KRS เลือก (view SQL / API / ไฟล์ — KRS-11) · ชื่อ view/คอลัมน์ · 1 แถวต่อรายการหรือต่อใบ · watermark (`rowversion` หรือ `updated_at`) · เขตเวลาของ `updated_at` · รูป response/พารามิเตอร์ของ API · SO ที่ถูกลบจริง (ไม่ใช่ยกเลิก) จะหายจาก view หรือไม่

## สวิตช์ (control — ไม่ต้องใช้ key)

> **คำเตือน:** `/__mock/*` **ไม่มีการยืนยันตัวตน** — ใครเรียกถึงก็ล้าง/เขียนทับ/สั่ง fault ได้ ค่าเริ่มจึง bind `127.0.0.1` เท่านั้น ห้ามตั้ง `MOCK_KRS_HOST=0.0.0.0` บนเครื่องที่ใช้ร่วมกันหรือ staging โดยไม่จำกัดเครือข่าย (firewall / private network) และห้ามใช้แทน KRS จริงใน production

| คำขอ | ทำอะไร |
|---|---|
| `POST /__mock/reset` | ล้างใบ เลขเริ่มใหม่ ปิดทุกสวิตช์ |
| `GET /__mock/state` | ใบทั้งหมด (+ `revision`, `overwriteCount`) สวิตช์ และ log คำขอ |
| `POST /__mock/faults` `{kind?, status?, method?, times?, skip?, body?}` (หรือ array) | kind: `status` (ค่าเริ่ม 503 — ทุก code ใน A.1 ได้) · `timeout` · `reset` · `timeout-after-commit` / `reset-after-commit` (บันทึกแล้วแต่ response หาย — เคส AMBIGUOUS ของ A.5) · `times` ค่าเริ่ม 1, `0` = จนกว่าจะล้าง · `skip` (ST8-T08) = ปล่อยคำขอที่ตรงเงื่อนไข N ครั้งแรกผ่านก่อน (เช่น ล้มที่ POST ใบที่ 2) |
| `DELETE /__mock/faults` | ล้าง fault |
| header `X-Mock-Fault` | fault ต่อคำขอ: ตัวเลข 3 หลัก `400`–`599` (status) หรือชนิด `timeout` / `reset` / `timeout-after-commit` / `reset-after-commit` — ค่าอื่น = 400 · ปิดได้ด้วย `allowHeaderFaults: false` |
| `PUT /__mock/overwrite` `{enabled, rule?}` | **บัญชีกดบันทึกแล้วรายการถูกเขียนใหม่** — เปิดแล้วใบที่มีถูกเขียนทับทันที และใบที่ POST/PUT หลังจากนั้นถูกเขียนทับหลังตอบ (GET ถัดไปได้รายการที่เปลี่ยน) |
| `POST /__mock/invoices/{transactionNo}/overwrite` `rule` | เขียนทับใบเดียว |

`rule`: `keepLines` (ค่าเริ่ม 30 — เคส 79 → 30 รายการ; `null` = ไม่ตัด) · `dropFlowNos[]` · `blankFields[]` (เฉพาะฟิลด์ข้อความ เช่น `carId`, `carPerson`, `frWay`, `toWay` — `mainQuantity`/`unitPrice`/`lineId` ไม่ได้ = 400) · `blankValue` (`''` ค่าเริ่ม / `null`) · `renumberLineIds`

## [OPEN — KRS] ที่ตั้งค่าได้ (คำถามใน `plan/08-questions-krs.md` — อย่าถือเป็นข้อเท็จจริง)

| เรื่อง | ค่าเริ่มของ mock | option |
|---|---|---|
| รูปแบบ `transactionNo` | ตัวเลขเรียงจาก 100001 | `transactionNoStart` |
| เดือนใน `voucherNo` | จาก `voucherDate` | `voucherPeriodFrom: 'clock'` |
| รูป error body | `{status, error, message, errors?}` | — (adapter ต้องเก็บ response ตัวเต็ม — A.5) |
| body เกิน 50 MB | 400 | `oversizeStatus`, `maxBodyBytes` |
| ยอดเงินใน GET (ชื่อฟิลด์/มีไหม) | `amount`, `totalAmount` | `includeAmounts: false` |
| วิธีปัดยอด | ปัดครึ่งขึ้นเป็นสตางค์ต่อรายการแล้วรวม | `amountRounding: 'total-half-up'` (รวมค่าเต็มแล้วปัดครั้งเดียว) / `'line-half-even'` |
| method อื่นบน `/invoice` (A.1 บอกแค่ว่า "ไม่มี") | 405 + `Allow` | `unsupportedMethodStatus: 404` |
| `Retry-After` ของ 503 | 60 วินาที | `retryAfterSeconds` (`null` = ไม่ส่ง) |
| วันที่ไม่มีจริง เช่น `2026-13-45` | **ผ่าน** — schema ของ contract ตรวจแค่รูป `\d{4}-\d{2}-\d{2}` (KRS ของจริงอาจตอบ 400) · adapter ต้องส่งวันที่จริงเสมอ | — (แก้ schema เมื่อ KRS ยืนยัน) |
| PUT เปลี่ยน `tmsVoucherNo` | ยอม (เลขของใบอื่น = 409 เสมอ) | `putTmsVoucherNoChange: 'reject400'` |
| ลำดับตรวจของ PUT (400 กับ 404) | validate ก่อน | `putCheckOrder: 'lookup-first'` |
| รายการไหนหาย/ฟิลด์ไหนว่างตอนเขียนทับ | 30 รายการแรก, ไม่ล้างฟิลด์ | `rule` ข้างบน |
| ฟิลด์สถานะ GL / ค้นด้วย `tmsVoucherNo` / credit note / DO | ไม่มี (ตาม A.1) | เพิ่มเมื่อ KRS ตอบ — แก้ schema ใน `packages/contracts/krs` ก่อน |
| rate limit | ไม่จำกัด | — |

## Payload ที่ TMS ส่ง (ST8-T07 — `apps/api/src/erp-adapters/krs/krs-invoice-payload.ts`)

builder สร้าง body ของ `POST /invoice` / `PUT /invoice/{transactionNo}` จาก canonical invoice แบบ whitelist (test `apps/api/test/krs-invoice-payload.test.ts` เทียบกับ `invoice-request.schema.json` และ POST เข้า mock นี้) · **[OPEN — KRS]** จุดที่ contract ไม่กำหนด — ค่าเริ่มของ builder เป็นทางระมัดระวัง ตั้งค่าได้ใน `KRS_PAYLOAD_DEFAULTS` (คำถาม: `plan/08-questions-krs.md` KRS-19 — **ยังไม่ได้ส่ง KRS อย่าถือเป็นข้อเท็จจริง**)

| เรื่อง [OPEN — KRS] | ค่าเริ่มของ builder | option |
|---|---|---|
| เพดาน "50 MB" (10^6 หรือ 2^20, วัดที่ body หรือไม่) | 50,000,000 ไบต์ของ body JSON UTF-8 (mock รับถึง 52,428,800) | `maxBytes` |
| เกินเพดาน: KRS รับการแบ่งใบไหม / เลขของใบที่แบ่ง | แบ่งตามลำดับรายการ หัวเอกสารซ้ำ; ใบแรก = เลขเดิม ใบที่ n = `{tmsVoucherNo}-P{n}` | `splitVoucherNo` |
| `lineId` ของใบที่แบ่ง (เลขเดิม / เริ่ม 1 ใหม่ / ต้องต่อเนื่องไหม) | เลขบรรทัดเดิมของ TMS | `splitLineId: 'renumber'` |
| รายการที่ไม่ผูก DO (contract บังคับ `flowNo`…`toWay` ทุกรายการ) | ไม่สร้าง payload (`krs_line_without_do`) | `lineWithoutDo: 'placeholder'`, `placeholderText` |
| รายการที่มีส่วนลด (ไม่มีช่องส่วนลด; KRS คิดยอด = จำนวน × ราคา) | ไม่สร้าง payload (`krs_discount_unsupported`) | `discount: 'net-unit-price'` (เฉพาะหารลงตัว) |
| เที่ยวไม่มีชื่อคนขับ (รถร่วม) — `carPerson` บังคับ | ไม่สร้าง payload | `carPersonFallback: 'carrierName'` |
| เที่ยวไม่มีทะเบียนรถ — `carId` บังคับ | ไม่สร้าง payload | `carIdFallback: 'placeholder'` (ใช้ `placeholderText`) |
| `accountCode` เมื่อยังไม่ได้นำเข้าผังบัญชีของ KRS | ไม่ส่ง key (A.3: KRS กำหนด default) — ส่งเฉพาะค่าที่หาเจอในผัง ACCOUNT | — |
| KRS ปัดยอดต่อรายการ / ยอดรวมอย่างไร (mock: `amountRounding`) | builder ไม่ส่งยอด — คืน `expectedAmount` + `expectedLines` ไว้เทียบ (จับคู่ `lineId` + `flowNo`) | — |
| `deliveryAddress` ("ที่อยู่หลักของลูกค้า") | ที่อยู่วางบิล (เท่ากับ `address`) | `deliveryAddress: 'empty'` |
| `entryBy` (ต้องเป็น user ใน ERP ไหม) | `TMS` | `entryBy` |
| `saleName` เมื่อผังรหัสไม่มีชื่อ | สตริงว่าง | — |
| หลายรายการของ DO เดียวกัน (`flowNo` ซ้ำในใบ) | ส่งตามบรรทัด ไม่รวมรายการ | — |
| ความยาวสูงสุดของช่องข้อความ · ทศนิยมสูงสุด/ค่าติดลบ/ศูนย์ของ `mainQuantity`, `unitPrice` | ไม่ตัด ไม่ปัด ส่งตามจริง (ตัวเลขที่แปลงเป็น JSON number แล้วเพี้ยน = ไม่ส่ง) | — |
| VAT ต่อรายการ (A.6) | builder ไม่แยกใบ — ST8-T08 แยกตาม `vat_type` แล้วเรียก builder ต่อกลุ่ม | `tmsVoucherNo` |

