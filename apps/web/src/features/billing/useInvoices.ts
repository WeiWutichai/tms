import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../api';
import { useCursorList } from '../master/useCursorList';

export type Invoice = Schemas['InvoiceDto'];
export type InvoiceSummary = Schemas['InvoiceSummaryDto'];
export type QueueRow = Schemas['BillingQueueRowDto'];
export type QueueCustomer = Schemas['BillingQueueCustomerDto'];

const KEY = 'invoices';

/** คิวพร้อมวางบิลของลูกค้า + ช่วงวันที่ส่ง (ST5-T04) — ≤ 200 DO ต่อครั้ง (ขั้น "ติ๊ก DO") */
export function useBillQueue(f: { customerId?: string; dateFrom: string; dateTo: string }) {
  return useQuery({
    queryKey: [KEY, 'queue', f],
    queryFn: () =>
      unwrap(
        api.GET('/v1/invoices/queue', {
          params: { query: { limit: 200, sort: 'updatedAt', ...f } as never },
        }),
      ),
  });
}

/** ลูกค้าที่มี DO ในคิว (ตัวเลือกลูกค้า) + ยอด KPI "DO รอวางบิล" — ไม่กรองช่วงวันที่ */
export function useQueueCustomers() {
  return useQuery({
    queryKey: [KEY, 'queue', 'customers'],
    queryFn: () =>
      unwrap(api.GET('/v1/invoices/queue', { params: { query: { limit: 1 } as never } })),
  });
}

export function useCustomerTerms(id: string | undefined) {
  return useQuery({
    queryKey: ['customers', 'one', id],
    enabled: !!id,
    queryFn: () => unwrap(api.GET('/v1/customers/{id}', { params: { path: { id: id! } } })),
  });
}

export function useInvoiceList(filters: Record<string, string>) {
  return useCursorList<InvoiceSummary>(
    KEY,
    filters,
    (query) => unwrap(api.GET('/v1/invoices', { params: { query: query as never } })),
    { sort: '-updatedAt' },
  );
}

/** จำนวนร่าง (KPI "ใบแจ้งหนี้ร่าง") */
export function useDraftCount() {
  return useQuery({
    queryKey: [KEY, 'drafts'],
    queryFn: () =>
      unwrap(api.GET('/v1/invoices', { params: { query: { status: 'DRAFT', limit: 200 } } })).then(
        (p) => (p.hasMore ? `${p.data.length}+` : String(p.data.length)),
      ),
  });
}

export function useInvoice(id: string | null) {
  return useQuery({
    queryKey: [KEY, 'one', id],
    enabled: !!id,
    queryFn: () => unwrap(api.GET('/v1/invoices/{id}', { params: { path: { id: id! } } })),
  });
}

/**
 * ออกเอกสาร (ขั้นของ T07): ส่งบัญชี DO ที่ยังไม่ส่ง (bulk-release — ไม่ส่งซ้ำ) แล้วสร้างร่างใบแจ้งหนี้ (ไม่มีเลข)
 * API ตรวจความพร้อมซ้ำตอนดึง · ออกเลขจริง = ST5-T09
 */
export function useCreateDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { customerId: string; rows: QueueRow[]; from: string; to: string }) => {
      const pending = v.rows.filter((r) => !r.releasedAt);
      if (pending.length) {
        const res = await unwrap(
          api.POST('/v1/delivery-orders/bulk-release', {
            body: { items: pending.map((r) => ({ deliveryOrderId: r.id, version: r.version })) },
          }),
        );
        const bad = res.results.find((x) => x.outcome === 'FAILED');
        if (bad) throw Object.assign(new Error(bad.problem?.title ?? ''), { problem: bad.problem });
      }
      return unwrap(
        api.POST('/v1/invoices', {
          body: {
            customerId: v.customerId,
            deliveryOrderIds: v.rows.map((r) => r.id),
            periodFrom: v.from,
            periodTo: v.to,
          },
        }),
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useCancelDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; reason: string }) =>
      unwrap(
        api.POST('/v1/invoices/{id}/cancel', {
          params: { path: { id: v.id } },
          headers: { 'If-Match': `"${v.version}"` },
          body: { reason: v.reason },
        }),
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

/** PDF ตัวอย่างของร่าง (pro forma) — เปิดแท็บใหม่ */
export async function openProforma(id: string): Promise<void> {
  const res = await api.GET('/v1/invoices/{id}/proforma', {
    params: { path: { id } },
    parseAs: 'blob',
  });
  if (!res.response.ok) throw new Error(String(res.response.status));
  const url = URL.createObjectURL(res.data as unknown as Blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
