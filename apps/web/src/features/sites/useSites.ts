import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../api';
import { useCursorList } from '../master/useCursorList';

export type Site = Schemas['SiteDto'];
export type SiteInput = Schemas['UpdateSiteDto'];
export type SiteCreate = Schemas['CreateSiteDto'];
export type SiteKind = Site['kind'];
export type VehicleClass = NonNullable<Site['maxVehicleClass']>;

export const SITE_KINDS: SiteKind[] = ['PICKUP', 'DROPOFF', 'WAREHOUSE'];
/** ลำดับตามต้นแบบ (ตัวเลือกในฟอร์ม/ตัวกรอง) */
export const VEHICLE_CLASSES: VehicleClass[] = ['6W', '10W', 'TRAILER', 'SEMI_TRAILER'];

const KEY = 'customer-sites';

export interface SiteFilters {
  kind: string;
  q: string;
  customerName: string;
  maxVehicleClass: string;
  pinned: string;
  customerId: string;
}

export function useSiteList(filters: SiteFilters) {
  return useCursorList<Site>(KEY, { ...filters }, (query) =>
    unwrap(api.GET('/v1/customer-sites', { params: { query: query as never } })),
  );
}

export function useSiteSummary() {
  return useQuery({
    queryKey: [KEY, 'summary'],
    queryFn: () => unwrap(api.GET('/v1/customer-sites/summary')),
  });
}

/** สถานที่ของลูกค้ารายเดียว (แท็บ "ที่อยู่ส่ง" ใน drawer ลูกค้า) */
export function useCustomerSites(customerId: string, enabled: boolean) {
  return useQuery({
    queryKey: [KEY, 'by-customer', customerId],
    enabled,
    queryFn: () =>
      unwrap(
        api.GET('/v1/customer-sites', {
          params: { query: { customerId, limit: 200, sort: 'code' } },
        }),
      ),
  });
}

/** ลูกค้าที่ใช้งาน — ตัวเลือก "ลูกค้า" ในฟอร์มสถานที่ */
export function useCustomerOptions(enabled: boolean) {
  return useQuery({
    queryKey: ['customers', 'options'],
    enabled,
    queryFn: () =>
      unwrap(api.GET('/v1/customers', { params: { query: { status: 'active', limit: 200 } } })),
  });
}

export function useCreateSite() {
  const qc = useQueryClient();
  return useMutation({
    /** idempotencyKey ต่อการเปิดฟอร์ม 1 ครั้ง — กดซ้ำ/ส่งซ้ำได้สถานที่เดียว (ST0-T07) */
    mutationFn: (v: { body: SiteCreate; idempotencyKey: string }) =>
      unwrap(
        api.POST('/v1/customer-sites', {
          body: v.body,
          headers: { 'Idempotency-Key': v.idempotencyKey },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useUpdateSite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; body: SiteInput }) =>
      unwrap(
        api.PATCH('/v1/customer-sites/{id}', {
          params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
          body: v.body,
        }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: ['history'] });
    },
  });
}

export function useSiteAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      id: string;
      version: number;
      action: 'activate' | 'deactivate' | 'delete';
      reason?: string;
    }): Promise<Site | null> => {
      // If-Match: กันเปลี่ยนสถานะ/ลบรายการที่ผู้อื่นเพิ่งแก้ (412 → แจ้งให้โหลดใหม่)
      const p = {
        params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
      };
      if (v.action === 'activate')
        return unwrap(api.POST('/v1/customer-sites/{id}/activate', { ...p, body: {} }));
      if (v.action === 'deactivate')
        return unwrap(
          api.POST('/v1/customer-sites/{id}/deactivate', {
            ...p,
            body: { reason: v.reason ?? '' },
          }),
        );
      await unwrap(
        api.POST('/v1/customer-sites/{id}/delete', { ...p, body: { reason: v.reason ?? '' } }),
      );
      return null;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: ['history'] });
    },
  });
}
