import type { MessageKey } from '../../i18n/th';

/**
 * ST9-T02 Dashboard บิล (docs/04 H; spec/09 §1 การ์ดบิล — **ย่อ D-54: ไม่มีการ์ด "WHT รอ 50 ทวิ"**)
 * การ์ดแต่ละใบ = แท็บของหน้าต้นทาง (คลิก = เปิดหน้านั้นที่แท็บเดียวกัน — RPT-005) ตัวเลขมาจาก summary ที่นับด้วยตัวกรองเดียวกับแท็บ:
 * - ร่าง / ออกแล้วรอชำระ / ชำระบางส่วน = `GET /invoices/summary` (แท็บของหน้าต้นทาง — ไม่รวมใบเกินกำหนด ST5-T18)
 * - ครบกำหนด = `GET /invoices/summary` `due` (D-81 · D68-94 — docs/04 H): ใบค้างที่ dueDate ≤ วันนี้ **รวมเกินกำหนด**
 *   → หน้ารับชำระ ตัวกรอง "ครบกำหนด" (`/pay?tab=due` = `receivable=due`) · ซ้อนกับ "ออกแล้วรอชำระ"/"ชำระบางส่วน" เฉพาะใบที่ครบวันนี้
 * - ค้างวางบิล = `GET /invoices/queue` `totals` (คิวพร้อมวางบิล ST5-T04 — ยอดก่อน VAT)
 * - ลูกหนี้ค้างชำระ / รับชำระเดือนนี้-ก่อน = `GET /payments/summary`
 * เดิม "ครบกำหนด" = ใบเกินกำหนดเท่านั้น [DECISION spec/12 §3 ST9-T02] → PO ให้ตาม docs (D-81 · D68-94, 23 พ.ย. 2569)
 */
export type BillTileKey = 'draft' | 'ready' | 'issued' | 'due' | 'partial';

export interface BillTile {
  key: BillTileKey;
  label: MessageKey;
  /** หน้า + แท็บที่คลิกลงไป (`?tab=` อ่านโดย BillPage / PayPage) */
  link: string;
  /** สีตัวเลข (ต้นแบบการ์ดลูกหนี้: เกินกำหนด = แดง) */
  color: string;
}

export const BILL_TILES: BillTile[] = [
  { key: 'draft', label: 'dash.bill.draft', link: '/bill?tab=DRAFT', color: '#101418' },
  { key: 'ready', label: 'dash.bill.ready', link: '/bill', color: '#101418' },
  { key: 'issued', label: 'dash.bill.issued', link: '/bill?tab=ISSUED', color: '#101418' },
  { key: 'due', label: 'dash.bill.due', link: '/pay?tab=due', color: '#B3322A' },
  { key: 'partial', label: 'dash.bill.partial', link: '/pay?tab=part', color: '#101418' },
];

/** การ์ดลูกหนี้ (ต้นแบบ `dash.ar`) — ค้างรับ / เกินกำหนด → หน้ารับชำระ */
export const AR_LINKS = { open: '/pay?tab=open', over: '/pay?tab=over', pay: '/pay' } as const;

/** KPI "ใบแจ้งหนี้เกินกำหนด" (ต้นแบบ kpis('dash') ใบที่ 4 เมื่อไม่ได้เชื่อมระบบบัญชี → go('pay', { tab: 'over' })) */
export const OVERDUE_KPI_LINK = '/pay?tab=over';
