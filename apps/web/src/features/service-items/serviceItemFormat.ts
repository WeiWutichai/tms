import type { T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import type { CalcUnit, ServiceItem, Side, VatType, WhtRate } from './useServiceItems';

/** รูปแบบเงินของต้นแบบ (fmt: en-US ทศนิยม 2 ตำแหน่ง) — แสดงผลเท่านั้น ไม่คำนวณ */
export const money = (s: string) =>
  Number(s).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (s: string) => Number(s).toLocaleString('en-US', { maximumFractionDigits: 2 });

export const unitText = (t: T, u: CalcUnit) => t(`svc.u.${u}` as MessageKey);
export const vatText = (t: T, v: VatType) => t(`svc.vat.${v}` as MessageKey);
export const whtText = (t: T, w: WhtRate) => t(`svc.wht.${w}` as MessageKey);
export const sideText = (t: T, s: Side) => t(`svc.side.${s}` as MessageKey);

/**
 * ราคาในตาราง (ต้นแบบ specAx): ตามจริง → "ตามใบเสร็จ", % → "4.5%", อื่น → 500.00
 * ไม่มีราคาตั้งต้น (ค่าขนส่ง/FSC ของชุดเริ่มต้น — ราคามาจาก rate card) → "ตาม rate card" [ต้นแบบไม่มีกรณีนี้]
 */
export function priceText(t: T, r: ServiceItem, withBaht = false): string {
  if (r.calcUnit === 'ACTUAL') return t('svc.byReceipt');
  if (r.defaultPrice === null) return t('svc.byRate');
  if (r.calcUnit === 'PERCENT_OF_FREIGHT') return t('svc.pct', { n: pct(r.defaultPrice) });
  return withBaht ? t('svc.baht', { n: money(r.defaultPrice) }) : money(r.defaultPrice);
}

/** เงื่อนไข (ต้นแบบเก็บ "อิงดีเซล 31.50 ฿/ลิตร · {เงื่อนไข}" ในข้อความเดียว — เราเก็บแยกแล้วต่อเมื่อแสดง) */
export function condText(t: T, r: ServiceItem): string {
  return [r.fuelRefPrice ? t('svc.fuelRef', { n: money(r.fuelRefPrice) }) : '', r.condition ?? '']
    .filter(Boolean)
    .join(' · ');
}
