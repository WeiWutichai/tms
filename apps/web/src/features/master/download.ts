import { api } from '../../api';
import { exportList, ExportQueued, ExportFailed, type ExportResource } from '../exports/exportJob';
import type { T } from '../../i18n';

/** path ส่งออกของ master ที่มี (เพิ่มเมื่อ master ใหม่มี `GET /{master}/export`) */
export type ExportPath =
  | '/v1/customers/export'
  | '/v1/customer-sites/export'
  | '/v1/vehicle-types/export'
  | '/v1/carriers/export'
  | '/v1/vehicles/export'
  | '/v1/drivers/export'
  | '/v1/routes/export'
  | '/v1/products/export'
  | '/v1/service-items/export'
  | '/v1/rate-cards/export'
  | '/v1/vehicle-documents/export';

/**
 * ดาวน์โหลดไฟล์จาก endpoint ส่งออก — ผ่าน client เดียวกับ UI (token, ภาษา, การใช้งานแทน) แบบ blob
 * error → throw (หน้าแสดง toast) · revoke URL หลังเบราว์เซอร์เริ่มดาวน์โหลดแล้ว
 * คืนจำนวนแถวในไฟล์เมื่อ API ส่ง header `X-Export-Rows` (เอกสารรถ ST2-T19) — ไม่มี = undefined
 */
export async function downloadFile(
  path: ExportPath,
  query: Record<string, string>,
): Promise<number | undefined> {
  const q = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== ''));
  const r = await api.GET(path, { params: { query: q as never }, parseAs: 'blob' });
  // เกินเพดานส่งออกทันที (10,000 แถว) และส่งออกตามตัวกรอง → ส่งเป็นงานเบื้องหลัง (ST9-T10)
  const tooMany = (r.error as { errors?: { code?: string }[] } | undefined)?.errors?.some(
    (e) => e.code === 'too_many_rows',
  );
  if (r.response.status === 422 && tooMany && !q.ids) {
    const { format, ...filter } = q;
    const resource = /^\/v1\/(.+)\/export$/.exec(path)![1] as ExportResource;
    return exportList(resource, filter, format === 'csv' ? 'csv' : 'xlsx');
  }
  if (!r.response.ok || !r.data) throw new Error(`export failed: ${r.response.status}`);
  const name =
    /filename="([^"]+)"/.exec(r.response.headers.get('content-disposition') ?? '')?.[1] ??
    'export.xlsx';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(r.data as Blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  const n = Number(r.response.headers.get('x-export-rows') ?? NaN);
  return Number.isInteger(n) ? n : undefined;
}

/**
 * ข้อความ toast เมื่อส่งออกไม่ได้ไฟล์ทันที (ST9-T10): ส่งเป็นงานเบื้องหลังแล้ว → "จะแจ้งเตือนเมื่อไฟล์พร้อม" ·
 * เกินเพดานงาน → บอกให้กรองแคบลง · อื่น ๆ = ข้อความ "ส่งออกไม่สำเร็จ" ของหน้านั้น
 */
export function exportFailText(t: T, e: unknown, failed: string): string {
  if (e instanceof ExportQueued) return t('export.queued');
  if (e instanceof ExportFailed && e.code === 'too_many_rows') return t('export.tooMany');
  return failed;
}
