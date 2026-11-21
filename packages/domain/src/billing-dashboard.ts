/**
 * ST9-T02 Dashboard บิล (docs/04 H "Dashboard บิล", spec/09 §1 การ์ดบิล — **ย่อตาม D-54: ไม่มีการ์ด "WHT รอ 50 ทวิ"**)
 * ช่องเดือน "เดือนนี้ vs เดือนก่อน" ตามเวลาไทย (RPT-002) — วันนี้มาจาก `bangkokToday(Clock)` ของ server
 * ไฟล์นี้ไม่มี import ตอนรัน (web ใช้ซอร์สตรงได้เหมือน `ops-dashboard.ts`)
 */
export interface DayRange {
  /** วันแรก (YYYY-MM-DD รวม) */
  from: string;
  /** วันสุดท้าย (YYYY-MM-DD รวม) */
  to: string;
}

export interface MonthRanges {
  /** เดือนนี้ = วันที่ 1 ถึงวันนี้ (month-to-date) */
  thisMonth: DayRange & { month: string };
  /** เดือนก่อน = ทั้งเดือน (วันที่ 1 ถึงวันสุดท้ายของเดือน) */
  lastMonth: DayRange & { month: string };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** วันสุดท้ายของเดือน (ปีอธิกสุรทินถูกต้อง) */
function lastDay(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * ช่วงวันที่ของเดือนนี้ (ถึงวันนี้) และเดือนก่อน (ทั้งเดือน) จาก `today` (YYYY-MM-DD เวลาไทย)
 * มกราคม → เดือนก่อน = ธันวาคมปีก่อน
 */
export function billingMonthRanges(today: string): MonthRanges {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!m) throw new Error(`invalid date: ${today}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const py = mo === 1 ? y - 1 : y;
  const pm = mo === 1 ? 12 : mo - 1;
  return {
    thisMonth: { month: `${y}-${pad(mo)}`, from: `${y}-${pad(mo)}-01`, to: today },
    lastMonth: {
      month: `${py}-${pad(pm)}`,
      from: `${py}-${pad(pm)}-01`,
      to: `${py}-${pad(pm)}-${pad(lastDay(py, pm))}`,
    },
  };
}
