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

/** "DO ยังไม่วางบิลเกิน N วัน" (ST9-T06 — `GET /v1/reports/unbilled-delivery-orders`) · N = ค่าตั้งองค์กร · รวม "ร่างค้างเกิน N วัน" (D-71) */
export const UNBILLED_QUERY = { includeStaleDrafts: 'true' } as const;
export function useUnbilledReport(enabled: boolean) {
  return useQuery({
    queryKey: [KEY, 'reports', 'unbilled'],
    enabled,
    queryFn: async () => {
      const first = await unwrap(
        api.GET('/v1/reports/unbilled-delivery-orders', {
          params: { query: { ...UNBILLED_QUERY, limit: PAGE } },
        }),
      );
      const rows: UnbilledRow[] = [...first.data];
      let cursor = first.nextCursor;
      while (cursor && rows.length < REPORT_MAX_ROWS) {
        const p = await unwrap(
          api.GET('/v1/reports/unbilled-delivery-orders', {
            params: { query: { ...UNBILLED_QUERY, limit: PAGE, cursor } },
          }),
        );
        rows.push(...p.data);
        cursor = p.nextCursor;
      }
      return { ...first, data: rows.slice(0, REPORT_MAX_ROWS) };
    },
  });
}

/** เกณฑ์ N (ค่าตั้งองค์กร `billing.unbilledAlertDays` ผ่านรายงาน — ผู้วางบิลไม่มี `settings:read`) สำหรับชื่อแท็บ — ขอแค่ 1 แถว (review L8) */
export function useUnbilledDays(enabled: boolean) {
  return useQuery({
    queryKey: [KEY, 'reports', 'unbilled', 'days'],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () =>
      (
        await unwrap(
          api.GET('/v1/reports/unbilled-delivery-orders', { params: { query: { limit: 1 } } }),
        )
      ).minDays,
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

export type RevenueReport = Schemas['RevenueReportDto'];
export type RevenueRow = Schemas['RevenueRowDto'];
export type RevenueGroupBy =
  'customer' | 'route' | 'vehicle' | 'vehicleType' | 'legalEntity' | 'month';

/**
 * รายงานรายได้ (ST9-T05 — `GET /v1/reports/revenue`) — แถวสรุปต่อกลุ่ม (ไม่มีหน้า) · ใช้ key เดียวกับใบแจ้งหนี้
 * (ออก/ยกเลิกใบแล้วโหลดใหม่)
 */
export function useRevenueReport(
  enabled: boolean,
  q: { groupBy: RevenueGroupBy; fromMonth: string; toMonth: string },
) {
  return useQuery({
    queryKey: [KEY, 'reports', 'revenue', q.groupBy, q.fromMonth, q.toMonth],
    enabled,
    queryFn: () => unwrap(api.GET('/v1/reports/revenue', { params: { query: q } })),
  });
}

/** เดือนปัจจุบันเวลาไทย (YYYY-MM) */
export function bangkokMonth(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
  })
    .format(now)
    .slice(0, 7);
}

/** เลื่อนเดือน YYYY-MM ไป n เดือน */
export function shiftMonth(month: string, n: number): string {
  const i = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}
