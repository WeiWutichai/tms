const TH_MONTHS_FULL = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
];

/** วันที่บนเอกสาร: "3 พฤศจิกายน 2569" (พ.ศ.) หรือ "3 พฤศจิกายน 2026" (ค.ศ.) ตามที่ tenant ตั้ง (D-30) — ใช้เวลาไทย */
export function docDate(d: Date, yearStyle: 'BE' | 'CE'): string {
  const bkk = new Date(d.getTime() + 7 * 3600_000);
  const y = bkk.getUTCFullYear() + (yearStyle === 'BE' ? 543 : 0);
  return `${bkk.getUTCDate()} ${TH_MONTHS_FULL[bkk.getUTCMonth()]} ${y}`;
}

const TH_MONTHS_ABBR = [
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

/** วันที่ (date-only `YYYY-MM-DD`) แบบย่อบนเอกสาร: "3 พ.ย. 2569" (ต้นแบบ TMS Print ใบคุมรถ) — ปีตามที่ tenant ตั้ง (D-30) */
export function docDateShort(ymd: string, yearStyle: 'BE' | 'CE'): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${d} ${TH_MONTHS_ABBR[m! - 1]} ${y! + (yearStyle === 'BE' ? 543 : 0)}`;
}

/** เวลาไทย HH:MM */
export function bkkTime(d: Date): string {
  const b = new Date(d.getTime() + 7 * 3600_000);
  return `${String(b.getUTCHours()).padStart(2, '0')}:${String(b.getUTCMinutes()).padStart(2, '0')}`;
}
