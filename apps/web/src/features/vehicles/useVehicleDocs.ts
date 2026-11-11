import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, unwrap } from '../../api';

export type VehicleDoc = Schemas['VehicleDocumentDto'];
export type VehicleDocCreate = Schemas['CreateVehicleDocumentDto'];
export type VehicleDocRenew = Schemas['RenewVehicleDocumentDto'];
export type VehicleDocType = VehicleDoc['docType'];

/** ลำดับประเภทตามต้นแบบ (ประกันภัย · พ.ร.บ. · ภาษี · ตรอ. · ใบอนุญาตขนส่ง · GPS DLT) */
export const VEHICLE_DOC_TYPES: VehicleDocType[] = [
  'INSURANCE',
  'COMPULSORY_ACT',
  'ANNUAL_TAX',
  'INSPECTION',
  'TRANSPORT_LICENSE',
  'GPS_DLT_CERT',
  'OTHER',
];
/** ไฟล์แนบเอกสารรถ — ชนิด/ขนาดเดียวกับ /v1/documents (docs/04 I 10 MB) */
export const DOC_FILE_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const;
export const DOC_FILE_MAX = 10 * 1024 * 1024;

const KEY = 'vehicle-documents';

export function useVehicleDocs(vehicleId: string) {
  return useQuery({
    queryKey: [KEY, vehicleId],
    queryFn: () =>
      unwrap(api.GET('/v1/vehicles/{id}/documents', { params: { path: { id: vehicleId } } })),
    select: (r) => r.data,
  });
}

/** อัปโหลดไฟล์ 1 ไฟล์ (จอง → PUT เนื้อไฟล์) คืน id เอกสาร `doc_…` */
export async function uploadDocFile(f: File): Promise<string> {
  const mime = DOC_FILE_MIME.find((m) => m === f.type);
  if (!mime || f.size > DOC_FILE_MAX || f.size === 0) throw new Error('bad_file');
  const doc = await unwrap(
    api.POST('/v1/documents', {
      body: { kind: 'VEHICLE_DOC', mime, bytes: f.size, filename: f.name },
    }),
  );
  const u = new URL(doc.uploadUrl!, location.origin);
  const up = await fetch(u.pathname + u.search, { method: 'PUT', body: f });
  if (!up.ok) throw new ApiError((await up.json()) as never);
  return doc.id;
}

/** เปิดไฟล์แนบ (ลิงก์ดาวน์โหลดอายุสั้นจาก GET /v1/documents/{id}) */
export async function openDocFile(id: string): Promise<void> {
  const d = await unwrap(api.GET('/v1/documents/{id}', { params: { path: { id } } }));
  if (!d.downloadUrl) throw new Error('not_ready');
  const u = new URL(d.downloadUrl, location.origin);
  const a = document.createElement('a');
  a.href = u.pathname + u.search;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function useCreateVehicleDoc(vehicleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { body: VehicleDocCreate; idempotencyKey: string }) =>
      unwrap(
        api.POST('/v1/vehicles/{id}/documents', {
          params: { path: { id: vehicleId } },
          body: v.body,
          headers: { 'Idempotency-Key': v.idempotencyKey },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useRenewVehicleDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; body: VehicleDocRenew; idempotencyKey: string }) =>
      unwrap(
        api.POST('/v1/vehicle-documents/{id}/renew', {
          params: { path: { id: v.id } },
          body: v.body,
          headers: { 'Idempotency-Key': v.idempotencyKey },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

/** YYYY-MM-DD วันนี้ตามเวลาไทย */
export const todayTh = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
/** + n ปี (29 ก.พ. → 28 ก.พ.) */
export function addYears(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y + n, m, 0)).getUTCDate();
  return `${y + n}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
