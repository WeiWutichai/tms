import { decimalFromSatang, satangFromDecimal, sumSatang, type Satang } from './money';
import type { ServiceItemVatType, ServiceItemWhtRate } from './tax';

/**
 * Pricing engine (ST2-T15) — ฟังก์ชันล้วน ใช้ทั้งขาขาย (SELL → บรรทัดรายได้ของ order) และขาซื้อ (BUY → cost line ของ trip)
 * ที่มา: docs/04 B1 (สูตรราคา + `pricingStatus`), spec/02 §5 MD-114 (สูตรค่าขนส่งฐาน + ขั้นต่ำ + ปัด 2 ตำแหน่ง half-up),
 * MD-115 (ค่าจุดเพิ่มเป็นบรรทัดแยก `EXTRA_STOP`), MD-117 (snapshot ค่าที่ใช้คิด)
 *
 * - สูตรเฟส 0: PER_TRIP (เหมาเที่ยว = FLAT_TRIP ใน docs) · PER_KM (ตามระยะทาง = PER_DISTANCE) ·
 *   PER_TON / PER_CBM / PER_UNIT (ตามน้ำหนัก/ปริมาตร/หน่วยนับ) — PER_DAY (เหมาวัน) เป็น P1 → CALCULATION_FAILURE
 * - เงินคิดเป็นสตางค์ (bigint) + จำนวนเป็นเศษส่วน bigint — ไม่มี float เลย; ปัดครั้งเดียวต่อบรรทัด (half-up เป็นสตางค์)
 *   แล้วจึงเทียบขั้นต่ำ: ค่าขนส่ง = max(ปัด(ราคา × จำนวน), ขั้นต่ำ)
 * - **ไม่คำนวณ VAT/หัก ณ ที่จ่าย** — แค่พา `vatType`/`whtRate` ของรายการบริการ (snapshot) ไปกับแต่ละบรรทัด
 *   `whtRate` เป็น **เปอร์เซ็นต์** ตาม snapshot ("1.00") — ก่อนเข้า computeDocumentTax ต้องผ่าน toCalcWhtRate() เสมอ
 * - ไม่ throw กับข้อมูลธุรกิจ: ขาดข้อมูล/แปลงหน่วยไม่ได้ → `CALCULATION_FAILURE` + เหตุผลครบทุกข้อ (ไม่หยุดที่ข้อแรก)
 *   สถานะไม่ใช่ AVAILABLE → `total = null`, `lines = []` (ห้ามใช้ยอดบางส่วนออกเอกสาร)
 */

export type PricingModel = 'PER_TRIP' | 'PER_KM' | 'PER_TON' | 'PER_CBM' | 'PER_UNIT' | 'PER_DAY';
export type PricingStatus = 'AVAILABLE' | 'RATE_MISSING' | 'CALCULATION_FAILURE';
export type UnitKind = 'COUNT' | 'WEIGHT' | 'VOLUME';

/** ส่วนของ snapshot รายการบริการ (ServiceItemSnapshot ของ API ตรงกับโครงนี้) ที่ engine ต้องใช้ */
export interface PricingServiceItem {
  sourceItemId: string;
  code: string;
  /** หน่วยคิด (PER_TRIP / PER_STOP / PER_HOUR / PERCENT_OF_FREIGHT / ACTUAL …) */
  unit: string;
  /** ราคาตั้งต้นบาท (ค่าบริการเสริมที่ rate card ไม่ได้กำหนดราคาเฉพาะ) — null = ไม่มี */
  unitPrice: string | null;
  vatType: ServiceItemVatType;
  /** เปอร์เซ็นต์ เช่น "1.00" */
  whtRate: ServiceItemWhtRate;
}

/** หน่วย (ตาราง `unit`) — WEIGHT มี toKg, VOLUME มี toCbm */
export interface PricingUnit {
  id: string;
  code?: string;
  kind: UnitKind;
  toKg?: string | null;
  toCbm?: string | null;
}

/** สินค้า + หน่วยแปลง (ตาราง `product` / `product_alt_unit`) — ใช้แปลงจำนวนเมื่อหน่วยของงานไม่ตรงกับหน่วยของราคา */
export interface PricingProduct {
  baseUnit: PricingUnit;
  /** น้ำหนักต่อ 1 หน่วยหลัก (กก.) */
  weightPerUnitKg?: string | null;
  /** ปริมาตรต่อ 1 หน่วยหลัก (ลบ.ม.) */
  volumePerUnitCbm?: string | null;
  /** 1 หน่วยนี้ = factorToBase หน่วยหลัก (1 พาเลท = 40 ถุง → 40) */
  altUnits?: readonly { unitId: string; factorToBase: string }[];
}

/** rate ที่ใช้คิด (snapshot จาก rate card — `findApplicableRate`) */
export interface PricingRate<S extends PricingServiceItem = PricingServiceItem> {
  rateCardId: string;
  code: string;
  revision: number;
  pricingModel: PricingModel;
  /** ราคาต่อหน่วยของสูตร (บาท, ≤ 2 ตำแหน่ง) */
  unitPrice: string;
  minCharge?: string | null;
  /** ค่าจุดเพิ่มต่อจุด — null = ไม่คิดค่าจุดเพิ่ม */
  extraStopPrice?: string | null;
  /** N จุดที่รวมในราคา */
  includedStops: number;
  /** PER_UNIT: หน่วยของราคา */
  unit?: PricingUnit | null;
  /** รายการบนเอกสารของค่าขนส่ง (ค่าเริ่มต้น FREIGHT) */
  serviceItem: S;
  /** รายการ EXTRA_STOP (บรรทัดค่าจุดเพิ่ม — MD-115) */
  extraStopItem?: S | null;
  /** ราคาค่าบริการเสริมเฉพาะของ rate card นี้ */
  accessorials?: readonly { serviceItemId: string; price: string }[];
}

export interface PricingQuantity {
  /** จำนวน (ทศนิยมได้) ≥ 0 */
  value: string;
  unit: PricingUnit;
  /** ใส่เมื่อต้องแปลงผ่านข้อมูลสินค้า (เช่น ถุง → ตัน) */
  product?: PricingProduct | null;
}

/** ข้อเท็จจริงของงาน */
export interface PricingShipment<S extends PricingServiceItem = PricingServiceItem> {
  /** ระยะทาง (กม.) จาก route master — PER_KM บังคับ */
  distanceKm?: string | null;
  /** จำนวนสินค้า (รวมหลายรายการได้) — PER_TON/PER_CBM/PER_UNIT บังคับ */
  quantities?: readonly PricingQuantity[] | null;
  /** จำนวนจุดทั้งหมด (รับ + ส่ง) */
  stops?: number | null;
  /** ค่าบริการเสริมที่เกิดกับงานนี้ (ราคา = ราคาเฉพาะใน rate card ก่อน แล้วจึงราคาตั้งต้นของรายการ) */
  accessorials?: readonly { serviceItem: S; qty: string }[] | null;
}

export type PricingLineKind = 'FREIGHT' | 'EXTRA_STOP' | 'ACCESSORIAL';

export interface PricingLine<S extends PricingServiceItem = PricingServiceItem> {
  kind: PricingLineKind;
  serviceItem: S;
  /** จำนวนตามสูตร (ทศนิยมสูงสุด 4 ตำแหน่ง ตัดศูนย์ท้าย — ค่าแสดงผล; amount คิดจากค่าจริงไม่ปัด) */
  qty: string;
  unitPrice: string;
  /** ยอดบรรทัด (บาท 2 ตำแหน่ง) — ถ้าใช้ขั้นต่ำ = minCharge */
  amount: string;
  /** ยอดตามสูตรก่อนเทียบขั้นต่ำ */
  calculatedAmount: string;
  minChargeApplied: boolean;
  vatType: ServiceItemVatType;
  /** เปอร์เซ็นต์ ("1.00") — แปลงด้วย toCalcWhtRate() ก่อนคำนวณภาษี */
  whtRate: ServiceItemWhtRate;
}

export type PricingReasonCode =
  | 'RATE_MISSING'
  | 'PRICING_MODEL_UNSUPPORTED'
  | 'INVALID_RATE'
  | 'DISTANCE_MISSING'
  | 'DISTANCE_INVALID'
  | 'QUANTITY_MISSING'
  | 'QUANTITY_INVALID'
  | 'RATE_UNIT_MISSING'
  | 'UNIT_CONVERSION_FAILED'
  | 'STOPS_MISSING'
  | 'STOPS_INVALID'
  | 'EXTRA_STOP_ITEM_MISSING'
  | 'ACCESSORIAL_PRICE_MISSING'
  | 'ACCESSORIAL_UNSUPPORTED'
  | 'ACCESSORIAL_QTY_INVALID';

export interface PricingReason {
  code: PricingReasonCode;
  /** ข้อความไทยสำหรับ log/ใบค้าง — UI ใช้ `code` แปลผ่าน i18n */
  message: string;
  /** ช่องข้อมูลที่เป็นต้นเหตุ */
  field?: string;
}

export const PRICING_REASON_TH: Record<PricingReasonCode, string> = {
  RATE_MISSING:
    'ไม่พบ rate card ที่ใช้ได้ (ลูกค้า/รถร่วม + ต้นทาง + ปลายทาง + ประเภทรถ ณ วันรับของ)',
  PRICING_MODEL_UNSUPPORTED: 'สูตรราคานี้ยังไม่รองรับในเฟส 0 (เหมาวัน)',
  INVALID_RATE: 'ราคาใน rate card ไม่ถูกต้อง',
  DISTANCE_MISSING: 'คิดตามระยะทางแต่ไม่มีระยะทาง (ยังไม่มีเส้นทางต้นทาง→ปลายทางที่ใช้งาน)',
  DISTANCE_INVALID: 'ระยะทางต้องมากกว่า 0',
  QUANTITY_MISSING: 'คิดตามน้ำหนัก/ปริมาตร/หน่วยนับแต่ไม่มีจำนวนสินค้า',
  QUANTITY_INVALID: 'จำนวนสินค้าไม่ถูกต้อง',
  RATE_UNIT_MISSING: 'rate card คิดตามหน่วยนับแต่ไม่ได้ระบุหน่วย',
  UNIT_CONVERSION_FAILED: 'แปลงหน่วยของสินค้าเป็นหน่วยของราคาไม่ได้',
  STOPS_MISSING: 'rate card คิดค่าจุดเพิ่มแต่ไม่ทราบจำนวนจุด',
  STOPS_INVALID: 'จำนวนจุดต้องเป็นจำนวนเต็มตั้งแต่ 1',
  EXTRA_STOP_ITEM_MISSING: 'ไม่พบรายการค่าจุดส่งเพิ่ม (EXTRA_STOP)',
  ACCESSORIAL_PRICE_MISSING:
    'ค่าบริการเสริมไม่มีราคา (ไม่มีทั้งราคาเฉพาะใน rate card และราคาตั้งต้น)',
  ACCESSORIAL_UNSUPPORTED: 'ค่าบริการเสริมแบบ % ของค่าขนส่ง/ตามจริง ยังคิดอัตโนมัติไม่ได้',
  ACCESSORIAL_QTY_INVALID: 'จำนวนของค่าบริการเสริมไม่ถูกต้อง',
};

export interface PricingResult<S extends PricingServiceItem = PricingServiceItem> {
  pricingStatus: PricingStatus;
  /** ยอดรวมก่อน VAT (บาท 2 ตำแหน่ง) — null เมื่อไม่ใช่ AVAILABLE */
  total: string | null;
  lines: PricingLine<S>[];
  reasons: PricingReason[];
  /** ค่าที่ใช้คิด (MD-117 snapshot) */
  params: {
    rateCardId: string | null;
    rateCode: string | null;
    rateRevision: number | null;
    pricingModel: PricingModel | null;
    unitPrice: string | null;
    minCharge: string | null;
    includedStops: number | null;
    extraStopPrice: string | null;
    distanceKm: string | null;
    /** จำนวนในหน่วยของราคา (ตัน / ลบ.ม. / หน่วยของ rate) */
    quantity: string | null;
    stops: number | null;
    extraStops: number | null;
  };
}

// ---------- เศษส่วน bigint (ไม่มี float) ----------

interface Q {
  n: bigint;
  d: bigint;
}
const DEC = /^\d+(\.\d+)?$/;
const ONE: Q = { n: 1n, d: 1n };

function q(value: string | null | undefined): Q | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!DEC.test(s)) return null;
  const [w, f = ''] = s.split('.') as [string, string?];
  return { n: BigInt(w + f), d: 10n ** BigInt(f.length) };
}
const mul = (a: Q, b: Q): Q => ({ n: a.n * b.n, d: a.d * b.d });
const div = (a: Q, b: Q): Q | null => (b.n === 0n ? null : { n: a.n * b.d, d: a.d * b.n });
const add = (a: Q, b: Q): Q => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const isZero = (a: Q) => a.n === 0n;

/** n/d ปัด half-up เป็นจำนวนเต็ม (ค่าบวกเท่านั้น) */
function roundHalfUp(n: bigint, d: bigint): bigint {
  const qt = n / d;
  return (n % d) * 2n >= d ? qt + 1n : qt;
}

/** สตางค์ × จำนวน → สตางค์ (ปัด half-up ครั้งเดียว) */
function amountOf(price: Satang, qty: Q): Satang {
  return roundHalfUp(price * qty.n, qty.d);
}

/** ค่าแสดงผล: ทศนิยม ≤ 4 ตำแหน่ง (half-up) ตัดศูนย์ท้าย */
function fmtQty(v: Q): string {
  const x = roundHalfUp(v.n * 10_000n, v.d);
  const whole = x / 10_000n;
  const frac = (x % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function money(value: string | null | undefined): Satang | null {
  if (value === null || value === undefined) return null;
  try {
    const s = satangFromDecimal(String(value).trim());
    return s < 0n ? null : s;
  } catch {
    return null;
  }
}

// ---------- แปลงหน่วย ----------

const TON: PricingUnit = { id: '__ton', kind: 'WEIGHT', toKg: '1000' };
const CBM: PricingUnit = { id: '__cbm', kind: 'VOLUME', toCbm: '1' };

/** 1 หน่วย `from` = ? หน่วย `to` โดยไม่ใช้ข้อมูลสินค้า (หน่วยเดียวกัน / น้ำหนัก↔น้ำหนัก / ปริมาตร↔ปริมาตร) */
function directFactor(from: PricingUnit, to: PricingUnit): Q | null {
  if (from.id === to.id) return ONE;
  if (from.kind !== to.kind) return null;
  const key = from.kind === 'WEIGHT' ? 'toKg' : from.kind === 'VOLUME' ? 'toCbm' : null;
  if (!key) return null;
  const a = q(from[key]);
  const b = q(to[key]);
  if (!a || !b || isZero(a)) return null;
  return div(a, b);
}

/** 1 หน่วย `u` = ? หน่วยหลักของสินค้า */
function factorToBase(p: PricingProduct, u: PricingUnit): Q | null {
  if (u.id === p.baseUnit.id) return ONE;
  const alt = p.altUnits?.find((a) => a.unitId === u.id);
  const f = alt ? q(alt.factorToBase) : null;
  return f && !isZero(f) ? f : null;
}

/** 1 หน่วยน้ำหนัก/ปริมาตร `u` = ? หน่วยหลักของสินค้า (ผ่านน้ำหนัก/ปริมาตรต่อหน่วยหลัก เช่น 1 ตัน ÷ 50 กก. = 20 ถุง) */
function measureToBase(p: PricingProduct, u: PricingUnit): Q | null {
  const [mine, per] =
    u.kind === 'WEIGHT'
      ? [q(u.toKg), q(p.weightPerUnitKg)]
      : u.kind === 'VOLUME'
        ? [q(u.toCbm), q(p.volumePerUnitCbm)]
        : [null, null];
  return mine && per && !isZero(per) ? div(mine, per) : null;
}

/** 1 หน่วยหลักของสินค้า = ? หน่วย `to` */
function baseToUnit(p: PricingProduct, to: PricingUnit): Q | null {
  const viaAlt = factorToBase(p, to);
  if (viaAlt) return div(ONE, viaAlt);
  const direct = directFactor(p.baseUnit, to);
  if (direct) return direct;
  // ผ่านน้ำหนัก/ปริมาตรต่อหน่วยหลัก
  if (to.kind === 'WEIGHT') {
    const kg = q(p.weightPerUnitKg);
    const toKg = q(to.toKg);
    return kg && toKg && !isZero(toKg) ? div(kg, toKg) : null;
  }
  if (to.kind === 'VOLUME') {
    const cbm = q(p.volumePerUnitCbm);
    const toCbm = q(to.toCbm);
    return cbm && toCbm && !isZero(toCbm) ? div(cbm, toCbm) : null;
  }
  return null;
}

/** จำนวน → หน่วย `to` (null = แปลงไม่ได้) */
export function convertQuantity(
  value: string,
  from: PricingUnit,
  to: PricingUnit,
  product?: PricingProduct | null,
): string | null {
  const v = q(value);
  if (!v) return null;
  const r = convertQ(v, from, to, product);
  return r ? fmtQty(r) : null;
}

function convertQ(
  v: Q,
  from: PricingUnit,
  to: PricingUnit,
  product?: PricingProduct | null,
): Q | null {
  const direct = directFactor(from, to);
  if (direct) return mul(v, direct);
  if (!product) return null;
  const toBase =
    factorToBase(product, from) ??
    directFactor(from, product.baseUnit) ??
    measureToBase(product, from);
  if (!toBase) return null;
  const out = baseToUnit(product, to);
  return out ? mul(mul(v, toBase), out) : null;
}

// ---------- engine ----------

const fail = (code: PricingReasonCode, field?: string): PricingReason => ({
  code,
  message: PRICING_REASON_TH[code],
  ...(field ? { field } : {}),
});

/**
 * คิดราคางานหนึ่งงานจาก rate ที่หาได้ (หรือ null = ไม่พบ rate)
 * ลำดับบรรทัด: ค่าขนส่ง → ค่าจุดเพิ่ม → ค่าบริการเสริม (ตามลำดับที่ส่งมา)
 */
export function priceShipment<S extends PricingServiceItem>(
  rate: PricingRate<S> | null | undefined,
  shipment: PricingShipment<S>,
): PricingResult<S> {
  const params: PricingResult<S>['params'] = {
    rateCardId: rate?.rateCardId ?? null,
    rateCode: rate?.code ?? null,
    rateRevision: rate?.revision ?? null,
    pricingModel: rate?.pricingModel ?? null,
    unitPrice: rate?.unitPrice ?? null,
    minCharge: rate?.minCharge ?? null,
    includedStops: rate?.includedStops ?? null,
    extraStopPrice: rate?.extraStopPrice ?? null,
    distanceKm: shipment.distanceKm ?? null,
    quantity: null,
    stops: shipment.stops ?? null,
    extraStops: null,
  };
  if (!rate) {
    return {
      pricingStatus: 'RATE_MISSING',
      total: null,
      lines: [],
      reasons: [fail('RATE_MISSING')],
      params,
    };
  }

  const reasons: PricingReason[] = [];
  const lines: PricingLine<S>[] = [];
  const line = (
    kind: PricingLineKind,
    item: S,
    qty: Q,
    price: Satang,
    min: Satang | null = null,
  ): PricingLine<S> => {
    const calculated = amountOf(price, qty);
    const minApplied = min !== null && calculated < min;
    return {
      kind,
      serviceItem: item,
      qty: fmtQty(qty),
      unitPrice: decimalFromSatang(price),
      amount: decimalFromSatang(minApplied ? min : calculated),
      calculatedAmount: decimalFromSatang(calculated),
      minChargeApplied: minApplied,
      vatType: item.vatType,
      whtRate: item.whtRate,
    };
  };

  // ราคาใน rate card
  const price = money(rate.unitPrice);
  if (price === null) reasons.push(fail('INVALID_RATE', 'unitPrice'));
  const hasMin = rate.minCharge !== null && rate.minCharge !== undefined;
  const min = hasMin ? money(rate.minCharge) : null;
  if (hasMin && min === null) reasons.push(fail('INVALID_RATE', 'minCharge'));
  const hasExtra = rate.extraStopPrice !== null && rate.extraStopPrice !== undefined;
  const extraPrice = hasExtra ? money(rate.extraStopPrice) : null;
  if (hasExtra && extraPrice === null) reasons.push(fail('INVALID_RATE', 'extraStopPrice'));
  if (!Number.isInteger(rate.includedStops) || rate.includedStops < 0)
    reasons.push(fail('INVALID_RATE', 'includedStops'));

  // จำนวนตามสูตร (MD-114)
  let qty: Q | null = null;
  switch (rate.pricingModel) {
    case 'PER_TRIP':
      qty = ONE;
      break;
    case 'PER_KM': {
      if (shipment.distanceKm === null || shipment.distanceKm === undefined) {
        reasons.push(fail('DISTANCE_MISSING', 'distanceKm'));
        break;
      }
      const dist = q(shipment.distanceKm);
      if (!dist || isZero(dist)) reasons.push(fail('DISTANCE_INVALID', 'distanceKm'));
      else qty = dist;
      break;
    }
    case 'PER_TON':
    case 'PER_CBM':
    case 'PER_UNIT': {
      const target =
        rate.pricingModel === 'PER_TON' ? TON : rate.pricingModel === 'PER_CBM' ? CBM : rate.unit;
      if (!target) {
        reasons.push(fail('RATE_UNIT_MISSING', 'unitId'));
        break;
      }
      const list = shipment.quantities ?? [];
      if (list.length === 0) {
        reasons.push(fail('QUANTITY_MISSING', 'quantity'));
        break;
      }
      let sum: Q = { n: 0n, d: 1n };
      let ok = true;
      for (const [i, x] of list.entries()) {
        const v = q(x.value);
        if (!v) {
          reasons.push(fail('QUANTITY_INVALID', `quantities[${i}].value`));
          ok = false;
          continue;
        }
        const c = convertQ(v, x.unit, target, x.product);
        if (!c) {
          reasons.push(fail('UNIT_CONVERSION_FAILED', `quantities[${i}].unit`));
          ok = false;
          continue;
        }
        sum = add(sum, c);
      }
      // ยอดรวม 0 = ข้อมูลผิด (ไม่ใช่ "คิดขั้นต่ำ") — กันออกราคาขั้นต่ำให้งานที่ลืมกรอกน้ำหนัก
      if (ok && isZero(sum)) reasons.push(fail('QUANTITY_INVALID', 'quantity'));
      qty = ok && !isZero(sum) ? sum : null;
      if (qty) params.quantity = fmtQty(qty);
      break;
    }
    default:
      reasons.push(fail('PRICING_MODEL_UNSUPPORTED', 'pricingModel'));
  }
  if (qty && price !== null && (!hasMin || min !== null))
    lines.push(line('FREIGHT', rate.serviceItem, qty, price, min));

  // ค่าจุดเพิ่ม (MD-115): max(0, จุด − N) × ราคา/จุด — rate ไม่ตั้งราคา (null) หรือ 0 = ไม่คิด
  const stops = shipment.stops;
  if (stops !== null && stops !== undefined && (!Number.isInteger(stops) || stops < 1)) {
    reasons.push(fail('STOPS_INVALID', 'stops'));
  } else if (extraPrice !== null && extraPrice > 0n && Number.isInteger(rate.includedStops)) {
    if (stops === null || stops === undefined) reasons.push(fail('STOPS_MISSING', 'stops'));
    else {
      const extra = Math.max(0, stops - rate.includedStops);
      params.extraStops = extra;
      if (extra > 0) {
        if (!rate.extraStopItem) reasons.push(fail('EXTRA_STOP_ITEM_MISSING', 'extraStopItem'));
        else
          lines.push(
            line('EXTRA_STOP', rate.extraStopItem, { n: BigInt(extra), d: 1n }, extraPrice),
          );
      }
    }
  } else if (stops !== null && stops !== undefined && Number.isInteger(rate.includedStops)) {
    params.extraStops = Math.max(0, stops - rate.includedStops);
  }

  // ค่าบริการเสริม: ราคาเฉพาะใน rate card → ราคาตั้งต้นของรายการ
  (shipment.accessorials ?? []).forEach((a, i) => {
    const field = `accessorials[${i}]`;
    const aq = q(a.qty);
    if (!aq || isZero(aq)) {
      reasons.push(fail('ACCESSORIAL_QTY_INVALID', `${field}.qty`));
      return;
    }
    if (a.serviceItem.unit === 'PERCENT_OF_FREIGHT' || a.serviceItem.unit === 'ACTUAL') {
      reasons.push(fail('ACCESSORIAL_UNSUPPORTED', field));
      return;
    }
    const special = rate.accessorials?.find((x) => x.serviceItemId === a.serviceItem.sourceItemId);
    const p = money(special ? special.price : a.serviceItem.unitPrice);
    if (p === null) {
      reasons.push(fail('ACCESSORIAL_PRICE_MISSING', field));
      return;
    }
    lines.push(line('ACCESSORIAL', a.serviceItem, aq, p));
  });

  if (reasons.length > 0)
    return { pricingStatus: 'CALCULATION_FAILURE', total: null, lines: [], reasons, params };
  return {
    pricingStatus: 'AVAILABLE',
    total: decimalFromSatang(sumSatang(lines.map((l) => satangFromDecimal(l.amount)))),
    lines,
    reasons: [],
    params,
  };
}
