import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, unwrap } from '../../api';
import { DOC_FILE_MAX, DOC_FILE_MIME } from '../vehicles/useVehicleDocs';

export type UploadLink = Schemas['UploadLinkDto'];
export type IssuedUploadLink = Schemas['IssuedUploadLinkDto'];
export type DocSubmission = Schemas['CarrierDocSubmissionDto'];
export type LinkView = Schemas['CarrierDocsLinkViewDto'];
export type LinkItem = Schemas['LinkItemDto'];

const LINKS = 'carrier-upload-links';
const SUBS = 'carrier-doc-submissions';

// ---------- admin (ST2-T21) ----------

export function useUploadLinks(carrierId: string) {
  return useQuery({
    queryKey: [LINKS, carrierId],
    queryFn: () =>
      unwrap(api.GET('/v1/carriers/{id}/upload-links', { params: { path: { id: carrierId } } })),
    select: (r) => r.data,
  });
}

export function useIssueUploadLink(carrierId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/v1/carriers/{id}/upload-links', {
          params: { path: { id: carrierId } },
          body: {},
        }),
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [LINKS, carrierId] }),
  });
}

export function useRevokeUploadLink(carrierId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      unwrap(
        api.POST('/v1/carrier-upload-links/{id}/revoke', {
          params: { path: { id: v.id } },
          body: { reason: v.reason },
        }),
      ),
    // แทนแถวในแคชทันที (ไม่ให้กดยกเลิกลิงก์เดิมซ้ำระหว่างรอโหลดใหม่ → 409) แล้วค่อยโหลดใหม่
    onSuccess: (row) => {
      qc.setQueryData<{ data: UploadLink[] }>([LINKS, carrierId], (old) =>
        old ? { ...old, data: old.data.map((l) => (l.id === row.id ? row : l)) } : old,
      );
      void qc.invalidateQueries({ queryKey: [LINKS, carrierId] });
    },
  });
}

export function useDocSubmissions(carrierId: string) {
  return useQuery({
    queryKey: [SUBS, carrierId],
    queryFn: () =>
      unwrap(api.GET('/v1/carrier-doc-submissions', { params: { query: { carrierId } } })),
    select: (r) => r.data,
  });
}

/** อนุมัติ/ไม่อนุมัติ — เอกสารรถ/คนขับเปลี่ยน → รีเฟรชรายการที่เกี่ยว */
export function useReviewSubmission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; reason: string; action: 'approve' | 'reject' }) =>
      unwrap(
        v.action === 'approve'
          ? api.POST('/v1/carrier-doc-submissions/{id}/approve', {
              params: { path: { id: v.id } },
              body: { reason: v.reason },
            })
          : api.POST('/v1/carrier-doc-submissions/{id}/reject', {
              params: { path: { id: v.id } },
              body: { reason: v.reason },
            }),
      ),
    onSuccess: () => {
      for (const k of [SUBS, 'vehicle-documents', 'vehicles', 'drivers', 'history'])
        void qc.invalidateQueries({ queryKey: [k] });
    },
  });
}

// ---------- หน้าลิงก์ (public — ไม่ login) ----------

export function useLinkView(token: string) {
  return useQuery({
    queryKey: ['carrier-docs-link', token],
    queryFn: () =>
      unwrap(api.GET('/v1/public/carrier-docs/{token}', { params: { path: { token } } })),
    retry: false,
  });
}

/** อัปโหลดไฟล์ 1 ไฟล์ผ่านลิงก์ (จอง → PUT เนื้อไฟล์) คืน `doc_…` */
export async function uploadLinkFile(token: string, f: File): Promise<string> {
  const mime = DOC_FILE_MIME.find((m) => m === f.type);
  if (!mime || f.size > DOC_FILE_MAX || f.size === 0) throw new Error('bad_file');
  const r = await unwrap(
    api.POST('/v1/public/carrier-docs/{token}/files', {
      params: { path: { token } },
      body: { mime, bytes: f.size, filename: f.name },
    }),
  );
  const u = new URL(r.uploadUrl, location.origin);
  const up = await fetch(u.pathname + u.search, { method: 'PUT', body: f });
  if (!up.ok) throw new ApiError((await up.json()) as never);
  return r.id;
}

export function useSubmitDoc(token: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas['CreateSubmissionDto']) =>
      unwrap(
        api.POST('/v1/public/carrier-docs/{token}/submissions', {
          params: { path: { token } },
          body,
        }),
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['carrier-docs-link', token] }),
  });
}
