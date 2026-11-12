import type { Schemas } from '@tms/contracts';
import type { RefOption } from '../master/RefPicker';
import { addDays } from '../rate-cards/rateFormat';

/**
 * แปลงข้อมูลฟอร์มใบสั่งขนส่ง ↔ API (ST3-T02) — ฟังก์ชันล้วน (test ใน orderForm.test.ts)
 * - ฟอร์มใช้ "วันที่ + เวลา" ตามเวลาไทย (Asia/Bangkok UTC+7 ไม่มี DST) · API รับ/คืน ISO 8601 (timestamptz)
 * - คัดลอกเป็นใบใหม่ (spec/03 ORD-022): คัดลอก ลูกค้า จุด สินค้า ประเภทรถ — ไม่คัดลอก PO ลูกค้า; วันที่ = วันถัดไปเวลาเดิม;
 *   ราคาคิดใหม่จาก rate card ปัจจุบัน (server คิดเองตอนบันทึก) · ใบใหม่เป็นร่าง ไม่มี externalId (ที่มา = มือ)
 * - เทมเพลต: payload รูปเดียวกับ body ของ POST /v1/orders — ใช้แล้วเลื่อนวันที่ทั้งใบไปวันที่เลือก (คงเวลา/ระยะห่างวัน)
 */
export type Order = Schemas['OrderDto'];
export type StopType = 'PICKUP' | 'DELIVERY' | 'RETURN';

/**
 * payload ตามสายจริง (ค่าเป็นสตริง/null) — ใช้แทนชนิดที่ generate จาก OpenAPI ของ input DTO
 * (ช่อง nullable ของ `OrderStopInputDto`/`OrderLineInputDto` ใน OpenAPI ไม่มี `type: string` → generate เป็น object; [OPEN] spec/12 §3)
 */
export interface PayloadStop {
  type: StopType;
  siteId: string | null;
  siteText: string | null;
  windowStart: string | null;
  windowEnd: string | null;
}
export interface PayloadLine {
  description: string;
  qty: string;
  unitId: string | null;
  unit: string | null;
  productId: string | null;
  weightKg: string | null;
}
export interface TemplatePayload {
  customer: { id?: string | null; externalId?: string | null; name?: string | null };
  customerRef: string | null;
  requestedDate: string;
  vehicleTypeId: string | null;
  stops: PayloadStop[];
  lines: PayloadLine[];
}
export type OrderBody = TemplatePayload & { draft: boolean };

export interface StopForm {
  key: string;
  type: StopType;
  site: RefOption | null;
  /** ข้อความสถานที่ตามต้นทาง (จุดที่ยังจับคู่ไม่ได้) — เลือกสถานที่แล้วใช้ชื่อสถานที่แทน */
  siteText: string;
  date: string;
  from: string;
  to: string;
}

export interface LineForm {
  key: string;
  product: RefOption | null;
  description: string;
  qty: string;
  unit: RefOption | null;
  /** ข้อความหน่วยตามต้นทาง (ไม่มี unitId) */
  unitText: string;
  weightKg: string;
}

export interface OrderForm {
  customer: RefOption | null;
  /** ข้อความลูกค้าตามต้นทาง (ใบที่ยังจับคู่ลูกค้าไม่ได้) — แสดงเป็นคำแนะนำ */
  customerText: string;
  customerRef: string;
  requestedDate: string;
  vehicleTypeId: string;
  stops: StopForm[];
  lines: LineForm[];
}

let seq = 0;
export const newKey = () => `k${++seq}`;

export const emptyStop = (type: StopType, date: string): StopForm => ({
  key: newKey(),
  type,
  site: null,
  siteText: '',
  date,
  from: '',
  to: '',
});
export const emptyLine = (): LineForm => ({
  key: newKey(),
  product: null,
  description: '',
  qty: '',
  unit: null,
  unitText: '',
  weightKg: '',
});

/** ใบใหม่: จุดรับ 1 + จุดส่ง 1 (spec/03: ≥ 1 pickup และ ≥ 1 drop) วันรับของ = พรุ่งนี้ */
export function emptyForm(today: string): OrderForm {
  const d = addDays(today, 1);
  return {
    customer: null,
    customerText: '',
    customerRef: '',
    requestedDate: d,
    vehicleTypeId: '',
    stops: [emptyStop('PICKUP', d), emptyStop('DELIVERY', d)],
    lines: [emptyLine()],
  };
}

// ---------- เวลาไทย ----------

const BKK = 7 * 3600_000;

/** ISO (UTC) → { date: YYYY-MM-DD, time: HH:mm } ตามเวลาไทย */
export function toBangkok(iso: string): { date: string; time: string } {
  const s = new Date(Date.parse(iso) + BKK).toISOString();
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}

/** วันที่ + เวลาไทย → ISO พร้อม timezone (+07:00) — เวลาว่าง = null */
export function fromBangkok(date: string, time: string): string | null {
  if (!date || !time) return null;
  return `${date}T${time}:00+07:00`;
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

// ---------- API → ฟอร์ม ----------

interface StopIn {
  type: string;
  siteId?: string | null;
  siteText?: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
}
interface LineIn {
  description: string;
  qty: string;
  unitId?: string | null;
  unit?: string | null;
  productId?: string | null;
  weightKg?: string | null;
}

function stopFrom(s: StopIn, fallbackDate: string): StopForm {
  const a = s.windowStart ? toBangkok(s.windowStart) : null;
  const b = s.windowEnd ? toBangkok(s.windowEnd) : null;
  return {
    key: newKey(),
    type: (['PICKUP', 'DELIVERY', 'RETURN'].includes(s.type) ? s.type : 'DELIVERY') as StopType,
    site: s.siteId ? { id: s.siteId, label: s.siteText ?? s.siteId } : null,
    siteText: s.siteId ? '' : (s.siteText ?? ''),
    date: a?.date ?? b?.date ?? fallbackDate,
    from: a?.time ?? '',
    to: b?.time ?? '',
  };
}

function lineFrom(l: LineIn): LineForm {
  return {
    key: newKey(),
    product: l.productId ? { id: l.productId, label: l.description } : null,
    description: l.description,
    qty: l.qty,
    unit: l.unitId ? { id: l.unitId, label: l.unit ?? l.unitId } : null,
    unitText: l.unitId ? '' : (l.unit ?? ''),
    weightKg: l.weightKg ?? '',
  };
}

/** ใบเดิม → ฟอร์มแก้ไข (ค่าเท่าเดิมทุกช่อง) */
export function fromOrder(o: Order): OrderForm {
  return {
    customer: o.customer.id
      ? {
          id: o.customer.id,
          label: o.customer.legalName ?? o.customer.code ?? o.customer.id,
          ...(o.customer.code ? { sub: o.customer.code } : {}),
        }
      : null,
    customerText: o.customer.id ? '' : (o.customer.name ?? o.customer.externalId ?? ''),
    customerRef: o.customerRef ?? '',
    requestedDate: o.requestedDate,
    vehicleTypeId: o.vehicleTypeId ?? '',
    stops: o.stops.map((s) => stopFrom(s, o.requestedDate)),
    lines: o.lines.map(lineFrom),
  };
}

/** เลื่อนทั้งใบให้วันรับของ = `to` (จุดที่อยู่คนละวันคงระยะห่างวันเดิม · เวลาเดิม) */
export function shiftTo(f: OrderForm, to: string): OrderForm {
  const n = dayDiff(f.requestedDate, to);
  return {
    ...f,
    requestedDate: to,
    stops: f.stops.map((s) => ({ ...s, key: newKey(), date: s.date ? addDays(s.date, n) : to })),
    lines: f.lines.map((l) => ({ ...l, key: newKey() })),
  };
}

/**
 * คัดลอกเป็นใบใหม่ (ORD-022): ข้อมูลเดิมครบ ยกเว้น PO ลูกค้า · วันรับของ = พรุ่งนี้ (เวลาเดิม)
 * ลูกค้าที่ยังจับคู่ไม่ได้ไม่คัดลอกข้อความ (ใบมือต้องเลือกลูกค้าจากข้อมูลหลัก)
 */
export function copyFromOrder(o: Order, today: string): OrderForm {
  const f = fromOrder(o);
  return shiftTo({ ...f, customerRef: '', customerText: '' }, addDays(today, 1));
}

/** เทมเพลต → ฟอร์มใบใหม่ (วันรับของ = `date`) — ชื่อลูกค้ามาจาก `customer` ที่ API resolve */
export function fromTemplate(
  p: TemplatePayload,
  customer: { id: string; code: string; legalName: string } | null,
  date: string,
): OrderForm {
  const f: OrderForm = {
    customer: customer ? { id: customer.id, label: customer.legalName, sub: customer.code } : null,
    customerText: '',
    customerRef: p.customerRef ?? '',
    requestedDate: p.requestedDate,
    vehicleTypeId: p.vehicleTypeId ?? '',
    stops: p.stops.map((s) => stopFrom(s, p.requestedDate)),
    lines: (p.lines ?? []).map(lineFrom),
  };
  return shiftTo(f, date);
}

// ---------- ฟอร์ม → API ----------

const blank = (v: string) => (v.trim() === '' ? null : v.trim());

function stopsBody(f: OrderForm) {
  return f.stops.map((s) => ({
    type: s.type,
    siteId: s.site?.id ?? null,
    siteText: s.site ? s.site.label : blank(s.siteText),
    windowStart: fromBangkok(s.date, s.from),
    windowEnd: fromBangkok(s.date, s.to),
  }));
}

function linesBody(f: OrderForm) {
  return f.lines.map((l) => ({
    description: l.description.trim(),
    qty: l.qty.trim(),
    unitId: l.unit?.id ?? null,
    unit: l.unit ? l.unit.label : blank(l.unitText),
    productId: l.product?.id ?? null,
    weightKg: blank(l.weightKg),
  }));
}

/** ฟอร์ม → payload (รูปเดียวกับ body ของ POST /v1/orders ไม่มี draft) — ใช้ทั้งสร้างใบและบันทึกเทมเพลต */
export function toPayload(f: OrderForm): TemplatePayload {
  return {
    customer: f.customer ? { id: f.customer.id } : {},
    customerRef: blank(f.customerRef),
    requestedDate: f.requestedDate,
    vehicleTypeId: f.vehicleTypeId || null,
    stops: stopsBody(f),
    lines: linesBody(f),
  };
}

export function toCreateBody(f: OrderForm, draft: boolean): OrderBody {
  return { ...toPayload(f), draft };
}

/** กลุ่มช่องของ API (`editableFields`) ที่แต่ละส่วนของ PATCH อยู่ */
const GROUP: Record<string, string> = {
  customer: 'customer',
  customerRef: 'customerRef',
  requestedDate: 'requestedDate',
  vehicleTypeId: 'vehicleTypeId',
  stops: 'stops',
  lines: 'lines',
};

/**
 * PATCH ของการแก้ไข: ส่งเฉพาะช่องที่เปลี่ยนจากค่าเดิม (ช่องที่ไม่ส่ง server คงค่าเดิม — ข้อความลูกค้าตามต้นทางไม่หาย)
 * `stops` ส่งได้เมื่อแก้จุดได้ หรือแก้ได้เฉพาะช่วงเวลา (`stops.window`) — server ตรวจซ้ำ (409 ถ้าเปลี่ยนสถานที่)
 */
export function toPatch(original: Order, f: OrderForm, submit: boolean): Record<string, unknown> {
  const a = toPayload(fromOrder(original)) as unknown as Record<string, unknown>;
  const b = toPayload(f) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(GROUP))
    if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) out[k] = b[k];
  if (submit && original.status === 'draft') out.draft = false;
  return out;
}

/** ช่องใดของฟอร์มที่แก้ได้ (จาก `editableFields` ของ API) — ใบใหม่ = ทุกช่อง */
export function editableOf(o: Order | null) {
  const g = new Set(o ? (o.editableFields ?? []) : Object.values(GROUP).concat('stops.window'));
  return {
    customer: g.has('customer'),
    customerRef: g.has('customerRef'),
    requestedDate: g.has('requestedDate'),
    vehicleTypeId: g.has('vehicleTypeId'),
    stops: g.has('stops'),
    window: g.has('stops') || g.has('stops.window'),
    lines: g.has('lines'),
    any: g.size > 0,
  };
}

// ---------- ตรวจในฟอร์ม ----------

const QTY = /^\d{1,12}(\.\d{1,3})?$/;

/**
 * ตรวจก่อนส่ง — key = path ของ API (`stops[0].siteId`) ให้ error จาก server ลงช่องเดียวกัน
 * ร่าง (D-21) ตรวจเฉพาะรูปแบบ; ส่ง/ยืนยัน ต้องมีลูกค้า ประเภทรถ จุดรับ ≥ 1 และจุดส่ง ≥ 1 ที่เลือกสถานที่แล้ว
 */
export function validate(f: OrderForm, draft: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (!f.requestedDate) e.requestedDate = 'required';
  if (!draft && !f.customer) e['customer.id'] = 'required';
  if (!draft && !f.vehicleTypeId) e.vehicleTypeId = 'required';
  if (!f.stops.length) e.stops = 'too_few';
  if (!draft && !f.stops.some((s) => s.type === 'PICKUP')) e.stops = 'need_pickup';
  else if (!draft && !f.stops.some((s) => s.type === 'DELIVERY')) e.stops = 'need_delivery';
  f.stops.forEach((s, i) => {
    if (!s.site && !s.siteText.trim()) e[`stops[${i}].siteId`] = 'required';
    if ((s.from || s.to) && !s.date) e[`stops[${i}].windowStart`] = 'required';
    if (s.from && s.to && s.to < s.from) e[`stops[${i}].windowEnd`] = 'window_order';
  });
  f.lines.forEach((l, i) => {
    if (!l.description.trim()) e[`lines[${i}].description`] = 'required';
    if (!QTY.test(l.qty.trim()) || !/[1-9]/.test(l.qty)) e[`lines[${i}].qty`] = 'must_be_positive';
    if (!l.unit && !l.unitText.trim()) e[`lines[${i}].unit`] = 'required';
    if (l.weightKg.trim() && !QTY.test(l.weightKg.trim()))
      e[`lines[${i}].weightKg`] = 'invalid_decimal';
  });
  return e;
}

/** น้ำหนักรวม (กก.) ของบรรทัดที่มีน้ำหนัก — สตริงทศนิยม (ไม่ใช้ float สะสม: คิดเป็นกรัม) */
export function totalWeightKg(lines: { weightKg?: string | null }[]): string | null {
  let g = 0n;
  let any = false;
  for (const l of lines) {
    if (!l.weightKg) continue;
    const [i = '0', f = ''] = l.weightKg.split('.');
    g += BigInt(i) * 1000n + BigInt((f + '000').slice(0, 3));
    any = true;
  }
  if (!any) return null;
  const kg = g / 1000n;
  const r = g % 1000n;
  return r ? `${kg}.${String(r).padStart(3, '0').replace(/0+$/, '')}` : String(kg);
}
