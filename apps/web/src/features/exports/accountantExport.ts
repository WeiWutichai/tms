import type { Schemas } from '@tms/contracts';
import { api, unwrap } from '../../api';
import { type ExportResource, fetchExport, openDownload } from './exportJob';

export type XpDataset = 'sales' | 'receipts' | 'settlements';
export type XpSummary = Schemas['AccountingExportSummaryDto'];
export type XpFormat = 'xlsx' | 'csv';

/** งวดของต้นแบบ (`vXp` pers): เดือนที่แล้ว (ค่าเริ่ม) · เดือนนี้ถึงวันนี้ · ไตรมาสนี้ */
export interface XpPeriod {
  key: 'last' | 'this' | 'quarter';
  from: string;
  to: string;
  /** เดือน 1–12 / ปี ค.ศ. ของงวด (ป้าย) — ไตรมาส: q = 1–4 */
  month: number;
  year: number;
  q?: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

export function xpPeriods(today: string): XpPeriod[] {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const ly = m === 1 ? y - 1 : y;
  const lm = m === 1 ? 12 : m - 1;
  const q = Math.floor((m - 1) / 3) + 1;
  const qm = (q - 1) * 3 + 1;
  return [
    { key: 'last', from: ymd(ly, lm, 1), to: ymd(ly, lm, lastDay(ly, lm)), month: lm, year: ly },
    { key: 'this', from: ymd(y, m, 1), to: today, month: m, year: y },
    {
      key: 'quarter',
      from: ymd(y, qm, 1),
      to: ymd(y, qm + 2, lastDay(y, qm + 2)),
      month: qm,
      year: y,
      q,
    },
  ];
}

/**
 * ป้ายงวดในชื่อไฟล์ — กติกาเดียวกับ API (`accountingPeriodTag`): เต็มเดือน "ต.ค.2569" · เต็มไตรมาส "ไตรมาส4-2569"
 * · ช่วงอื่น "2026-11-01_2026-11-22"
 */
export function xpPeriodTag(
  from: string,
  to: string,
  monthAbbr: (m: number) => string,
  quarterTag: (q: number, beYear: number) => string,
): string {
  const [y1, m1, d1] = from.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = to.split('-').map(Number) as [number, number, number];
  if (d1 === 1 && y1 === y2 && d2 === lastDay(y2, m2)) {
    if (m1 === m2) return `${monthAbbr(m1)}${y1 + 543}`;
    if (m1 % 3 === 1 && m2 === m1 + 2) return quarterTag((m1 + 2) / 3, y1 + 543);
  }
  return `${from}_${to}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WAIT_MS = 8000;
const POLL_MS = 1000;

export interface XpRunResult {
  done: number;
  queued: number;
  failed: string | null;
  /** จำนวนไฟล์ที่สั่งไม่สำเร็จ (งานอื่นยังเดินต่อ) */
  notCreated: number;
}

/**
 * สั่งส่งออกทีละชุด (`POST /v1/exports` 1 งานต่อไฟล์) แล้วรอสั้น ๆ — เสร็จทันดาวน์โหลดเลย ไม่ทันไฟล์มาทางแจ้งเตือน (ST9-T10)
 */
export async function runAccountantExport(
  resources: string[],
  format: XpFormat,
  filter: { dateFrom: string; dateTo: string },
): Promise<XpRunResult> {
  // สั่งทุกไฟล์พร้อมกัน — บางงานสร้างไม่ได้ (เช่น ถูกถอดสิทธิ์) ไม่ทิ้งงานที่สร้างแล้ว
  const created = await Promise.allSettled(
    resources.map((resource) =>
      unwrap(
        api.POST('/v1/exports', {
          body: { resource: resource as ExportResource, format, filter },
        }),
      ),
    ),
  );
  const jobs = created.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  if (!jobs.length) throw (created[0] as PromiseRejectedResult).reason;
  const pending = new Set(jobs.map((j) => j.id));
  let done = 0;
  let failed: string | null = null;
  const notCreated = created.length - jobs.length;
  const until = Date.now() + WAIT_MS;
  while (pending.size && Date.now() < until) {
    await sleep(POLL_MS);
    for (const id of [...pending]) {
      const s = await fetchExport(id);
      if (s.status === 'succeeded' && s.downloadUrl) {
        openDownload(s.downloadUrl);
        done++;
        pending.delete(id);
      } else if (s.status === 'failed' || s.status === 'expired') {
        failed = s.error?.code ?? 'failed';
        pending.delete(id);
      }
    }
  }
  return { done, queued: pending.size, failed, notCreated };
}
