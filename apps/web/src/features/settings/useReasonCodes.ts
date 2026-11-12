import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, idempotent, unwrap } from '../../api';
import { refetchOnStale } from '../master/problems';

export type ReasonCode = Schemas['ReasonCodeDto'];
export type ReasonCategory = ReasonCode['category'];
export type ReasonInput = Schemas['UpdateReasonCodeDto'];
export type ReasonCreate = Schemas['CreateReasonCodeDto'];
export type ReasonFlag = 'requiresPhoto' | 'requiresNote' | 'autoReschedule' | 'showOnTracking';

/**
 * ลำดับหมวดบนหน้าจอ — ต้นแบบเรียง ตีกลับ → ส่งไม่สำเร็จ → ยกเลิก แล้วต่อด้วยหมวดที่ต้นแบบไม่มี (docs/04 B)
 */
export const CATEGORIES: ReasonCategory[] = [
  'REJECTED_BY_RECEIVER',
  'DELIVERY_FAILED',
  'CANCEL',
  'POD_MISSING',
  'DELAY',
  'ORDER_HOLD',
  'SETTLEMENT_DISPUTE',
  'OVERRIDE',
];
/** ธงที่ใช้ได้ตามหมวด — ตรงกับกฎของ API (422 not_applicable) */
export const FLAG_ALLOWED: Record<ReasonFlag, (c: ReasonCategory) => boolean> = {
  requiresPhoto: () => true,
  requiresNote: () => true,
  autoReschedule: (c) => c === 'DELIVERY_FAILED',
  showOnTracking: (c) =>
    c === 'DELIVERY_FAILED' || c === 'REJECTED_BY_RECEIVER' || c === 'POD_MISSING' || c === 'DELAY',
};
/** "อื่น ๆ" ของระบบบังคับโน้ตเสมอ (MD-221) */
export const flagLocked = (r: ReasonCode, f: ReasonFlag) =>
  f === 'requiresNote' && r.system && r.code === 'OTHER';

const KEY = 'reason-codes';

/** ทั้งหมด (ทุกหมวด รวมที่ปิดใช้) — ไล่ cursor ทีละ 200 (ชุดเริ่มต้นราว 50 รายการ) */
export function useReasonCodes() {
  return useQuery({
    queryKey: [KEY],
    queryFn: async () => {
      const out: ReasonCode[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 25; i++) {
        const p = await unwrap(
          api.GET('/v1/reason-codes', { params: { query: { limit: 200, cursor } as never } }),
        );
        out.push(...p.data);
        if (!p.hasMore || !p.nextCursor) break;
        cursor = p.nextCursor;
      }
      const rank = (r: ReasonCode) => CATEGORIES.indexOf(r.category);
      return out.sort(
        (a, b) =>
          rank(a) - rank(b) || a.sortOrder - b.sortOrder || a.code.localeCompare(b.code, 'en'),
      );
    },
  });
}

export function useCreateReason() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { body: ReasonCreate; idempotencyKey: string }) =>
      idempotent(() =>
        api.POST('/v1/reason-codes', {
          body: v.body,
          headers: { 'Idempotency-Key': v.idempotencyKey },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

const patch = (v: { id: string; version: number; body: ReasonInput }) =>
  unwrap(
    api.PATCH('/v1/reason-codes/{id}', {
      params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
      body: v.body,
    }),
  );

export function useUpdateReason() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: patch,
    onError: refetchOnStale(qc, KEY),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: ['history'] });
    },
  });
}

/** ปุ่ม "บันทึก" ลอยของหน้า: ส่งธงที่ติ๊กเปลี่ยนทีละแถว (If-Match ต่อแถว) — แถวไหนล้มหยุดและแจ้ง */
export function useSaveReasonFlags() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rows: Array<{ id: string; version: number; body: ReasonInput }>) => {
      for (const r of rows)
        try {
          await patch(r);
        } catch (e) {
          throw Object.assign(e as object, { failedId: r.id });
        }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useReasonAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      id: string;
      version: number;
      action: 'activate' | 'deactivate' | 'delete';
      reason?: string;
    }): Promise<ReasonCode | null> => {
      const p = {
        params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
      };
      if (v.action === 'activate')
        return unwrap(api.POST('/v1/reason-codes/{id}/activate', { ...p, body: {} }));
      if (v.action === 'deactivate')
        return unwrap(
          api.POST('/v1/reason-codes/{id}/deactivate', { ...p, body: { reason: v.reason ?? '' } }),
        );
      await unwrap(
        api.POST('/v1/reason-codes/{id}/delete', { ...p, body: { reason: v.reason ?? '' } }),
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
