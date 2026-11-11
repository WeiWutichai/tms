import { getAccessToken } from '../../auth/session';

/**
 * ดาวน์โหลดไฟล์จาก endpoint ส่งออก (`GET /v1/{master}/export`) — ใช้ token เดียวกับ client
 * (ไฟล์ binary จึงไม่ผ่าน openapi-fetch ที่ parse JSON)
 */
export async function downloadFile(path: string, query: Record<string, string>): Promise<void> {
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== '')).toString();
  const token = await getAccessToken();
  const res = await fetch(`${path}${qs ? `?${qs}` : ''}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`export failed: ${res.status}`);
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'export.xlsx';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
