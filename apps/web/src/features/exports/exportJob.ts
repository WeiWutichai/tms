import type { Schemas } from '@tms/contracts';
import { api, unwrap } from '../../api';
import { stepUpHeaders, withStepUp } from '../stepup/stepUp';

export type ExportResource = Schemas['CreateExportDto']['resource'];
export type ExportStatus = Schemas['ExportDto'];

/** รอผลงานส่งออกในหน้าไม่เกินนี้ — เสร็จทันก็ดาวน์โหลดเลย ไม่ทันก็รอแจ้งเตือน (ST9-T10) */
const WAIT_MS = 8000;
const POLL_MS = 1000;

/** ส่งออกถูกส่งเป็นงานเบื้องหลัง — ไฟล์จะมาทางแจ้งเตือน (ไม่ใช่ข้อผิดพลาด) */
export class ExportQueued extends Error {
  constructor(readonly jobId: string) {
    super('export_queued');
  }
}

/** ส่งออกล้ม (เช่น too_many_rows) */
export class ExportFailed extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function fetchExport(id: string): Promise<ExportStatus> {
  return unwrap(api.GET('/v1/exports/{id}', { params: { path: { id } } }));
}

/** เปิดลิงก์ดาวน์โหลด (URL ลายเซ็นของ API — ไม่ต้องใช้ token) */
export function openDownload(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * ส่งออกตามตัวกรองของหน้ารายการ (`POST /v1/exports` → 202) แล้วรอสั้น ๆ
 * - เสร็จภายใน ~8 วินาที → ดาวน์โหลดทันที คืนจำนวนแถว
 * - ยังไม่เสร็จ → throw ExportQueued (ไฟล์จะมาทางแจ้งเตือน + อีเมล พร้อมลิงก์ /exports/{id})
 * - ล้ม → throw ExportFailed(code)
 */
export async function exportList(
  resource: ExportResource,
  filter: object,
  format: 'csv' | 'xlsx' | 'pdf' = 'csv',
): Promise<number> {
  const clean = Object.fromEntries(
    Object.entries(filter).filter(
      (e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '',
    ),
  );
  // D-67: ส่งออกทั้งบริษัท (ไม่มีตัวกรอง / ให้นักบัญชี) ต้องยืนยัน 2FA — withStepUp เปิดกล่องยืนยันแล้วส่งซ้ำ
  const job = await withStepUp((su) =>
    unwrap(
      api.POST('/v1/exports', {
        body: { resource, format, filter: clean },
        headers: stepUpHeaders(su),
      }),
    ),
  );
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    await sleep(POLL_MS);
    const s = await fetchExport(job.id);
    if (s.status === 'succeeded' && s.downloadUrl) {
      openDownload(s.downloadUrl);
      return s.rows ?? 0;
    }
    if (s.status === 'failed' || s.status === 'expired')
      throw new ExportFailed(s.error?.code ?? 'failed');
  }
  throw new ExportQueued(job.id);
}
