import type { T } from '../../i18n';
import type { TripDetail } from './useTrips';

/**
 * Multi-drop (ST3-T16) — ฟังก์ชันล้วนของ drawer เที่ยวรถ: เลื่อนจุด, ตรวจ "ส่งก่อนรับ" ฝั่ง client (server ตรวจซ้ำ —
 * 422 `stop_order_invalid`), ข้อความระยะ/เวลา
 */

/** สลับจุดที่ `i` กับจุดถัดไป/ก่อนหน้า (`d` = ±1) — ขอบ = null (ต้นแบบ mv ไม่ทำอะไร) */
export function moveStop(ids: readonly string[], i: number, d: -1 | 1): string[] | null {
  const j = i + d;
  if (i < 0 || i >= ids.length || j < 0 || j >= ids.length) return null;
  const out = [...ids];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** ใบส่งของใบแรกที่จุดส่งไม่อยู่หลังจุดรับในลำดับใหม่ (กฎเดียวกับ `stopOrderViolations` ของ @tms/domain) */
export function firstOrderViolation(
  trip: Pick<TripDetail, 'deliveryOrders'>,
  order: readonly string[],
): { doNo: string } | null {
  const pos = new Map(order.map((id, i) => [id, i] as const));
  for (const d of trip.deliveryOrders) {
    if (!d.pickupStopId || !d.dropStopId) continue;
    const p = pos.get(d.pickupStopId);
    const q = pos.get(d.dropStopId);
    if (p !== undefined && q !== undefined && q <= p) return { doNo: d.doNo };
  }
  return null;
}

/** 182.4 → "182.4" (หลักพันแบบไทย) */
export const kmText = (km: string | number) =>
  Number(km).toLocaleString('th-TH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** นาที → "3 ชม. 50 นาที" / "45 นาที" */
export function durationText(t: T, minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return t('trip.min', { m });
  return m === 0 ? t('trip.hr', { h }) : t('trip.hrMin', { h, m });
}

/** ระยะรวมของเที่ยว (ช่อง "ระยะทางรวม") — ค่าประมาณ/ช่วงที่ไม่ทราบบอกต่อท้าย */
export function routeDistanceText(t: T, r: TripDetail['route']): string {
  if (r.distanceKm === null) return r.missingLegs ? t('trip.route.unknown') : '—';
  let s = t('trip.km', { km: kmText(r.distanceKm) });
  if (r.estimated) s += ` ${t('trip.route.estimated')}`;
  if (r.missingLegs) s += ` · ${t('trip.route.missing', { n: r.missingLegs })}`;
  return s;
}

/** ช่วงวิ่งของจุด (ช่องขวาของแถว): "+45.2 กม." · ค่าประมาณ "≈ +45.2 กม." · ไม่ทราบ "ไม่ทราบระยะ" · จุดแรก = '' */
export function legText(t: T, s: TripDetail['stops'][number], first: boolean): string {
  if (first) return '';
  if (s.legSource === null || s.legDistanceKm === null) return t('trip.leg.unknown');
  const v = t('trip.leg.km', { km: kmText(s.legDistanceKm) });
  return s.legSource === 'ESTIMATE' ? `≈ ${v}` : v;
}
