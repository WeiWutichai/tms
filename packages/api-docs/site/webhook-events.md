# Webhook events

รายการ event สาธารณะทั้งหมด (= `GET /v1/webhooks/event-types`) — envelope, header และวิธีตรวจลายเซ็นดูที่ [Webhook และการตรวจลายเซ็น](webhooks.md)

> นอกจาก event ในตาราง ระบบส่ง event ระบบอีก 2 ชนิด: `webhook.verification` (ครั้งเดียวตอนสมัคร endpoint — `data.object.challenge` ให้ echo กลับ; ส่งก่อนคุณได้ secret จึงตรวจลายเซ็นไม่ได้ ดู [ยืนยัน endpoint](webhooks.md#ยืนยัน-endpoint-webhookverification)) และ `webhook.test` (ปุ่มทดสอบในหน้าเว็บ — envelope มี `test: true`)

| event | สถานะ | data.object | เกิดเมื่อ |
|---|---|---|---|
| [`connector.health_changed`](#connector-health_changed) | ใช้งาน | `ConnectorDto` | สถานะการเชื่อมต่อระบบภายนอกเปลี่ยน |
| [`credit_note.finalized`](#credit_note-finalized) | ยังไม่ส่ง (จองชื่อไว้) |   | ออกเลขใบลดหนี้แล้ว |
| [`debit_note.finalized`](#debit_note-finalized) | ยังไม่ส่ง (จองชื่อไว้) |   | ออกเลขใบเพิ่มหนี้แล้ว |
| [`delivery_order.status_changed`](#delivery_order-status_changed) | ใช้งาน | `DeliveryOrderDto` | สถานะใบส่งของ (DO) เปลี่ยน |
| [`invoice.adjusted`](#invoice-adjusted) | ยังไม่ส่ง (จองชื่อไว้) |   | ปรับยอดใบแจ้งหนี้ด้วยใบลดหนี้/เพิ่มหนี้ |
| [`invoice.finalized`](#invoice-finalized) | ใช้งาน | `InvoiceDto` | ออกเอกสารใบแจ้งหนี้แล้ว |
| [`invoice.paid`](#invoice-paid) | ใช้งาน | `InvoiceDto` | ใบแจ้งหนี้ได้รับชำระครบ (ยอดตัดรวม WHT ที่ถูกหัก = ยอดรวม) — `data.object` = ใบหลังชำระ (`status` PAID) · `previousAttributes` = { status, version } ก่อนชำระ · กลับรายการภายหลังไม่ยิงซ้ำ (ดู `payment.reversed`) · สถานะชำระจากระบบบัญชี ยิงผ่านทางเดียวกัน |
| [`invoice.voided`](#invoice-voided) | ใช้งาน | `InvoiceDto` | ยกเลิกใบแจ้งหนี้ที่ออกแล้ว (`POST /invoices/{id}/void`) — `data.object` = ใบหลังยกเลิก: `status` CANCELLED + `invoiceNo` เดิม + `cancelledAt` (ไม่มีเหตุผล/ผู้ยกเลิก — ข้อความอิสระ) · `replacedByInvoice` = null เสมอตอนยิง (ร่างฉบับใหม่แทนสร้างหลัง event — ดูผ่าน GET) · `previousAttributes` = { status: ISSUED, version } · ระบบบัญชีที่รับใบไปแล้วยกเลิกตาม |
| [`job.completed`](#job-completed) | ใช้งาน | `JobDto` | งานเบื้องหลัง (นำเข้า/bulk/ส่งออก/รอบวางบิล) เสร็จ |
| [`order.cancelled`](#order-cancelled) | ใช้งาน | `OrderDto` | ยกเลิกใบสั่งงาน |
| [`order.created`](#order-created) | ใช้งาน | `OrderDto` | สร้างใบสั่งงานใหม่ (หน้าจอ, Open API, นำเข้าไฟล์) |
| [`order.held`](#order-held) | ใช้งาน | `OrderDto` | พักใบสั่งงาน (เช่น ข้อมูลไม่ครบ เกินวงเงิน) |
| [`order.released`](#order-released) | ใช้งาน | `OrderDto` | ปล่อยใบสั่งงานที่พักไว้ให้วางแผนต่อ |
| [`order.updated`](#order-updated) | ใช้งาน | `OrderDto` | แก้ไขข้อมูลใบสั่งงาน |
| [`payment.recorded`](#payment-recorded) | ใช้งาน | `PaymentDto` | บันทึกรับชำระเงิน |
| [`payment.reversed`](#payment-reversed) | ใช้งาน | `PaymentDto` | กลับรายการรับชำระเงิน (รวมเช็คคืน — `chequeStatus` = BOUNCED) ยอดค้างของใบกลับมา |
| [`pod.captured`](#pod-captured) | ใช้งาน | `DeliveryOrderPodDto` | บันทึกหลักฐานการส่ง (POD) |
| [`receipt.issued`](#receipt-issued) | ยังไม่ส่ง (จองชื่อไว้) |   | ออกใบเสร็จรับเงินแล้ว |
| [`reconcile.mismatch_found`](#reconcile-mismatch_found) | ยังไม่ส่ง (จองชื่อไว้) |   | พบข้อมูลไม่ตรงกันจากการกระทบยอดกับระบบภายนอก |
| [`settlement.approved`](#settlement-approved) | ใช้งาน | `SettlementDto` | อนุมัติใบสำคัญจ่ายรถร่วม (ออกเลข STL แล้ว — ผู้อนุมัติไม่ใช่ผู้สร้าง) |
| [`settlement.paid`](#settlement-paid) | ยังไม่ส่ง (จองชื่อไว้) |   | จ่ายเงินตามใบสรุปค่าขนส่งรถร่วมแล้ว |
| [`stop.arrived`](#stop-arrived) | ใช้งาน | `TripStopDto` | รถถึงจุดรับ/ส่ง |
| [`stop.completed`](#stop-completed) | ใช้งาน | `TripStopDto` | ปิดงานที่จุดรับ/ส่งสำเร็จ |
| [`stop.departed`](#stop-departed) | ใช้งาน | `TripStopDto` | รถออกจากจุดรับ/ส่ง |
| [`stop.failed`](#stop-failed) | ใช้งาน | `TripStopDto` | งานที่จุดรับ/ส่งไม่สำเร็จ (มีเหตุผล) |
| [`trip.assigned`](#trip-assigned) | ใช้งาน | `TripDto` | จัดรถ/คนขับ หรือรถร่วมให้เที่ยววิ่ง |
| [`trip.cancelled`](#trip-cancelled) | ใช้งาน | `TripDto` | ยกเลิกเที่ยววิ่ง |
| [`trip.completed`](#trip-completed) | ใช้งาน | `TripDto` | เที่ยววิ่งจบครบทุกจุด |
| [`trip.dispatched`](#trip-dispatched) | ใช้งาน | `TripDto` | ปล่อยเที่ยววิ่งให้คนขับ |
| [`trip.started`](#trip-started) | ใช้งาน | `TripDto` | คนขับเริ่มเที่ยววิ่ง |
| [`wht_certificate.issued`](#wht_certificate-issued) | ยังไม่ส่ง (จองชื่อไว้) |   | ออกหนังสือรับรองการหักภาษี ณ ที่จ่ายแล้ว |

## connector.health_changed {#connector-health_changed}

สถานะการเชื่อมต่อระบบภายนอกเปลี่ยน

`data.object` = `ConnectorDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `con_8f3a…` |
| `adapterKey` | ใช่ | `string` |   |   | `demo` |
| `displayName` | ใช่ | `string` | null ได้ | null = adapter ไม่ได้ติดตั้งในระบบนี้ | `Demo ERP` |
| `companyId` | ใช่ | `string` | null ได้ | นิติบุคคลที่ใช้ connector นี้ (Invoice As / Tender As) · null = ทุกนิติบุคคลที่ไม่มีของตัวเอง | `cmp_…` |
| `erpCompanyCode` | ใช่ | `string` | null ได้ |   | `PP01` |
| `branchMap` | ใช่ | `object` |   | สาขา TMS → รหัสบริษัท/สาขาฝั่ง ERP (ไม่มี = ใช้ erpCompanyCode) | `{"brn_8f3a":"PP01-BKK"}` |
| `status` | ใช่ | `string` | ค่า: `ACTIVE`, `PAUSED`, `ERROR`, `DISCONNECTED` |   |   |
| `statusReason` | ใช่ | `string` | null ได้ |   |   |
| `statusChangedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `capabilitiesSupported` | ใช่ | `array<string>` |   | capability ที่ adapter รองรับ (ใช้งานได้จริง — ไม่รวมที่ยังไม่ได้ทำ) |   |
| `capabilitiesPending` | ใช่ | `array<string>` |   | capability ที่ adapter ประกาศแต่ยังไม่ได้ทำ — เปิดไม่ได้ แสดงเป็น "ยังไม่รองรับ" |   |
| `capabilitiesEnabled` | ใช่ | `array<string>` |   | ที่ tenant เปิด |   |
| `capabilities` | ใช่ | `array<string>` |   | ใช้ได้จริง = รองรับ ∩ เปิด (ว่างเมื่อยกเลิกการเชื่อม) |   |
| `settings` | ใช่ | `object` |   | ค่าตั้งที่ไม่ลับ (base URL ฯลฯ) |   |
| `credentialKeys` | ใช่ | `array<string>` |   | ชื่อช่อง credential ที่ตั้งแล้ว — ค่าไม่ส่งกลับเด็ดขาด | `["apiKey"]` |
| `credentialsUpdatedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `syncFromDate` | ใช่ | `string (date)` | null ได้ |   | `2026-12-01` |
| `lastHealthAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `lastHealthOk` | ใช่ | `boolean` | null ได้ |   |   |
| `lastHealthError` | ใช่ | `object` | null ได้ | {errorClass, code, message} ของ healthCheck ล่าสุดที่ล้ม |   |
| `activatedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `disconnectedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `inbound` | ใช่ | `ConnectorInboundDto` |   |   |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `updatedAt` | ใช่ | `string (date-time)` |   |   |   |

## credit_note.finalized {#credit_note-finalized}

ออกเลขใบลดหนี้แล้ว

> ยังไม่ส่ง — ชื่อและ schema จองไว้ (สมัครรับล่วงหน้าได้)

`data.object` = 

## debit_note.finalized {#debit_note-finalized}

ออกเลขใบเพิ่มหนี้แล้ว

> ยังไม่ส่ง — ชื่อและ schema จองไว้ (สมัครรับล่วงหน้าได้)

`data.object` = 

## delivery_order.status_changed {#delivery_order-status_changed}

สถานะใบส่งของ (DO) เปลี่ยน

`data.object` = `DeliveryOrderDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `do_3f2a…` |
| `doNo` | ใช่ | `string` |   |   | `DO-6911-0001` |
| `status` | ใช่ | `string` | ค่า: `DRAFT`, `PLANNED`, `DISPATCHED`, `PICKED_UP`, `DELIVERED`, `FAILED`, `RETURNED`, `POD_PENDING`, `UNBILLED`, `BILLED`, `CANCELLED` |   |   |
| `orderId` | ใช่ | `string` |   |   | `ord_3f2a…` |
| `customerId` | ใช่ | `string` |   |   | `cus_3f2a…` |
| `doDate` | ใช่ | `string` |   |   | `2026-11-12` |
| `originSiteId` | ใช่ | `string` |   |   | `loc_3f2a…` |
| `destSiteId` | ใช่ | `string` |   |   | `loc_3f2a…` |
| `originStopSeq` | ใช่ | `number` |   | ลำดับจุดรับของ SO |   |
| `destStopSeq` | ใช่ | `number` |   | ลำดับจุดส่งของ SO |   |
| `tripId` | ใช่ | `string` | null ได้ |   |   |
| `customerName` | ใช่ | `string` |   | ชื่อลูกค้า |   |
| `originSiteName` | ใช่ | `string` |   | ชื่อจุดรับ |   |
| `destSiteName` | ใช่ | `string` |   | ชื่อจุดส่ง |   |
| `tripNo` | ใช่ | `string` | null ได้ |   | `TRP-6911-0001` |
| `vehiclePlate` | ใช่ | `string` | null ได้ | ทะเบียนรถของเที่ยว (snapshot) |   |
| `driverName` | ใช่ | `string` | null ได้ | คนขับของเที่ยว (snapshot) |   |
| `carrierName` | ใช่ | `string` | null ได้ | รถร่วมของเที่ยว (snapshot) |   |
| `weightKg` | ใช่ | `string` | null ได้ |   |   |
| `cbm` | ใช่ | `string` | null ได้ |   |   |
| `customerRef` | ใช่ | `string` | null ได้ | ลูกค้า |   |
| `splitFromId` | ใช่ | `string` | null ได้ | ใบแม่ที่ถูกแยก |   |
| `splitIndex` | ใช่ | `number` | null ได้ |   |   |
| `redeliveryOfId` | ใช่ | `string` | null ได้ | ส่งใหม่ของ DO ใบนี้ |   |
| `rescheduleCount` | ใช่ | `number` |   | ครั้งที่นัดส่งใหม่อัตโนมัติของสายงานนี้ (0 = ใบแรก) — เกินค่าตั้ง `dispatch.maxAutoReschedules` → ใบสั่งค้าง RESCHEDULES_EXHAUSTED | `0` |
| `redeliveryManual` | ใช่ | `boolean` |   | ส่งซ้ำโดยผู้ใช้ (ไม่ใช่นัดส่งใหม่อัตโนมัติ) — ผลส่งไม่สำเร็จถูกพลิกภายหลังระบบไม่คืนใบเดิมเอง |   |
| `rejectedFromId` | ใช่ | `string` | null ได้ | ใบส่งซ้ำของที่ลูกค้าปฏิเสธรับจาก DO นี้ (ใบเดิมคงส่งแล้ว) — ไม่นับปริมาณจัดสรรของ SO |   |
| `podStatus` | ใช่ | `string` |   |   | `NONE` |
| `releasedAt` | ใช่ | `string` | null ได้ | เวลาส่งบัญชี · null = ยังไม่ส่ง |   |
| `billingStatus` | ใช่ | `string` | ค่า: `UNBILLED`, `IN_DRAFT`, `INVOICED`, `CREDITED` | สถานะวางบิล: UNBILLED ยังไม่อยู่ในใบแจ้งหนี้ · IN_DRAFT อยู่ในร่าง · INVOICED ใบออกเลขแล้ว · CREDITED ใบถูกลดหนี้เต็มใบ (วางบิลใหม่ได้) — DO หนึ่งใบอยู่ในใบแจ้งหนี้ที่ active ได้ใบเดียว | `UNBILLED` |
| `invoicedAt` | ใช่ | `string` | null ได้ | เวลาใบแจ้งหนี้ของ DO ออกเลข · null = ยังไม่ออก/ดึงเข้าร่างใหม่หลังลดหนี้ |   |
| `paidAt` | ใช่ | `string` | null ได้ | เวลารับชำระครบ · null = ยังไม่ชำระครบ |   |
| `billingStage` | ใช่ | `string` | ค่า: `DELIVERED`, `RELEASED`, `IN_DRAFT`, `INVOICED`, `PARTIALLY_PAID`, `PAID`, `CREDITED` · null ได้ | ขั้น lifecycle วางบิล: DELIVERED ส่งถึง · RELEASED ส่งบัญชีแล้ว · IN_DRAFT อยู่ในร่าง · INVOICED ออกใบแล้ว · PAID ชำระครบ · CREDITED ลดหนี้เต็มใบ · null = ยังไม่ส่งถึง/ส่งไม่สำเร็จ/ยกเลิก | `RELEASED` |
| `lines` | ใช่ | `array<DeliveryOrderLineDto>` |   |   |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |

## invoice.adjusted {#invoice-adjusted}

ปรับยอดใบแจ้งหนี้ด้วยใบลดหนี้/เพิ่มหนี้

> ยังไม่ส่ง — ชื่อและ schema จองไว้ (สมัครรับล่วงหน้าได้)

`data.object` = 

## invoice.finalized {#invoice-finalized}

ออกเอกสารใบแจ้งหนี้แล้ว

`data.object` = `InvoiceDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `ivc_…` |
| `invoiceNo` | ใช่ | `string` | null ได้ | เลขใบแจ้งหนี้ — **ร่างไม่มีเลข** (ออกตอนออกเอกสาร) |   |
| `status` | ใช่ | `string` | ค่า: `DRAFT`, `ISSUED`, `PARTIALLY_PAID`, `PAID`, `ADJUSTED`, `VOIDED`, `CANCELLED` |   |   |
| `customer` | ใช่ | `InvoiceCustomerDto` |   |   |   |
| `periodFrom` | ใช่ | `string` | null ได้ |   |   |
| `periodTo` | ใช่ | `string` | null ได้ |   |   |
| `deliveryOrderCount` | ใช่ | `number` |   |   |   |
| `lineMode` | ใช่ | `string` | ค่า: `SINGLE`, `GROUP`, `MERGE` |   |   |
| `issueDate` | ใช่ | `string` | null ได้ | วันที่ออก (เวลาไทย) — ร่าง = null | `2026-11-20` |
| `dueDate` | ใช่ | `string` | null ได้ | ครบกำหนดชำระ = วันที่ออก + เครดิต — ร่าง = null | `2026-12-20` |
| `overdue` | ใช่ | `boolean` |   | เกินกำหนด — ค้างรับ (ISSUED/PARTIALLY_PAID) และเลยวันครบกำหนด (เวลาไทย) · **ธงแยกจาก `status`** (ใบชำระบางส่วนที่เลยกำหนด = `PARTIALLY_PAID` + `overdue: true`) · ตั้งโดย job รายวัน 00:05 และตอนรับชำระ/กลับรายการ · ชำระครบแล้วหลุดเอง |   |
| `overdueAt` | ใช่ | `string` | null ได้ | เวลาที่ระบบตั้งธงเกินกำหนด — ไม่เกิน = null | `2026-11-21T17:05:00.000Z` |
| `sentToCustomerAt` | ใช่ | `string` | null ได้ | ส่งลูกค้าแล้วเมื่อ — ส่งแล้วยกเลิกใบไม่ได้ (409 `invoice_sent_to_customer`) |   |
| `sentToCustomerChannel` | ใช่ | `string` | ค่า: `MANUAL`, `BILLING_NOTE`, `EMAIL` · null ได้ | ช่องทางที่ทำให้ "ส่งลูกค้าแล้ว": MANUAL = ทำเครื่องหมายเอง · BILLING_NOTE = ออกใบวางบิล · EMAIL = ส่งอีเมล |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |
| `issuingCompanyId` | ใช่ | `string` |   |   | `cmp_…` |
| `issuingBranchId` | ใช่ | `string` |   |   | `brn_…` |
| `creditTermDays` | ใช่ | `number` |   |   |   |
| `customerPoNo` | ใช่ | `string` | null ได้ |   |   |
| `taxEstimated` | ใช่ | `boolean` |   | ยอด VAT/WHT เป็นประมาณการ — true เสมอ |   |
| `deliveryOrders` | ใช่ | `array<InvoiceDeliveryOrderDto>` |   |   |   |
| `cancelledAt` | ใช่ | `string` | null ได้ | เวลายกเลิก · null = ไม่ถูกยกเลิก |   |
| `replacesInvoice` | ใช่ | `InvoiceReplacesDto` | null ได้ | ใบนี้ออกแทนใบที่ยกเลิก · PDF พิมพ์หมายเหตุอ้างเลข/วันที่เดิม |   |
| `replacedByInvoice` | ใช่ | `InvoiceReplacedByDto` | null ได้ | ใบที่ออกแทนใบนี้ (ใบที่ยกเลิกแล้วออกใหม่ — ล่าสุดที่ยังไม่ยกเลิก) |   |
| `issuedAt` | ใช่ | `string` | null ได้ | เวลาออกเอกสาร (ออกเลข) — ร่าง = null |   |
| `billingNoteId` | ใช่ | `string` | null ได้ | ใบวางบิลที่ใบนี้อยู่ · null = ไม่อยู่ในใบวางบิล | `bn_…` |

## invoice.paid {#invoice-paid}

ใบแจ้งหนี้ได้รับชำระครบ (ยอดตัดรวม WHT ที่ถูกหัก = ยอดรวม) — `data.object` = ใบหลังชำระ (`status` PAID) · `previousAttributes` = { status, version } ก่อนชำระ · กลับรายการภายหลังไม่ยิงซ้ำ (ดู `payment.reversed`) · สถานะชำระจากระบบบัญชี ยิงผ่านทางเดียวกัน

`data.object` = `InvoiceDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `ivc_…` |
| `invoiceNo` | ใช่ | `string` | null ได้ | เลขใบแจ้งหนี้ — **ร่างไม่มีเลข** (ออกตอนออกเอกสาร) |   |
| `status` | ใช่ | `string` | ค่า: `DRAFT`, `ISSUED`, `PARTIALLY_PAID`, `PAID`, `ADJUSTED`, `VOIDED`, `CANCELLED` |   |   |
| `customer` | ใช่ | `InvoiceCustomerDto` |   |   |   |
| `periodFrom` | ใช่ | `string` | null ได้ |   |   |
| `periodTo` | ใช่ | `string` | null ได้ |   |   |
| `deliveryOrderCount` | ใช่ | `number` |   |   |   |
| `lineMode` | ใช่ | `string` | ค่า: `SINGLE`, `GROUP`, `MERGE` |   |   |
| `issueDate` | ใช่ | `string` | null ได้ | วันที่ออก (เวลาไทย) — ร่าง = null | `2026-11-20` |
| `dueDate` | ใช่ | `string` | null ได้ | ครบกำหนดชำระ = วันที่ออก + เครดิต — ร่าง = null | `2026-12-20` |
| `overdue` | ใช่ | `boolean` |   | เกินกำหนด — ค้างรับ (ISSUED/PARTIALLY_PAID) และเลยวันครบกำหนด (เวลาไทย) · **ธงแยกจาก `status`** (ใบชำระบางส่วนที่เลยกำหนด = `PARTIALLY_PAID` + `overdue: true`) · ตั้งโดย job รายวัน 00:05 และตอนรับชำระ/กลับรายการ · ชำระครบแล้วหลุดเอง |   |
| `overdueAt` | ใช่ | `string` | null ได้ | เวลาที่ระบบตั้งธงเกินกำหนด — ไม่เกิน = null | `2026-11-21T17:05:00.000Z` |
| `sentToCustomerAt` | ใช่ | `string` | null ได้ | ส่งลูกค้าแล้วเมื่อ — ส่งแล้วยกเลิกใบไม่ได้ (409 `invoice_sent_to_customer`) |   |
| `sentToCustomerChannel` | ใช่ | `string` | ค่า: `MANUAL`, `BILLING_NOTE`, `EMAIL` · null ได้ | ช่องทางที่ทำให้ "ส่งลูกค้าแล้ว": MANUAL = ทำเครื่องหมายเอง · BILLING_NOTE = ออกใบวางบิล · EMAIL = ส่งอีเมล |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |
| `issuingCompanyId` | ใช่ | `string` |   |   | `cmp_…` |
| `issuingBranchId` | ใช่ | `string` |   |   | `brn_…` |
| `creditTermDays` | ใช่ | `number` |   |   |   |
| `customerPoNo` | ใช่ | `string` | null ได้ |   |   |
| `taxEstimated` | ใช่ | `boolean` |   | ยอด VAT/WHT เป็นประมาณการ — true เสมอ |   |
| `deliveryOrders` | ใช่ | `array<InvoiceDeliveryOrderDto>` |   |   |   |
| `cancelledAt` | ใช่ | `string` | null ได้ | เวลายกเลิก · null = ไม่ถูกยกเลิก |   |
| `replacesInvoice` | ใช่ | `InvoiceReplacesDto` | null ได้ | ใบนี้ออกแทนใบที่ยกเลิก · PDF พิมพ์หมายเหตุอ้างเลข/วันที่เดิม |   |
| `replacedByInvoice` | ใช่ | `InvoiceReplacedByDto` | null ได้ | ใบที่ออกแทนใบนี้ (ใบที่ยกเลิกแล้วออกใหม่ — ล่าสุดที่ยังไม่ยกเลิก) |   |
| `issuedAt` | ใช่ | `string` | null ได้ | เวลาออกเอกสาร (ออกเลข) — ร่าง = null |   |
| `billingNoteId` | ใช่ | `string` | null ได้ | ใบวางบิลที่ใบนี้อยู่ · null = ไม่อยู่ในใบวางบิล | `bn_…` |

## invoice.voided {#invoice-voided}

ยกเลิกใบแจ้งหนี้ที่ออกแล้ว (`POST /invoices/{id}/void`) — `data.object` = ใบหลังยกเลิก: `status` CANCELLED + `invoiceNo` เดิม + `cancelledAt` (ไม่มีเหตุผล/ผู้ยกเลิก — ข้อความอิสระ) · `replacedByInvoice` = null เสมอตอนยิง (ร่างฉบับใหม่แทนสร้างหลัง event — ดูผ่าน GET) · `previousAttributes` = { status: ISSUED, version } · ระบบบัญชีที่รับใบไปแล้วยกเลิกตาม

`data.object` = `InvoiceDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `ivc_…` |
| `invoiceNo` | ใช่ | `string` | null ได้ | เลขใบแจ้งหนี้ — **ร่างไม่มีเลข** (ออกตอนออกเอกสาร) |   |
| `status` | ใช่ | `string` | ค่า: `DRAFT`, `ISSUED`, `PARTIALLY_PAID`, `PAID`, `ADJUSTED`, `VOIDED`, `CANCELLED` |   |   |
| `customer` | ใช่ | `InvoiceCustomerDto` |   |   |   |
| `periodFrom` | ใช่ | `string` | null ได้ |   |   |
| `periodTo` | ใช่ | `string` | null ได้ |   |   |
| `deliveryOrderCount` | ใช่ | `number` |   |   |   |
| `lineMode` | ใช่ | `string` | ค่า: `SINGLE`, `GROUP`, `MERGE` |   |   |
| `issueDate` | ใช่ | `string` | null ได้ | วันที่ออก (เวลาไทย) — ร่าง = null | `2026-11-20` |
| `dueDate` | ใช่ | `string` | null ได้ | ครบกำหนดชำระ = วันที่ออก + เครดิต — ร่าง = null | `2026-12-20` |
| `overdue` | ใช่ | `boolean` |   | เกินกำหนด — ค้างรับ (ISSUED/PARTIALLY_PAID) และเลยวันครบกำหนด (เวลาไทย) · **ธงแยกจาก `status`** (ใบชำระบางส่วนที่เลยกำหนด = `PARTIALLY_PAID` + `overdue: true`) · ตั้งโดย job รายวัน 00:05 และตอนรับชำระ/กลับรายการ · ชำระครบแล้วหลุดเอง |   |
| `overdueAt` | ใช่ | `string` | null ได้ | เวลาที่ระบบตั้งธงเกินกำหนด — ไม่เกิน = null | `2026-11-21T17:05:00.000Z` |
| `sentToCustomerAt` | ใช่ | `string` | null ได้ | ส่งลูกค้าแล้วเมื่อ — ส่งแล้วยกเลิกใบไม่ได้ (409 `invoice_sent_to_customer`) |   |
| `sentToCustomerChannel` | ใช่ | `string` | ค่า: `MANUAL`, `BILLING_NOTE`, `EMAIL` · null ได้ | ช่องทางที่ทำให้ "ส่งลูกค้าแล้ว": MANUAL = ทำเครื่องหมายเอง · BILLING_NOTE = ออกใบวางบิล · EMAIL = ส่งอีเมล |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |
| `issuingCompanyId` | ใช่ | `string` |   |   | `cmp_…` |
| `issuingBranchId` | ใช่ | `string` |   |   | `brn_…` |
| `creditTermDays` | ใช่ | `number` |   |   |   |
| `customerPoNo` | ใช่ | `string` | null ได้ |   |   |
| `taxEstimated` | ใช่ | `boolean` |   | ยอด VAT/WHT เป็นประมาณการ — true เสมอ |   |
| `deliveryOrders` | ใช่ | `array<InvoiceDeliveryOrderDto>` |   |   |   |
| `cancelledAt` | ใช่ | `string` | null ได้ | เวลายกเลิก · null = ไม่ถูกยกเลิก |   |
| `replacesInvoice` | ใช่ | `InvoiceReplacesDto` | null ได้ | ใบนี้ออกแทนใบที่ยกเลิก · PDF พิมพ์หมายเหตุอ้างเลข/วันที่เดิม |   |
| `replacedByInvoice` | ใช่ | `InvoiceReplacedByDto` | null ได้ | ใบที่ออกแทนใบนี้ (ใบที่ยกเลิกแล้วออกใหม่ — ล่าสุดที่ยังไม่ยกเลิก) |   |
| `issuedAt` | ใช่ | `string` | null ได้ | เวลาออกเอกสาร (ออกเลข) — ร่าง = null |   |
| `billingNoteId` | ใช่ | `string` | null ได้ | ใบวางบิลที่ใบนี้อยู่ · null = ไม่อยู่ในใบวางบิล | `bn_…` |

## job.completed {#job-completed}

งานเบื้องหลัง (นำเข้า/bulk/ส่งออก/รอบวางบิล) เสร็จ

`data.object` = `JobDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `job_…` |
| `type` | ใช่ | `string` |   |   |   |
| `status` | ใช่ | `string` | ค่า: `pending`, `running`, `succeeded`, `succeeded_with_errors`, `failed`, `skipped` | `succeeded_with_errors` = ทำครบแต่บางรายการไม่ผ่าน (bulk — ดู `result.results[]`) · `failed` = งานล้มทั้งงาน · client ต้องรับค่าที่ไม่รู้จักได้ |   |
| `progress` | ใช่ | `number` | ≥ 0 · ≤ 100 |   |   |
| `result` | ใช่ | `object` | null ได้ |   |   |
| `error` | ใช่ | `object` | null ได้ |   |   |
| `attempts` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `finishedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |

## order.cancelled {#order-cancelled}

ยกเลิกใบสั่งงาน

`data.object` = `OrderDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `ord_3f2a…` |
| `soNo` | ใช่ | `string` | null ได้ | ร่าง = null | `SO-6911-0001` |
| `status` | ใช่ | `string` | ค่า: `draft`, `received`, `on_hold`, `planned`, `in_transit`, `partially_delivered`, `delivered`, `closed`, `cancelled` |   |   |
| `source` | ใช่ | `string` |   | ที่มาตาม C: MANUAL / EXCEL / API / PORTAL / ERP:{connector} | `ERP:krs` |
| `sourceType` | ใช่ | `string` | ค่า: `MANUAL`, `IMPORT`, `API`, `PORTAL`, `CONNECTOR` | ชนิดที่มา (ใช้กับป้ายที่มา): MANUAL / IMPORT / API / PORTAL / CONNECTOR |   |
| `connector` | ใช่ | `string` | null ได้ | รหัส connector | `krs` |
| `externalId` | ใช่ | `string` | null ได้ | externalRef ของระบบต้นทาง |   |
| `customer` | ใช่ | `OrderCustomerDto` |   |   |   |
| `billingCompanyId` | ใช่ | `string` |   |   |   |
| `customerRef` | ใช่ | `string` | null ได้ |   |   |
| `requestedDate` | ใช่ | `string` |   |   | `2026-11-12` |
| `vehicleTypeId` | ใช่ | `string` | null ได้ |   |   |
| `holdReason` | ใช่ | `OrderHoldReasonDto` | null ได้ | เหตุค้าง (ON_HOLD) |   |
| `holdCodes` | ใช่ | `array<string>` |   | เหตุค้างทั้งหมดของการรับงานครั้งล่าสุด (ตัวแรก = holdReason) |   |
| `rescheduledDate` | ใช่ | `string` | null ได้ | วันที่นัดส่งใหม่ล่าสุดของ DO ส่งใหม่ที่ยังรอจัด (null = ไม่มี) — หน้าใบค้าง/รายการแสดงแทนกำหนดส่งเดิม | `2026-11-18` |
| `pricingStatus` | ใช่ | `string` | ค่า: `AVAILABLE`, `RATE_MISSING`, `CALCULATION_FAILURE` |   |   |
| `pricingReasons` | ใช่ | `array<OrderPricingReasonDto>` |   |   |   |
| `stops` | ใช่ | `array<OrderStopDto>` |   |   |   |
| `lines` | ใช่ | `array<OrderLineDto>` |   |   |   |
| `sourceChangedAfterPlan` | ใช่ | `boolean` |   | ต้นทาง (connector) แก้ใบหลังวางแผน — ไม่ทับข้อมูล รอคนรับ/ไม่รับ (`sourceChange`) · สถานะใบไม่เปลี่ยน |   |
| `sourceChange` | ใช่ | `OrderSourceChangeDto` | null ได้ | ชุดการเปลี่ยนแปลงจากต้นทางที่รอตัดสิน (รับ: POST …/source-changes/{changeId}/accept · ไม่รับ: …/reject) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |

## order.created {#order-created}

สร้างใบสั่งงานใหม่ (หน้าจอ, Open API, นำเข้าไฟล์)

`data.object` = `OrderDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `ord_3f2a…` |
| `soNo` | ใช่ | `string` | null ได้ | ร่าง = null | `SO-6911-0001` |
| `status` | ใช่ | `string` | ค่า: `draft`, `received`, `on_hold`, `planned`, `in_transit`, `partially_delivered`, `delivered`, `closed`, `cancelled` |   |   |
| `source` | ใช่ | `string` |   | ที่มาตาม C: MANUAL / EXCEL / API / PORTAL / ERP:{connector} | `ERP:krs` |
| `sourceType` | ใช่ | `string` | ค่า: `MANUAL`, `IMPORT`, `API`, `PORTAL`, `CONNECTOR` | ชนิดที่มา (ใช้กับป้ายที่มา): MANUAL / IMPORT / API / PORTAL / CONNECTOR |   |
| `connector` | ใช่ | `string` | null ได้ | รหัส connector | `krs` |
| `externalId` | ใช่ | `string` | null ได้ | externalRef ของระบบต้นทาง |   |
| `customer` | ใช่ | `OrderCustomerDto` |   |   |   |
| `billingCompanyId` | ใช่ | `string` |   |   |   |
| `customerRef` | ใช่ | `string` | null ได้ |   |   |
| `requestedDate` | ใช่ | `string` |   |   | `2026-11-12` |
| `vehicleTypeId` | ใช่ | `string` | null ได้ |   |   |
| `holdReason` | ใช่ | `OrderHoldReasonDto` | null ได้ | เหตุค้าง (ON_HOLD) |   |
| `holdCodes` | ใช่ | `array<string>` |   | เหตุค้างทั้งหมดของการรับงานครั้งล่าสุด (ตัวแรก = holdReason) |   |
| `rescheduledDate` | ใช่ | `string` | null ได้ | วันที่นัดส่งใหม่ล่าสุดของ DO ส่งใหม่ที่ยังรอจัด (null = ไม่มี) — หน้าใบค้าง/รายการแสดงแทนกำหนดส่งเดิม | `2026-11-18` |
| `pricingStatus` | ใช่ | `string` | ค่า: `AVAILABLE`, `RATE_MISSING`, `CALCULATION_FAILURE` |   |   |
| `pricingReasons` | ใช่ | `array<OrderPricingReasonDto>` |   |   |   |
| `stops` | ใช่ | `array<OrderStopDto>` |   |   |   |
| `lines` | ใช่ | `array<OrderLineDto>` |   |   |   |
| `sourceChangedAfterPlan` | ใช่ | `boolean` |   | ต้นทาง (connector) แก้ใบหลังวางแผน — ไม่ทับข้อมูล รอคนรับ/ไม่รับ (`sourceChange`) · สถานะใบไม่เปลี่ยน |   |
| `sourceChange` | ใช่ | `OrderSourceChangeDto` | null ได้ | ชุดการเปลี่ยนแปลงจากต้นทางที่รอตัดสิน (รับ: POST …/source-changes/{changeId}/accept · ไม่รับ: …/reject) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |

## order.held {#order-held}

พักใบสั่งงาน (เช่น ข้อมูลไม่ครบ เกินวงเงิน)

`data.object` = `OrderDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `ord_3f2a…` |
| `soNo` | ใช่ | `string` | null ได้ | ร่าง = null | `SO-6911-0001` |
| `status` | ใช่ | `string` | ค่า: `draft`, `received`, `on_hold`, `planned`, `in_transit`, `partially_delivered`, `delivered`, `closed`, `cancelled` |   |   |
| `source` | ใช่ | `string` |   | ที่มาตาม C: MANUAL / EXCEL / API / PORTAL / ERP:{connector} | `ERP:krs` |
| `sourceType` | ใช่ | `string` | ค่า: `MANUAL`, `IMPORT`, `API`, `PORTAL`, `CONNECTOR` | ชนิดที่มา (ใช้กับป้ายที่มา): MANUAL / IMPORT / API / PORTAL / CONNECTOR |   |
| `connector` | ใช่ | `string` | null ได้ | รหัส connector | `krs` |
| `externalId` | ใช่ | `string` | null ได้ | externalRef ของระบบต้นทาง |   |
| `customer` | ใช่ | `OrderCustomerDto` |   |   |   |
| `billingCompanyId` | ใช่ | `string` |   |   |   |
| `customerRef` | ใช่ | `string` | null ได้ |   |   |
| `requestedDate` | ใช่ | `string` |   |   | `2026-11-12` |
| `vehicleTypeId` | ใช่ | `string` | null ได้ |   |   |
| `holdReason` | ใช่ | `OrderHoldReasonDto` | null ได้ | เหตุค้าง (ON_HOLD) |   |
| `holdCodes` | ใช่ | `array<string>` |   | เหตุค้างทั้งหมดของการรับงานครั้งล่าสุด (ตัวแรก = holdReason) |   |
| `rescheduledDate` | ใช่ | `string` | null ได้ | วันที่นัดส่งใหม่ล่าสุดของ DO ส่งใหม่ที่ยังรอจัด (null = ไม่มี) — หน้าใบค้าง/รายการแสดงแทนกำหนดส่งเดิม | `2026-11-18` |
| `pricingStatus` | ใช่ | `string` | ค่า: `AVAILABLE`, `RATE_MISSING`, `CALCULATION_FAILURE` |   |   |
| `pricingReasons` | ใช่ | `array<OrderPricingReasonDto>` |   |   |   |
| `stops` | ใช่ | `array<OrderStopDto>` |   |   |   |
| `lines` | ใช่ | `array<OrderLineDto>` |   |   |   |
| `sourceChangedAfterPlan` | ใช่ | `boolean` |   | ต้นทาง (connector) แก้ใบหลังวางแผน — ไม่ทับข้อมูล รอคนรับ/ไม่รับ (`sourceChange`) · สถานะใบไม่เปลี่ยน |   |
| `sourceChange` | ใช่ | `OrderSourceChangeDto` | null ได้ | ชุดการเปลี่ยนแปลงจากต้นทางที่รอตัดสิน (รับ: POST …/source-changes/{changeId}/accept · ไม่รับ: …/reject) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |

## order.released {#order-released}

ปล่อยใบสั่งงานที่พักไว้ให้วางแผนต่อ

`data.object` = `OrderDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `ord_3f2a…` |
| `soNo` | ใช่ | `string` | null ได้ | ร่าง = null | `SO-6911-0001` |
| `status` | ใช่ | `string` | ค่า: `draft`, `received`, `on_hold`, `planned`, `in_transit`, `partially_delivered`, `delivered`, `closed`, `cancelled` |   |   |
| `source` | ใช่ | `string` |   | ที่มาตาม C: MANUAL / EXCEL / API / PORTAL / ERP:{connector} | `ERP:krs` |
| `sourceType` | ใช่ | `string` | ค่า: `MANUAL`, `IMPORT`, `API`, `PORTAL`, `CONNECTOR` | ชนิดที่มา (ใช้กับป้ายที่มา): MANUAL / IMPORT / API / PORTAL / CONNECTOR |   |
| `connector` | ใช่ | `string` | null ได้ | รหัส connector | `krs` |
| `externalId` | ใช่ | `string` | null ได้ | externalRef ของระบบต้นทาง |   |
| `customer` | ใช่ | `OrderCustomerDto` |   |   |   |
| `billingCompanyId` | ใช่ | `string` |   |   |   |
| `customerRef` | ใช่ | `string` | null ได้ |   |   |
| `requestedDate` | ใช่ | `string` |   |   | `2026-11-12` |
| `vehicleTypeId` | ใช่ | `string` | null ได้ |   |   |
| `holdReason` | ใช่ | `OrderHoldReasonDto` | null ได้ | เหตุค้าง (ON_HOLD) |   |
| `holdCodes` | ใช่ | `array<string>` |   | เหตุค้างทั้งหมดของการรับงานครั้งล่าสุด (ตัวแรก = holdReason) |   |
| `rescheduledDate` | ใช่ | `string` | null ได้ | วันที่นัดส่งใหม่ล่าสุดของ DO ส่งใหม่ที่ยังรอจัด (null = ไม่มี) — หน้าใบค้าง/รายการแสดงแทนกำหนดส่งเดิม | `2026-11-18` |
| `pricingStatus` | ใช่ | `string` | ค่า: `AVAILABLE`, `RATE_MISSING`, `CALCULATION_FAILURE` |   |   |
| `pricingReasons` | ใช่ | `array<OrderPricingReasonDto>` |   |   |   |
| `stops` | ใช่ | `array<OrderStopDto>` |   |   |   |
| `lines` | ใช่ | `array<OrderLineDto>` |   |   |   |
| `sourceChangedAfterPlan` | ใช่ | `boolean` |   | ต้นทาง (connector) แก้ใบหลังวางแผน — ไม่ทับข้อมูล รอคนรับ/ไม่รับ (`sourceChange`) · สถานะใบไม่เปลี่ยน |   |
| `sourceChange` | ใช่ | `OrderSourceChangeDto` | null ได้ | ชุดการเปลี่ยนแปลงจากต้นทางที่รอตัดสิน (รับ: POST …/source-changes/{changeId}/accept · ไม่รับ: …/reject) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |

## order.updated {#order-updated}

แก้ไขข้อมูลใบสั่งงาน

`data.object` = `OrderDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `ord_3f2a…` |
| `soNo` | ใช่ | `string` | null ได้ | ร่าง = null | `SO-6911-0001` |
| `status` | ใช่ | `string` | ค่า: `draft`, `received`, `on_hold`, `planned`, `in_transit`, `partially_delivered`, `delivered`, `closed`, `cancelled` |   |   |
| `source` | ใช่ | `string` |   | ที่มาตาม C: MANUAL / EXCEL / API / PORTAL / ERP:{connector} | `ERP:krs` |
| `sourceType` | ใช่ | `string` | ค่า: `MANUAL`, `IMPORT`, `API`, `PORTAL`, `CONNECTOR` | ชนิดที่มา (ใช้กับป้ายที่มา): MANUAL / IMPORT / API / PORTAL / CONNECTOR |   |
| `connector` | ใช่ | `string` | null ได้ | รหัส connector | `krs` |
| `externalId` | ใช่ | `string` | null ได้ | externalRef ของระบบต้นทาง |   |
| `customer` | ใช่ | `OrderCustomerDto` |   |   |   |
| `billingCompanyId` | ใช่ | `string` |   |   |   |
| `customerRef` | ใช่ | `string` | null ได้ |   |   |
| `requestedDate` | ใช่ | `string` |   |   | `2026-11-12` |
| `vehicleTypeId` | ใช่ | `string` | null ได้ |   |   |
| `holdReason` | ใช่ | `OrderHoldReasonDto` | null ได้ | เหตุค้าง (ON_HOLD) |   |
| `holdCodes` | ใช่ | `array<string>` |   | เหตุค้างทั้งหมดของการรับงานครั้งล่าสุด (ตัวแรก = holdReason) |   |
| `rescheduledDate` | ใช่ | `string` | null ได้ | วันที่นัดส่งใหม่ล่าสุดของ DO ส่งใหม่ที่ยังรอจัด (null = ไม่มี) — หน้าใบค้าง/รายการแสดงแทนกำหนดส่งเดิม | `2026-11-18` |
| `pricingStatus` | ใช่ | `string` | ค่า: `AVAILABLE`, `RATE_MISSING`, `CALCULATION_FAILURE` |   |   |
| `pricingReasons` | ใช่ | `array<OrderPricingReasonDto>` |   |   |   |
| `stops` | ใช่ | `array<OrderStopDto>` |   |   |   |
| `lines` | ใช่ | `array<OrderLineDto>` |   |   |   |
| `sourceChangedAfterPlan` | ใช่ | `boolean` |   | ต้นทาง (connector) แก้ใบหลังวางแผน — ไม่ทับข้อมูล รอคนรับ/ไม่รับ (`sourceChange`) · สถานะใบไม่เปลี่ยน |   |
| `sourceChange` | ใช่ | `OrderSourceChangeDto` | null ได้ | ชุดการเปลี่ยนแปลงจากต้นทางที่รอตัดสิน (รับ: POST …/source-changes/{changeId}/accept · ไม่รับ: …/reject) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |

## payment.recorded {#payment-recorded}

บันทึกรับชำระเงิน

`data.object` = `PaymentDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `pay_…` |
| `paymentNo` | ใช่ | `string` |   | เลขภายใน | `PAY-2611-0001` |
| `customer` | ใช่ | `PaymentCustomerDto` |   |   |   |
| `receivedDate` | ใช่ | `string` |   |   | `2026-11-21` |
| `method` | ใช่ | `string` | ค่า: `TRANSFER`, `CHEQUE`, `CASH`, `OFFSET` |   |   |
| `reference` | ใช่ | `string` | null ได้ |   |   |
| `chequeNo` | ใช่ | `string` | null ได้ |   |   |
| `chequeBank` | ใช่ | `string` | null ได้ |   |   |
| `chequeDate` | ใช่ | `string` | null ได้ |   |   |
| `chequeStatus` | ใช่ | `string` | ค่า: `PENDING`, `CLEARED`, `BOUNCED` · null ได้ | สถานะเช็ค (รอเคลียร์ / ผ่าน / เช็คคืน) — ไม่ใช่เช็ค = null |   |
| `whtCertificateNo` | ใช่ | `string` | null ได้ | เลขที่ 50 ทวิ ที่ลูกค้าแจ้ง |   |
| `source` | ใช่ | `string` | ค่า: `MANUAL`, `CONNECTOR` |   |   |
| `status` | ใช่ | `string` | ค่า: `RECORDED`, `REVERSED` | RECORDED · REVERSED (กลับรายการแล้ว — ไม่นับเป็นยอดรับ) |   |
| `allocations` | ใช่ | `array<PaymentAllocationDto>` |   |   |   |
| `reversedAt` | ใช่ | `string` | null ได้ |   |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |

## payment.reversed {#payment-reversed}

กลับรายการรับชำระเงิน (รวมเช็คคืน — `chequeStatus` = BOUNCED) ยอดค้างของใบกลับมา

`data.object` = `PaymentDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `pay_…` |
| `paymentNo` | ใช่ | `string` |   | เลขภายใน | `PAY-2611-0001` |
| `customer` | ใช่ | `PaymentCustomerDto` |   |   |   |
| `receivedDate` | ใช่ | `string` |   |   | `2026-11-21` |
| `method` | ใช่ | `string` | ค่า: `TRANSFER`, `CHEQUE`, `CASH`, `OFFSET` |   |   |
| `reference` | ใช่ | `string` | null ได้ |   |   |
| `chequeNo` | ใช่ | `string` | null ได้ |   |   |
| `chequeBank` | ใช่ | `string` | null ได้ |   |   |
| `chequeDate` | ใช่ | `string` | null ได้ |   |   |
| `chequeStatus` | ใช่ | `string` | ค่า: `PENDING`, `CLEARED`, `BOUNCED` · null ได้ | สถานะเช็ค (รอเคลียร์ / ผ่าน / เช็คคืน) — ไม่ใช่เช็ค = null |   |
| `whtCertificateNo` | ใช่ | `string` | null ได้ | เลขที่ 50 ทวิ ที่ลูกค้าแจ้ง |   |
| `source` | ใช่ | `string` | ค่า: `MANUAL`, `CONNECTOR` |   |   |
| `status` | ใช่ | `string` | ค่า: `RECORDED`, `REVERSED` | RECORDED · REVERSED (กลับรายการแล้ว — ไม่นับเป็นยอดรับ) |   |
| `allocations` | ใช่ | `array<PaymentAllocationDto>` |   |   |   |
| `reversedAt` | ใช่ | `string` | null ได้ |   |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |

## pod.captured {#pod-captured}

บันทึกหลักฐานการส่ง (POD)

`data.object` = `DeliveryOrderPodDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `deliveryOrderId` | ใช่ | `string` |   |   | `do_…` |
| `doNo` | ใช่ | `string` |   |   | `DO-2611-00052` |
| `doStatus` | ใช่ | `string` |   | สถานะ DO (ตัวใหญ่ — เหมือน GET /v1/delivery-orders/{id}) | `UNBILLED` |
| `podStatus` | ใช่ | `string` | ค่า: `NONE`, `PARTIAL`, `COMPLETE` |   |   |
| `editable` | ใช่ | `boolean` |   | บันทึก/แก้หลักฐานได้ในสถานะ DO ปัจจุบัน (ส่งแล้ว/ส่งไม่สำเร็จ ยังไม่วางบิล) |   |
| `plannedWeightKg` | ใช่ | `string` | null ได้ | น้ำหนักตามใบสั่ง | `15000` |
| `checklist` | ใช่ | `EffectivePodChecklistDto` |   | checklist ที่ใช้จริงตอนนี้ (ชุดตามสถานะ DO: ส่งไม่สำเร็จ = ชุดไม่สำเร็จ) |   |
| `missing` | ใช่ | `array<PodMissingDto>` |   | เทียบหลักฐานปัจจุบันกับ checklist ตอนนี้ (ว่าง = ครบ) |   |
| `current` | ใช่ | `PodRecordDto` | null ได้ | ฉบับปัจจุบัน — null = ยังไม่มี |   |
| `versions` | ใช่ | `array<PodVersionDto>` |   | ทุกฉบับ ใหม่ → เก่า |   |
| `lines` | ใช่ | `array<PodLineDto>` |   | บรรทัดของ DO (แผน vs ส่งจริง vs ปฏิเสธ + เหตุผล) ตามฉบับล่าสุด |   |

## receipt.issued {#receipt-issued}

ออกใบเสร็จรับเงินแล้ว

> ยังไม่ส่ง — ชื่อและ schema จองไว้ (สมัครรับล่วงหน้าได้)

`data.object` = 

## reconcile.mismatch_found {#reconcile-mismatch_found}

พบข้อมูลไม่ตรงกันจากการกระทบยอดกับระบบภายนอก

> ยังไม่ส่ง — ชื่อและ schema จองไว้ (สมัครรับล่วงหน้าได้)

`data.object` = 

## settlement.approved {#settlement-approved}

อนุมัติใบสำคัญจ่ายรถร่วม (ออกเลข STL แล้ว — ผู้อนุมัติไม่ใช่ผู้สร้าง)

`data.object` = `SettlementDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `stl_…` |
| `settlementNo` | ใช่ | `string` | null ได้ | เลขเอกสาร (ชุด STL) — ร่างยังไม่มีเลข · ออกตอนอนุมัติ |   |
| `status` | ใช่ | `string` | ค่า: `DRAFT`, `SENT_TO_CARRIER`, `DISPUTED`, `APPROVED`, `CANCELLED` |   |   |
| `carrier` | ใช่ | `SettlementCarrierDto` |   |   |   |
| `payingCompanyId` | ใช่ | `string` | null ได้ | นิติบุคคลที่จ่าย ("จ้างในนาม" ของรถร่วม — null = ค่าเริ่มต้นองค์กร) |   |
| `periodFrom` | ใช่ | `string` |   |   | `2026-11-01` |
| `periodTo` | ใช่ | `string` |   |   | `2026-11-15` |
| `carrierInvoiceNo` | ใช่ | `string` | null ได้ |   |   |
| `carrierInvoiceDate` | ใช่ | `string` | null ได้ |   |   |
| `carrierReceiptNo` | ใช่ | `string` | null ได้ |   |   |
| `tripCount` | ใช่ | `number` |   | จำนวนเที่ยวในใบ (บรรทัดที่ยังใช้) |   |
| `approvedAt` | ใช่ | `string` | null ได้ | เวลาอนุมัติ — ออกเลข `settlementNo` พร้อมกัน |   |
| `sentAt` | ใช่ | `string` | null ได้ | ส่งให้รถร่วมตรวจล่าสุด — ผู้ส่งนับเป็นผู้เตรียมใบ (อนุมัติใบนี้ไม่ได้) |   |
| `carrierReview` | ใช่ | `SettlementCarrierReviewDto` |   |   |   |
| `dispute` | ใช่ | `SettlementDisputeSummaryDto` |   |   |   |
| `cancelledAt` | ใช่ | `string` | null ได้ |   |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |

## settlement.paid {#settlement-paid}

จ่ายเงินตามใบสรุปค่าขนส่งรถร่วมแล้ว

> ยังไม่ส่ง — ชื่อและ schema จองไว้ (สมัครรับล่วงหน้าได้)

`data.object` = 

## stop.arrived {#stop-arrived}

รถถึงจุดรับ/ส่ง

`data.object` = `TripStopDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `stp_3f2a…` |
| `sequence` | ใช่ | `number` |   |   |   |
| `type` | ใช่ | `string` | ค่า: `PICKUP`, `DELIVERY`, `RETURN` |   |   |
| `siteId` | ใช่ | `string` |   |   | `loc_3f2a…` |
| `status` | ใช่ | `string` | ค่า: `PENDING`, `ARRIVED`, `COMPLETED`, `FAILED`, `SKIPPED` |   |   |
| `windowStart` | ใช่ | `string` | null ได้ | ช่วงเวลาที่ลูกค้าขอ (ส่วนที่ทุก DO รับได้) |   |
| `windowEnd` | ใช่ | `string` | null ได้ |   |   |
| `plannedArrival` | ใช่ | `string` | null ได้ |   |   |
| `plannedDeparture` | ใช่ | `string` | null ได้ |   |   |
| `deliveryOrderIds` | ใช่ | `array<string>` |   | DO ที่รับ (PICKUP) / ส่ง (DELIVERY) ที่จุดนี้ |   |
| `siteName` | ใช่ | `string` |   | ชื่อสถานที่ (ปัจจุบัน) | `คลังสินค้าบางนา` |
| `legDistanceKm` | ใช่ | `string` | null ได้ | ระยะช่วงวิ่งจากจุดก่อนหน้า (กม.) — จุดแรก/ไม่ทราบ = null | `45.2` |
| `legMinutes` | ใช่ | `number` | null ได้ | เวลาเดินทางช่วงนี้ (นาที) | `55` |
| `legSource` | ใช่ | `string` | ค่า: `ROUTE`, `ESTIMATE`, `SAME_SITE` · null ได้ | ที่มา: ROUTE = เส้นทางใน route master · ESTIMATE = ค่าประมาณจากพิกัด (เส้นตรง × 1.3, 50 กม./ชม.) · SAME_SITE = จุดเดียวกัน |   |
| `arrivedAt` | ใช่ | `string (date-time)` | null ได้ | เวลาถึงจุด |   |
| `departedAt` | ใช่ | `string (date-time)` | null ได้ | เวลาออกจากจุด = DEPART ของจุดถัดไป ถ้าไม่มี = เวลาปิดงานของจุดนี้ · ไม่เคยถึง = null |   |
| `outcome` | ใช่ | `string` | ค่า: `DELIVERED`, `PARTIAL`, `FAILED`, `UNDELIVERED_RETAIN` · null ได้ | ผลของจุดที่ปิดแล้ว |   |
| `lastEventId` | ใช่ | `string` | null ได้ | event ล่าสุดที่เปลี่ยนสถานะจุด — รายละเอียด/ชื่อผู้บันทึกจาก `GET /v1/trips/{id}/events` | `evt_3f2a…` |
| `reschedules` | ใช่ | `array<TripStopRescheduleDto>` |   | DO ที่ส่งไม่สำเร็จที่จุดนี้แล้วถูกส่งใหม่ (นัดส่งใหม่อัตโนมัติ/ส่งซ้ำ) — DO ใบเดิมเป็น CANCELLED จึงไม่อยู่ใน `deliveryOrders` |   |
| `tripId` | ใช่ | `string` |   | เที่ยวของจุดนี้ | `trp_…` |

## stop.completed {#stop-completed}

ปิดงานที่จุดรับ/ส่งสำเร็จ

`data.object` = `TripStopDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `stp_3f2a…` |
| `sequence` | ใช่ | `number` |   |   |   |
| `type` | ใช่ | `string` | ค่า: `PICKUP`, `DELIVERY`, `RETURN` |   |   |
| `siteId` | ใช่ | `string` |   |   | `loc_3f2a…` |
| `status` | ใช่ | `string` | ค่า: `PENDING`, `ARRIVED`, `COMPLETED`, `FAILED`, `SKIPPED` |   |   |
| `windowStart` | ใช่ | `string` | null ได้ | ช่วงเวลาที่ลูกค้าขอ (ส่วนที่ทุก DO รับได้) |   |
| `windowEnd` | ใช่ | `string` | null ได้ |   |   |
| `plannedArrival` | ใช่ | `string` | null ได้ |   |   |
| `plannedDeparture` | ใช่ | `string` | null ได้ |   |   |
| `deliveryOrderIds` | ใช่ | `array<string>` |   | DO ที่รับ (PICKUP) / ส่ง (DELIVERY) ที่จุดนี้ |   |
| `siteName` | ใช่ | `string` |   | ชื่อสถานที่ (ปัจจุบัน) | `คลังสินค้าบางนา` |
| `legDistanceKm` | ใช่ | `string` | null ได้ | ระยะช่วงวิ่งจากจุดก่อนหน้า (กม.) — จุดแรก/ไม่ทราบ = null | `45.2` |
| `legMinutes` | ใช่ | `number` | null ได้ | เวลาเดินทางช่วงนี้ (นาที) | `55` |
| `legSource` | ใช่ | `string` | ค่า: `ROUTE`, `ESTIMATE`, `SAME_SITE` · null ได้ | ที่มา: ROUTE = เส้นทางใน route master · ESTIMATE = ค่าประมาณจากพิกัด (เส้นตรง × 1.3, 50 กม./ชม.) · SAME_SITE = จุดเดียวกัน |   |
| `arrivedAt` | ใช่ | `string (date-time)` | null ได้ | เวลาถึงจุด |   |
| `departedAt` | ใช่ | `string (date-time)` | null ได้ | เวลาออกจากจุด = DEPART ของจุดถัดไป ถ้าไม่มี = เวลาปิดงานของจุดนี้ · ไม่เคยถึง = null |   |
| `outcome` | ใช่ | `string` | ค่า: `DELIVERED`, `PARTIAL`, `FAILED`, `UNDELIVERED_RETAIN` · null ได้ | ผลของจุดที่ปิดแล้ว |   |
| `lastEventId` | ใช่ | `string` | null ได้ | event ล่าสุดที่เปลี่ยนสถานะจุด — รายละเอียด/ชื่อผู้บันทึกจาก `GET /v1/trips/{id}/events` | `evt_3f2a…` |
| `reschedules` | ใช่ | `array<TripStopRescheduleDto>` |   | DO ที่ส่งไม่สำเร็จที่จุดนี้แล้วถูกส่งใหม่ (นัดส่งใหม่อัตโนมัติ/ส่งซ้ำ) — DO ใบเดิมเป็น CANCELLED จึงไม่อยู่ใน `deliveryOrders` |   |
| `tripId` | ใช่ | `string` |   | เที่ยวของจุดนี้ | `trp_…` |

## stop.departed {#stop-departed}

รถออกจากจุดรับ/ส่ง

`data.object` = `TripStopDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `stp_3f2a…` |
| `sequence` | ใช่ | `number` |   |   |   |
| `type` | ใช่ | `string` | ค่า: `PICKUP`, `DELIVERY`, `RETURN` |   |   |
| `siteId` | ใช่ | `string` |   |   | `loc_3f2a…` |
| `status` | ใช่ | `string` | ค่า: `PENDING`, `ARRIVED`, `COMPLETED`, `FAILED`, `SKIPPED` |   |   |
| `windowStart` | ใช่ | `string` | null ได้ | ช่วงเวลาที่ลูกค้าขอ (ส่วนที่ทุก DO รับได้) |   |
| `windowEnd` | ใช่ | `string` | null ได้ |   |   |
| `plannedArrival` | ใช่ | `string` | null ได้ |   |   |
| `plannedDeparture` | ใช่ | `string` | null ได้ |   |   |
| `deliveryOrderIds` | ใช่ | `array<string>` |   | DO ที่รับ (PICKUP) / ส่ง (DELIVERY) ที่จุดนี้ |   |
| `siteName` | ใช่ | `string` |   | ชื่อสถานที่ (ปัจจุบัน) | `คลังสินค้าบางนา` |
| `legDistanceKm` | ใช่ | `string` | null ได้ | ระยะช่วงวิ่งจากจุดก่อนหน้า (กม.) — จุดแรก/ไม่ทราบ = null | `45.2` |
| `legMinutes` | ใช่ | `number` | null ได้ | เวลาเดินทางช่วงนี้ (นาที) | `55` |
| `legSource` | ใช่ | `string` | ค่า: `ROUTE`, `ESTIMATE`, `SAME_SITE` · null ได้ | ที่มา: ROUTE = เส้นทางใน route master · ESTIMATE = ค่าประมาณจากพิกัด (เส้นตรง × 1.3, 50 กม./ชม.) · SAME_SITE = จุดเดียวกัน |   |
| `arrivedAt` | ใช่ | `string (date-time)` | null ได้ | เวลาถึงจุด |   |
| `departedAt` | ใช่ | `string (date-time)` | null ได้ | เวลาออกจากจุด = DEPART ของจุดถัดไป ถ้าไม่มี = เวลาปิดงานของจุดนี้ · ไม่เคยถึง = null |   |
| `outcome` | ใช่ | `string` | ค่า: `DELIVERED`, `PARTIAL`, `FAILED`, `UNDELIVERED_RETAIN` · null ได้ | ผลของจุดที่ปิดแล้ว |   |
| `lastEventId` | ใช่ | `string` | null ได้ | event ล่าสุดที่เปลี่ยนสถานะจุด — รายละเอียด/ชื่อผู้บันทึกจาก `GET /v1/trips/{id}/events` | `evt_3f2a…` |
| `reschedules` | ใช่ | `array<TripStopRescheduleDto>` |   | DO ที่ส่งไม่สำเร็จที่จุดนี้แล้วถูกส่งใหม่ (นัดส่งใหม่อัตโนมัติ/ส่งซ้ำ) — DO ใบเดิมเป็น CANCELLED จึงไม่อยู่ใน `deliveryOrders` |   |
| `tripId` | ใช่ | `string` |   | เที่ยวของจุดนี้ | `trp_…` |

## stop.failed {#stop-failed}

งานที่จุดรับ/ส่งไม่สำเร็จ (มีเหตุผล)

`data.object` = `TripStopDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `stp_3f2a…` |
| `sequence` | ใช่ | `number` |   |   |   |
| `type` | ใช่ | `string` | ค่า: `PICKUP`, `DELIVERY`, `RETURN` |   |   |
| `siteId` | ใช่ | `string` |   |   | `loc_3f2a…` |
| `status` | ใช่ | `string` | ค่า: `PENDING`, `ARRIVED`, `COMPLETED`, `FAILED`, `SKIPPED` |   |   |
| `windowStart` | ใช่ | `string` | null ได้ | ช่วงเวลาที่ลูกค้าขอ (ส่วนที่ทุก DO รับได้) |   |
| `windowEnd` | ใช่ | `string` | null ได้ |   |   |
| `plannedArrival` | ใช่ | `string` | null ได้ |   |   |
| `plannedDeparture` | ใช่ | `string` | null ได้ |   |   |
| `deliveryOrderIds` | ใช่ | `array<string>` |   | DO ที่รับ (PICKUP) / ส่ง (DELIVERY) ที่จุดนี้ |   |
| `siteName` | ใช่ | `string` |   | ชื่อสถานที่ (ปัจจุบัน) | `คลังสินค้าบางนา` |
| `legDistanceKm` | ใช่ | `string` | null ได้ | ระยะช่วงวิ่งจากจุดก่อนหน้า (กม.) — จุดแรก/ไม่ทราบ = null | `45.2` |
| `legMinutes` | ใช่ | `number` | null ได้ | เวลาเดินทางช่วงนี้ (นาที) | `55` |
| `legSource` | ใช่ | `string` | ค่า: `ROUTE`, `ESTIMATE`, `SAME_SITE` · null ได้ | ที่มา: ROUTE = เส้นทางใน route master · ESTIMATE = ค่าประมาณจากพิกัด (เส้นตรง × 1.3, 50 กม./ชม.) · SAME_SITE = จุดเดียวกัน |   |
| `arrivedAt` | ใช่ | `string (date-time)` | null ได้ | เวลาถึงจุด |   |
| `departedAt` | ใช่ | `string (date-time)` | null ได้ | เวลาออกจากจุด = DEPART ของจุดถัดไป ถ้าไม่มี = เวลาปิดงานของจุดนี้ · ไม่เคยถึง = null |   |
| `outcome` | ใช่ | `string` | ค่า: `DELIVERED`, `PARTIAL`, `FAILED`, `UNDELIVERED_RETAIN` · null ได้ | ผลของจุดที่ปิดแล้ว |   |
| `lastEventId` | ใช่ | `string` | null ได้ | event ล่าสุดที่เปลี่ยนสถานะจุด — รายละเอียด/ชื่อผู้บันทึกจาก `GET /v1/trips/{id}/events` | `evt_3f2a…` |
| `reschedules` | ใช่ | `array<TripStopRescheduleDto>` |   | DO ที่ส่งไม่สำเร็จที่จุดนี้แล้วถูกส่งใหม่ (นัดส่งใหม่อัตโนมัติ/ส่งซ้ำ) — DO ใบเดิมเป็น CANCELLED จึงไม่อยู่ใน `deliveryOrders` |   |
| `tripId` | ใช่ | `string` |   | เที่ยวของจุดนี้ | `trp_…` |

## trip.assigned {#trip-assigned}

จัดรถ/คนขับ หรือรถร่วมให้เที่ยววิ่ง

`data.object` = `TripDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `trp_3f2a…` |
| `tripNo` | ใช่ | `string` |   |   | `TRP-6911-0001` |
| `tripDate` | ใช่ | `string` |   |   | `2026-11-13` |
| `status` | ใช่ | `string` | ค่า: `PLANNING`, `OFFERED`, `ASSIGNED`, `DISPATCHED`, `IN_PROGRESS`, `COMPLETED`, `COSTED`, `SETTLED`, `CANCELLED` |   |   |
| `plannedStartAt` | ใช่ | `string` | null ได้ |   |   |
| `plannedEndAt` | ใช่ | `string` | null ได้ |   |   |
| `vehicle` | ใช่ | `TripVehicleDto` | null ได้ |   |   |
| `trailer` | ใช่ | `TripTrailerDto` | null ได้ |   |   |
| `driver` | ใช่ | `TripDriverDto` | null ได้ |   |   |
| `reliefDriver` | ใช่ | `TripDriverDto` | null ได้ | คนขับสำรอง |   |
| `carrier` | ใช่ | `TripCarrierDto` | null ได้ |   |   |
| `assignmentStatus` | ใช่ | `string` | ค่า: `OFFERED`, `ACCEPTED`, `REJECTED`, `EXPIRED` · null ได้ |   |   |
| `offeredAt` | ใช่ | `string` | null ได้ |   |   |
| `offerExpiresAt` | ใช่ | `string` | null ได้ | ข้อเสนอหมดอายุ (48 ชม.) |   |
| `hire` | ใช่ | `TripHireDto` | null ได้ | การจ้างรถร่วมที่ใช้งานอยู่ (รอตอบ/รับแล้ว) — ราคาซื้อเห็นเมื่อมี `prices.buy:read` |   |
| `assignedAt` | ใช่ | `string` | null ได้ |   |   |
| `dispatchedAt` | ใช่ | `string` | null ได้ |   |   |
| `completedAt` | ใช่ | `string` | null ได้ |   |   |
| `cancelledAt` | ใช่ | `string` | null ได้ |   |   |
| `cancelReason` | ใช่ | `string` | null ได้ |   |   |
| `stops` | ใช่ | `array<TripStopDto>` |   |   |   |
| `deliveryOrders` | ใช่ | `array<TripDeliveryOrderDto>` |   |   |   |
| `rescheduledDeliveryOrders` | ใช่ | `array<TripRescheduledDoDto>` |   | DO ที่ส่งไม่สำเร็จในเที่ยวนี้แล้วนัดส่งใหม่ (ใบเดิม CANCELLED) — "ส่งไม่สำเร็จ · นัดส่งใหม่" · มีค่าเฉพาะ GET /trips/{id} (อื่น = []) |   |
| `weightKg` | ใช่ | `string` |   | น้ำหนักรวมของ DO ในเที่ยว (กก.) | `5400` |
| `route` | ใช่ | `TripRouteSummaryDto` |   | ระยะ/เวลารวมตามลำดับจุดปัจจุบัน (คำนวณใหม่ทุกครั้งที่จุดเปลี่ยน) |   |
| `warnings` | ใช่ | `array<TripWarningDto>` |   | ผลตรวจกฎตอนจัดล่าสุด |   |
| `ruleOverrides` | ใช่ | `array<TripRuleOverrideDto>` |   | ประวัติการยกเว้น/ยืนยันกฎของเที่ยว (เรียงตามเวลา) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |
| `startedAt` |   | `string (date-time)` |   | trip.started: เวลาเริ่มจริง (event หน้างานแรก) |   |

## trip.cancelled {#trip-cancelled}

ยกเลิกเที่ยววิ่ง

`data.object` = `TripDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `trp_3f2a…` |
| `tripNo` | ใช่ | `string` |   |   | `TRP-6911-0001` |
| `tripDate` | ใช่ | `string` |   |   | `2026-11-13` |
| `status` | ใช่ | `string` | ค่า: `PLANNING`, `OFFERED`, `ASSIGNED`, `DISPATCHED`, `IN_PROGRESS`, `COMPLETED`, `COSTED`, `SETTLED`, `CANCELLED` |   |   |
| `plannedStartAt` | ใช่ | `string` | null ได้ |   |   |
| `plannedEndAt` | ใช่ | `string` | null ได้ |   |   |
| `vehicle` | ใช่ | `TripVehicleDto` | null ได้ |   |   |
| `trailer` | ใช่ | `TripTrailerDto` | null ได้ |   |   |
| `driver` | ใช่ | `TripDriverDto` | null ได้ |   |   |
| `reliefDriver` | ใช่ | `TripDriverDto` | null ได้ | คนขับสำรอง |   |
| `carrier` | ใช่ | `TripCarrierDto` | null ได้ |   |   |
| `assignmentStatus` | ใช่ | `string` | ค่า: `OFFERED`, `ACCEPTED`, `REJECTED`, `EXPIRED` · null ได้ |   |   |
| `offeredAt` | ใช่ | `string` | null ได้ |   |   |
| `offerExpiresAt` | ใช่ | `string` | null ได้ | ข้อเสนอหมดอายุ (48 ชม.) |   |
| `hire` | ใช่ | `TripHireDto` | null ได้ | การจ้างรถร่วมที่ใช้งานอยู่ (รอตอบ/รับแล้ว) — ราคาซื้อเห็นเมื่อมี `prices.buy:read` |   |
| `assignedAt` | ใช่ | `string` | null ได้ |   |   |
| `dispatchedAt` | ใช่ | `string` | null ได้ |   |   |
| `completedAt` | ใช่ | `string` | null ได้ |   |   |
| `cancelledAt` | ใช่ | `string` | null ได้ |   |   |
| `cancelReason` | ใช่ | `string` | null ได้ |   |   |
| `stops` | ใช่ | `array<TripStopDto>` |   |   |   |
| `deliveryOrders` | ใช่ | `array<TripDeliveryOrderDto>` |   |   |   |
| `rescheduledDeliveryOrders` | ใช่ | `array<TripRescheduledDoDto>` |   | DO ที่ส่งไม่สำเร็จในเที่ยวนี้แล้วนัดส่งใหม่ (ใบเดิม CANCELLED) — "ส่งไม่สำเร็จ · นัดส่งใหม่" · มีค่าเฉพาะ GET /trips/{id} (อื่น = []) |   |
| `weightKg` | ใช่ | `string` |   | น้ำหนักรวมของ DO ในเที่ยว (กก.) | `5400` |
| `route` | ใช่ | `TripRouteSummaryDto` |   | ระยะ/เวลารวมตามลำดับจุดปัจจุบัน (คำนวณใหม่ทุกครั้งที่จุดเปลี่ยน) |   |
| `warnings` | ใช่ | `array<TripWarningDto>` |   | ผลตรวจกฎตอนจัดล่าสุด |   |
| `ruleOverrides` | ใช่ | `array<TripRuleOverrideDto>` |   | ประวัติการยกเว้น/ยืนยันกฎของเที่ยว (เรียงตามเวลา) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |
| `startedAt` |   | `string (date-time)` |   | trip.started: เวลาเริ่มจริง (event หน้างานแรก) |   |

## trip.completed {#trip-completed}

เที่ยววิ่งจบครบทุกจุด

`data.object` = `TripDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `trp_3f2a…` |
| `tripNo` | ใช่ | `string` |   |   | `TRP-6911-0001` |
| `tripDate` | ใช่ | `string` |   |   | `2026-11-13` |
| `status` | ใช่ | `string` | ค่า: `PLANNING`, `OFFERED`, `ASSIGNED`, `DISPATCHED`, `IN_PROGRESS`, `COMPLETED`, `COSTED`, `SETTLED`, `CANCELLED` |   |   |
| `plannedStartAt` | ใช่ | `string` | null ได้ |   |   |
| `plannedEndAt` | ใช่ | `string` | null ได้ |   |   |
| `vehicle` | ใช่ | `TripVehicleDto` | null ได้ |   |   |
| `trailer` | ใช่ | `TripTrailerDto` | null ได้ |   |   |
| `driver` | ใช่ | `TripDriverDto` | null ได้ |   |   |
| `reliefDriver` | ใช่ | `TripDriverDto` | null ได้ | คนขับสำรอง |   |
| `carrier` | ใช่ | `TripCarrierDto` | null ได้ |   |   |
| `assignmentStatus` | ใช่ | `string` | ค่า: `OFFERED`, `ACCEPTED`, `REJECTED`, `EXPIRED` · null ได้ |   |   |
| `offeredAt` | ใช่ | `string` | null ได้ |   |   |
| `offerExpiresAt` | ใช่ | `string` | null ได้ | ข้อเสนอหมดอายุ (48 ชม.) |   |
| `hire` | ใช่ | `TripHireDto` | null ได้ | การจ้างรถร่วมที่ใช้งานอยู่ (รอตอบ/รับแล้ว) — ราคาซื้อเห็นเมื่อมี `prices.buy:read` |   |
| `assignedAt` | ใช่ | `string` | null ได้ |   |   |
| `dispatchedAt` | ใช่ | `string` | null ได้ |   |   |
| `completedAt` | ใช่ | `string` | null ได้ |   |   |
| `cancelledAt` | ใช่ | `string` | null ได้ |   |   |
| `cancelReason` | ใช่ | `string` | null ได้ |   |   |
| `stops` | ใช่ | `array<TripStopDto>` |   |   |   |
| `deliveryOrders` | ใช่ | `array<TripDeliveryOrderDto>` |   |   |   |
| `rescheduledDeliveryOrders` | ใช่ | `array<TripRescheduledDoDto>` |   | DO ที่ส่งไม่สำเร็จในเที่ยวนี้แล้วนัดส่งใหม่ (ใบเดิม CANCELLED) — "ส่งไม่สำเร็จ · นัดส่งใหม่" · มีค่าเฉพาะ GET /trips/{id} (อื่น = []) |   |
| `weightKg` | ใช่ | `string` |   | น้ำหนักรวมของ DO ในเที่ยว (กก.) | `5400` |
| `route` | ใช่ | `TripRouteSummaryDto` |   | ระยะ/เวลารวมตามลำดับจุดปัจจุบัน (คำนวณใหม่ทุกครั้งที่จุดเปลี่ยน) |   |
| `warnings` | ใช่ | `array<TripWarningDto>` |   | ผลตรวจกฎตอนจัดล่าสุด |   |
| `ruleOverrides` | ใช่ | `array<TripRuleOverrideDto>` |   | ประวัติการยกเว้น/ยืนยันกฎของเที่ยว (เรียงตามเวลา) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |
| `startedAt` |   | `string (date-time)` |   | trip.started: เวลาเริ่มจริง (event หน้างานแรก) |   |

## trip.dispatched {#trip-dispatched}

ปล่อยเที่ยววิ่งให้คนขับ

`data.object` = `TripDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `trp_3f2a…` |
| `tripNo` | ใช่ | `string` |   |   | `TRP-6911-0001` |
| `tripDate` | ใช่ | `string` |   |   | `2026-11-13` |
| `status` | ใช่ | `string` | ค่า: `PLANNING`, `OFFERED`, `ASSIGNED`, `DISPATCHED`, `IN_PROGRESS`, `COMPLETED`, `COSTED`, `SETTLED`, `CANCELLED` |   |   |
| `plannedStartAt` | ใช่ | `string` | null ได้ |   |   |
| `plannedEndAt` | ใช่ | `string` | null ได้ |   |   |
| `vehicle` | ใช่ | `TripVehicleDto` | null ได้ |   |   |
| `trailer` | ใช่ | `TripTrailerDto` | null ได้ |   |   |
| `driver` | ใช่ | `TripDriverDto` | null ได้ |   |   |
| `reliefDriver` | ใช่ | `TripDriverDto` | null ได้ | คนขับสำรอง |   |
| `carrier` | ใช่ | `TripCarrierDto` | null ได้ |   |   |
| `assignmentStatus` | ใช่ | `string` | ค่า: `OFFERED`, `ACCEPTED`, `REJECTED`, `EXPIRED` · null ได้ |   |   |
| `offeredAt` | ใช่ | `string` | null ได้ |   |   |
| `offerExpiresAt` | ใช่ | `string` | null ได้ | ข้อเสนอหมดอายุ (48 ชม.) |   |
| `hire` | ใช่ | `TripHireDto` | null ได้ | การจ้างรถร่วมที่ใช้งานอยู่ (รอตอบ/รับแล้ว) — ราคาซื้อเห็นเมื่อมี `prices.buy:read` |   |
| `assignedAt` | ใช่ | `string` | null ได้ |   |   |
| `dispatchedAt` | ใช่ | `string` | null ได้ |   |   |
| `completedAt` | ใช่ | `string` | null ได้ |   |   |
| `cancelledAt` | ใช่ | `string` | null ได้ |   |   |
| `cancelReason` | ใช่ | `string` | null ได้ |   |   |
| `stops` | ใช่ | `array<TripStopDto>` |   |   |   |
| `deliveryOrders` | ใช่ | `array<TripDeliveryOrderDto>` |   |   |   |
| `rescheduledDeliveryOrders` | ใช่ | `array<TripRescheduledDoDto>` |   | DO ที่ส่งไม่สำเร็จในเที่ยวนี้แล้วนัดส่งใหม่ (ใบเดิม CANCELLED) — "ส่งไม่สำเร็จ · นัดส่งใหม่" · มีค่าเฉพาะ GET /trips/{id} (อื่น = []) |   |
| `weightKg` | ใช่ | `string` |   | น้ำหนักรวมของ DO ในเที่ยว (กก.) | `5400` |
| `route` | ใช่ | `TripRouteSummaryDto` |   | ระยะ/เวลารวมตามลำดับจุดปัจจุบัน (คำนวณใหม่ทุกครั้งที่จุดเปลี่ยน) |   |
| `warnings` | ใช่ | `array<TripWarningDto>` |   | ผลตรวจกฎตอนจัดล่าสุด |   |
| `ruleOverrides` | ใช่ | `array<TripRuleOverrideDto>` |   | ประวัติการยกเว้น/ยืนยันกฎของเที่ยว (เรียงตามเวลา) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |
| `startedAt` |   | `string (date-time)` |   | trip.started: เวลาเริ่มจริง (event หน้างานแรก) |   |

## trip.started {#trip-started}

คนขับเริ่มเที่ยววิ่ง

`data.object` = `TripDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `trp_3f2a…` |
| `tripNo` | ใช่ | `string` |   |   | `TRP-6911-0001` |
| `tripDate` | ใช่ | `string` |   |   | `2026-11-13` |
| `status` | ใช่ | `string` | ค่า: `PLANNING`, `OFFERED`, `ASSIGNED`, `DISPATCHED`, `IN_PROGRESS`, `COMPLETED`, `COSTED`, `SETTLED`, `CANCELLED` |   |   |
| `plannedStartAt` | ใช่ | `string` | null ได้ |   |   |
| `plannedEndAt` | ใช่ | `string` | null ได้ |   |   |
| `vehicle` | ใช่ | `TripVehicleDto` | null ได้ |   |   |
| `trailer` | ใช่ | `TripTrailerDto` | null ได้ |   |   |
| `driver` | ใช่ | `TripDriverDto` | null ได้ |   |   |
| `reliefDriver` | ใช่ | `TripDriverDto` | null ได้ | คนขับสำรอง |   |
| `carrier` | ใช่ | `TripCarrierDto` | null ได้ |   |   |
| `assignmentStatus` | ใช่ | `string` | ค่า: `OFFERED`, `ACCEPTED`, `REJECTED`, `EXPIRED` · null ได้ |   |   |
| `offeredAt` | ใช่ | `string` | null ได้ |   |   |
| `offerExpiresAt` | ใช่ | `string` | null ได้ | ข้อเสนอหมดอายุ (48 ชม.) |   |
| `hire` | ใช่ | `TripHireDto` | null ได้ | การจ้างรถร่วมที่ใช้งานอยู่ (รอตอบ/รับแล้ว) — ราคาซื้อเห็นเมื่อมี `prices.buy:read` |   |
| `assignedAt` | ใช่ | `string` | null ได้ |   |   |
| `dispatchedAt` | ใช่ | `string` | null ได้ |   |   |
| `completedAt` | ใช่ | `string` | null ได้ |   |   |
| `cancelledAt` | ใช่ | `string` | null ได้ |   |   |
| `cancelReason` | ใช่ | `string` | null ได้ |   |   |
| `stops` | ใช่ | `array<TripStopDto>` |   |   |   |
| `deliveryOrders` | ใช่ | `array<TripDeliveryOrderDto>` |   |   |   |
| `rescheduledDeliveryOrders` | ใช่ | `array<TripRescheduledDoDto>` |   | DO ที่ส่งไม่สำเร็จในเที่ยวนี้แล้วนัดส่งใหม่ (ใบเดิม CANCELLED) — "ส่งไม่สำเร็จ · นัดส่งใหม่" · มีค่าเฉพาะ GET /trips/{id} (อื่น = []) |   |
| `weightKg` | ใช่ | `string` |   | น้ำหนักรวมของ DO ในเที่ยว (กก.) | `5400` |
| `route` | ใช่ | `TripRouteSummaryDto` |   | ระยะ/เวลารวมตามลำดับจุดปัจจุบัน (คำนวณใหม่ทุกครั้งที่จุดเปลี่ยน) |   |
| `warnings` | ใช่ | `array<TripWarningDto>` |   | ผลตรวจกฎตอนจัดล่าสุด |   |
| `ruleOverrides` | ใช่ | `array<TripRuleOverrideDto>` |   | ประวัติการยกเว้น/ยืนยันกฎของเที่ยว (เรียงตามเวลา) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |
| `startedAt` | ใช่ | `string (date-time)` |   | trip.started: เวลาเริ่มจริง (event หน้างานแรก) |   |

## wht_certificate.issued {#wht_certificate-issued}

ออกหนังสือรับรองการหักภาษี ณ ที่จ่ายแล้ว

> ยังไม่ส่ง — ชื่อและ schema จองไว้ (สมัครรับล่วงหน้าได้)

`data.object` = 
