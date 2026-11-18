import { scopeAllows } from '@tms/domain';
import type { ExportSpec } from '../exports/export-spec';
import type { ExportColumn } from '../master/export';
import { OrderListQuery, type OrderDto } from './order.dto';
import type { OrdersService } from './orders.service';

/** ชื่อสถานะ SO (ไทยตรงกับหน้า SO — `ord.st.*`) */
const STATUS_TH: Record<string, string> = {
  draft: 'ร่าง',
  received: 'รับคำสั่งแล้ว',
  on_hold: 'ค้าง',
  planned: 'จัดรถแล้ว',
  in_transit: 'ระหว่างส่ง',
  partially_delivered: 'ส่งบางส่วน',
  delivered: 'ส่งแล้ว',
  closed: 'ปิดงาน',
  cancelled: 'ยกเลิก',
};

/** วันเวลา Bangkok YYYY-MM-DD HH:MM */
const bkk = (iso: string | null | undefined) =>
  iso
    ? new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')
    : null;

/** กำหนดส่ง = วันนัดใหม่ / ปลายช่วงเวลาของจุดส่งสุดท้าย / วันรับของ (เหมือนคอลัมน์ "กำหนดส่ง" ของหน้า SO) */
function due(r: OrderDto): string {
  if (r.rescheduledDate) return r.rescheduledDate;
  const last = [...r.stops].reverse().find((s) => s.type === 'DELIVERY');
  const iso = last?.windowEnd ?? last?.windowStart;
  return iso ? bkk(iso)! : r.requestedDate;
}

/** น้ำหนักรวม (กก.) — บวกทศนิยม 3 ตำแหน่งแบบจำนวนเต็ม (ไม่ใช้ float) */
function totalWeight(r: OrderDto): string | null {
  let g = 0n;
  let any = false;
  for (const l of r.lines) {
    if (!l.weightKg) continue;
    const [i = '0', f = ''] = l.weightKg.split('.');
    g += BigInt(i) * 1000n + BigInt((f + '000').slice(0, 3));
    any = true;
  }
  if (!any) return null;
  const frac = (g % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${g / 1000n}${frac ? `.${frac}` : ''}`;
}

/**
 * คอลัมน์ไฟล์ส่งออก SO/ใบค้าง (ST9-T10) — ลำดับตามตารางหน้า SO (เลข SO · ลูกค้า · เส้นทาง · น้ำหนัก · กำหนดส่ง · เหตุผล/สถานะ · ที่มา)
 * แล้วตามด้วยข้อมูลอ้างอิง · ยอดขาย (ก่อน VAT) เฉพาะผู้มี `prices.sell:read`
 */
export function orderExportColumns(sellPrices: boolean): ExportColumn<OrderDto>[] {
  return [
    { header: 'เลข SO', value: (r) => r.soNo },
    { header: 'รหัสลูกค้า', value: (r) => r.customer.code },
    { header: 'ลูกค้า', value: (r) => r.customer.legalName ?? r.customer.name },
    { header: 'เส้นทาง', value: (r) => r.stops.map((s) => s.siteText).join(' → ') },
    { header: 'น้ำหนัก (กก.)', value: (r) => totalWeight(r) },
    { header: 'วันรับของ', value: (r) => r.requestedDate },
    { header: 'กำหนดส่ง', value: (r) => due(r) },
    { header: 'สถานะ', value: (r) => STATUS_TH[r.status] ?? r.status },
    { header: 'เหตุค้าง', value: (r) => r.holdReason?.label ?? null },
    { header: 'รหัสเหตุค้าง', value: (r) => r.holdCodes.join(', ') || null },
    { header: 'ที่มา', value: (r) => r.source },
    { header: 'เลขอ้างอิงลูกค้า', value: (r) => r.customerRef },
    { header: 'เลขอ้างอิงต้นทาง', value: (r) => r.externalId },
    ...(sellPrices
      ? [{ header: 'ยอดขาย (ก่อน VAT)', value: (r: OrderDto) => r.sellTotal ?? null }]
      : []),
    { header: 'สร้างเมื่อ', value: (r) => bkk(r.createdAt) },
    { header: 'แก้ล่าสุด', value: (r) => bkk(r.updatedAt) },
  ];
}

/** ใบสั่งขนส่ง (SO) และหน้าใบค้าง (`held=true`) — `GET /v1/orders` (orders:read) */
export const ordersExportSpec = (svc: OrdersService): ExportSpec<OrderListQuery, OrderDto> => ({
  resource: 'orders',
  label: 'ใบสั่งขนส่ง',
  fileBase: 'orders',
  scope: 'orders:read',
  idKind: 'salesOrder',
  query: OrderListQuery,
  fetch: (q, page) => svc.exportRows(q, page),
  columns: (scopes) => orderExportColumns(scopeAllows(scopes, 'prices.sell:read')),
});
