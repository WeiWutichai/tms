import type { Schemas } from '@tms/contracts';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../api';
import { can } from '../../nav';
import { useMe } from '../../shell/AppShell';
import { useCursorList } from '../master/useCursorList';
import type { QueueTab } from './erpq';
import type { QueueItem } from './queue';

/** รายการ + ตัวนับ + log ใช้ key เดียว — ทำรายการแล้วโหลดใหม่พร้อมกัน (+ การ์ดภาพรวม `connector-metrics`) */
const KEY = 'erp-queue';

/**
 * review q86 L3: งานของหน้านี้กระทบกันข้ามแหล่ง (ส่งซ้ำ/ข้าม/กรอกเลข ↔ ผลเทียบ ↔ การ์ดภาพรวม) — ทำรายการใดก็โหลดใหม่ทั้งสามชุด
 * (badge เมนูโหลดใหม่จาก MutationCache ใน api.ts)
 */
export function invalidateErp(qc: QueryClient) {
  for (const k of [KEY, 'reconcile-results', 'connector-metrics'])
    void qc.invalidateQueries({ queryKey: [k] });
}

type Metrics = Schemas['ConnectorMetricsDto'];
const LIVE_ORDER: Record<string, number> = { ACTIVE: 0, ERROR: 1 };

/**
 * connector ที่หน้า "คิวเชื่อมระบบบัญชี" แสดง (review q86 M1 — ชั่วคราว): ตัวที่มีรายการล้มเหลวมากสุด
 * (เท่ากัน → ACTIVE → ERROR → ตัวแรกตามลำดับของ API) — badge เมนูนับล้มเหลวของทุก connector ที่ยังเชื่อม จึงให้หน้าเปิดตัวที่มีงานค้างมากสุด
 * ต้นแบบไม่มีตัวเลือก connector บนหน้า `erp` [OPEN — PO / Claude Design] · การ์ดภาพรวมใช้ตัวเลือกของตัวเอง (ACTIVE ก่อน) ไม่เปลี่ยน
 */
export function pickErpConnector(cs: readonly Metrics[]): Metrics | null {
  let best: Metrics | null = null;
  let bestIdx = -1;
  cs.forEach((c, i) => {
    if (!best) {
      best = c;
      bestIdx = i;
      return;
    }
    const d = c.queue.failed - best.queue.failed;
    const rank = (x: Metrics) => LIVE_ORDER[x.status] ?? 2;
    if (d > 0 || (d === 0 && rank(c) < rank(best))) {
      best = c;
      bestIdx = i;
    }
  });
  return bestIdx < 0 ? null : best;
}

/** connector ของหน้านี้ — query เดียวกับการ์ดภาพรวม (`GET /connectors/metrics`) · ไม่มีสิทธิ์อ่าน/แพ็กเกจไม่มี `conn` = ไม่เรียก */
export function useErpConnector(): Metrics | null {
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const enabled =
    !!me.data &&
    (can(scopes, 'integrations:read') || can(scopes, 'settings:read')) &&
    !!me.data.features?.includes('conn');
  const q = useQuery({
    queryKey: ['connector-metrics'],
    queryFn: () => unwrap(api.GET('/v1/connectors/metrics')),
    enabled,
    retry: false,
    refetchInterval: 60_000,
  });
  return enabled ? pickErpConnector(q.data?.data ?? []) : null;
}

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
    onSettled: () => invalidateErp(qc),
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
    onSettled: () => invalidateErp(qc),
  });
}
