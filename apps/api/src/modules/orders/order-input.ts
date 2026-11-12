import {
  isValidSourceRef,
  parseOrderSource,
  type OrderSource,
  type OrderSourceRef,
  type OrderStopType,
} from '@tms/domain';
import { ProblemException, type FieldError } from '../../common/problem';
import { cleanLine } from '../master/master-kit';
import { isRealDate } from '../vehicle-documents/expiry';

/**
 * ข้อมูลขาเข้าของ `upsertOrder()` — รูปกลาง (canonical) ที่ทุกทางเข้าแปลงมา (ST3-T02 ฟอร์ม, T03 API, T04 Excel,
 * T05 connector) · id ทั้งหมดเป็น uuid (ผู้เรียกถอด public id เอง) · เงิน/จำนวนเป็นสตริงทศนิยม (ไม่ใช้ float)
 */
export interface UpsertOrderInput {
  /**
   * uuid ของ SO เดิม — แก้ใบที่ไม่มี externalId (กรอกมือ/ร่าง) ด้วยทางเดียวกัน (lock → hash → ประเมินสถานะ)
   * ระบุ id แล้ว ช่องทาง/externalId ของใบเดิมคงไว้ (ส่ง externalId อื่น → 422 `external_id_locked`)
   */
  id?: string | null;
  /** ช่องทางเข้า: `{source, connector}` หรือชื่อตาม docs/04 C (`MANUAL` / `EXCEL` / `API` / `PORTAL` / `ERP:{connector}`) */
  source: OrderSourceRef | string;
  /** externalRef ของระบบต้นทาง — มีค่า = upsert idempotent ต่อ (source, connector, externalId) */
  externalId?: string | null;
  /** บันทึกเป็นร่าง (D-21 — ไม่ออกเลข SO) · ใบที่พ้นร่างแล้วกลับเป็นร่างไม่ได้ */
  draft?: boolean;
  customer?: {
    /** uuid ของลูกค้าใน master (เลือกจากฟอร์ม) */
    id?: string | null;
    /** รหัสลูกค้าตามต้นทาง — จับคู่กับ customer.external_id */
    externalId?: string | null;
    /** ชื่อ/ข้อความตามต้นทาง */
    text?: string | null;
  };
  /** override นิติบุคคลที่ออกบิล (uuid) — ไม่ส่ง = routing ST1-T16 */
  billingCompanyId?: string | null;
  /** PO ลูกค้า */
  customerRef?: string | null;
  /** YYYY-MM-DD วันรับของ (ใช้หา rate MD-110) */
  requestedDate: string;
  vehicleTypeId?: string | null;
  stops: UpsertOrderStop[];
  lines?: UpsertOrderLine[];
  /** ต้นทางแจ้งว่าข้อมูลไม่ครบ/ผิดรูป → ใบค้าง SOURCE_ERROR (connector) */
  sourceIssues?: string[];
  /** payload ดิบจากต้นทาง (docs/01 §3.3 raw_payload) */
  rawPayload?: unknown;
}

export interface UpsertOrderStop {
  type: OrderStopType;
  /** uuid ของสถานที่ — ว่าง = ยังจับคู่ไม่ได้ (LOCATION_UNMAPPED) */
  siteId?: string | null;
  /** ข้อความสถานที่ตามต้นทาง (บังคับเมื่อไม่มี siteId) */
  siteText?: string | null;
  /** ISO 8601 พร้อม timezone */
  windowStart?: string | null;
  windowEnd?: string | null;
}

export interface UpsertOrderLine {
  description: string;
  /** > 0 ทศนิยม ≤ 3 ตำแหน่ง */
  qty: string;
  /** หน่วยใน master (ใช้คิดราคา) และ/หรือ ข้อความหน่วย */
  unitId?: string | null;
  unit?: string | null;
  productId?: string | null;
  itemCode?: string | null;
  weightKg?: string | null;
  cbm?: string | null;
  isDangerous?: boolean;
  tempMin?: string | null;
  tempMax?: string | null;
}

export interface NormalizedOrder {
  id: string | null;
  source: OrderSource;
  connector: string;
  externalId: string | null;
  draft: boolean;
  customer: { id: string | null; externalId: string | null; text: string | null };
  billingCompanyId: string | null;
  customerRef: string | null;
  requestedDate: string;
  vehicleTypeId: string | null;
  stops: {
    type: OrderStopType;
    siteId: string | null;
    siteText: string;
    windowStart: string | null;
    windowEnd: string | null;
  }[];
  lines: {
    description: string;
    qty: string;
    unitId: string | null;
    unit: string | null;
    productId: string | null;
    itemCode: string | null;
    weightKg: string | null;
    cbm: string | null;
    isDangerous: boolean;
    tempMin: string | null;
    tempMax: string | null;
  }[];
  sourceIssues: string[];
  rawPayload: unknown;
}

/** "012.50" → "12.5", "-0.0" → "0" — ค่าเดียวกันได้ hash เดียวกัน */
export function canonDecimal(v: string): string {
  const neg = v.startsWith('-');
  let [i = '0', f = ''] = v.replace(/^[-+]/, '').split('.');
  i = i.replace(/^0+(?=\d)/, '');
  f = f.replace(/0+$/, '');
  const out = f ? `${i}.${f}` : i;
  return neg && out !== '0' ? `-${out}` : out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** numeric(14,3) ≥ 0 */
const QTY = /^\d{1,11}(\.\d{1,3})?$/;
/** numeric(5,1) */
const TEMP = /^-?\d{1,4}(\.\d)?$/;
const STOP_TYPES: readonly OrderStopType[] = ['PICKUP', 'DELIVERY', 'RETURN'];
export const ORDER_LIMITS = { stops: 50, lines: 200, text: 500, ref: 100, rawBytes: 256 * 1024 };

/**
 * กฎตรวจรูปแบบชุดเดียวของทุกทางเข้า — ผิด → 422 รวมทุกช่อง (errors[]) ไม่ใช่ทีละช่อง
 * ข้อมูลที่ "ไม่ครบเชิงธุรกิจ" (ไม่มีลูกค้า/จุดยังไม่จับคู่/ไม่มีประเภทรถ) **ไม่ใช่** ข้อผิดพลาด — ใบค้าง (evaluateIntakeHolds)
 * ข้อความถูกล้างอักขระควบคุม/zero-width (cleanLine) ก่อนเก็บ
 */
export function normalizeOrderInput(input: UpsertOrderInput): NormalizedOrder {
  const errors: FieldError[] = [];
  const err = (field: string, code: string, message: string) =>
    errors.push({ field, code, message });
  const text = (v: unknown, field: string, max: number, required = false): string | null => {
    if (v === undefined || v === null) {
      if (required) err(field, 'required', 'required');
      return null;
    }
    if (typeof v !== 'string') {
      err(field, 'invalid_type', 'must be a string');
      return null;
    }
    const c = cleanLine(v);
    if (!c) {
      if (required) err(field, 'required', 'required');
      return null;
    }
    if (c.length > max) err(field, 'too_long', `must be at most ${max} characters`);
    return c;
  };
  const uuid = (v: unknown, field: string): string | null => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !UUID.test(v)) {
      err(field, 'invalid_id', 'must be a uuid');
      return null;
    }
    return v.toLowerCase();
  };
  const decimal = (v: unknown, field: string, re: RegExp, required = false): string | null => {
    if (v === undefined || v === null || v === '') {
      if (required) err(field, 'required', 'required');
      return null;
    }
    // เงิน/จำนวนรับเป็นสตริงทศนิยมเท่านั้น (JS number = float → ปฏิเสธ)
    if (typeof v !== 'string') {
      err(field, 'invalid_type', 'must be a decimal string');
      return null;
    }
    if (!re.test(v.trim())) {
      err(field, 'invalid_decimal', 'invalid number');
      return null;
    }
    return canonDecimal(v.trim());
  };
  const instant = (v: unknown, field: string): string | null => {
    if (v === undefined || v === null || v === '') return null;
    const s = v instanceof Date ? v.toISOString() : v;
    // ต้องมี timezone (Z หรือ ±hh:mm) — เวลาเก็บ timestamptz
    if (
      typeof s !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(s) ||
      Number.isNaN(Date.parse(s))
    ) {
      err(field, 'invalid_datetime', 'must be ISO 8601 with timezone');
      return null;
    }
    return new Date(s).toISOString();
  };

  // ช่องทาง
  const ref =
    typeof input.source === 'string'
      ? parseOrderSource(input.source)
      : input.source && typeof input.source === 'object'
        ? { source: input.source.source, connector: input.source.connector ?? '' }
        : null;
  if (!ref || !isValidSourceRef(ref))
    err('source', 'invalid_source', 'must be MANUAL, EXCEL, API, PORTAL or ERP:{connector}');

  const externalId = text(input.externalId, 'externalId', ORDER_LIMITS.ref);
  const requestedDate =
    typeof input.requestedDate === 'string' && isRealDate(input.requestedDate)
      ? input.requestedDate
      : (err('requestedDate', 'invalid_date', 'must be YYYY-MM-DD'), '');

  const c = input.customer ?? {};
  const customer = {
    id: uuid(c.id, 'customer.id'),
    externalId: text(c.externalId, 'customer.externalId', ORDER_LIMITS.ref),
    text: text(c.text, 'customer.text', ORDER_LIMITS.text),
  };

  const stopsIn = Array.isArray(input.stops) ? input.stops : [];
  if (!Array.isArray(input.stops)) err('stops', 'required', 'required');
  else if (!stopsIn.length) err('stops', 'too_few', 'at least one stop');
  else if (stopsIn.length > ORDER_LIMITS.stops)
    err('stops', 'too_many', `at most ${ORDER_LIMITS.stops} stops`);
  const stops = stopsIn.slice(0, ORDER_LIMITS.stops).map((s, i) => {
    const f = `stops[${i}]`;
    const type = s?.type;
    if (!STOP_TYPES.includes(type)) err(`${f}.type`, 'invalid_enum', 'PICKUP, DELIVERY or RETURN');
    const siteId = uuid(s?.siteId, `${f}.siteId`);
    const siteText = text(s?.siteText, `${f}.siteText`, ORDER_LIMITS.text, !siteId && !s?.siteId);
    const windowStart = instant(s?.windowStart, `${f}.windowStart`);
    const windowEnd = instant(s?.windowEnd, `${f}.windowEnd`);
    if (windowStart && windowEnd && windowEnd < windowStart)
      err(`${f}.windowEnd`, 'window_order', 'windowEnd must not be before windowStart');
    return { type, siteId, siteText: siteText ?? '', windowStart, windowEnd };
  });

  const linesIn = input.lines ?? [];
  if (!Array.isArray(linesIn)) err('lines', 'invalid_type', 'must be an array');
  else if (linesIn.length > ORDER_LIMITS.lines)
    err('lines', 'too_many', `at most ${ORDER_LIMITS.lines} lines`);
  const lines = (Array.isArray(linesIn) ? linesIn : []).slice(0, ORDER_LIMITS.lines).map((l, i) => {
    const f = `lines[${i}]`;
    const qty = decimal(l?.qty, `${f}.qty`, QTY, true);
    if (qty !== null && !/[1-9]/.test(qty)) err(`${f}.qty`, 'must_be_positive', 'must be > 0');
    const unitId = uuid(l?.unitId, `${f}.unitId`);
    const unit = text(l?.unit, `${f}.unit`, 30, !unitId && !l?.unitId);
    const tempMin = decimal(l?.tempMin, `${f}.tempMin`, TEMP);
    const tempMax = decimal(l?.tempMax, `${f}.tempMax`, TEMP);
    if (tempMin !== null && tempMax !== null && Number(tempMin) > Number(tempMax))
      err(`${f}.tempMax`, 'temp_range', 'tempMax must be ≥ tempMin');
    if (l?.isDangerous !== undefined && typeof l.isDangerous !== 'boolean')
      err(`${f}.isDangerous`, 'invalid_type', 'must be a boolean');
    return {
      description: text(l?.description, `${f}.description`, ORDER_LIMITS.text, true) ?? '',
      qty: qty ?? '0',
      unitId,
      unit,
      productId: uuid(l?.productId, `${f}.productId`),
      itemCode: text(l?.itemCode, `${f}.itemCode`, ORDER_LIMITS.ref),
      weightKg: decimal(l?.weightKg, `${f}.weightKg`, QTY),
      cbm: decimal(l?.cbm, `${f}.cbm`, QTY),
      isDangerous: l?.isDangerous === true,
      tempMin,
      tempMax,
    };
  });

  const issuesIn = input.sourceIssues ?? [];
  if (!Array.isArray(issuesIn) || issuesIn.length > 50)
    err('sourceIssues', 'invalid_type', 'must be an array of at most 50 messages');
  const sourceIssues = (Array.isArray(issuesIn) ? issuesIn : [])
    .slice(0, 50)
    .map((x, i) => text(x, `sourceIssues[${i}]`, ORDER_LIMITS.text, true) ?? '');

  if (input.draft !== undefined && typeof input.draft !== 'boolean')
    err('draft', 'invalid_type', 'must be a boolean');
  let rawPayload: unknown = input.rawPayload ?? null;
  if (rawPayload !== null) {
    let json: string | undefined;
    try {
      json = JSON.stringify(rawPayload);
    } catch {
      json = undefined;
    }
    if (json === undefined) err('rawPayload', 'invalid_type', 'must be JSON');
    else if (Buffer.byteLength(json) > ORDER_LIMITS.rawBytes)
      err('rawPayload', 'too_large', `must be at most ${ORDER_LIMITS.rawBytes} bytes`);
    else rawPayload = JSON.parse(json);
  }

  const result: NormalizedOrder = {
    id: uuid(input.id, 'id'),
    source: (ref?.source ?? 'MANUAL') as OrderSource,
    connector: ref?.connector ?? '',
    externalId,
    draft: input.draft === true,
    customer,
    billingCompanyId: uuid(input.billingCompanyId, 'billingCompanyId'),
    customerRef: text(input.customerRef, 'customerRef', 50),
    requestedDate,
    vehicleTypeId: uuid(input.vehicleTypeId, 'vehicleTypeId'),
    stops,
    lines,
    sourceIssues,
    rawPayload,
  };
  if (errors.length) throw new ProblemException('validation_failed', undefined, errors);
  return result;
}
