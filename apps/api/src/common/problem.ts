import { HttpException } from '@nestjs/common';

/**
 * Catalog ของ error `code` (คงที่ ห้ามเปลี่ยนชื่อ — ลูกค้าและ UI ผูกกับค่าเหล่านี้)
 * RFC 9457 application/problem+json (docs/01 §5.1)
 */
export const PROBLEMS = {
  validation_failed: { status: 422, th: 'ข้อมูลไม่ถูกต้อง', en: 'Validation failed' },
  bad_request: { status: 400, th: 'คำขอไม่ถูกต้อง', en: 'Bad request' },
  /** ST7-T07: header X-Api-Version ผิดรูปแบบ / ก่อนเวอร์ชันแรก / วันในอนาคต (`reason`: format | before_first | future) */
  invalid_api_version: {
    status: 400,
    th: 'X-Api-Version ไม่ถูกต้อง (ต้องเป็นวันที่ YYYY-MM-DD)',
    en: 'Invalid X-Api-Version (expected a YYYY-MM-DD date)',
  },
  unauthorized: { status: 401, th: 'ต้องเข้าสู่ระบบ', en: 'Authentication required' },
  forbidden: { status: 403, th: 'ไม่มีสิทธิ์ทำรายการนี้', en: 'Forbidden' },
  not_found: { status: 404, th: 'ไม่พบข้อมูล', en: 'Not found' },
  method_not_allowed: { status: 405, th: 'ไม่รองรับวิธีเรียกนี้', en: 'Method not allowed' },
  conflict: { status: 409, th: 'ข้อมูลขัดแย้งกับที่มีอยู่', en: 'Conflict' },
  /** deadlock / serialization failure ของฐานข้อมูล (40P01/40001, Prisma P2034) — ลองส่งใหม่ได้ (มี Retry-After) */
  concurrent_update: {
    status: 409,
    th: 'มีการแก้ไขข้อมูลเดียวกันพร้อมกัน กรุณาลองใหม่อีกครั้ง',
    en: 'Concurrent update — please retry',
  },
  duplicate: { status: 409, th: 'ข้อมูลซ้ำกับที่มีอยู่', en: 'Duplicate' },
  invalid_state_transition: {
    status: 409,
    th: 'ทำรายการนี้ไม่ได้ในสถานะปัจจุบัน',
    en: 'Invalid state transition',
  },
  idempotency_in_progress: {
    status: 409,
    th: 'คำขอเดียวกันกำลังประมวลผลอยู่',
    en: 'Request with this Idempotency-Key is in progress',
  },
  precondition_failed: {
    status: 412,
    th: 'ข้อมูลถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดใหม่',
    en: 'Precondition failed (version mismatch)',
  },
  idempotency_mismatch: {
    status: 422,
    th: 'Idempotency-Key นี้เคยใช้กับข้อมูลอื่น',
    en: 'Idempotency-Key reused with a different request body',
  },
  mfa_required: {
    status: 401,
    th: 'กรอกรหัสยืนยันตัวตน 2 ชั้นจากแอป Authenticator',
    en: 'Enter the code from your authenticator app',
  },
  mfa_enrollment_required: {
    status: 401,
    th: 'บัญชีนี้ต้องตั้งการยืนยันตัวตน 2 ชั้นก่อนเข้าใช้งาน',
    en: 'Set up two-factor authentication to continue',
  },
  mfa_expired: {
    status: 401,
    th: 'หมดเวลายืนยันตัวตน เข้าสู่ระบบใหม่อีกครั้ง',
    en: 'Verification expired, sign in again',
  },
  invalid_otp: {
    status: 401,
    th: 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุ',
    en: 'Invalid or expired code',
  },
  step_up_required: {
    status: 403,
    th: 'ยืนยันตัวตน 2 ชั้นอีกครั้งก่อนทำรายการนี้',
    en: 'Confirm with two-factor authentication first',
  },
  two_factor_not_enabled: {
    status: 409,
    th: 'ยังไม่ได้ตั้งการยืนยันตัวตน 2 ชั้น',
    en: 'Two-factor authentication is not set up',
  },
  feature_not_in_plan: {
    status: 403,
    th: 'แพ็กเกจปัจจุบันยังไม่มีฟีเจอร์นี้',
    en: 'This feature is not included in your plan',
  },
  impersonation_read_only: {
    status: 403,
    th: 'กำลังเข้าใช้งานแทนแบบอ่านอย่างเดียว — แก้ไขข้อมูลไม่ได้',
    en: 'Impersonation is read-only',
  },
  permission_denied: {
    status: 403,
    th: 'ไม่มีสิทธิ์ทำรายการนี้',
    en: 'You do not have permission for this action',
  },
  /** ST4-T13 maker-checker: ผู้บันทึกยืนยัน/ปฏิเสธรายการของตัวเองไม่ได้ */
  self_approval_forbidden: {
    status: 403,
    th: 'ยืนยันหรือปฏิเสธรายการที่ตัวเองบันทึกไม่ได้ ต้องให้ผู้อื่นตรวจ',
    en: 'You cannot approve or reject a line you recorded',
  },
  payload_too_large: {
    status: 413,
    th: 'ไฟล์หรือข้อมูลมีขนาดใหญ่เกินกำหนด',
    en: 'Payload too large',
  },
  rate_limited: { status: 429, th: 'เรียกถี่เกินไป', en: 'Too many requests' },
  /** ระบบ/ฐานข้อมูลรับงานไม่ทัน (connection pool เต็ม, เริ่ม transaction ไม่ทัน) — ไม่ใช่ความผิดของผู้เรียก ลองใหม่ได้ (มี Retry-After) */
  pdf_render_timeout: {
    status: 503,
    th: 'สร้าง PDF ไม่ทันเวลา กรุณาลองใหม่อีกครั้ง',
    en: 'PDF rendering timed out — please retry',
  },
  service_busy: {
    status: 503,
    th: 'ระบบกำลังมีผู้ใช้งานมาก กรุณาลองใหม่อีกครั้ง',
    en: 'Service busy — please retry',
  },
  invalid_credentials: {
    status: 401,
    th: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
    en: 'Invalid email or password',
  },
  account_locked: {
    status: 429,
    th: 'ใส่รหัสผ่านผิดหลายครั้ง ลองใหม่อีกครั้งใน 15 นาที',
    en: 'Too many failed attempts, try again in 15 minutes',
  },
  tenant_selection_required: {
    status: 409,
    th: 'อีเมลนี้เป็นสมาชิกหลายบริษัท เลือกบริษัทที่ต้องการเข้า',
    en: 'This account belongs to several organisations; choose one',
  },
  reset_link_invalid: {
    status: 400,
    th: 'ลิงก์ตั้งรหัสผ่านไม่ถูกต้อง หมดอายุ หรือใช้ไปแล้ว ขอลิงก์ใหม่อีกครั้ง',
    en: 'This reset link is invalid, expired or already used',
  },
  invitation_invalid: {
    status: 400,
    th: 'ลิงก์คำเชิญไม่ถูกต้อง หมดอายุ หรือใช้ไปแล้ว ขอให้ผู้ดูแลส่งคำเชิญใหม่',
    en: 'This invitation is invalid, expired or already used',
  },
  already_member: {
    status: 409,
    th: 'อีเมลนี้เป็นสมาชิกของบริษัทแล้ว',
    en: 'This email is already a member',
  },
  /** ST9-T11 มุมมองที่บันทึกไว้ครบ 50 ต่อหน้าต่อผู้ใช้ — มี `limit` */
  saved_view_limit: {
    status: 409,
    th: 'บันทึกได้สูงสุด 50 มุมมองต่อหน้า',
    en: 'At most 50 saved views per page',
  },
  /** ST7-T13 จำนวน connector ครบตามแพ็กเกจ (entitlement `conn`) — มี `limit` */
  connector_limit_reached: {
    status: 409,
    th: 'จำนวนการเชื่อมระบบบัญชีครบตามแพ็กเกจแล้ว',
    en: 'Connector limit of your plan reached',
  },
  /** ST7-T13 นิติบุคคลนี้ (หรือขอบเขต "ทุกนิติบุคคล") มี connector ที่ยังไม่ยกเลิกอยู่แล้ว */
  connector_scope_taken: {
    status: 409,
    th: 'นิติบุคคลนี้เชื่อมระบบบัญชีอยู่แล้ว ยกเลิกการเชื่อมเดิมก่อน',
    en: 'This legal entity already has a connector — disconnect it first',
  },
  /** ST7-T13 เปิดใช้ไม่ได้เพราะทดสอบการเชื่อมต่อไม่ผ่าน (spec/07 INT-015) — มี `errorClass`, `code` */
  /**
   * ST7-T17 นิติบุคคลนี้ให้ระบบบัญชี (ERP) เป็นเจ้าของเอกสารภาษี — TMS ออกเลขใบกำกับภาษีไม่ได้ (docs/01 §8.1)
   * มี `connectorId` — ออกได้เฉพาะใบแจ้งหนี้/ใบวางบิล
   */
  tax_document_owned_by_erp: {
    status: 409,
    th: 'นิติบุคคลนี้ให้ระบบบัญชีเป็นผู้ออกใบกำกับภาษี — TMS ออกได้เฉพาะใบแจ้งหนี้/ใบวางบิล',
    en: 'Tax documents for this legal entity are issued by the ERP — TMS issues invoices/billing notes only',
  },
  /** ST7-T17 ยังไม่ได้เลือกเจ้าของเอกสารภาษี — เปิดการส่งเอกสารภาษีไประบบบัญชีไม่ได้ (docs/01 §8.1 "ต้องเลือก") */
  sor_not_chosen: {
    status: 422,
    th: 'เลือก "ใครออกเลขเอกสาร" ก่อนเปิดการส่งเอกสารเข้าระบบบัญชี',
    en: 'Choose the tax document owner before enabling document push',
  },
  /** ST7-T17 เปลี่ยนเจ้าของข้อมูล/เอกสารภาษีไม่ได้หลังส่งเอกสารเข้าระบบบัญชีสำเร็จแล้ว (แบบ spec/07 INT-014) */
  sor_locked: {
    status: 409,
    th: 'เปลี่ยนเจ้าของเอกสารไม่ได้ เพราะมีเอกสารส่งหรือรอส่งเข้าระบบบัญชีแล้ว — ยกเลิกการเชื่อมแล้วตั้งใหม่',
    en: 'Ownership cannot change after documents were synced — disconnect and set up again',
  },
  /** ST7-T22 adapter ของ connector นี้ไม่รับ webhook ขาเข้า */
  inbound_not_supported: {
    status: 409,
    th: 'ระบบบัญชีนี้ไม่รองรับการส่งข้อมูลเข้ามาทาง webhook',
    en: 'This connector does not support inbound webhooks',
  },
  /** ST7-T18 adapter ของ connector นี้ดึงผังรหัสไม่ได้ — นำเข้าจากไฟล์แทน (import kind `erp_master_code`) */
  master_sync_not_supported: {
    status: 409,
    th: 'ระบบบัญชีนี้ดึงผังรหัสอัตโนมัติไม่ได้ นำเข้าจากไฟล์แทน',
    en: 'This connector cannot fetch master codes — import them from a file',
  },
  /** ST7-T18 ดึงผังรหัสจากระบบบัญชีไม่สำเร็จ (ไม่มีการเปลี่ยนแปลง) — มี `kind`, `message` */
  master_sync_failed: {
    status: 409,
    th: 'ดึงผังรหัสจากระบบบัญชีไม่สำเร็จ ตรวจการเชื่อมต่อแล้วลองใหม่',
    en: 'Fetching master codes from the connector failed — check the connection and retry',
  },
  connector_health_failed: {
    status: 409,
    th: 'ทดสอบการเชื่อมต่อไม่ผ่าน ตรวจค่าตั้งและ credential แล้วลองใหม่',
    en: 'Connection test failed — check settings and credentials',
  },
  /** ST7-T04 จำนวน webhook endpoint ครบตามแพ็กเกจ (entitlement `webhook`) — มี `limit` */
  webhook_limit_reached: {
    status: 409,
    th: 'จำนวน webhook endpoint ครบตามแพ็กเกจแล้ว',
    en: 'Webhook endpoint limit of your plan reached',
  },
  /** ST7-T05 ส่งซ้ำไม่ได้: event ทดสอบ/ยืนยันปลายทาง (ไม่มี event จริง) — ใช้ "ส่ง event ทดสอบ" แทน */
  webhook_not_retryable: {
    status: 422,
    th: 'ส่งซ้ำรายการนี้ไม่ได้ (event ทดสอบ) ใช้ "ส่ง event ทดสอบ" แทน',
    en: 'This delivery cannot be retried (test event) — send a test event instead',
  },
  /** ST7-T05 event เกิน 30 วัน — ส่งซ้ำด้วยมือได้ภายใน 30 วัน (INT-106) */
  webhook_event_expired: {
    status: 422,
    th: 'event เกิน 30 วันแล้ว ส่งซ้ำไม่ได้',
    en: 'The event is older than 30 days and can no longer be redelivered',
  },
  /** ST7-T05 redeliver ไปยัง endpoint ที่ไม่ได้สมัคร event ชนิดนี้ / event ไม่ใช่ event สาธารณะ */
  webhook_event_not_subscribed: {
    status: 422,
    th: 'endpoint นี้ไม่ได้สมัคร event ชนิดนี้',
    en: 'The endpoint is not subscribed to this event type',
  },
  seat_limit_reached: {
    status: 409,
    th: 'จำนวนผู้ใช้ครบตามแพ็กเกจแล้ว',
    en: 'User limit of your plan reached',
  },
  import_has_errors: {
    status: 409,
    th: 'ไฟล์มีแถวที่ตรวจไม่ผ่าน — แก้ไฟล์หรือเลือกนำเข้าเฉพาะแถวที่ผ่าน',
    en: 'The file has invalid rows — fix them or import valid rows only',
  },
  import_expired: {
    status: 409,
    th: 'ผลตรวจไฟล์หมดอายุแล้ว (24 ชั่วโมง) อัปโหลดไฟล์ใหม่',
    en: 'The validation result expired after 24 hours — upload the file again',
  },
  in_use: {
    status: 409,
    th: 'ลบไม่ได้ เพราะมีเอกสารหรือข้อมูลอื่นอ้างถึงแล้ว — ใช้ "ปิดใช้" แทน',
    en: 'Referenced by other records — deactivate it instead',
  },
  secret_unreadable: {
    status: 409,
    th: 'อ่านข้อมูลลับเดิมไม่ได้ (กุญแจเข้ารหัสเดิมถูกถอดออกแล้ว) — กรอกเลขใหม่แทน',
    en: 'Stored secret cannot be decrypted (retired key) — provide a new value',
  },
  in_use_active: {
    status: 409,
    th: 'ปิดใช้ไม่ได้ เพราะยังมีข้อมูลที่ใช้งานอยู่อ้างถึง',
    en: 'Cannot deactivate — still used by active records (see references)',
  },
  /** ORD-023 / docs/04 C: ทางเข้า (upsert) เขียนทับ SO ที่วางแผนแล้ว/ปิด/ยกเลิกไม่ได้ (หลังวางแผน = ST3-T10 เก็บ diff) */
  order_locked_for_update: {
    status: 409,
    th: 'แก้ข้อมูลนี้ของใบสั่งขนส่งไม่ได้ในสถานะปัจจุบัน (วางแผน ออกรถ ปิดงาน หรือยกเลิกแล้ว)',
    en: 'These order fields can no longer be changed in its current status',
  },
  /**
   * ST3-T08 (docs/04 C Edit lock): ผู้ใช้อื่นเปิดแก้ใบนี้อยู่ (ล็อกยังไม่หมดอายุ) — แก้ผ่าน PATCH/ขอล็อกไม่ได้
   * extension `editLock` = {userId, userName, acquiredAt, expiresAt}
   */
  order_locked_by_user: {
    status: 409,
    th: 'ใบสั่งขนส่งนี้กำลังถูกแก้ไขโดยผู้ใช้อื่น',
    en: 'This order is being edited by another user',
  },
  /**
   * ST3-T08 (QA): ล็อกการแก้ของผู้เรียกถูกผู้อื่นปลด (`orders:unlock`) — ต่ออายุ/บันทึกไม่ได้จนกว่าจะเปิดแก้ใหม่ (โหลดใหม่)
   * extension `releasedBy` = {userId, userName}, `releasedAt`, `reason`
   */
  order_lock_released: {
    status: 409,
    th: 'การแก้ไขของคุณถูกปลดล็อกโดยผู้อื่นแล้ว — โหลดใหม่ก่อนแก้ต่อ',
    en: 'Your edit lock was released by another user — reload before editing again',
  },
  /** ST3-T08: ขอล็อกการแก้ได้เฉพาะผู้ใช้ในบริษัท (ล็อกแสดงชื่อผู้แก้) — token ที่ไม่ใช่ผู้ใช้ (เช่น API client) ไม่ต้องใช้ล็อก */
  edit_lock_user_required: {
    status: 403,
    th: 'การล็อกเพื่อแก้ไขใช้ได้เฉพาะผู้ใช้ในระบบ',
    en: 'Edit locks are only available to signed-in users',
  },
  /** externalId เดียวกันมาจากช่องทาง/connector อื่น (externalId unique ต่อ tenant — plan/00a) — ไม่ทับใบของต้นทางอื่น */
  external_id_conflict: {
    status: 409,
    th: 'เลขอ้างอิงต้นทางนี้ถูกใช้กับใบสั่งขนส่งจากช่องทางอื่นแล้ว',
    en: 'This external id is already used by an order from another source',
  },
  /** ST3-T06: รหัส/ชื่อลูกค้าตามต้นทางนี้เคยจับคู่กับลูกค้าอื่นไว้ — ย้ายต้องยืนยัน (`confirmReassign` + เหตุผล) */
  alias_conflict: {
    status: 409,
    th: 'รหัสหรือชื่อลูกค้าตามต้นทางนี้เคยจับคู่กับลูกค้ารายอื่นไว้แล้ว — ยืนยันการย้ายพร้อมเหตุผล',
    en: 'This source customer code/name is already mapped to another customer — confirm the reassignment with a reason',
  },
  /** ST3-T09: สร้าง DO ได้เมื่อ SO พ้นร่าง ยังไม่วางแผน/ยกเลิก และจับคู่ลูกค้า + สถานที่ครบ (DO ต้องมีลูกค้า/ต้นทาง/ปลายทาง) */
  order_not_ready_for_delivery: {
    status: 409,
    th: 'ยังสร้างใบส่งของจากใบสั่งขนส่งนี้ไม่ได้ (ร่าง ยกเลิก วางแผนแล้ว หรือยังจับคู่ลูกค้า/สถานที่ไม่ครบ)',
    en: 'Delivery orders cannot be created for this order yet (draft, cancelled, planned or unmapped customer/locations)',
  },
  /** ST3-T09 ORD-083/086: แยก/รวม/ยกเลิก DO ได้เฉพาะใบ DRAFT ที่ยังไม่อยู่ในเที่ยว */
  trip_has_loaded_orders: {
    status: 409,
    th: 'ยกเลิกเที่ยวไม่ได้ — มีใบส่งของที่รับของขึ้นรถหรือส่งแล้ว (ปิดเที่ยวบางส่วนแล้วเปิดเที่ยวใหม่แทน)',
    en: 'Trip has orders already picked up or delivered — close it partially and open a new trip instead',
  },
  offer_required: {
    status: 409,
    th: 'รถคันนี้เป็นรถร่วม — ต้องเสนองานให้รถร่วมก่อน แล้วจึงบันทึกการรับงาน',
    en: 'Subcontract vehicle — offer the trip to the carrier first',
  },
  /** ST3-T23 ลิงก์ข้อเสนองาน: ข้อเสนอนี้ตอบไปแล้ว/ถูกถอน/เที่ยวเปลี่ยนไปแล้ว (คนอื่นกดก่อน — การกระทำแรกชนะ) */
  offer_closed: {
    status: 409,
    th: 'ข้อเสนองานนี้ปิดแล้ว (ตอบไปแล้วหรือถูกยกเลิก)',
    en: 'This job offer is closed (already answered or withdrawn)',
  },
  /** ST3-T24 "ส่งรายถัดไป" ระหว่างรอตอบ: ยังไม่ครบเวลาตอบ N ชม. (extension `responseDueAt`) */
  offer_not_timed_out: {
    status: 409,
    th: 'รถร่วมรายนี้ยังอยู่ในเวลาตอบรับ — ส่งรายถัดไปได้เมื่อครบเวลา',
    en: 'The carrier still has time to respond — send to the next carrier after the response time',
  },
  /**
   * ST3-T25 เปลี่ยนผู้รับเหมา: ทำได้เฉพาะเที่ยวที่รอรถร่วมตอบ (OFFERED) หรือรถร่วมรับงานแล้วแต่ยังไม่ปล่อยรถ (ASSIGNED)
   * — ปล่อยรถแล้ว/ไม่มีการจ้างรถร่วม → 409 (extension `from`)
   */
  carrier_change_not_allowed: {
    status: 409,
    th: 'เปลี่ยนผู้รับเหมาได้เฉพาะเที่ยวที่รอรถร่วมตอบ หรือรถร่วมรับงานแล้วแต่ยังไม่ปล่อยรถ',
    en: 'The carrier can only be changed while the offer is open or accepted but not yet dispatched',
  },
  carrier_change_requires_cancel: {
    status: 409,
    th: 'เปลี่ยนรถร่วมหรือสลับรถร่วม/รถบริษัทไม่ได้ — ยกเลิกการจ้างเดิมก่อน',
    en: 'Changing the carrier requires cancelling the current hire first',
  },
  /**
   * ST3-T16 (spec/03 PLN-003): ลำดับจุดที่เรียงเองทำให้จุดส่งของใบส่งของอยู่ก่อนจุดรับ (ส่งก่อนรับ) — บล็อก
   * extension `violations[]` {deliveryOrderId, doNo, pickupStopId, dropStopId, pickupSequence, dropSequence}
   */
  stop_order_invalid: {
    status: 422,
    th: 'ลำดับจุดไม่ถูกต้อง — จุดส่งของใบส่งของต้องอยู่หลังจุดรับของใบเดียวกัน',
    en: 'Invalid stop order — a delivery stop must come after the pickup stop of the same delivery order',
  },
  trip_empty: {
    status: 409,
    th: 'เที่ยวนี้ยังไม่มีใบส่งของ',
    en: 'Trip has no delivery orders',
  },
  /** ST6-T01c: ปิดต้นทุนถูกปิดด้วย kill switch ระดับระบบ (env `TRIP_COSTING_ENABLED=0`) — ค่าเริ่มต้นเปิด */
  trip_costing_unavailable: {
    status: 409,
    th: 'ปิดต้นทุนเที่ยวถูกปิดใช้ชั่วคราวโดยผู้ดูแลระบบ',
    en: 'Trip costing is temporarily disabled by the system administrator',
  },
  /** ST6-T01c: ผลปันต้นทุนลง DO ไม่ลงตัว (invariant — ไม่ควรเกิด) · transaction ถูกยกเลิก */
  trip_cost_allocation_failed: {
    status: 500,
    th: 'ปันต้นทุนเที่ยวลงใบส่งของไม่ลงตัว — ยังไม่ปิดต้นทุน กรุณาแจ้งผู้ดูแลระบบ',
    en: 'Trip cost allocation to delivery orders did not balance — trip was not costed',
  },
  /** ST6-T01: ปิดต้นทุน (COMPLETED → COSTED) ไม่ได้ — extension `blockers` (PENDING_FIELD_CHARGES / CARRIER_FEE_MISSING / REVENUE_PROVISIONAL / REVENUE_MISSING / PENDING_SELL_CHARGES) */
  trip_costs_incomplete: {
    status: 409,
    th: 'ต้นทุนเที่ยวยังไม่ครบ — ยืนยัน/ปฏิเสธค่าใช้จ่ายหน้างานที่รอ ตรวจค่าจ้างรถร่วม และรายได้ของใบส่งของ (ใช้ปันต้นทุน) ก่อนปิดต้นทุน',
    en: 'Trip costs are not complete — decide pending field charges, check the carrier fee and the delivery order revenue used for allocation first',
  },
  /** ST6-T03: บรรทัดต้นทุนอยู่ในใบสำคัญจ่ายที่ยังใช้อยู่แล้ว (กันจ่ายซ้ำ K11) — extension `tripCostIds`, `settlementIds` */
  trip_cost_already_settled: {
    status: 409,
    th: 'บรรทัดต้นทุนนี้อยู่ในใบสำคัญจ่ายอื่นแล้ว — จ่ายซ้ำไม่ได้',
    en: 'Trip cost line is already in another active settlement',
  },
  /** ST6-T07 separation of duties (docs/04 F6 Approve, A3): ผู้สร้างใบสำคัญจ่ายอนุมัติใบตัวเองไม่ได้ */
  settlement_self_approval: {
    status: 403,
    th: 'ผู้เตรียมใบสำคัญจ่าย (สร้างใบ เพิ่มหรือนำรายการออก) อนุมัติใบนั้นไม่ได้ ต้องให้ผู้อนุมัติคนอื่น',
    en: 'Whoever prepared a settlement cannot approve it',
  },
  /** ST6-T07: ใบไม่มีบรรทัดเที่ยวที่ยังใช้ — อนุมัติไม่ได้ */
  settlement_empty: {
    status: 409,
    th: 'ใบสำคัญจ่ายยังไม่มีรายการเที่ยว อนุมัติไม่ได้',
    en: 'The settlement has no trip lines',
  },
  /** ST6-T07 (spec/05 BIL-133): ยอดสุทธิติดลบ — ยกยอดหักส่วนเกินไปงวดถัดไปก่อนอนุมัติ */
  settlement_net_negative: {
    status: 409,
    th: 'ยอดสุทธิติดลบ อนุมัติไม่ได้ — นำรายการหักส่วนเกินออกแล้วยกไปงวดถัดไป',
    en: 'Net payable is negative — move the excess deductions to the next period',
  },
  /** ST6-T05/T06 (docs/01 §4.5 "dispute ใด ๆ บล็อก approve", spec/05 BIL-136): มีรายการโต้แย้งค้าง (รถร่วมโต้แย้ง/บัญชีติด dispute ที่ยังไม่เคลียร์) ในรอบตรวจปัจจุบัน — extension `disputedCount` */
  settlement_disputed: {
    status: 409,
    th: 'มีรายการโต้แย้งที่ยังไม่เคลียร์ อนุมัติไม่ได้ — ยืนยันยอดเดิมพร้อมเหตุผล หรือเรียกใบกลับมาแก้รายการ',
    en: 'The settlement has unresolved disputed lines — it cannot be approved',
  },
  /** ST6-T06: บริษัทยืนยันยอดเดิมของรายการนี้แล้วในรอบตรวจนี้ — รถร่วมตอบซ้ำไม่ได้ */
  settlement_line_resolved: {
    status: 409,
    th: 'บริษัทยืนยันยอดของรายการนี้แล้ว ตอบรายการนี้ไม่ได้อีก',
    en: 'The company already resolved this line — it cannot be answered again',
  },
  /** ST6-T05 (docs/01 §4.5): บริษัทตั้งให้รถร่วมตรวจก่อนอนุมัติ (`settlement.carrierReviewRequired`) — ร่างอนุมัติตรงไม่ได้ */
  settlement_review_required: {
    status: 409,
    th: 'ต้องส่งให้รถร่วมตรวจก่อนอนุมัติ (ตั้งค่าบริษัท)',
    en: 'The settlement must be sent to the carrier for review before approval',
  },
  /** ST6-T03: เที่ยว/บรรทัดต้นทุนไม่อยู่ในคิวจ่ายของรถร่วมรายนี้ (ยังไม่ปิดต้นทุน / POD ไม่ครบ / ต่างรถร่วม / ยังไม่ยืนยัน) — extension `tripIds`, `tripCostIds` */
  trip_cost_not_payable: {
    status: 409,
    th: 'เที่ยวหรือบรรทัดต้นทุนนี้ยังไม่อยู่ในคิวจ่ายของรถร่วมรายนี้ (ต้องปิดต้นทุนแล้ว หลักฐานส่งครบตามเงื่อนไข และเป็นของรถร่วมรายนี้)',
    en: 'Trip or trip cost line is not in the pay queue of this carrier',
  },
  trip_stops_open: {
    status: 409,
    th: 'ยังมีจุดแวะที่ยังไม่จบ — ปิดเที่ยวได้เมื่อทุกจุดส่งสำเร็จ/ไม่สำเร็จ/ข้าม',
    en: 'Some stops are not finished yet',
  },
  /** ST4-T01: บันทึก event หน้างาน (ถึง/ออก/ปิดงาน/ส่งไม่สำเร็จ) ได้เฉพาะเที่ยว DISPATCHED / IN_PROGRESS — extension `tripStatus` */
  trip_not_in_progress: {
    status: 409,
    th: 'บันทึกสถานะหน้างานได้เฉพาะเที่ยวที่ปล่อยรถแล้วและยังไม่จบ',
    en: 'Stop events can only be recorded on a dispatched trip that is not finished',
  },
  /**
   * `clientEventId` นี้ถูกใช้กับ event อื่นแล้ว (คนละจุด/คนละชนิด — unique ต่อ tenant, docs/01 §3.9) — extension `eventId`
   * ST4-T02: ส่งซ้ำด้วยจุด + ชนิดเดียวกัน = คืนผลเดิม 200 (ไม่ใช่ error นี้)
   */
  stop_event_duplicate: {
    status: 409,
    th: 'clientEventId นี้ถูกใช้กับ event อื่นแล้ว',
    en: 'This clientEventId was already used for a different event',
  },
  /** ST4-T02: event นี้ไม่มีธงให้ตัดสิน (ลำดับถูกต้องแล้ว / เวลาไม่เพี้ยน / ไม่ได้มาหลังปิด) */
  stop_event_not_flagged: {
    status: 409,
    th: 'เหตุการณ์นี้ไม่มีข้อขัดแย้งให้ตัดสิน',
    en: 'This stop event has no flag to resolve',
  },
  /** ST4-T02: ตัดสินไปแล้ว (1 event ตัดสินได้ครั้งเดียว — แถวใน stop_event_resolution) */
  stop_event_already_resolved: {
    status: 409,
    th: 'เหตุการณ์นี้ถูกตัดสินไปแล้ว',
    en: 'This stop event flag was already resolved',
  },
  delivery_order_on_trip: {
    status: 409,
    th: 'ใบส่งของนี้อยู่ในเที่ยวรถแล้ว — ถอดออกจากเที่ยวก่อน',
    en: 'Delivery order is on a trip — remove it from the trip first',
  },
  /** ST3-T10 docs/04 C: ยกเลิก/รับข้อมูลต้นทางของใบที่มีใบส่งของอยู่ในเที่ยว → ต้องถอดออกจากเที่ยวก่อน */
  order_on_trip: {
    status: 409,
    th: 'ใบสั่งขนส่งนี้มีใบส่งของอยู่ในเที่ยวรถ — ถอดออกจากเที่ยวก่อน',
    en: 'This order has delivery orders on a trip — remove them from the trip first',
  },
  /** ST3-T10: ชุดการเปลี่ยนแปลงจากต้นทางถูกตัดสินแล้ว (รับ/ไม่รับ/ต้นทางส่งชุดใหม่มาแทน) */
  source_change_not_pending: {
    status: 409,
    th: 'การเปลี่ยนแปลงจากต้นทางชุดนี้ถูกตัดสินไปแล้ว หรือมีชุดใหม่มาแทน — โหลดใหม่',
    en: 'This source change was already decided or superseded — reload',
  },
  /** ST3-T10: ใบที่ต้นทางแก้หลังวางแผนยังรอตัดสิน (รับ/ไม่รับ) — ลงเที่ยวไม่ได้ [OPEN #56] */
  order_source_change_pending: {
    status: 409,
    th: 'ต้นทางแก้ใบสั่งขนส่งนี้หลังวางแผน — เลือกรับค่าต้นทางหรือใช้ค่า TMS ก่อนจัดลงเที่ยว',
    en: 'The source changed this order after planning — accept or reject the change before planning it',
  },
  /**
   * ST3-T14 (D-07): รถ/คนขับติดกฎเอกสาร (เอกสารรถบังคับหมด/ไม่มี, ใบขับขี่ไม่มี/หมด/ชั้นไม่ถึง) — ผู้มี `trips:override`
   * ส่ง `overrideBlocks: true` + `overrideReason` (≥ 10 ตัว) เพื่อยกเว้น · extension `blocks[]`, `warnings[]`, `overrideScope`
   */
  assignment_blocked: {
    status: 409,
    th: 'รถหรือคนขับติดกฎห้ามจ่ายงาน — แก้เอกสารให้ครบ หรือให้ผู้จัดการยกเว้นพร้อมเหตุผล',
    en: 'Vehicle or driver is blocked by dispatch rules — fix the documents or have a manager override with a reason',
  },
  /**
   * ST3-T14 (D-07): ยังมีคำเตือนที่ไม่ได้ยืนยัน (น้ำหนักเกิน, รถไม่เข้ากับงาน/จุดส่ง, ชั่วโมงขับ, ซ้อนเวลา ฯลฯ) ตอนปล่อยรถ —
   * ส่ง `acknowledgeWarnings: true` + `overrideReason` หรือยืนยันที่ `/confirm-rules` · extension `warnings[]`
   */
  assignment_warnings: {
    status: 409,
    th: 'เที่ยวนี้มีคำเตือนที่ยังไม่ได้ยืนยัน — ยืนยันพร้อมเหตุผลก่อน',
    en: 'This trip has unconfirmed warnings — confirm them with a reason first',
  },
  /** code/refresh token ของการเข้าสู่ระบบหมดอายุหรือใช้ไปแล้ว (ไม่ใช่รหัส 2FA — นั่นคือ invalid_otp) */
  invalid_grant: {
    status: 400,
    th: 'การเข้าสู่ระบบหมดเวลา ลองใหม่อีกครั้ง',
    en: 'Sign-in expired or invalid grant — please try again',
  },
  /** ST3-T21 ช่องส่ง LINE/SMS ปิดหรือยังไม่ตั้งค่า — ผู้ใช้คัดลอกลิงก์ไปส่งเองได้ */
  channel_unavailable: {
    status: 409,
    th: 'ส่งทางช่องทางนี้ไม่ได้ตอนนี้ คัดลอกลิงก์ไปส่งเองได้',
    en: 'This channel is not available — copy the link and send it yourself',
  },
  /** ST4-T05 ตัวตรวจ POD: หลักฐานขาด field ที่ checklist ของลูกค้าตั้ง "บังคับ" — `missing[]` บอกรายการที่ขาด */
  pod_incomplete: {
    status: 422,
    th: 'หลักฐานการส่ง (POD) ยังไม่ครบตามที่ลูกค้ากำหนด',
    en: 'Proof of delivery is incomplete for this customer checklist',
  },
  /**
   * ST5-T04 ส่งบัญชี (RELEASED): DO ยังไม่พร้อมวางบิล — `reasons[]` (NOT_DELIVERED · BILLING_HOLD · PRICING_UNAVAILABLE ·
   * NO_REVENUE · REVENUE_PROVISIONAL · REVENUE_LOCKED · SURCHARGE_PENDING · STOP_TIMES_MISSING · POD_INCOMPLETE · IN_INVOICE) + `missing[]` เมื่อ POD ไม่ครบ
   */
  not_ready_to_bill: {
    status: 409,
    th: 'ใบส่งของนี้ยังไม่พร้อมวางบิล',
    en: 'This delivery order is not ready to bill',
  },
  /**
   * ST5-T05 กันวางบิลซ้ำ (docs/04 F3; spec/05 §2 ข้อ 8 `DO_ALREADY_DRAFTED`): DO อยู่ในบรรทัดใบแจ้งหนี้ที่ยัง active แล้ว
   * (ร่างอื่น/ใบที่ออกแล้ว) — `deliveryOrderId`, `doNo`, `billingStatus` (IN_DRAFT · INVOICED) · สองคำขอพร้อมกัน = รายที่สองได้ 409 นี้
   */
  do_already_drafted: {
    status: 409,
    th: 'ใบส่งของนี้อยู่ในใบแจ้งหนี้อื่นแล้ว',
    en: 'This delivery order is already on another invoice',
  },
  /**
   * ST5-T09 ออกเอกสารใบแจ้งหนี้ไม่ได้ (docs/04 F3 Finalize, spec/05 BIL-037/038) — extension `reasons[]` (รหัสคงที่):
   * `no_lines` `total_not_positive` `customer_tax_id_missing` `customer_branch_missing` `line_vat_type_missing`
   * `revenue_line_provisional` (+ `lines[]`) `issuer_not_vat_registered` (ผู้ออกไม่จด VAT แต่มีบรรทัด VAT 7% — [OPEN] #63)
   */
  invoice_not_finalizable: {
    status: 409,
    th: 'ยังออกเอกสารใบแจ้งหนี้นี้ไม่ได้',
    en: 'This invoice cannot be finalized yet',
  },
  /** ST5-T09 separation of duties (docs/04 A3): ผู้สร้าง/ผู้แก้ร่างล่าสุด ออกเอกสารใบนั้นเองไม่ได้ (เว้น tenant ปิดกฎ `billing.allowSelfFinalize`) */
  invoice_self_finalize: {
    status: 403,
    th: 'ผู้สร้างหรือผู้แก้ร่างใบแจ้งหนี้ ออกเอกสารใบนั้นเองไม่ได้ ต้องให้ผู้อื่นออก',
    en: 'Whoever prepared an invoice draft cannot finalize it',
  },
  /** ST5-T09 sandbox ยังออกเลขใบแจ้งหนี้ไม่ได้ ([OPEN — spec/12 §3 "Sandbox: เอกสารภาษีใน sandbox" — ห้ามตัดสินเอง]) */
  /** ST5-T09 review M1: PDF ใบที่ออกแล้วต้อง render ด้วยแม่แบบรุ่นเดียวกับวันออก — แม่แบบเปลี่ยนแล้ว (ไม่ render ใหม่เงียบ ๆ) */
  invoice_pdf_template_changed: {
    status: 409,
    th: 'แม่แบบเอกสารเปลี่ยนหลังวันออก สร้าง PDF ของใบนี้ใหม่ไม่ได้ — ติดต่อผู้ดูแลระบบ',
    en: 'The invoice template changed after issue — the issued PDF cannot be re-rendered',
  },
  /** D-61 (21 พ.ย. 2569): **ไม่ถูกส่งแล้ว** — sandbox ออกใบแจ้งหนี้ได้ (เลข `TEST-` + ลายน้ำ) · คงไว้เพื่อสัญญา API ไม่เปลี่ยนแบบ breaking */
  sandbox_finalize_disabled: {
    status: 409,
    th: 'โหมดทดสอบ (sandbox) ยังออกเลขใบแจ้งหนี้ไม่ได้',
    en: 'Finalizing invoices is not available in sandbox yet',
  },
  /**
   * ST5-T11 ใบวางบิล (spec/05 BIL-039): ใบแจ้งหนี้อยู่ในใบวางบิลอื่นที่ยัง active (ร่าง/ออกแล้ว) — `invoices[]`
   * (`invoiceId`, `invoiceNo`, `billingNoteId`, `billingNoteNo`) · สองคำขอพร้อมกัน = รายที่สองได้ 409 นี้ (unique partial ระดับ DB)
   */
  invoice_already_billed: {
    status: 409,
    th: 'ใบแจ้งหนี้นี้อยู่ในใบวางบิลอื่นแล้ว',
    en: 'This invoice is already on another active billing note',
  },
  /** ST5-T11 ใบวางบิลรวมได้เฉพาะใบแจ้งหนี้ที่ออกแล้วและยังค้างชำระ (ISSUED / PARTIALLY_PAID) — `invoices[]` (`invoiceId`, `invoiceNo`, `status`) */
  invoice_not_billable: {
    status: 409,
    th: 'ใบแจ้งหนี้นี้ยังไม่ออกหรือไม่มียอดค้าง ใส่ในใบวางบิลไม่ได้',
    en: 'Only issued invoices with an outstanding balance can be put on a billing note',
  },
  /** ST4-T07 บันทึก/แก้หลักฐานส่งได้เฉพาะ DO ที่ส่งแล้ว/ส่งไม่สำเร็จและยังไม่วางบิล — `doStatus` บอกสถานะปัจจุบัน */
  pod_not_allowed: {
    status: 409,
    th: 'บันทึกหลักฐานส่งของใบส่งของนี้ไม่ได้ในสถานะปัจจุบัน',
    en: 'Proof of delivery cannot be recorded for this delivery order in its current status',
  },
  /** ST4-T09 ลิงก์รถร่วม: DO นี้มีหลักฐานส่งแล้ว (ส่งผ่านลิงก์ครั้งเดียว — แก้ = ผู้จัดรถในเว็บ) */
  pod_exists: {
    status: 409,
    th: 'ส่ง POD ของใบส่งของนี้แล้ว',
    en: 'Proof of delivery has already been sent for this delivery order',
  },
  /** ST4-T12: จุดที่ DO ทุกใบถูกนัดส่งใหม่แล้ว (สถานะ ข้าม) — บันทึกถึง/ออก/ปิดงานไม่ได้ */
  stop_skipped: {
    status: 409,
    th: 'จุดนี้ไม่มีใบส่งของแล้ว (นัดส่งใหม่ไปเที่ยวอื่น) — ไม่ต้องบันทึกที่จุดนี้',
    en: 'This stop has no delivery orders left (rescheduled) — nothing to record here',
  },
  /** ST4-T09 ลิงก์รถร่วม: ปิดงานจุดส่งได้หลังกด "ถึงจุดส่ง" เท่านั้น */
  stop_not_arrived: {
    status: 409,
    th: 'ยังไม่ได้บันทึกถึงจุดนี้',
    en: 'The stop has not been arrived at yet',
  },
  /** ST4-T09 ลิงก์รถร่วม: ปิดงานจุดส่งไม่มีผล — จุดก่อนหน้า (จุดรับ) ยังไม่ปิด/ลำดับขัด */
  stop_not_ready: {
    status: 409,
    th: 'ปิดงานจุดก่อนหน้าก่อน',
    en: 'Close the previous stop first',
  },
  /** ST4-T09 ลิงก์รถร่วม: จุดนี้ถูกปิดแล้ว (ผู้จัดรถปิดแทน/คำขออื่นมาก่อน) — ส่ง POD อย่างเดียวได้ */
  stop_already_closed: {
    status: 409,
    th: 'จุดนี้ถูกปิดแล้ว — ส่ง POD ของ DO นี้ได้',
    en: 'This stop is already closed — send the proof of delivery only',
  },
  /** ST7-T01 OAuth2 client credentials (RFC 6749 §5.2): client_id/secret ผิด — ไม่บอกว่าผิดส่วนไหน */
  invalid_client: {
    status: 401,
    th: 'client_id หรือ client_secret ไม่ถูกต้อง',
    en: 'Invalid client credentials',
  },
  /** ST7-T01 ขอ scope ที่ key ไม่มี (RFC 6749 §5.2) */
  invalid_scope: {
    status: 400,
    th: 'ขอ scope ที่ API key นี้ไม่มี',
    en: 'Requested scope exceeds the scopes of this API key',
  },
  /** ST7-T01 (spec/07 §6 ข้อ 8) key ถูกเพิกถอน หรือหมุนแล้วเลยเวลา `revokeAt` */
  key_revoked: { status: 401, th: 'API key ถูกเพิกถอนแล้ว', en: 'API key has been revoked' },
  key_expired: { status: 401, th: 'API key หมดอายุแล้ว', en: 'API key has expired' },
  /** ST7-T01 (INT-075) IP ผู้เรียกไม่อยู่ใน allowlist ของ key */
  ip_not_allowed: {
    status: 403,
    th: 'IP นี้ไม่ได้รับอนุญาตให้ใช้ API key นี้',
    en: 'This IP address is not allowed for this API key',
  },
  sandbox_only: {
    status: 403,
    th: 'ใช้ได้เฉพาะโหมด Sandbox (key tk_test_ หรือสลับเป็น Sandbox)',
    en: 'Available in sandbox (test) mode only',
  },
  sandbox_unsupported: {
    status: 403,
    th: 'ใช้ใน Sandbox ไม่ได้ (เชื่อมระบบภายนอกจริง)',
    en: 'Not available in sandbox (connects to real external systems)',
  },
  /**
   * ST7-T12: รหัสใน `errors[].code` ของ routing นิติบุคคล (ตัว problem = `validation_failed`) — อยู่ใน catalog
   * เพื่อให้ข้อความ errors[].message เป็นไทย/อังกฤษตาม Accept-Language และมีหัวข้อในหน้า รหัส error ของเอกสาร
   */
  routing_not_configured: {
    status: 422,
    th: 'บริษัทมีหลายนิติบุคคลแต่ยังไม่ได้กำหนดนิติบุคคลออกบิล — ส่ง billingCompanyId (จาก GET /v1/companies) หรือตั้ง "ออกบิลในนาม" ที่ลูกค้า/ค่าตั้งต้นของบริษัท',
    en: 'Several legal entities and no billing entity set — send billingCompanyId (from GET /v1/companies) or set the customer/company default',
  },
  company_unavailable: {
    status: 422,
    th: 'นิติบุคคลออกบิลไม่พบหรือปิดใช้อยู่',
    en: 'Billing legal entity not found or inactive',
  },
  branch_unavailable: {
    status: 422,
    th: 'นิติบุคคลออกบิลยังไม่มีสาขาที่ออกเอกสาร',
    en: 'No issuing branch for this legal entity',
  },
  /**
   * ST5-T06 รหัสใน `errors[].code` ของ `invalid_state_transition` (lifecycle วางบิล — docs/04 F4) — อยู่ใน catalog
   * เพื่อมีหัวข้อในหน้า รหัส error ของเอกสาร: DO อยู่ในใบแจ้งหนี้ (ร่าง/ออกเลข) · DO ส่งบัญชีแล้ว (แก้จุดแวะ/ยอด/ย้อนผลส่งไม่ได้)
   */
  do_in_invoice: {
    status: 409,
    th: 'ใบส่งของนี้อยู่ในใบแจ้งหนี้แล้ว — แก้ที่ใบแจ้งหนี้ หรือถอดออกจากร่างก่อน',
    en: 'This delivery order is on an invoice — change it on the invoice or remove it from the draft first',
  },
  do_released: {
    status: 409,
    th: 'ใบส่งของนี้ส่งบัญชีแล้ว — แก้จุดแวะ/ยอดส่งจริงไม่ได้ ให้ฝ่ายวางบิลย้อนการส่งบัญชีก่อน',
    en: 'This delivery order was released to billing — ask billing to undo the release first',
  },
  internal_error: { status: 500, th: 'ระบบขัดข้อง', en: 'Internal error' },
} as const;

export type ProblemCode = keyof typeof PROBLEMS;

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export class ProblemException extends HttpException {
  constructor(
    readonly code: ProblemCode,
    readonly detail?: string,
    readonly errors?: FieldError[],
    readonly extra?: Record<string, unknown>,
  ) {
    super(code, PROBLEMS[code].status);
  }
}

export const notFound = (detail?: string) => new ProblemException('not_found', detail);
