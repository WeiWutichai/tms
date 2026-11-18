# รหัส error

ทุก error เป็น `application/problem+json` (RFC 9457) — `type` = `https://docs.tms.example/problems/<code>` ชี้มาที่หัวข้อในหน้านี้ · ตัดสินใจจาก `code` เท่านั้น ดู [แนวทางการใช้ API](conventions.md#รูปแบบ-error-rfc-9457)

| code | HTTP | ความหมาย |
|---|---|---|
| [`bad_request`](#bad_request) | 400 | คำขอไม่ถูกต้อง |
| [`unauthorized`](#unauthorized) | 401 | ต้องเข้าสู่ระบบ |
| [`edit_lock_user_required`](#edit_lock_user_required) | 403 | การล็อกเพื่อแก้ไขใช้ได้เฉพาะผู้ใช้ในระบบ |
| [`permission_denied`](#permission_denied) | 403 | ไม่มีสิทธิ์ทำรายการนี้ |
| [`not_found`](#not_found) | 404 | ไม่พบข้อมูล |
| [`alias_conflict`](#alias_conflict) | 409 | รหัสหรือชื่อลูกค้าตามต้นทางนี้เคยจับคู่กับลูกค้ารายอื่นไว้แล้ว — ยืนยันการย้ายพร้อมเหตุผล |
| [`assignment_blocked`](#assignment_blocked) | 409 | รถหรือคนขับติดกฎห้ามจ่ายงาน — แก้เอกสารให้ครบ หรือให้ผู้จัดการยกเว้นพร้อมเหตุผล |
| [`assignment_warnings`](#assignment_warnings) | 409 | เที่ยวนี้มีคำเตือนที่ยังไม่ได้ยืนยัน — ยืนยันพร้อมเหตุผลก่อน |
| [`carrier_change_not_allowed`](#carrier_change_not_allowed) | 409 | เปลี่ยนผู้รับเหมาได้เฉพาะเที่ยวที่รอรถร่วมตอบ หรือรถร่วมรับงานแล้วแต่ยังไม่ปล่อยรถ |
| [`carrier_change_requires_cancel`](#carrier_change_requires_cancel) | 409 | เปลี่ยนรถร่วมหรือสลับรถร่วม/รถบริษัทไม่ได้ — ยกเลิกการจ้างเดิมก่อน |
| [`concurrent_update`](#concurrent_update) | 409 | มีการแก้ไขข้อมูลเดียวกันพร้อมกัน กรุณาลองใหม่อีกครั้ง |
| [`conflict`](#conflict) | 409 | ข้อมูลขัดแย้งกับที่มีอยู่ |
| [`delivery_order_on_trip`](#delivery_order_on_trip) | 409 | ใบส่งของนี้อยู่ในเที่ยวรถแล้ว — ถอดออกจากเที่ยวก่อน |
| [`duplicate`](#duplicate) | 409 | ข้อมูลซ้ำกับที่มีอยู่ |
| [`external_id_conflict`](#external_id_conflict) | 409 | เลขอ้างอิงต้นทางนี้ถูกใช้กับใบสั่งขนส่งจากช่องทางอื่นแล้ว |
| [`idempotency_in_progress`](#idempotency_in_progress) | 409 | คำขอเดียวกันกำลังประมวลผลอยู่ |
| [`invalid_state_transition`](#invalid_state_transition) | 409 | ทำรายการนี้ไม่ได้ในสถานะปัจจุบัน |
| [`offer_closed`](#offer_closed) | 409 | ข้อเสนองานนี้ปิดแล้ว (ตอบไปแล้วหรือถูกยกเลิก) |
| [`offer_not_timed_out`](#offer_not_timed_out) | 409 | รถร่วมรายนี้ยังอยู่ในเวลาตอบรับ — ส่งรายถัดไปได้เมื่อครบเวลา |
| [`offer_required`](#offer_required) | 409 | รถคันนี้เป็นรถร่วม — ต้องเสนองานให้รถร่วมก่อน แล้วจึงบันทึกการรับงาน |
| [`order_lock_released`](#order_lock_released) | 409 | การแก้ไขของคุณถูกปลดล็อกโดยผู้อื่นแล้ว — โหลดใหม่ก่อนแก้ต่อ |
| [`order_locked_by_user`](#order_locked_by_user) | 409 | ใบสั่งขนส่งนี้กำลังถูกแก้ไขโดยผู้ใช้อื่น |
| [`order_locked_for_update`](#order_locked_for_update) | 409 | แก้ข้อมูลนี้ของใบสั่งขนส่งไม่ได้ในสถานะปัจจุบัน |
| [`order_not_ready_for_delivery`](#order_not_ready_for_delivery) | 409 | ยังสร้างใบส่งของจากใบสั่งขนส่งนี้ไม่ได้ (ร่าง ยกเลิก วางแผนแล้ว หรือยังจับคู่ลูกค้า/สถานที่ไม่ครบ) |
| [`order_on_trip`](#order_on_trip) | 409 | ใบสั่งขนส่งนี้มีใบส่งของอยู่ในเที่ยวรถ — ถอดออกจากเที่ยวก่อน |
| [`pod_not_allowed`](#pod_not_allowed) | 409 | บันทึกหลักฐานส่งของใบส่งของนี้ไม่ได้ในสถานะปัจจุบัน |
| [`source_change_not_pending`](#source_change_not_pending) | 409 | การเปลี่ยนแปลงจากต้นทางชุดนี้ถูกตัดสินไปแล้ว หรือมีชุดใหม่มาแทน — โหลดใหม่ |
| [`stop_event_already_resolved`](#stop_event_already_resolved) | 409 | เหตุการณ์นี้ถูกตัดสินไปแล้ว |
| [`stop_event_duplicate`](#stop_event_duplicate) | 409 | clientEventId นี้ถูกใช้กับ event อื่นแล้ว |
| [`stop_event_not_flagged`](#stop_event_not_flagged) | 409 | เหตุการณ์นี้ไม่มีข้อขัดแย้งให้ตัดสิน |
| [`trip_empty`](#trip_empty) | 409 | เที่ยวนี้ยังไม่มีใบส่งของ |
| [`trip_has_loaded_orders`](#trip_has_loaded_orders) | 409 | ยกเลิกเที่ยวไม่ได้ — มีใบส่งของที่รับของขึ้นรถหรือส่งแล้ว (ปิดเที่ยวบางส่วนแล้วเปิดเที่ยวใหม่แทน) |
| [`trip_not_in_progress`](#trip_not_in_progress) | 409 | บันทึกสถานะหน้างานได้เฉพาะเที่ยวที่ปล่อยรถแล้วและยังไม่จบ |
| [`trip_stops_open`](#trip_stops_open) | 409 | ยังมีจุดแวะที่ยังไม่จบ — ปิดเที่ยวได้เมื่อทุกจุดส่งสำเร็จ/ไม่สำเร็จ/ข้าม |
| [`precondition_failed`](#precondition_failed) | 412 | ข้อมูลถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดใหม่ |
| [`payload_too_large`](#payload_too_large) | 413 | ไฟล์หรือข้อมูลมีขนาดใหญ่เกินกำหนด |
| [`idempotency_mismatch`](#idempotency_mismatch) | 422 | Idempotency-Key นี้เคยใช้กับข้อมูลอื่น |
| [`pod_incomplete`](#pod_incomplete) | 422 | หลักฐานการส่ง (POD) ยังไม่ครบตามที่ลูกค้ากำหนด |
| [`stop_order_invalid`](#stop_order_invalid) | 422 | ลำดับจุดไม่ถูกต้อง — จุดส่งของใบส่งของต้องอยู่หลังจุดรับของใบเดียวกัน |
| [`validation_failed`](#validation_failed) | 422 | ข้อมูลไม่ถูกต้อง |

## bad_request {#bad_request}

HTTP `400` · คำขอไม่ถูกต้อง

พบใน: [`POST /v1/orders:bulk`](ref-orders.md#post-orders-bulk), [`POST /v1/orders`](ref-orders.md#post-orders), [`PUT /v1/orders/external/{externalId}`](ref-orders.md#put-orders-external-externalId), [`PATCH /v1/orders/external/{externalId}`](ref-orders.md#patch-orders-external-externalId), [`PATCH /v1/orders/{id}`](ref-orders.md#patch-orders-id), [`POST /v1/orders/{id}/cancel`](ref-orders.md#post-orders-id-cancel), [`POST /v1/orders/{id}/source-changes/{changeId}/accept`](ref-orders.md#post-orders-id-source-changes-changeId-accept), [`POST /v1/orders/{id}/source-changes/{changeId}/reject`](ref-orders.md#post-orders-id-source-changes-changeId-reject), [`POST /v1/orders/{id}/stops/{sequence}/map-site`](ref-orders.md#post-orders-id-stops-sequence-map-site), [`POST /v1/orders/{id}/manual-price`](ref-orders.md#post-orders-id-manual-price), [`POST /v1/orders/{id}/resolve-source-error`](ref-orders.md#post-orders-id-resolve-source-error), [`POST /v1/orders/{id}/map-customer`](ref-orders.md#post-orders-id-map-customer)

## unauthorized {#unauthorized}

HTTP `401` · ต้องเข้าสู่ระบบ

พบใน: [`POST /v1/exports`](ref-exports.md#post-exports), [`GET /v1/exports/{id}`](ref-exports.md#get-exports-id), [`GET /v1/companies`](ref-companies.md#get-companies), [`GET /v1/companies/{id}`](ref-companies.md#get-companies-id), [`GET /v1/branches`](ref-branches.md#get-branches), [`GET /v1/branches/{id}`](ref-branches.md#get-branches-id), [`GET /v1/document-sequences`](ref-document-sequences.md#get-document-sequences), [`GET /v1/document-sequences/{id}`](ref-document-sequences.md#get-document-sequences-id), [`GET /v1/audit-logs`](ref-audit.md#get-audit-logs), [`POST /v1/documents`](ref-documents.md#post-documents), [`GET /v1/documents/{id}`](ref-documents.md#get-documents-id), [`GET /v1/settings`](ref-settings.md#get-settings) และอีก 286 endpoint

## edit_lock_user_required {#edit_lock_user_required}

HTTP `403` · การล็อกเพื่อแก้ไขใช้ได้เฉพาะผู้ใช้ในระบบ

พบใน: [`POST /v1/orders/{id}/lock`](ref-orders.md#post-orders-id-lock)

## permission_denied {#permission_denied}

HTTP `403` · ไม่มีสิทธิ์ทำรายการนี้

พบใน: [`POST /v1/exports`](ref-exports.md#post-exports), [`GET /v1/exports/{id}`](ref-exports.md#get-exports-id), [`GET /v1/companies`](ref-companies.md#get-companies), [`GET /v1/companies/{id}`](ref-companies.md#get-companies-id), [`GET /v1/branches`](ref-branches.md#get-branches), [`GET /v1/branches/{id}`](ref-branches.md#get-branches-id), [`GET /v1/document-sequences`](ref-document-sequences.md#get-document-sequences), [`GET /v1/document-sequences/{id}`](ref-document-sequences.md#get-document-sequences-id), [`GET /v1/audit-logs`](ref-audit.md#get-audit-logs), [`POST /v1/documents`](ref-documents.md#post-documents), [`GET /v1/documents/{id}`](ref-documents.md#get-documents-id), [`GET /v1/settings`](ref-settings.md#get-settings) และอีก 286 endpoint

## not_found {#not_found}

HTTP `404` · ไม่พบข้อมูล

พบใน: [`GET /v1/exports/{id}`](ref-exports.md#get-exports-id), [`GET /v1/companies/{id}`](ref-companies.md#get-companies-id), [`GET /v1/branches/{id}`](ref-branches.md#get-branches-id), [`GET /v1/document-sequences/{id}`](ref-document-sequences.md#get-document-sequences-id), [`GET /v1/documents/{id}`](ref-documents.md#get-documents-id), [`GET /v1/documents/{id}/content`](ref-documents.md#get-documents-id-content), [`PUT /v1/documents/{id}/content`](ref-documents.md#put-documents-id-content), [`GET /v1/jobs/{id}`](ref-jobs.md#get-jobs-id), [`PATCH /v1/customers/external/{externalId}`](ref-customers.md#patch-customers-external-externalId), [`GET /v1/customers/{id}`](ref-customers.md#get-customers-id), [`PATCH /v1/customers/{id}`](ref-customers.md#patch-customers-id), [`GET /v1/customers/{id}/history`](ref-customers.md#get-customers-id-history) และอีก 176 endpoint

## alias_conflict {#alias_conflict}

HTTP `409` · รหัสหรือชื่อลูกค้าตามต้นทางนี้เคยจับคู่กับลูกค้ารายอื่นไว้แล้ว — ยืนยันการย้ายพร้อมเหตุผล

พบใน: [`POST /v1/orders/{id}/map-customer`](ref-orders.md#post-orders-id-map-customer)

## assignment_blocked {#assignment_blocked}

HTTP `409` · รถหรือคนขับติดกฎห้ามจ่ายงาน — แก้เอกสารให้ครบ หรือให้ผู้จัดการยกเว้นพร้อมเหตุผล

พบใน: [`POST /v1/trips`](ref-trips.md#post-trips), [`POST /v1/trips/{id}/schedule`](ref-trips.md#post-trips-id-schedule), [`POST /v1/trips/{id}/assign`](ref-trips.md#post-trips-id-assign), [`POST /v1/trips/{id}/dispatch`](ref-trips.md#post-trips-id-dispatch), [`POST /v1/trips/{id}/confirm-rules`](ref-trips.md#post-trips-id-confirm-rules)

## assignment_warnings {#assignment_warnings}

HTTP `409` · เที่ยวนี้มีคำเตือนที่ยังไม่ได้ยืนยัน — ยืนยันพร้อมเหตุผลก่อน

พบใน: [`POST /v1/trips/{id}/assign`](ref-trips.md#post-trips-id-assign), [`POST /v1/trips/{id}/dispatch`](ref-trips.md#post-trips-id-dispatch)

## carrier_change_not_allowed {#carrier_change_not_allowed}

HTTP `409` · เปลี่ยนผู้รับเหมาได้เฉพาะเที่ยวที่รอรถร่วมตอบ หรือรถร่วมรับงานแล้วแต่ยังไม่ปล่อยรถ

พบใน: [`POST /v1/trips/{id}/offer`](ref-trips.md#post-trips-id-offer)

## carrier_change_requires_cancel {#carrier_change_requires_cancel}

HTTP `409` · เปลี่ยนรถร่วมหรือสลับรถร่วม/รถบริษัทไม่ได้ — ยกเลิกการจ้างเดิมก่อน

พบใน: [`POST /v1/trips/{id}/assign`](ref-trips.md#post-trips-id-assign)

## concurrent_update {#concurrent_update}

HTTP `409` · มีการแก้ไขข้อมูลเดียวกันพร้อมกัน กรุณาลองใหม่อีกครั้ง

พบใน: [`POST /v1/orders/{id}/lock`](ref-orders.md#post-orders-id-lock), [`PUT /v1/delivery-orders/{id}/pod`](ref-delivery-orders.md#put-delivery-orders-id-pod), [`POST /v1/trips`](ref-trips.md#post-trips), [`POST /v1/trips/{id}/schedule`](ref-trips.md#post-trips-id-schedule), [`POST /v1/trips/{id}/attach`](ref-trips.md#post-trips-id-attach), [`POST /v1/trips/{id}/detach`](ref-trips.md#post-trips-id-detach), [`POST /v1/trips/{id}/reorder-stops`](ref-trips.md#post-trips-id-reorder-stops), [`POST /v1/trips/{id}/assign`](ref-trips.md#post-trips-id-assign), [`POST /v1/trips/{id}/offer`](ref-trips.md#post-trips-id-offer), [`POST /v1/trips/{id}/dispatch`](ref-trips.md#post-trips-id-dispatch), [`POST /v1/trips/{id}/confirm-rules`](ref-trips.md#post-trips-id-confirm-rules), [`POST /v1/trips/{id}/complete`](ref-trips.md#post-trips-id-complete) และอีก 16 endpoint

## conflict {#conflict}

HTTP `409` · ข้อมูลขัดแย้งกับที่มีอยู่

พบใน: [`PUT /v1/customers/external/{externalId}`](ref-customers.md#put-customers-external-externalId), [`PATCH /v1/customers/external/{externalId}`](ref-customers.md#patch-customers-external-externalId), [`PUT /v1/customer-sites/external/{externalId}`](ref-customer-sites.md#put-customer-sites-external-externalId), [`PATCH /v1/customer-sites/external/{externalId}`](ref-customer-sites.md#patch-customer-sites-external-externalId), [`PUT /v1/routes/external/{externalId}`](ref-routes.md#put-routes-external-externalId), [`PATCH /v1/routes/external/{externalId}`](ref-routes.md#patch-routes-external-externalId), [`PUT /v1/products/external/{externalId}`](ref-products.md#put-products-external-externalId), [`PATCH /v1/products/external/{externalId}`](ref-products.md#patch-products-external-externalId), [`PUT /v1/vehicle-types/external/{externalId}`](ref-vehicle-types.md#put-vehicle-types-external-externalId), [`PATCH /v1/vehicle-types/external/{externalId}`](ref-vehicle-types.md#patch-vehicle-types-external-externalId), [`PUT /v1/service-items/external/{externalId}`](ref-service-items.md#put-service-items-external-externalId), [`PATCH /v1/service-items/external/{externalId}`](ref-service-items.md#patch-service-items-external-externalId) และอีก 12 endpoint

## delivery_order_on_trip {#delivery_order_on_trip}

HTTP `409` · ใบส่งของนี้อยู่ในเที่ยวรถแล้ว — ถอดออกจากเที่ยวก่อน

พบใน: [`POST /v1/trips`](ref-trips.md#post-trips), [`POST /v1/trips/{id}/attach`](ref-trips.md#post-trips-id-attach)

## duplicate {#duplicate}

HTTP `409` · ข้อมูลซ้ำกับที่มีอยู่

พบใน: [`POST /v1/documents`](ref-documents.md#post-documents), [`PUT /v1/customers/external/{externalId}`](ref-customers.md#put-customers-external-externalId), [`PATCH /v1/customers/external/{externalId}`](ref-customers.md#patch-customers-external-externalId), [`PUT /v1/customer-sites/external/{externalId}`](ref-customer-sites.md#put-customer-sites-external-externalId), [`PATCH /v1/customer-sites/external/{externalId}`](ref-customer-sites.md#patch-customer-sites-external-externalId), [`PUT /v1/routes/external/{externalId}`](ref-routes.md#put-routes-external-externalId), [`PATCH /v1/routes/external/{externalId}`](ref-routes.md#patch-routes-external-externalId), [`PUT /v1/products/external/{externalId}`](ref-products.md#put-products-external-externalId), [`PATCH /v1/products/external/{externalId}`](ref-products.md#patch-products-external-externalId), [`PUT /v1/vehicle-types/external/{externalId}`](ref-vehicle-types.md#put-vehicle-types-external-externalId), [`PATCH /v1/vehicle-types/external/{externalId}`](ref-vehicle-types.md#patch-vehicle-types-external-externalId), [`PUT /v1/service-items/external/{externalId}`](ref-service-items.md#put-service-items-external-externalId) และอีก 11 endpoint

## external_id_conflict {#external_id_conflict}

HTTP `409` · เลขอ้างอิงต้นทางนี้ถูกใช้กับใบสั่งขนส่งจากช่องทางอื่นแล้ว

พบใน: [`POST /v1/orders`](ref-orders.md#post-orders), [`PUT /v1/orders/external/{externalId}`](ref-orders.md#put-orders-external-externalId), [`PATCH /v1/orders/external/{externalId}`](ref-orders.md#patch-orders-external-externalId)

## idempotency_in_progress {#idempotency_in_progress}

HTTP `409` · คำขอเดียวกันกำลังประมวลผลอยู่

พบใน: [`POST /v1/orders:bulk`](ref-orders.md#post-orders-bulk), [`POST /v1/orders`](ref-orders.md#post-orders), [`POST /v1/trips`](ref-trips.md#post-trips), [`POST /v1/trips/{id}/schedule`](ref-trips.md#post-trips-id-schedule), [`POST /v1/trips/{id}/attach`](ref-trips.md#post-trips-id-attach), [`POST /v1/trips/{id}/detach`](ref-trips.md#post-trips-id-detach), [`POST /v1/trips/{id}/reorder-stops`](ref-trips.md#post-trips-id-reorder-stops), [`POST /v1/trips/{id}/assign`](ref-trips.md#post-trips-id-assign), [`POST /v1/trips/{id}/offer`](ref-trips.md#post-trips-id-offer), [`POST /v1/trips/{id}/dispatch`](ref-trips.md#post-trips-id-dispatch), [`POST /v1/trips/{id}/confirm-rules`](ref-trips.md#post-trips-id-confirm-rules), [`POST /v1/trips/{id}/complete`](ref-trips.md#post-trips-id-complete) และอีก 16 endpoint

## invalid_state_transition {#invalid_state_transition}

HTTP `409` · ทำรายการนี้ไม่ได้ในสถานะปัจจุบัน

พบใน: [`PUT /v1/documents/{id}/content`](ref-documents.md#put-documents-id-content), [`POST /v1/orders`](ref-orders.md#post-orders), [`PUT /v1/orders/external/{externalId}`](ref-orders.md#put-orders-external-externalId), [`PATCH /v1/orders/external/{externalId}`](ref-orders.md#patch-orders-external-externalId), [`PATCH /v1/orders/{id}`](ref-orders.md#patch-orders-id), [`POST /v1/orders/{id}/cancel`](ref-orders.md#post-orders-id-cancel), [`POST /v1/orders/{id}/stops/{sequence}/map-site`](ref-orders.md#post-orders-id-stops-sequence-map-site), [`POST /v1/orders/{id}/reevaluate`](ref-orders.md#post-orders-id-reevaluate), [`POST /v1/orders/{id}/manual-price`](ref-orders.md#post-orders-id-manual-price), [`POST /v1/orders/{id}/resolve-source-error`](ref-orders.md#post-orders-id-resolve-source-error), [`POST /v1/orders/{id}/map-customer`](ref-orders.md#post-orders-id-map-customer), [`POST /v1/trips`](ref-trips.md#post-trips) และอีก 23 endpoint

## offer_closed {#offer_closed}

HTTP `409` · ข้อเสนองานนี้ปิดแล้ว (ตอบไปแล้วหรือถูกยกเลิก)

พบใน: [`POST /v1/trips/{id}/offer`](ref-trips.md#post-trips-id-offer), [`POST /v1/trips/{id}/offer-link`](ref-trips.md#post-trips-id-offer-link)

## offer_not_timed_out {#offer_not_timed_out}

HTTP `409` · รถร่วมรายนี้ยังอยู่ในเวลาตอบรับ — ส่งรายถัดไปได้เมื่อครบเวลา

พบใน: [`POST /v1/trips/{id}/offer`](ref-trips.md#post-trips-id-offer)

## offer_required {#offer_required}

HTTP `409` · รถคันนี้เป็นรถร่วม — ต้องเสนองานให้รถร่วมก่อน แล้วจึงบันทึกการรับงาน

พบใน: [`POST /v1/trips/{id}/assign`](ref-trips.md#post-trips-id-assign)

## order_lock_released {#order_lock_released}

HTTP `409` · การแก้ไขของคุณถูกปลดล็อกโดยผู้อื่นแล้ว — โหลดใหม่ก่อนแก้ต่อ

พบใน: [`PATCH /v1/orders/external/{externalId}`](ref-orders.md#patch-orders-external-externalId), [`PATCH /v1/orders/{id}`](ref-orders.md#patch-orders-id), [`POST /v1/orders/{id}/cancel`](ref-orders.md#post-orders-id-cancel), [`POST /v1/orders/{id}/source-changes/{changeId}/accept`](ref-orders.md#post-orders-id-source-changes-changeId-accept), [`POST /v1/orders/{id}/source-changes/{changeId}/reject`](ref-orders.md#post-orders-id-source-changes-changeId-reject), [`POST /v1/orders/{id}/lock`](ref-orders.md#post-orders-id-lock), [`POST /v1/orders/{id}/reevaluate`](ref-orders.md#post-orders-id-reevaluate), [`POST /v1/orders/{id}/manual-price`](ref-orders.md#post-orders-id-manual-price), [`POST /v1/orders/{id}/resolve-source-error`](ref-orders.md#post-orders-id-resolve-source-error)

## order_locked_by_user {#order_locked_by_user}

HTTP `409` · ใบสั่งขนส่งนี้กำลังถูกแก้ไขโดยผู้ใช้อื่น

พบใน: [`PATCH /v1/orders/external/{externalId}`](ref-orders.md#patch-orders-external-externalId), [`PATCH /v1/orders/{id}`](ref-orders.md#patch-orders-id), [`POST /v1/orders/{id}/cancel`](ref-orders.md#post-orders-id-cancel), [`POST /v1/orders/{id}/source-changes/{changeId}/accept`](ref-orders.md#post-orders-id-source-changes-changeId-accept), [`POST /v1/orders/{id}/source-changes/{changeId}/reject`](ref-orders.md#post-orders-id-source-changes-changeId-reject), [`POST /v1/orders/{id}/lock`](ref-orders.md#post-orders-id-lock), [`POST /v1/orders/{id}/reevaluate`](ref-orders.md#post-orders-id-reevaluate), [`POST /v1/orders/{id}/manual-price`](ref-orders.md#post-orders-id-manual-price), [`POST /v1/orders/{id}/resolve-source-error`](ref-orders.md#post-orders-id-resolve-source-error)

## order_locked_for_update {#order_locked_for_update}

HTTP `409` · แก้ข้อมูลนี้ของใบสั่งขนส่งไม่ได้ในสถานะปัจจุบัน

พบใน: [`POST /v1/orders`](ref-orders.md#post-orders), [`PUT /v1/orders/external/{externalId}`](ref-orders.md#put-orders-external-externalId), [`PATCH /v1/orders/external/{externalId}`](ref-orders.md#patch-orders-external-externalId), [`PATCH /v1/orders/{id}`](ref-orders.md#patch-orders-id), [`POST /v1/orders/{id}/stops/{sequence}/map-site`](ref-orders.md#post-orders-id-stops-sequence-map-site), [`POST /v1/orders/{id}/reevaluate`](ref-orders.md#post-orders-id-reevaluate), [`POST /v1/orders/{id}/manual-price`](ref-orders.md#post-orders-id-manual-price), [`POST /v1/orders/{id}/resolve-source-error`](ref-orders.md#post-orders-id-resolve-source-error), [`POST /v1/orders/{id}/map-customer`](ref-orders.md#post-orders-id-map-customer)

## order_not_ready_for_delivery {#order_not_ready_for_delivery}

HTTP `409` · ยังสร้างใบส่งของจากใบสั่งขนส่งนี้ไม่ได้ (ร่าง ยกเลิก วางแผนแล้ว หรือยังจับคู่ลูกค้า/สถานที่ไม่ครบ)

พบใน: [`POST /v1/trips`](ref-trips.md#post-trips), [`POST /v1/trips/{id}/attach`](ref-trips.md#post-trips-id-attach)

## order_on_trip {#order_on_trip}

HTTP `409` · ใบสั่งขนส่งนี้มีใบส่งของอยู่ในเที่ยวรถ — ถอดออกจากเที่ยวก่อน

พบใน: [`POST /v1/orders/{id}/cancel`](ref-orders.md#post-orders-id-cancel), [`POST /v1/orders/{id}/source-changes/{changeId}/accept`](ref-orders.md#post-orders-id-source-changes-changeId-accept), [`POST /v1/orders/{id}/source-changes/{changeId}/reject`](ref-orders.md#post-orders-id-source-changes-changeId-reject)

## pod_not_allowed {#pod_not_allowed}

HTTP `409` · บันทึกหลักฐานส่งของใบส่งของนี้ไม่ได้ในสถานะปัจจุบัน

พบใน: [`PUT /v1/delivery-orders/{id}/pod`](ref-delivery-orders.md#put-delivery-orders-id-pod)

## source_change_not_pending {#source_change_not_pending}

HTTP `409` · การเปลี่ยนแปลงจากต้นทางชุดนี้ถูกตัดสินไปแล้ว หรือมีชุดใหม่มาแทน — โหลดใหม่

พบใน: [`POST /v1/orders/{id}/source-changes/{changeId}/accept`](ref-orders.md#post-orders-id-source-changes-changeId-accept), [`POST /v1/orders/{id}/source-changes/{changeId}/reject`](ref-orders.md#post-orders-id-source-changes-changeId-reject)

## stop_event_already_resolved {#stop_event_already_resolved}

HTTP `409` · เหตุการณ์นี้ถูกตัดสินไปแล้ว

พบใน: [`POST /v1/stop-event-flags/{id}/resolve`](ref-stops.md#post-stop-event-flags-id-resolve)

## stop_event_duplicate {#stop_event_duplicate}

HTTP `409` · clientEventId นี้ถูกใช้กับ event อื่นแล้ว

พบใน: [`POST /v1/stops/{id}/arrive`](ref-stops.md#post-stops-id-arrive), [`POST /v1/stops/{id}/depart`](ref-stops.md#post-stops-id-depart), [`POST /v1/stops/{id}/complete`](ref-stops.md#post-stops-id-complete), [`POST /v1/stops/{id}/fail`](ref-stops.md#post-stops-id-fail)

## stop_event_not_flagged {#stop_event_not_flagged}

HTTP `409` · เหตุการณ์นี้ไม่มีข้อขัดแย้งให้ตัดสิน

พบใน: [`POST /v1/stop-event-flags/{id}/resolve`](ref-stops.md#post-stop-event-flags-id-resolve)

## trip_empty {#trip_empty}

HTTP `409` · เที่ยวนี้ยังไม่มีใบส่งของ

พบใน: [`POST /v1/trips/{id}/assign`](ref-trips.md#post-trips-id-assign), [`POST /v1/trips/{id}/offer`](ref-trips.md#post-trips-id-offer), [`POST /v1/trips/{id}/dispatch`](ref-trips.md#post-trips-id-dispatch), [`POST /v1/trips/{id}/sheet`](ref-trips.md#post-trips-id-sheet), [`POST /v1/trips/{id}/sheet/driver-link`](ref-trips.md#post-trips-id-sheet-driver-link)

## trip_has_loaded_orders {#trip_has_loaded_orders}

HTTP `409` · ยกเลิกเที่ยวไม่ได้ — มีใบส่งของที่รับของขึ้นรถหรือส่งแล้ว (ปิดเที่ยวบางส่วนแล้วเปิดเที่ยวใหม่แทน)

พบใน: [`POST /v1/trips/{id}/detach`](ref-trips.md#post-trips-id-detach), [`POST /v1/trips/{id}/cancel`](ref-trips.md#post-trips-id-cancel)

## trip_not_in_progress {#trip_not_in_progress}

HTTP `409` · บันทึกสถานะหน้างานได้เฉพาะเที่ยวที่ปล่อยรถแล้วและยังไม่จบ

พบใน: [`POST /v1/stops/{id}/arrive`](ref-stops.md#post-stops-id-arrive), [`POST /v1/stops/{id}/depart`](ref-stops.md#post-stops-id-depart), [`POST /v1/stops/{id}/complete`](ref-stops.md#post-stops-id-complete), [`POST /v1/stops/{id}/fail`](ref-stops.md#post-stops-id-fail)

## trip_stops_open {#trip_stops_open}

HTTP `409` · ยังมีจุดแวะที่ยังไม่จบ — ปิดเที่ยวได้เมื่อทุกจุดส่งสำเร็จ/ไม่สำเร็จ/ข้าม

พบใน: [`POST /v1/trips/{id}/complete`](ref-trips.md#post-trips-id-complete)

## precondition_failed {#precondition_failed}

HTTP `412` · ข้อมูลถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดใหม่

พบใน: [`PUT /v1/customers/external/{externalId}`](ref-customers.md#put-customers-external-externalId), [`PATCH /v1/customers/external/{externalId}`](ref-customers.md#patch-customers-external-externalId), [`PATCH /v1/customers/{id}`](ref-customers.md#patch-customers-id), [`POST /v1/customers/{id}/deactivate`](ref-customers.md#post-customers-id-deactivate), [`POST /v1/customers/{id}/activate`](ref-customers.md#post-customers-id-activate), [`POST /v1/customers/{id}/delete`](ref-customers.md#post-customers-id-delete), [`PUT /v1/orders/external/{externalId}`](ref-orders.md#put-orders-external-externalId), [`PATCH /v1/orders/external/{externalId}`](ref-orders.md#patch-orders-external-externalId), [`PATCH /v1/orders/{id}`](ref-orders.md#patch-orders-id), [`POST /v1/orders/{id}/cancel`](ref-orders.md#post-orders-id-cancel), [`POST /v1/orders/{id}/source-changes/{changeId}/accept`](ref-orders.md#post-orders-id-source-changes-changeId-accept), [`POST /v1/orders/{id}/source-changes/{changeId}/reject`](ref-orders.md#post-orders-id-source-changes-changeId-reject) และอีก 99 endpoint

## payload_too_large {#payload_too_large}

HTTP `413` · ไฟล์หรือข้อมูลมีขนาดใหญ่เกินกำหนด

พบใน: [`POST /v1/orders:bulk`](ref-orders.md#post-orders-bulk), [`POST /v1/orders`](ref-orders.md#post-orders), [`PUT /v1/orders/external/{externalId}`](ref-orders.md#put-orders-external-externalId), [`PATCH /v1/orders/external/{externalId}`](ref-orders.md#patch-orders-external-externalId), [`PATCH /v1/orders/{id}`](ref-orders.md#patch-orders-id)

## idempotency_mismatch {#idempotency_mismatch}

HTTP `422` · Idempotency-Key นี้เคยใช้กับข้อมูลอื่น

พบใน: [`POST /v1/orders:bulk`](ref-orders.md#post-orders-bulk), [`GET /v1/orders`](ref-orders.md#get-orders), [`POST /v1/orders`](ref-orders.md#post-orders), [`PUT /v1/orders/external/{externalId}`](ref-orders.md#put-orders-external-externalId), [`PATCH /v1/orders/external/{externalId}`](ref-orders.md#patch-orders-external-externalId), [`PATCH /v1/orders/{id}`](ref-orders.md#patch-orders-id), [`POST /v1/orders/{id}/stops/{sequence}/map-site`](ref-orders.md#post-orders-id-stops-sequence-map-site), [`POST /v1/orders/{id}/manual-price`](ref-orders.md#post-orders-id-manual-price), [`POST /v1/orders/{id}/resolve-source-error`](ref-orders.md#post-orders-id-resolve-source-error), [`POST /v1/orders/{id}/map-customer`](ref-orders.md#post-orders-id-map-customer), [`GET /v1/trips`](ref-trips.md#get-trips), [`POST /v1/trips`](ref-trips.md#post-trips) และอีก 33 endpoint

## pod_incomplete {#pod_incomplete}

HTTP `422` · หลักฐานการส่ง (POD) ยังไม่ครบตามที่ลูกค้ากำหนด

พบใน: [`PUT /v1/delivery-orders/{id}/pod`](ref-delivery-orders.md#put-delivery-orders-id-pod)

## stop_order_invalid {#stop_order_invalid}

HTTP `422` · ลำดับจุดไม่ถูกต้อง — จุดส่งของใบส่งของต้องอยู่หลังจุดรับของใบเดียวกัน

พบใน: [`POST /v1/trips/{id}/reorder-stops`](ref-trips.md#post-trips-id-reorder-stops)

## validation_failed {#validation_failed}

HTTP `422` · ข้อมูลไม่ถูกต้อง

พบใน: [`POST /v1/exports`](ref-exports.md#post-exports), [`GET /v1/companies`](ref-companies.md#get-companies), [`GET /v1/branches`](ref-branches.md#get-branches), [`GET /v1/audit-logs`](ref-audit.md#get-audit-logs), [`POST /v1/documents`](ref-documents.md#post-documents), [`PUT /v1/documents/{id}/content`](ref-documents.md#put-documents-id-content), [`GET /v1/customers`](ref-customers.md#get-customers), [`POST /v1/customers`](ref-customers.md#post-customers), [`GET /v1/customers/export`](ref-customers.md#get-customers-export), [`PUT /v1/customers/external/{externalId}`](ref-customers.md#put-customers-external-externalId), [`PATCH /v1/customers/external/{externalId}`](ref-customers.md#patch-customers-external-externalId), [`PATCH /v1/customers/{id}`](ref-customers.md#patch-customers-id) และอีก 204 endpoint
