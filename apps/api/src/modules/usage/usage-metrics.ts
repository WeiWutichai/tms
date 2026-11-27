import { Prisma } from '@prisma/client';
import type { Month } from '../depreciation/depreciation-policy';
import { periodRange } from './active-vehicles';

/**
 * เมตริกการใช้งานอื่นนอกจากรถ active (P1-ST1-T07; docs/02 §5 Usage & Billing · spec/01 §7 `UsageDaily` · plan/13 R-17)
 *
 * - ตาราง `usage_daily` (วันปฏิทินเวลาไทย) → ปิดยอดเดือนลง `usage_record` พร้อมรถ active (UsageFinalizeService)
 * - เมตริกสะสม (FLOW): ยอดเดือน = ผลรวมรายวัน (เกณฑ์ตรวจรับ "ยอดรายวันรวม = ยอดรายเดือน")
 *   - `do.created` DO ที่สร้างในวัน ไม่รวมที่ยกเลิก [DECISION — lead 28 พ.ย. 2569, ย้อนได้]
 *   - `invoices.issued` ใบแจ้งหนี้ที่ออกเลขในวัน (issued_at — ยกเลิกภายหลังยังนับ เพราะออกเอกสารไปแล้ว)
 *   - `api.calls` แยก source `rest` / `mcp` — นับคำขอของ API key / OAuth client ที่ตอบ < 500 และไม่ใช่ 429 (ApiUsageMeter)
 *     UI ของเราเองไม่นับ (เรียก /v1 ชุดเดียวกันแต่ไม่ใช่ "API calls" ของลูกค้า) · MCP ยังไม่มีในเฟส 1 = 0
 * - เมตริกค่า ณ วัน (GAUGE): ยอดเดือน = ค่าของวันล่าสุดที่มีในเดือน
 *   - `storage.pod_gb` ขนาดไฟล์ที่ลูกค้าอัปโหลด (POD + เอกสารแนบ, READY, ไม่รวม PDF/ไฟล์ส่งออกที่ระบบสร้าง) หน่วย GB (1024³) ทศนิยม 2
 *   - `connectors.accounting` connector สถานะ ACTIVE · `users.active` ผู้ใช้สถานะ ACTIVE
 * - e-Tax: ไม่มีในเฟส 1 (R-17) → API คืน null ให้ UI แสดง "—" (ไม่มีแถว)
 * - sandbox (tenant.mode = test) ไม่มีแถว · เดือนที่ปิดยอดแล้ว (มี usage_record) ไม่ถูกแตะ
 */
export const USAGE_METRIC = {
  doCreated: 'do.created',
  invoicesIssued: 'invoices.issued',
  apiCalls: 'api.calls',
  podStorage: 'storage.pod_gb',
  connectors: 'connectors.accounting',
  users: 'users.active',
} as const;

export const FLOW_METRICS = [
  USAGE_METRIC.doCreated,
  USAGE_METRIC.invoicesIssued,
  USAGE_METRIC.apiCalls,
] as const;
export const GAUGE_METRICS = [
  USAGE_METRIC.podStorage,
  USAGE_METRIC.connectors,
  USAGE_METRIC.users,
] as const;
/** เมตริกสะสมที่ rollup คำนวณใหม่จากตารางต้นทาง (api.calls มาจากตัวนับ — ไม่คำนวณใหม่) */
const RECOMPUTED = [USAGE_METRIC.doCreated, USAGE_METRIC.invoicesIssued];

export const API_SOURCES = ['rest', 'mcp'] as const;
export type ApiSource = (typeof API_SOURCES)[number];

type Db = Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>;

/** วันเวลาไทยของ `at` (YYYY-MM-DD) */
export function bangkokDate(at: Date): string {
  return new Date(at.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

/** เดือนที่ปิดยอดแล้ว — วัน `dcol` ของ tenant `tcol` อยู่ในเดือนที่มี usage_record */
const notFinalized = (tcol: Prisma.Sql, dcol: Prisma.Sql) => Prisma.sql`NOT EXISTS (
  SELECT 1 FROM usage_record r WHERE r.tenant_id = ${tcol} AND r.period = to_char(${dcol}, 'YYYY-MM'))`;

const bkkDay = (col: Prisma.Sql) => Prisma.sql`(${col} AT TIME ZONE 'Asia/Bangkok')::date`;

/**
 * คำนวณเมตริกสะสมที่มาจากตารางต้นทาง (DO / ใบแจ้งหนี้) ใหม่ในช่วง [from, to) — ลบแถวเดิมแล้วเขียนใหม่ (วันที่ยอดกลับเป็น 0 ไม่ค้าง)
 * ไม่ระบุ tenant = ทุก tenant live (rollup ของ worker) · ข้ามเดือนที่ปิดยอดแล้ว · ต้องเรียกใน transaction
 */
export async function recomputeFlows(
  db: Db,
  range: { from: Date; to: Date },
  tenantId?: string,
): Promise<void> {
  const only = (col: Prisma.Sql) =>
    tenantId ? Prisma.sql`AND ${col} = ${tenantId}::uuid` : Prisma.empty;
  const fromDay = bangkokDate(range.from);
  const toDay = bangkokDate(new Date(range.to.getTime() - 1));
  await db.$executeRaw`
    DELETE FROM usage_daily d USING tenant t
     WHERE t.id = d.tenant_id AND t.mode = 'live'
       AND d.metric IN (${Prisma.join(RECOMPUTED)})
       AND d.date BETWEEN ${fromDay}::date AND ${toDay}::date
       AND ${notFinalized(Prisma.sql`d.tenant_id`, Prisma.sql`d.date`)} ${only(Prisma.sql`d.tenant_id`)}`;
  await db.$executeRaw`
    INSERT INTO usage_daily (tenant_id, date, metric, source, value)
    SELECT x.tenant_id, ${bkkDay(Prisma.sql`x.created_at`)}, ${USAGE_METRIC.doCreated}, '', count(*)
      FROM delivery_order x JOIN tenant t ON t.id = x.tenant_id AND t.mode = 'live'
     WHERE x.created_at >= ${range.from} AND x.created_at < ${range.to} AND x.status <> 'CANCELLED'
       AND ${notFinalized(Prisma.sql`x.tenant_id`, bkkDay(Prisma.sql`x.created_at`))} ${only(Prisma.sql`x.tenant_id`)}
     GROUP BY 1, 2
    ON CONFLICT (tenant_id, date, metric, source) DO UPDATE SET value = excluded.value, updated_at = now()`;
  await db.$executeRaw`
    INSERT INTO usage_daily (tenant_id, date, metric, source, value)
    SELECT x.tenant_id, ${bkkDay(Prisma.sql`x.issued_at`)}, ${USAGE_METRIC.invoicesIssued}, '', count(*)
      FROM invoice x JOIN tenant t ON t.id = x.tenant_id AND t.mode = 'live'
     WHERE x.issued_at >= ${range.from} AND x.issued_at < ${range.to}
       AND ${notFinalized(Prisma.sql`x.tenant_id`, bkkDay(Prisma.sql`x.issued_at`))} ${only(Prisma.sql`x.tenant_id`)}
     GROUP BY 1, 2
    ON CONFLICT (tenant_id, date, metric, source) DO UPDATE SET value = excluded.value, updated_at = now()`;
}

/** ค่า ณ ตอนนี้ของเมตริกแบบ GAUGE (ต่อ tenant) — นิยามเดียวกับ snapshot รายวัน */
const gaugeSelect = (tcol: Prisma.Sql) => Prisma.sql`
  round(coalesce((SELECT sum(s.size_bytes) FROM stored_document s
                   WHERE s.tenant_id = ${tcol} AND s.status = 'READY' AND s.kind NOT IN ('PDF', 'EXPORT')), 0)
        / 1073741824.0, 2) AS pod,
  (SELECT count(*) FROM connector c WHERE c.tenant_id = ${tcol} AND c.status = 'ACTIVE') AS conn,
  (SELECT count(*) FROM app_user u WHERE u.tenant_id = ${tcol} AND u.status = 'ACTIVE') AS users`;

export interface GaugeValues {
  pod: number;
  conn: number;
  users: number;
}

export async function liveGauges(db: Db, tenantId: string): Promise<GaugeValues> {
  const [r] = await db.$queryRaw<{ pod: Prisma.Decimal; conn: bigint; users: bigint }[]>`
    SELECT ${gaugeSelect(Prisma.sql`${tenantId}::uuid`)}`;
  return { pod: Number(r!.pod), conn: Number(r!.conn), users: Number(r!.users) };
}

/** snapshot เมตริก GAUGE ของวันนี้ (เวลาไทย) ทุก tenant live — วันนี้ไม่เคยอยู่ในเดือนที่ปิดยอดแล้ว */
export async function snapshotGauges(db: Db, now: Date, tenantId?: string): Promise<void> {
  const day = bangkokDate(now);
  const only = tenantId ? Prisma.sql`AND t.id = ${tenantId}::uuid` : Prisma.empty;
  await db.$executeRaw`
    WITH g AS (SELECT t.id, ${gaugeSelect(Prisma.sql`t.id`)} FROM tenant t WHERE t.mode = 'live' ${only})
    INSERT INTO usage_daily (tenant_id, date, metric, source, value)
    SELECT g.id, ${day}::date, m.metric, '', m.value
      FROM g CROSS JOIN LATERAL (VALUES (${USAGE_METRIC.podStorage}, g.pod::numeric),
                                        (${USAGE_METRIC.connectors}, g.conn::numeric),
                                        (${USAGE_METRIC.users}, g.users::numeric)) AS m(metric, value)
     WHERE ${notFinalized(Prisma.sql`g.id`, Prisma.sql`${day}::date`)}
    ON CONFLICT (tenant_id, date, metric, source) DO UPDATE SET value = excluded.value, updated_at = now()`;
}

/**
 * rollup ของ worker (ทุก 10 นาที): เมตริกสะสมของเมื่อวาน + วันนี้ (เวลาไทย — จับ DO ที่ยกเลิกข้ามวัน) + snapshot GAUGE วันนี้
 * set-based ครั้งเดียวทุก tenant (ไม่วนต่อ tenant)
 */
export async function rollupUsageDaily(db: Db, now: Date): Promise<void> {
  const today = new Date(`${bangkokDate(now)}T00:00:00+07:00`);
  const from = new Date(today.getTime() - 24 * 3600_000);
  const to = new Date(today.getTime() + 24 * 3600_000);
  await recomputeFlows(db, { from, to });
  await snapshotGauges(db, now);
}

export interface MonthMetrics {
  doCreated: number;
  invoicesIssued: number;
  apiCalls: { total: number; rest: number; mcp: number };
  podStorageGb: number;
  connectors: number;
  users: number;
  /** วันล่าสุดที่มี snapshot ของ GAUGE (null = ยังไม่มี — ใช้ค่าสด) */
  gaugeAsOf: string | null;
}

/** รวมยอดเดือนจาก usage_daily (FLOW = ผลรวม · GAUGE = วันล่าสุด; ไม่มี snapshot → ค่าสด) */
export async function sumMonth(db: Db, tenantId: string, period: Month): Promise<MonthMetrics> {
  const { start, end } = periodRange(period);
  const from = bangkokDate(start);
  const to = bangkokDate(new Date(end.getTime() - 1));
  const flows = await db.$queryRaw<{ metric: string; source: string; value: Prisma.Decimal }[]>`
    SELECT metric, source, sum(value) AS value FROM usage_daily
     WHERE tenant_id = ${tenantId}::uuid AND date BETWEEN ${from}::date AND ${to}::date
       AND metric IN (${Prisma.join(FLOW_METRICS)})
     GROUP BY metric, source`;
  const gauges = await db.$queryRaw<{ metric: string; value: Prisma.Decimal; date: Date }[]>`
    SELECT DISTINCT ON (metric) metric, value, date FROM usage_daily
     WHERE tenant_id = ${tenantId}::uuid AND date BETWEEN ${from}::date AND ${to}::date
       AND metric IN (${Prisma.join(GAUGE_METRICS)})
     ORDER BY metric, date DESC`;
  const f = (m: string, s = '') =>
    Number(flows.find((r) => r.metric === m && (s === '*' || r.source === s))?.value ?? 0);
  const rest = f(USAGE_METRIC.apiCalls, 'rest');
  const mcp = f(USAGE_METRIC.apiCalls, 'mcp');
  const g = (m: string) => gauges.find((r) => r.metric === m);
  const live = gauges.length < GAUGE_METRICS.length ? await liveGauges(db, tenantId) : null;
  const gv = (m: string, k: keyof GaugeValues) => {
    const r = g(m);
    return r ? Number(r.value) : live![k];
  };
  const asOf = gauges.map((r) => r.date.toISOString().slice(0, 10)).sort();
  return {
    doCreated: f(USAGE_METRIC.doCreated),
    invoicesIssued: f(USAGE_METRIC.invoicesIssued),
    apiCalls: { total: rest + mcp, rest, mcp },
    podStorageGb: gv(USAGE_METRIC.podStorage, 'pod'),
    connectors: gv(USAGE_METRIC.connectors, 'conn'),
    users: gv(USAGE_METRIC.users, 'users'),
    gaugeAsOf: asOf.length ? asOf[asOf.length - 1]! : null,
  };
}

/** แถว usage_record ของเมตริกอื่น (ปิดยอด) จากยอดเดือน */
export function monthRecords(m: MonthMetrics): { metric: string; value: number; detail: object }[] {
  const gauge = { asOf: m.gaugeAsOf };
  return [
    { metric: USAGE_METRIC.doCreated, value: m.doCreated, detail: {} },
    { metric: USAGE_METRIC.invoicesIssued, value: m.invoicesIssued, detail: {} },
    {
      metric: USAGE_METRIC.apiCalls,
      value: m.apiCalls.total,
      detail: { rest: m.apiCalls.rest, mcp: m.apiCalls.mcp },
    },
    { metric: USAGE_METRIC.podStorage, value: m.podStorageGb, detail: gauge },
    { metric: USAGE_METRIC.connectors, value: m.connectors, detail: gauge },
    { metric: USAGE_METRIC.users, value: m.users, detail: gauge },
  ];
}

/** อ่านยอดเดือนที่ปิดแล้วจาก usage_record (null = ยังไม่ปิด) */
export async function readFinalizedMonth(
  db: Db,
  tenantId: string,
  period: Month,
): Promise<MonthMetrics | null> {
  const rows = await db.$queryRaw<{ metric: string; value: Prisma.Decimal; detail: unknown }[]>`
    SELECT metric, value, detail FROM usage_record
     WHERE tenant_id = ${tenantId}::uuid AND period = ${period}
       AND metric IN (${Prisma.join([...FLOW_METRICS, ...GAUGE_METRICS])})`;
  if (!rows.length) return null;
  const v = (m: string) => Number(rows.find((r) => r.metric === m)?.value ?? 0);
  const d = (m: string) =>
    (rows.find((r) => r.metric === m)?.detail ?? {}) as Record<string, unknown>;
  const api = d(USAGE_METRIC.apiCalls);
  return {
    doCreated: v(USAGE_METRIC.doCreated),
    invoicesIssued: v(USAGE_METRIC.invoicesIssued),
    apiCalls: {
      total: v(USAGE_METRIC.apiCalls),
      rest: Number(api.rest ?? 0),
      mcp: Number(api.mcp ?? 0),
    },
    podStorageGb: v(USAGE_METRIC.podStorage),
    connectors: v(USAGE_METRIC.connectors),
    users: v(USAGE_METRIC.users),
    gaugeAsOf: (d(USAGE_METRIC.podStorage).asOf as string | null) ?? null,
  };
}

export interface UsageMetricsView extends MonthMetrics {
  period: Month;
  status: 'open' | 'finalized' | 'invoiced';
  finalizedAt: string | null;
}

/**
 * ยอดของเดือนสำหรับ API (ลูกค้า / Console) — ปิดยอดแล้ว = usage_record · ยังเปิด = ผลรวม usage_daily
 * (DO/ใบแจ้งหนี้ช้าได้ ≤ 10 นาที, API calls ≤ 30 วิ) · เดือนปัจจุบันใช้ค่า GAUGE สด
 */
export async function readUsageMetrics(
  db: Db,
  tenantId: string,
  period: Month,
  currentPeriod: Month,
): Promise<UsageMetricsView> {
  const fin = await readFinalizedMonth(db, tenantId, period);
  if (fin) {
    const [r] = await db.$queryRaw<{ status: string; finalized_at: Date | null }[]>`
      SELECT status, finalized_at FROM usage_record
       WHERE tenant_id = ${tenantId}::uuid AND period = ${period} AND metric = ${USAGE_METRIC.doCreated}`;
    return {
      ...fin,
      period,
      status: (r?.status ?? 'finalized') as UsageMetricsView['status'],
      finalizedAt: r?.finalized_at?.toISOString() ?? null,
    };
  }
  const m = await sumMonth(db, tenantId, period);
  if (period === currentPeriod) {
    const g = await liveGauges(db, tenantId);
    Object.assign(m, { podStorageGb: g.pod, connectors: g.conn, users: g.users, gaugeAsOf: null });
  }
  return { ...m, period, status: 'open', finalizedAt: null };
}
