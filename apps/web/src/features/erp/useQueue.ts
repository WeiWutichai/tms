import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../api';
import { useCursorList } from '../master/useCursorList';
import type { QueueTab } from './erpq';
import type { QueueItem } from './queue';

/** รายการ + ตัวนับ + log ใช้ key เดียว — ทำรายการแล้วโหลดใหม่พร้อมกัน (+ การ์ดภาพรวม `connector-metrics`) */
const KEY = 'erp-queue';

/** รายการในแท็บคิว (keyset ตามเวลาเปลี่ยนล่าสุด — API ไม่รับ `sort`) · `errorClass` = กลุ่มของแท็บล้มเหลว */
export function useQueueList(connectorId: string | null, tab: QueueTab, errorClass: string) {
  return useCursorList<QueueItem>(
    KEY,
    { c: connectorId ?? '', tab, ...(errorClass ? { errorClass } : {}) },
    ({ sort: _sort, c, ...query }) =>
      unwrap(
        api.GET('/v1/connectors/{id}/queue', {
          params: { path: { id: String(c) }, query: query as never },
        }),
      ),
    { enabled: !!connectorId },
  );
}

/** ตัวนับต่อแท็บ + แท็บล้มเหลวแยก ErrorClass */
export function useQueueSummary(connectorId: string | null) {
  return useQuery({
    queryKey: [KEY, 'summary', connectorId],
    enabled: !!connectorId,
    queryFn: () =>
      unwrap(
        api.GET('/v1/connectors/{id}/queue/summary', { params: { path: { id: connectorId! } } }),
      ),
  });
}

/** request/response ของคำสั่งนี้ (ST7-T16 sync log `commandId` — ตัด secret แล้ว) = "ลิงก์ไป sync log ของคำสั่งนั้น" (docs/01 §6.4) */
export function useCommandSyncLog(connectorId: string, commandId: string) {
  return useQuery({
    queryKey: [KEY, 'log', connectorId, commandId],
    retry: false,
    queryFn: () =>
      unwrap(
        api.GET('/v1/connectors/{id}/sync-log', {
          params: { path: { id: connectorId }, query: { commandId, limit: 50 } },
        }),
      ),
  });
}

export type QueueAction =
  | { action: 'retry'; id: string }
  | { action: 'skip'; id: string; reason: string }
  | { action: 'approve'; id: string; reason: string }
  | {
      action: 'externalId';
      id: string;
      reason: string;
      externalId: string;
      externalDocNo?: string;
    };

/** ส่งซ้ำ / ข้ามพร้อมเหตุผล / อนุมัติแทนที่ / กรอกเลขเอง (ST7-T19 / ST8-T13 — เหตุผล ≥ 10 ลง audit) */
export function useQueueAction(connectorId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: QueueAction): Promise<unknown> => {
      const path = { id: connectorId, commandId: v.id };
      switch (v.action) {
        case 'retry':
          return unwrap(
            api.POST('/v1/connectors/{id}/queue/{commandId}/retry', { params: { path } }),
          );
        case 'skip':
          return unwrap(
            api.POST('/v1/connectors/{id}/queue/{commandId}/skip', {
              params: { path },
              body: { reason: v.reason },
            }),
          );
        case 'approve':
          return unwrap(
            api.POST('/v1/connectors/{id}/queue/{commandId}/approve', {
              params: { path },
              body: { reason: v.reason },
            }),
          );
        case 'externalId':
          return unwrap(
            api.POST('/v1/connectors/{id}/queue/{commandId}/external-id', {
              params: { path },
              body: {
                reason: v.reason,
                externalId: v.externalId,
                ...(v.externalDocNo ? { externalDocNo: v.externalDocNo } : {}),
              },
            }),
          );
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [KEY] });
      void qc.invalidateQueries({ queryKey: ['connector-metrics'] });
    },
  });
}

/** ปุ่มหัวหน้า "ส่งซ้ำทั้งหมดที่รอ" (ต้นแบบ actions.erp) = ส่งซ้ำทุกรายการในแท็บล้มเหลวที่ส่งซ้ำได้ (≤ 200 ต่อครั้ง) */
export function useRetryAll(connectorId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/v1/connectors/{id}/queue/retry', {
          params: { path: { id: connectorId! } },
          body: {},
        }),
      ),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [KEY] });
      void qc.invalidateQueries({ queryKey: ['connector-metrics'] });
    },
  });
}
