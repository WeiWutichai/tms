import { formatDate, useI18n, type T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { useMe } from '../../shell/AppShell';
import type { RateCard, RateStatus } from './useRateCards';

/** ป้ายสถานะ (ต้นแบบ: มีผล / รออนุมัติ / หมดอายุ) — ร่างเฟส 0 = "รออนุมัติ" (อนุมัติได้ทันที) · ยกเลิก = ป้าย "ยกเลิก" */
export function rateStatusLabel(t: T, s: RateStatus): string {
  if (s === 'active') return t('rc.st.active');
  if (s === 'expired') return t('rc.st.expired');
  if (s === 'retired') return t('rc.st.retired');
  return t('rc.st.draft');
}

/** หน่วยของสูตร: เที่ยว / กม. / ตัน / ลบ.ม. / ชื่อหน่วยนับ */
export function rateUnit(t: T, model: string, unitName?: string | null): string {
  if (model === 'PER_UNIT') return unitName ?? t('rc.f.PER_UNIT');
  return t(`rc.u.${model}` as MessageKey);
}

export const modelLabel = (t: T, model: string) => t(`rc.f.${model}` as MessageKey);

/** เงินจาก API เป็นข้อความ "6500.00" → "6,500.00" (ต้นแบบ fmt — ไม่แปลงเป็น float) */
export function money(v: string | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const [i = '0', f = ''] = v.split('.');
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f.padEnd(2, '0').slice(0, 2)}`;
}

/** วันที่ "3 พ.ย. 2569" ตามปี พ.ศ./ค.ศ. ของบริษัท */
export function useDateText() {
  const { lang } = useI18n();
  const me = useMe();
  const ys = (me.data?.tenant.yearStyle as 'BE' | 'CE') ?? 'BE';
  return (iso: string) => formatDate(new Date(`${iso}T00:00:00`), lang, ys);
}

export const routeText = (r: RateCard) => `${r.origin.name} → ${r.destination.name}`;

/** วันนี้ตามเวลาไทย (UTC+7 ไม่มี DST) YYYY-MM-DD — ความหมายเดียวกับ API (`bangkokToday` ฝั่ง API) */
export function bangkokToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD + n วัน */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
