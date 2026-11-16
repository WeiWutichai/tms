import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, idempotent, unwrap } from '../../api';
import type { Board, BoardPrefs } from './board';

export type Trip = Schemas['TripDto'];
const KEY = 'planning-board';

/** กระดาน (GET /v1/planning/board) — เริ่มวันนี้ตาม server (เวลาไทย) + จำนวนวัน (1 / 7) */
export function useBoard(days: 1 | 7) {
  return useQuery({
    queryKey: [KEY, days],
    staleTime: 0,
    queryFn: () =>
      unwrap(api.GET('/v1/planning/board', { params: { query: { days } } })) as Promise<Board>,
  });
}

/**
 * มุมมอง + field บนการ์ดของผู้ใช้ (GET /v1/planning/board/preferences — ST3-T13) — เก็บฝั่ง server จำข้ามเครื่อง/login
 * ผิดพลาด (เช่น credential ไม่ใช่ผู้ใช้) → ไม่ลองซ้ำ ใช้ค่าเริ่มต้น
 */
export function useBoardPrefs() {
  return useQuery({
    queryKey: ['planning-board-prefs'],
    staleTime: 60_000,
    retry: false,
    queryFn: () => unwrap(api.GET('/v1/planning/board/preferences')) as Promise<BoardPrefs>,
  });
}

/** ลาก SO ลงแถวรถ → POST /v1/trips (เที่ยว PLANNING มีรถที่วางไว้) — 1 การปล่อย = 1 Idempotency-Key */
export function useDropOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { body: Schemas['CreateTripDto']; idempotencyKey: string }): Promise<Trip> =>
      idempotent(() =>
        api.POST('/v1/trips', {
          body: v.body,
          headers: { 'Idempotency-Key': v.idempotencyKey },
        }),
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

/**
 * ย้าย/ปรับขนาดเที่ยว → POST /v1/trips/{id}/schedule (If-Match = version บนกระดาน) — คำขอเดียว
 * (เที่ยว ASSIGNED ย้ายไปรถอื่น = ทางจัดรถใหม่ของ ST3-T17 กระดานบล็อกไว้ — ไม่ทำ /assign + /schedule สองคำขอ)
 */
export function useMoveTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      id: string;
      version: number;
      body: Schemas['ScheduleTripDto'];
    }): Promise<Trip> => {
      const key = crypto.randomUUID();
      return idempotent(() =>
        api.POST('/v1/trips/{id}/schedule', {
          params: { path: { id: v.id } },
          body: v.body,
          headers: { 'If-Match': `"${v.version}"`, 'Idempotency-Key': key },
        }),
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}
