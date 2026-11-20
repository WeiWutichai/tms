import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../api';
import { useCursorList } from '../master/useCursorList';
import { showPdf } from './useInvoices';

export type BillingNote = Schemas['BillingNoteDto'];
export type BillingNoteSummary = Schemas['BillingNoteSummaryDto'];
export type BillingNoteCandidate = Schemas['BillingNoteCandidateDto'];

/** ใบวางบิลอยู่ใต้ key `invoices` ด้วย — สร้าง/ออก/ยกเลิกใบวางบิลแล้ว candidates/รายการใบแจ้งหนี้ refetch ตาม */
const KEY = 'invoices';

export function useBillingNoteList(filters: Record<string, string>, enabled = true) {
  return useCursorList<BillingNoteSummary>(
    `${KEY}-bn`,
    filters,
    (query) => unwrap(api.GET('/v1/billing-notes', { params: { query: query as never } })),
    { sort: '-updatedAt', enabled },
  );
}

export function useBillingNote(id: string | null) {
  return useQuery({
    queryKey: [KEY, 'bn', id],
    enabled: !!id,
    queryFn: () => unwrap(api.GET('/v1/billing-notes/{id}', { params: { path: { id: id! } } })),
  });
}

export function useBillingNoteCounts() {
  return useQuery({
    queryKey: [KEY, 'bn-summary'],
    queryFn: () => unwrap(api.GET('/v1/billing-notes/summary')),
  });
}

/** ใบแจ้งหนี้ของลูกค้าที่ใส่ในใบวางบิลได้ (ออกแล้ว ค้างชำระ ไม่อยู่ในใบวางบิลอื่นที่ active) */
export function useBillingCandidates(customerId: string | undefined) {
  return useQuery({
    queryKey: [KEY, 'bn-candidates', customerId],
    enabled: !!customerId,
    queryFn: () =>
      unwrap(
        api.GET('/v1/billing-notes/candidates', {
          params: { query: { customerId: customerId! } },
        }),
      ),
  });
}

const invalidate = (qc: ReturnType<typeof useQueryClient>) => () => {
  void qc.invalidateQueries({ queryKey: [KEY] });
  void qc.invalidateQueries({ queryKey: [`${KEY}-bn`] });
};

export function useCreateBillingNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      customerId: string;
      invoiceIds: string[];
      collectionDate?: string;
      note?: string;
    }) => unwrap(api.POST('/v1/billing-notes', { body: v })),
    onSettled: invalidate(qc),
  });
}

export function useUpdateBillingNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      id: string;
      version: number;
      invoiceIds?: string[];
      collectionDate?: string | null;
      note?: string | null;
    }) => {
      const { id, version, ...body } = v;
      return unwrap(
        api.PATCH('/v1/billing-notes/{id}', {
          params: { path: { id } },
          headers: { 'If-Match': `"${version}"` },
          body,
        }),
      );
    },
    onSettled: invalidate(qc),
  });
}

/** ออกเอกสาร: ออกเลขใบวางบิล (ชุด BN) + ล็อก — If-Match บังคับ */
export function useFinalizeBillingNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number }) =>
      unwrap(
        api.POST('/v1/billing-notes/{id}/finalize', {
          params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } },
        }),
      ),
    onSettled: invalidate(qc),
  });
}

export function useAcknowledgeBillingNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; receivedBy: string; receivedOn: string }) =>
      unwrap(
        api.POST('/v1/billing-notes/{id}/acknowledge', {
          params: { path: { id: v.id } },
          headers: { 'If-Match': `"${v.version}"` },
          body: { receivedBy: v.receivedBy, receivedOn: v.receivedOn },
        }),
      ),
    onSettled: invalidate(qc),
  });
}

export function useCollectBillingNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; note: string }) =>
      unwrap(
        api.POST('/v1/billing-notes/{id}/collect', {
          params: { path: { id: v.id } },
          headers: { 'If-Match': `"${v.version}"` },
          body: v.note ? { note: v.note } : {},
        }),
      ),
    onSettled: invalidate(qc),
  });
}

export function useCancelBillingNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; reason: string }) =>
      unwrap(
        api.POST('/v1/billing-notes/{id}/cancel', {
          params: { path: { id: v.id } },
          headers: { 'If-Match': `"${v.version}"` },
          body: { reason: v.reason },
        }),
      ),
    onSettled: invalidate(qc),
  });
}

/** ร่าง = PDF ตัวอย่าง (ลายน้ำ "ร่าง") · ออกแล้ว = ไฟล์ต้นฉบับที่เก็บ ณ วันออก */
export function openBillingNotePdf(x: {
  id: string;
  status: string;
  billingNoteNo: string | null;
}) {
  return x.status === 'DRAFT'
    ? showPdf(
        () =>
          api.GET('/v1/billing-notes/{id}/proforma', {
            params: { path: { id: x.id } },
            parseAs: 'blob',
          }),
        'billing-note-proforma.pdf',
      )
    : showPdf(
        () =>
          api.GET('/v1/billing-notes/{id}/pdf', {
            params: { path: { id: x.id } },
            parseAs: 'blob',
          }),
        `${x.billingNoteNo ?? 'billing-note'}.pdf`,
      );
}
