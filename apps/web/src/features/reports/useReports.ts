import type { Schemas } from '@tms/contracts';
import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from '../../api';

export type UnbilledReport = Schemas['UnbilledReportDto'];
export type UnbilledRow = Schemas['UnbilledDeliveryOrderDto'];
export type AgingCustomer = Schemas['AgingCustomerDto'];

/** แถวที่โหลดมาแสดงบนจอได้สูงสุด — ที่เหลือส่งออก Excel (ไฟล์มีทุกแถว) */
export const REPORT_MAX_ROWS = 1000;
const PAGE = 200;

/** key เดียวกับใบแจ้งหนี้/รับชำระ — ออกใบ/รับชำระแล้วรายงานโหลดใหม่ */
const KEY = 'invoices';

/** "DO ยังไม่วางบิลเกิน N วัน" (ST9-T06 — `GET /v1/reports/unbilled-delivery-orders`) · N = ค่าตั้งองค์กร */
export function useUnbilledReport(enabled: boolean) {
  return useQuery({
    queryKey: [KEY, 'reports', 'unbilled'],
    enabled,
    queryFn: async () => {
      const first = await unwrap(
        api.GET('/v1/reports/unbilled-delivery-orders', { params: { query: { limit: PAGE } } }),
      );
      const rows: UnbilledRow[] = [...first.data];
      let cursor = first.nextCursor;
      while (cursor && rows.length < REPORT_MAX_ROWS) {
        const p = await unwrap(
          api.GET('/v1/reports/unbilled-delivery-orders', {
            params: { query: { limit: PAGE, cursor } },
          }),
        );
        rows.push(...p.data);
        cursor = p.nextCursor;
      }
      return { ...first, data: rows.slice(0, REPORT_MAX_ROWS) };
    },
  });
}

/**
 * ลูกหนี้คงค้างต่อลูกค้า (ST9-T06) — `GET /v1/payments/aging` ตัวเดียวกับการ์ดหน้ารับชำระ (ST5-T22) โหลดทุกหน้า
 * แล้วเรียงยอดรวมมากไปน้อยแบบต้นแบบ (ไม่มีสิทธิ์ราคาขาย = เรียงตามจำนวนใบ)
 */
export function useAgingByCustomer(enabled: boolean) {
  return useQuery({
    queryKey: [KEY, 'reports', 'aging'],
    enabled,
    queryFn: async () => {
      const first = await unwrap(
        api.GET('/v1/payments/aging', { params: { query: { limit: PAGE } } }),
      );
      const rows: AgingCustomer[] = [...first.data];
      let cursor = first.nextCursor;
      while (cursor && rows.length < REPORT_MAX_ROWS) {
        const p = await unwrap(
          api.GET('/v1/payments/aging', { params: { query: { limit: PAGE, cursor } } }),
        );
        rows.push(...p.data);
        cursor = p.nextCursor;
      }
      return { ...first, data: sortAging(rows).slice(0, REPORT_MAX_ROWS), hasMore: !!cursor };
    },
  });
}

/** ต้นแบบ `ar`: เรียงยอดรวมมากไปน้อย (เท่ากัน/ไม่มีสิทธิ์ราคา → จำนวนใบ → ชื่อ) */
export function sortAging(rows: AgingCustomer[]): AgingCustomer[] {
  const amt = (r: AgingCustomer) => Number(r.sellOutstanding ?? 0);
  return [...rows].sort(
    (a, b) =>
      amt(b) - amt(a) ||
      b.count - a.count ||
      a.customer.legalName.localeCompare(b.customer.legalName, 'th'),
  );
}
