import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError, unwrap } from '../api';

/**
 * ลิงก์งานของรถร่วม — ส่วนสถานะ (ST4-T08; docs/04 E2 "ePOD ผ่านลิงก์", docs/01 §5.5 `/public/pod/{token}`)
 * ตรรกะปุ่มเป็นฟังก์ชันล้วน (test ได้) · ความหมาย DEPART ตาม docs/01 §3.9 (spec/12 §3 DECISION ST4-T02):
 * "ออกจากจุด" ของจุด N = DEPART ของจุดถัดไปในเที่ยว · จุดรับที่ถึงแล้ว "ออกจากจุดรับ" = ขึ้นของเสร็จ (`LOADED` —
 * D-81 · D68-39, docs/01 §3.9) ก่อน
 */
export type PodView = Schemas['PodLinkViewDto'];
export type PodDo = Schemas['PodDoDto'];
export type PodStop = Schemas['PodStopDto'];
export type PodEventBody = Schemas['PodLinkEventDto'];
export type PodEventResult = Schemas['PodLinkEventResultDto'];
/** ST4-T09 หลักฐานส่งผ่านลิงก์ */
export type PodLinkPod = Schemas['PodLinkDoPodDto'];
export type PodLinkField = PodLinkPod['fields'][number];
export type PodCaptureBody = Schemas['PodLinkCaptureDto'];
export type PodCaptureResult = Schemas['PodLinkCaptureResultDto'];
export type PodFileKind = Schemas['PodLinkFileReserveDto']['kind'];

export type PodActionKey = 'arrivePickup' | 'leavePickup' | 'arriveDrop' | 'leaveDrop';

/** หนึ่งคำขอของปุ่ม (ส่งตามลำดับ — ARRIVE/LOADED/COMPLETE ก่อน DEPART ของจุดถัดไป) */
export interface PodStep {
  stopId: string;
  type: 'ARRIVE' | 'DEPART' | 'LOADED' | 'COMPLETE' | 'FAIL';
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
          { stopId: P.id, type: 'LOADED' },
          // DEPART เฉพาะเมื่อจุดถัดไปยังว่าง (QA M1 — กันสร้าง event ขัดลำดับ)
          ...(P.nextStopId && P.nextOpen
            ? [{ stopId: P.nextStopId, type: 'DEPART' as const }]
            : []),
        ],
      };
    if (P.status === 'FAILED') return null;
    // ปิดจุดรับแล้ว (เช่น ผู้จัดรถบันทึกแทน) แต่ยังไม่ออก → ออกจากจุดรับ = DEPART จุดถัดไปอย่างเดียว
    if (P.status === 'COMPLETED' && P.nextOpen && P.nextStopId && D?.status === 'PENDING')
      return { key: 'leavePickup', steps: [{ stopId: P.nextStopId, type: 'DEPART' }] };
  }
  if (D) {
    if (D.status === 'PENDING')
      return { key: 'arriveDrop', steps: [{ stopId: D.id, type: 'ARRIVE' }] };
    if (closed(D) && D.nextStopId && D.nextOpen)
      return { key: 'leaveDrop', steps: [{ stopId: D.nextStopId, type: 'DEPART' }] };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Q-LINK แจ้งรับ/ส่งไม่สำเร็จ หรือรับบางส่วน พร้อมเหตุผล + รูป (D-81 · D68-39; docs/01 §3.9, §5.5)

export type PodFailReason = PodDo['failReasons'][number];
export type PodFailKindKey = 'pickupPartial' | 'pickupFailed' | 'dropFailed' | 'dropRetain';
export interface PodFailKind {
  key: PodFailKindKey;
  type: 'FAIL' | 'COMPLETE';
  outcome: 'PARTIAL' | 'FAILED' | 'UNDELIVERED_RETAIN' | null;
  /** แนบรูปได้ (ผลไม่สำเร็จ → หลักฐานชุด "ไม่สำเร็จ" ของ DO) */
  photos: boolean;
}
export interface PodFailTarget {
  stop: PodStop;
  kinds: PodFailKind[];
}

/**
 * จุดที่แจ้งได้ตอนนี้ + ตัวเลือก — จุดรับก่อน (ยังไม่ปิด) แล้วจุดส่ง (เมื่อจุดรับปิดสำเร็จ) ·
 * ถึงจุดแล้ว = ปิดงานพร้อมผล (`COMPLETE`) · ยังไม่ถึง = `FAIL` (API: ปิดด้วยผลต้องถึงก่อน — 409 `stop_not_arrived`) ·
 * รับบางส่วนต้องถึงจุดรับก่อน · ส่งบางส่วนที่จุดส่งใช้ช่อง "ส่งจริง" ของฟอร์ม POD เดิม (ST4-T10)
 */
export function podFailTarget(m: PodDo): PodFailTarget | null {
  const open = (s: PodStop | null | undefined): s is PodStop =>
    !!s && (s.status === 'PENDING' || s.status === 'ARRIVED');
  const P = m.pickup;
  const D = m.delivery;
  if (open(P)) {
    const at = P.status === 'ARRIVED';
    return {
      stop: P,
      kinds: [
        ...(at
          ? [{ key: 'pickupPartial', type: 'COMPLETE', outcome: 'PARTIAL', photos: false } as const]
          : []),
        at
          ? ({ key: 'pickupFailed', type: 'COMPLETE', outcome: 'FAILED', photos: true } as const)
          : ({ key: 'pickupFailed', type: 'FAIL', outcome: null, photos: true } as const),
      ],
    };
  }
  if (P && P.status !== 'COMPLETED') return null;
  if (open(D)) {
    const at = D.status === 'ARRIVED';
    return {
      stop: D,
      kinds: [
        at
          ? { key: 'dropFailed', type: 'COMPLETE', outcome: 'FAILED', photos: true }
          : { key: 'dropFailed', type: 'FAIL', outcome: null, photos: true },
        {
          key: 'dropRetain',
          type: at ? 'COMPLETE' : 'FAIL',
          outcome: 'UNDELIVERED_RETAIN',
          photos: true,
        },
      ],
    };
  }
  return null;
}

/**
 * เหตุผลที่เลือกได้ต่อตัวเลือก — ของยังอยู่บนรถ = หมวด DELIVERY_FAILED เท่านั้น (API 422) ·
 * รับบางส่วนแนบรูปไม่ได้ → ซ่อนเหตุผลที่บังคับรูป
 */
export function podFailReasons(all: PodFailReason[], k: PodFailKind): PodFailReason[] {
  return all.filter(
    (r) =>
      (k.outcome !== 'UNDELIVERED_RETAIN' || r.category === 'DELIVERY_FAILED') &&
      (k.photos || !r.requiresPhoto),
  );
}

/** ข้อที่ยังขาดก่อนส่ง (ฝั่งหน้าจอ — server ตรวจซ้ำ) */
export function podFailMissing(
  k: PodFailKind | null,
  r: PodFailReason | undefined,
  note: string,
  photos: number,
): 'kind' | 'reason' | 'note' | 'photo' | null {
  if (!k) return 'kind';
  if (!r) return 'reason';
  if (r.requiresNote && !note.trim()) return 'note';
  if (k.photos && r.requiresPhoto && photos === 0) return 'photo';
  return null;
}

/** DO นี้แจ้งไม่สำเร็จแล้ว (จุดรับหรือจุดส่งปิดด้วยผลไม่สำเร็จ) */
export const podFailed = (m: PodDo): boolean =>
  m.pickup?.status === 'FAILED' || m.delivery?.status === 'FAILED';

/** รอบของ clientEventId ต่อ (จุด, ชนิด) จาก `match.retries` */
export const retryOf = (m: PodDo, step: PodStep): number =>
  m.retries.find((r) => r.stopId === step.stopId && r.type === step.type)?.n ?? 0;

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
export async function podClientEventId(
  token: string,
  step: PodStep,
  attempt = 0,
  variant?: string,
): Promise<string> {
  // attempt = ครั้งที่ผู้จัดรถ "ไม่ใช้" event ชนิดนี้ของจุดนี้ (`match.retries`) → กดใหม่ได้ event ใหม่ (QA M2)
  // variant (Q-LINK) = ผลที่แจ้ง — ปิดงานด้วยผลต่างกันได้ id ต่างกัน (ไม่ชนกับ "ส่ง POD" ที่ปิดด้วย DELIVERED)
  const base = `tms-pod|${token}|${step.stopId}|${step.type}${variant ? `|${variant}` : ''}`;
  const data = new TextEncoder().encode(attempt > 0 ? `${base}|${attempt}` : base);
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

// ---------------------------------------------------------------------------------------------
// ST4-T09 ส่ง POD ผ่านลิงก์

/** ชนิดรูปที่ API รับ (รูป/ลายเซ็น) + เพดาน 10 MB/ไฟล์ (เท่า /v1/documents) */
export const POD_LINK_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const POD_LINK_FILE_MAX = 10 * 1024 * 1024;

/** ร่างหลักฐานบนหน้าลิงก์ (ข้อที่ checklist บังคับนอกจากรูป/ลายเซ็น) */
export interface PodLinkDraft {
  photos: number;
  signed: boolean;
  note: string;
  checks: Record<string, boolean>;
  choices: Record<string, string>;
  barcodes: string;
  pin: string;
  rating: number | null;
}

/**
 * ข้อบังคับที่ยังขาด (ตรวจก่อนส่ง — server ตรวจซ้ำด้วย checklist จริง) เรียงตาม checklist
 * PHOTO นับขั้นต่ำ `minCount` (ไม่ส่ง = 1) · BOOLEAN ต้องติ๊ก "ใช่" · PIN ตัวเลขครบหลัก
 */
export function podLinkMissing(fields: PodLinkField[], d: PodLinkDraft): PodLinkField[] {
  return fields.filter((f) => {
    if (f.level !== 'REQUIRED') return false;
    switch (f.type) {
      case 'PHOTO':
        return d.photos < (f.minCount ?? 1);
      case 'SIGNATURE':
        return !d.signed;
      case 'NOTE':
        return !d.note.trim();
      case 'BOOLEAN':
        return d.checks[f.key] !== true;
      case 'SINGLE_CHOICE':
        return !d.choices[f.key];
      case 'BARCODE':
        return !barcodeList(d.barcodes).length;
      case 'PIN':
        return !new RegExp(`^[0-9]{${f.length ?? 4}}$`).test(d.pin);
      case 'RATING':
        return d.rating === null;
      default:
        return false;
    }
  });
}

/** รหัสสแกน: บรรทัดละ 1 ตัดช่องว่าง/บรรทัดว่าง */
export const barcodeList = (v: string) =>
  v
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

/** body ของ POD จากร่าง (ส่งเฉพาะข้อที่ checklist ใช้) */
export function podLinkBody(
  doNo: string,
  fields: PodLinkField[],
  d: PodLinkDraft,
  files: { photos: string[]; signature: string | null },
): PodCaptureBody {
  const has = (t: string) => fields.some((f) => f.type === t);
  const body: PodCaptureBody = { doNo, photoDocumentIds: files.photos };
  if (files.signature) body.signatureDocumentId = files.signature;
  if (has('NOTE') && d.note.trim()) body.note = d.note.trim();
  const keys = (t: string) => new Set(fields.filter((f) => f.type === t).map((f) => f.key));
  const ck = keys('BOOLEAN');
  const checks = Object.fromEntries(Object.entries(d.checks).filter(([k]) => ck.has(k)));
  if (Object.keys(checks).length) body.checks = checks;
  const ch = keys('SINGLE_CHOICE');
  const choices = Object.fromEntries(Object.entries(d.choices).filter(([k, v]) => ch.has(k) && v));
  if (Object.keys(choices).length) body.choices = choices;
  if (has('BARCODE') && barcodeList(d.barcodes).length) body.barcodes = barcodeList(d.barcodes);
  if (has('PIN') && d.pin) body.pin = d.pin;
  if (has('RATING') && d.rating !== null) body.rating = d.rating;
  return body;
}

// ---------------------------------------------------------------------------------------------
// ST4-T10 ยอดส่งจริงผ่านลิงก์ — ค่าเริ่มต้น = แผน · น้อยกว่าแผน = ต้องเลือกเหตุผล (หนึ่งเหตุผลต่อ DO ใช้กับทุกบรรทัดที่ขาด)

export type PodLinkLine = PodLinkPod['lines'][number];
export type PodLinkReason = PodLinkPod['rejectReasons'][number];

const QTY = /^\d{1,11}(\.\d{1,3})?$/;
/** "12.5" → 12500n (หน่วย 1/1000) · ผิดรูป = null */
export function linkMilli(v: string): bigint | null {
  const s = v.trim();
  if (!QTY.test(s)) return null;
  const [w, f = ''] = s.split('.') as [string, string?];
  return BigInt(w) * 1000n + BigInt((f + '000').slice(0, 3));
}
export function linkQtyStr(m: bigint): string {
  const whole = m / 1000n;
  const frac = (m % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
/** ปุ่ม − / + ทีละ 1 (ไม่ต่ำกว่า 0 ไม่เกินแผน) */
export function stepQty(v: string, planned: string, dir: -1 | 1): string {
  const p = linkMilli(planned) ?? 0n;
  const cur = linkMilli(v) ?? p;
  const next = cur + BigInt(dir) * 1000n;
  return linkQtyStr(next < 0n ? 0n : next > p ? p : next);
}
/** สถานะของยอดส่งจริงในฟอร์ม: บรรทัดผิด (ผิดรูป/เกินแผน), มีที่ขาด */
export function linkQtyState(lines: PodLinkLine[], qty: Record<number, string>) {
  let bad = false;
  let short = false;
  for (const l of lines) {
    const p = linkMilli(l.qtyPlanned);
    const a = linkMilli(qty[l.lineNo] ?? l.qtyPlanned);
    if (p === null || a === null || a > p) bad = true;
    else if (a < p) short = true;
  }
  return { bad, short };
}
/** body.lines — ส่งครบทุกบรรทัดตามแผน = ไม่ส่ง (API ถือว่าตามแผน) */
export function podLinkLines(
  lines: PodLinkLine[],
  qty: Record<number, string>,
  reason: string | null,
  note: string,
): PodCaptureBody['lines'] {
  const { short } = linkQtyState(lines, qty);
  if (!short) return undefined;
  return lines.map((l) => {
    const v = (qty[l.lineNo] ?? l.qtyPlanned).trim();
    const isShort = (linkMilli(v) ?? 0n) < (linkMilli(l.qtyPlanned) ?? 0n);
    return {
      lineNo: l.lineNo,
      qtyActual: v,
      ...(isShort ? { rejectReasonCodeId: reason, note: note.trim() || null } : {}),
    };
  });
}

/** จองไฟล์ผ่านลิงก์ (ผูกกับ DO นี้) → PUT เนื้อไฟล์ → id · ชนิด/ขนาดผิด → Error('bad_file') */
export async function uploadPodLinkFile(
  token: string,
  doNo: string,
  f: Blob,
  kind: PodFileKind,
  name: string,
): Promise<string> {
  const mime = POD_LINK_IMAGE_MIME.find((m) => m === f.type);
  if (!mime || f.size > POD_LINK_FILE_MAX || f.size === 0) throw new Error('bad_file');
  const r = await unwrap(
    api.POST('/v1/public/pod/{token}/files', {
      params: { path: { token } },
      body: { doNo, kind, mime, bytes: f.size, filename: name },
    }),
  );
  const u = new URL(r.uploadUrl, location.origin);
  const up = await fetch(u.pathname + u.search, { method: 'PUT', body: f });
  if (!up.ok) throw new ApiError((await up.json()) as never);
  return r.id;
}

/** ส่ง POD อย่างเดียว (จุดส่งปิดแล้ว) */
export function usePodCapture(token: string) {
  return useMutation({
    mutationFn: (body: PodCaptureBody) =>
      unwrap(api.POST('/v1/public/pod/{token}/pod', { params: { path: { token } }, body })),
  });
}
