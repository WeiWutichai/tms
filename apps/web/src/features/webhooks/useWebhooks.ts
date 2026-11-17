import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../api';
import { refetchOnStale } from '../master/problems';
import { useCursorList } from '../master/useCursorList';

export type Webhook = Schemas['WebhookEndpointDto'];
export type WebhookWithSecret = Schemas['WebhookEndpointSecretDto'];
export type WebhookCreate = Schemas['CreateWebhookDto'];
export type WebhookTestResult = Schemas['WebhookTestResultDto'];

/** แท็บสถานะตามต้นแบบ specApi hooks (ทั้งหมด / ใช้งาน / ล้มเหลวต่อเนื่อง / ปิด) — "ปิด" รวมที่ระบบปิดอัตโนมัติ */
export const HOOK_TABS = ['active', 'failing', 'disabled'] as const;
export type HookTab = (typeof HOOK_TABS)[number];
/** ค่า `status` ของ API ต่อแท็บ */
export const TAB_QUERY: Record<HookTab, string> = {
  active: 'active',
  failing: 'failing',
  disabled: 'disabled,auto_disabled',
};

const KEY = 'webhooks';

export interface WebhookFilters {
  status: string;
  url: string;
}

export function useWebhookList(filters: WebhookFilters) {
  return useCursorList<Webhook>(
    KEY,
    { ...filters },
    (query) => {
      const q = { ...query } as Record<string, string | number>;
      if (q.status) q.status = TAB_QUERY[q.status as HookTab] ?? q.status;
      return unwrap(api.GET('/v1/webhooks', { params: { query: q as never } }));
    },
    { sort: '-updatedAt' },
  );
}

export function useWebhookSummary() {
  return useQuery({
    queryKey: [KEY, 'summary'],
    queryFn: () => unwrap(api.GET('/v1/webhooks/summary')),
  });
}

export function useWebhookEventTypes() {
  return useQuery({
    queryKey: [KEY, 'event-types'],
    queryFn: () => unwrap(api.GET('/v1/webhooks/event-types')),
    staleTime: 10 * 60_000,
  });
}

export function useCreateWebhook() {
  const qc = useQueryClient();
  return useMutation({
    // ไม่ส่ง Idempotency-Key: ผลมี secret ที่แสดงครั้งเดียว — ส่งซ้ำ = URL ซ้ำ 409
    mutationFn: (body: WebhookCreate) => unwrap(api.POST('/v1/webhooks', { body })),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

/** ปิด (มีเหตุผล) / เปิด / หมุน signing secret */
export function useWebhookAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      id: string;
      version: number;
      action: 'disable' | 'enable' | 'rotate';
      /** ปิดใช้งาน: เหตุผล ≥ 10 ตัว (บังคับ) */
      reason?: string;
    }): Promise<{ hook: Webhook; secret?: string }> => {
      const params = { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never };
      if (v.action === 'rotate') {
        const r = await unwrap(api.POST('/v1/webhooks/{id}/rotate-secret', { params, body: {} }));
        return { hook: r, secret: r.secret };
      }
      const r = await unwrap(
        v.action === 'disable'
          ? api.POST('/v1/webhooks/{id}/disable', { params, body: { reason: v.reason ?? '' } })
          : api.POST('/v1/webhooks/{id}/enable', { params, body: {} }),
      );
      return { hook: r };
    },
    onError: refetchOnStale(qc, KEY),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: ['history'] });
    },
  });
}

/** ส่ง `webhook.test` ทันที (รอผลไม่เกิน 10 วิ) */
export function useTestWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST('/v1/webhooks/{id}/test', { params: { path: { id } }, body: {} })),
    onSettled: () => qc.invalidateQueries({ queryKey: ['history'] }),
  });
}

/** ข้อความ "Header เพิ่มเติม" (บรรทัดละ `Name: value`) → รายการ — คืน null ถ้ามีบรรทัดผิดรูปแบบ (ต้นแบบ cfHook chk) */
export function parseHeaders(s: string): { name: string; value: string }[] | null {
  const lines = s
    .split('\n')
    .map((z) => z.trim())
    .filter(Boolean);
  const out: { name: string; value: string }[] = [];
  for (const l of lines) {
    if (!/^[A-Za-z0-9-]+:\s*\S/.test(l)) return null;
    const i = l.indexOf(':');
    out.push({ name: l.slice(0, i).trim(), value: l.slice(i + 1).trim() });
  }
  return out;
}

/** URL ตามกฎของต้นแบบ (cfHook) — https และมีโดเมน */
export const HOOK_URL_RE = /^https:\/\/[^\s/$.?#][^\s]*\.[^\s]+$/i;
