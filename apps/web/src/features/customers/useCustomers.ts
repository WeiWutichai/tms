import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../api';
import { useCursorList } from '../master/useCursorList';

export type Customer = Schemas['CustomerDto'];
export type CustomerInput = Schemas['UpdateCustomerDto'];
export type CustomerCreate = Schemas['CreateCustomerDto'];

const KEY = 'customers';

export interface CustomerFilters {
  status: string;
  billingCycle: string;
  code: string;
  name: string;
}

export function useCustomerList(filters: CustomerFilters) {
  return useCursorList<Customer>(KEY, { ...filters }, (query) =>
    unwrap(api.GET('/v1/customers', { params: { query: query as never } })),
  );
}

export function useCustomerSummary() {
  return useQuery({
    queryKey: [KEY, 'summary'],
    queryFn: () => unwrap(api.GET('/v1/customers/summary')),
  });
}

export function useNextCustomerCode(enabled: boolean) {
  return useQuery({
    queryKey: [KEY, 'next-code'],
    enabled,
    staleTime: 0,
    queryFn: () => unwrap(api.GET('/v1/customers/next-code')),
  });
}

/** นิติบุคคลที่ใช้งาน — ตัวเลือก "ออกบิลในนาม" */
export function useCompanyOptions() {
  return useQuery({
    queryKey: ['companies', 'options'],
    queryFn: () =>
      unwrap(api.GET('/v1/companies', { params: { query: { status: 'active', limit: 200 } } })),
  });
}

export function useCreateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    /** idempotencyKey ต่อการเปิดฟอร์ม 1 ครั้ง — กดซ้ำ/ส่งซ้ำได้ลูกค้ารายเดียว (ST0-T07) */
    mutationFn: (v: { body: CustomerCreate; idempotencyKey: string }) =>
      unwrap(
        api.POST('/v1/customers', {
          body: v.body,
          headers: { 'Idempotency-Key': v.idempotencyKey },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useUpdateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; body: CustomerInput }) =>
      unwrap(
        api.PATCH('/v1/customers/{id}', {
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

export function useCustomerAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      id: string;
      version: number;
      action: 'activate' | 'deactivate' | 'delete';
      reason?: string;
    }): Promise<Customer | null> => {
      // If-Match: กันเปลี่ยนสถานะ/ลบรายการที่ผู้อื่นเพิ่งแก้ (412 → แจ้งให้โหลดใหม่)
      const p = {
        params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
      };
      if (v.action === 'activate')
        return unwrap(api.POST('/v1/customers/{id}/activate', { ...p, body: {} }));
      if (v.action === 'deactivate')
        return unwrap(
          api.POST('/v1/customers/{id}/deactivate', { ...p, body: { reason: v.reason ?? '' } }),
        );
      await unwrap(
        api.POST('/v1/customers/{id}/delete', { ...p, body: { reason: v.reason ?? '' } }),
      );
      return null;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: ['history'] });
    },
  });
}
