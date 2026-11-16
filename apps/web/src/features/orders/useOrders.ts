import type { Schemas } from '@tms/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, idempotent, unwrap } from '../../api';
import { refetchOnStale } from '../master/problems';
import { useCursorList } from '../master/useCursorList';
import type { Order, OrderBody, TemplatePayload } from './orderForm';

export type OrderTemplate = Schemas['OrderTemplateDto'];
export type OrderSummary = Schemas['OrderSummaryDto'];

const KEY = 'orders';
const TPL = 'order-templates';

/** ตัวกรองของรายการ (ค่าตรงกับ query ของ GET /v1/orders) */
export interface OrderFilters {
  status: string;
  holdReason: string;
  source: string;
  q: string;
  requestedFrom: string;
  requestedTo: string;
}

export function useOrderList(filters: OrderFilters) {
  return useCursorList<Order>(
    KEY,
    { ...filters },
    (query) => unwrap(api.GET('/v1/orders', { params: { query: query as never } })),
    { sort: '-updatedAt', size: 10, persist: 'so.list' },
  );
}

export function useOrderSummary() {
  return useQuery({
    queryKey: [KEY, 'summary'],
    queryFn: () => unwrap(api.GET('/v1/orders/summary')),
  });
}

/** ใบเดียว (มี `editableFields`) — ETag = version ในตัวใบ */
export function useOrder(id: string | null) {
  return useQuery({
    queryKey: [KEY, 'one', id],
    enabled: !!id,
    staleTime: 0,
    // ผู้อื่นแก้อยู่ (ST3-T08) → ตรวจซ้ำทุก 30 วินาที ให้ป้าย "กำลังแก้ไขโดย …" หายเองเมื่อเขาปิด/ล็อกหมดอายุ
    refetchInterval: (q) => {
      const l = (q.state.data as Order | undefined)?.editLock;
      return l && !l.mine ? 30_000 : false;
    },
    queryFn: () =>
      unwrap(api.GET('/v1/orders/{id}', { params: { path: { id: id! } } })) as Promise<Order>,
  });
}

export function useCreateOrder() {
  const qc = useQueryClient();
  return useMutation({
    /** 1 การเปิดฟอร์ม = 1 Idempotency-Key — กดซ้ำ/เน็ตช้าได้ใบเดียว */
    mutationFn: (v: { body: OrderBody; idempotencyKey: string }) =>
      idempotent(() =>
        api.POST('/v1/orders', {
          body: v.body,
          headers: { 'Idempotency-Key': v.idempotencyKey },
        }),
      ) as Promise<Order>,
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useUpdateOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; body: Schemas['UpdateOrderDto'] }) =>
      unwrap(
        api.PATCH('/v1/orders/{id}', {
          params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } },
          body: v.body,
        }),
      ),
    onError: refetchOnStale(qc, KEY),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

/** ยกเลิกใบสั่งขนส่ง (ST3-T10) — เหตุผล ≥ 10 ตัวอักษร · If-Match = version ที่เห็นใน drawer */
export function useCancelOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; reason: string }) =>
      unwrap(
        api.POST('/v1/orders/{id}/cancel', {
          params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } },
          body: { reason: v.reason },
        }),
      ) as Promise<Order>,
    onError: refetchOnStale(qc, KEY),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

/** รับ/ไม่รับ การเปลี่ยนแปลงจากต้นทาง (ST3-T10) */
export function useDecideSourceChange() {
  const qc = useQueryClient();
  return useMutation({
    /** If-Match = version ของใบที่ผู้ใช้เห็น diff (diff คำนวณกับข้อมูลตอนอ่าน) */
    mutationFn: (v: {
      id: string;
      version: number;
      changeId: string;
      accept: boolean;
      reason: string;
    }) =>
      unwrap(
        v.accept
          ? api.POST('/v1/orders/{id}/source-changes/{changeId}/accept', {
              params: {
                path: { id: v.id, changeId: v.changeId },
                header: { 'If-Match': `"${v.version}"` },
              },
              body: { reason: v.reason },
            })
          : api.POST('/v1/orders/{id}/source-changes/{changeId}/reject', {
              params: {
                path: { id: v.id, changeId: v.changeId },
                header: { 'If-Match': `"${v.version}"` },
              },
              body: { reason: v.reason },
            }),
      ) as Promise<Order>,
    onError: refetchOnStale(qc, KEY),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

// ---------- ล็อกการแก้ (ST3-T08) ----------

/** ปลดล็อกของผู้อื่น (`orders:unlock`) พร้อมเหตุผล ≥ 10 ตัวอักษร — server ลง audit */
export function useForceUnlock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      unwrap(
        api.POST('/v1/orders/{id}/unlock', {
          params: { path: { id: v.id } },
          body: { reason: v.reason },
        }),
      ),
    onSettled: (_d, _e, v) => qc.invalidateQueries({ queryKey: [KEY, 'one', v.id] }),
  });
}

// ---------- เทมเพลตงานประจำ ----------

/** รายการเทมเพลตทีละ 20 (cursor) — "แสดงเพิ่ม" ดึงหน้าถัดไป */
export function useTemplates(q: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: [TPL, q],
    enabled,
    initialPageParam: null as string | null,
    getNextPageParam: (p: { nextCursor: string | null; hasMore: boolean }) =>
      p.hasMore ? p.nextCursor : null,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/v1/order-templates', {
          params: {
            query: {
              limit: 20,
              sort: '-updatedAt',
              ...(q ? { q } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
  });
}

export function useCreateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { body: { name: string; payload: TemplatePayload }; idempotencyKey: string }) =>
      idempotent(() =>
        api.POST('/v1/order-templates', {
          body: v.body,
          headers: { 'Idempotency-Key': v.idempotencyKey },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: [TPL] }),
  });
}

export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; reason: string }) =>
      unwrap(
        api.POST('/v1/order-templates/{id}/delete', {
          params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } },
          body: { reason: v.reason },
        }),
      ),
    onError: refetchOnStale(qc, TPL),
    onSuccess: () => qc.invalidateQueries({ queryKey: [TPL] }),
  });
}

// ---------- ข้อมูลหลักที่ฟอร์มอ้าง ----------

/** ประเภทรถที่ใช้งาน (ตัวเลือกแบบ select ตามต้นแบบ) */
export function useVehicleTypeOptions() {
  return useQuery({
    queryKey: ['vehicle-types', 'options'],
    staleTime: 5 * 60_000,
    queryFn: () =>
      unwrap(
        api.GET('/v1/vehicle-types', {
          params: { query: { status: 'active', limit: 200 } as never },
        }),
      ),
  });
}

const PICK = 20;

export const searchCustomers = (q: string) =>
  unwrap(
    api.GET('/v1/customers', {
      params: { query: { status: 'active', limit: PICK, ...(q ? { q } : {}) } as never },
    }),
  ).then((r) => r.data.map((c) => ({ id: c.id, label: c.legalName, sub: c.code })));

/** สถานที่: ของลูกค้าที่เลือกขึ้นก่อน (ORD-021) แล้วตามด้วยสถานที่อื่น */
export const searchSites = (customerId: string | null) => async (q: string) => {
  const get = (extra: Record<string, string>) =>
    unwrap(
      api.GET('/v1/customer-sites', {
        params: {
          query: { status: 'active', limit: PICK, ...(q ? { q } : {}), ...extra } as never,
        },
      }),
    ).then((r) => r.data);
  const mine = customerId ? await get({ customerId }) : [];
  const all = await get({});
  const seen = new Set(mine.map((s) => s.id));
  return [...mine, ...all.filter((s) => !seen.has(s.id))]
    .slice(0, PICK)
    .map((s) => ({ id: s.id, label: s.name, sub: `${s.code} · ${s.address?.province ?? ''}` }));
};

export const searchUnits = (q: string) =>
  unwrap(
    api.GET('/v1/units', {
      params: { query: { status: 'active', limit: PICK, ...(q ? { q } : {}) } as never },
    }),
  ).then((r) => r.data.map((u) => ({ id: u.id, label: u.name, sub: u.code })));

export const searchProducts = (q: string) =>
  unwrap(
    api.GET('/v1/products', {
      params: { query: { status: 'active', limit: PICK, ...(q ? { q } : {}) } as never },
    }),
  ).then((r) =>
    r.data.map((p) => ({
      id: p.id,
      label: p.name,
      sub: p.code,
      unit: p.unit ? { id: p.unit.id, label: p.unit.name } : null,
    })),
  );

// ---------- หน้าใบค้าง (ST3-T07) ----------

const ifMatch = (version: number) => ({ 'If-Match': `"${version}"` });

/** ตารางใบค้าง: ON_HOLD ทุกเหตุ (held=true) + กรองเหตุ/ค้นหา/ที่มา */
export function useHoldList(filters: { holdReason: string; q: string; source: string }) {
  return useCursorList<Order>(
    KEY,
    { held: 'true', ...filters },
    (query) => unwrap(api.GET('/v1/orders', { params: { query: query as never } })),
    { sort: '-updatedAt', size: 10, persist: 'hold.list' },
  );
}

/** จับคู่ลูกค้า (endpoint ST3-T06) — 409 alias_conflict ให้ผู้เรียกถามเหตุผลแล้วส่ง confirmReassign */
export function useMapCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; body: Schemas['MapCustomerDto'] }) =>
      unwrap(
        api.POST('/v1/orders/{id}/map-customer', {
          params: { path: { id: v.id }, header: ifMatch(v.version) as never },
          body: v.body,
        }),
      ) as Promise<Order>,
    onError: refetchOnStale(qc, KEY),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

/** เลือกสถานที่ของจุด (endpoint ST3-T06) */
export function useMapSite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; sequence: number; siteId: string }) =>
      unwrap(
        api.POST('/v1/orders/{id}/stops/{sequence}/map-site', {
          params: {
            path: { id: v.id, sequence: String(v.sequence) },
            header: ifMatch(v.version) as never,
          },
          body: { siteId: v.siteId },
        }),
      ) as Promise<Order>,
    onError: refetchOnStale(qc, KEY),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

/** ตรวจอีกครั้ง — คิดราคา + ประเมินเหตุค้างใหม่จากข้อมูลหลักปัจจุบัน */
export function useReevaluate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number }) =>
      unwrap(
        api.POST('/v1/orders/{id}/reevaluate', {
          params: { path: { id: v.id }, header: ifMatch(v.version) as never },
        }),
      ) as Promise<Order>,
    onError: refetchOnStale(qc, KEY),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

/** ยืนยันข้อมูลใบที่ต้นทางแจ้งว่าไม่ครบ (SOURCE_ERROR) — เหตุผล ≥ 10 */
export function useResolveSourceError() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; reason: string }) =>
      unwrap(
        api.POST('/v1/orders/{id}/resolve-source-error', {
          params: { path: { id: v.id }, header: ifMatch(v.version) as never },
          body: { reason: v.reason },
        }),
      ) as Promise<Order>,
    onError: refetchOnStale(qc, KEY),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export type SiteOption = Schemas['SiteDto'];

/**
 * สถานที่ให้เลือกสำหรับจุด: ของลูกค้าของใบก่อน แล้วของบริษัท — สถานที่ของลูกค้าอื่นไม่แสดง
 * (เลือกไม่ได้ — 422 site_other_customer) · ใบยังไม่มีลูกค้า = เฉพาะของบริษัท
 */
export async function searchStopSites(customerId: string | null, q: string) {
  const query = { status: 'active', limit: PICK, ...(q ? { q } : {}) };
  const get = (extra: Record<string, string>) =>
    unwrap(
      api.GET('/v1/customer-sites', { params: { query: { ...query, ...extra } as never } }),
    ).then((r) => r.data);
  const [mine, all] = await Promise.all([customerId ? get({ customerId }) : [], get({})]);
  const seen = new Set<string>();
  return [...mine, ...all]
    .filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return !s.customer || s.customer.id === customerId;
    })
    .slice(0, PICK);
}
