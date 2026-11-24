import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../api';
import { useCursorList } from '../master/useCursorList';
import { showPdf } from '../billing/useInvoices';

export type SettlementSummary = Schemas['SettlementSummaryDto'];
export type Settlement = Schemas['SettlementDto'];
export type SettlementKpi = Schemas['SettlementKpiDto'];
export type SettlementLink = Schemas['SettlementReviewLinkDto'];
export type SettlementPayInput = Schemas['SettlementPayDto'];

/** ใบสำคัญจ่าย + KPI ใช้ key เดียว — อนุมัติ/บันทึกจ่ายแล้วรายการ/การ์ด/drawer โหลดใหม่พร้อมกัน */
const KEY = 'settlements';

export function useSettlementList(filters: Record<string, string>, enabled = true) {
  return useCursorList<SettlementSummary>(
    KEY,
    filters,
    (query) => unwrap(api.GET('/v1/settlements', { params: { query: query as never } })),
    { sort: '-updatedAt', enabled },
  );
}

/** ตัวนับต่อสถานะ — หน้า settle และ Dashboard AP (ST9-T03) ใช้ key เดียวกัน */
export function useSettlementKpi(enabled = true) {
  return useQuery({
    queryKey: [KEY, 'summary'],
    enabled,
    queryFn: () => unwrap(api.GET('/v1/settlements/summary')),
  });
}

export function useSettlement(id: string | null) {
  return useQuery({
    queryKey: [KEY, 'one', id],
    enabled: !!id,
    queryFn: () => unwrap(api.GET('/v1/settlements/{id}', { params: { path: { id: id! } } })),
  });
}

/** อนุมัติ (ST6-T07): เหตุผล ≥ 10 + If-Match · เกินวงเงิน → 403 `step_up_required` แล้วส่งซ้ำพร้อม `X-Step-Up` */
export function useApproveSettlement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; reason: string; stepUp?: string }) =>
      unwrap(
        api.POST('/v1/settlements/{id}/approve', {
          params: {
            path: { id: v.id },
            header: {
              'If-Match': `"${v.version}"`,
              ...(v.stepUp ? { 'X-Step-Up': v.stepUp } : {}),
            } as never,
          },
          body: { reason: v.reason },
        }),
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

/** บันทึกจ่าย (ST6-T09) — APPROVED → PAID · D-60 ผู้อนุมัติบันทึกจ่ายเองไม่ได้ (403 `settlement_self_payment`) */
export function useMarkPaid() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; body: SettlementPayInput }) =>
      unwrap(
        api.POST('/v1/settlements/{id}/mark-paid', {
          params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
          body: v.body,
        }),
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

/** D-63 "ออกลิงก์ใหม่" (D-59: ใบ APPROVED/PAID = ลิงก์ดูอย่างเดียว) — เพิกถอนลิงก์เดิม */
export function useReissueLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST('/v1/settlements/{id}/review-link', { params: { path: { id } } })),
    onSettled: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

/** ST6-T11 ลิงก์ "ค่าเที่ยวของฉัน" ของรถร่วม (ดูอย่างเดียว) — เพิกถอนลิงก์ค่าเที่ยวเดิมของรถร่วมรายนั้น */
export function useIssuePayLink() {
  return useMutation({
    mutationFn: (carrierId: string) =>
      unwrap(api.POST('/v1/carriers/{id}/pay-link', { params: { path: { id: carrierId } } })),
  });
}

/** PDF ใบสำคัญจ่าย (ST6-T04) — แท็บใหม่ */
export function openVoucherPdf(id: string, no: string | null): Promise<void> {
  return showPdf(
    () => api.GET('/v1/settlements/{id}/pdf', { params: { path: { id } }, parseAs: 'blob' }),
    `${no ?? 'settlement'}.pdf`,
  );
}

export type SettlementQueue = Schemas['SettlementQueuePageDto'];
export type SettlementQueueTrip = Schemas['SettlementQueueTripDto'];
export type CreateSettlementInput = Schemas['CreateSettlementDto'];

/**
 * คิวจ่ายรถร่วม (ST6-T02 `GET /v1/settlements/queue`) ของฟอร์ม "สร้างงวดใหม่" — `carriers` = รายชื่อผู้รับเหมาที่มีเที่ยวรอจ่าย
 * (ไม่ส่ง carrierId) · เลือกผู้รับเหมาแล้วโหลดเที่ยวของรายนั้น (สูงสุด 200 เที่ยวต่อใบ — `tripIds` ≤ 200)
 */
export function useSettlementQueue(f: { carrierId?: string; dateFrom?: string; dateTo?: string }) {
  return useQuery({
    queryKey: [KEY, 'queue', f],
    queryFn: () =>
      unwrap(
        api.GET('/v1/settlements/queue', {
          params: { query: { limit: 200, sort: 'updatedAt', ...f } as never },
        }),
      ),
  });
}

/** ติ๊กเที่ยว → สร้างร่างใบสำคัญจ่าย (ST6-T03 `POST /v1/settlements`) */
export function useCreateSettlement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSettlementInput) => unwrap(api.POST('/v1/settlements', { body })),
    onSettled: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}
