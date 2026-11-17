import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, unwrap } from '../api';

/**
 * ลิงก์งานของรถร่วม — ส่วนสถานะ (ST4-T08; docs/04 E2 "ePOD ผ่านลิงก์", docs/01 §5.5 `/public/pod/{token}`)
 * ตรรกะปุ่มเป็นฟังก์ชันล้วน (test ได้) · ความหมาย DEPART ตาม docs/01 §3.9 (spec/12 §3 DECISION ST4-T02):
 * "ออกจากจุด" ของจุด N = DEPART ของจุดถัดไปในเที่ยว · จุดรับที่ถึงแล้ว "ออกจากจุดรับ" = ปิดงานจุดรับ (รับของครบ) ก่อน
 */
export type PodView = Schemas['PodLinkViewDto'];
export type PodDo = Schemas['PodDoDto'];
export type PodStop = Schemas['PodStopDto'];
export type PodEventBody = Schemas['PodLinkEventDto'];

export type PodActionKey = 'arrivePickup' | 'leavePickup' | 'arriveDrop' | 'leaveDrop';

/** หนึ่งคำขอของปุ่ม (ส่งตามลำดับ — ARRIVE/COMPLETE ก่อน DEPART ของจุดถัดไป) */
export interface PodStep {
  stopId: string;
  type: 'ARRIVE' | 'DEPART' | 'COMPLETE';
}
export interface PodAction {
  key: PodActionKey;
  steps: PodStep[];
}

/** ข้อความแทนปุ่มเมื่อไม่มีปุ่มถัดไป */
export type PodHint = 'atDrop' | 'done' | 'pickupFailed' | null;

const closed = (s: PodStop) => s.status === 'COMPLETED' || s.status === 'FAILED';

/** ปุ่มสถานะถัดไปของ DO (spec/04 §5 S4: ถึงจุดรับ / ออกจากจุดรับ / ถึงจุดส่ง — ส่งแล้ว = POD ST4-T09) */
export function nextPodAction(m: PodDo): PodAction | null {
  const P = m.pickup;
  const D = m.delivery;
  if (P) {
    if (P.status === 'PENDING')
      return { key: 'arrivePickup', steps: [{ stopId: P.id, type: 'ARRIVE' }] };
    if (P.status === 'ARRIVED')
      return {
        key: 'leavePickup',
        steps: [
          { stopId: P.id, type: 'COMPLETE' },
          ...(P.nextStopId ? [{ stopId: P.nextStopId, type: 'DEPART' as const }] : []),
        ],
      };
    if (P.status === 'FAILED') return null;
    // ปิดจุดรับแล้ว (เช่น ผู้จัดรถบันทึกแทน) แต่ยังไม่ออก → ออกจากจุดรับ = DEPART จุดถัดไปอย่างเดียว
    if (P.status === 'COMPLETED' && !P.leftAt && P.nextStopId && D?.status === 'PENDING')
      return { key: 'leavePickup', steps: [{ stopId: P.nextStopId, type: 'DEPART' }] };
  }
  if (D) {
    if (D.status === 'PENDING')
      return { key: 'arriveDrop', steps: [{ stopId: D.id, type: 'ARRIVE' }] };
    if (closed(D) && D.nextStopId && !D.leftAt)
      return { key: 'leaveDrop', steps: [{ stopId: D.nextStopId, type: 'DEPART' }] };
  }
  return null;
}

export function podHint(m: PodDo): PodHint {
  if (m.pickup?.status === 'FAILED') return 'pickupFailed';
  if (m.delivery?.status === 'ARRIVED') return 'atDrop';
  if (m.delivery && closed(m.delivery)) return 'done';
  return null;
}

/** ป้ายสถานะของแถวจุด + สีจุดนำหน้า (สีจากต้นแบบ) */
export function stopState(s: PodStop): { key: string; at: string | null; c: string } {
  if (s.status === 'PENDING') return { key: 'PENDING', at: null, c: '#59606B' };
  if (s.status === 'ARRIVED') return { key: 'ARRIVED', at: s.arrivedAt, c: '#2257C4' };
  if (s.status === 'SKIPPED') return { key: 'SKIPPED', at: null, c: '#59606B' };
  if (s.status === 'FAILED') return { key: 'FAILED', at: null, c: '#B3322A' };
  if (s.role === 'PICKUP')
    return s.leftAt
      ? { key: 'LEFT', at: s.leftAt, c: '#17733F' }
      : { key: 'PICKED', at: null, c: '#17733F' };
  return { key: s.outcome === 'PARTIAL' ? 'PARTIAL' : 'DELIVERED', at: null, c: '#17733F' };
}

/** เลข DO ที่พิมพ์ → รูปเดียวกับ server (ตัวใหญ่ ไม่มีช่องว่าง เลขอารบิก) */
export function normalizeDoNo(v: string): string {
  return v
    .replace(/[\u0E50-\u0E59]/g, (d) => String(d.charCodeAt(0) - 0x0e50))
    .replace(/\s+/g, '')
    .toUpperCase();
}

/**
 * `clientEventId` คงที่ต่อ (ลิงก์, จุด, ชนิด) — refresh หน้าแล้วกดซ้ำ/เปิดสองเครื่อง ได้ id เดิม → server คืน event เดิม
 * (docs/01 §5.5 "ไม่มี outbox แต่ idempotent เท่ากัน") · UUID รูปแบบ v4 จาก SHA-256
 */
export async function podClientEventId(token: string, step: PodStep): Promise<string> {
  const data = new TextEncoder().encode(`tms-pod|${token}|${step.stopId}|${step.type}`);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', data)).slice(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** เวลาเครื่องแบบมี offset ไทย (+07:00) */
export function nowBangkokIso(now = Date.now()): string {
  const d = new Date(now + 7 * 3600_000);
  return `${d.toISOString().slice(0, 19)}+07:00`;
}

/** พิกัด ณ เวลากด ถ้าผู้ใช้อนุญาต (spec/04 §5 S4) — ไม่ได้ภายใน 3 วิ = ไม่ส่งพิกัด */
export function currentPosition(): Promise<{ lat: number; lng: number; accuracyM: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    const done = setTimeout(() => resolve(null), 3000);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(done);
        resolve({
          lat: Math.round(p.coords.latitude * 1e6) / 1e6,
          lng: Math.round(p.coords.longitude * 1e6) / 1e6,
          accuracyM: Math.round(p.coords.accuracy * 10) / 10,
        });
      },
      () => {
        clearTimeout(done);
        resolve(null);
      },
      { timeout: 3000, maximumAge: 60_000 },
    );
  });
}

export function usePodView(token: string, doNo: string | null) {
  return useQuery({
    queryKey: ['pod-link', token, doNo ?? ''],
    queryFn: () =>
      unwrap(
        api.GET('/v1/public/pod/{token}', {
          params: { path: { token }, query: doNo ? { doNo } : {} },
        }),
      ),
    retry: false,
  });
}

export function usePodEvent(token: string) {
  return useMutation({
    mutationFn: (v: { stopId: string; body: PodEventBody }) =>
      unwrap(
        api.POST('/v1/public/pod/{token}/stops/{stopId}/events', {
          params: { path: { token, stopId: v.stopId } },
          body: v.body,
        }),
      ),
  });
}
