import type { Schemas } from '@tms/contracts';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, idempotent, unwrap } from '../../api';
import { useCursorList } from '../master/useCursorList';
import type { TripDetail } from './useTrips';

/**
 * หน้ารายการเที่ยวรถ `/trips` (UAT 24 พ.ย. 2569) — query key อยู่ใต้ 'trip' เดียวกับ drawer (useTrips)
 * การจัดรถ/ปล่อย/ถอด DO ใน drawer invalidate ['trip'] → รายการ/การ์ด/กระดานบนหน้านี้โหลดใหม่ด้วย
 */
const KEY = 'trip';
export type TripRow = Schemas['TripDto'];
export type TripSummary = Schemas['TripSummaryDto'];
export type PoolDo = Schemas['DeliveryOrderDto'];
export type TripCosts = Schemas['TripCostListDto'];

/** ตัวกรองของรายการ (ค่าตรงกับ query ของ GET /v1/trips) */
export interface TripFilters {
  status: string;
  ownership: string;
  tripNo: string;
  vehiclePlate: string;
  driverName: string;
}

export function useTripList(filters: TripFilters) {
  return useCursorList<TripRow>(
    KEY,
    { ...filters },
    (query) => unwrap(api.GET('/v1/trips', { params: { query: query as never } })),
    { sort: '-updatedAt', size: 10, persist: 'trips.list' },
  );
}

export function useTripSummary() {
  return useQuery({
    queryKey: [KEY, 'summary'],
    queryFn: () => unwrap(api.GET('/v1/trips/summary')) as Promise<TripSummary>,
  });
}

/** กระดาน: DO รอเข้าเที่ยว (DRAFT = ยังไม่อยู่ในเที่ยว) — ต้นแบบ vTrpB pool */
export function usePoolDos(enabled: boolean) {
  return useQuery({
    queryKey: [KEY, 'pool'],
    enabled,
    staleTime: 0,
    queryFn: () =>
      unwrap(
        api.GET('/v1/delivery-orders', {
          params: { query: { status: 'DRAFT', limit: 100, sort: '-updatedAt' } },
        }),
      ) as Promise<Schemas['DeliveryOrderPageDto']>,
  });
}

/** กระดาน: เที่ยวที่ยังเพิ่ม DO ได้ (ก่อนปล่อยรถ — API `/attach` รับ PLANNING/ASSIGNED) — ต้นแบบ vTrpB plan */
export function usePlanTrips() {
  return useQuery({
    queryKey: [KEY, 'plan-cards'],
    staleTime: 0,
    queryFn: () =>
      unwrap(
        api.GET('/v1/trips', {
          params: { query: { status: 'PLANNING,ASSIGNED', limit: 50, sort: '-updatedAt' } },
        }),
      ) as Promise<Schemas['TripPageDto']>,
  });
}

/** น้ำหนักบรรทุกของประเภทรถ (แถบน้ำหนักบนการ์ดเที่ยว) — master:read; ไม่มีสิทธิ์ = ไม่แสดงแถบ */
export function useVehicleTypeCaps(enabled: boolean) {
  return useQuery({
    queryKey: ['vehicle-types', 'caps'],
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const p = (await unwrap(
        api.GET('/v1/vehicle-types', { params: { query: { limit: 200 } as never } }),
      )) as Schemas['VehicleTypePageDto'];
      return new Map(p.data.map((v) => [v.id, v.payloadKg]));
    },
  });
}

const invalidate = (qc: ReturnType<typeof useQueryClient>) => {
  qc.invalidateQueries({ queryKey: [KEY] });
  qc.invalidateQueries({ queryKey: ['planning-board'] });
  qc.invalidateQueries({ queryKey: ['orders'] });
  qc.invalidateQueries({ queryKey: ['delivery-orders'] });
};

/** วาง DO บนการ์ดเที่ยว → POST /v1/trips/{id}/attach (If-Match = version ที่เห็น) */
export function useAttachDo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { trip: TripRow; doId: string }): Promise<TripDetail> => {
      const key = crypto.randomUUID();
      return idempotent(() =>
        api.POST('/v1/trips/{id}/attach', {
          params: { path: { id: v.trip.id } },
          body: { deliveryOrderIds: [v.doId] },
          headers: { 'If-Match': `"${v.trip.version}"`, 'Idempotency-Key': key },
        }),
      );
    },
    onSettled: () => invalidate(qc),
  });
}

/** วาง DO บน "เที่ยวใหม่" → POST /v1/trips (เที่ยว PLANNING ยังไม่มีรถ — จัดรถใน drawer) */
export function useNewTripFromDo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { doId: string; tripDate: string }): Promise<TripDetail> => {
      const key = crypto.randomUUID();
      return idempotent(() =>
        api.POST('/v1/trips', {
          body: { deliveryOrderIds: [v.doId], tripDate: v.tripDate },
          headers: { 'Idempotency-Key': key },
        }),
      );
    },
    onSettled: () => invalidate(qc),
  });
}

/** ต้นทุนเที่ยว (GET /v1/trips/{id}/costs — ST6-T01) — ยอด buy* ตัดตามสิทธิ์ที่ API */
export function useTripCosts(id: string, enabled: boolean) {
  return useQuery({
    queryKey: [KEY, id, 'costs'],
    enabled,
    staleTime: 0,
    queryFn: () =>
      unwrap(api.GET('/v1/trips/{id}/costs', { params: { path: { id } } })) as Promise<TripCosts>,
  });
}

/** ปิดต้นทุนเที่ยว COMPLETED → COSTED (POST /v1/trips/{id}/cost — `trips:close` + If-Match) */
export function useCloseTripCost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number }): Promise<TripDetail> => {
      const key = crypto.randomUUID();
      return idempotent(() =>
        api.POST('/v1/trips/{id}/cost', {
          params: { path: { id: v.id } },
          headers: { 'If-Match': `"${v.version}"`, 'Idempotency-Key': key },
        }),
      );
    },
    onSuccess: (t) => qc.setQueryData([KEY, t.id], t),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: ['settlements'] });
    },
  });
}

/**
 * รายได้จาก DO ของเที่ยว (ส่วนยอดเงินใน drawer) = Σ `sellRevenueTotal` ของแต่ละ DO (GET /delivery-orders/{id}/revenue-lines
 * — `prices.sell:read`) · ยังโหลดไม่ครบ/ไม่มีสิทธิ์ = undefined
 */
export function useTripRevenue(doIds: string[], enabled: boolean): string | undefined {
  const qs = useQueries({
    queries: doIds.map((id) => ({
      queryKey: ['delivery-orders', 'one', id, 'revenue'],
      enabled,
      retry: false,
      queryFn: () =>
        unwrap(
          api.GET('/v1/delivery-orders/{id}/revenue-lines', { params: { path: { id } } }),
        ) as Promise<Schemas['DeliveryOrderRevenueDto']>,
    })),
  });
  if (!enabled || qs.some((q) => !q.data || q.data.sellRevenueTotal === undefined))
    return undefined;
  const satang = qs.reduce((a, q) => a + Math.round(Number(q.data!.sellRevenueTotal) * 100), 0);
  return (satang / 100).toFixed(2);
}
