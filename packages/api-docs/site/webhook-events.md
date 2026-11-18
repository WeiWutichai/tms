# Webhook events

รายการ event สาธารณะทั้งหมด (= `GET /v1/webhooks/event-types`) — envelope, header และวิธีตรวจลายเซ็นดูที่ [Webhook และการตรวจลายเซ็น](webhooks.md)

| event | สถานะ | data.object | เกิดเมื่อ |
|---|---|---|---|
| [`connector.health_changed`](#connector-health_changed) | ใช้งาน | `ConnectorDto` | สถานะการเชื่อมต่อระบบภายนอกเปลี่ยน |
| [`credit_note.finalized`](#credit_note-finalized) | ยังไม่ส่ง (จองชื่อไว้) |   | ออกเลขใบลดหนี้แล้ว |
| [`debit_note.finalized`](#debit_note-finalized) | ยังไม่ส่ง (จองชื่อไว้) |   | ออกเลขใบเพิ่มหนี้แล้ว |
| [`delivery_order.status_changed`](#delivery_order-status_changed) | ใช้งาน | `DeliveryOrderDto` | สถานะใบส่งของ (DO) เปลี่ยน |
| [`invoice.adjusted`](#invoice-adjusted) | ยังไม่ส่ง (จองชื่อไว้) |   | ปรับยอดใบแจ้งหนี้ด้วยใบลดหนี้/เพิ่มหนี้ |
| [`invoice.finalized`](#invoice-finalized) | ยังไม่ส่ง (จองชื่อไว้) |   | ออกเลขใบแจ้งหนี้/ใบกำกับภาษีแล้ว |
| [`invoice.paid`](#invoice-paid) | ยังไม่ส่ง (จองชื่อไว้) |   | ใบแจ้งหนี้ได้รับชำระครบ |
| [`invoice.voided`](#invoice-voided) | ยังไม่ส่ง (จองชื่อไว้) |   | ยกเลิกใบแจ้งหนี้ |
| [`job.completed`](#job-completed) | ใช้งาน | `JobDto` | งานเบื้องหลัง (นำเข้า/bulk/ส่งออก/รอบวางบิล) เสร็จ |
| [`order.cancelled`](#order-cancelled) | ใช้งาน | `OrderDto` | ยกเลิกใบสั่งงาน |
| [`order.created`](#order-created) | ใช้งาน | `OrderDto` | สร้างใบสั่งงานใหม่ (หน้าจอ, Open API, นำเข้าไฟล์) |
| [`order.held`](#order-held) | ใช้งาน | `OrderDto` | พักใบสั่งงาน (เช่น ข้อมูลไม่ครบ เกินวงเงิน) |
| [`order.released`](#order-released) | ใช้งาน | `OrderDto` | ปล่อยใบสั่งงานที่พักไว้ให้วางแผนต่อ |
| [`order.updated`](#order-updated) | ใช้งาน | `OrderDto` | แก้ไขข้อมูลใบสั่งงาน |
| [`payment.recorded`](#payment-recorded) | ยังไม่ส่ง (จองชื่อไว้) |   | บันทึกรับชำระเงิน |
| [`payment.reversed`](#payment-reversed) | ยังไม่ส่ง (จองชื่อไว้) |   | กลับรายการรับชำระเงิน |
| [`pod.captured`](#pod-captured) | ใช้งาน | `DeliveryOrderPodDto` | บันทึกหลักฐานการส่ง (POD) |
| [`receipt.issued`](#receipt-issued) | ยังไม่ส่ง (จองชื่อไว้) |   | ออกใบเสร็จรับเงินแล้ว |
| [`reconcile.mismatch_found`](#reconcile-mismatch_found) | ยังไม่ส่ง (จองชื่อไว้) |   | พบข้อมูลไม่ตรงกันจากการกระทบยอดกับระบบภายนอก |
| [`settlement.approved`](#settlement-approved) | ยังไม่ส่ง (จองชื่อไว้) |   | อนุมัติใบสรุปค่าขนส่งรถร่วม |
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

## invoice.adjusted {#invoice-adjusted}

ปรับยอดใบแจ้งหนี้ด้วยใบลดหนี้/เพิ่มหนี้

> ยังไม่ส่ง — ชื่อและ schema จองไว้ (สมัครรับล่วงหน้าได้)

`data.object` = 

## invoice.finalized {#invoice-finalized}

ออกเลขใบแจ้งหนี้/ใบกำกับภาษีแล้ว

> ยังไม่ส่ง — ชื่อและ schema จองไว้ (สมัครรับล่วงหน้าได้)

`data.object` = 

## invoice.paid {#invoice-paid}

ใบแจ้งหนี้ได้รับชำระครบ

> ยังไม่ส่ง — ชื่อและ schema จองไว้ (สมัครรับล่วงหน้าได้)

`data.object` = 

## invoice.voided {#invoice-voided}

ยกเลิกใบแจ้งหนี้

> ยังไม่ส่ง — ชื่อและ schema จองไว้ (สมัครรับล่วงหน้าได้)

`data.object` = 

## job.completed {#job-completed}

งานเบื้องหลัง (นำเข้า/bulk/ส่งออก/รอบวางบิล) เสร็จ

`data.object` = `JobDto`

## order.cancelled {#order-cancelled}

ยกเลิกใบสั่งงาน

`data.object` = `OrderDto`

## order.created {#order-created}

สร้างใบสั่งงานใหม่ (หน้าจอ, Open API, นำเข้าไฟล์)

`data.object` = `OrderDto`

## order.held {#order-held}

พักใบสั่งงาน (เช่น ข้อมูลไม่ครบ เกินวงเงิน)

`data.object` = `OrderDto`

## order.released {#order-released}

ปล่อยใบสั่งงานที่พักไว้ให้วางแผนต่อ

`data.object` = `OrderDto`

## order.updated {#order-updated}

แก้ไขข้อมูลใบสั่งงาน

`data.object` = `OrderDto`

## payment.recorded {#payment-recorded}

บันทึกรับชำระเงิน

> ยังไม่ส่ง — ชื่อและ schema จองไว้ (สมัครรับล่วงหน้าได้)

`data.object` = 

## payment.reversed {#payment-reversed}

กลับรายการรับชำระเงิน

> ยังไม่ส่ง — ชื่อและ schema จองไว้ (สมัครรับล่วงหน้าได้)

`data.object` = 

## pod.captured {#pod-captured}

บันทึกหลักฐานการส่ง (POD)

`data.object` = `DeliveryOrderPodDto`

## receipt.issued {#receipt-issued}

ออกใบเสร็จรับเงินแล้ว

> ยังไม่ส่ง — ชื่อและ schema จองไว้ (สมัครรับล่วงหน้าได้)

`data.object` = 

## reconcile.mismatch_found {#reconcile-mismatch_found}

พบข้อมูลไม่ตรงกันจากการกระทบยอดกับระบบภายนอก

> ยังไม่ส่ง — ชื่อและ schema จองไว้ (สมัครรับล่วงหน้าได้)

`data.object` = 

## settlement.approved {#settlement-approved}

อนุมัติใบสรุปค่าขนส่งรถร่วม

> ยังไม่ส่ง — ชื่อและ schema จองไว้ (สมัครรับล่วงหน้าได้)

`data.object` = 

## settlement.paid {#settlement-paid}

จ่ายเงินตามใบสรุปค่าขนส่งรถร่วมแล้ว

> ยังไม่ส่ง — ชื่อและ schema จองไว้ (สมัครรับล่วงหน้าได้)

`data.object` = 

## stop.arrived {#stop-arrived}

รถถึงจุดรับ/ส่ง

`data.object` = `TripStopDto`

## stop.completed {#stop-completed}

ปิดงานที่จุดรับ/ส่งสำเร็จ

`data.object` = `TripStopDto`

## stop.departed {#stop-departed}

รถออกจากจุดรับ/ส่ง

`data.object` = `TripStopDto`

## stop.failed {#stop-failed}

งานที่จุดรับ/ส่งไม่สำเร็จ (มีเหตุผล)

`data.object` = `TripStopDto`

## trip.assigned {#trip-assigned}

จัดรถ/คนขับ หรือรถร่วมให้เที่ยววิ่ง

`data.object` = `TripDto`

## trip.cancelled {#trip-cancelled}

ยกเลิกเที่ยววิ่ง

`data.object` = `TripDto`

## trip.completed {#trip-completed}

เที่ยววิ่งจบครบทุกจุด

`data.object` = `TripDto`

## trip.dispatched {#trip-dispatched}

ปล่อยเที่ยววิ่งให้คนขับ

`data.object` = `TripDto`

## trip.started {#trip-started}

คนขับเริ่มเที่ยววิ่ง

`data.object` = `TripDto`

## wht_certificate.issued {#wht_certificate-issued}

ออกหนังสือรับรองการหักภาษี ณ ที่จ่ายแล้ว

> ยังไม่ส่ง — ชื่อและ schema จองไว้ (สมัครรับล่วงหน้าได้)

`data.object` = 
