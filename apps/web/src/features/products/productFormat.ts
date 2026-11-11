import type { T } from '../../i18n';
import { tempRange } from '../master/format';
import type { MessageKey } from '../../i18n/th';
import type { Product, Special, Unit } from './useProducts';

export const num = (n: number, max = 3) =>
  n.toLocaleString('th-TH', { maximumFractionDigits: max });

export const kgText = (t: T, p: Product) =>
  p.weightPerUnitKg === null ? '—' : t('prd.kg', { n: num(p.weightPerUnitKg, 3) });
export const cbmText = (t: T, p: Product) =>
  p.volumePerUnitCbm === null ? '—' : t('prd.cbm', { n: num(p.volumePerUnitCbm, 4) });

/** ประเภทพิเศษของสินค้า (เรียงตามต้นแบบ: เปราะบาง อันตราย ควบคุมอุณหภูมิ) */
export function specialsOf(
  p: Pick<Product, 'fragile' | 'hazardous' | 'tempControlled'>,
): Special[] {
  const out: Special[] = [];
  if (p.fragile) out.push('fragile');
  if (p.hazardous) out.push('hazardous');
  if (p.tempControlled) out.push('temp');
  return out;
}

export const specialText = (t: T, p: Product) =>
  specialsOf(p)
    .map((s) => t(`prd.sp.${s}` as MessageKey))
    .join(', ');

export const tempText = (_t: T, p: Product) =>
  p.tempMinC !== null && p.tempMaxC !== null ? tempRange(p.tempMinC, p.tempMaxC) : '';

export const unText = (t: T, p: Product) =>
  p.unNumber && p.hazardClass ? t('prd.un', { u: p.unNumber, c: p.hazardClass }) : '';

/** บรรทัดรองของคอลัมน์ "ประเภทพิเศษ" (ต้นแบบ: ช่วงอุณหภูมิ หรือ UN · Class) */
export const specialSub = (t: T, p: Product) =>
  [tempText(t, p), unText(t, p)].filter(Boolean).join(' · ');

export const unitKindLabel = (t: T, k: Unit['kind']) => t(`unit.kind.${k}` as MessageKey);

export function unitConvText(t: T, u: Pick<Unit, 'name' | 'toKg' | 'toCbm'>): string {
  if (u.toKg !== null) return t('unit.conv.kg', { u: u.name, n: num(u.toKg, 6) });
  if (u.toCbm !== null) return t('unit.conv.cbm', { u: u.name, n: num(u.toCbm, 6) });
  return '—';
}
