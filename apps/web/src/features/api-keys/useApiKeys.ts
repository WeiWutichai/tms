import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../api';
import { refetchOnStale } from '../master/problems';
import { stepUpHeaders, withStepUp } from '../stepup/stepUp';
import { useCursorList } from '../master/useCursorList';

export type ApiKey = Schemas['ApiKeyDto'];
export type ApiKeyWithSecret = Schemas['ApiKeySecretDto'];
export type ApiKeyStatus = ApiKey['status'];
export type ApiKeyCreate = Schemas['CreateApiKeyDto'];
export type ApiKeyUpdate = Schemas['UpdateApiKeyDto'];

/** แท็บสถานะตามต้นแบบ specApi (ทั้งหมด / ใช้งาน / ใกล้หมดอายุ / หมุนเวียน / เพิกถอน) */
export const STATUS_TABS = ['active', 'expiring', 'rotating', 'revoked'] as const;
/** อายุที่เลือกได้ตามลำดับในต้นแบบ cfKey (90 วัน เป็นค่าเริ่ม) — null = ไม่หมดอายุ */
export const TTL_OPTIONS = [90, 30, 365, null] as const;

const KEY = 'api-keys';

export interface ApiKeyFilters {
  status: string;
  name: string;
  scope: string;
  createdBy: string;
}

export function useApiKeyList(filters: ApiKeyFilters) {
  return useCursorList<ApiKey>(
    KEY,
    { ...filters },
    (query) => unwrap(api.GET('/v1/api-keys', { params: { query: query as never } })),
    { sort: '-updatedAt' },
  );
}

export function useApiKeySummary() {
  return useQuery({
    queryKey: [KEY, 'summary'],
    queryFn: () => unwrap(api.GET('/v1/api-keys/summary')),
  });
}

/** scope ที่ให้ key ได้ + ผู้ใช้ให้ได้ไหม (INT-073) */
export function useScopeOptions() {
  return useQuery({
    queryKey: [KEY, 'scopes'],
    queryFn: () => unwrap(api.GET('/v1/api-keys/scopes')),
    staleTime: 5 * 60_000,
  });
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    // ไม่ส่ง Idempotency-Key: ผลมี secret ที่แสดงครั้งเดียว (API ไม่เก็บ response) — ส่งซ้ำ = ชื่อซ้ำ 409
    // ST7-T09: key test สร้างใน sandbox — ส่งโหมดที่เลือกในฟอร์มเป็น header (ไม่ขึ้นกับโหมดของหน้า)
    // D-67: สร้าง key ต้องยืนยัน 2FA — 403 step_up_required → กล่องยืนยัน แล้วส่งซ้ำพร้อม X-Step-Up
    mutationFn: (body: ApiKeyCreate) =>
      withStepUp((su) =>
        unwrap(
          api.POST('/v1/api-keys', {
            params: { header: { 'X-Tms-Mode': body.mode ?? 'live' } } as never,
            headers: stepUpHeaders(su),
            body,
          }),
        ),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useUpdateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    // D-67 review M2: แก้ scope / IP ต้องยืนยัน 2FA
    mutationFn: (v: { id: string; version: number; body: ApiKeyUpdate }) =>
      withStepUp((su) =>
        unwrap(
          api.PATCH('/v1/api-keys/{id}', {
            params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
            headers: stepUpHeaders(su),
            body: v.body,
          }),
        ),
      ),
    onError: refetchOnStale(qc, KEY),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: ['history'] });
    },
  });
}

/** หมุนเวียน (ต้นแบบ: key เดิมใช้ได้อีก 24 ชม.) / เพิกถอน — เหตุผล ≥ 10 ตัว */
export function useApiKeyAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      id: string;
      version: number;
      action: 'rotate' | 'revoke';
      reason: string;
    }): Promise<{ key: ApiKey; secret?: ApiKeyWithSecret }> => {
      const params = {
        path: { id: v.id },
        header: { 'If-Match': `"${v.version}"` } as never,
      };
      if (v.action === 'rotate') {
        const r = await withStepUp((su) =>
          unwrap(
            api.POST('/v1/api-keys/{id}/rotate', {
              params,
              headers: stepUpHeaders(su), // D-67
              body: { reason: v.reason, graceHours: 24 },
            }),
          ),
        );
        return { key: r, secret: r };
      }
      const r = await unwrap(
        api.POST('/v1/api-keys/{id}/revoke', { params, body: { reason: v.reason } }),
      );
      return { key: r };
    },
    onError: refetchOnStale(qc, KEY),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: ['history'] });
    },
  });
}
