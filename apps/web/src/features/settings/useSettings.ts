import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../api';

export type Branch = Schemas['BranchDto'];
export type Sequence = Schemas['SequenceDto'];
export type User = Schemas['UserDto'];
export type Role = Schemas['RoleDto'];

/** ทั้งหมดในหน้าเดียว (นิติบุคคล/สาขาของ tenant มีไม่กี่แถว — สูงสุด 200 ตาม limit ของ API) */
export function useCompaniesAll() {
  return useQuery({
    queryKey: ['companies', 'all'],
    queryFn: () => unwrap(api.GET('/v1/companies', { params: { query: { limit: 200 } } })),
  });
}
export function useBranches() {
  return useQuery({
    queryKey: ['branches'],
    queryFn: () => unwrap(api.GET('/v1/branches', { params: { query: { limit: 200 } } })),
  });
}
export function useSequences() {
  return useQuery({
    queryKey: ['sequences'],
    queryFn: () => unwrap(api.GET('/v1/document-sequences')),
  });
}
export function useUsers() {
  return useQuery({
    queryKey: ['users'],
    queryFn: () => unwrap(api.GET('/v1/users', { params: { query: { limit: 200 } } })),
  });
}
export function useRoles() {
  return useQuery({ queryKey: ['roles'], queryFn: () => unwrap(api.GET('/v1/roles')) });
}

export function useSaveBranch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { id?: string; version?: number; body: Record<string, unknown> }) =>
      v.id
        ? unwrap(
            api.PATCH('/v1/branches/{id}', {
              params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
              body: v.body as never,
            }),
          )
        : unwrap(
            api.POST('/v1/branches', {
              body: v.body as never,
              headers: { 'Idempotency-Key': crypto.randomUUID() },
            }),
          ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['branches'] }),
  });
}

export function useSaveSequence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { id: string; version: number; body: Record<string, unknown> }) =>
      unwrap(
        api.PATCH('/v1/document-sequences/{id}', {
          params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
          body: v.body as never,
        }),
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: ['sequences'] }),
  });
}

export type TenantSetting = Schemas['SettingDto'];

export function useTenantSettings() {
  return useQuery({
    queryKey: ['tenant-settings'],
    queryFn: () => unwrap(api.GET('/v1/settings')),
  });
}

export function useSaveTenantSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      values: Record<string, unknown>;
      versions: Record<string, number>;
      stepUp?: string;
    }) =>
      unwrap(
        api.PATCH('/v1/settings', {
          body: { values: v.values, versions: v.versions },
          params: { header: v.stepUp ? { 'X-Step-Up': v.stepUp } : {} } as never,
        }),
      ),
    onSuccess: (data) => {
      qc.setQueryData(['tenant-settings'], data);
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

/** step-up 2FA (ST1-T05) — คืน token สำหรับ header X-Step-Up */
export async function stepUp(otp: string): Promise<string> {
  const r = await unwrap(api.POST('/v1/auth/step-up', { body: { otp } }));
  return r.stepUpToken;
}
