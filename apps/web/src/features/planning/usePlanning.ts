import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, idempotent, unwrap } from '../../api';
import type { Board } from './board';

export type Trip = Schemas['TripDto'];
const KEY = 'planning-board';

/** กระดาน (GET /v1/planning/board) — วันแรก + จำนวนวัน (1 / 7) */
export function useBoard(date: string, days: 1 | 7) {
  return useQuery({
    queryKey: [KEY, date, days],
    staleTime: 0,
    queryFn: () =>
      unwrap(api.GET('/v1/planning/board', { params: { query: { date, days } } })) as Promise<Board>,
  });
}

/** ลาก SO ลงแถวรถ → POST /v1/trips (เที่ยว PLANNING มีรถที่วางไว้) — 1 การปล่อย = 1 Idempotency-Key */
export function useDropOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      body: Schemas['CreateTripDto'];
      idempotencyKey: string;
    }): Promise<Trip> =>
      idempotent(() =>
        api.POST('/v1/trips', {
          body: v.body,
          headers: { 'Idempotency-Key': v.idempotencyKey },
        }),
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

/** ย้าย/ปรับขนาดเที่ยว → POST /v1/trips/{id}/schedule (If-Match = version บนกระดาน) */
export function useScheduleTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      id: string;
      version: number;
      body: Schemas['ScheduleTripDto'];
      idempotencyKey: string;
    }): Promise<Trip> =>
      idempotent(() =>
        api.POST('/v1/trips/{id}/schedule', {
          params: { path: { id: v.id } },
          body: v.body,
          headers: { 'If-Match': `"${v.version}"`, 'Idempotency-Key': v.idempotencyKey },
        }),
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

/** ย้ายเที่ยวที่จัดรถแล้ว (ASSIGNED) ไปรถอื่น → POST /v1/trips/{id}/assign (คนขับ = คนขับประจำของรถใหม่) */
export function useReassignTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      id: string;
      version: number;
      vehicleId: string;
      idempotencyKey: string;
    }): Promise<Trip> =>
      idempotent(() =>
        api.POST('/v1/trips/{id}/assign', {
          params: { path: { id: v.id } },
          body: { vehicleId: v.vehicleId },
          headers: { 'If-Match': `"${v.version}"`, 'Idempotency-Key': v.idempotencyKey },
        }),
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}
