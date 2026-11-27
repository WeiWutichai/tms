# รหัส error

ทุก error เป็น `application/problem+json` (RFC 9457) — `type` = `https://docs.tms.example/problems/<code>` ชี้มาที่หัวข้อในหน้านี้ · ตัดสินใจจาก `code` เท่านั้น ดู [แนวทางการใช้ API](conventions.md#รูปแบบ-error-rfc-9457)

| code | HTTP | ความหมาย |
|---|---|---|
| [`bad_request`](#bad_request) | 400 | คำขอไม่ถูกต้อง |
| [`invalid_api_version`](#invalid_api_version) | 400 | X-Api-Version ไม่ถูกต้อง (ต้องเป็นวันที่ YYYY-MM-DD) |
| [`invalid_grant`](#invalid_grant) | 400 | การเข้าสู่ระบบหมดเวลา ลองใหม่อีกครั้ง |
| [`invalid_scope`](#invalid_scope) | 400 | ขอ scope ที่ API key นี้ไม่มี |
| [`invitation_invalid`](#invitation_invalid) | 400 | ลิงก์คำเชิญไม่ถูกต้อง หมดอายุ หรือใช้ไปแล้ว ขอให้ผู้ดูแลส่งคำเชิญใหม่ |
| [`reset_link_invalid`](#reset_link_invalid) | 400 | ลิงก์ตั้งรหัสผ่านไม่ถูกต้อง หมดอายุ หรือใช้ไปแล้ว ขอลิงก์ใหม่อีกครั้ง |
| [`invalid_client`](#invalid_client) | 401 | client_id หรือ client_secret ไม่ถูกต้อง |
| [`invalid_credentials`](#invalid_credentials) | 401 | อีเมลหรือรหัสผ่านไม่ถูกต้อง |
| [`invalid_otp`](#invalid_otp) | 401 | รหัสยืนยันไม่ถูกต้องหรือหมดอายุ |
| [`key_expired`](#key_expired) | 401 | API key หมดอายุแล้ว |
| [`key_revoked`](#key_revoked) | 401 | API key ถูกเพิกถอนแล้ว |
| [`mfa_enrollment_required`](#mfa_enrollment_required) | 401 | บัญชีนี้ต้องตั้งการยืนยันตัวตน 2 ชั้นก่อนเข้าใช้งาน |
| [`mfa_expired`](#mfa_expired) | 401 | หมดเวลายืนยันตัวตน เข้าสู่ระบบใหม่อีกครั้ง |
| [`mfa_required`](#mfa_required) | 401 | กรอกรหัสยืนยันตัวตน 2 ชั้นจากแอป Authenticator |
| [`unauthorized`](#unauthorized) | 401 | ต้องเข้าสู่ระบบ |
| [`bank_change_requires_user`](#bank_change_requires_user) | 403 | แก้หรือดูบัญชีธนาคารผู้รับเหมาผ่าน API key ไม่ได้ ต้องให้ผู้ใช้ทำในระบบ |
| [`bot_check_failed`](#bot_check_failed) | 403 | ยืนยันว่าไม่ใช่บอทไม่สำเร็จ กรุณาลองใหม่อีกครั้ง |
| [`edit_lock_user_required`](#edit_lock_user_required) | 403 | การล็อกเพื่อแก้ไขใช้ได้เฉพาะผู้ใช้ในระบบ |
| [`erp_replace_self_approval`](#erp_replace_self_approval) | 403 | ผู้ขอแทนที่เอกสารในระบบบัญชี (ผู้ออกใบใหม่ ผู้ยกเลิกใบเดิม หรือผู้สั่งส่งซ้ำ) อนุมัติเองไม่ได้ ต้องให้ผู้อนุมัติคนอื่น |
| [`feature_not_in_plan`](#feature_not_in_plan) | 403 | แพ็กเกจปัจจุบันยังไม่มีฟีเจอร์นี้ |
| [`forbidden`](#forbidden) | 403 | ไม่มีสิทธิ์ทำรายการนี้ |
| [`impersonation_read_only`](#impersonation_read_only) | 403 | กำลังเข้าใช้งานแทนแบบอ่านอย่างเดียว — แก้ไขข้อมูลไม่ได้ |
| [`invoice_self_finalize`](#invoice_self_finalize) | 403 | ผู้สร้างหรือผู้แก้ร่างใบแจ้งหนี้ ออกเอกสารใบนั้นเองไม่ได้ ต้องให้ผู้อื่นออก |
| [`ip_not_allowed`](#ip_not_allowed) | 403 | IP นี้ไม่ได้รับอนุญาตให้ใช้ API key นี้ |
| [`payment_difference_over_limit`](#payment_difference_over_limit) | 403 | ส่วนต่างเกินวงเงินที่ตั้งไว้ ต้องให้ผู้จัดการบันทึก |
| [`permission_denied`](#permission_denied) | 403 | ไม่มีสิทธิ์ทำรายการนี้ |
| [`sandbox_only`](#sandbox_only) | 403 | ใช้ได้เฉพาะโหมด Sandbox (key tk_test_ หรือสลับเป็น Sandbox) |
| [`sandbox_unsupported`](#sandbox_unsupported) | 403 | ใช้ใน Sandbox ไม่ได้ (เชื่อมระบบภายนอกจริง) |
| [`self_approval_forbidden`](#self_approval_forbidden) | 403 | ยืนยันหรือปฏิเสธรายการที่ตัวเองบันทึกไม่ได้ ต้องให้ผู้อื่นตรวจ |
| [`settlement_self_approval`](#settlement_self_approval) | 403 | ผู้เตรียมใบสำคัญจ่าย (สร้างใบ เพิ่มหรือนำรายการออก) อนุมัติใบนั้นไม่ได้ ต้องให้ผู้อนุมัติคนอื่น |
| [`settlement_self_payment`](#settlement_self_payment) | 403 | ผู้อนุมัติใบสำคัญจ่าย บันทึกจ่ายใบนั้นเองไม่ได้ ต้องให้ผู้อื่นบันทึกจ่าย |
| [`step_up_required`](#step_up_required) | 403 | ยืนยันตัวตน 2 ชั้นอีกครั้งก่อนทำรายการนี้ |
| [`two_factor_enrolment_required`](#two_factor_enrolment_required) | 403 | บัญชีนี้ต้องตั้งการยืนยันตัวตน 2 ชั้นก่อนใช้งาน |
| [`not_found`](#not_found) | 404 | ไม่พบข้อมูล |
| [`method_not_allowed`](#method_not_allowed) | 405 | ไม่รองรับวิธีเรียกนี้ |
| [`alias_conflict`](#alias_conflict) | 409 | รหัสหรือชื่อลูกค้าตามต้นทางนี้เคยจับคู่กับลูกค้ารายอื่นไว้แล้ว — ยืนยันการย้ายพร้อมเหตุผล |
| [`already_member`](#already_member) | 409 | อีเมลนี้เป็นสมาชิกของบริษัทแล้ว |
| [`assignment_blocked`](#assignment_blocked) | 409 | รถหรือคนขับติดกฎห้ามจ่ายงาน — แก้เอกสารให้ครบ หรือให้ผู้จัดการยกเว้นพร้อมเหตุผล |
| [`assignment_warnings`](#assignment_warnings) | 409 | เที่ยวนี้มีคำเตือนที่ยังไม่ได้ยืนยัน — ยืนยันพร้อมเหตุผลก่อน |
| [`carrier_change_not_allowed`](#carrier_change_not_allowed) | 409 | เปลี่ยนผู้รับเหมาได้เฉพาะเที่ยวที่รอรถร่วมตอบ หรือรถร่วมรับงานแล้วแต่ยังไม่ปล่อยรถ |
| [`carrier_change_requires_cancel`](#carrier_change_requires_cancel) | 409 | เปลี่ยนรถร่วมหรือสลับรถร่วม/รถบริษัทไม่ได้ — ยกเลิกการจ้างเดิมก่อน |
| [`channel_unavailable`](#channel_unavailable) | 409 | ส่งทางช่องทางนี้ไม่ได้ตอนนี้ คัดลอกลิงก์ไปส่งเองได้ |
| [`concurrent_update`](#concurrent_update) | 409 | มีการแก้ไขข้อมูลเดียวกันพร้อมกัน กรุณาลองใหม่อีกครั้ง |
| [`conflict`](#conflict) | 409 | ข้อมูลขัดแย้งกับที่มีอยู่ |
| [`connector_health_failed`](#connector_health_failed) | 409 | ทดสอบการเชื่อมต่อไม่ผ่าน ตรวจค่าตั้งและ credential แล้วลองใหม่ |
| [`connector_limit_reached`](#connector_limit_reached) | 409 | จำนวนการเชื่อมระบบบัญชีครบตามแพ็กเกจแล้ว |
| [`connector_scope_taken`](#connector_scope_taken) | 409 | นิติบุคคลนี้เชื่อมระบบบัญชีอยู่แล้ว ยกเลิกการเชื่อมเดิมก่อน |
| [`delivery_order_on_trip`](#delivery_order_on_trip) | 409 | ใบส่งของนี้อยู่ในเที่ยวรถแล้ว — ถอดออกจากเที่ยวก่อน |
| [`do_already_drafted`](#do_already_drafted) | 409 | ใบส่งของนี้อยู่ในใบแจ้งหนี้อื่นแล้ว |
| [`do_in_invoice`](#do_in_invoice) | 409 | ใบส่งของนี้อยู่ในใบแจ้งหนี้แล้ว — แก้ที่ใบแจ้งหนี้ หรือถอดออกจากร่างก่อน |
| [`do_released`](#do_released) | 409 | ใบส่งของนี้ส่งบัญชีแล้ว — แก้จุดแวะ/ยอดส่งจริงไม่ได้ ให้ฝ่ายวางบิลย้อนการส่งบัญชีก่อน |
| [`document_email_pending`](#document_email_pending) | 409 | เอกสารนี้กำลังรอส่งถึงผู้รับเดิมอยู่ — รอสักครู่แล้วตรวจสถานะการส่ง |
| [`duplicate`](#duplicate) | 409 | ข้อมูลซ้ำกับที่มีอยู่ |
| [`external_id_conflict`](#external_id_conflict) | 409 | เลขอ้างอิงต้นทางนี้ถูกใช้กับใบสั่งขนส่งจากช่องทางอื่นแล้ว |
| [`idempotency_in_progress`](#idempotency_in_progress) | 409 | คำขอเดียวกันกำลังประมวลผลอยู่ |
| [`import_expired`](#import_expired) | 409 | ผลตรวจไฟล์หมดอายุแล้ว (24 ชั่วโมง) อัปโหลดไฟล์ใหม่ |
| [`import_has_errors`](#import_has_errors) | 409 | ไฟล์มีแถวที่ตรวจไม่ผ่าน — แก้ไฟล์หรือเลือกนำเข้าเฉพาะแถวที่ผ่าน |
| [`in_use`](#in_use) | 409 | ลบไม่ได้ เพราะมีเอกสารหรือข้อมูลอื่นอ้างถึงแล้ว — ใช้ "ปิดใช้" แทน |
| [`in_use_active`](#in_use_active) | 409 | ปิดใช้ไม่ได้ เพราะยังมีข้อมูลที่ใช้งานอยู่อ้างถึง |
| [`inbound_not_supported`](#inbound_not_supported) | 409 | ระบบบัญชีนี้ไม่รองรับการส่งข้อมูลเข้ามาทาง webhook |
| [`invalid_state_transition`](#invalid_state_transition) | 409 | ทำรายการนี้ไม่ได้ในสถานะปัจจุบัน |
| [`invoice_already_billed`](#invoice_already_billed) | 409 | ใบแจ้งหนี้นี้อยู่ในใบวางบิลอื่นแล้ว |
| [`invoice_has_payments`](#invoice_has_payments) | 409 | ใบแจ้งหนี้นี้รับชำระแล้ว ยกเลิกไม่ได้ — กลับรายการรับชำระก่อน |
| [`invoice_not_billable`](#invoice_not_billable) | 409 | ใบแจ้งหนี้นี้ยังไม่ออกหรือไม่มียอดค้าง ใส่ในใบวางบิลไม่ได้ |
| [`invoice_not_finalizable`](#invoice_not_finalizable) | 409 | ยังออกเอกสารใบแจ้งหนี้นี้ไม่ได้ |
| [`invoice_not_payable`](#invoice_not_payable) | 409 | ใบแจ้งหนี้นี้รับชำระไม่ได้ในสถานะปัจจุบัน |
| [`invoice_on_billing_note`](#invoice_on_billing_note) | 409 | ใบแจ้งหนี้นี้อยู่ในใบวางบิลที่ออกแล้ว ยกเลิกไม่ได้ — ยกเลิกใบวางบิลก่อน |
| [`invoice_pdf_template_changed`](#invoice_pdf_template_changed) | 409 | แม่แบบเอกสารเปลี่ยนหลังวันออก สร้าง PDF ของใบนี้ใหม่ไม่ได้ — ติดต่อผู้ดูแลระบบ |
| [`invoice_sent_to_customer`](#invoice_sent_to_customer) | 409 | ใบแจ้งหนี้นี้ส่งลูกค้าแล้ว ยกเลิกไม่ได้ |
| [`master_sync_failed`](#master_sync_failed) | 409 | ดึงผังรหัสจากระบบบัญชีไม่สำเร็จ ตรวจการเชื่อมต่อแล้วลองใหม่ |
| [`master_sync_not_supported`](#master_sync_not_supported) | 409 | ระบบบัญชีนี้ดึงผังรหัสอัตโนมัติไม่ได้ นำเข้าจากไฟล์แทน |
| [`not_ready_to_bill`](#not_ready_to_bill) | 409 | ใบส่งของนี้ยังไม่พร้อมวางบิล |
| [`offer_closed`](#offer_closed) | 409 | ข้อเสนองานนี้ปิดแล้ว (ตอบไปแล้วหรือถูกยกเลิก) |
| [`offer_not_timed_out`](#offer_not_timed_out) | 409 | รถร่วมรายนี้ยังอยู่ในเวลาตอบรับ — ส่งรายถัดไปได้เมื่อครบเวลา |
| [`offer_required`](#offer_required) | 409 | รถคันนี้เป็นรถร่วม — ต้องเสนองานให้รถร่วมก่อน แล้วจึงบันทึกการรับงาน |
| [`order_lock_released`](#order_lock_released) | 409 | การแก้ไขของคุณถูกปลดล็อกโดยผู้อื่นแล้ว — โหลดใหม่ก่อนแก้ต่อ |
| [`order_locked_by_user`](#order_locked_by_user) | 409 | ใบสั่งขนส่งนี้กำลังถูกแก้ไขโดยผู้ใช้อื่น |
| [`order_locked_for_update`](#order_locked_for_update) | 409 | แก้ข้อมูลนี้ของใบสั่งขนส่งไม่ได้ในสถานะปัจจุบัน (วางแผน ออกรถ ปิดงาน หรือยกเลิกแล้ว) |
| [`order_not_ready_for_delivery`](#order_not_ready_for_delivery) | 409 | ยังสร้างใบส่งของจากใบสั่งขนส่งนี้ไม่ได้ (ร่าง ยกเลิก วางแผนแล้ว หรือยังจับคู่ลูกค้า/สถานที่ไม่ครบ) |
| [`order_on_trip`](#order_on_trip) | 409 | ใบสั่งขนส่งนี้มีใบส่งของอยู่ในเที่ยวรถ — ถอดออกจากเที่ยวก่อน |
| [`order_source_change_pending`](#order_source_change_pending) | 409 | ต้นทางแก้ใบสั่งขนส่งนี้หลังวางแผน — เลือกรับค่าต้นทางหรือใช้ค่า TMS ก่อนจัดลงเที่ยว |
| [`payment_exceeds_outstanding`](#payment_exceeds_outstanding) | 409 | ยอดตัดหนี้เกินยอดคงค้าง |
| [`pod_exists`](#pod_exists) | 409 | ส่ง POD ของใบส่งของนี้แล้ว |
| [`pod_not_allowed`](#pod_not_allowed) | 409 | บันทึกหลักฐานส่งของใบส่งของนี้ไม่ได้ในสถานะปัจจุบัน |
| [`queue_action_not_allowed`](#queue_action_not_allowed) | 409 | ทำรายการนี้กับคำสั่งนี้ไม่ได้ (จัดการไปแล้ว หรือไม่ใช่รายการที่ล้มเหลว หรือต้องทำในระบบบัญชีเอง) |
| [`sandbox_finalize_disabled`](#sandbox_finalize_disabled) | 409 | โหมดทดสอบ (sandbox) ยังออกเลขใบแจ้งหนี้ไม่ได้ |
| [`saved_view_limit`](#saved_view_limit) | 409 | บันทึกได้สูงสุด 50 มุมมองต่อหน้า |
| [`seat_limit_reached`](#seat_limit_reached) | 409 | จำนวนผู้ใช้ครบตามแพ็กเกจแล้ว |
| [`secret_unreadable`](#secret_unreadable) | 409 | อ่านข้อมูลลับเดิมไม่ได้ (กุญแจเข้ารหัสเดิมถูกถอดออกแล้ว) — กรอกเลขใหม่แทน |
| [`settlement_carrier_type_missing`](#settlement_carrier_type_missing) | 409 | ข้อมูลรถร่วมในใบสำคัญจ่ายไม่มีประเภท (บุคคลธรรมดา/นิติบุคคล) คำนวณหัก ณ ที่จ่ายไม่ได้ — ยกเลิกใบแล้วสร้างใหม่ |
| [`settlement_disputed`](#settlement_disputed) | 409 | มีรายการโต้แย้งที่ยังไม่เคลียร์ อนุมัติไม่ได้ — ยืนยันยอดเดิมพร้อมเหตุผล หรือเรียกใบกลับมาแก้รายการ |
| [`settlement_empty`](#settlement_empty) | 409 | ใบสำคัญจ่ายยังไม่มีรายการเที่ยว อนุมัติไม่ได้ |
| [`settlement_line_resolved`](#settlement_line_resolved) | 409 | บริษัทยืนยันยอดของรายการนี้แล้ว ตอบรายการนี้ไม่ได้อีก |
| [`settlement_net_negative`](#settlement_net_negative) | 409 | ยอดสุทธิติดลบ อนุมัติไม่ได้ — นำรายการหักส่วนเกินออกแล้วยกไปงวดถัดไป |
| [`settlement_review_required`](#settlement_review_required) | 409 | ต้องส่งให้รถร่วมตรวจก่อนอนุมัติ (ตั้งค่าบริษัท) |
| [`sor_locked`](#sor_locked) | 409 | เปลี่ยนเจ้าของเอกสารไม่ได้ เพราะมีเอกสารส่งหรือรอส่งเข้าระบบบัญชีแล้ว — ยกเลิกการเชื่อมแล้วตั้งใหม่ |
| [`source_change_not_pending`](#source_change_not_pending) | 409 | การเปลี่ยนแปลงจากต้นทางชุดนี้ถูกตัดสินไปแล้ว หรือมีชุดใหม่มาแทน — โหลดใหม่ |
| [`stop_already_closed`](#stop_already_closed) | 409 | จุดนี้ถูกปิดแล้ว — ส่ง POD ของ DO นี้ได้ |
| [`stop_event_already_resolved`](#stop_event_already_resolved) | 409 | เหตุการณ์นี้ถูกตัดสินไปแล้ว |
| [`stop_event_duplicate`](#stop_event_duplicate) | 409 | clientEventId นี้ถูกใช้กับ event อื่นแล้ว |
| [`stop_event_not_flagged`](#stop_event_not_flagged) | 409 | เหตุการณ์นี้ไม่มีข้อขัดแย้งให้ตัดสิน |
| [`stop_not_arrived`](#stop_not_arrived) | 409 | ยังไม่ได้บันทึกถึงจุดนี้ |
| [`stop_not_ready`](#stop_not_ready) | 409 | ปิดงานจุดก่อนหน้าก่อน |
| [`stop_skipped`](#stop_skipped) | 409 | จุดนี้ไม่มีใบส่งของแล้ว (นัดส่งใหม่ไปเที่ยวอื่น) — ไม่ต้องบันทึกที่จุดนี้ |
| [`tax_document_owned_by_erp`](#tax_document_owned_by_erp) | 409 | นิติบุคคลนี้ให้ระบบบัญชีเป็นผู้ออกใบกำกับภาษี — TMS ออกได้เฉพาะใบแจ้งหนี้/ใบวางบิล |
| [`tenant_selection_required`](#tenant_selection_required) | 409 | อีเมลนี้เป็นสมาชิกหลายบริษัท เลือกบริษัทที่ต้องการเข้า |
| [`trip_cost_already_settled`](#trip_cost_already_settled) | 409 | บรรทัดต้นทุนนี้อยู่ในใบสำคัญจ่ายอื่นแล้ว — จ่ายซ้ำไม่ได้ |
| [`trip_cost_not_payable`](#trip_cost_not_payable) | 409 | เที่ยวหรือบรรทัดต้นทุนนี้ยังไม่อยู่ในคิวจ่ายของรถร่วมรายนี้ (ต้องปิดต้นทุนแล้ว หลักฐานส่งครบตามเงื่อนไข และเป็นของรถร่วมรายนี้) |
| [`trip_costing_unavailable`](#trip_costing_unavailable) | 409 | ปิดต้นทุนเที่ยวถูกปิดใช้ชั่วคราวโดยผู้ดูแลระบบ |
| [`trip_costs_incomplete`](#trip_costs_incomplete) | 409 | ต้นทุนเที่ยวยังไม่ครบ — ยืนยัน/ปฏิเสธค่าใช้จ่ายหน้างานที่รอ ตรวจค่าจ้างรถร่วม และรายได้ของใบส่งของ (ใช้ปันต้นทุน) ก่อนปิดต้นทุน |
| [`trip_empty`](#trip_empty) | 409 | เที่ยวนี้ยังไม่มีใบส่งของ |
| [`trip_has_loaded_orders`](#trip_has_loaded_orders) | 409 | ยกเลิกเที่ยวไม่ได้ — มีใบส่งของที่รับของขึ้นรถหรือส่งแล้ว (ปิดเที่ยวบางส่วนแล้วเปิดเที่ยวใหม่แทน) |
| [`trip_not_in_progress`](#trip_not_in_progress) | 409 | บันทึกสถานะหน้างานได้เฉพาะเที่ยวที่ปล่อยรถแล้วและยังไม่จบ |
| [`trip_stops_open`](#trip_stops_open) | 409 | ยังมีจุดแวะที่ยังไม่จบ — ปิดเที่ยวได้เมื่อทุกจุดส่งสำเร็จ/ไม่สำเร็จ/ข้าม |
| [`two_factor_not_enabled`](#two_factor_not_enabled) | 409 | ยังไม่ได้ตั้งการยืนยันตัวตน 2 ชั้น |
| [`webhook_limit_reached`](#webhook_limit_reached) | 409 | จำนวน webhook endpoint ครบตามแพ็กเกจแล้ว |
| [`precondition_failed`](#precondition_failed) | 412 | ข้อมูลถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดใหม่ |
| [`payload_too_large`](#payload_too_large) | 413 | ไฟล์หรือข้อมูลมีขนาดใหญ่เกินกำหนด |
| [`branch_unavailable`](#branch_unavailable) | 422 | นิติบุคคลออกบิลยังไม่มีสาขาที่ออกเอกสาร |
| [`company_unavailable`](#company_unavailable) | 422 | นิติบุคคลออกบิลไม่พบหรือปิดใช้อยู่ |
| [`document_email_no_recipient`](#document_email_no_recipient) | 422 | ลูกค้ายังไม่มีอีเมลผู้ติดต่อ — เพิ่มอีเมลในข้อมูลลูกค้า หรือดาวน์โหลด PDF แล้วส่งเอง |
| [`email_attachment_too_large`](#email_attachment_too_large) | 422 | ไฟล์ใหญ่เกินกว่าจะส่งทางอีเมล — ดาวน์โหลด PDF แล้วส่งเอง |
| [`idempotency_mismatch`](#idempotency_mismatch) | 422 | Idempotency-Key นี้เคยใช้กับข้อมูลอื่น |
| [`pod_incomplete`](#pod_incomplete) | 422 | หลักฐานการส่ง (POD) ยังไม่ครบตามที่ลูกค้ากำหนด |
| [`routing_not_configured`](#routing_not_configured) | 422 | บริษัทมีหลายนิติบุคคลแต่ยังไม่ได้กำหนดนิติบุคคลออกบิล — ส่ง billingCompanyId (จาก GET /v1/companies) หรือตั้ง "ออกบิลในนาม" ที่ลูกค้า/ค่าตั้งต้นของบริษัท |
| [`sor_fixed`](#sor_fixed) | 422 | ระบบบัญชีนี้เป็นผู้ออกเอกสารภาษีเสมอ เปลี่ยนไม่ได้ |
| [`sor_not_chosen`](#sor_not_chosen) | 422 | เลือก "ใครออกเลขเอกสาร" ก่อนเปิดการส่งเอกสารเข้าระบบบัญชี |
| [`stop_order_invalid`](#stop_order_invalid) | 422 | ลำดับจุดไม่ถูกต้อง — จุดส่งของใบส่งของต้องอยู่หลังจุดรับของใบเดียวกัน |
| [`validation_failed`](#validation_failed) | 422 | ข้อมูลไม่ถูกต้อง |
| [`webhook_event_expired`](#webhook_event_expired) | 422 | event เกิน 30 วันแล้ว ส่งซ้ำไม่ได้ |
| [`webhook_event_not_subscribed`](#webhook_event_not_subscribed) | 422 | endpoint นี้ไม่ได้สมัคร event ชนิดนี้ |
| [`webhook_not_retryable`](#webhook_not_retryable) | 422 | ส่งซ้ำรายการนี้ไม่ได้ (event ทดสอบ) ใช้ "ส่ง event ทดสอบ" แทน |
| [`account_locked`](#account_locked) | 429 | ใส่รหัสผ่านผิดหลายครั้ง ลองใหม่อีกครั้งใน 15 นาที |
| [`rate_limited`](#rate_limited) | 429 | เรียกถี่เกินไป |
| [`internal_error`](#internal_error) | 500 | ระบบขัดข้อง |
| [`trip_cost_allocation_failed`](#trip_cost_allocation_failed) | 500 | ปันต้นทุนเที่ยวลงใบส่งของไม่ลงตัว — ยังไม่ปิดต้นทุน กรุณาแจ้งผู้ดูแลระบบ |
| [`pdf_render_timeout`](#pdf_render_timeout) | 503 | สร้าง PDF ไม่ทันเวลา กรุณาลองใหม่อีกครั้ง |
| [`service_busy`](#service_busy) | 503 | ระบบกำลังมีผู้ใช้งานมาก กรุณาลองใหม่อีกครั้ง |

## bad_request {#bad_request}

HTTP `400` · คำขอไม่ถูกต้อง

พบใน: [`POST /v1/orders:bulk`](ref-orders.md#post-orders-bulk), [`POST /v1/orders`](ref-orders.md#post-orders), [`PUT /v1/orders/external/{externalId}`](ref-orders.md#put-orders-external-externalId), [`PATCH /v1/orders/external/{externalId}`](ref-orders.md#patch-orders-external-externalId), [`PATCH /v1/orders/{id}`](ref-orders.md#patch-orders-id), [`POST /v1/orders/{id}/cancel`](ref-orders.md#post-orders-id-cancel), [`POST /v1/orders/{id}/source-changes/{changeId}/accept`](ref-orders.md#post-orders-id-source-changes-changeId-accept), [`POST /v1/orders/{id}/source-changes/{changeId}/reject`](ref-orders.md#post-orders-id-source-changes-changeId-reject), [`POST /v1/orders/{id}/stops/{sequence}/map-site`](ref-orders.md#post-orders-id-stops-sequence-map-site), [`POST /v1/orders/{id}/manual-price`](ref-orders.md#post-orders-id-manual-price), [`POST /v1/orders/{id}/resolve-source-error`](ref-orders.md#post-orders-id-resolve-source-error), [`POST /v1/orders/{id}/map-customer`](ref-orders.md#post-orders-id-map-customer)

## invalid_api_version {#invalid_api_version}

HTTP `400` · X-Api-Version ไม่ถูกต้อง (ต้องเป็นวันที่ YYYY-MM-DD)

อาจตอบได้จากหลาย endpoint

## invalid_grant {#invalid_grant}

HTTP `400` · การเข้าสู่ระบบหมดเวลา ลองใหม่อีกครั้ง

อาจตอบได้จากหลาย endpoint

## invalid_scope {#invalid_scope}

HTTP `400` · ขอ scope ที่ API key นี้ไม่มี

อาจตอบได้จากหลาย endpoint

## invitation_invalid {#invitation_invalid}

HTTP `400` · ลิงก์คำเชิญไม่ถูกต้อง หมดอายุ หรือใช้ไปแล้ว ขอให้ผู้ดูแลส่งคำเชิญใหม่

อาจตอบได้จากหลาย endpoint

## reset_link_invalid {#reset_link_invalid}

HTTP `400` · ลิงก์ตั้งรหัสผ่านไม่ถูกต้อง หมดอายุ หรือใช้ไปแล้ว ขอลิงก์ใหม่อีกครั้ง

อาจตอบได้จากหลาย endpoint

## invalid_client {#invalid_client}

HTTP `401` · client_id หรือ client_secret ไม่ถูกต้อง

อาจตอบได้จากหลาย endpoint

## invalid_credentials {#invalid_credentials}

HTTP `401` · อีเมลหรือรหัสผ่านไม่ถูกต้อง

อาจตอบได้จากหลาย endpoint

## invalid_otp {#invalid_otp}

HTTP `401` · รหัสยืนยันไม่ถูกต้องหรือหมดอายุ

อาจตอบได้จากหลาย endpoint

## key_expired {#key_expired}

HTTP `401` · API key หมดอายุแล้ว

อาจตอบได้จากหลาย endpoint

## key_revoked {#key_revoked}

HTTP `401` · API key ถูกเพิกถอนแล้ว

อาจตอบได้จากหลาย endpoint

## mfa_enrollment_required {#mfa_enrollment_required}

HTTP `401` · บัญชีนี้ต้องตั้งการยืนยันตัวตน 2 ชั้นก่อนเข้าใช้งาน

อาจตอบได้จากหลาย endpoint

## mfa_expired {#mfa_expired}

HTTP `401` · หมดเวลายืนยันตัวตน เข้าสู่ระบบใหม่อีกครั้ง

อาจตอบได้จากหลาย endpoint

## mfa_required {#mfa_required}

HTTP `401` · กรอกรหัสยืนยันตัวตน 2 ชั้นจากแอป Authenticator

อาจตอบได้จากหลาย endpoint

## unauthorized {#unauthorized}

HTTP `401` · ต้องเข้าสู่ระบบ

พบใน: [`POST /v1/exports`](ref-exports.md#post-exports), [`GET /v1/exports/{id}`](ref-exports.md#get-exports-id), [`GET /v1/search`](ref-search.md#get-search), [`GET /v1/companies`](ref-companies.md#get-companies), [`GET /v1/companies/{id}`](ref-companies.md#get-companies-id), [`GET /v1/branches`](ref-branches.md#get-branches), [`GET /v1/branches/{id}`](ref-branches.md#get-branches-id), [`GET /v1/document-sequences`](ref-document-sequences.md#get-document-sequences), [`GET /v1/document-sequences/{id}`](ref-document-sequences.md#get-document-sequences-id), [`GET /v1/audit-logs`](ref-audit.md#get-audit-logs), [`POST /v1/documents`](ref-documents.md#post-documents), [`GET /v1/documents/{id}`](ref-documents.md#get-documents-id) และอีก 407 endpoint

## bank_change_requires_user {#bank_change_requires_user}

HTTP `403` · แก้หรือดูบัญชีธนาคารผู้รับเหมาผ่าน API key ไม่ได้ ต้องให้ผู้ใช้ทำในระบบ

พบใน: [`POST /v1/carriers`](ref-carriers.md#post-carriers), [`PUT /v1/carriers/external/{externalId}`](ref-carriers.md#put-carriers-external-externalId), [`PATCH /v1/carriers/external/{externalId}`](ref-carriers.md#patch-carriers-external-externalId), [`PATCH /v1/carriers/{id}`](ref-carriers.md#patch-carriers-id), [`POST /v1/carriers/{id}/reveal`](ref-carriers.md#post-carriers-id-reveal)

## bot_check_failed {#bot_check_failed}

HTTP `403` · ยืนยันว่าไม่ใช่บอทไม่สำเร็จ กรุณาลองใหม่อีกครั้ง

อาจตอบได้จากหลาย endpoint

## edit_lock_user_required {#edit_lock_user_required}

HTTP `403` · การล็อกเพื่อแก้ไขใช้ได้เฉพาะผู้ใช้ในระบบ

พบใน: [`POST /v1/orders/{id}/lock`](ref-orders.md#post-orders-id-lock)

## erp_replace_self_approval {#erp_replace_self_approval}

HTTP `403` · ผู้ขอแทนที่เอกสารในระบบบัญชี (ผู้ออกใบใหม่ ผู้ยกเลิกใบเดิม หรือผู้สั่งส่งซ้ำ) อนุมัติเองไม่ได้ ต้องให้ผู้อนุมัติคนอื่น

อาจตอบได้จากหลาย endpoint

## feature_not_in_plan {#feature_not_in_plan}

HTTP `403` · แพ็กเกจปัจจุบันยังไม่มีฟีเจอร์นี้

อาจตอบได้จากหลาย endpoint

## forbidden {#forbidden}

HTTP `403` · ไม่มีสิทธิ์ทำรายการนี้

อาจตอบได้จากหลาย endpoint

## impersonation_read_only {#impersonation_read_only}

HTTP `403` · กำลังเข้าใช้งานแทนแบบอ่านอย่างเดียว — แก้ไขข้อมูลไม่ได้

อาจตอบได้จากหลาย endpoint

## invoice_self_finalize {#invoice_self_finalize}

HTTP `403` · ผู้สร้างหรือผู้แก้ร่างใบแจ้งหนี้ ออกเอกสารใบนั้นเองไม่ได้ ต้องให้ผู้อื่นออก

พบใน: [`POST /v1/invoices/{id}/finalize`](ref-invoices.md#post-invoices-id-finalize)

## ip_not_allowed {#ip_not_allowed}

HTTP `403` · IP นี้ไม่ได้รับอนุญาตให้ใช้ API key นี้

อาจตอบได้จากหลาย endpoint

## payment_difference_over_limit {#payment_difference_over_limit}

HTTP `403` · ส่วนต่างเกินวงเงินที่ตั้งไว้ ต้องให้ผู้จัดการบันทึก

พบใน: [`POST /v1/payments`](ref-payments.md#post-payments)

## permission_denied {#permission_denied}

HTTP `403` · ไม่มีสิทธิ์ทำรายการนี้

พบใน: [`POST /v1/exports`](ref-exports.md#post-exports), [`GET /v1/exports/{id}`](ref-exports.md#get-exports-id), [`GET /v1/search`](ref-search.md#get-search), [`GET /v1/companies`](ref-companies.md#get-companies), [`GET /v1/companies/{id}`](ref-companies.md#get-companies-id), [`GET /v1/branches`](ref-branches.md#get-branches), [`GET /v1/branches/{id}`](ref-branches.md#get-branches-id), [`GET /v1/document-sequences`](ref-document-sequences.md#get-document-sequences), [`GET /v1/document-sequences/{id}`](ref-document-sequences.md#get-document-sequences-id), [`GET /v1/audit-logs`](ref-audit.md#get-audit-logs), [`POST /v1/documents`](ref-documents.md#post-documents), [`GET /v1/documents/{id}`](ref-documents.md#get-documents-id) และอีก 407 endpoint

## sandbox_only {#sandbox_only}

HTTP `403` · ใช้ได้เฉพาะโหมด Sandbox (key tk_test_ หรือสลับเป็น Sandbox)

อาจตอบได้จากหลาย endpoint

## sandbox_unsupported {#sandbox_unsupported}

HTTP `403` · ใช้ใน Sandbox ไม่ได้ (เชื่อมระบบภายนอกจริง)

อาจตอบได้จากหลาย endpoint

## self_approval_forbidden {#self_approval_forbidden}

HTTP `403` · ยืนยันหรือปฏิเสธรายการที่ตัวเองบันทึกไม่ได้ ต้องให้ผู้อื่นตรวจ

อาจตอบได้จากหลาย endpoint

## settlement_self_approval {#settlement_self_approval}

HTTP `403` · ผู้เตรียมใบสำคัญจ่าย (สร้างใบ เพิ่มหรือนำรายการออก) อนุมัติใบนั้นไม่ได้ ต้องให้ผู้อนุมัติคนอื่น

อาจตอบได้จากหลาย endpoint

## settlement_self_payment {#settlement_self_payment}

HTTP `403` · ผู้อนุมัติใบสำคัญจ่าย บันทึกจ่ายใบนั้นเองไม่ได้ ต้องให้ผู้อื่นบันทึกจ่าย

พบใน: [`POST /v1/settlements/{id}/mark-paid`](ref-settlements.md#post-settlements-id-mark-paid)

## step_up_required {#step_up_required}

HTTP `403` · ยืนยันตัวตน 2 ชั้นอีกครั้งก่อนทำรายการนี้

พบใน: [`POST /v1/exports`](ref-exports.md#post-exports), [`GET /v1/customers/export`](ref-customers.md#get-customers-export), [`GET /v1/customer-sites/export`](ref-customer-sites.md#get-customer-sites-export), [`GET /v1/routes/export`](ref-routes.md#get-routes-export), [`GET /v1/products/export`](ref-products.md#get-products-export), [`GET /v1/vehicle-types/export`](ref-vehicle-types.md#get-vehicle-types-export), [`GET /v1/service-items/export`](ref-service-items.md#get-service-items-export), [`GET /v1/reason-codes/export`](ref-reason-codes.md#get-reason-codes-export), [`POST /v1/webhooks`](ref-webhooks.md#post-webhooks), [`PATCH /v1/webhooks/{id}`](ref-webhooks.md#patch-webhooks-id), [`POST /v1/webhooks/{id}/rotate-secret`](ref-webhooks.md#post-webhooks-id-rotate-secret), [`GET /v1/rate-cards/export`](ref-rate-cards.md#get-rate-cards-export) และอีก 11 endpoint

## two_factor_enrolment_required {#two_factor_enrolment_required}

HTTP `403` · บัญชีนี้ต้องตั้งการยืนยันตัวตน 2 ชั้นก่อนใช้งาน

อาจตอบได้จากหลาย endpoint

## not_found {#not_found}

HTTP `404` · ไม่พบข้อมูล

พบใน: [`GET /v1/exports/{id}`](ref-exports.md#get-exports-id), [`GET /v1/companies/{id}`](ref-companies.md#get-companies-id), [`GET /v1/branches/{id}`](ref-branches.md#get-branches-id), [`GET /v1/document-sequences/{id}`](ref-document-sequences.md#get-document-sequences-id), [`GET /v1/documents/{id}`](ref-documents.md#get-documents-id), [`GET /v1/documents/{id}/content`](ref-documents.md#get-documents-id-content), [`PUT /v1/documents/{id}/content`](ref-documents.md#put-documents-id-content), [`GET /v1/jobs/{id}`](ref-jobs.md#get-jobs-id), [`PATCH /v1/customers/external/{externalId}`](ref-customers.md#patch-customers-external-externalId), [`GET /v1/customers/{id}`](ref-customers.md#get-customers-id), [`PATCH /v1/customers/{id}`](ref-customers.md#patch-customers-id), [`GET /v1/customers/{id}/history`](ref-customers.md#get-customers-id-history) และอีก 265 endpoint

## method_not_allowed {#method_not_allowed}

HTTP `405` · ไม่รองรับวิธีเรียกนี้

อาจตอบได้จากหลาย endpoint

## alias_conflict {#alias_conflict}

HTTP `409` · รหัสหรือชื่อลูกค้าตามต้นทางนี้เคยจับคู่กับลูกค้ารายอื่นไว้แล้ว — ยืนยันการย้ายพร้อมเหตุผล

พบใน: [`POST /v1/orders/{id}/map-customer`](ref-orders.md#post-orders-id-map-customer)

## already_member {#already_member}

HTTP `409` · อีเมลนี้เป็นสมาชิกของบริษัทแล้ว

อาจตอบได้จากหลาย endpoint

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

## channel_unavailable {#channel_unavailable}

HTTP `409` · ส่งทางช่องทางนี้ไม่ได้ตอนนี้ คัดลอกลิงก์ไปส่งเองได้

อาจตอบได้จากหลาย endpoint

## concurrent_update {#concurrent_update}

HTTP `409` · มีการแก้ไขข้อมูลเดียวกันพร้อมกัน กรุณาลองใหม่อีกครั้ง

พบใน: [`POST /v1/orders/{id}/lock`](ref-orders.md#post-orders-id-lock), [`PUT /v1/delivery-orders/{id}/pod`](ref-delivery-orders.md#put-delivery-orders-id-pod), [`POST /v1/trips`](ref-trips.md#post-trips), [`POST /v1/trips/{id}/schedule`](ref-trips.md#post-trips-id-schedule), [`POST /v1/trips/{id}/attach`](ref-trips.md#post-trips-id-attach), [`POST /v1/trips/{id}/detach`](ref-trips.md#post-trips-id-detach), [`POST /v1/trips/{id}/reorder-stops`](ref-trips.md#post-trips-id-reorder-stops), [`POST /v1/trips/{id}/assign`](ref-trips.md#post-trips-id-assign), [`POST /v1/trips/{id}/offer`](ref-trips.md#post-trips-id-offer), [`POST /v1/trips/{id}/dispatch`](ref-trips.md#post-trips-id-dispatch), [`POST /v1/trips/{id}/confirm-rules`](ref-trips.md#post-trips-id-confirm-rules), [`POST /v1/trips/{id}/complete`](ref-trips.md#post-trips-id-complete) และอีก 56 endpoint

## conflict {#conflict}

HTTP `409` · ข้อมูลขัดแย้งกับที่มีอยู่

พบใน: [`PUT /v1/customers/external/{externalId}`](ref-customers.md#put-customers-external-externalId), [`PATCH /v1/customers/external/{externalId}`](ref-customers.md#patch-customers-external-externalId), [`PUT /v1/customer-sites/external/{externalId}`](ref-customer-sites.md#put-customer-sites-external-externalId), [`PATCH /v1/customer-sites/external/{externalId}`](ref-customer-sites.md#patch-customer-sites-external-externalId), [`PUT /v1/routes/external/{externalId}`](ref-routes.md#put-routes-external-externalId), [`PATCH /v1/routes/external/{externalId}`](ref-routes.md#patch-routes-external-externalId), [`PUT /v1/products/external/{externalId}`](ref-products.md#put-products-external-externalId), [`PATCH /v1/products/external/{externalId}`](ref-products.md#patch-products-external-externalId), [`PUT /v1/vehicle-types/external/{externalId}`](ref-vehicle-types.md#put-vehicle-types-external-externalId), [`PATCH /v1/vehicle-types/external/{externalId}`](ref-vehicle-types.md#patch-vehicle-types-external-externalId), [`PUT /v1/service-items/external/{externalId}`](ref-service-items.md#put-service-items-external-externalId), [`PATCH /v1/service-items/external/{externalId}`](ref-service-items.md#patch-service-items-external-externalId) และอีก 14 endpoint

## connector_health_failed {#connector_health_failed}

HTTP `409` · ทดสอบการเชื่อมต่อไม่ผ่าน ตรวจค่าตั้งและ credential แล้วลองใหม่

อาจตอบได้จากหลาย endpoint

## connector_limit_reached {#connector_limit_reached}

HTTP `409` · จำนวนการเชื่อมระบบบัญชีครบตามแพ็กเกจแล้ว

อาจตอบได้จากหลาย endpoint

## connector_scope_taken {#connector_scope_taken}

HTTP `409` · นิติบุคคลนี้เชื่อมระบบบัญชีอยู่แล้ว ยกเลิกการเชื่อมเดิมก่อน

อาจตอบได้จากหลาย endpoint

## delivery_order_on_trip {#delivery_order_on_trip}

HTTP `409` · ใบส่งของนี้อยู่ในเที่ยวรถแล้ว — ถอดออกจากเที่ยวก่อน

พบใน: [`POST /v1/trips`](ref-trips.md#post-trips), [`POST /v1/trips/{id}/attach`](ref-trips.md#post-trips-id-attach)

## do_already_drafted {#do_already_drafted}

HTTP `409` · ใบส่งของนี้อยู่ในใบแจ้งหนี้อื่นแล้ว

พบใน: [`POST /v1/invoices/preview`](ref-invoices.md#post-invoices-preview), [`POST /v1/invoices`](ref-invoices.md#post-invoices), [`PUT /v1/invoices/external/{externalId}`](ref-invoices.md#put-invoices-external-externalId), [`POST /v1/invoices/{id}/delivery-orders`](ref-invoices.md#post-invoices-id-delivery-orders), [`POST /v1/invoices/{id}/delivery-orders/move`](ref-invoices.md#post-invoices-id-delivery-orders-move)

## do_in_invoice {#do_in_invoice}

HTTP `409` · ใบส่งของนี้อยู่ในใบแจ้งหนี้แล้ว — แก้ที่ใบแจ้งหนี้ หรือถอดออกจากร่างก่อน

อยู่ใน `errors[].code` ของ `409 invalid_state_transition`

## do_released {#do_released}

HTTP `409` · ใบส่งของนี้ส่งบัญชีแล้ว — แก้จุดแวะ/ยอดส่งจริงไม่ได้ ให้ฝ่ายวางบิลย้อนการส่งบัญชีก่อน

อยู่ใน `errors[].code` ของ `409 invalid_state_transition`

## document_email_pending {#document_email_pending}

HTTP `409` · เอกสารนี้กำลังรอส่งถึงผู้รับเดิมอยู่ — รอสักครู่แล้วตรวจสถานะการส่ง

พบใน: [`POST /v1/invoices/{id}/send`](ref-invoices.md#post-invoices-id-send), [`POST /v1/billing-notes/{id}/send`](ref-billing-notes.md#post-billing-notes-id-send)

## duplicate {#duplicate}

HTTP `409` · ข้อมูลซ้ำกับที่มีอยู่

พบใน: [`POST /v1/documents`](ref-documents.md#post-documents), [`PUT /v1/customers/external/{externalId}`](ref-customers.md#put-customers-external-externalId), [`PATCH /v1/customers/external/{externalId}`](ref-customers.md#patch-customers-external-externalId), [`PUT /v1/customer-sites/external/{externalId}`](ref-customer-sites.md#put-customer-sites-external-externalId), [`PATCH /v1/customer-sites/external/{externalId}`](ref-customer-sites.md#patch-customer-sites-external-externalId), [`PUT /v1/routes/external/{externalId}`](ref-routes.md#put-routes-external-externalId), [`PATCH /v1/routes/external/{externalId}`](ref-routes.md#patch-routes-external-externalId), [`PUT /v1/products/external/{externalId}`](ref-products.md#put-products-external-externalId), [`PATCH /v1/products/external/{externalId}`](ref-products.md#patch-products-external-externalId), [`PUT /v1/vehicle-types/external/{externalId}`](ref-vehicle-types.md#put-vehicle-types-external-externalId), [`PATCH /v1/vehicle-types/external/{externalId}`](ref-vehicle-types.md#patch-vehicle-types-external-externalId), [`PUT /v1/service-items/external/{externalId}`](ref-service-items.md#put-service-items-external-externalId) และอีก 11 endpoint

## external_id_conflict {#external_id_conflict}

HTTP `409` · เลขอ้างอิงต้นทางนี้ถูกใช้กับใบสั่งขนส่งจากช่องทางอื่นแล้ว

พบใน: [`POST /v1/orders`](ref-orders.md#post-orders), [`PUT /v1/orders/external/{externalId}`](ref-orders.md#put-orders-external-externalId), [`PATCH /v1/orders/external/{externalId}`](ref-orders.md#patch-orders-external-externalId)

## idempotency_in_progress {#idempotency_in_progress}

HTTP `409` · คำขอเดียวกันกำลังประมวลผลอยู่

พบใน: [`POST /v1/orders:bulk`](ref-orders.md#post-orders-bulk), [`POST /v1/orders`](ref-orders.md#post-orders), [`POST /v1/trips`](ref-trips.md#post-trips), [`POST /v1/trips/{id}/schedule`](ref-trips.md#post-trips-id-schedule), [`POST /v1/trips/{id}/attach`](ref-trips.md#post-trips-id-attach), [`POST /v1/trips/{id}/detach`](ref-trips.md#post-trips-id-detach), [`POST /v1/trips/{id}/reorder-stops`](ref-trips.md#post-trips-id-reorder-stops), [`POST /v1/trips/{id}/assign`](ref-trips.md#post-trips-id-assign), [`POST /v1/trips/{id}/offer`](ref-trips.md#post-trips-id-offer), [`POST /v1/trips/{id}/dispatch`](ref-trips.md#post-trips-id-dispatch), [`POST /v1/trips/{id}/confirm-rules`](ref-trips.md#post-trips-id-confirm-rules), [`POST /v1/trips/{id}/complete`](ref-trips.md#post-trips-id-complete) และอีก 56 endpoint

## import_expired {#import_expired}

HTTP `409` · ผลตรวจไฟล์หมดอายุแล้ว (24 ชั่วโมง) อัปโหลดไฟล์ใหม่

อาจตอบได้จากหลาย endpoint

## import_has_errors {#import_has_errors}

HTTP `409` · ไฟล์มีแถวที่ตรวจไม่ผ่าน — แก้ไฟล์หรือเลือกนำเข้าเฉพาะแถวที่ผ่าน

อาจตอบได้จากหลาย endpoint

## in_use {#in_use}

HTTP `409` · ลบไม่ได้ เพราะมีเอกสารหรือข้อมูลอื่นอ้างถึงแล้ว — ใช้ "ปิดใช้" แทน

อาจตอบได้จากหลาย endpoint

## in_use_active {#in_use_active}

HTTP `409` · ปิดใช้ไม่ได้ เพราะยังมีข้อมูลที่ใช้งานอยู่อ้างถึง

อาจตอบได้จากหลาย endpoint

## inbound_not_supported {#inbound_not_supported}

HTTP `409` · ระบบบัญชีนี้ไม่รองรับการส่งข้อมูลเข้ามาทาง webhook

อาจตอบได้จากหลาย endpoint

## invalid_state_transition {#invalid_state_transition}

HTTP `409` · ทำรายการนี้ไม่ได้ในสถานะปัจจุบัน

พบใน: [`PUT /v1/documents/{id}/content`](ref-documents.md#put-documents-id-content), [`POST /v1/orders`](ref-orders.md#post-orders), [`PUT /v1/orders/external/{externalId}`](ref-orders.md#put-orders-external-externalId), [`PATCH /v1/orders/external/{externalId}`](ref-orders.md#patch-orders-external-externalId), [`PATCH /v1/orders/{id}`](ref-orders.md#patch-orders-id), [`POST /v1/orders/{id}/cancel`](ref-orders.md#post-orders-id-cancel), [`POST /v1/orders/{id}/stops/{sequence}/map-site`](ref-orders.md#post-orders-id-stops-sequence-map-site), [`POST /v1/orders/{id}/reevaluate`](ref-orders.md#post-orders-id-reevaluate), [`POST /v1/orders/{id}/manual-price`](ref-orders.md#post-orders-id-manual-price), [`POST /v1/orders/{id}/resolve-source-error`](ref-orders.md#post-orders-id-resolve-source-error), [`POST /v1/orders/{id}/map-customer`](ref-orders.md#post-orders-id-map-customer), [`POST /v1/reconcile-results/{id}/acknowledge`](ref-connectors.md#post-reconcile-results-id-acknowledge) และอีก 72 endpoint

## invoice_already_billed {#invoice_already_billed}

HTTP `409` · ใบแจ้งหนี้นี้อยู่ในใบวางบิลอื่นแล้ว

พบใน: [`POST /v1/billing-notes`](ref-billing-notes.md#post-billing-notes), [`PATCH /v1/billing-notes/{id}`](ref-billing-notes.md#patch-billing-notes-id), [`POST /v1/billing-notes/{id}/finalize`](ref-billing-notes.md#post-billing-notes-id-finalize)

## invoice_has_payments {#invoice_has_payments}

HTTP `409` · ใบแจ้งหนี้นี้รับชำระแล้ว ยกเลิกไม่ได้ — กลับรายการรับชำระก่อน

พบใน: [`POST /v1/invoices/{id}/void`](ref-invoices.md#post-invoices-id-void)

## invoice_not_billable {#invoice_not_billable}

HTTP `409` · ใบแจ้งหนี้นี้ยังไม่ออกหรือไม่มียอดค้าง ใส่ในใบวางบิลไม่ได้

พบใน: [`POST /v1/billing-notes`](ref-billing-notes.md#post-billing-notes), [`PATCH /v1/billing-notes/{id}`](ref-billing-notes.md#patch-billing-notes-id), [`POST /v1/billing-notes/{id}/finalize`](ref-billing-notes.md#post-billing-notes-id-finalize)

## invoice_not_finalizable {#invoice_not_finalizable}

HTTP `409` · ยังออกเอกสารใบแจ้งหนี้นี้ไม่ได้

พบใน: [`POST /v1/invoices/{id}/finalize`](ref-invoices.md#post-invoices-id-finalize)

## invoice_not_payable {#invoice_not_payable}

HTTP `409` · ใบแจ้งหนี้นี้รับชำระไม่ได้ในสถานะปัจจุบัน

พบใน: [`POST /v1/payments`](ref-payments.md#post-payments)

## invoice_on_billing_note {#invoice_on_billing_note}

HTTP `409` · ใบแจ้งหนี้นี้อยู่ในใบวางบิลที่ออกแล้ว ยกเลิกไม่ได้ — ยกเลิกใบวางบิลก่อน

พบใน: [`POST /v1/invoices/{id}/void`](ref-invoices.md#post-invoices-id-void)

## invoice_pdf_template_changed {#invoice_pdf_template_changed}

HTTP `409` · แม่แบบเอกสารเปลี่ยนหลังวันออก สร้าง PDF ของใบนี้ใหม่ไม่ได้ — ติดต่อผู้ดูแลระบบ

พบใน: [`POST /v1/invoices/{id}/send`](ref-invoices.md#post-invoices-id-send), [`GET /v1/billing-notes/{id}/pdf`](ref-billing-notes.md#get-billing-notes-id-pdf), [`GET /v1/billing-notes/{id}/pdf-bundle`](ref-billing-notes.md#get-billing-notes-id-pdf-bundle), [`POST /v1/billing-notes/{id}/send`](ref-billing-notes.md#post-billing-notes-id-send)

## invoice_sent_to_customer {#invoice_sent_to_customer}

HTTP `409` · ใบแจ้งหนี้นี้ส่งลูกค้าแล้ว ยกเลิกไม่ได้

อาจตอบได้จากหลาย endpoint

## master_sync_failed {#master_sync_failed}

HTTP `409` · ดึงผังรหัสจากระบบบัญชีไม่สำเร็จ ตรวจการเชื่อมต่อแล้วลองใหม่

อาจตอบได้จากหลาย endpoint

## master_sync_not_supported {#master_sync_not_supported}

HTTP `409` · ระบบบัญชีนี้ดึงผังรหัสอัตโนมัติไม่ได้ นำเข้าจากไฟล์แทน

อาจตอบได้จากหลาย endpoint

## not_ready_to_bill {#not_ready_to_bill}

HTTP `409` · ใบส่งของนี้ยังไม่พร้อมวางบิล

พบใน: [`POST /v1/invoices/preview`](ref-invoices.md#post-invoices-preview), [`POST /v1/invoices`](ref-invoices.md#post-invoices), [`PUT /v1/invoices/external/{externalId}`](ref-invoices.md#put-invoices-external-externalId), [`POST /v1/invoices/{id}/delivery-orders`](ref-invoices.md#post-invoices-id-delivery-orders), [`POST /v1/invoices/{id}/delivery-orders/move`](ref-invoices.md#post-invoices-id-delivery-orders-move), [`POST /v1/delivery-orders/{id}/release`](ref-delivery-orders.md#post-delivery-orders-id-release)

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

HTTP `409` · แก้ข้อมูลนี้ของใบสั่งขนส่งไม่ได้ในสถานะปัจจุบัน (วางแผน ออกรถ ปิดงาน หรือยกเลิกแล้ว)

พบใน: [`POST /v1/orders`](ref-orders.md#post-orders), [`PUT /v1/orders/external/{externalId}`](ref-orders.md#put-orders-external-externalId), [`PATCH /v1/orders/external/{externalId}`](ref-orders.md#patch-orders-external-externalId), [`PATCH /v1/orders/{id}`](ref-orders.md#patch-orders-id), [`POST /v1/orders/{id}/stops/{sequence}/map-site`](ref-orders.md#post-orders-id-stops-sequence-map-site), [`POST /v1/orders/{id}/reevaluate`](ref-orders.md#post-orders-id-reevaluate), [`POST /v1/orders/{id}/manual-price`](ref-orders.md#post-orders-id-manual-price), [`POST /v1/orders/{id}/resolve-source-error`](ref-orders.md#post-orders-id-resolve-source-error), [`POST /v1/orders/{id}/map-customer`](ref-orders.md#post-orders-id-map-customer), [`POST /v1/orders/{id}/revenue-lines`](ref-orders.md#post-orders-id-revenue-lines), [`POST /v1/revenue-lines/{id}/void`](ref-orders.md#post-revenue-lines-id-void)

## order_not_ready_for_delivery {#order_not_ready_for_delivery}

HTTP `409` · ยังสร้างใบส่งของจากใบสั่งขนส่งนี้ไม่ได้ (ร่าง ยกเลิก วางแผนแล้ว หรือยังจับคู่ลูกค้า/สถานที่ไม่ครบ)

พบใน: [`POST /v1/trips`](ref-trips.md#post-trips), [`POST /v1/trips/{id}/attach`](ref-trips.md#post-trips-id-attach)

## order_on_trip {#order_on_trip}

HTTP `409` · ใบสั่งขนส่งนี้มีใบส่งของอยู่ในเที่ยวรถ — ถอดออกจากเที่ยวก่อน

พบใน: [`POST /v1/orders/{id}/cancel`](ref-orders.md#post-orders-id-cancel), [`POST /v1/orders/{id}/source-changes/{changeId}/accept`](ref-orders.md#post-orders-id-source-changes-changeId-accept), [`POST /v1/orders/{id}/source-changes/{changeId}/reject`](ref-orders.md#post-orders-id-source-changes-changeId-reject)

## order_source_change_pending {#order_source_change_pending}

HTTP `409` · ต้นทางแก้ใบสั่งขนส่งนี้หลังวางแผน — เลือกรับค่าต้นทางหรือใช้ค่า TMS ก่อนจัดลงเที่ยว

อาจตอบได้จากหลาย endpoint

## payment_exceeds_outstanding {#payment_exceeds_outstanding}

HTTP `409` · ยอดตัดหนี้เกินยอดคงค้าง

พบใน: [`POST /v1/payments`](ref-payments.md#post-payments)

## pod_exists {#pod_exists}

HTTP `409` · ส่ง POD ของใบส่งของนี้แล้ว

อาจตอบได้จากหลาย endpoint

## pod_not_allowed {#pod_not_allowed}

HTTP `409` · บันทึกหลักฐานส่งของใบส่งของนี้ไม่ได้ในสถานะปัจจุบัน

พบใน: [`PUT /v1/delivery-orders/{id}/pod`](ref-delivery-orders.md#put-delivery-orders-id-pod)

## queue_action_not_allowed {#queue_action_not_allowed}

HTTP `409` · ทำรายการนี้กับคำสั่งนี้ไม่ได้ (จัดการไปแล้ว หรือไม่ใช่รายการที่ล้มเหลว หรือต้องทำในระบบบัญชีเอง)

อาจตอบได้จากหลาย endpoint

## sandbox_finalize_disabled {#sandbox_finalize_disabled}

HTTP `409` · โหมดทดสอบ (sandbox) ยังออกเลขใบแจ้งหนี้ไม่ได้

อาจตอบได้จากหลาย endpoint

## saved_view_limit {#saved_view_limit}

HTTP `409` · บันทึกได้สูงสุด 50 มุมมองต่อหน้า

อาจตอบได้จากหลาย endpoint

## seat_limit_reached {#seat_limit_reached}

HTTP `409` · จำนวนผู้ใช้ครบตามแพ็กเกจแล้ว

อาจตอบได้จากหลาย endpoint

## secret_unreadable {#secret_unreadable}

HTTP `409` · อ่านข้อมูลลับเดิมไม่ได้ (กุญแจเข้ารหัสเดิมถูกถอดออกแล้ว) — กรอกเลขใหม่แทน

อาจตอบได้จากหลาย endpoint

## settlement_carrier_type_missing {#settlement_carrier_type_missing}

HTTP `409` · ข้อมูลรถร่วมในใบสำคัญจ่ายไม่มีประเภท (บุคคลธรรมดา/นิติบุคคล) คำนวณหัก ณ ที่จ่ายไม่ได้ — ยกเลิกใบแล้วสร้างใหม่

อาจตอบได้จากหลาย endpoint

## settlement_disputed {#settlement_disputed}

HTTP `409` · มีรายการโต้แย้งที่ยังไม่เคลียร์ อนุมัติไม่ได้ — ยืนยันยอดเดิมพร้อมเหตุผล หรือเรียกใบกลับมาแก้รายการ

อาจตอบได้จากหลาย endpoint

## settlement_empty {#settlement_empty}

HTTP `409` · ใบสำคัญจ่ายยังไม่มีรายการเที่ยว อนุมัติไม่ได้

พบใน: [`POST /v1/settlements/{id}/send-to-carrier`](ref-settlements.md#post-settlements-id-send-to-carrier)

## settlement_line_resolved {#settlement_line_resolved}

HTTP `409` · บริษัทยืนยันยอดของรายการนี้แล้ว ตอบรายการนี้ไม่ได้อีก

อาจตอบได้จากหลาย endpoint

## settlement_net_negative {#settlement_net_negative}

HTTP `409` · ยอดสุทธิติดลบ อนุมัติไม่ได้ — นำรายการหักส่วนเกินออกแล้วยกไปงวดถัดไป

พบใน: [`POST /v1/settlements/{id}/send-to-carrier`](ref-settlements.md#post-settlements-id-send-to-carrier)

## settlement_review_required {#settlement_review_required}

HTTP `409` · ต้องส่งให้รถร่วมตรวจก่อนอนุมัติ (ตั้งค่าบริษัท)

อาจตอบได้จากหลาย endpoint

## sor_locked {#sor_locked}

HTTP `409` · เปลี่ยนเจ้าของเอกสารไม่ได้ เพราะมีเอกสารส่งหรือรอส่งเข้าระบบบัญชีแล้ว — ยกเลิกการเชื่อมแล้วตั้งใหม่

อาจตอบได้จากหลาย endpoint

## source_change_not_pending {#source_change_not_pending}

HTTP `409` · การเปลี่ยนแปลงจากต้นทางชุดนี้ถูกตัดสินไปแล้ว หรือมีชุดใหม่มาแทน — โหลดใหม่

พบใน: [`POST /v1/orders/{id}/source-changes/{changeId}/accept`](ref-orders.md#post-orders-id-source-changes-changeId-accept), [`POST /v1/orders/{id}/source-changes/{changeId}/reject`](ref-orders.md#post-orders-id-source-changes-changeId-reject)

## stop_already_closed {#stop_already_closed}

HTTP `409` · จุดนี้ถูกปิดแล้ว — ส่ง POD ของ DO นี้ได้

อาจตอบได้จากหลาย endpoint

## stop_event_already_resolved {#stop_event_already_resolved}

HTTP `409` · เหตุการณ์นี้ถูกตัดสินไปแล้ว

พบใน: [`POST /v1/stop-event-flags/{id}/resolve`](ref-stops.md#post-stop-event-flags-id-resolve)

## stop_event_duplicate {#stop_event_duplicate}

HTTP `409` · clientEventId นี้ถูกใช้กับ event อื่นแล้ว

พบใน: [`POST /v1/stops/{id}/arrive`](ref-stops.md#post-stops-id-arrive), [`POST /v1/stops/{id}/depart`](ref-stops.md#post-stops-id-depart), [`POST /v1/stops/{id}/complete`](ref-stops.md#post-stops-id-complete), [`POST /v1/stops/{id}/fail`](ref-stops.md#post-stops-id-fail)

## stop_event_not_flagged {#stop_event_not_flagged}

HTTP `409` · เหตุการณ์นี้ไม่มีข้อขัดแย้งให้ตัดสิน

พบใน: [`POST /v1/stop-event-flags/{id}/resolve`](ref-stops.md#post-stop-event-flags-id-resolve)

## stop_not_arrived {#stop_not_arrived}

HTTP `409` · ยังไม่ได้บันทึกถึงจุดนี้

อาจตอบได้จากหลาย endpoint

## stop_not_ready {#stop_not_ready}

HTTP `409` · ปิดงานจุดก่อนหน้าก่อน

อาจตอบได้จากหลาย endpoint

## stop_skipped {#stop_skipped}

HTTP `409` · จุดนี้ไม่มีใบส่งของแล้ว (นัดส่งใหม่ไปเที่ยวอื่น) — ไม่ต้องบันทึกที่จุดนี้

อาจตอบได้จากหลาย endpoint

## tax_document_owned_by_erp {#tax_document_owned_by_erp}

HTTP `409` · นิติบุคคลนี้ให้ระบบบัญชีเป็นผู้ออกใบกำกับภาษี — TMS ออกได้เฉพาะใบแจ้งหนี้/ใบวางบิล

อาจตอบได้จากหลาย endpoint

## tenant_selection_required {#tenant_selection_required}

HTTP `409` · อีเมลนี้เป็นสมาชิกหลายบริษัท เลือกบริษัทที่ต้องการเข้า

อาจตอบได้จากหลาย endpoint

## trip_cost_already_settled {#trip_cost_already_settled}

HTTP `409` · บรรทัดต้นทุนนี้อยู่ในใบสำคัญจ่ายอื่นแล้ว — จ่ายซ้ำไม่ได้

พบใน: [`POST /v1/settlements`](ref-settlements.md#post-settlements), [`POST /v1/settlements/{id}/lines`](ref-settlements.md#post-settlements-id-lines)

## trip_cost_not_payable {#trip_cost_not_payable}

HTTP `409` · เที่ยวหรือบรรทัดต้นทุนนี้ยังไม่อยู่ในคิวจ่ายของรถร่วมรายนี้ (ต้องปิดต้นทุนแล้ว หลักฐานส่งครบตามเงื่อนไข และเป็นของรถร่วมรายนี้)

พบใน: [`POST /v1/settlements`](ref-settlements.md#post-settlements), [`POST /v1/settlements/{id}/lines`](ref-settlements.md#post-settlements-id-lines)

## trip_costing_unavailable {#trip_costing_unavailable}

HTTP `409` · ปิดต้นทุนเที่ยวถูกปิดใช้ชั่วคราวโดยผู้ดูแลระบบ

พบใน: [`POST /v1/trips/{id}/cost`](ref-trips.md#post-trips-id-cost)

## trip_costs_incomplete {#trip_costs_incomplete}

HTTP `409` · ต้นทุนเที่ยวยังไม่ครบ — ยืนยัน/ปฏิเสธค่าใช้จ่ายหน้างานที่รอ ตรวจค่าจ้างรถร่วม และรายได้ของใบส่งของ (ใช้ปันต้นทุน) ก่อนปิดต้นทุน

พบใน: [`POST /v1/trips/{id}/cost`](ref-trips.md#post-trips-id-cost)

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

## two_factor_not_enabled {#two_factor_not_enabled}

HTTP `409` · ยังไม่ได้ตั้งการยืนยันตัวตน 2 ชั้น

อาจตอบได้จากหลาย endpoint

## webhook_limit_reached {#webhook_limit_reached}

HTTP `409` · จำนวน webhook endpoint ครบตามแพ็กเกจแล้ว

อาจตอบได้จากหลาย endpoint

## precondition_failed {#precondition_failed}

HTTP `412` · ข้อมูลถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดใหม่

พบใน: [`PUT /v1/customers/external/{externalId}`](ref-customers.md#put-customers-external-externalId), [`PATCH /v1/customers/external/{externalId}`](ref-customers.md#patch-customers-external-externalId), [`PATCH /v1/customers/{id}`](ref-customers.md#patch-customers-id), [`POST /v1/customers/{id}/deactivate`](ref-customers.md#post-customers-id-deactivate), [`POST /v1/customers/{id}/activate`](ref-customers.md#post-customers-id-activate), [`POST /v1/customers/{id}/delete`](ref-customers.md#post-customers-id-delete), [`PUT /v1/orders/external/{externalId}`](ref-orders.md#put-orders-external-externalId), [`PATCH /v1/orders/external/{externalId}`](ref-orders.md#patch-orders-external-externalId), [`PATCH /v1/orders/{id}`](ref-orders.md#patch-orders-id), [`POST /v1/orders/{id}/cancel`](ref-orders.md#post-orders-id-cancel), [`POST /v1/orders/{id}/source-changes/{changeId}/accept`](ref-orders.md#post-orders-id-source-changes-changeId-accept), [`POST /v1/orders/{id}/source-changes/{changeId}/reject`](ref-orders.md#post-orders-id-source-changes-changeId-reject) และอีก 140 endpoint

## payload_too_large {#payload_too_large}

HTTP `413` · ไฟล์หรือข้อมูลมีขนาดใหญ่เกินกำหนด

พบใน: [`POST /v1/orders:bulk`](ref-orders.md#post-orders-bulk), [`POST /v1/orders`](ref-orders.md#post-orders), [`PUT /v1/orders/external/{externalId}`](ref-orders.md#put-orders-external-externalId), [`PATCH /v1/orders/external/{externalId}`](ref-orders.md#patch-orders-external-externalId), [`PATCH /v1/orders/{id}`](ref-orders.md#patch-orders-id)

## branch_unavailable {#branch_unavailable}

HTTP `422` · นิติบุคคลออกบิลยังไม่มีสาขาที่ออกเอกสาร

อยู่ใน `errors[].code` ของ `422 validation_failed` (`errors[].field` = ช่องที่ต้องแก้)

## company_unavailable {#company_unavailable}

HTTP `422` · นิติบุคคลออกบิลไม่พบหรือปิดใช้อยู่

อยู่ใน `errors[].code` ของ `422 validation_failed` (`errors[].field` = ช่องที่ต้องแก้)

## document_email_no_recipient {#document_email_no_recipient}

HTTP `422` · ลูกค้ายังไม่มีอีเมลผู้ติดต่อ — เพิ่มอีเมลในข้อมูลลูกค้า หรือดาวน์โหลด PDF แล้วส่งเอง

พบใน: [`POST /v1/invoices/{id}/send`](ref-invoices.md#post-invoices-id-send), [`POST /v1/billing-notes/{id}/send`](ref-billing-notes.md#post-billing-notes-id-send)

## email_attachment_too_large {#email_attachment_too_large}

HTTP `422` · ไฟล์ใหญ่เกินกว่าจะส่งทางอีเมล — ดาวน์โหลด PDF แล้วส่งเอง

พบใน: [`POST /v1/invoices/{id}/send`](ref-invoices.md#post-invoices-id-send), [`POST /v1/billing-notes/{id}/send`](ref-billing-notes.md#post-billing-notes-id-send)

## idempotency_mismatch {#idempotency_mismatch}

HTTP `422` · Idempotency-Key นี้เคยใช้กับข้อมูลอื่น

พบใน: [`POST /v1/orders:bulk`](ref-orders.md#post-orders-bulk), [`GET /v1/orders`](ref-orders.md#get-orders), [`POST /v1/orders`](ref-orders.md#post-orders), [`PUT /v1/orders/external/{externalId}`](ref-orders.md#put-orders-external-externalId), [`PATCH /v1/orders/external/{externalId}`](ref-orders.md#patch-orders-external-externalId), [`PATCH /v1/orders/{id}`](ref-orders.md#patch-orders-id), [`POST /v1/orders/{id}/stops/{sequence}/map-site`](ref-orders.md#post-orders-id-stops-sequence-map-site), [`POST /v1/orders/{id}/manual-price`](ref-orders.md#post-orders-id-manual-price), [`POST /v1/orders/{id}/resolve-source-error`](ref-orders.md#post-orders-id-resolve-source-error), [`POST /v1/orders/{id}/map-customer`](ref-orders.md#post-orders-id-map-customer), [`POST /v1/delivery-orders/{id}/revert-delivery`](ref-delivery-orders.md#post-delivery-orders-id-revert-delivery), [`GET /v1/trips`](ref-trips.md#get-trips) และอีก 91 endpoint

## pod_incomplete {#pod_incomplete}

HTTP `422` · หลักฐานการส่ง (POD) ยังไม่ครบตามที่ลูกค้ากำหนด

พบใน: [`PUT /v1/delivery-orders/{id}/pod`](ref-delivery-orders.md#put-delivery-orders-id-pod)

## routing_not_configured {#routing_not_configured}

HTTP `422` · บริษัทมีหลายนิติบุคคลแต่ยังไม่ได้กำหนดนิติบุคคลออกบิล — ส่ง billingCompanyId (จาก GET /v1/companies) หรือตั้ง "ออกบิลในนาม" ที่ลูกค้า/ค่าตั้งต้นของบริษัท

อยู่ใน `errors[].code` ของ `422 validation_failed` (`errors[].field` = ช่องที่ต้องแก้)

## sor_fixed {#sor_fixed}

HTTP `422` · ระบบบัญชีนี้เป็นผู้ออกเอกสารภาษีเสมอ เปลี่ยนไม่ได้

อาจตอบได้จากหลาย endpoint

## sor_not_chosen {#sor_not_chosen}

HTTP `422` · เลือก "ใครออกเลขเอกสาร" ก่อนเปิดการส่งเอกสารเข้าระบบบัญชี

อาจตอบได้จากหลาย endpoint

## stop_order_invalid {#stop_order_invalid}

HTTP `422` · ลำดับจุดไม่ถูกต้อง — จุดส่งของใบส่งของต้องอยู่หลังจุดรับของใบเดียวกัน

พบใน: [`POST /v1/trips/{id}/reorder-stops`](ref-trips.md#post-trips-id-reorder-stops)

## validation_failed {#validation_failed}

HTTP `422` · ข้อมูลไม่ถูกต้อง

พบใน: [`POST /v1/exports`](ref-exports.md#post-exports), [`GET /v1/search`](ref-search.md#get-search), [`GET /v1/companies`](ref-companies.md#get-companies), [`GET /v1/branches`](ref-branches.md#get-branches), [`GET /v1/audit-logs`](ref-audit.md#get-audit-logs), [`POST /v1/documents`](ref-documents.md#post-documents), [`PUT /v1/documents/{id}/content`](ref-documents.md#put-documents-id-content), [`GET /v1/customers`](ref-customers.md#get-customers), [`POST /v1/customers`](ref-customers.md#post-customers), [`GET /v1/customers/export`](ref-customers.md#get-customers-export), [`PUT /v1/customers/external/{externalId}`](ref-customers.md#put-customers-external-externalId), [`PATCH /v1/customers/external/{externalId}`](ref-customers.md#patch-customers-external-externalId) และอีก 294 endpoint

## webhook_event_expired {#webhook_event_expired}

HTTP `422` · event เกิน 30 วันแล้ว ส่งซ้ำไม่ได้

อาจตอบได้จากหลาย endpoint

## webhook_event_not_subscribed {#webhook_event_not_subscribed}

HTTP `422` · endpoint นี้ไม่ได้สมัคร event ชนิดนี้

อาจตอบได้จากหลาย endpoint

## webhook_not_retryable {#webhook_not_retryable}

HTTP `422` · ส่งซ้ำรายการนี้ไม่ได้ (event ทดสอบ) ใช้ "ส่ง event ทดสอบ" แทน

อาจตอบได้จากหลาย endpoint

## account_locked {#account_locked}

HTTP `429` · ใส่รหัสผ่านผิดหลายครั้ง ลองใหม่อีกครั้งใน 15 นาที

อาจตอบได้จากหลาย endpoint

## rate_limited {#rate_limited}

HTTP `429` · เรียกถี่เกินไป

พบใน: [`POST /v1/invoices/{id}/send`](ref-invoices.md#post-invoices-id-send), [`POST /v1/billing-notes/{id}/send`](ref-billing-notes.md#post-billing-notes-id-send)

## internal_error {#internal_error}

HTTP `500` · ระบบขัดข้อง

อาจตอบได้จากหลาย endpoint

## trip_cost_allocation_failed {#trip_cost_allocation_failed}

HTTP `500` · ปันต้นทุนเที่ยวลงใบส่งของไม่ลงตัว — ยังไม่ปิดต้นทุน กรุณาแจ้งผู้ดูแลระบบ

อาจตอบได้จากหลาย endpoint

## pdf_render_timeout {#pdf_render_timeout}

HTTP `503` · สร้าง PDF ไม่ทันเวลา กรุณาลองใหม่อีกครั้ง

อาจตอบได้จากหลาย endpoint

## service_busy {#service_busy}

HTTP `503` · ระบบกำลังมีผู้ใช้งานมาก กรุณาลองใหม่อีกครั้ง

อาจตอบได้จากหลาย endpoint
