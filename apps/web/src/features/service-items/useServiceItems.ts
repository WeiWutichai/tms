import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, idempotent, unwrap } from '../../api';
import { refetchOnStale } from '../master/problems';
import { useCursorList } from '../master/useCursorList';

export type ServiceItem = Schemas['ServiceItemDto'];
export type ServiceItemInput = Schemas['UpdateServiceItemDto'];
/** ผลของ POST/PATCH — มี `warnings` (คำเตือนที่ไม่บล็อก เช่นคู่ VAT × หัก ณ ที่จ่ายไม่ปกติ) */
export type ServiceItemSaved = Schemas['ServiceItemWriteResultDto'];
export type ServiceItemCreate = Schemas['CreateServiceItemDto'];
export type CalcUnit = ServiceItem['calcUnit'];
export type VatType = ServiceItem['vatType'];
export type WhtRate = ServiceItem['whtRate'];
export type Side = ServiceItem['side'];

/** ลำดับตัวเลือกหน่วยคิดตามต้นแบบ cfAx (ฟอร์ม) */
export const CALC_UNITS: CalcUnit[] = [
  'PER_TRIP',
  'PER_HOUR',
  'PER_NIGHT',
  'PER_STOP',
  'PERCENT_OF_FREIGHT',
  'ACTUAL',
];
/** ลำดับตัวกรองคอลัมน์หน่วยคิดตามต้นแบบ specAx */
export const CALC_UNIT_FILTER: CalcUnit[] = [
  'PER_HOUR',
  'PER_TRIP',
  'PER_NIGHT',
  'PER_STOP',
  'PERCENT_OF_FREIGHT',
  'ACTUAL',
];
/** ต้นแบบ: VAT 7% / ยกเว้น VAT + VAT 0% (docs/01 ZERO_RATED — ต้นแบบไม่มี [OPEN spec/12 §3]) */
export const VAT_TYPES: VatType[] = ['VAT_7', 'EXEMPT_TRANSPORT', 'ZERO_RATED'];
/** ลำดับตัวเลือกหัก ณ ที่จ่ายตามต้นแบบ (1% / ไม่หัก / 3%) */
export const WHT_RATES: WhtRate[] = ['1.00', '0.00', '3.00'];
export const SIDES: Side[] = ['BOTH', 'SELL', 'BUY'];

const KEY = 'service-items';

export interface ServiceItemFilters {
  name: string;
  calcUnit: string;
  vatType: string;
}

export function useServiceItemList(filters: ServiceItemFilters) {
  return useCursorList<ServiceItem>(KEY, { ...filters }, (query) =>
    unwrap(api.GET('/v1/service-items', { params: { query: query as never } })),
  );
}

export function useServiceItemSummary() {
  return useQuery({
    queryKey: [KEY, 'summary'],
    queryFn: () => unwrap(api.GET('/v1/service-items/summary')),
  });
}

export function useCreateServiceItem() {
  const qc = useQueryClient();
  return useMutation({
    /** idempotencyKey ต่อการเปิดฟอร์ม 1 ครั้ง — กดซ้ำ/ส่งซ้ำได้รายการเดียว (ST0-T07) */
    mutationFn: (v: { body: ServiceItemCreate; idempotencyKey: string }) =>
      idempotent(() =>
        api.POST('/v1/service-items', {
          body: v.body,
          headers: { 'Idempotency-Key': v.idempotencyKey },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useUpdateServiceItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; body: ServiceItemInput }) =>
      unwrap(
        api.PATCH('/v1/service-items/{id}', {
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

export function useServiceItemAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      id: string;
      version: number;
      action: 'activate' | 'deactivate' | 'delete';
      reason?: string;
    }): Promise<ServiceItem | null> => {
      // If-Match: กันเปลี่ยนสถานะ/ลบรายการที่ผู้อื่นเพิ่งแก้ (412 → แจ้งให้โหลดใหม่)
      const p = {
        params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
      };
      if (v.action === 'activate')
        return unwrap(api.POST('/v1/service-items/{id}/activate', { ...p, body: {} }));
      if (v.action === 'deactivate')
        return unwrap(
          api.POST('/v1/service-items/{id}/deactivate', {
            ...p,
            body: { reason: v.reason ?? '' },
          }),
        );
      await unwrap(
        api.POST('/v1/service-items/{id}/delete', { ...p, body: { reason: v.reason ?? '' } }),
      );
      return null;
    },
    onError: refetchOnStale(qc, KEY),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: ['history'] });
    },
  });
}
