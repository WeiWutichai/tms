/**
 * วันทำการ (จันทร์–ศุกร์ ตามเวลาไทย) — P1-ST2-T06 SLA คิวอนุมัติ 1 วันทำการ / owner ตอบคำขอเข้าร่วม 3 วันทำการ (spec/01 §10.3, PLT-107)
 * วันหยุดนักขัตฤกษ์ไม่นับ (ระบบยังไม่มีปฏิทินวันหยุด — แบบเดียวกับ document-reconcile "วันทำการสุดท้ายของเดือน") [OPEN — PO]
 */
const BKK_MS = 7 * 3600_000;
const DAY_MS = 86_400_000;

const isWeekendBkk = (ms: number) => {
  const d = new Date(ms + BKK_MS).getUTCDay();
  return d === 0 || d === 6;
};

/**
 * เวลา + n วันทำการ: เดินทีละวัน (เวลาเดิมของวัน) ข้ามเสาร์–อาทิตย์ · เริ่มในวันหยุด = นับจากเริ่มวันทำการถัดไป
 * เช่น ศุกร์ 10:00 + 1 = จันทร์ 10:00 · เสาร์ 10:00 + 1 = อังคาร 00:00 (เวลาไทย)
 */
export function addBusinessDays(from: Date, n: number): Date {
  let ms = from.getTime();
  if (isWeekendBkk(ms)) {
    // ไปเริ่มวันจันทร์ 00:00 เวลาไทย
    const startOfDay = Math.floor((ms + BKK_MS) / DAY_MS) * DAY_MS - BKK_MS;
    ms = startOfDay;
    while (isWeekendBkk(ms)) ms += DAY_MS;
  }
  let left = n;
  while (left > 0) {
    ms += DAY_MS;
    if (!isWeekendBkk(ms)) left--;
  }
  return new Date(ms);
}
