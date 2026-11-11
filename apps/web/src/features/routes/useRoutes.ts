import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, idempotent, unwrap } from '../../api';
import type { RefOption } from '../master/RefPicker';
import { refetchOnStale } from '../master/problems';
import { useCursorList } from '../master/useCursorList';

export type Route = Schemas['RouteDto'];
export type RouteInput = Schemas['UpdateRouteDto'];
export type RouteCreate = Schemas['CreateRouteDto'];

const KEY = 'routes';

export interface RouteFilters {
  route: string;
  status: string;
}

export function useRouteList(filters: RouteFilters) {
  return useCursorList<Route>(KEY, { ...filters }, (query) =>
    unwrap(api.GET('/v1/routes', { params: { query: query as never } })),
  );
}

export function useRouteSummary() {
  return useQuery({
    queryKey: [KEY, 'summary'],
    queryFn: () => unwrap(api.GET('/v1/routes/summary')),
  });
}

/** ช่องเลือกต้นทาง/ปลายทาง — สถานที่ที่ใช้งาน ค้นด้วย `q` ทีละ 20 รายการ */
export async function searchSites(q: string): Promise<RefOption[]> {
  const r = await unwrap(
    api.GET('/v1/customer-sites', {
      params: { query: { status: 'active', limit: 20, ...(q ? { q } : {}) } },
    }),
  );
  return r.data.map((s) => ({ id: s.id, label: s.name, sub: s.code }));
}

export function useCreateRoute() {
  const qc = useQueryClient();
  return useMutation({
    /** idempotencyKey ต่อการเปิดฟอร์ม 1 ครั้ง — กดซ้ำ/ส่งซ้ำได้รายการเดียว (ST0-T07) */
    mutationFn: (v: { body: RouteCreate; idempotencyKey: string }) =>
      idempotent(() =>
        api.POST('/v1/routes', {
          body: v.body,
          headers: { 'Idempotency-Key': v.idempotencyKey },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useUpdateRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; body: RouteInput }) =>
      unwrap(
        api.PATCH('/v1/routes/{id}', {
          params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
          body: v.body,
        }),
      ),
    onError: refetchOnStale(qc, KEY),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: ['history'] });
    },
  });
}

/** ปุ่ม "คำนวณจากพิกัด" — ไม่บันทึก */
export function useRouteEstimate() {
  return useMutation({
    mutationFn: (v: { originId: string; destinationId: string }) =>
      unwrap(api.POST('/v1/routes/estimate', { body: v })),
  });
}

export function useRouteAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      id: string;
      version: number;
      action: 'activate' | 'deactivate' | 'delete';
      reason?: string;
    }): Promise<Route | null> => {
      // If-Match: กันเปลี่ยนสถานะ/ลบรายการที่ผู้อื่นเพิ่งแก้ (412 → แจ้งให้โหลดใหม่)
      const p = {
        params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
      };
      if (v.action === 'activate')
        return unwrap(api.POST('/v1/routes/{id}/activate', { ...p, body: {} }));
      if (v.action === 'deactivate')
        return unwrap(
          api.POST('/v1/routes/{id}/deactivate', { ...p, body: { reason: v.reason ?? '' } }),
        );
      await unwrap(api.POST('/v1/routes/{id}/delete', { ...p, body: { reason: v.reason ?? '' } }));
      return null;
    },
    onError: refetchOnStale(qc, KEY),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: ['history'] });
    },
  });
}
