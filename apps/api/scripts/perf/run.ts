/**
 * ST9-T17 วัดประสิทธิภาพเทียบเป้า NFR (docs/04 "Performance"; spec/11 §8) — รันผ่าน `pnpm --filter @tms/api perf run`
 *
 * เปิด API + worker เป็น process แยก (โค้ดเดียวกับ dev: `src/main.ts` / `src/worker.ts`, role แอป + RLS, rate limit เปิด)
 * กับฐาน `*_perf` ที่ seed แล้ว แล้วยิงผ่าน HTTP จริง:
 *   lists     รายการ 10,000 แถว (orders / delivery-orders / trips / invoices / คิววางบิล): หน้าแรก · cursor ลึก · ตัวกรอง · ไล่ครบ 10,000 แถว
 *   mixed     API p95 ของงานอ่านผสม (ผู้ใช้ 3 คน ~40 คำขอ/วินาที — ใต้เพดาน rate limit ต่อบริษัท 50/วินาที)
 *   webhook   เวลา event → ถึงตัวรับ (ตัวรับ HTTP ในเครื่อง)
 *   finalize  ร่าง + ออกใบแจ้งหนี้ 500 DO และ 200 DO (PDF แยกรายงาน)
 *   run       รอบวางบิล 2,000 DO (ส่งบัญชีแล้ว) และ 2,000 DO (ส่งบัญชีในรอบ)
 *   web       (ไม่อยู่ในค่าเริ่ม — `--web` / `--only=web`) เวลาแสดงตารางในเบราว์เซอร์จริง ดู web.ts
 * ผล: ตารางสรุปบนจอ + JSON ที่ `.data/perf/result-<เวลา>.json` (`--out=<ไฟล์>` เพื่อเก็บที่อื่น)
 *
 * ธง: `--only=lists,mixed,webhook,finalize,run,web` · `--force` (ไม่รอเครื่องว่าง) · `--max-load=12`
 * finalize / run ใช้ข้อมูลหมดไป — รันซ้ำต้อง seed ใหม่ (`perf all`)
 */
import 'reflect-metadata';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PrismaClient } from '@prisma/client';
import { web } from './web';
import {
  API_PORT,
  BASE,
  PERF_DIR,
  RECEIVER_PORT,
  VOLUME,
  assertPerfDb,
  client,
  load,
  ok,
  readState,
  sleep,
  stats,
  waitQuiet,
  writeState,
  type Call,
  type PerfState,
  type Stats,
} from './lib';

const API_DIR = resolve(__dirname, '../..');
const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const FORCE = args.includes('--force');
const MAX_LOAD = Number(flag('max-load') ?? 12);
const SECTIONS = ['lists', 'mixed', 'webhook', 'finalize', 'run', 'web'] as const;
type Section = (typeof SECTIONS)[number];
/** ค่าเริ่ม = ทุกส่วนยกเว้น web (ต้องเปิด vite + Chromium — สั่งเองด้วย `--only=web` หรือ `--web`) */
const ONLY = (flag('only')?.split(',') ?? [
  ...SECTIONS.filter((x) => x !== 'web' || args.includes('--web')),
]) as Section[];

/** เป้า (docs/04 NFR Performance — ตัวตัดสิน; spec/11 §8 เป็น [PROPOSED] ใช้ประกอบ) */
const TARGET = {
  listMs: 2000,
  apiP95Ms: 300,
  finalizeMs: 5000,
  invoiceRunMs: 120_000,
  webhookMs: 5000,
};

interface Row {
  item: string;
  detail: string;
  value: string;
  target: string;
  pass: boolean | null;
}
const rows: Row[] = [];
const result: Record<string, unknown> = {};
const t0 = Date.now();
const log = (m: string) => console.log(`[perf +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const ms = (x: number) => (x >= 10_000 ? `${(x / 1000).toFixed(1)} วิ` : `${Math.round(x)} ms`);

// ---------- ตัวรับ webhook ในเครื่อง ----------
interface Hook {
  at: number;
  type: string;
  body: string;
}
const hooks: Hook[] = [];
function startReceiver() {
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const at = Date.now();
      const body = Buffer.concat(chunks).toString('utf8');
      let type = String(req.headers['x-tms-event'] ?? '');
      let challenge: string | undefined;
      try {
        const j = JSON.parse(body) as {
          type?: string;
          data?: { challenge?: string };
          challenge?: string;
        };
        type ||= j.type ?? '';
        challenge = j.data?.challenge ?? j.challenge;
      } catch {
        /* เก็บ body ดิบ */
      }
      hooks.push({ at, type, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(challenge ? { challenge } : { ok: true }));
    });
  });
  return new Promise<() => void>((done) =>
    srv.listen(RECEIVER_PORT, '127.0.0.1', () => done(() => srv.close())),
  );
}
/** รอ webhook ที่ตรงเงื่อนไข (คืนเวลาที่ถึง หรือ null เมื่อเกินเวลา) */
async function waitHook(match: (h: Hook) => boolean, timeoutMs: number): Promise<Hook | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const h = hooks.find(match);
    if (h) return h;
    if (Date.now() > end) return null;
    await sleep(20);
  }
}

// ---------- process ของ API / worker ----------
const children: ChildProcess[] = [];
function start(name: string, entry: string): ChildProcess {
  mkdirSync(PERF_DIR, { recursive: true });
  const out = createWriteStream(resolve(PERF_DIR, `${name}.log`));
  const p = spawn(process.execPath, ['-r', '@swc-node/register', entry], {
    cwd: API_DIR,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout!.pipe(out);
  p.stderr!.pipe(out);
  children.push(p);
  return p;
}
function stopAll() {
  for (const p of children) if (p.exitCode === null) p.kill('SIGTERM');
}
async function waitApi() {
  for (let i = 0; i < 240; i++) {
    try {
      if ((await fetch(`${BASE}/v1/healthz`)).ok) return;
    } catch {
      /* ยังไม่ขึ้น */
    }
    await sleep(500);
  }
  throw new Error(`API ไม่ขึ้นที่ ${BASE} — ดู ${PERF_DIR}/api.log`);
}

// ---------- ตัววัด ----------
/** ระยะห่างคำขอของผู้ใช้เดียว (~13 คำขอ/วินาที — ใต้เพดานต่อผู้ใช้ 20/วินาที) */
const PACE_MS = 75;
let rateLimited = 0;
async function sample(call: Call, path: string, n: number, warm = 2) {
  const xs: number[] = [];
  let bytes = 0;
  let count = 0;
  for (let i = 0; i < warm + n; i++) {
    const started = performance.now();
    const r = await call('GET', path);
    if (r.status === 429) {
      rateLimited++;
      await sleep(1000);
      i--;
      continue;
    }
    ok(r, 200, path);
    if (i >= warm) xs.push(r.ms);
    bytes = r.bytes;
    count = Array.isArray(r.body?.data) ? r.body.data.length : 0;
    await sleep(Math.max(0, PACE_MS - (performance.now() - started)));
  }
  return { path, rows: count, bytes, ...stats(xs) };
}

const SEED_BASE = Date.parse('2026-11-01T00:00:00Z');
/** cursor ของแถวลำดับ n (ข้อมูลตั้งต้น: updated_at = ฐาน + n × 30 วิ) — ไปหน้าลึกโดยไม่ต้องไล่ทีละหน้า */
const cursorAt = (n: number) =>
  Buffer.from(
    JSON.stringify({
      u: new Date(SEED_BASE + n * 30_000).toISOString(),
      i: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
      s: 'updatedAt',
    }),
  ).toString('base64url');

async function lists(call: Call, s: PerfState) {
  const deep = `cursor=${cursorAt(9000)}`;
  const cus = s.customers.hist[3]!;
  const groups: Record<string, [string, string][]> = {
    orders: [
      ['หน้าแรก (50)', '/v1/orders?limit=50'],
      ['ล่าสุดก่อน (10 — ค่าของหน้าเว็บ)', '/v1/orders?limit=10&sort=-updatedAt'],
      ['cursor ลึก (แถวที่ 9,000)', `/v1/orders?limit=50&${deep}`],
      ['กรองสถานะ', '/v1/orders?limit=50&status=delivered'],
      ['กรองลูกค้า', `/v1/orders?limit=50&customerId=${cus}`],
      ['กรองช่วงวันที่', '/v1/orders?limit=50&requestedFrom=2026-10-01&requestedTo=2026-10-31'],
      ['หน้าใหญ่สุด (200)', '/v1/orders?limit=200'],
      ['สรุปจำนวนต่อสถานะ', '/v1/orders/summary'],
    ],
    'delivery-orders': [
      ['หน้าแรก (50)', '/v1/delivery-orders?limit=50'],
      ['ล่าสุดก่อน (10)', '/v1/delivery-orders?limit=10&sort=-updatedAt'],
      ['cursor ลึก (แถวที่ 9,000)', `/v1/delivery-orders?limit=50&${deep}`],
      ['กรองสถานะ', '/v1/delivery-orders?limit=50&status=BILLED'],
      ['กรองลูกค้า', `/v1/delivery-orders?limit=50&customerId=${cus}`],
      ['กรองช่วงวันที่', '/v1/delivery-orders?limit=50&dateFrom=2026-10-01&dateTo=2026-10-31'],
      ['หน้าใหญ่สุด (200)', '/v1/delivery-orders?limit=200'],
      ['สรุปจำนวนต่อสถานะ', '/v1/delivery-orders/summary'],
    ],
    trips: [
      ['หน้าแรก (50)', '/v1/trips?limit=50'],
      ['ล่าสุดก่อน (10)', '/v1/trips?limit=10&sort=-updatedAt'],
      ['cursor ลึก (แถวที่ 9,000)', `/v1/trips?limit=50&${deep}`],
      ['กรองสถานะ', '/v1/trips?limit=50&status=COMPLETED'],
      ['กรองช่วงวันที่ (7 วัน)', '/v1/trips?limit=50&dateFrom=2026-10-01&dateTo=2026-10-07'],
      ['กรองรถ', `/v1/trips?limit=50&vehicleId=${s.vehicles[5]}`],
      ['หน้าใหญ่สุด (200)', '/v1/trips?limit=200'],
      ['สรุปจำนวนต่อสถานะ', '/v1/trips/summary'],
    ],
    invoices: [
      ['หน้าแรก (50)', '/v1/invoices?limit=50'],
      ['ล่าสุดก่อน (10)', '/v1/invoices?limit=10&sort=-updatedAt'],
      ['cursor ลึก (แถวที่ 9,000)', `/v1/invoices?limit=50&${deep}`],
      ['กรองสถานะ', '/v1/invoices?limit=50&status=ISSUED'],
      ['เกินกำหนด', '/v1/invoices?limit=50&receivable=overdue'],
      ['กรองลูกค้า', `/v1/invoices?limit=50&customerId=${cus}`],
      ['หน้าใหญ่สุด (200)', '/v1/invoices?limit=200'],
      ['สรุปจำนวนต่อสถานะ', '/v1/invoices/summary'],
    ],
    'invoices/queue': [
      ['คิวพร้อมวางบิล หน้าแรก (50)', '/v1/invoices/queue?limit=50'],
      ['คิว: ส่งบัญชีแล้ว', '/v1/invoices/queue?limit=50&released=true'],
      ['คิว: กรองลูกค้า (450 DO)', `/v1/invoices/queue?limit=50&customerId=${s.customers.run[0]}`],
    ],
    search: [['ค้นหา ⌘K', '/v1/search?q=SO-P-0042']],
  };
  const out: Record<string, unknown[]> = {};
  for (const [g, variants] of Object.entries(groups)) {
    out[g] = [];
    for (const [label, path] of variants) {
      let r: Awaited<ReturnType<typeof sample>>;
      try {
        r = await sample(call, path, 20);
      } catch (e) {
        // ตัวแปรเดียวล้ม (เช่น 4xx/5xx) ไม่หยุดทั้งส่วน — รายงานเป็นไม่ผ่าน
        out[g].push({ label, path, error: (e as Error).message.slice(0, 300) });
        rows.push({
          item: `รายการ ${g}`,
          detail: label,
          value: (e as Error).message.slice(0, 160),
          target: '',
          pass: false,
        });
        continue;
      }
      out[g].push({ label, ...r });
      rows.push({
        item: `รายการ ${g}`,
        detail: label,
        value: `p50 ${ms(r.p50)} · p95 ${ms(r.p95)} · max ${ms(r.max)} (${r.rows} แถว, ${Math.round(r.bytes / 1024)} KB)`,
        target: `< ${TARGET.listMs} ms (ตาราง) · p95 < ${TARGET.apiP95Ms} ms (API)`,
        pass: r.max < TARGET.listMs && r.p95 < TARGET.apiP95Ms,
      });
    }
  }
  // ไล่ครบ 10,000 แถวด้วย cursor (หน้าละ 200 = 50 คำขอ) — ตีความ "ตาราง 10,000 แถว" แบบโหลดทั้งหมด
  const scans: unknown[] = [];
  for (const res of ['orders', 'delivery-orders', 'trips', 'invoices']) {
    let cursor: string | null = null;
    let total = 0;
    let server = 0;
    const pages: number[] = [];
    const started = performance.now();
    do {
      const begin = performance.now();
      const r: Awaited<ReturnType<Call>> = await call(
        'GET',
        `/v1/${res}?limit=200${cursor ? `&cursor=${cursor}` : ''}`,
      );
      if (r.status === 429) {
        rateLimited++;
        await sleep(1000);
        continue;
      }
      ok(r, 200, `scan ${res}`);
      total += r.body.data.length;
      server += r.ms;
      pages.push(r.ms);
      cursor = r.body.nextCursor;
      await sleep(Math.max(0, PACE_MS - (performance.now() - begin)));
    } while (cursor);
    const wall = performance.now() - started;
    scans.push({
      resource: res,
      rows: total,
      requests: pages.length,
      sumMs: Math.round(server),
      wallMs: Math.round(wall),
      page: stats(pages),
    });
    rows.push({
      item: `ไล่ครบทุกแถว ${res}`,
      detail: `${total.toLocaleString()} แถว · ${pages.length} คำขอ (หน้าละ 200)`,
      value: `รวมเวลาคำขอ ${ms(server)} · หน้าช้าสุด ${ms(Math.max(...pages))}`,
      target: '(ข้อมูลประกอบ — เป้า 2 วิ เป็นของการเปิดตารางทีละหน้าแบบ cursor)',
      pass: null,
    });
  }
  result.lists = { groups: out, scans };
}

/** สุ่มแบบกำหนดผลได้ (LCG) — ลำดับคำขอเดิมทุกครั้ง */
function lcg(seed: number) {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0), x / 2 ** 32);
}

async function mixed(tokens: string[], s: PerfState) {
  const calls = tokens.map((t) => client(t));
  const first = async (path: string) =>
    (ok(await calls[0]!('GET', path), 200, path).body.data as { id: string }[]).map((x) => x.id);
  const idsOf = async (res: string) => [
    ...(await first(`/v1/${res}?limit=50&sort=-updatedAt`)),
    ...(await first(`/v1/${res}?limit=50&cursor=${cursorAt(5000)}`)),
  ];
  const ids = {
    orders: await idsOf('orders'),
    'delivery-orders': await idsOf('delivery-orders'),
    trips: await idsOf('trips'),
    invoices: await idsOf('invoices'),
  };
  const cus = s.customers.hist;
  type Pick = (r: () => number) => [group: string, path: string];
  const any = <T>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const mix: [number, Pick][] = [
    [8, () => ['list', '/v1/orders?limit=10&sort=-updatedAt']],
    [8, () => ['list', '/v1/delivery-orders?limit=50&sort=-updatedAt']],
    [7, () => ['list', '/v1/trips?limit=50&sort=-updatedAt']],
    [7, () => ['list', '/v1/invoices?limit=50&sort=-updatedAt']],
    [
      5,
      (r) => [
        'list+filter',
        `/v1/orders?limit=50&status=${any(r, ['planned', 'in_transit', 'delivered'])}`,
      ],
    ],
    [5, (r) => ['list+filter', `/v1/delivery-orders?limit=50&customerId=${any(r, cus)}`]],
    [
      5,
      (r) => [
        'list+filter',
        `/v1/trips?limit=50&dateFrom=2026-10-0${1 + Math.floor(r() * 9)}&dateTo=2026-10-2${Math.floor(r() * 9)}`,
      ],
    ],
    [
      5,
      (r) => ['list+filter', `/v1/invoices?limit=50&status=${any(r, ['ISSUED', 'PAID', 'DRAFT'])}`],
    ],
    [3, () => ['list+filter', '/v1/invoices?limit=50&receivable=overdue']],
    [3, () => ['queue', '/v1/invoices/queue?limit=50&released=true']],
    [10, (r) => ['detail', `/v1/orders/${any(r, ids.orders)}`]],
    [9, (r) => ['detail', `/v1/delivery-orders/${any(r, ids['delivery-orders'])}`]],
    [8, (r) => ['detail', `/v1/trips/${any(r, ids.trips)}`]],
    [8, (r) => ['detail', `/v1/invoices/${any(r, ids.invoices)}`]],
    [2, () => ['summary', '/v1/orders/summary']],
    [2, () => ['summary', '/v1/invoices/summary']],
    [2, () => ['master', '/v1/customers?limit=50']],
    [1, () => ['master', '/v1/vehicles?limit=50']],
    [1, () => ['master', '/v1/me']],
    [
      1,
      (r) => [
        'search',
        `/v1/search?q=${any(r, ['SO-P-00', 'DO-P-0091', 'INV-P-004', 'ประวัติ 7'])}`,
      ],
    ],
  ];
  const totalW = mix.reduce((a, [w]) => a + w, 0);
  const DURATION = 40_000;
  const byGroup = new Map<string, number[]>();
  const all: number[] = [];
  let errors = 0;
  let limited = 0;
  const started = performance.now();
  await Promise.all(
    calls.map(async (call, u) => {
      const rnd = lcg(1000 + u);
      while (performance.now() - started < DURATION) {
        let x = rnd() * totalW;
        const pick = mix.find(([w]) => (x -= w) < 0)![1];
        const [group, path] = pick(rnd);
        const begin = performance.now();
        const r = await call('GET', encodeURI(path));
        if (r.status === 429) limited++;
        else if (r.status !== 200) {
          errors++;
          if (errors <= 3) console.warn(`  mixed: HTTP ${r.status} ${path}`);
        } else {
          all.push(r.ms);
          byGroup.set(group, [...(byGroup.get(group) ?? []), r.ms]);
        }
        await sleep(Math.max(0, PACE_MS - (performance.now() - begin)));
      }
    }),
  );
  const wall = performance.now() - started;
  const overall = stats(all);
  const groups = Object.fromEntries([...byGroup].map(([g, xs]) => [g, stats(xs)]));
  result.mixed = {
    users: calls.length,
    durationMs: Math.round(wall),
    requests: all.length,
    rps: Math.round((all.length / wall) * 10_000) / 10,
    errors,
    rateLimited: limited,
    overall,
    groups,
  };
  rows.push({
    item: 'API p95 (งานอ่านผสม)',
    detail: `${all.length} คำขอ · ${calls.length} ผู้ใช้ · ${(all.length / (wall / 1000)).toFixed(0)} คำขอ/วิ · ผิดพลาด ${errors} · 429 ${limited}`,
    value: `p50 ${ms(overall.p50)} · p95 ${ms(overall.p95)} · p99 ${ms(overall.p99)} · max ${ms(overall.max)}`,
    target: `p95 < ${TARGET.apiP95Ms} ms`,
    pass: overall.p95 < TARGET.apiP95Ms && errors === 0,
  });
  for (const [g, st] of Object.entries(groups) as [string, Stats][])
    rows.push({
      item: 'API p95 (งานอ่านผสม)',
      detail: `กลุ่ม ${g} (${st.n})`,
      value: `p50 ${ms(st.p50)} · p95 ${ms(st.p95)} · max ${ms(st.max)}`,
      target: `p95 < ${TARGET.apiP95Ms} ms`,
      pass: st.p95 < TARGET.apiP95Ms,
    });
}

const HOOK_EVENTS = ['order.created', 'invoice.finalized', 'job.completed'];
async function ensureWebhook(call: Call) {
  const url = `http://127.0.0.1:${RECEIVER_PORT}/hook`;
  // 409 duplicate = สร้างไว้แล้วจากรอบก่อน (ฐานเดิม) — ใช้ต่อ
  const r = ok(
    await call('POST', '/v1/webhooks', {
      url,
      events: HOOK_EVENTS,
      description: 'ตัวรับทดสอบประสิทธิภาพ (ในเครื่อง)',
    }),
    [201, 409],
    'webhook',
  );
  if (r.status === 201) await waitHook((h) => h.type === 'webhook.verification', 10_000);
}

async function webhook(call: Call, s: PerfState, db: PrismaClient) {
  const fromResponse: number[] = [];
  const fromRequest: number[] = [];
  const fromEvent: number[] = [];
  let missed = 0;
  const N = 12;
  for (let i = 0; i < N; i++) {
    const sent = Date.now();
    const r = ok(
      await call('POST', '/v1/orders', {
        customer: { id: s.customers.hist[0] },
        requestedDate: '2026-11-25',
        vehicleTypeId: s.vehicleTypeId,
        customerRef: `PERF-WH-${Date.now()}-${i}`,
        stops: [
          { type: 'PICKUP', siteId: s.sites.origin },
          { type: 'DELIVERY', siteId: s.sites.dest },
        ],
        lines: [
          { description: 'ปูนซีเมนต์ถุง 50 กก.', qty: '5', unitId: s.unitId, weightKg: '5000' },
        ],
      }),
      201,
      'order',
    );
    const responded = Date.now();
    const id = r.body.id as string;
    const h = await waitHook((x) => x.type === 'order.created' && x.body.includes(id), 30_000);
    if (!h) {
      missed++;
      continue;
    }
    fromResponse.push(h.at - responded);
    fromRequest.push(h.at - sent);
    // เวลา event ตามนาฬิกาฐานข้อมูล (domain_event.created_at) — ต่างเครื่อง/ต่าง container อาจคลาดกับนาฬิกาเครื่องที่รับ
    const ev = await db.$queryRawUnsafe<{ created_at: Date }[]>(
      `SELECT created_at FROM domain_event WHERE type = 'order.created' ORDER BY created_at DESC LIMIT 1`,
    );
    if (ev[0]) fromEvent.push(h.at - ev[0].created_at.getTime());
    await sleep(1300 + (i % 4) * 150); // ไม่ตรงจังหวะรอบ poll 1 วิ ของ outbox ทุกครั้ง
  }
  const a = stats(fromResponse);
  result.webhook = {
    events: N,
    missed,
    fromResponseMs: a,
    fromRequestMs: stats(fromRequest),
    fromDbEventMs: stats(fromEvent),
  };
  rows.push({
    item: 'Webhook: event → ถึงผู้รับ',
    detail: `order.created ${N} ครั้ง (ไม่ถึงใน 30 วิ: ${missed}) — นับจาก API ตอบ 201`,
    value: `p50 ${ms(a.p50)} · p95 ${ms(a.p95)} · max ${ms(a.max)}`,
    target: `< ${TARGET.webhookMs} ms`,
    pass: missed === 0 && a.max < TARGET.webhookMs,
  });
}

/** DO ที่ส่งบัญชีแล้วพร้อมวางบิลของลูกค้า (id) — จากคิวจริง */
async function readyDos(call: Call, customerId: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = null;
  do {
    const r: Awaited<ReturnType<Call>> = ok(
      await call(
        'GET',
        `/v1/invoices/queue?limit=200&released=true&fields=id&customerId=${customerId}${cursor ? `&cursor=${cursor}` : ''}`,
      ),
      200,
      'queue',
    );
    out.push(...(r.body.data as { id: string }[]).map((d) => d.id));
    cursor = r.body.nextCursor;
  } while (cursor);
  return out;
}

async function finalizeOne(
  label: string,
  size: number,
  customerId: string,
  preparer: Call,
  finalizer: Call,
  db: PrismaClient,
) {
  const dos = await readyDos(preparer, customerId);
  if (dos.length < size)
    throw new Error(`finalize ${label}: DO พร้อมวางบิล ${dos.length} < ${size} — seed ใหม่ก่อน`);
  const pick = dos.slice(0, size);
  // เพดาน 200 DO ต่อคำขอ → ใบ 500 DO = สร้าง 200 + เพิ่ม 200 + เพิ่ม 100
  const steps: { step: string; dos: number; ms: number }[] = [];
  let r = ok(
    await preparer('POST', '/v1/invoices', { customerId, deliveryOrderIds: pick.slice(0, 200) }),
    201,
    'draft',
  );
  steps.push({ step: 'POST /invoices', dos: Math.min(200, size), ms: Math.round(r.ms) });
  const id = r.body.id as string;
  for (let i = 200; i < size; i += 200) {
    const part = pick.slice(i, i + 200);
    r = ok(
      await preparer(
        'POST',
        `/v1/invoices/${id}/delivery-orders`,
        { deliveryOrderIds: part },
        { 'If-Match': `"${r.body.version}"` },
      ),
      [200, 201],
      'add DOs',
    );
    steps.push({
      step: 'POST /invoices/{id}/delivery-orders',
      dos: part.length,
      ms: Math.round(r.ms),
    });
  }
  const gets: number[] = [];
  let version = r.body.version as number;
  let lines = 0;
  for (let i = 0; i < 5; i++) {
    const g = ok(await preparer('GET', `/v1/invoices/${id}`), 200, 'get draft');
    gets.push(g.ms);
    version = g.body.version;
    lines = g.body.lines.length;
    await sleep(PACE_MS);
  }
  const before = hooks.length;
  const requested = Date.now();
  const f = await finalizer('POST', `/v1/invoices/${id}/finalize`, undefined, {
    'If-Match': `"${version}"`,
  });
  const responded = Date.now();
  const okFinal = f.status === 200;
  const out: Record<string, unknown> = {
    deliveryOrders: size,
    lines,
    draftSteps: steps,
    draftTotalMs: steps.reduce((a, x) => a + x.ms, 0),
    getDraft: stats(gets),
    finalizeMs: Math.round(f.ms),
    finalizeStatus: f.status,
  };
  if (!okFinal) out.finalizeError = f.body;
  else {
    out.invoiceNo = f.body.invoiceNo;
    out.pdfInResponse = !!f.body.pdf;
    const hook = await waitHook(
      (h) => hooks.indexOf(h) >= before && h.type === 'invoice.finalized' && h.body.includes(id),
      30_000,
    );
    if (hook) out.webhookAfterResponseMs = hook.at - responded;
    // แยกเวลา: ขั้นออกเลข (transaction) กับ render + เก็บ PDF ต้นฉบับ (หลัง commit ในคำขอเดียวกัน)
    const t = await db
      .$queryRawUnsafe<{ issued_at: Date; pdf_at: Date | null; pdf_bytes: number | null }[]>(
        `SELECT i.issued_at, d.created_at AS pdf_at, d.size_bytes::int AS pdf_bytes
         FROM invoice i LEFT JOIN stored_document d ON d.id = i.pdf_document_id
        WHERE i.invoice_no = $1`,
        f.body.invoiceNo,
      )
      .catch(() => []);
    if (t[0]?.pdf_at) {
      out.requestToIssuedAtMs = t[0].issued_at.getTime() - requested;
      out.issuedAtToPdfStoredMs = t[0].pdf_at.getTime() - t[0].issued_at.getTime();
      out.pdfBytes = t[0].pdf_bytes;
    }
    // งานเบื้องหลัง render สำเนา (worker) — เวลา render PDF ของใบขนาดนี้ 1 ฉบับโดยไม่ปนขั้นออกเลข
    for (let i = 0; i < 120; i++) {
      const j = await db
        .$queryRawUnsafe<{ status: string; ms: number | null }[]>(
          `SELECT status::text, (extract(epoch FROM (finished_at - started_at)) * 1000)::int AS ms
           FROM job WHERE type = 'invoice.render_pdf' AND payload->>'invoiceId' = (SELECT id::text FROM invoice WHERE invoice_no = $1)
          ORDER BY created_at DESC LIMIT 1`,
          f.body.invoiceNo,
        )
        .catch(() => []);
      if (j[0] && !['PENDING', 'RUNNING'].includes(j[0].status)) {
        out.copyPdfJob = j[0];
        break;
      }
      await sleep(500);
    }
    const pdf = await finalizer('GET', `/v1/invoices/${id}/pdf`);
    out.downloadPdf = { status: pdf.status, ms: Math.round(pdf.ms), bytes: pdf.bytes };
  }
  rows.push({
    item: `Finalize ใบแจ้งหนี้ ${size} DO`,
    detail: `${lines} บรรทัด · HTTP ${f.status}${okFinal ? ` · ${f.body.invoiceNo} · PDF ในคำตอบ: ${f.body.pdf ? 'มี' : 'ไม่มี (รอ job)'}` : ''}`,
    value: `${ms(f.ms)} (รวม render PDF ต้นฉบับ)${out.issuedAtToPdfStoredMs !== undefined ? ` · ออกเลข→PDF เก็บ ${ms(out.issuedAtToPdfStoredMs as number)}` : ''}`,
    target: `< ${TARGET.finalizeMs} ms`,
    pass: okFinal && f.ms < TARGET.finalizeMs,
  });
  rows.push({
    item: `ร่างใบแจ้งหนี้ ${size} DO`,
    detail: steps
      .map((x) => `${x.step.replace('POST ', '')} ${x.dos} DO = ${ms(x.ms)}`)
      .join(' · '),
    value: `รวม ${ms(out.draftTotalMs as number)} · GET ร่าง p50 ${ms(stats(gets).p50)}`,
    target: '(ไม่มีเป้าเฉพาะ — API เขียน p95 ≤ 500 ms ใน spec/11 [PROPOSED])',
    pass: null,
  });
  return out;
}

async function invoiceRun(
  label: string,
  body: Record<string, unknown>,
  expectDos: number,
  call: Call,
  db: PrismaClient,
) {
  const before = hooks.length;
  const started = performance.now();
  const r = ok(await call('POST', '/v1/invoice-runs', body), 202, 'invoice run');
  const jobId = r.body.jobId as string;
  let job: any;
  for (;;) {
    await sleep(500);
    const g = await call('GET', `/v1/jobs/${jobId}`);
    if (g.status === 429) continue;
    job = ok(g, 200, 'job').body;
    if (!['pending', 'queued', 'running'].includes(job.status)) break;
    if (performance.now() - started > 15 * 60_000) throw new Error('invoice run เกิน 15 นาที');
  }
  const wall = performance.now() - started;
  const hook = await waitHook(
    (h) => hooks.indexOf(h) >= before && h.type === 'job.completed' && h.body.includes(jobId),
    30_000,
  );
  const t = await db
    .$queryRawUnsafe<{ wait_ms: number; run_ms: number; finished_at: Date }[]>(
      `SELECT (extract(epoch FROM (started_at - created_at)) * 1000)::int AS wait_ms,
            (extract(epoch FROM (finished_at - started_at)) * 1000)::int AS run_ms, finished_at
       FROM job WHERE type = 'invoices.run' ORDER BY created_at DESC LIMIT 1`,
    )
    .catch(() => []);
  const drafted = await db.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM delivery_order d
      WHERE d.billing_status = 'IN_DRAFT' AND d.do_date BETWEEN $1::date AND $2::date`,
    body.periodFrom,
    body.periodTo,
  );
  const res = job.result ?? {};
  const out = {
    request: body,
    status: job.status,
    wallMs: Math.round(wall),
    queueWaitMs: t[0]?.wait_ms ?? null,
    jobRunMs: t[0]?.run_ms ?? null,
    customers: res.customers,
    invoicesCreated: res.invoicesCreated,
    failed: res.failed,
    deliveryOrdersInDrafts: drafted[0]?.n ?? null,
    jobCompletedWebhookMs: hook && t[0] ? hook.at - t[0].finished_at.getTime() : null,
    problems: (res.results ?? []).filter((x: any) => x.problem).slice(0, 3),
  };
  rows.push({
    item: `Invoice run ${expectDos.toLocaleString()} DO`,
    detail: `${label} · สถานะ ${job.status} · ${res.customers ?? '?'} ลูกค้า · ${res.invoicesCreated ?? '?'} ร่าง · DO เข้าร่าง ${out.deliveryOrdersInDrafts} · ล้ม ${res.failed ?? '?'}`,
    value: `${ms(wall)} (รอคิว ${ms(out.queueWaitMs ?? 0)} + ทำงาน ${ms(out.jobRunMs ?? 0)})`,
    target: `< ${TARGET.invoiceRunMs / 1000} วิ`,
    pass:
      job.status === 'succeeded' &&
      out.deliveryOrdersInDrafts === expectDos &&
      wall < TARGET.invoiceRunMs,
  });
  return out;
}

async function main() {
  const dbName = assertPerfDb();
  const s = readState();
  const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  const { signDevToken } = require('../../src/auth/auth.guard');
  const token = (sub: string) => signDevToken({ sub, tid: s.tenantId }, '3h') as Promise<string>;
  const preparerToken = await token('perf-preparer');
  const preparer = client(preparerToken);
  const finalizer = client(await token('perf-finalizer'));

  const pg = await db.$queryRawUnsafe<{ v: string }[]>('SELECT version() AS v');
  const meta = {
    task: 'ST9-T17',
    startedAt: new Date().toISOString(),
    seededAt: s.seededAt,
    database: dbName,
    machine: {
      cpu: cpus()[0]?.model,
      cores: cpus().length,
      memoryGb: Math.round(totalmem() / 2 ** 30),
      os: `${platform()} ${release()} ${arch()}`,
      node: process.version,
      postgres: pg[0]?.v.split(' on ')[0],
    },
    volume: VOLUME,
    rateLimit: process.env.RATE_LIMIT ?? 'on (ค่าเริ่ม)',
    maxLoad: MAX_LOAD,
    forced: FORCE,
    loadAtStart: load(),
    sections: {} as Record<string, { loadBefore: number[]; loadAfter: number[]; seconds: number }>,
  };
  result.meta = meta;

  const closeReceiver = await startReceiver();
  log(`เปิด API :${API_PORT} + worker (ฐาน ${dbName}) · ตัวรับ webhook :${RECEIVER_PORT}`);
  start('api', 'src/main.ts');
  start('worker', 'src/worker.ts');
  await waitApi();
  await sleep(1500);

  const section = async (name: Section, fn: () => Promise<void>) => {
    if (!ONLY.includes(name)) return;
    const loadBefore = await waitQuiet(MAX_LOAD, FORCE, name);
    log(`▶ ${name} (load ${loadBefore.join(' ')})`);
    const begin = Date.now();
    try {
      await fn();
    } catch (e) {
      console.error(`  ✘ ${name}: ${(e as Error).message}`);
      rows.push({
        item: name,
        detail: 'วัดไม่สำเร็จ',
        value: (e as Error).message.slice(0, 300),
        target: '',
        pass: false,
      });
      (result as any)[`${name}Error`] = (e as Error).message;
    }
    meta.sections[name] = {
      loadBefore,
      loadAfter: load(),
      seconds: Math.round((Date.now() - begin) / 1000),
    };
  };

  try {
    await ensureWebhook(preparer);
    await section('lists', () => lists(preparer, s));
    await section('mixed', async () =>
      mixed([preparerToken, await token('perf-user-2'), await token('perf-user-3')], s),
    );
    await section('webhook', () => webhook(preparer, s, db));
    await section('finalize', async () => {
      if (s.consumed.finalize)
        throw new Error(`ข้อมูล finalize ถูกใช้แล้ว (${s.consumed.finalize}) — seed ใหม่`);
      s.consumed.finalize = new Date().toISOString();
      writeState(s);
      result.finalize = {
        do500: await finalizeOne('500', 500, s.customers.big500, preparer, finalizer, db),
        do200: await finalizeOne('200', 200, s.customers.big200, preparer, finalizer, db),
      };
    });
    await section('run', async () => {
      if (s.consumed.run)
        throw new Error(`ข้อมูล invoice run ถูกใช้แล้ว (${s.consumed.run}) — seed ใหม่`);
      s.consumed.run = new Date().toISOString();
      writeState(s);
      const a = await invoiceRun(
        'DO ส่งบัญชีแล้ว',
        {
          billingCycle: 'MONTHLY',
          periodFrom: VOLUME.runA.periodFrom,
          periodTo: VOLUME.runA.periodTo,
        },
        VOLUME.runA.to - VOLUME.runA.from + 1,
        preparer,
        db,
      );
      const b = await invoiceRun(
        'ส่งบัญชีในรอบ (releaseDeliveryOrders)',
        {
          billingCycle: 'MONTHLY',
          periodFrom: VOLUME.runB.periodFrom,
          periodTo: VOLUME.runB.periodTo,
          releaseDeliveryOrders: true,
        },
        VOLUME.runB.to - VOLUME.runB.from + 1,
        preparer,
        db,
      );
      result.invoiceRun = { released: a, releaseInRun: b };
    });
    await section('web', async () => {
      const w = await web(children);
      result.web = w;
      for (const p of w.pages as any[])
        rows.push({
          item: `เว็บ: ตาราง ${p.label} (${p.path})`,
          detail: `${p.rowsShown} แถวบนจอ · ${w.mode} · ${w.viewport}`,
          value: `โหลดเต็มหน้า p50 ${ms(p.fullLoad.p50)} · max ${ms(p.fullLoad.max)}${p.inApp ? ` · เปลี่ยนหน้าในแอป p50 ${ms(p.inApp.p50)} · max ${ms(p.inApp.max)}` : ''}`,
          target: `< ${TARGET.listMs} ms`,
          pass: p.fullLoad.max < TARGET.listMs,
        });
    });
  } finally {
    stopAll();
    closeReceiver();
  }
  (meta as any).loadAtEnd = load();
  (meta as any).rateLimited429 = rateLimited;
  (meta as any).finishedAt = new Date().toISOString();
  result.summary = rows;

  const file = flag('out')
    ? resolve(process.cwd(), flag('out')!)
    : resolve(PERF_DIR, `result-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));

  console.log('\n| รายการ | รายละเอียด | ผล | เป้า | ผ่าน |\n|---|---|---|---|---|');
  for (const r of rows)
    console.log(
      `| ${r.item} | ${r.detail} | ${r.value} | ${r.target} | ${r.pass === null ? '–' : r.pass ? '✔' : '✘'} |`,
    );
  console.log(
    `\nเครื่อง: ${meta.machine.cpu} × ${meta.machine.cores} · ${meta.machine.memoryGb} GB · load เริ่ม ${meta.loadAtStart.join(' ')} จบ ${load().join(' ')}`,
  );
  console.log(`ผลฉบับเต็ม: ${file}`);
  await db.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => (stopAll(), process.exit(130)));
process.on('SIGTERM', () => (stopAll(), process.exit(143)));
main().catch((e) => {
  stopAll();
  console.error(e);
  process.exit(1);
});
