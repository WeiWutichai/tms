import { api } from '../../api';

/** path ส่งออกของ master ที่มี (เพิ่มเมื่อ master ใหม่มี `GET /{master}/export`) */
export type ExportPath = '/v1/customers/export';

/**
 * ดาวน์โหลดไฟล์จาก endpoint ส่งออก — ผ่าน client เดียวกับ UI (token, ภาษา, การใช้งานแทน) แบบ blob
 * error → throw (หน้าแสดง toast) · revoke URL หลังเบราว์เซอร์เริ่มดาวน์โหลดแล้ว
 */
export async function downloadFile(path: ExportPath, query: Record<string, string>): Promise<void> {
  const q = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== ''));
  const r = await api.GET(path, { params: { query: q as never }, parseAs: 'blob' });
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
}
