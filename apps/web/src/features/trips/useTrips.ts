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

export type BulkResults = Schemas['BulkTripResultsDto'];
type AssignBody = Schemas['AssignTripDto'];

const invalidateAll = (qc: ReturnType<typeof useQueryClient>) => {
  qc.invalidateQueries({ queryKey: [KEY] });
  qc.invalidateQueries({ queryKey: [BOARD_KEY] });
  qc.invalidateQueries({ queryKey: ['orders'] });
};

/**
 * จัดรถ (→ ASSIGNED) / จัดรถและปล่อยเที่ยว (`dispatch: true` → DISPATCHED ในคำขอเดียว) — POST /v1/trips/{id}/assign
 * ST3-T17 (docs/04 D2 "Assign vs Dispatch แยกปุ่ม") · If-Match = version ที่เห็น
 */
export function useAssignTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; body: AssignBody }): Promise<TripDetail> => {
      const key = crypto.randomUUID();
      return idempotent(() =>
        api.POST('/v1/trips/{id}/assign', {
          params: { path: { id: v.id } },
          body: v.body,
          headers: { 'If-Match': `"${v.version}"`, 'Idempotency-Key': key },
        }),
      );
    },
    onSuccess: (t) => qc.setQueryData([KEY, t.id], t),
    onSettled: () => invalidateAll(qc),
  });
}

/** ปล่อยเที่ยวที่จัดรถแล้ว (ASSIGNED → DISPATCHED) — POST /v1/trips/{id}/dispatch */
export function useDispatchTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      id: string;
      version: number;
      body: Schemas['DispatchTripDto'];
    }): Promise<TripDetail> => {
      const key = crypto.randomUUID();
      return idempotent(() =>
        api.POST('/v1/trips/{id}/dispatch', {
          params: { path: { id: v.id } },
          body: v.body,
          headers: { 'If-Match': `"${v.version}"`, 'Idempotency-Key': key },
        }),
      );
    },
    onSuccess: (t) => qc.setQueryData([KEY, t.id], t),
    onSettled: () => invalidateAll(qc),
  });
}

/** จัดรถ / จัดรถและปล่อยเที่ยว หลายเที่ยว — POST /v1/trips/bulk-assign (207 ผลต่อรายการ) */
export function useBulkAssign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: Schemas['BulkAssignTripsDto']): Promise<BulkResults> => {
      const key = crypto.randomUUID();
      return idempotent(() =>
        api.POST('/v1/trips/bulk-assign', { body: v, headers: { 'Idempotency-Key': key } }),
      );
    },
    onSettled: () => invalidateAll(qc),
  });
}

export type SendAllResults = Schemas['SendAllTripsResultDto'];

/**
 * ส่งแผนทั้งวัน (ST3-T18 "Send all" — POST /v1/trips/send-all) → 207 ผลต่อเที่ยว + สถานะส่งครบของวัน
 * ส่งเฉพาะเที่ยวที่ติ๊ก (+ version ที่เห็น) เสมอ — ไม่ปล่อยเที่ยวที่ผู้ใช้ไม่เห็นในรายการ
 */
export function useSendAll() {
  const qc = useQueryClient();
  return useMutation({
    /** `key` = Idempotency-Key ต่อการส่ง 1 ครั้งของ dialog (QA M1 — กดซ้ำได้ผลเดิม ไม่ส่งสองรอบ) */
    mutationFn: ({
      key,
      ...v
    }: Schemas['SendAllTripsDto'] & { key: string }): Promise<SendAllResults> =>
      idempotent(() =>
        api.POST('/v1/trips/send-all', { body: v, headers: { 'Idempotency-Key': key } }),
      ),
    onSettled: () => invalidateAll(qc),
  });
}

/**
 * ตรวจล่วงหน้าก่อนส่งแผน (ST3-T18 QA L2 — `dryRun`: กฎ T14 ชุดเดียวกับตอนปล่อย แล้วย้อน) → tripId → problem (null = ผ่าน)
 * ไม่มีเที่ยว/ไม่มีสิทธิ์ = ไม่เรียก
 */
export function useSendCheck(
  date: string,
  trips: { id: string; version: number }[],
  enabled: boolean,
): Record<string, unknown> | undefined {
  const q = useQuery({
    queryKey: [KEY, 'send-check', date, trips.map((x) => `${x.id}:${x.version}`).join(',')],
    enabled: enabled && trips.length > 0,
    staleTime: 0,
    retry: false,
    queryFn: () =>
      unwrap(
        api.POST('/v1/trips/send-all', {
          body: {
            date,
            dryRun: true,
            items: trips.map((x) => ({ tripId: x.id, version: x.version })),
          },
        }),
      ) as Promise<SendAllResults>,
  });
  if (!q.data) return undefined;
  return Object.fromEntries(q.data.results.map((r) => [r.tripId, r.trip ? null : r.problem]));
}

/**
 * ตัวเลือก "รถ" / "คนขับ" ของการจัดรถใน drawer เที่ยว (ต้นแบบ SO drawer "จัดรถ": select รถ + คนขับ)
 * รถ: ใช้งานได้ ไม่ใช่หาง · รถบริษัท (เที่ยวที่ไม่มีรถร่วม) หรือรถของรถร่วมรายนั้น · คนขับ: พร้อมใช้ (ต้องมี `master:read`)
 */
export function useAssignOptions(carrierId: string | null, enabled: boolean) {
  const vehicles = useQuery({
    queryKey: [KEY, 'assign-vehicles', carrierId],
    enabled,
    queryFn: () =>
      unwrap(
        api.GET('/v1/vehicles', {
          params: {
            query: {
              limit: 200,
              status: 'ready,maintenance,parked',
              ...(carrierId ? { ownership: 'SUBCONTRACT', carrierId } : { ownership: 'OWN' }),
            } as never,
          },
        }),
      ).then((p) => p.data.filter((v) => v.unitRole !== 'TRAILER')),
  });
  const drivers = useQuery({
    queryKey: [KEY, 'assign-drivers', carrierId],
    enabled,
    queryFn: () =>
      unwrap(
        api.GET('/v1/drivers', {
          params: {
            query: { limit: 200, status: 'active', ...(carrierId ? { carrierId } : {}) } as never,
          },
        }),
      ).then((p) => p.data),
  });
  return { vehicles, drivers };
}

// ---------------------------------------------------------------- ใบคุมรถ PDF (ST3-T20)

export type TripSheet = Schemas['TripSheetDto'];
export type TripSheetLink = Schemas['TripSheetLinkDto'];

/** ดาวน์โหลดไฟล์จากลิงก์อายุสั้นของ `/v1/documents/{id}/content` (แบบเดียวกับไฟล์แนบ — openDocFile) */
export function downloadSheet(s: TripSheet): void {
  const url = s.document.downloadUrl;
  if (!url) return;
  const u = new URL(url, location.origin);
  const a = document.createElement('a');
  a.href = u.pathname + u.search;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** "พิมพ์ใบคุมรถ" ของเที่ยว → POST /v1/trips/{id}/sheet (สร้าง PDF ใหม่ทุกครั้ง = ข้อมูล ณ ตอนกด) แล้วดาวน์โหลด */
export function usePrintTripSheet() {
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST('/v1/trips/{id}/sheet', { params: { path: { id } } })) as Promise<TripSheet>,
    onSuccess: downloadSheet,
  });
}

/** ใบงานประจำวัน: ทุกเที่ยวของวัน (หรือรถคันเดียว) → POST /v1/trip-sheets แล้วดาวน์โหลด */
export function usePrintDaySheet() {
  return useMutation({
    mutationFn: (v: { date: string; vehicleId?: string }) =>
      unwrap(api.POST('/v1/trip-sheets', { body: v })) as Promise<TripSheet>,
    onSuccess: downloadSheet,
  });
}

/** "ส่งให้คนขับ" (เฟส 0 = คัดลอกลิงก์) → POST /v1/trips/{id}/sheet/driver-link */
export function useTripSheetLink() {
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.POST('/v1/trips/{id}/sheet/driver-link', { params: { path: { id } } }),
      ) as Promise<TripSheetLink>,
  });
}

/** เพิกถอนลิงก์ใบคุมรถของเที่ยว (เหตุผล ≥ 10) → POST /v1/trips/{id}/sheet/driver-link/revoke */
export function useRevokeTripSheetLinks() {
  return useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      unwrap(
        api.POST('/v1/trips/{id}/sheet/driver-link/revoke', {
          params: { path: { id: v.id } },
          body: { reason: v.reason },
        }),
      ) as Promise<{ revoked: number }>,
  });
}

export type HireOptions = Schemas['HireOptionsDto'];

/** ST3-T22 ตัวเลือกจ้างรถร่วมของเที่ยว (GET /v1/trips/{id}/hire-options) — ราคา rate card ขาซื้อ + 5 ครั้งล่าสุด + ถูกสุด */
export function useHireOptions(id: string, enabled: boolean) {
  return useQuery({
    queryKey: [KEY, id, 'hire-options'],
    enabled,
    staleTime: 0,
    queryFn: () =>
      unwrap(
        api.GET('/v1/trips/{id}/hire-options', { params: { path: { id } } }),
      ) as Promise<HireOptions>,
  });
}

/** ST3-T22 จ้างรถร่วม = เสนองาน (POST /v1/trips/{id}/offer) — ราคาซื้อ + เหตุผลการเลือก · If-Match = version ที่เห็น */
export function useHireTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      id: string;
      version: number;
      body: Schemas['OfferTripDto'];
    }): Promise<TripDetail> => {
      const key = crypto.randomUUID();
      return idempotent(() =>
        api.POST('/v1/trips/{id}/offer', {
          params: { path: { id: v.id } },
          body: v.body,
          headers: { 'If-Match': `"${v.version}"`, 'Idempotency-Key': key },
        }),
      );
    },
    onSuccess: (t) => qc.setQueryData([KEY, t.id], t),
    onSettled: () => invalidateAll(qc),
  });
}

// ---------- ST3-T23 ลิงก์ข้อเสนองานรถร่วม ----------

export type OfferLink = Schemas['OfferLinkDto'];
export type SubconOffer = Schemas['SubconOfferDto'];
export type OfferView = Schemas['OfferLinkViewDto'];

/** ลิงก์ที่ใช้ได้ของการจ้างปัจจุบัน (`trips:assign`) — null = ไม่มี */
export function useOfferLink(id: string, enabled: boolean) {
  return useQuery({
    queryKey: [KEY, id, 'offer-link'],
    queryFn: () => unwrap(api.GET('/v1/trips/{id}/offer-link', { params: { path: { id } } })),
    select: (r) => r.link,
    enabled,
  });
}

/** ประวัติการจ้าง + การส่งลิงก์ (แท็บกิจกรรม) — มีรายการรอส่ง = โหลดซ้ำทุก 3 วิ */
export function useTripOffers(id: string, enabled: boolean) {
  return useQuery({
    queryKey: [KEY, id, 'offers'],
    queryFn: () => unwrap(api.GET('/v1/trips/{id}/offers', { params: { path: { id } } })),
    select: (r) => r.data,
    enabled,
    refetchInterval: (q) =>
      q.state.data?.data.some((o) =>
        o.messages.some((m) => m.status === 'queued' || m.status === 'sending'),
      )
        ? 3000
        : false,
  });
}

/** ส่งลิงก์ข้อเสนองานทาง LINE/SMS (ST3-T21 `/messages/send-link`) */
export function useSendOfferLink(tripId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { channel: 'line' | 'sms'; url: string; idempotencyKey: string }) =>
      idempotent(() =>
        api.POST('/v1/messages/send-link', {
          body: { channel: v.channel, url: v.url },
          headers: { 'Idempotency-Key': v.idempotencyKey },
        }),
      ),
    onSettled: () => void qc.invalidateQueries({ queryKey: [KEY, tripId, 'offers'] }),
  });
}

// ---------- หน้าลิงก์ของรถร่วม (public — ไม่ login) ----------

export function useOfferView(token: string) {
  return useQuery({
    queryKey: ['offer-link', token],
    queryFn: () => unwrap(api.GET('/v1/public/offers/{token}', { params: { path: { token } } })),
    retry: false,
  });
}

export function useRespondOffer(token: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      v:
        | { kind: 'accept'; body: Schemas['AcceptOfferDto'] }
        | { kind: 'reject'; body: Schemas['RejectOfferDto'] },
    ) =>
      unwrap(
        v.kind === 'accept'
          ? api.POST('/v1/public/offers/{token}/accept', {
              params: { path: { token } },
              body: v.body,
            })
          : api.POST('/v1/public/offers/{token}/reject', {
              params: { path: { token } },
              body: v.body,
            }),
      ),
    onSuccess: (view) => qc.setQueryData(['offer-link', token], view),
  });
}
