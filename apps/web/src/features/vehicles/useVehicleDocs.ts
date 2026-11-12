import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, idempotent, unwrap } from '../../api';
import { useCursorList } from '../master/useCursorList';

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

/** ตัวกรองหน้าเอกสารรถรวม (ST2-T19) — ช่องคอลัมน์ของตาราง */
export interface FleetDocFilters {
  plate: string;
  docType: string;
  docNo: string;
  issuer: string;
  /** '' | 'expired' (หมดอายุ) | 'soon' (ใกล้หมดอายุ ≤ 30 วัน) | 'ok' (ปกติ > 30 วัน) — ป้ายของต้นแบบ specFDoc */
  st: string;
}
/** แท็บ/การ์ดของต้นแบบ: ทั้งหมด · หมดแล้ว · ภายใน 7 / 30 / 60 วัน */
export const FDOC_TABS = ['all', 'exp', 'd7', 'd30', 'd60'] as const;
export type FleetDocTab = (typeof FDOC_TABS)[number];
const TAB_DAYS: Partial<Record<FleetDocTab, number>> = { d7: 7, d30: 30, d60: 60 };
/** เกณฑ์ "ใกล้หมดอายุ" ของหน้า (ต้นแบบ ≤ 30 วัน; สถานะ API expiring = ≤ 60 วัน) */
export const SOON_DAYS = 30;

/**
 * แท็บ ∩ ตัวกรองสถานะ → query ของ GET /v1/vehicle-documents · ขัดกันเอง (เช่น แท็บหมดแล้ว + ปกติ) → null = ตารางว่าง
 */
export function fleetDocQuery(tab: FleetDocTab, f: FleetDocFilters): Record<string, string> | null {
  const { st, ...rest } = f;
  const q: Record<string, string> = { ...rest };
  const tabDays = TAB_DAYS[tab];
  if (tab === 'exp') {
    if (st && st !== 'expired') return null;
    q.status = 'expired';
  } else if (st === 'expired') {
    if (tabDays !== undefined) return null;
    q.status = 'expired';
  }
  let within = tabDays;
  if (st === 'soon') within = Math.min(within ?? SOON_DAYS, SOON_DAYS);
  if (st === 'ok') {
    if (within !== undefined && within <= SOON_DAYS) return null;
    q.expiresBeyondDays = String(SOON_DAYS);
  }
  if (within !== undefined) q.expiresWithinDays = String(within);
  return q;
}

export function useFleetDocList(query: Record<string, string> | null, persist?: string) {
  return useCursorList<VehicleDoc>(
    KEY,
    query ?? {},
    // รายการนี้เรียงวันหมดเสมอ (API ไม่มี sort)
    ({ sort: _sort, ...q }) =>
      unwrap(api.GET('/v1/vehicle-documents', { params: { query: q as never } })),
    { enabled: query !== null, ...(persist ? { persist } : {}) },
  );
}

export function useFleetDocSummary() {
  return useQuery({
    queryKey: [KEY, 'summary'],
    queryFn: () => unwrap(api.GET('/v1/vehicle-documents/summary')),
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

/** เอกสารเปลี่ยน → รายการเอกสาร + ทะเบียนรถ (ป้ายเอกสารใกล้หมด / การ์ด summary — ST2-T07) + กิจกรรมของรถ */
function invalidate(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: [KEY] });
  void qc.invalidateQueries({ queryKey: ['vehicles'] });
  void qc.invalidateQueries({ queryKey: ['history'] });
}

export function useCreateVehicleDoc(vehicleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { body: VehicleDocCreate; idempotencyKey: string }) =>
      idempotent(() =>
        api.POST('/v1/vehicles/{id}/documents', {
          params: { path: { id: vehicleId } },
          body: v.body,
          headers: { 'Idempotency-Key': v.idempotencyKey },
        }),
      ),
    onSuccess: () => invalidate(qc),
  });
}

export function useRenewVehicleDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; body: VehicleDocRenew; idempotencyKey: string }) =>
      idempotent(() =>
        api.POST('/v1/vehicle-documents/{id}/renew', {
          params: { path: { id: v.id } },
          body: v.body,
          headers: { 'Idempotency-Key': v.idempotencyKey },
        }),
      ),
    onSuccess: () => invalidate(qc),
  });
}

/** ยกเลิกเอกสารที่บันทึกผิด (เหตุผล ≥ 10 — API ลง audit, ฉบับเดิมที่ถูกต่ออายุกลับเป็นปัจจุบัน) — review ST2-T07 */
export function useCancelVehicleDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      unwrap(
        api.POST('/v1/vehicle-documents/{id}/cancel', {
          params: { path: { id: v.id } },
          body: { reason: v.reason },
        }),
      ),
    onSuccess: () => invalidate(qc),
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
