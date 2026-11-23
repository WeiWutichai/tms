import type { NotificationTemplate } from './templates';

/**
 * ศูนย์แจ้งเตือน (ST9-T08; docs/04 I "เหตุการณ์: ใบค้างใหม่, งานรถร่วมหมดเวลา, dispute, ขออนุมัติ,
 * เอกสารรถ/ใบขับขี่/rate card ใกล้หมด, connector ล่ม, DO ยังไม่วางบิล, ครบกำหนดชำระ; ผู้ใช้ตั้งว่ารับอะไรทางไหน; สรุปรายวัน 08:00")
 * + ข้อมูลไม่ตรงกับระบบบัญชี (MISMATCH — docs/01 §6.5 "severity `MONEY` แจ้งหัวหน้าบัญชีทันที … และสรุป 08:00"; D-81 · D68-61)
 *
 * - event = หมวดที่ผู้ใช้ตั้งรับ/ไม่รับได้ต่อช่องทาง (template หลายตัวอยู่ใต้ event เดียวได้)
 * - template ที่ไม่อยู่ใน event ใด (งานเบื้องหลังที่ผู้ใช้สั่งเอง `job.*`, `import.*`) = แจ้งผู้สั่งเสมอ ปิดไม่ได้
 * - `pending` = โมดูลต้นทางยังไม่มี (งานที่จะยิง event นี้) — ผู้ใช้ตั้งค่าล่วงหน้าได้ ระบบยังไม่ส่ง
 * - LINE ของทีมภายใน = P1 (docs/04 I "LINE P1 สำหรับทีมภายใน") → ยังตั้งไม่ได้ (คอลัมน์ในหน้าจอปิดไว้)
 */
export const NOTIFICATION_EVENTS = [
  'order.on_hold',
  'subcon.no_response',
  'dispute',
  'approval.requested',
  'document.expiring',
  'connector.down',
  'reconcile.mismatch',
  'delivery_order.unbilled',
  'payment.due',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/** ช่องทางที่ผู้ใช้ตั้งได้ (เฟส 0) */
export const PREF_CHANNELS = ['in_app', 'email'] as const;
export type PrefChannel = (typeof PREF_CHANNELS)[number];

export interface EventDefinition {
  templates: NotificationTemplate[];
  /** ค่าเริ่มต้นเมื่อผู้ใช้ยังไม่ตั้ง */
  defaults: Record<PrefChannel, boolean>;
  /** งาน backlog ที่จะยิง event นี้ (ยังไม่ merge) — null = ยิงแล้ว */
  pending: string | null;
}

export const EVENT_CATALOGUE: Record<NotificationEvent, EventDefinition> = {
  // ใบสั่งงานเข้าใบค้าง (ทางเข้า/นัดส่งใหม่เกิน/คืนคลัง — รถร่วมปฏิเสธอยู่ใต้ subcon) · งานทีละมากรวมเป็นฉบับเดียว · อีเมลปิดไว้ก่อน (นำเข้าทีละมาก ๆ = อีเมลท่วม; ดูในสรุปรายวันแทน)
  'order.on_hold': {
    // ST8-T05 ต้นทางยกเลิกใบที่มี DO แล้ว (ไม่ยกเลิกเอง) — อยู่ใต้หมวดเดียวกับใบค้าง (ต้นแบบไม่มีหมวดแยก)
    templates: ['order.held', 'order.held_batch', 'order.source_cancelled'],
    defaults: { in_app: true, email: false },
    pending: null,
  },
  // ST3-T24 ไม่ตอบใน N ชม. / ลิงก์หมดอายุ 48 ชม. + รถร่วมปฏิเสธ (ใบค้าง CARRIER_REJECTED — ST9-T08)
  'subcon.no_response': {
    templates: ['subcon_offer.no_response', 'subcon_offer.expired', 'subcon_offer.rejected'],
    defaults: { in_app: true, email: true },
    pending: null,
  },
  // ST6-T06 ใบสำคัญจ่ายรถร่วมเข้าสถานะ DISPUTED (รถร่วมโต้แย้ง/บัญชีติด dispute) → ผู้เตรียมใบ (`settlements:create`)
  dispute: {
    templates: ['settlement.disputed'],
    defaults: { in_app: true, email: true },
    pending: null,
  },
  // ค่าใช้จ่ายหน้างานรอยืนยัน (ST4-T13) · settlement/ใบลดหนี้รออนุมัติมากับ ST6/ST5
  'approval.requested': {
    templates: ['field_charge.pending'],
    defaults: { in_app: true, email: true },
    pending: null,
  },
  'document.expiring': {
    templates: ['expiry.digest'],
    defaults: { in_app: true, email: true },
    pending: null,
  },
  // connector → ERROR (ST7-T13) · webhook ถูกปิดอัตโนมัติ (ST7-T04) · D-81 · D68-57 เอกสารไม่ถูกส่งเข้าระบบบัญชี → ฝ่ายบัญชี
  // (ต้นแบบไม่มีหมวดแยก — อยู่ใต้ "การเชื่อมต่อขัดข้อง")
  'connector.down': {
    templates: [
      'connector.error',
      'connector.recovered',
      'webhook.auto_disabled',
      'connector.document_not_sent',
      // ST8-T11 อ่านเอกสารจากระบบบัญชีไม่สำเร็จ 2 รอบติด (ERP_UNREACHABLE)
      'connector.reconcile_unreachable',
    ],
    defaults: { in_app: true, email: true },
    pending: null,
  },
  // D-81 · D68-61 กระทบยอดกับระบบบัญชีพบส่วนต่างใหม่ (`reconcile.mismatch_found`, severity MONEY) → หัวหน้าบัญชี (`payments:record`)
  // ทันทีหลังจบรอบ (1 ฉบับ/รอบ/connector — ส่วนต่างเดิมไม่แจ้งซ้ำตาม diff_hash) + อยู่ในสรุปรายวัน 08:00
  // ST8-T11 เนื้อหาเอกสารไม่ตรง (`reconcile.document_mismatch_found`) — MONEY ในระบบ + อีเมลทันที · FIELD ในระบบ (ขึ้นสรุปเช้า) · รวมกลุ่มต่อ connector
  'reconcile.mismatch': {
    templates: ['reconcile.mismatch_found', 'reconcile.document_mismatch_found'],
    defaults: { in_app: true, email: true },
    pending: null,
  },
  // ST9-T06 DO ส่งถึงแล้วยังไม่วางบิลเกิน N วัน (`billing.unbilledAlertDays`) → ผู้วางบิล (`invoices:draft`) — สรุปทุกเช้า 08:00 ที่ยังมีใบค้าง (D-71 — เพิ่งเกินวันนี้ / ค้างทั้งหมด / ร่างค้างเกิน N วัน)
  'delivery_order.unbilled': {
    templates: ['delivery_order.unbilled'],
    defaults: { in_app: true, email: true },
    pending: null,
  },
  // ST5-T22 สรุปเตือนครบกำหนดชำระรายวัน 08:00 (BIL-121) → ผู้ดูแลลูกค้า (ไม่มี/ใช้ไม่ได้ → ผู้บันทึกรับชำระ `payments:record`)
  'payment.due': {
    templates: ['invoice.payment_due'],
    defaults: { in_app: true, email: true },
    pending: null,
  },
};

const BY_TEMPLATE = new Map<string, NotificationEvent>();
for (const e of NOTIFICATION_EVENTS)
  for (const t of EVENT_CATALOGUE[e].templates) BY_TEMPLATE.set(t, e);

/** event ของ template (null = แจ้งเสมอ ไม่ขึ้นกับการตั้งค่า) */
export function eventOfTemplate(template: string): NotificationEvent | null {
  return BY_TEMPLATE.get(template) ?? null;
}

/** key ของ user_preference */
export const NOTIFICATION_PREF_KEY = 'notifications';

/** ค่าที่เก็บ: { events: { [event]: { in_app?, email? } }, dailyDigest?: boolean } — ไม่มีค่า = ค่าเริ่มต้น */
export interface StoredPrefs {
  events: Partial<Record<NotificationEvent, Partial<Record<PrefChannel, boolean>>>>;
  dailyDigest?: boolean;
}

/** อ่านค่าที่เก็บแบบทนข้อมูลเสีย (key/ชนิดที่ไม่รู้จักถูกทิ้ง) */
export function parsePrefs(v: unknown): StoredPrefs {
  const out: StoredPrefs = { events: {} };
  if (!v || typeof v !== 'object') return out;
  const o = v as { events?: unknown; dailyDigest?: unknown };
  if (o.events && typeof o.events === 'object')
    for (const e of NOTIFICATION_EVENTS) {
      const ch = (o.events as Record<string, unknown>)[e];
      if (!ch || typeof ch !== 'object') continue;
      const c: Partial<Record<PrefChannel, boolean>> = {};
      for (const k of PREF_CHANNELS) {
        const b = (ch as Record<string, unknown>)[k];
        if (typeof b === 'boolean') c[k] = b;
      }
      if (Object.keys(c).length) out.events[e] = c;
    }
  if (typeof o.dailyDigest === 'boolean') out.dailyDigest = o.dailyDigest;
  return out;
}

export function channelEnabled(p: StoredPrefs, e: NotificationEvent, ch: PrefChannel): boolean {
  return p.events[e]?.[ch] ?? EVENT_CATALOGUE[e].defaults[ch];
}

/** สรุปรายวัน 08:00 (อีเมล) — ค่าเริ่มต้นเปิด */
export const DAILY_DIGEST_DEFAULT = true;
export function digestEnabled(p: StoredPrefs): boolean {
  return p.dailyDigest ?? DAILY_DIGEST_DEFAULT;
}
