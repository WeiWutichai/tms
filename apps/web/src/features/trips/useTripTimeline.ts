import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../api';

export type TimelineEvent = Schemas['TripTimelineEventDto'];
export type StopEvent = Schemas['StopEventDto'];
export type StopAction = 'arrive' | 'depart' | 'complete' | 'fail';

/** ไทม์ไลน์ event ของเที่ยว (ST4-T04 — GET /v1/trips/{id}/events) · key ใต้ 'trip' = โหลดใหม่พร้อมเที่ยว */
export function useTripEvents(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['trip', id, 'events'],
    enabled,
    staleTime: 0,
    queryFn: async () =>
      (await unwrap(api.GET('/v1/trips/{id}/events', { params: { path: { id } } }))).data,
  });
}

export interface StopEventBody {
  clientEventId: string;
  occurredAt: string;
  outcome?: 'DELIVERED' | 'PARTIAL' | 'FAILED' | 'UNDELIVERED_RETAIN';
  reasonCodeId?: string | null;
  note?: string | null;
}

/** 1 action ของจุด — `clientEventId` คงที่ต่อการกด (ส่งซ้ำ = server คืน event เดิม) */
export interface StopEventStep {
  stopId: string;
  action: StopAction;
  body: StopEventBody;
}

const post = (s: StopEventStep): Promise<StopEvent> => {
  const path = { params: { path: { id: s.stopId } } };
  switch (s.action) {
    case 'arrive':
      return unwrap(api.POST('/v1/stops/{id}/arrive', { ...path, body: s.body }));
    case 'depart':
      return unwrap(api.POST('/v1/stops/{id}/depart', { ...path, body: s.body }));
    case 'complete':
      return unwrap(
        api.POST('/v1/stops/{id}/complete', {
          ...path,
          body: { ...s.body, outcome: s.body.outcome ?? 'DELIVERED' },
        }),
      );
    case 'fail':
      return unwrap(
        api.POST('/v1/stops/{id}/fail', {
          ...path,
          body: {
            ...s.body,
            outcome: s.body.outcome === 'UNDELIVERED_RETAIN' ? s.body.outcome : null,
          },
        }),
      );
  }
};

/**
 * บันทึก event หน้างานแทนคนขับ (ST4-T04) — ส่งทีละรายการตามลำดับ (ถึงจุดก่อนปิดงาน / ส่งไม่สำเร็จทีละจุด)
 * ล้มกลางทาง → error มี `done` = จำนวนที่สำเร็จแล้ว (กดซ้ำด้วย clientEventId เดิม = ไม่เกิด event ซ้ำ)
 */
export function useRecordStopEvents() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (steps: StopEventStep[]): Promise<StopEvent[]> => {
      const out: StopEvent[] = [];
      for (const s of steps) {
        try {
          out.push(await post(s));
        } catch (e) {
          throw Object.assign(e as object, { done: out.length });
        }
      }
      return out;
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['trip'] });
      qc.invalidateQueries({ queryKey: ['stop-event-flags'] });
      qc.invalidateQueries({ queryKey: ['planning-board'] });
      // สถานะ DO เปลี่ยนตามผลที่จุดส่ง (หน้า /do รายการ + ตัวนับ + drawer DO)
      qc.invalidateQueries({ queryKey: ['delivery-orders'] });
      qc.invalidateQueries({ queryKey: ['delivery-order'] });
    },
  });
}
