import type { LoadIssue } from '@tms/domain';

/**
 * ข้อความไทยของกฎตอนจัด (ST3-T14) ที่ไม่มีตัวห่อของตัวเอง — ใช้ร่วมกันระหว่างผลตรวจของเที่ยว (`TripService.refreshWarnings`)
 * กับการเน้นรถ/งานที่รับได้บนกระดาน (ST3-T15) ให้ข้อความตรงกันทุกที่ (API-first)
 */
const fmtN = (x: string) => Number(x).toLocaleString('en-US', { maximumFractionDigits: 3 });

/** น้ำหนัก/ปริมาตรเกิน (`checkLoad`) */
export const loadMessageTh = (i: LoadIssue): string =>
  i.code === 'OVERWEIGHT'
    ? `น้ำหนักเกิน ${fmtN(i.params.over)} กก. (${fmtN(i.params.load)} / ${fmtN(i.params.capacity)} กก.)`
    : `ปริมาตรเกิน ${fmtN(i.params.over)} ลบ.ม. (${fmtN(i.params.load)} / ${fmtN(i.params.capacity)} ลบ.ม.)`;

/** รถไม่พร้อม (ซ่อม/จอด) */
export const vehicleNotReadyMessageTh = (plate: string | null, status: string): string =>
  `รถ ${plate ?? ''} อยู่ในสถานะ${status === 'MAINTENANCE' ? 'ซ่อม' : 'จอด'}`;

const TH_MONTHS_SHORT = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
];
/** "2026-11-18" → "18 พ.ย. 2569" */
export const thaiShortDate = (ymd: string): string => {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${d} ${TH_MONTHS_SHORT[m! - 1]} ${y! + 543}`;
};

/**
 * คนขับ/คนขับสำรองลา — สถานะ "ลาพัก" (ไม่มีวัน) หรือวันลาในตารางรถ/คนขับรายวัน (ST3-T19 — ระบุวัน)
 */
export const driverOnLeaveMessageTh = (
  role: 'driver' | 'relief',
  name: string | null,
  dates: readonly string[] = [],
): string =>
  `${role === 'driver' ? 'คนขับ' : 'คนขับสำรอง'} ${name ?? ''} ` +
  (dates.length ? `ลาวันที่ ${dates.map(thaiShortDate).join(', ')}` : 'ลาอยู่');

/** รถมีเที่ยวอื่นในช่วงเวลาเดียวกัน */
export const vehicleOverlapMessageTh = (plate: string | null, tripNos: string[]): string =>
  `รถ ${plate ?? ''} มีเที่ยวอื่นในช่วงเวลาเดียวกัน: ${tripNos.join(', ')}`;
