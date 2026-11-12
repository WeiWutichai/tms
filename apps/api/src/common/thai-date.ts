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
