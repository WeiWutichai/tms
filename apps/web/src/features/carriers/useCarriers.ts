import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../api';
import { refetchOnStale } from '../master/problems';
import { useCursorList } from '../master/useCursorList';

export type Carrier = Schemas['CarrierDto'];
export type CarrierInput = Schemas['UpdateCarrierDto'];
export type CarrierCreate = Schemas['CreateCarrierDto'];
export type EntityType = Carrier['entityType'];
export type WhtRate = Carrier['whtRate'];
export type BankCode = NonNullable<Carrier['bankAccount']>['bankCode'];

/** ธนาคาร (ลำดับในตัวเลือก) — ตรงกับ BANK_CODES ของ API */
export const BANK_CODES: BankCode[] = [
  'KBANK',
  'SCB',
  'BBL',
  'KTB',
  'BAY',
  'TTB',
  'GSB',
  'BAAC',
  'GHB',
  'KKP',
  'CIMBT',
  'UOBT',
  'TISCO',
  'LHFG',
  'ICBCT',
  'TCRB',
  'IBANK',
];

const KEY = 'carriers';

export interface CarrierFilters {
  status: string;
  name: string;
  entityType: string;
}

export function useCarrierList(filters: CarrierFilters) {
  return useCursorList<Carrier>(KEY, { ...filters }, (query) =>
    unwrap(api.GET('/v1/carriers', { params: { query: query as never } })),
  );
}

export function useCarrierSummary() {
  return useQuery({
    queryKey: [KEY, 'summary'],
    queryFn: () => unwrap(api.GET('/v1/carriers/summary')),
  });
}

/** ค้นผู้รับเหมาที่ใช้งาน (ช่อง "สังกัด") */
export function searchCarriers(q: string, exceptId?: string) {
  return unwrap(
    api.GET('/v1/carriers', {
      params: { query: { limit: 20, status: 'active', ...(q ? { q } : {}) } },
    }),
  ).then((p) =>
    p.data
      .filter((c) => c.id !== exceptId)
      .map((c) => ({ id: c.id, label: c.legalName, sub: c.code })),
  );
}

export function useCreateCarrier() {
  const qc = useQueryClient();
  return useMutation({
    /** idempotencyKey ต่อการเปิดฟอร์ม 1 ครั้ง — กดซ้ำ/ส่งซ้ำได้รายการเดียว (ST0-T07) */
    mutationFn: (v: { body: CarrierCreate; idempotencyKey: string }) =>
      unwrap(
        api.POST('/v1/carriers', {
          body: v.body,
          headers: { 'Idempotency-Key': v.idempotencyKey },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useUpdateCarrier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; body: CarrierInput }) =>
      unwrap(
        api.PATCH('/v1/carriers/{id}', {
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

export function useCarrierAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      id: string;
      version: number;
      action: 'activate' | 'deactivate' | 'delete';
      reason?: string;
    }): Promise<Carrier | null> => {
      // If-Match: กันเปลี่ยนสถานะ/ลบรายการที่ผู้อื่นเพิ่งแก้ (412 → แจ้งให้โหลดใหม่)
      const p = {
        params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
      };
      if (v.action === 'activate')
        return unwrap(api.POST('/v1/carriers/{id}/activate', { ...p, body: {} }));
      if (v.action === 'deactivate')
        return unwrap(
          api.POST('/v1/carriers/{id}/deactivate', { ...p, body: { reason: v.reason ?? '' } }),
        );
      await unwrap(
        api.POST('/v1/carriers/{id}/delete', { ...p, body: { reason: v.reason ?? '' } }),
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
