import type { Schemas } from '@tms/contracts';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, idempotent, unwrap } from '../../api';

export type TripDetail = Schemas['TripDto'];
const KEY = 'trip';
/** กระดานวางแผน (ST3-T12) — เรียง/ถอดจุดแล้วต้องโหลดกระดานใหม่ (ระยะรวม/คำเตือน) */
const BOARD_KEY = 'planning-board';

/** เที่ยวรถ 1 เที่ยว (GET /v1/trips/{id}) */
export function useTrip(id: string | null) {
  return useQuery({
    queryKey: [KEY, id],
    enabled: !!id,
    staleTime: 0,
    queryFn: () =>
      unwrap(api.GET('/v1/trips/{id}', { params: { path: { id: id! } } })) as Promise<TripDetail>,
  });
}

/**
 * เที่ยวของใบสั่งขนส่ง (ส่วน "รถ / คนขับ" ใน drawer SO) — DO ของใบ → เที่ยวที่ DO อยู่ (ไม่ซ้ำ)
 * ต้องมี `trips:read` (`enabled` = false → ไม่เรียก)
 */
export function useOrderTrips(orderId: string, enabled: boolean) {
  const dos = useQuery({
    queryKey: [KEY, 'of-order', orderId],
    enabled,
    staleTime: 0,
    queryFn: () =>
      unwrap(
        api.GET('/v1/delivery-orders', { params: { query: { orderId, limit: 100 } } }),
      ) as Promise<Schemas['DeliveryOrderPageDto']>,
  });
  const ids = [
    ...new Set((dos.data?.data ?? []).map((d) => d.tripId).filter((x): x is string => !!x)),
  ];
  const trips = useQueries({
    queries: ids.map((id) => ({
      queryKey: [KEY, id],
      staleTime: 0,
      queryFn: () =>
        unwrap(api.GET('/v1/trips/{id}', { params: { path: { id } } })) as Promise<TripDetail>,
    })),
  });
  return trips.map((q) => q.data).filter((x): x is TripDetail => !!x);
}

/** เรียงจุดแวะเอง → POST /v1/trips/{id}/reorder-stops (If-Match = version ที่เห็น) — ST3-T16 */
export function useReorderStops() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; stopIds: string[] }): Promise<TripDetail> => {
      const key = crypto.randomUUID();
      return idempotent(() =>
        api.POST('/v1/trips/{id}/reorder-stops', {
          params: { path: { id: v.id } },
          body: { stopIds: v.stopIds },
          headers: { 'If-Match': `"${v.version}"`, 'Idempotency-Key': key },
        }),
      );
    },
    onSuccess: (t) => qc.setQueryData([KEY, t.id], t),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: [BOARD_KEY] });
    },
  });
}

/** นำใบส่งของออกจากเที่ยว (ปุ่ม × ของแถวจุด — ต้นแบบ "นำออกจากเที่ยว") → POST /v1/trips/{id}/detach */
export function useDetachFromTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; doIds: string[] }): Promise<TripDetail> => {
      const key = crypto.randomUUID();
      return idempotent(() =>
        api.POST('/v1/trips/{id}/detach', {
          params: { path: { id: v.id } },
          body: { deliveryOrderIds: v.doIds },
          headers: { 'If-Match': `"${v.version}"`, 'Idempotency-Key': key },
        }),
      );
    },
    onSuccess: (t) => qc.setQueryData([KEY, t.id], t),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: [BOARD_KEY] });
      qc.invalidateQueries({ queryKey: ['orders'] });
    },
  });
}
