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
