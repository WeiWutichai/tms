import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

/** ที่เก็บสถานะ/ผลของการวัด (อยู่ใต้ .data — ไม่ commit) */
export const PERF_DIR = resolve(__dirname, '../../.data/perf');
export const STATE_FILE = resolve(PERF_DIR, 'state.json');

export const API_PORT = Number(process.env.PERF_API_PORT);
export const RECEIVER_PORT = Number(process.env.PERF_RECEIVER_PORT);
export const BASE = `http://127.0.0.1:${API_PORT}`;

/** กันรันผิดฐาน: script ทุกตัวต้องถูกเรียกผ่าน cli.mjs (ซึ่งสลับ connection string ไปฐาน *_perf) */
export function assertPerfDb(): string {
  const names = ['DATABASE_URL', 'APP_DATABASE_URL', 'PLATFORM_DATABASE_URL'].map((k) =>
    decodeURIComponent(new URL(process.env[k] ?? 'postgres://x/none').pathname.slice(1)),
  );
  if (!names.every((n) => /^[a-z0-9_]+_perf$/.test(n) && n === process.env.PERF_DB))
    throw new Error(`perf: ต้องรันผ่าน "pnpm --filter @tms/api perf" (ฐาน: ${names.join(', ')})`);
  if (!API_PORT || !RECEIVER_PORT)
    throw new Error('perf: ไม่มี PERF_API_PORT / PERF_RECEIVER_PORT');
  return names[0]!;
}

/** ขนาดข้อมูลตั้งต้น (แก้ที่นี่ที่เดียว — รายงานอ้างค่าชุดนี้) */
export const VOLUME = {
  /** ใบสั่งขนส่ง = ใบส่งของ = เที่ยว (1:1:1) */
  orders: 10_000,
  /** ใบแจ้งหนี้ย้อนหลัง (ทุกสถานะ) */
  invoices: 10_000,
  /** รอบวางบิล A: DO ส่งบัญชีแล้ว (ต.ค. 2569) · B: DO ยังไม่ส่งบัญชี (ก.ย. 2569 — วัดทาง releaseDeliveryOrders) */
  runA: { from: 1, to: 2000, periodFrom: '2026-10-01', periodTo: '2026-10-31' },
  runB: { from: 2001, to: 4000, periodFrom: '2026-09-01', periodTo: '2026-09-30' },
  /** ใบเดียว 500 DO (เกณฑ์ NFR) และ 200 DO (เพดานของ POST /invoices ต่อคำขอ) */
  big500: { from: 4001, to: 4500 },
  big200: { from: 4501, to: 4700 },
  /** ลูกค้าของรอบวางบิล: 2 รายใหญ่ (450 DO — ใกล้ใบ KRS 446 รายการ) + 22 ราย × 50 DO */
  runCustomers: 24,
  histCustomers: 20,
  vehicles: 20,
} as const;

export interface PerfState {
  seededAt: string;
  tenantId: string;
  customers: { run: string[]; big500: string; big200: string; hist: string[] };
  vehicles: string[];
  sites: { origin: string; dest: string };
  vehicleTypeId: string;
  unitId: string;
  /** ตัวอย่างที่สร้างผ่าน API จริง (ใช้เป็นแม่แบบ clone และเป็นเป้าของ GET รายการเดียว) */
  template: { orderId: string; deliveryOrderId: string; tripId: string; invoiceId: string };
  /** ธงว่าข้อมูลส่วนที่ใช้แล้วหมดไป (finalize / invoice run) ถูกใช้ไปหรือยัง */
  consumed: Record<string, string>;
}

export function readState(): PerfState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as PerfState;
  } catch {
    throw new Error('perf: ยังไม่มีข้อมูลตั้งต้น — รัน "pnpm --filter @tms/api perf seed" ก่อน');
  }
}
export function writeState(s: PerfState): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

export interface Res<T = any> {
  status: number;
  body: T;
  ms: number;
  bytes: number;
  headers: Headers;
}

/** เรียก API จริงผ่าน HTTP (เวลา = ส่งคำขอ → อ่าน body ครบ) */
export function client(token: string, base = BASE) {
  return async function call<T = any>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Res<T>> {
    const t0 = performance.now();
    const r = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    const ms = performance.now() - t0;
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* ไม่ใช่ JSON (เช่น PDF) */
    }
    return { status: r.status, body: parsed as T, ms, bytes: text.length, headers: r.headers };
  };
}
export type Call = ReturnType<typeof client>;

export function ok<T>(r: Res<T>, expect: number | number[], what: string): Res<T> {
  const want = Array.isArray(expect) ? expect : [expect];
  if (!want.includes(r.status))
    throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 800)}`);
  return r;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** เลขผู้เสียภาษี 13 หลักที่ checksum ถูก (ข้อมูลสมมติ — ขึ้นต้น 0990 ไม่ใช่เลขจริง) */
export function taxId(seed: number): string {
  const base = `0990${String(seed).padStart(8, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

export interface Stats {
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}
const r1 = (x: number) => Math.round(x * 10) / 10;
/** percentile แบบ nearest-rank (n น้อย: p95 ของ 20 ตัวอย่าง = ตัวที่ 19) */
export function stats(xs: number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? 0;
  return {
    n: s.length,
    min: r1(s[0] ?? 0),
    p50: r1(q(0.5)),
    p95: r1(q(0.95)),
    p99: r1(q(0.99)),
    max: r1(s[s.length - 1] ?? 0),
    mean: r1(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)),
  };
}

export const load = () => loadavg().map((x) => Math.round(x * 100) / 100);

/**
 * รอจน load average (1 นาที) ≤ เพดาน — เครื่องเดียวกันรัน CI/lane อื่นอยู่ ผลจะเพี้ยนและไปแย่ง CPU งานอื่น
 * `--force` = ไม่รอ (ผลถูกติดป้ายว่าเครื่องมีโหลด)
 */
export async function waitQuiet(max: number, force: boolean, what: string): Promise<number[]> {
  for (let i = 0; i < 60 && !force; i++) {
    const [l1] = load();
    if (l1! <= max) break;
    if (i === 0) console.log(`  … รอเครื่องว่าง (${what}): load ${l1} > ${max} (ข้าม: --force)`);
    await sleep(10_000);
  }
  return load();
}
