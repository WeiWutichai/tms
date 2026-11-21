import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../api';
import { useCursorList } from '../master/useCursorList';
import type { InvoiceSummary } from './useInvoices';

export type Payment = Schemas['PaymentDto'];
export type PaymentInput = Schemas['CreatePaymentDto'];

/** ใบแจ้งหนี้ + การรับชำระ ใช้ key เดียวกัน — บันทึก/กลับรายการแล้วยอดคงค้าง/สถานะใบโหลดใหม่ทุกหน้า */
const KEY = 'invoices';

/** ใบที่ออกแล้วของหน้า "รับชำระ" (ST5-T13 — ต้นแบบ payRows: ไม่รวมร่าง/ยกเลิก) */
export function useReceivableList(filters: Record<string, string>) {
  return useCursorList<InvoiceSummary>(
    KEY,
    filters,
    (query) => unwrap(api.GET('/v1/invoices', { params: { query: query as never } })),
    { sort: '-updatedAt' },
  );
}

export function usePaymentSummary() {
  return useQuery({
    queryKey: [KEY, 'payments', 'summary'],
    queryFn: () => unwrap(api.GET('/v1/payments/summary')),
  });
}

/** ประวัติรับชำระของใบ (รวมที่กลับรายการ) */
export function useInvoicePayments(invoiceId: string | null | undefined) {
  return useQuery({
    queryKey: [KEY, 'payments', 'of', invoiceId],
    enabled: !!invoiceId,
    queryFn: () =>
      unwrap(
        api.GET('/v1/payments', {
          params: { query: { invoiceId: invoiceId!, limit: 200, sort: '-updatedAt' } as never },
        }),
      ),
  });
}

export function useRecordPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PaymentInput) => unwrap(api.POST('/v1/payments', { body })),
    onSettled: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

/** กลับรายการ / เช็คคืน (เหตุผล + If-Match) · เช็คผ่าน (If-Match) */
export function usePaymentAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      id: string;
      version: number;
      action: 'reverse' | 'bounce' | 'clear';
      reason?: string;
    }) => {
      const opts = {
        params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } },
      };
      if (v.action === 'clear') return unwrap(api.POST('/v1/payments/{id}/clear', opts));
      const body = { reason: v.reason ?? '' };
      return v.action === 'reverse'
        ? unwrap(api.POST('/v1/payments/{id}/reverse', { ...opts, body }))
        : unwrap(api.POST('/v1/payments/{id}/bounce', { ...opts, body }));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}
