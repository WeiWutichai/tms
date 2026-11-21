import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, unwrap } from '../../api';
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

export function useInvoice(id: string | null) {
  return useQuery({
    queryKey: [KEY, 'one', id],
    enabled: !!id,
    queryFn: () => unwrap(api.GET('/v1/invoices/{id}', { params: { path: { id: id! } } })),
  });
}

/**
 * ออกเอกสาร (ขั้นของ T07): ส่งบัญชี DO ที่ยังไม่ส่ง + สร้างร่างใบแจ้งหนี้ (ไม่มีเลข) **ในคำขอเดียว** (atomic — review M2)
 * API ตรวจความพร้อมซ้ำตอนดึง · ออกเลขจริง = ST5-T09
 */
export function useCreateDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { customerId: string; rows: QueueRow[]; from: string; to: string }) =>
      unwrap(
        api.POST('/v1/invoices', {
          body: {
            customerId: v.customerId,
            deliveryOrderIds: v.rows.map((r) => r.id),
            periodFrom: v.from,
            periodTo: v.to,
            releaseDeliveryOrders: true,
          },
        }),
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useInvoiceCounts(enabled = true) {
  return useQuery({
    queryKey: [KEY, 'summary'],
    enabled,
    queryFn: () => unwrap(api.GET('/v1/invoices/summary')),
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

/**
 * ยกเลิกใบที่ออกแล้ว (ST5-T10 `POST /invoices/{id}/void`): CANCELLED คงเลข — If-Match บังคับ · `invoices:void` (owner/admin/manager)
 * รับชำระแล้ว → 409 `invoice_has_payments` · อยู่ในใบวางบิลที่ออกแล้ว → 409 `invoice_on_billing_note` (`billingNoteNo`)
 * `reissue` = สร้างร่างฉบับใหม่แทน (ตอบ `replacedByInvoice`)
 */
export function useVoidInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; reason: string; reissue: boolean }) =>
      unwrap(
        api.POST('/v1/invoices/{id}/void', {
          params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } },
          body: { reason: v.reason, reissue: v.reissue },
        }),
      ),
    // ทุกคิวรี: ใบแจ้งหนี้ + ใบวางบิลร่างที่ถูกถอดใบนี้ออก + คิวพร้อมวางบิล (DO กลับมา)
    onSettled: () => qc.invalidateQueries(),
  });
}

/**
 * ออกเอกสาร (ST5-T09): ออกเลขใบแจ้งหนี้ + ล็อก — If-Match บังคับ · ผู้สร้าง/ผู้แก้ร่างล่าสุดออกเองไม่ได้ (403 `invoice_self_finalize`)
 * ตรวจไม่ผ่าน → 409 `invoice_not_finalizable` (`reasons[]`)
 */
export function useFinalize() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number }) =>
      unwrap(
        api.POST('/v1/invoices/{id}/finalize', {
          params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } },
        }),
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

/**
 * เปิด PDF ในแท็บใหม่ — เปิดหน้าต่าง **ทันทีตอนกด** (ก่อน await — กัน popup blocker) แล้วค่อยใส่ไฟล์ · เปิดไม่ได้ = ดาวน์โหลด
 */
export async function showPdf(
  load: () => Promise<{ response: Response; data?: unknown; error?: unknown }>,
  filename: string,
): Promise<void> {
  const w = window.open('', '_blank');
  try {
    const r = await load();
    if (!r.response.ok)
      throw new ApiError(
        (r.error ?? {
          code: 'internal_error',
          status: r.response.status,
          title: '',
          type: '',
        }) as never,
      );
    const url = URL.createObjectURL(r.data as Blob);
    if (w) w.location.href = url;
    else {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    w?.close();
    throw e;
  }
}

/** PDF ตัวอย่างของร่าง (pro forma) */
export function openProforma(id: string): Promise<void> {
  return showPdf(
    () => api.GET('/v1/invoices/{id}/proforma', { params: { path: { id } }, parseAs: 'blob' }),
    'proforma.pdf',
  );
}

/** PDF ใบที่ออกแล้ว (ไฟล์ต้นฉบับที่เก็บ ณ วันออก — ST5-T09) */
export function openIssuedPdf(id: string, filename = 'invoice.pdf'): Promise<void> {
  return showPdf(
    () => api.GET('/v1/invoices/{id}/pdf', { params: { path: { id } }, parseAs: 'blob' }),
    filename,
  );
}

/** PDF ตัวอย่างจาก DO ที่ติ๊ก — ไม่บันทึกอะไร (POST /v1/invoices/preview — review M2) */
export function previewDraft(v: {
  customerId: string;
  rows: QueueRow[];
  from: string;
  to: string;
}): Promise<void> {
  return showPdf(
    () =>
      api.POST('/v1/invoices/preview', {
        body: {
          customerId: v.customerId,
          deliveryOrderIds: v.rows.map((r) => r.id),
          periodFrom: v.from,
          periodTo: v.to,
        },
        parseAs: 'blob',
      }),
    'proforma-preview.pdf',
  );
}
