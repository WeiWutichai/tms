import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../api';
import { useCursorList } from '../master/useCursorList';
import { invalidateErp } from './useQueue';

export type ReconcileResult = Schemas['ReconcileResultDto'];
export type SyncLog = Schemas['ErpSyncLogDto'];

/** รายการ + ตัวนับ + drawer ใช้ key เดียว — ปิด/ขออนุมัติแล้วโหลดใหม่พร้อมกัน (+ badge เมนูจาก MutationCache) */
const KEY = 'reconcile-results';
/** หน้า MISMATCH = เนื้อหาเอกสาร (ST8-T11) ที่ต้องมีคนตัดสิน — ไม่รวม INFO (อ่านไม่ได้ / เทียบไม่ได้) และยอดรับชำระ (#74) */
export const BASE_QUERY = { check: 'DOCUMENT', actionable: 'true' } as const;

export function useReconcileList(filters: Record<string, string>, enabled = true) {
  return useCursorList<ReconcileResult>(
    KEY,
    { ...BASE_QUERY, ...filters },
    (query) => unwrap(api.GET('/v1/reconcile-results', { params: { query: query as never } })),
    { sort: '-updatedAt', enabled },
  );
}

/** ตัวนับแถบสรุป/แท็บ (ทั้งหมด · ไม่ตรง · รออนุมัติ) — สูงสุด 200 รายการล่าสุด (เกิน = "200+") */
export function useReconcileCounts() {
  return useQuery({
    queryKey: [KEY, 'counts'],
    queryFn: () =>
      unwrap(
        api.GET('/v1/reconcile-results', {
          params: { query: { ...BASE_QUERY, limit: 200 } as never },
        }),
      ),
  });
}

export function useReconcileResult(id: string | null) {
  return useQuery({
    queryKey: [KEY, 'one', id],
    enabled: !!id,
    queryFn: () => unwrap(api.GET('/v1/reconcile-results/{id}', { params: { path: { id: id! } } })),
  });
}

/** request/response ของการเรียกระบบบัญชีของเอกสารนี้ (ST7-T16 sync log — แท็บกิจกรรม) */
export function useDocumentSyncLog(connectorId: string | null, documentNo: string | null) {
  return useQuery({
    queryKey: [KEY, 'log', connectorId, documentNo],
    enabled: !!connectorId && !!documentNo,
    retry: false,
    queryFn: () =>
      unwrap(
        api.GET('/v1/connectors/{id}/sync-log', {
          params: { path: { id: connectorId! }, query: { documentNo: documentNo!, limit: 50 } },
        }),
      ),
  });
}

export type CloseAction = 'acknowledge' | 'resolve' | 'resend' | 'request' | 'approve' | 'reject';

/** ปิด 3 ทาง + ขอ/อนุมัติส่งทับ — เหตุผล ≥ 10 ตัวอักษร (API ลง audit ผู้ทำ + เหตุผล) */
export function useCloseAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { action: CloseAction; id: string; reason: string }) => {
      const opts = { params: { path: { id: v.id } }, body: { reason: v.reason } };
      switch (v.action) {
        case 'acknowledge':
          return unwrap(api.POST('/v1/reconcile-results/{id}/acknowledge', opts));
        case 'resolve':
          return unwrap(api.POST('/v1/reconcile-results/{id}/resolve-in-tms', opts));
        case 'resend':
          return unwrap(api.POST('/v1/reconcile-results/{id}/resend', opts));
        case 'request':
          return unwrap(api.POST('/v1/reconcile-results/{id}/overwrite-request', opts));
        case 'approve':
          return unwrap(api.POST('/v1/reconcile-results/{id}/overwrite-request/approve', opts));
        case 'reject':
          // #94 (PO 24 พ.ย. 2569) ไม่อนุมัติคำขอแก้ → กลับเป็น "ไม่ตรง" ขอใหม่ได้ · audit `reconcile.overwrite_rejected`
          return unwrap(api.POST('/v1/reconcile-results/{id}/overwrite-request/reject', opts));
      }
    },
    onSettled: () => invalidateErp(qc),
  });
}
