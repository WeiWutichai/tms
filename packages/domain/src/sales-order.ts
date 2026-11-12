import type { PricingStatus } from './pricing';
import { InvalidTransitionError, type TransitionTable } from './state-machine';

/**
 * Sales Order (ST3-T01) — state machine (docs/01 §4.1 + D-21 "ร่าง"), ช่องทางเข้า (docs/04 C "Source ของ order")
 * และกฎรับงานเข้า (intake) ที่ใช้ร่วมกันทุกทางเข้า: UI กรอกมือ (T02) / Open API (T03) / Excel (T04) / connector (T05)
 * ล้วนเรียก `upsertOrder()` ตัวเดียวในฝั่ง API ซึ่งใช้ฟังก์ชันในไฟล์นี้ตัดสินสถานะ — ไม่มีทางลัด
 */

// ---------- สถานะ + transition ----------

export const SO_STATUSES = [
  'DRAFT',
  'RECEIVED',
  'ON_HOLD',
  'PLANNED',
  'IN_TRANSIT',
  'PARTIALLY_DELIVERED',
  'DELIVERED',
  'CLOSED',
  'CANCELLED',
] as const;
export type SoStatus = (typeof SO_STATUSES)[number];

export const SO_EVENTS = [
  'submit',
  'hold',
  'release',
  'plan',
  'dispatch',
  'deliver_partial',
  'resume',
  'deliver',
  'cancel',
  'close',
  'unplan',
  'recall',
] as const;
export type SoEvent = (typeof SO_EVENTS)[number];

/**
 * ตาราง transition ตาม docs/01 §4.1 (mermaid) + ร่าง (D-21: ร่างไม่กินเลข — ส่ง (submit) แล้วเป็น RECEIVED)
 * - สร้างใบ: เริ่มที่ RECEIVED (หรือ DRAFT เมื่อบันทึกร่าง) — ดู `SO_INITIAL_STATUSES`
 * - ค้าง (ON_HOLD) ทุกแบบใช้ event `hold` + reason code เดียว; ต้นทางแก้หลังวางแผน (SOURCE_CHANGED_AFTER_PLAN)
 *   **ไม่เปลี่ยนสถานะ** (ตั้งธง `source_changed_after_plan` — ST3-T10)
 * - `unplan` = DO ทุกใบหลุดจากเที่ยว (ถอด/ยกเลิกเที่ยว — ST3-T11) → RECEIVED แล้วประเมินใบค้างใหม่
 *   `recall` = เที่ยวที่ปล่อยแล้วถูกยกเลิกก่อนรับของ → กลับ PLANNED (เพิ่มจาก docs §4.1 — [OPEN] spec/12 §3)
 * - ยกเลิกได้ก่อนออกรถเท่านั้น (PLANNED ต้องยกเลิก DO ก่อน — ST3-T10 ตรวจ)
 */
export const SO_TRANSITIONS: TransitionTable<SoStatus, SoEvent> = {
  DRAFT: { submit: 'RECEIVED', cancel: 'CANCELLED' },
  RECEIVED: { hold: 'ON_HOLD', plan: 'PLANNED', cancel: 'CANCELLED' },
  ON_HOLD: { release: 'RECEIVED', plan: 'PLANNED', cancel: 'CANCELLED' },
  PLANNED: { hold: 'ON_HOLD', dispatch: 'IN_TRANSIT', cancel: 'CANCELLED', unplan: 'RECEIVED' },
  IN_TRANSIT: { deliver_partial: 'PARTIALLY_DELIVERED', deliver: 'DELIVERED', recall: 'PLANNED' },
  PARTIALLY_DELIVERED: { resume: 'IN_TRANSIT', deliver: 'DELIVERED' },
  DELIVERED: { close: 'CLOSED' },
  // CLOSED / CANCELLED = สถานะสิ้นสุด
};

/** สถานะแรกของใบใหม่ */
export const SO_INITIAL_STATUSES = ['DRAFT', 'RECEIVED'] as const satisfies readonly SoStatus[];

/** สถานะที่ข้อมูลจากทางเข้า (upsert) ยังเขียนทับได้ — หลังวางแผนเป็นเรื่องของ ST3-T10 (เก็บ diff ไม่ทับ) */
export const SO_INTAKE_EDITABLE = [
  'DRAFT',
  'RECEIVED',
  'ON_HOLD',
] as const satisfies readonly SoStatus[];

export function isIntakeEditable(status: SoStatus): boolean {
  return (SO_INTAKE_EDITABLE as readonly SoStatus[]).includes(status);
}

// ---------- ช่องที่แก้ได้ตามสถานะ (ST3-T03) ----------

/**
 * กลุ่มข้อมูลของ SO ที่ทางเข้าแก้ได้ (ชื่อใช้ใน `errors[].field` ของ 409 `order_locked_for_update`)
 * - `stops` = จำนวน/ลำดับ/ชนิด/สถานที่ของจุด · `stops.window` = ช่วงเวลาของจุดเดิม (เทียบตามลำดับ)
 * - `customerRef` = เลข PO/อ้างอิงลูกค้า (ถือเป็น custom field ตาม docs/04 C "Custom fields (เลข PO …)")
 */
export const SO_FIELD_GROUPS = [
  'customer',
  'billingCompanyId',
  'customerRef',
  'requestedDate',
  'vehicleTypeId',
  'stops',
  'stops.window',
  'lines',
  'sourceIssues',
] as const;
export type SoFieldGroup = (typeof SO_FIELD_GROUPS)[number];

/**
 * ช่องที่แก้ได้ตามสถานะ — docs/04 C "กฎ field ที่แก้ไม่ได้หลัง `in_transit` → 409" + รายละเอียด spec/03 ORD-032:
 * - ก่อนวางแผน (DRAFT/RECEIVED/ON_HOLD และยังไม่มี DO ในเที่ยว): ทุกช่อง (ประเมินราคา/ใบค้างใหม่)
 * - วางแผนแล้ว (PLANNED): ช่วงเวลา + เลข PO (ช่องอื่นต้องถอด DO ออกจากเที่ยวก่อน — ต้นทางแก้ = ST3-T10 diff)
 * - ตั้งแต่ IN_TRANSIT ขึ้นไป (รวมส่งบางส่วน/ส่งแล้ว): เลข PO เท่านั้น (ราคา/หมายเหตุ/custom fields = งานถัดไป)
 * - CLOSED / CANCELLED: ไม่มี
 * `doOnTrip` = มี DO ของใบนี้อยู่ในเที่ยวแล้ว (กันกรณีสถานะยังไม่เดินตาม) → นับเหมือน PLANNED
 */
export function soEditableFields(status: SoStatus, doOnTrip = false): readonly SoFieldGroup[] {
  if (isIntakeEditable(status) && !doOnTrip) return SO_FIELD_GROUPS;
  switch (status) {
    case 'DRAFT':
    case 'RECEIVED':
    case 'ON_HOLD':
    case 'PLANNED':
      return ['customerRef', 'stops.window'];
    case 'IN_TRANSIT':
    case 'PARTIALLY_DELIVERED':
    case 'DELIVERED':
      return ['customerRef'];
    default:
      return [];
  }
}

/** ร่างไม่กินเลข (docs/01 §3.5) — สถานะอื่นทุกสถานะต้องมีเลข SO (CHECK `sales_order_number`) */
export function soRequiresNumber(status: SoStatus): boolean {
  return status !== 'DRAFT';
}

// ---------- ช่องทางเข้า (source) ----------

/**
 * ค่าที่เก็บ (docs/01 §3.3 enum `order_source`) ↔ ชื่อใน docs/04 C:
 * MANUAL = MANUAL · IMPORT = EXCEL · API = API · PORTAL = PORTAL · CONNECTOR + รหัส connector = `ERP:{connector}`
 * (ชื่อสองชุดใน docs ขัดกัน — [OPEN] spec/12 §3; เก็บตาม data model และแปลงชื่อที่ขอบ)
 */
export const ORDER_SOURCES = ['MANUAL', 'IMPORT', 'API', 'PORTAL', 'CONNECTOR'] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

/** รหัส connector (เช่น `krs`) — ตัวเล็ก/ตัวเลข/-/_ ไม่เกิน 32 ตัว (CHECK `sales_order_source_connector`) */
export const CONNECTOR_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export interface OrderSourceRef {
  source: OrderSource;
  /** เฉพาะ CONNECTOR (ไม่ใช่ = '') */
  connector: string;
}

/** ชื่อแสดง/ส่งออกตาม docs/04 C: MANUAL / EXCEL / API / PORTAL / ERP:{connector} */
export function formatOrderSource(ref: OrderSourceRef): string {
  switch (ref.source) {
    case 'IMPORT':
      return 'EXCEL';
    case 'CONNECTOR':
      return `ERP:${ref.connector}`;
    default:
      return ref.source;
  }
}

/** แปลงชื่อตาม docs/04 C (หรือค่าที่เก็บ) → ค่าที่เก็บ · ไม่รู้จัก/รหัส connector ผิดรูป → null */
export function parseOrderSource(value: string): OrderSourceRef | null {
  const v = value.trim();
  const m = /^(ERP|CONNECTOR):(.*)$/i.exec(v);
  if (m) {
    const connector = m[2]!.trim().toLowerCase();
    return CONNECTOR_KEY_RE.test(connector) ? { source: 'CONNECTOR', connector } : null;
  }
  const up = v.toUpperCase();
  if (up === 'EXCEL' || up === 'IMPORT') return { source: 'IMPORT', connector: '' };
  if (up === 'MANUAL' || up === 'API' || up === 'PORTAL') return { source: up, connector: '' };
  return null;
}

/** ค่าที่เก็บต้องสอดคล้องกัน: CONNECTOR ⇔ มีรหัส connector ถูกรูป */
export function isValidSourceRef(ref: OrderSourceRef): boolean {
  if (!(ORDER_SOURCES as readonly string[]).includes(ref.source)) return false;
  return ref.source === 'CONNECTOR' ? CONNECTOR_KEY_RE.test(ref.connector) : ref.connector === '';
}

// ---------- กฎรับงานเข้า (intake) → ใบค้าง ----------

/**
 * เหตุค้างที่ "ทางเข้า" เป็นผู้ตั้งและเคลียร์เอง (ประเมินใหม่ทุกครั้งที่ upsert) — เรียงตามลำดับความสำคัญ
 * (reason code ระบบหมวด ORDER_HOLD ของ ST2-T12; plan/11 ข้อ 4) · เหตุอื่น (CARRIER_REJECTED, CAPACITY_EXCEEDED,
 * DELIVERY_WINDOW_EXHAUSTED …) ตั้งโดย flow อื่น — upsert ไม่แตะ
 */
export const INTAKE_HOLD_CODES = [
  'SOURCE_ERROR',
  'CUSTOMER_UNMAPPED',
  'LOCATION_UNMAPPED',
  'RATE_MISSING',
] as const;
export type IntakeHoldCode = (typeof INTAKE_HOLD_CODES)[number];

export function isIntakeHoldCode(code: string | null | undefined): code is IntakeHoldCode {
  return !!code && (INTAKE_HOLD_CODES as readonly string[]).includes(code);
}

export type OrderStopType = 'PICKUP' | 'DELIVERY' | 'RETURN';

export interface IntakeFacts {
  /** ต้นทางแจ้งว่าข้อมูลไม่ครบ/ผิดรูป (connector) */
  sourceIssues: readonly string[];
  /** จับคู่ลูกค้าได้ (มี customer_id) */
  customerMapped: boolean;
  /** จุดตามลำดับ — `mapped` = จับคู่สถานที่ใน master ได้ */
  stops: readonly { type: OrderStopType; mapped: boolean }[];
  pricingStatus: PricingStatus;
  /** มีบรรทัดค่าขนส่งที่คนกำหนดเอง (ORD-043 — บรรทัด MANUAL) → ไม่ค้าง RATE_MISSING แม้หา rate ไม่ได้ */
  manualFreight?: boolean;
}

export interface IntakeHold {
  code: IntakeHoldCode;
  /** ช่องที่เป็นต้นเหตุ (เช่น `customer`, `stops[1].site`) */
  field?: string;
}

/**
 * ตรวจข้อเท็จจริงของ order → เหตุค้างทั้งหมด เรียงตามความสำคัญ (ตัวแรก = reason code ที่ตั้งบน SO)
 * - ต้องมีจุดรับ ≥ 1 และจุดส่ง ≥ 1 ที่จับคู่สถานที่ได้ — ขาด/จับคู่ไม่ได้ = LOCATION_UNMAPPED
 * - คิดราคาไม่ได้ (ไม่พบ rate / คำนวณไม่ได้) = RATE_MISSING (plan/11 ข้อ 4: ROUTE_PENDING → LOCATION_UNMAPPED/RATE_MISSING)
 * ไม่บล็อกการรับงาน — order เข้าระบบเสมอ (docs/04 C) แล้วไปอยู่หน้าใบค้าง (ST3-T07)
 */
export function evaluateIntakeHolds(f: IntakeFacts): IntakeHold[] {
  const holds: IntakeHold[] = [];
  if (f.sourceIssues.length) holds.push({ code: 'SOURCE_ERROR', field: 'source' });
  if (!f.customerMapped) holds.push({ code: 'CUSTOMER_UNMAPPED', field: 'customer' });
  const unmapped = f.stops.findIndex((s) => !s.mapped);
  if (unmapped >= 0) holds.push({ code: 'LOCATION_UNMAPPED', field: `stops[${unmapped}].site` });
  else if (!f.stops.some((s) => s.type === 'PICKUP'))
    holds.push({ code: 'LOCATION_UNMAPPED', field: 'stops.pickup' });
  else if (!f.stops.some((s) => s.type === 'DELIVERY'))
    holds.push({ code: 'LOCATION_UNMAPPED', field: 'stops.delivery' });
  if (f.pricingStatus !== 'AVAILABLE' && !f.manualFreight)
    holds.push({ code: 'RATE_MISSING', field: 'pricing' });
  return holds;
}

export interface IntakePlanInput {
  /** null = ใบใหม่ */
  current: SoStatus | null;
  /** reason code ปัจจุบัน (เมื่อ ON_HOLD) */
  currentHoldCode: string | null;
  /** ผู้เรียกขอบันทึกเป็นร่าง */
  draft: boolean;
  holds: readonly IntakeHold[];
}

export interface IntakePlan {
  /** สถานะเริ่มของใบใหม่ (null เมื่อเป็นใบเดิม) */
  initial: (typeof SO_INITIAL_STATUSES)[number] | null;
  /** event ที่ต้องเดินต่อตามลำดับ (ผ่าน SO_TRANSITIONS) */
  events: SoEvent[];
  /** reason code ที่ต้องอยู่บน SO หลังจบ (null = ไม่ค้าง) */
  holdCode: string | null;
  /** ค้างอยู่แล้วแต่เหตุเปลี่ยน (สถานะเดิม ON_HOLD → ON_HOLD) */
  holdCodeChanged: boolean;
}

/**
 * ตัดสินสถานะหลัง upsert (ฟังก์ชันล้วน — ใช้ทั้ง API และ test):
 * - ใบใหม่: ร่าง → DRAFT · ไม่ใช่ร่าง → RECEIVED แล้ว `hold` ถ้ามีเหตุค้าง (docs/01 §4.1: [*] → RECEIVED → ON_HOLD)
 * - ร่างเดิม + ไม่ขอร่าง → `submit` (+ `hold`)
 * - RECEIVED + มีเหตุ → `hold` · ON_HOLD ด้วยเหตุของทางเข้า + เหตุหมด → `release` / เหตุเปลี่ยน → เปลี่ยน reason code
 * - ON_HOLD ด้วยเหตุที่ flow อื่นตั้ง (เช่น CARRIER_REJECTED) → ไม่แตะ
 * - ขอร่างกับใบที่พ้นร่างแล้ว → InvalidTransition (ไม่มีทางกลับเป็นร่าง)
 */
export function planIntake(p: IntakePlanInput): IntakePlan {
  const first = p.holds[0]?.code ?? null;
  if (p.current === null) {
    if (p.draft) return { initial: 'DRAFT', events: [], holdCode: null, holdCodeChanged: false };
    return {
      initial: 'RECEIVED',
      events: first ? ['hold'] : [],
      holdCode: first,
      holdCodeChanged: false,
    };
  }
  if (p.draft && p.current !== 'DRAFT')
    throw new InvalidTransitionError<SoStatus, string>('sales_order', p.current, 'save_draft');
  switch (p.current) {
    case 'DRAFT':
      if (p.draft) return { initial: null, events: [], holdCode: null, holdCodeChanged: false };
      return {
        initial: null,
        events: first ? ['submit', 'hold'] : ['submit'],
        holdCode: first,
        holdCodeChanged: false,
      };
    case 'RECEIVED':
      return {
        initial: null,
        events: first ? ['hold'] : [],
        holdCode: first,
        holdCodeChanged: false,
      };
    case 'ON_HOLD':
      if (!isIntakeHoldCode(p.currentHoldCode))
        return { initial: null, events: [], holdCode: p.currentHoldCode, holdCodeChanged: false };
      if (!first)
        return { initial: null, events: ['release'], holdCode: null, holdCodeChanged: false };
      return {
        initial: null,
        events: [],
        holdCode: first,
        holdCodeChanged: first !== p.currentHoldCode,
      };
    default:
      // หลังวางแผน upsert ไม่เปลี่ยนสถานะ (ST3-T10) — ผู้เรียกต้องกันไว้ก่อน (isIntakeEditable)
      return { initial: null, events: [], holdCode: p.currentHoldCode, holdCodeChanged: false };
  }
}

/** ข้อความไทยของเหตุค้าง (ลง `hold_note` / ประวัติสถานะ — คนอ่าน ไม่ใช่ชื่อช่อง) */
export function intakeHoldNoteTh(
  hold: IntakeHold,
  ctx: {
    customerRef?: string | null;
    /** ลูกค้าที่ระบุถูกปิดใช้งาน */
    customerInactive?: boolean;
    stopTexts?: readonly string[];
    /** จุดที่อ้างสถานที่ซึ่งถูกปิดใช้งาน (ตามลำดับจุด) */
    stopInactive?: readonly boolean[];
    sourceIssues?: readonly string[];
  } = {},
): string {
  switch (hold.code) {
    case 'SOURCE_ERROR':
      return `ข้อมูลจากต้นทางไม่ครบ: ${(ctx.sourceIssues ?? []).join(' · ') || 'ไม่ระบุ'}`;
    case 'CUSTOMER_UNMAPPED':
      if (ctx.customerInactive) return 'ลูกค้าถูกปิดใช้งาน — เลือกลูกค้าใหม่หรือเปิดใช้ลูกค้า';
      return ctx.customerRef
        ? `ยังไม่ได้จับคู่ลูกค้า (รหัสต้นทาง ${ctx.customerRef})`
        : 'ยังไม่ได้ระบุลูกค้า';
    case 'LOCATION_UNMAPPED': {
      const m = /^stops\[(\d+)\]/.exec(hold.field ?? '');
      if (m) {
        const i = Number(m[1]);
        const t = ctx.stopTexts?.[i];
        if (ctx.stopInactive?.[i]) return `จุดที่ ${i + 1} สถานที่ถูกปิดใช้งาน${t ? `: ${t}` : ''}`;
        return `จุดที่ ${i + 1} ยังไม่ได้จับคู่สถานที่${t ? `: ${t}` : ''}`;
      }
      return hold.field === 'stops.pickup' ? 'ยังไม่มีจุดรับสินค้า' : 'ยังไม่มีจุดส่งสินค้า';
    }
    case 'RATE_MISSING':
      return 'ยังไม่มีราคาขาย (ไม่พบ rate card ที่ใช้ได้ หรือคิดราคาไม่ได้)';
  }
}
