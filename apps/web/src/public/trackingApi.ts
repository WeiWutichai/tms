import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, unwrap } from '../api';

/**
 * หน้าติดตามของผู้รับ (ST4-T14; docs/04 E2 "Tracking link สาธารณะ", spec/04 §4 EXE-D) — ไม่ login
 * ตรรกะสี/ขั้นของ stepper เป็นฟังก์ชันล้วน (test ได้) ตามต้นแบบ `TMS Tracking.dc.html` (`renderVals().steps`)
 */
export type TrackingView = Schemas['TrackingViewDto'];
export type TrackingShipment = Schemas['TrackingShipmentDto'];
export type TrackingStage =
  'ACCEPTED' | 'DEPARTED' | 'IN_TRANSIT' | 'DELIVERED' | 'FAILED' | 'CANCELLED';

const BLUE = '#2257C4';
const GREEN = '#15803D';
const RED = '#B3322A';
const GRAY = '#6B7280';

/** ป้ายสถานะ (สี + ไอคอน — ต้นแบบ B: รับงาน/ออกรถ/กำลังส่ง = น้ำเงิน, ส่งแล้ว = เขียว) */
export const TRACKING_BADGE: Record<TrackingStage, { c: string; i: string }> = {
  ACCEPTED: { c: BLUE, i: 'inbox' },
  DEPARTED: { c: BLUE, i: 'truck' },
  IN_TRANSIT: { c: BLUE, i: 'navigation' },
  DELIVERED: { c: GREEN, i: 'circle-check' },
  FAILED: { c: RED, i: 'circle-x' },
  CANCELLED: { c: GRAY, i: 'ban' },
};

const STEP_ICONS = ['inbox', 'truck', 'navigation', 'package-check'];

export interface StepView {
  key: string;
  label: TrackingStage;
  at: string | null;
  icon: string;
  bg: string;
  bd: string;
  fg: string;
  lc: string;
  fw: number;
  lineL: string;
  lineR: string;
}

/**
 * stepper 4 ขั้นตามต้นแบบ — `cur` = ขั้นล่าสุดที่ถึง, ส่งแล้ว = ทุกขั้นเสร็จ
 * ส่งไม่สำเร็จ (spec/04 §4): ขั้นสุดท้ายเป็น "ส่งไม่สำเร็จ" สีแดง · ยกเลิก: ทุกขั้นเทา
 */
export function stepViews(s: Pick<TrackingShipment, 'status' | 'steps'>): StepView[] {
  const stage = s.status as TrackingStage;
  const delivered = stage === 'DELIVERED';
  const failed = stage === 'FAILED';
  const cur = s.steps.reduce((m, x, i) => (x.done ? i : m), -1);
  return s.steps.map((x, i) => {
    const isFail = failed && i === 3;
    const done = !isFail && (i < cur || (delivered && i === cur));
    const on = !isFail && i === cur && !delivered;
    const lit = done || on;
    return {
      key: x.key,
      label: isFail ? 'FAILED' : (x.key as TrackingStage),
      at: x.at,
      icon: isFail ? 'x' : done ? 'check' : STEP_ICONS[i]!,
      bg: isFail ? RED : lit ? BLUE : '#FFFFFF',
      bd: isFail ? RED : lit ? BLUE : '#D1D5DB',
      fg: isFail || lit ? '#FFFFFF' : GRAY,
      lc: isFail ? RED : on ? BLUE : done ? '#111827' : GRAY,
      fw: on || isFail ? 600 : 500,
      lineL: i === 0 ? 'transparent' : i <= cur ? BLUE : '#E5E7EB',
      lineR: i === 3 ? 'transparent' : i < cur ? BLUE : '#E5E7EB',
    };
  });
}

/** เบอร์สำหรับลิงก์ `tel:` — ตัวเลขและ + เท่านั้น */
export const telHref = (phone: string) => `tel:${phone.replace(/[^0-9+]/g, '')}`;

export function useTrackingView(token: string) {
  return useQuery({
    queryKey: ['tracking', token],
    queryFn: () => unwrap(api.GET('/v1/public/tracking/{token}', { params: { path: { token } } })),
    retry: false,
  });
}

export function useTrackingLookup(token: string) {
  return useMutation({
    mutationFn: (body: { ref: string; phoneLast4: string }) =>
      unwrap(api.POST('/v1/public/tracking/{token}/lookup', { params: { path: { token } }, body })),
  });
}
