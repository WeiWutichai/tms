# วิธีเพิ่ม connector (ระบบบัญชี / ERP) — ชุดแม่แบบ P1-ST5-T01

> สำหรับนักพัฒนาที่จะทำ FlowAccount (P1-ST5-T02–T06) และ PEAK (P1-ST5-T07–T10) · ที่มา: docs/01 §6.1–6.5, docs/04 G3/G4,
> plan/13 R-01 / R-09, D-55, D-58, D-70, D-80, D68-29, D68-47 · ภาษีและชนิดเอกสารปลายทาง **ห้ามเดา** (ดูหัวข้อ 6)

## 1. หลักที่ห้ามละเมิด

- **Standalone-first:** ทุก flow ทำจบได้โดยไม่มี connector — adapter เป็นส่วนเสริม ห้ามมีโค้ด core ที่รู้ชื่อ adapter
  (`scripts/lint-adapters.mjs` ตรวจใน `pnpm lint`) · core รู้จักแค่ `ErpAdapter` (`src/modules/erp/erp-adapter.ts`) + `capabilities()`
- adapter **ห้ามเขียนฐานข้อมูล TMS** และห้ามถือ transaction — core (`ErpAdapterSink`) เรียกนอก transaction แล้วบันทึกผลเอง
  (outbox, `external_mapping`, sync log, reconcile)
- error ของปลายทาง → `PushResult.ok=false` + `ErrorClass` กลาง (ไม่ใช่ HTTP code) · อ่านกลับ (fetch/pull) → throw `ErpAdapterError(class)`
- ห้ามมี credential ใน `problem` / `raw` / ข้อความ error / sync log · ห้ามส่ง header ให้ `onHttpCall`
- ข้อมูลส่วนบุคคล: ใช้ได้เฉพาะช่องที่ประกาศใน `personalDataNeeds` และเท่าที่สัญญาปลายทางบังคับ (D-80)

## 2. ขั้นตอน

1. สร้างโฟลเดอร์ `src/erp-adapters/<key>/` (`key` ตาม `CONNECTOR_KEY_RE` เช่น `flowaccount`, `peak`) — ไม่ import adapter ตัวอื่น
2. เขียน class ที่ implement `ErpAdapter`:
   - `configFields` — ค่าที่ใช้ยืนยันตัวตน (client secret, token, API key) **ต้อง** `secret: true` · base URL เป็น `kind: 'url'`
   - `capabilities()` — ประกาศเฉพาะ method ที่มีจริง (method ⇔ capability ตรวจด้วย `adapterShapeProblems`) ·
     ทำยังไม่เสร็จ = ใส่ใน `pendingCapabilities` + method ตอบ `notImplementedResult()` / `notImplementedError()`
   - **R-01 (FlowAccount / PEAK / AccountSystem):** `fixedSystemOfRecord = { taxDocumentOwner: 'ERP' }` ตายตัว ·
     `pushInvoice` = ใบแจ้งหนี้ของ TMS เป็นเอกสาร**ร่าง**ในโปรแกรมบัญชี (แต่ละบรรทัดมี `vatType` + `whtRate` ตาม canonical) ·
     `pushSettlement` = ใบสำคัญจ่ายรถร่วมที่จ่ายแล้ว → ค่าใช้จ่าย**ร่าง** + WHT ประมาณการ (50 ทวิ ออกในโปรแกรมบัญชี — D-58) ·
     **ไม่มี `pushCreditNote`** (TMS ไม่ส่งใบลดหนี้/ใบเสร็จในเฟสนี้) · ดึงกลับเลขเอกสาร/สถานะ = `fetchDocument` / `fetchPaymentStatus` (D-70)
   - HTTP ใช้ `safeHttpRequest` (กัน SSRF) · รายงานทุก call ผ่าน `ctx.onHttpCall` (sync log 1 แถวต่อ 1 call — docs/01 §6.4)
   - ส่งเลขอ้างอิงของเรา (`doc.number`) ในช่องที่ ERP ใช้กันซ้ำ (docs/01 §6.2 ข้อ 3) · ตอบ `applied` ตามจริง
   - แปลง HTTP → ErrorClass ตามตารางข้อ 3
3. สร้าง mock ของ ERP จาก fixture/สัญญา (แบบ `packages/mock-accountsystem`) — test **ห้ามเรียก sandbox จริง**
   (ทดสอบกับ sandbox เป็นขั้นตอน go-live แยก — ตัวขวาง X-02 / X-03 ใน plan/13 §4.2)
4. ลงทะเบียน 1 บรรทัดใน `ERP_ADAPTER_FACTORIES` (`src/erp-adapters/index.ts`)
5. เพิ่มชุดใน `test/connector-conformance.test.ts` (`describeConnectorConformance`) และ
   `test/connector-conformance-pipeline.test.ts` (`runPipelineConformance`) — test "ทะเบียน adapter" ล้มถ้าลืม
6. `pnpm --filter @tms/api openapi:export` (catalog ของ adapter อยู่ใน `GET /v1/connectors/adapters`) + i18n ป้ายช่องตั้งค่า

## 3. ErrorClass ที่ชุด conformance ฉีดและคาดหวัง (docs/01 §6.3)

| fault ที่ฉีด                                                                                        | คาด                                                                      | core ทำอะไร                                                                  |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 401 / 403 (ทุกคำขอ)                                                                                 | `AUTH` (`retryable: false`) · อ่านกลับ = throw `ErpAdapterError('AUTH')` | คำสั่งคง PENDING ไม่นับครั้ง · connector `ERROR` + แจ้ง admin ทันที (D68-47) |
| 429 / 503 / connection refused (ทุกคำขอ) · 500 (คำขอเขียน)                                          | `TRANSIENT` (`retryable: true`) — throw Error ธรรมดาก็ได้                | ลองใหม่ 1, 2, 5, 15, 30, 60 นาที · healthCheck ล้ม ≥ 30 นาที = หยุดคิว       |
| 400 / 422 (คำขอเขียน)                                                                               | `VALIDATION` (`retryable: false`)                                        | FAILED_FINAL + แท็บ "ล้มเหลว" ของคิว                                         |
| สายหลุดหลังส่ง body (`resetAfterSend`) / ERP บันทึกแล้วแต่สายหลุดก่อนได้คำตอบ (`resetAfterForward`) | `AMBIGUOUS` (`retryable: true`)                                          | ไม่ส่งซ้ำทันที — ค้นก่อน (fetch/list)                                        |
| fixture "เลขอ้างอิงซ้ำ" ของ ERP                                                                     | `DUPLICATE` หรือ ok ที่ `applied !== true`                               | ตามหาเอกสารเดิม → SYNCED / MISMATCH / ให้คนกรอกเลข                           |
| fixture "งวดบัญชีปิด" ของ ERP                                                                       | `PERIOD_CLOSED`                                                          | FAILED_FINAL ไม่ลองใหม่                                                      |
| 404 ตอน `fetchDocument` / `replaceDocument`                                                         | fetch: `null` หรือ `ErpAdapterError('NOT_FOUND')` · replace: `NOT_FOUND` | REMOTE_MISSING ให้คนตัดสิน                                                   |
| capability ใน `pendingCapabilities`                                                                 | `CAPABILITY` + `not_implemented`                                         | พักคำสั่ง (PENDING)                                                          |

อื่น ๆ ที่ชุดตรวจ: ปลายทางล่มระหว่างอ่านกลับต้อง throw (ห้ามคืน `null` — core จะถือว่า "ไม่พบเอกสาร" → REMOTE_MISSING) ·
externalId / เลขเอกสารไม่ว่างและ ≤ 100 ตัว (CHECK ของ `external_mapping`) · ค่าส่วนบุคคลที่ประกาศไม่ถูกสะท้อนในผล/ข้อความ error ·
adapter ตัวเดียวใช้ร่วมทุก tenant — ห้ามค้าง credential/สถานะข้าม context · ระดับ pipeline: mapping แถวเดียวแม้ส่งซ้ำ, tenant อื่นไม่เห็น (RLS/404)

**ไม่มีการผ่านแบบเงียบ:** ข้อที่ฉีดกับ adapter ไม่ได้ (ไม่มี fixture ซ้ำ/งวดปิด, `simulate` คืน null, adapter ไม่ใช่ HTTP) ต้องมี `exceptions`
พร้อมเหตุผล — ไม่มี = test "ทุกข้อมีข้อยกเว้น" ล้ม · ข้อที่มีเหตุผลแสดงเป็น test ที่ **ข้าม (skip) พร้อมเหตุผลในชื่อ** · push ที่ประกาศต้องมี `samples`
· ตัวตรวจมี self-test กับ adapter ที่ตั้งใจทำผิด (`test/connector-kit-selftest.test.ts`) · ข้อยกเว้นปัจจุบัน:

| adapter       | ข้อ                                     | ผล                          | เหตุผล                                                                                                                                                                  |
| ------------- | --------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| accountsystem | `resetAfterSend`, `resetAfterForward`   | `TRANSIENT` แทน `AMBIGUOUS` | กันซ้ำด้วย `external_ref` (เลข TMS) — ชุดส่งซ้ำจริงแล้วได้ `created=false` และ mock มีเอกสารใบเดียว · [DECISION — lead 27 พ.ย. 2569, ย้อนได้] ใน spec/12 §3 รอ PO ทบทวน |
| accountsystem | `duplicate`                             | ข้าม                        | ไม่ตอบ "เลขซ้ำ" — POST ซ้ำด้วย `external_ref` เดิมคืนร่างเดิม (`applied` false)                                                                                         |
| accountsystem | `periodClosed`                          | ข้าม                        | สัญญา ext/v1 ไม่มีคำตอบงวดปิด (สร้างเฉพาะร่าง)                                                                                                                          |
| krs           | `periodClosed`                          | ข้าม                        | ตาราง error ของ KRS (docs/01 A.1/A.5) ไม่มีกรณีงวดปิด — ไม่มีรูปคำตอบให้ทำ fixture                                                                                      |
| krs           | ชุด pipeline                            | ไม่อยู่ในชุด                | ส่งใบเข้า KRS ต้องมีผังรหัส + รหัสลูกค้า PP ก่อน (ST8-T06) — ทดสอบทางเดียวกันใน `krs-push-invoice.test.ts` / `krs-a5-errors.test.ts`                                    |
| demo          | `refused`                               | ข้าม                        | ERP จำลองในโปรเซส ไม่มีปลายทางเครือข่าย (TRANSIENT ตรวจผ่าน `failMode` แล้ว)                                                                                            |
| demo          | healthCheck ภายใต้ fault ที่ไม่ใช่ AUTH | ไม่ตรวจ                     | `failMode` จำลองความล้มเฉพาะคำสั่ง (สาธิต retry โดย connector ยัง ACTIVE) — healthCheck ล้มเฉพาะ key ผิด                                                                |
| standalone    | ทุกข้อ                                  | ข้าม                        | ไม่มี capability และไม่ติดต่อภายนอก                                                                                                                                     |

## 4. ไฟล์ของชุดแม่แบบ

- `test/connector-kit/conformance.ts` — `describeConnectorConformance()` (รวม contract เดิม `test/erp-adapter-contract.ts`)
- `test/connector-kit/fault-proxy.ts` — reverse proxy ฉีด fault HTTP หน้า mock ใดก็ได้ (status / ตัดสายก่อนส่งต่อ / ส่งต่อแล้วตัดสาย) + เก็บคำขอ
- `test/connector-kit/pipeline.ts` — `runPipelineConformance()` ผ่าน API + outbox + sink + ฐานข้อมูล
- `test/connector-kit/samples.ts` — canonical ตัวอย่าง (ข้อมูลสมมติ)

## 5. จับคู่ลูกค้า (D68-29 — P1-ST5-T12)

ผลจับคู่ลูกค้าที่คนสอน (เดิมตาราง `customer_alias`) อยู่ใน `external_mapping` แล้ว (migration 0180): แถว `connector_id` NULL +
`match_kind` (`EXTERNAL_ID` ต่อช่องทาง `channel` = `ERP:{key}` / `API` / `EXCEL` … · `NAME` ทุกช่องทาง) · `source_code` = คีย์ค้น ·
`match_value` = ข้อความตามต้นทาง · เข้าถึงผ่าน `ExternalMappingService` (`aliasCustomer` / `insertAlias` / `reassignAlias`) เท่านั้น ·
แถว mapping ของ connector (`match_kind` NULL) ไม่เปลี่ยน — connector ใหม่ใช้ `source_code` / `external_id` ของแถวนั้นตามเดิม

## 6. สิ่งที่ยังไม่ตัดสิน (ห้ามเดา)

- ชนิดเอกสารปลายทางที่แน่นอนใน FlowAccount ("ใบแจ้งหนี้/ใบกำกับภาษี" ร่าง หรือ "ใบวางบิล") และ PEAK (Invoices ร่าง) และ
  "ส่งยอด VAT หรือให้ปลายทางคำนวณ" = **[OPEN — นักบัญชี X-07]** — ระหว่างรอ สร้างเป็น**ร่างเท่านั้น** (ไม่อนุมัติแทนผู้ใช้) ด้วยค่าที่ย้อนได้
- ตาราง SoR ต่อ connector (P1-ST0-T03 — `plan/sign-offs/`) ต้องลงนามก่อน go-live
