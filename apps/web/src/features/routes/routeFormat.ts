import type { T } from '../../i18n';
import type { Route } from './useRoutes';

const num = (n: number) => n.toLocaleString('th-TH');

export const routeName = (r: Route) => `${r.origin.name} → ${r.destination.name}`;
export const kmText = (t: T, r: Route) => t('rt.km', { n: num(r.distanceKm) });
/** เวลามาตรฐาน: < 60 นาที = "45 นาที", ไม่งั้น "2 ชม. 30 นาที" */
export function timeText(t: T, min: number | null): string {
  if (min === null) return '—';
  if (min < 60) return t('rt.min', { n: min });
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? t('rt.hm', { h: num(h), m }) : t('rt.h', { h: num(h) });
}
/** เงินจาก API เป็นข้อความ "1234.50" → "1,234.50" (จัดรูปแบบจากข้อความ ไม่แปลงเป็น float) */
export function moneyText(v: string | null): string {
  if (v === null) return '—';
  const [i = '0', f = ''] = v.split('.');
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f.padEnd(2, '0').slice(0, 2)}`;
}
export const tollText = (r: Route) => moneyText(r.tollAmount);
