# @tms/mock-krs — mock ของ KRS api-pueanphet (ST8-T01)

mock server จาก contract `packages/contracts/krs/*.schema.json` (docs/01 Appendix A.1, A.3, A.5) สำหรับ dev / test / staging — **ไม่เรียก KRS จริง ไม่ต่อเครือข่ายภายนอก** และไม่มีโค้ดของ core ใดอ้างถึง (KRS เป็นแค่ adapter หนึ่งหลัง `ErpAdapter`)

## รัน

| ใช้ที่ไหน | วิธี |
|---|---|
| server แยก | `pnpm --filter @tms/mock-krs dev` → `http://127.0.0.1:4784/api` (พอร์ตเริ่มต้นทั่วไปของ mock — เปลี่ยนด้วย env `MOCK_KRS_PORT` ให้อยู่ในช่วงพอร์ตของ worktree/lane ตัวเอง; `MOCK_KRS_HOST`, `MOCK_KRS_API_KEY` — ค่าเริ่ม key `mock-krs-key`) |
| ใน test (in-process) | `const mock = await startMockKrs({ apiKey: 'k' })` → `mock.apiBaseUrl` (พอร์ตสุ่ม) … `await mock.stop()` |

## Endpoint (ตาม contract)

| คำขอ | ผล |
|---|---|
| `POST /api/invoice` | 201 + `transactionNo` (เรียง 100001, 100002, …) + `voucherNo` `SA-S{YYMM}-{NNNN}` (เดินเลขต่อเดือนของ `voucherDate`) |
| `PUT /api/invoice/{transactionNo}` | 200 แทนที่ทั้งใบ (เลขเดิม) |
| `GET /api/invoice/{transactionNo}` | 200 ข้อมูลใบ + `amount` ต่อรายการ + `totalAmount` (KRS คำนวณ) |
| key ผิด/ไม่มี | 401 (ตรวจก่อน validate) |
| body ผิด schema / ฟิลด์นอก whitelist / ส่ง `voucherNo`/`transactionNo` เอง / JSON เสีย / เกิน 50 MB | 400 + `errors[]` (path, keyword, params — บอกชื่อฟิลด์) |
| `transactionNo` ไม่มี | 404 |
| `tmsVoucherNo` ซ้ำ (POST หรือ PUT ด้วยเลขของใบอื่น) | 409 (ไม่บอก `transactionNo` — ตาม A.5) |
| method อื่นบน `/invoice` (เช่น DELETE) | 405 + `Allow` (ค่าเริ่ม — [OPEN — KRS] ตั้ง `unsupportedMethodStatus: 404` ได้) · path อื่น (เช่น `/deliveryorder`, `/creditnote`) = 404 |
| 503 | มี `Retry-After: 60` (ค่าเริ่ม — [OPEN — KRS] `retryAfterSeconds`, `null` = ไม่ส่ง header) |

error body: `{ status, error, message, errors? }`

## สวิตช์ (control — ไม่ต้องใช้ key)

> **คำเตือน:** `/__mock/*` **ไม่มีการยืนยันตัวตน** — ใครเรียกถึงก็ล้าง/เขียนทับ/สั่ง fault ได้ ค่าเริ่มจึง bind `127.0.0.1` เท่านั้น ห้ามตั้ง `MOCK_KRS_HOST=0.0.0.0` บนเครื่องที่ใช้ร่วมกันหรือ staging โดยไม่จำกัดเครือข่าย (firewall / private network) และห้ามใช้แทน KRS จริงใน production

| คำขอ | ทำอะไร |
|---|---|
| `POST /__mock/reset` | ล้างใบ เลขเริ่มใหม่ ปิดทุกสวิตช์ |
| `GET /__mock/state` | ใบทั้งหมด (+ `revision`, `overwriteCount`) สวิตช์ และ log คำขอ |
| `POST /__mock/faults` `{kind?, status?, method?, times?, body?}` (หรือ array) | kind: `status` (ค่าเริ่ม 503 — ทุก code ใน A.1 ได้) · `timeout` · `reset` · `timeout-after-commit` / `reset-after-commit` (บันทึกแล้วแต่ response หาย — เคส AMBIGUOUS ของ A.5) · `times` ค่าเริ่ม 1, `0` = จนกว่าจะล้าง |
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
