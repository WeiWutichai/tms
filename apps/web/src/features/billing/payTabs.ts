/** แท็บของหน้า "รับชำระ" (ต้นแบบ specPay tabs) — ที่แสดงเป็นแท็บ */
export const PAY_TABS = ['all', 'open', 'over', 'part', 'paid'] as const;
/**
 * D-81 · D68-94 มุมมอง "ครบกำหนด" (docs/04 H — การ์ด Dashboard บิล): ไม่ใช่แท็บของต้นแบบ — เปิดจากลิงก์ `/pay?tab=due` เท่านั้น
 * แสดงเป็นชิปตัวกรอง (แบบชิป "อายุหนี้" ของต้นแบบ) ให้จำนวนแถว = ตัวเลขบนการ์ด
 */
export type PayTab = (typeof PAY_TABS)[number] | 'due';
export const PAY_URL_TABS: readonly PayTab[] = [...PAY_TABS, 'due'];
/** แท็บ → ตัวกรอง API */
export const PAY_TAB_QUERY: Record<PayTab, Record<string, string>> = {
  all: { receivable: 'all' },
  open: { receivable: 'open' },
  over: { receivable: 'overdue' },
  // ต้นแบบ invSt: ใบเกินกำหนดอยู่แท็บ "เกินกำหนด" (ไม่ซ้ำในแท็บชำระบางส่วน — ST5-T18)
  part: { receivable: 'all', status: 'PARTIALLY_PAID', overdue: 'false' },
  paid: { receivable: 'all', status: 'PAID' },
  // ครบกำหนด = ค้างรับที่ dueDate ≤ วันนี้ รวมเกินกำหนด (ชุดเดียวกับ `GET /invoices/summary` `due`)
  due: { receivable: 'due' },
};
