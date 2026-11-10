import type { Schemas } from '@tms/contracts';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, unwrap } from '../../api';

export type Company = Schemas['CompanyDto'];

/** list แบบ cursor: เก็บ cursor ของแต่ละหน้าที่เดินผ่าน เพื่อย้อนกลับได้ (API ไม่มี offset) */
export function useCompanyList() {
  const [size, setSize] = useState(20);
  const [status, setStatus] = useState('');
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [index, setIndex] = useState(0);
  const q = useQuery({
    queryKey: ['companies', size, status, cursors[index]],
    placeholderData: keepPreviousData,
    queryFn: () =>
      unwrap(
        api.GET('/v1/companies', {
          params: {
            query: {
              limit: size,
              sort: '-updatedAt',
              ...(status ? { status } : {}),
              ...(cursors[index] ? { cursor: cursors[index] } : {}),
            },
          },
        }),
      ),
  });
  const reset = () => {
    setCursors([undefined]);
    setIndex(0);
  };
  return {
    q,
    rows: q.data?.data ?? [],
    page: {
      index,
      size,
      hasNext: !!q.data?.hasMore,
      visited: cursors.length,
      rowsOnPage: q.data?.data.length ?? 0,
    },
    status,
    setStatus: (s: string) => {
      setStatus(s);
      reset();
    },
    setSize: (n: number) => {
      setSize(n);
      reset();
    },
    next: () => {
      const c = q.data?.nextCursor;
      if (!c) return;
      setCursors((cs) => (cs.length > index + 1 ? cs : [...cs, c]));
      setIndex((i) => i + 1);
    },
    prev: () => setIndex((i) => Math.max(0, i - 1)),
    goto: (i: number) => setIndex(i),
  };
}

export function useSaveCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { id?: string; version?: number; body: Record<string, unknown> }) => {
      if (v.id) {
        return unwrap(
          api.PATCH('/v1/companies/{id}', {
            params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
            body: v.body as never,
          }),
        );
      }
      return unwrap(
        api.POST('/v1/companies', {
          body: v.body as never,
          headers: { 'Idempotency-Key': crypto.randomUUID() },
        }),
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['companies'] }),
  });
}

export function useChangeCompanyStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; action: 'activate' | 'deactivate'; reason: string }) =>
      unwrap(
        v.action === 'activate'
          ? api.POST('/v1/companies/{id}/activate', {
              params: { path: { id: v.id } },
              body: { reason: v.reason },
            })
          : api.POST('/v1/companies/{id}/deactivate', {
              params: { path: { id: v.id } },
              body: { reason: v.reason },
            }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['companies'] }),
  });
}
