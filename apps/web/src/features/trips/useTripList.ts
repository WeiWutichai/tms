import type { Schemas } from '@tms/contracts';
import {
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { decimalFromSatang, satangFromDecimal } from '@tms/domain/src/money';
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
  route: string;
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

type DoPage = Schemas['DeliveryOrderPageDto'];
type TripPage = Schemas['TripPageDto'];
export const POOL_KEY = [KEY, 'pool'] as const;
export const PLAN_KEY = [KEY, 'plan-cards'] as const;
const BOARD_PAGE = 50;

/**
 * กระดาน: DO รอเข้าเที่ยว (DRAFT + ไม่อยู่ในเที่ยวที่ยังใช้งาน — DO ในเที่ยวที่ยังวางแผนยังเป็น DRAFT) — ต้นแบบ vTrpB pool
 * ทีละ 50 ใบ + "โหลดเพิ่ม" (review L7)
 */
export function usePoolDos(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: POOL_KEY,
    enabled,
    staleTime: 0,
    initialPageParam: '' as string,
    getNextPageParam: (p: DoPage) => (p.hasMore && p.nextCursor ? p.nextCursor : undefined),
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/v1/delivery-orders', {
          params: {
            query: {
              status: 'DRAFT',
              inTrip: 'false',
              limit: BOARD_PAGE,
              sort: '-updatedAt',
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ) as Promise<DoPage>,
  });
}

/**
 * กระดาน: เที่ยวที่ยังเพิ่ม DO ได้ (ก่อนปล่อยรถ — API `/attach` รับ PLANNING/ASSIGNED) — ต้นแบบ vTrpB plan
 * ไม่ขอยอดเงินต่อแถว (`amounts=false` — review L6) · ทีละ 50 + "โหลดเพิ่ม"
 */
export function usePlanTrips() {
  return useInfiniteQuery({
    queryKey: PLAN_KEY,
    staleTime: 0,
    initialPageParam: '' as string,
    getNextPageParam: (p: TripPage) => (p.hasMore && p.nextCursor ? p.nextCursor : undefined),
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/v1/trips', {
          params: {
            query: {
              status: 'PLANNING,ASSIGNED',
              amounts: 'false',
              limit: BOARD_PAGE,
              sort: '-updatedAt',
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ) as Promise<TripPage>,
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

/** เอา DO ออกจากกระดานทันที (optimistic) — คืนค่าเดิมไว้ย้อนเมื่อผิดพลาด */
function dropFromPool(qc: ReturnType<typeof useQueryClient>, doId: string) {
  const prev = qc.getQueryData<InfiniteData<DoPage>>(POOL_KEY);
  if (prev)
    qc.setQueryData<InfiniteData<DoPage>>(POOL_KEY, {
      ...prev,
      pages: prev.pages.map((p) => ({ ...p, data: p.data.filter((d) => d.id !== doId) })),
    });
  return prev;
}

/**
 * วาง DO บนการ์ดเที่ยว → POST /v1/trips/{id}/attach (If-Match = version ที่เห็น)
 * review M2: เอา DO ออกจากกองทันที + เขียนเที่ยวที่ได้กลับลง cache (drawer/การ์ดเห็นทันที) · ผิดพลาด = คืนกอง
 */
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
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: POOL_KEY });
      return { prev: dropFromPool(qc, v.doId) };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(POOL_KEY, ctx.prev);
    },
    onSuccess: (t) => {
      qc.setQueryData([KEY, t.id], t);
      const cards = qc.getQueryData<InfiniteData<TripPage>>(PLAN_KEY);
      if (cards)
        qc.setQueryData<InfiniteData<TripPage>>(PLAN_KEY, {
          ...cards,
          pages: cards.pages.map((p) => ({
            ...p,
            data: p.data.map((x) => (x.id === t.id ? { ...x, ...t } : x)),
          })),
        });
    },
    onSettled: () => invalidate(qc),
  });
}

/** วาง DO บน "เที่ยวใหม่" → POST /v1/trips (เที่ยว PLANNING ยังไม่มีรถ — จัดรถใน drawer) · เอา DO ออกจากกองทันที */
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
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: POOL_KEY });
      return { prev: dropFromPool(qc, v.doId) };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(POOL_KEY, ctx.prev);
    },
    onSuccess: (t) => qc.setQueryData([KEY, t.id], t),
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
  return decimalFromSatang(
    qs.reduce((a, q) => a + satangFromDecimal(q.data!.sellRevenueTotal!), 0n),
  );
}
