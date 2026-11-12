import { createHash } from 'node:crypto';
import type { OrderStopType } from '@tms/domain';
import { cleanLine, stableStringify } from '../master/master-kit';
import {
  ORDER_DATE_MAX,
  ORDER_DATE_MIN,
  ORDER_LIMITS,
  type UpsertOrderInput,
  type UpsertOrderLine,
  type UpsertOrderStop,
} from '../orders/order-input';
import { isRealDate } from '../vehicle-documents/expiry';
import type { ExternalOrder, ExternalOrderLine, ExternalOrderStop } from './order-source.port';

/** ข้อมูลหลักที่จับคู่จากรหัสต้นทางแล้ว (อ่านใน transaction ของใบนั้น) */
export interface MappedRefs {
  /** ลูกค้าที่รหัสต้นทางตรงกับ customer.external_id (ใช้กรองสถานที่ของลูกค้าอื่นเท่านั้น — upsertOrder จับคู่ลูกค้าเอง) */
  customerId: string | null;
  /** รหัสสถานที่ต้นทาง → สถานที่ที่ใช้งานอยู่ */
  sites: Map<string, { id: string; customerId: string | null }>;
  /** รหัสประเภทรถต้นทาง → id */
  vehicleTypes: Map<string, string>;
}

export interface MappedOrder {
  input: UpsertOrderInput;
  /** ปัญหาของข้อมูลต้นทาง (= sourceIssues → ใบค้าง SOURCE_ERROR) */
  issues: string[];
  /** จับคู่ไม่ได้แต่ไม่ใช่ข้อมูลผิด (เช่น รหัสประเภทรถไม่รู้จัก) — แจ้งในผลการดึง ไม่ค้างใบ */
  warnings: string[];
}

/** รหัสต้นทางที่ต้องจับคู่ก่อนแปลง (อ่านจาก ExternalOrder ที่ยังไม่ตรวจ) */
export function externalCodes(ext: ExternalOrder): {
  customer: string | null;
  sites: string[];
  vehicleType: string | null;
} {
  const stops = Array.isArray(ext.stops) ? (ext.stops as ExternalOrderStop[]) : [];
  return {
    customer: code(ext.customer && typeof ext.customer === 'object' ? ext.customer.code : null),
    sites: [
      ...new Set(stops.flatMap((s) => (s && typeof s === 'object' ? [code(s.siteCode)] : []))),
    ].filter((x): x is string => x !== null),
    vehicleType: code(ext.vehicleTypeCode),
  };
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const QTY = /^\d{1,11}(\.\d{1,3})?$/;
const TEMP = /^-?\d{1,4}(\.\d)?$/;
const STOP_TYPES: readonly OrderStopType[] = ['PICKUP', 'DELIVERY', 'RETURN'];
const MAX_ISSUES = 50;
/** ข้อความแทนเมื่อต้นทางไม่ให้ชื่อสถานที่ (ช่องบังคับของ SO) — คนแก้จากหน้าใบค้าง */
const NO_SITE_TEXT = '(ต้นทางไม่ระบุสถานที่)';

/** สตริง/ตัวเลขจากต้นทาง → ข้อความที่ล้างแล้ว (ว่าง = null) */
function code(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const c = cleanLine(v);
  return c ? c.slice(0, ORDER_LIMITS.ref) : null;
}

const show = (v: unknown) => {
  const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
};

/**
 * ExternalOrder (ไม่เชื่อ) → `UpsertOrderInput` ที่ผ่านกฎ `normalizeOrderInput` เสมอ — **ไม่ทิ้งใบ** (docs/04 C)
 * ช่องผิดรูป/ขาด → ล้างทิ้งหรือใช้ค่าแทน + บันทึกเป็น `sourceIssues` (ใบค้าง SOURCE_ERROR ให้คนแก้ — ดู raw_payload)
 * - ไม่มีวันรับของ → วันที่รับเข้า (`fallbackDate`, วันนี้เวลาไทย) ชั่วคราว
 * - ไม่มีเลขอ้างอิง → `{connector}-nokey-{hash}` จาก payload (ส่งซ้ำค่าเดิมยังได้ใบเดิม)
 * - บรรทัดสินค้าที่ขาดช่องบังคับ (จำนวน > 0, หน่วย, รายละเอียด/รหัส) → ไม่รับบรรทัดนั้น (payload ดิบยังอยู่)
 * จับคู่สถานที่/ประเภทรถจากรหัสต้นทาง (`refs`) · ลูกค้าส่งเป็น `customer.externalId` ให้ upsertOrder จับคู่เอง
 */
export function mapExternalOrder(
  ext: ExternalOrder,
  connector: string,
  refs: MappedRefs,
  fallbackDate: string,
): MappedOrder {
  const issues: string[] = [];
  const warnings: string[] = [];
  const issue = (m: string) => issues.push(m);
  const text = (v: unknown, max: number, label: string): string | null => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v))) {
      issue(`${label}: รูปแบบไม่ถูกต้อง (${show(v)})`);
      return null;
    }
    const c = cleanLine(String(v));
    if (!c) return null;
    if (c.length > max) {
      issue(`${label}: ยาวเกิน ${max} ตัวอักษร — ตัดเหลือ ${max}`);
      return c.slice(0, max);
    }
    return c;
  };
  const decimal = (v: unknown, re: RegExp, label: string): string | null => {
    if (v === undefined || v === null || v === '') return null;
    const s =
      typeof v === 'string'
        ? v.trim()
        : typeof v === 'number' && Number.isFinite(v)
          ? String(v)
          : null;
    if (s === null || !re.test(s)) {
      issue(`${label}: ตัวเลขไม่ถูกต้อง (${show(v)})`);
      return null;
    }
    return s;
  };
  const instant = (v: unknown, label: string): string | null => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !ISO_INSTANT.test(v) || Number.isNaN(Date.parse(v))) {
      issue(`${label}: เวลาไม่ถูกต้อง (${show(v)})`);
      return null;
    }
    return v;
  };

  // เลขอ้างอิง (key idempotent)
  let externalId = code(ext.externalId);
  const rawExt =
    typeof ext.externalId === 'string' ? cleanLine(ext.externalId) : (externalId ?? '');
  if (!externalId || rawExt.length > ORDER_LIMITS.ref) {
    const h = createHash('sha256')
      .update(stableStringify(ext.raw ?? { ...ext, externalId: ext.externalId ?? null }))
      .digest('hex')
      .slice(0, 16);
    issue(
      externalId
        ? `เลขอ้างอิงจากต้นทางยาวเกิน ${ORDER_LIMITS.ref} ตัวอักษร — ใช้เลขแทนชั่วคราว`
        : 'ไม่มีเลขอ้างอิงจากต้นทาง — ใช้เลขแทนชั่วคราว',
    );
    externalId = `${connector}-nokey-${h}`;
  }

  // วันรับของ
  let requestedDate = fallbackDate;
  const d = ext.requestedDate;
  if (typeof d === 'string' && isRealDate(d) && d >= ORDER_DATE_MIN && d <= ORDER_DATE_MAX)
    requestedDate = d;
  else
    issue(
      d === undefined || d === null || d === ''
        ? `ไม่มีวันรับของจากต้นทาง — ใช้วันที่รับเข้า ${fallbackDate} ชั่วคราว`
        : `วันรับของจากต้นทางไม่ถูกต้อง (${show(d)}) — ใช้วันที่รับเข้า ${fallbackDate} ชั่วคราว`,
    );

  // ลูกค้า
  const cust = ext.customer && typeof ext.customer === 'object' ? ext.customer : {};
  if (ext.customer !== undefined && ext.customer !== null && typeof ext.customer !== 'object')
    issue(`ลูกค้า: รูปแบบไม่ถูกต้อง (${show(ext.customer)})`);
  const customer = {
    externalId: text(cust.code, ORDER_LIMITS.ref, 'รหัสลูกค้า'),
    text: text(cust.name, ORDER_LIMITS.text, 'ชื่อลูกค้า'),
  };
  const customerRef = text(ext.customerRef, 50, 'เลข PO');

  // ประเภทรถ
  const vtCode = code(ext.vehicleTypeCode);
  const vehicleTypeId = vtCode ? (refs.vehicleTypes.get(vtCode) ?? null) : null;
  if (vtCode && !vehicleTypeId) warnings.push(`ไม่รู้จักรหัสประเภทรถ ${vtCode}`);

  // จุดรับ/ส่ง
  const stopsIn: unknown[] = Array.isArray(ext.stops) ? ext.stops : [];
  if (ext.stops !== undefined && ext.stops !== null && !Array.isArray(ext.stops))
    issue('จุดรับ/ส่ง: รูปแบบไม่ถูกต้อง');
  if (stopsIn.length > ORDER_LIMITS.stops)
    issue(`จุดรับ/ส่งเกิน ${ORDER_LIMITS.stops} จุด — รับ ${ORDER_LIMITS.stops} จุดแรก`);
  const stops: UpsertOrderStop[] = stopsIn.slice(0, ORDER_LIMITS.stops).map((raw, i) => {
    const label = `จุดที่ ${i + 1}`;
    const s = (raw && typeof raw === 'object' ? raw : {}) as ExternalOrderStop;
    if (!raw || typeof raw !== 'object') issue(`${label}: รูปแบบไม่ถูกต้อง`);
    let type = typeof s.type === 'string' ? (s.type.trim().toUpperCase() as OrderStopType) : null;
    if (!type || !STOP_TYPES.includes(type)) {
      issue(`${label}: ประเภทจุดไม่ถูกต้อง (${show(s.type ?? null)}) — ถือเป็นจุดส่ง`);
      type = 'DELIVERY';
    }
    const siteCode = code(s.siteCode);
    const hit = siteCode ? refs.sites.get(siteCode) : undefined;
    // สถานที่ของลูกค้าอื่น = ไม่จับคู่ (LOCATION_UNMAPPED) แทนที่จะปฏิเสธทั้งใบ
    const siteId =
      hit && (!hit.customerId || !refs.customerId || hit.customerId === refs.customerId)
        ? hit.id
        : null;
    let siteText = text(s.text, ORDER_LIMITS.text, `${label} ชื่อสถานที่`) ?? siteCode;
    if (!siteText && !siteId) {
      issue(`${label}: ไม่มีชื่อหรือรหัสสถานที่`);
      siteText = NO_SITE_TEXT;
    }
    let windowStart = instant(s.windowStart, `${label} เวลาเริ่ม`);
    let windowEnd = instant(s.windowEnd, `${label} เวลาสิ้นสุด`);
    if (windowStart && windowEnd && Date.parse(windowEnd) < Date.parse(windowStart)) {
      issue(`${label}: เวลาสิ้นสุดก่อนเวลาเริ่ม — ไม่รับช่วงเวลา`);
      windowStart = windowEnd = null;
    }
    return { type, siteId, siteText, windowStart, windowEnd };
  });
  if (!stops.length) {
    issue('ไม่มีจุดรับ/ส่งจากต้นทาง');
    stops.push({ type: 'DELIVERY', siteId: null, siteText: NO_SITE_TEXT });
  }

  // สินค้า
  const linesIn: unknown[] = Array.isArray(ext.lines) ? ext.lines : [];
  if (ext.lines !== undefined && ext.lines !== null && !Array.isArray(ext.lines))
    issue('รายการสินค้า: รูปแบบไม่ถูกต้อง');
  if (linesIn.length > ORDER_LIMITS.lines)
    issue(`รายการสินค้าเกิน ${ORDER_LIMITS.lines} บรรทัด — รับ ${ORDER_LIMITS.lines} บรรทัดแรก`);
  const lines: UpsertOrderLine[] = [];
  linesIn.slice(0, ORDER_LIMITS.lines).forEach((raw, i) => {
    const label = `สินค้าบรรทัดที่ ${i + 1}`;
    if (!raw || typeof raw !== 'object') {
      issue(`${label}: รูปแบบไม่ถูกต้อง — ไม่ได้รับบรรทัดนี้`);
      return;
    }
    const l = raw as ExternalOrderLine;
    const before = issues.length;
    const itemCode = text(l.itemCode, ORDER_LIMITS.ref, `${label} รหัสสินค้า`);
    const description = text(l.description, ORDER_LIMITS.text, `${label} รายละเอียด`) ?? itemCode;
    const qty = decimal(l.qty, QTY, `${label} จำนวน`);
    const unit = text(l.unit, 30, `${label} หน่วย`);
    const missing = [
      !description && 'รายละเอียด',
      (!qty || !/[1-9]/.test(qty)) && 'จำนวนมากกว่า 0',
      !unit && 'หน่วย',
    ].filter(Boolean);
    if (missing.length) {
      // ข้อความของช่องที่ผิดรูปบันทึกไปแล้ว — เพิ่มสรุปว่าไม่รับบรรทัด
      issues.splice(before);
      issue(`${label}: ไม่มี${missing.join('/')} — ไม่ได้รับบรรทัดนี้`);
      return;
    }
    let tempMin = decimal(l.tempMin, TEMP, `${label} อุณหภูมิต่ำสุด`);
    let tempMax = decimal(l.tempMax, TEMP, `${label} อุณหภูมิสูงสุด`);
    if (tempMin !== null && tempMax !== null && Number(tempMin) > Number(tempMax)) {
      issue(`${label}: อุณหภูมิต่ำสุดมากกว่าสูงสุด — ไม่รับช่วงอุณหภูมิ`);
      tempMin = tempMax = null;
    }
    let isDangerous = false;
    if (typeof l.isDangerous === 'boolean') isDangerous = l.isDangerous;
    else if (l.isDangerous !== undefined && l.isDangerous !== null)
      issue(`${label} สินค้าอันตราย: รูปแบบไม่ถูกต้อง (${show(l.isDangerous)})`);
    lines.push({
      description: description!,
      qty: qty!,
      unit,
      itemCode,
      weightKg: decimal(l.weightKg, QTY, `${label} น้ำหนัก`),
      cbm: decimal(l.cbm, QTY, `${label} ปริมาตร`),
      isDangerous,
      tempMin,
      tempMax,
    });
  });

  // ปัญหาที่ adapter แจ้งเอง (เช่น คอลัมน์หาย) — มาก่อนปัญหาที่ core พบ
  const fromSource: string[] = [];
  if (Array.isArray(ext.issues))
    for (const x of ext.issues) {
      const t = typeof x === 'string' ? cleanLine(x) : '';
      fromSource.push(t ? t.slice(0, ORDER_LIMITS.text) : `ต้นทางแจ้งปัญหา (${show(x)})`);
    }
  else if (ext.issues !== undefined && ext.issues !== null)
    fromSource.push(`ต้นทางแจ้งปัญหา (${show(ext.issues)})`);

  // payload ดิบ (ไม่เกินเพดาน — เกินเก็บเฉพาะขนาด)
  let rawPayload: unknown = ext.raw ?? null;
  if (rawPayload !== null) {
    let json: string | undefined;
    try {
      json = JSON.stringify(rawPayload);
    } catch {
      json = undefined;
    }
    if (json === undefined) {
      issue('ข้อมูลดิบจากต้นทางแปลงเป็น JSON ไม่ได้ — ไม่ได้เก็บ');
      rawPayload = null;
    } else if (Buffer.byteLength(json) > ORDER_LIMITS.rawBytes) {
      issue(`ข้อมูลดิบจากต้นทางใหญ่เกิน ${ORDER_LIMITS.rawBytes} ไบต์ — ไม่ได้เก็บ`);
      rawPayload = { truncated: true, bytes: Buffer.byteLength(json) };
    }
  }

  const all = [...fromSource, ...issues];
  const sourceIssues =
    all.length > MAX_ISSUES
      ? [...all.slice(0, MAX_ISSUES - 1), `…และอีก ${all.length - MAX_ISSUES + 1} ปัญหา`]
      : all;
  return {
    input: {
      source: { source: 'CONNECTOR', connector },
      externalId,
      customer,
      customerRef,
      requestedDate,
      vehicleTypeId,
      stops,
      lines,
      sourceIssues,
      rawPayload,
    },
    issues: sourceIssues,
    warnings,
  };
}

/**
 * ใบสำรองเมื่อ upsertOrder ยังปฏิเสธรูปแบบ (422 — ไม่ควรเกิดหลัง mapExternalOrder) — เก็บเฉพาะหัวใบ + จุดเป็นข้อความ
 * + ข้อผิดพลาดทั้งหมดเป็น sourceIssues → order ยังเข้าระบบเป็นใบค้าง SOURCE_ERROR (ไม่ทิ้ง)
 */
export function fallbackInput(m: MappedOrder, errors: string[]): UpsertOrderInput {
  const i = m.input;
  const issues = [...m.issues, ...errors.map((e) => `รับข้อมูลไม่ได้: ${e}`)];
  return {
    source: i.source,
    externalId: i.externalId,
    customer: { externalId: i.customer?.externalId ?? null, text: i.customer?.text ?? null },
    requestedDate: i.requestedDate,
    stops: i.stops.map((s) => ({
      type: s.type,
      siteText: s.siteText || NO_SITE_TEXT,
    })),
    lines: [],
    sourceIssues:
      issues.length > MAX_ISSUES
        ? [...issues.slice(0, MAX_ISSUES - 1), `…และอีก ${issues.length - MAX_ISSUES + 1} ปัญหา`]
        : issues.map((x) => x.slice(0, ORDER_LIMITS.text)),
    rawPayload: i.rawPayload ?? null,
  };
}
