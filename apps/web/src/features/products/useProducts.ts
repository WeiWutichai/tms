import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, idempotent, unwrap } from '../../api';
import { refetchOnStale } from '../master/problems';
import { useCursorList } from '../master/useCursorList';

export type Product = Schemas['ProductDto'];
export type ProductInput = Schemas['UpdateProductDto'];
export type ProductCreate = Schemas['CreateProductDto'];
export type Unit = Schemas['UnitDto'];
export type UnitKind = Unit['kind'];
export type UnitCreate = Schemas['CreateUnitDto'];
export type UnitInput = Schemas['UpdateUnitDto'];

export const UNIT_KINDS: UnitKind[] = ['COUNT', 'WEIGHT', 'VOLUME'];
/** ประเภทพิเศษ (ต้นแบบ specProd: เปราะบาง / อันตราย / ควบคุมอุณหภูมิ) */
export const SPECIALS = ['fragile', 'hazardous', 'temp'] as const;
export type Special = (typeof SPECIALS)[number];

const KEY = 'products';
const UNITS = 'units';

export interface ProductFilters {
  name: string;
  unitId: string;
  special: string;
}

export function useProductList(filters: ProductFilters) {
  return useCursorList<Product>(KEY, { ...filters }, (query) =>
    unwrap(api.GET('/v1/products', { params: { query: query as never } })),
  );
}

export function useProductSummary() {
  return useQuery({
    queryKey: [KEY, 'summary'],
    queryFn: () => unwrap(api.GET('/v1/products/summary')),
  });
}

/** หน่วยทั้งหมดของ tenant (มีไม่มาก — โหลดครั้งเดียว 200 รายการ) ใช้ในตัวเลือก/ตัวกรองและหน้าจัดการหน่วย */
export function useUnits() {
  return useQuery({
    queryKey: [UNITS],
    queryFn: () => unwrap(api.GET('/v1/units', { params: { query: { limit: 200 } } })),
    select: (r) => r.data,
  });
}

export function useNextProductCode(enabled: boolean) {
  return useQuery({
    queryKey: [KEY, 'next-code'],
    enabled,
    staleTime: 0,
    queryFn: () => unwrap(api.GET('/v1/products/next-code')),
  });
}

export function useCreateProduct() {
  const qc = useQueryClient();
  return useMutation({
    /** idempotencyKey ต่อการเปิดฟอร์ม 1 ครั้ง — กดซ้ำ/ส่งซ้ำได้รายการเดียว (ST0-T07) */
    mutationFn: (v: { body: ProductCreate; idempotencyKey: string }) =>
      idempotent(() =>
        api.POST('/v1/products', {
          body: v.body,
          headers: { 'Idempotency-Key': v.idempotencyKey },
        }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: [UNITS] });
    },
  });
}

export function useUpdateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; body: ProductInput }) =>
      unwrap(
        api.PATCH('/v1/products/{id}', {
          params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
          body: v.body,
        }),
      ),
    onError: refetchOnStale(qc, KEY),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: [UNITS] });
      qc.invalidateQueries({ queryKey: ['history'] });
    },
  });
}

export function useProductAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      id: string;
      version: number;
      action: 'activate' | 'deactivate' | 'delete';
      reason?: string;
    }): Promise<Product | null> => {
      const p = {
        params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
      };
      if (v.action === 'activate')
        return unwrap(api.POST('/v1/products/{id}/activate', { ...p, body: {} }));
      if (v.action === 'deactivate')
        return unwrap(
          api.POST('/v1/products/{id}/deactivate', { ...p, body: { reason: v.reason ?? '' } }),
        );
      await unwrap(
        api.POST('/v1/products/{id}/delete', { ...p, body: { reason: v.reason ?? '' } }),
      );
      return null;
    },
    onError: refetchOnStale(qc, KEY),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: [UNITS] });
      qc.invalidateQueries({ queryKey: ['history'] });
    },
  });
}

// ---------- หน่วย ----------

export function useSaveUnit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      v:
        | { id?: undefined; body: UnitCreate; idempotencyKey: string }
        | { id: string; version: number; body: UnitInput },
    ): Promise<Unit> =>
      v.id === undefined
        ? idempotent(() =>
            api.POST('/v1/units', {
              body: v.body,
              headers: { 'Idempotency-Key': v.idempotencyKey },
            }),
          )
        : unwrap(
            api.PATCH('/v1/units/{id}', {
              params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
              body: v.body,
            }),
          ),
    onError: refetchOnStale(qc, UNITS),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [UNITS] });
      qc.invalidateQueries({ queryKey: [KEY] });
    },
  });
}

export function useUnitAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      id: string;
      version: number;
      action: 'activate' | 'deactivate' | 'delete';
      reason?: string;
    }): Promise<void> => {
      const p = {
        params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
      };
      if (v.action === 'activate')
        await unwrap(api.POST('/v1/units/{id}/activate', { ...p, body: {} }));
      else if (v.action === 'deactivate')
        await unwrap(
          api.POST('/v1/units/{id}/deactivate', { ...p, body: { reason: v.reason ?? '' } }),
        );
      else
        await unwrap(api.POST('/v1/units/{id}/delete', { ...p, body: { reason: v.reason ?? '' } }));
    },
    onError: refetchOnStale(qc, UNITS),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [UNITS] });
      qc.invalidateQueries({ queryKey: [KEY] });
    },
  });
}
