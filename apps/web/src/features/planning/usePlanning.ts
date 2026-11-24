import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, idempotent, unwrap } from '../../api';
import { useRef, useState } from 'react';
import { DEFAULT_PREFS, type Board, type BoardPrefs, type Eligibility } from './board';
import { createPrefSaver } from './prefSaver';
import type { RefOption } from '../master/RefPicker';

export type Trip = Schemas['TripDto'];
const KEY = 'planning-board';
/** query key ของเที่ยว (useTrips) — invalidate drawer เที่ยวเมื่อคำเตือนเปลี่ยน */
const TRIPS_KEY = 'trip';
const PREFS_KEY = ['planning-board-prefs'];

/**
 * กระดาน (GET /v1/planning/board) — วันแรก `date` (null = วันนี้ตาม server เวลาไทย) + จำนวนวัน (1 / 7)
 * ตัวเลือกวัน ←/→ (spec/03 §5 ข้อ 3) ส่ง `date` · ไม่ส่ง = วันนี้ (review ST3-T12)
 */
export function useBoard(days: 1 | 7, date: string | null = null) {
  return useQuery({
    queryKey: [KEY, days, date ?? ''],
    staleTime: 0,
    queryFn: () =>
      unwrap(
        api.GET('/v1/planning/board', { params: { query: { days, ...(date ? { date } : {}) } } }),
      ) as Promise<Board>,
  });
}

/** สิ่งที่เลือกบนกระดาน → รถ/งานที่รับได้ (ST3-T15) */
export type EligSubject = { kind: 'order' | 'vehicle' | 'trip'; id: string };

const eligQuery = (s: EligSubject, days: 1 | 7, date: string | null = null) => ({
  // ใต้ KEY ของกระดาน — การวาง/ย้าย/ยืนยันกฎ invalidate ไปด้วย (ผลตรวจเปลี่ยนตามข้อมูลกระดาน)
  queryKey: [KEY, 'elig', s.kind, s.id, days, date ?? ''],
  staleTime: 0,
  queryFn: () =>
    unwrap(
      api.GET('/v1/planning/eligibility', {
        params: {
          query: {
            ...(s.kind === 'order'
              ? { orderId: s.id }
              : s.kind === 'vehicle'
                ? { vehicleId: s.id }
                : { tripId: s.id }),
            ...(s.kind === 'trip' ? {} : { days, ...(date ? { date } : {}) }),
          },
        },
      }),
    ) as Promise<Eligibility>,
});

/**
 * Filter รถที่รับได้สองทาง (GET /v1/planning/eligibility — ST3-T15): คลิก SO → รถทุกคัน · คลิกรถ → SO รอจัดทุกใบ
 * ช่วงวันเดียวกับกระดาน (วันนี้ตาม server + 7 วัน) — กฎชุดเดียวกับตอนวางจริง (ST3-T14)
 */
export function useEligibility(s: EligSubject | null, days: 1 | 7 = 7, date: string | null = null) {
  return useQuery({
    ...eligQuery(s ?? { kind: 'order', id: '' }, days, date),
    enabled: s !== null,
    retry: false,
  });
}

/** รถที่รับเที่ยวนี้ได้ ("ย้ายไปรถอื่น") — อ่านสดทุกครั้ง */
export function useFetchTripEligibility() {
  const qc = useQueryClient();
  return (tripId: string) => qc.fetchQuery(eligQuery({ kind: 'trip', id: tripId }, 1));
}

/**
 * มุมมอง + field บนการ์ดของผู้ใช้ (GET /v1/planning/board/preferences — ST3-T13) — เก็บฝั่ง server จำข้ามเครื่อง/login
 * ผิดพลาด (เช่น credential ไม่ใช่ผู้ใช้) → ไม่ลองซ้ำ ใช้ค่าเริ่มต้น
 */
export function useBoardPrefs() {
  return useQuery({
    queryKey: PREFS_KEY,
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
 * (เที่ยว ASSIGNED ย้ายไปรถอื่น = จัดรถใหม่ในคำขอเดียวกัน — ST3-T17)
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

/**
 * ยืนยันคำเตือน / ยกเว้นบล็อกของเที่ยว → POST /v1/trips/{id}/confirm-rules (ST3-T14 — เหตุผล ≥ 10 + audit)
 * เฉพาะ `ruleKeys` ที่ผู้ใช้เห็น · บล็อกต้องมี `trips:override` (ผู้จัดการ/ผู้ดูแล — D-07)
 */
export function useConfirmRules() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      id: string;
      version: number;
      reason: string;
      /** กุญแจของกฎที่ผู้ใช้เห็นและยืนยัน/ยกเว้น */
      ruleKeys: string[];
    }): Promise<Trip> => {
      const key = crypto.randomUUID();
      return idempotent(() =>
        api.POST('/v1/trips/{id}/confirm-rules', {
          params: { path: { id: v.id } },
          body: { overrideReason: v.reason, ruleKeys: v.ruleKeys },
          headers: { 'If-Match': `"${v.version}"`, 'Idempotency-Key': key },
        }),
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

/**
 * บันทึกมุมมอง + field บนการ์ด (PUT /v1/planning/board/preferences) — ทีละคำขอ รวมการกดรัว ๆ, version จากคำตอบก่อนหน้า,
 * 412 → อ่านใหม่แล้วลองซ้ำ 1 ครั้ง (`createPrefSaver`) · `onFail(conflict)` เมื่อยังไม่สำเร็จ (UI ย้อนค่าแล้ว)
 */
export function useSaveBoardPrefs(onFail: (conflict: boolean) => void) {
  const qc = useQueryClient();
  const fail = useRef(onFail);
  fail.current = onFail;
  const [saver] = useState(() =>
    createPrefSaver({
      put: (body, version) =>
        unwrap(
          api.PUT('/v1/planning/board/preferences', {
            body: body as Schemas['UpdateBoardPreferencesDto'],
            headers: version === undefined ? {} : { 'If-Match': `"${version}"` },
          }),
        ) as Promise<BoardPrefs>,
      get: () => unwrap(api.GET('/v1/planning/board/preferences')) as Promise<BoardPrefs>,
      read: () => qc.getQueryData<BoardPrefs>(PREFS_KEY),
      write: (v) => qc.setQueryData<BoardPrefs>(PREFS_KEY, v as BoardPrefs),
      fail: (c) => fail.current(c),
      fallback: { ...DEFAULT_PREFS, cardFields: [...DEFAULT_PREFS.cardFields], version: 0 },
    }),
  );
  return saver.save;
}

/**
 * ตารางรถ/คนขับรายวัน (ST3-T19) — ใส่วันลาคนขับ / โน้ตรายวัน (POST /v1/schedule-entries) จากเมนูคลิกขวาบนกระดาน
 * วันลาทับวันลาเดิม → 409 `conflict` (ข้อความไทยจาก server) · สำเร็จ → โหลดกระดานใหม่ (ช่อง "ว่าง"/"ลา" + คำเตือนเที่ยว)
 */
export function useAddScheduleEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas['CreateScheduleEntryDto']) => {
      const key = crypto.randomUUID();
      return idempotent(() =>
        api.POST('/v1/schedule-entries', { body, headers: { 'Idempotency-Key': key } }),
      );
    },
    // คำเตือนของเที่ยวเปลี่ยน (ตรวจใหม่ฝั่ง server) → drawer เที่ยวด้วย (review L2)
    onSettled: () => invalidateSchedule(qc),
  });
}

/** ยกเลิกวันลา/โน้ต (POST /v1/schedule-entries/{id}/cancel — เหตุผล ≥ 10 + audit, If-Match = version บนกระดาน) */
export function useCancelScheduleEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; reason: string }) =>
      unwrap(
        api.POST('/v1/schedule-entries/{id}/cancel', {
          params: { path: { id: v.id } },
          body: { reason: v.reason },
          headers: { 'If-Match': `"${v.version}"` },
        }),
      ),
    onSettled: () => invalidateSchedule(qc),
  });
}

const invalidateSchedule = (qc: ReturnType<typeof useQueryClient>) =>
  Promise.all([
    qc.invalidateQueries({ queryKey: [KEY] }),
    qc.invalidateQueries({ queryKey: [TRIPS_KEY] }),
  ]);

/** ค้นคนขับที่ใส่วันลาได้ (ACTIVE) แบบค้นหา — ไม่โหลดทั้งตาราง (review L4; แบบเดียวกับ RefPicker ของข้อมูลหลัก) */
export async function searchLeaveDrivers(q: string): Promise<RefOption[]> {
  const r = await unwrap(
    api.GET('/v1/drivers', {
      params: { query: { status: 'active', limit: 20, ...(q ? { q } : {}) } as never },
    }),
  );
  return r.data.map((d) => ({ id: d.id, label: d.name, sub: d.code }));
}

/**
 * วันลาที่ยังไม่ยกเลิกของคนขับ (วันนี้ถึง 61 วันข้างหน้า — ช่วงสูงสุดของ API) — แสดงใน dialog ใส่วันลา
 * ให้หา/ยกเลิกวันลาของคนขับที่ไม่มีแถวรถบนกระดานได้ (QA M1)
 */
export function useDriverLeaves(driverId: string | null, from: string) {
  return useQuery({
    queryKey: [KEY, 'driver-leaves', driverId, from],
    enabled: !!driverId,
    staleTime: 0,
    queryFn: () =>
      unwrap(
        api.GET('/v1/schedule-entries', {
          params: {
            query: {
              from,
              to: new Date(Date.parse(`${from}T00:00:00Z`) + 61 * 86_400_000)
                .toISOString()
                .slice(0, 10),
              driverId: driverId!,
            },
          },
        }),
      ).then((p) => p.data.filter((e) => e.kind === 'LEAVE')),
  });
}
