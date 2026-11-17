import { HttpException } from '@nestjs/common';

/**
 * Catalog ของ error `code` (คงที่ ห้ามเปลี่ยนชื่อ — ลูกค้าและ UI ผูกกับค่าเหล่านี้)
 * RFC 9457 application/problem+json (docs/01 §5.1)
 */
export const PROBLEMS = {
  validation_failed: { status: 422, th: 'ข้อมูลไม่ถูกต้อง', en: 'Validation failed' },
  bad_request: { status: 400, th: 'คำขอไม่ถูกต้อง', en: 'Bad request' },
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
    th: 'ปิดใช้ไม่ได้ เพราะยังมีข้อมูลที่ใช้งานอยู่อ้างถึง — ดูจำนวนใน references',
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
  invalid_grant: { status: 400, th: 'รหัสยืนยันหมดอายุหรือไม่ถูกต้อง', en: 'Invalid grant' },
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
