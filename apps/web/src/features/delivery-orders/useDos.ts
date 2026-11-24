import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../api';
import { useCursorList } from '../master/useCursorList';

/** หน้ารายการใบส่งของ `/do` (UAT 24 พ.ย. 2569) — ต้นแบบ TMS v4 specDo + kpisX('do') */
const KEY = 'delivery-orders';
export type Do = Schemas['DeliveryOrderDto'];
export type DoSummary = Schemas['DeliveryOrderSummaryDto'];

/** ตัวกรองของรายการ (ค่าตรงกับ query ของ GET /v1/delivery-orders) */
export interface DoFilters {
  status: string;
  dateFrom: string;
  dateTo: string;
  doNo: string;
  customerName: string;
  vehiclePlate: string;
  driverName: string;
  product: string;
  route: string;
  rejected: string;
}

export function useDoList(filters: DoFilters) {
  return useCursorList<Do>(
    KEY,
    { ...filters },
    (query) => unwrap(api.GET('/v1/delivery-orders', { params: { query: query as never } })),
    { sort: '-updatedAt', size: 10, persist: 'do.list' },
  );
}

export function useDoSummary() {
  return useQuery({
    queryKey: [KEY, 'summary'],
    queryFn: () => unwrap(api.GET('/v1/delivery-orders/summary')) as Promise<DoSummary>,
  });
}

/** ใบเดียว (drawer) */
export function useDo(id: string) {
  return useQuery({
    queryKey: [KEY, 'one', id],
    staleTime: 0,
    queryFn: () =>
      unwrap(api.GET('/v1/delivery-orders/{id}', { params: { path: { id } } })) as Promise<Do>,
  });
}

/** รายได้ของใบ (ราคา snapshot ใน footer — `prices.sell:read`) */
export function useDoRevenue(id: string, enabled: boolean) {
  return useQuery({
    queryKey: [KEY, 'one', id, 'revenue'],
    enabled,
    retry: false,
    queryFn: () =>
      unwrap(
        api.GET('/v1/delivery-orders/{id}/revenue-lines', { params: { path: { id } } }),
      ) as Promise<Schemas['DeliveryOrderRevenueDto']>,
  });
}

/** ยกเลิกใบส่งของ (เมนู "…" → ยกเลิกเอกสาร — `orders:cancel`, เหตุผล ≥ 10, If-Match) */
export function useCancelDo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; reason: string }): Promise<Do> =>
      unwrap(
        api.POST('/v1/delivery-orders/{id}/cancel', {
          params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } },
          body: { reason: v.reason },
        }),
      ) as Promise<Do>,
    onSettled: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: ['trip'] });
      qc.invalidateQueries({ queryKey: ['orders'] });
    },
  });
}
