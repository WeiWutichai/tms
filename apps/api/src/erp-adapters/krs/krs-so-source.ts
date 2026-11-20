import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { safeHttpRequest, type SendOptions } from '../../modules/webhooks/webhook-http';

/**
 * ST8-T02 client อ่านแหล่ง SO ของ KRS แบบ watermark (ขั้นต่ำ — poller จริง + แปลงเป็น order = ST8-T04)
 * docs/01 A.2 `pullOrders(since)`, A.4 · plan/08 KRS-11 (ทาง B `GET /salesorder?since=`)
 *
 * - ชื่อ view/คอลัมน์/path อ่านจาก `packages/contracts/krs/salesorder-source.json` **ที่เดียว** ([OPEN — KRS] ชื่อเสนอ —
 *   เมื่อ KRS ตอบให้แก้ไฟล์นั้น ไม่ต้องแก้โค้ดนี้) · mock (`packages/mock-krs`) อ่านไฟล์เดียวกัน
 * - ตอนนี้อ่านผ่าน HTTP stub (`GET {baseUrl}{httpPath}?since=&limit=` + `X-API-Key`) — ทาง SQL read-only view
 *   (ต้องมี driver SQL Server) ทำเมื่อ KRS เลือกทาง A (spec/12 §3 แถว ST8-T02)
 * - 1 แถว = 1 รายการ → รวมเป็นใบตาม (company, soNo) คงลำดับ watermark · `cancelled` = SO ที่ยกเลิกใน KRS (แถวยังส่งมา)
 * - watermark ทึบ (สตริงตัวเลข) ไม่รวมตัวเอง — ผู้เรียกเก็บ `next` หลังรับทุกใบของหน้าแล้ว (connector_cursor)
 * - ค่าจากต้นทางไม่เชื่อ: ช่องข้อมูลส่งต่อตามที่ได้ (`unknown`) ให้ core ตรวจ · แถวที่ไม่มี company/soNo/watermark = `rejectedRows`
 * - คอลัมน์ที่ mapping บังคับหายจากแถว = `source_columns_missing` (ST8-T04 → SO ค้าง SOURCE_ERROR + connector ERROR)
 * - ไม่โยน error (คืน `ok: false` + errorClass เหมือน healthCheck) · ข้อความไม่มี key
 */

export type KrsSoField =
  | 'company'
  | 'soNo'
  | 'soDate'
  | 'customerCode'
  | 'customerName'
  | 'customerPo'
  | 'deliveryDate'
  | 'vehicleType'
  | 'originCode'
  | 'originName'
  | 'destinationCode'
  | 'destinationName'
  | 'remark'
  | 'lineNo'
  | 'itemCode'
  | 'itemName'
  | 'qty'
  | 'unit'
  | 'cancelled'
  | 'updatedAt'
  | 'rowVersion';

export interface KrsSoMapping {
  status: string;
  view: string;
  httpPath: string;
  grain: 'line';
  watermark: KrsSoField;
  timezone: string;
  columns: Record<KrsSoField, { column: string; type: string; required: boolean }>;
}

let cached: KrsSoMapping | null = null;

/** ไฟล์ mapping ที่เดียว (packages/contracts/krs/salesorder-source.json) */
export function loadKrsSoMapping(): KrsSoMapping {
  if (cached) return cached;
  const dir = join(dirname(require.resolve('@tms/contracts/package.json')), 'krs');
  cached = JSON.parse(readFileSync(join(dir, 'salesorder-source.json'), 'utf8')) as KrsSoMapping;
  return cached;
}

export interface KrsSalesOrderLine {
  lineNo: unknown;
  itemCode: unknown;
  itemName: unknown;
  /** สตริงทศนิยมตามต้นทาง (ตัวเลข JS แปลงเป็นสตริง — ไม่คำนวณด้วย float) */
  qty: unknown;
  unit: unknown;
}

export interface KrsSalesOrder {
  company: string;
  soNo: string;
  soDate: unknown;
  customerCode: unknown;
  customerName: unknown;
  customerPo: unknown;
  deliveryDate: unknown;
  vehicleType: unknown;
  originCode: unknown;
  originName: unknown;
  destinationCode: unknown;
  destinationName: unknown;
  remark: unknown;
  /** KRS ยกเลิก SO แล้ว (bit 1) */
  cancelled: boolean;
  /** ISO 8601 พร้อม offset ตาม mapping.timezone (Asia/Bangkok = +07:00) · อ่านไม่ได้ = null */
  updatedAt: string | null;
  /** watermark ของใบ */
  rowVersion: string;
  lines: KrsSalesOrderLine[];
  /** แถวดิบทุกแถวของใบ (docs/01 A.4 เก็บใน `sales_order.raw_payload`) */
  raw: Array<Record<string, unknown>>;
}

export type KrsSoReadResult =
  | {
      ok: true;
      orders: KrsSalesOrder[];
      /** watermark ถัดไป (ไม่มีแถว = since เดิม) */
      next: string | null;
      hasMore: boolean;
      /** แถวที่ไม่มี company/soNo/watermark — ไม่รวมเป็นใบ */
      rejectedRows: Array<Record<string, unknown>>;
    }
  | {
      ok: false;
      errorClass: 'AUTH' | 'TRANSIENT' | 'VALIDATION';
      problem: { code: string; message: string };
      /** ชื่อคอลัมน์จริงที่หาย (code `source_columns_missing`) */
      missingColumns?: string[];
    };

export const KRS_SO_TIMEOUT_MS = 30_000;
export const KRS_SO_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const WATERMARK_RE = /^\d{1,19}$/;

export async function readKrsSalesOrders(
  config: { baseUrl?: string; apiKey?: string },
  since: string | null,
  limit: number,
  opts: Pick<SendOptions, 'allowPrivate' | 'resolver' | 'signal'> & { mapping?: KrsSoMapping } = {},
): Promise<KrsSoReadResult> {
  const mapping = opts.mapping ?? loadKrsSoMapping();
  const base = (config.baseUrl ?? '').trim().replace(/\/+$/, '');
  const key = config.apiKey ?? '';
  if (!base) return fail('VALIDATION', 'config_missing', 'baseUrl is not set');
  if (!key) return fail('AUTH', 'credentials_missing', 'apiKey is not set');
  if (since !== null && !WATERMARK_RE.test(since))
    return fail('VALIDATION', 'invalid_watermark', 'since must be a numeric watermark');
  const q = new URLSearchParams({ since: since ?? '', limit: String(limit) });
  const r = await safeHttpRequest(
    'GET',
    `${base}${mapping.httpPath}?${q.toString()}`,
    { 'X-API-Key': key, Accept: 'application/json' },
    '',
    {
      timeoutMs: KRS_SO_TIMEOUT_MS,
      maxResponseBytes: KRS_SO_MAX_RESPONSE_BYTES,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.allowPrivate !== undefined ? { allowPrivate: opts.allowPrivate } : {}),
      ...(opts.resolver ? { resolver: opts.resolver } : {}),
    },
  );
  if (r.status === null) {
    if (r.errorCode === 'timeout' || r.errorCode === 'network' || r.errorCode === 'aborted')
      return fail(
        'TRANSIENT',
        r.errorCode === 'timeout' ? 'timeout' : 'unreachable',
        r.errorMessage ?? '',
      );
    return fail('VALIDATION', r.errorCode ?? 'invalid_request', r.errorMessage ?? '');
  }
  if (r.status === 401 || r.status === 403)
    return fail('AUTH', 'unauthorized', `KRS rejected the API key (HTTP ${r.status})`);
  if (r.status === 429 || r.status >= 500)
    return fail('TRANSIENT', `http_${r.status}`, `KRS answered HTTP ${r.status}`);
  if (r.status === 404)
    return fail('VALIDATION', 'source_not_found', `sales order source ${mapping.view} not found`);
  if (r.status !== 200)
    return fail('VALIDATION', `http_${r.status}`, `unexpected HTTP ${r.status}`);

  let body: { rows?: unknown; next?: unknown; hasMore?: unknown };
  try {
    body = JSON.parse(r.body) as typeof body;
  } catch {
    return fail('VALIDATION', 'invalid_response', 'response is not JSON');
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.rows))
    return fail('VALIDATION', 'invalid_response', 'response has no rows[]');
  const rows = body.rows.filter(
    (x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x),
  );

  const c = mapping.columns;
  const required = (Object.keys(c) as KrsSoField[]).filter((f) => c[f].required);
  const missing = new Set<string>();
  for (const row of rows)
    for (const f of required) if (!(c[f].column in row)) missing.add(c[f].column);
  if (missing.size)
    return {
      ...fail(
        'VALIDATION',
        'source_columns_missing',
        `columns missing in ${mapping.view}: ${[...missing].join(', ')}`,
      ),
      missingColumns: [...missing],
    };

  const v = (row: Record<string, unknown>, f: KrsSoField): unknown => row[c[f].column] ?? null;
  const orders: KrsSalesOrder[] = [];
  const byKey = new Map<string, KrsSalesOrder>();
  const rejectedRows: Array<Record<string, unknown>> = [];
  let maxWm: string | null = null;
  for (const row of rows) {
    const company = text(v(row, 'company'));
    const soNo = text(v(row, 'soNo'));
    const wm = text(v(row, mapping.watermark));
    if (!company || !soNo || !wm || !WATERMARK_RE.test(wm)) {
      rejectedRows.push(row);
      continue;
    }
    if (maxWm === null || BigInt(wm) > BigInt(maxWm)) maxWm = wm;
    const k = `${company}\u0000${soNo}`;
    let so = byKey.get(k);
    if (!so) {
      so = {
        company,
        soNo,
        soDate: v(row, 'soDate'),
        customerCode: v(row, 'customerCode'),
        customerName: v(row, 'customerName'),
        customerPo: v(row, 'customerPo'),
        deliveryDate: v(row, 'deliveryDate'),
        vehicleType: v(row, 'vehicleType'),
        originCode: v(row, 'originCode'),
        originName: v(row, 'originName'),
        destinationCode: v(row, 'destinationCode'),
        destinationName: v(row, 'destinationName'),
        remark: v(row, 'remark'),
        cancelled: bit(v(row, 'cancelled')),
        updatedAt: localToIso(v(row, 'updatedAt'), mapping.timezone),
        rowVersion: wm,
        lines: [],
        raw: [],
      };
      byKey.set(k, so);
      orders.push(so);
    } else if (BigInt(wm) > BigInt(so.rowVersion)) {
      // แถวของใบเดียวกันควรมี watermark เท่ากัน — ถ้าไม่เท่าใช้ค่าล่าสุด (ไม่ทิ้งแถว)
      so.rowVersion = wm;
    }
    const qty = v(row, 'qty');
    so.lines.push({
      lineNo: v(row, 'lineNo'),
      itemCode: v(row, 'itemCode'),
      itemName: v(row, 'itemName'),
      qty: typeof qty === 'number' ? String(qty) : qty,
      unit: v(row, 'unit'),
    });
    so.raw.push(row);
  }

  const serverNext =
    typeof body.next === 'string' && WATERMARK_RE.test(body.next) ? body.next : null;
  // ไม่ถอยหลัง: ใช้ค่าที่มากกว่าระหว่าง next ของต้นทางกับ watermark สูงสุดที่เห็น (ไม่มีทั้งคู่ = since เดิม)
  const candidates = [serverNext, maxWm, since].filter((x): x is string => x !== null);
  const next = candidates.length
    ? candidates.reduce((a, b) => (BigInt(b) > BigInt(a) ? b : a))
    : null;
  return { ok: true, orders, next, hasMore: body.hasMore === true, rejectedRows };
}

function text(x: unknown): string | null {
  if (typeof x === 'number' && Number.isSafeInteger(x)) return String(x);
  if (typeof x !== 'string') return null;
  const t = x.trim();
  return t ? t : null;
}

function bit(x: unknown): boolean {
  return x === 1 || x === true || x === '1' || x === 'true';
}

/** datetime2 ไม่มี offset (เวลาท้องถิ่นของต้นทาง) → ISO 8601 พร้อม offset · มี offset อยู่แล้ว = คงไว้ */
function localToIso(x: unknown, timezone: string): string | null {
  if (typeof x !== 'string') return null;
  const s = x.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$/.test(s)) return s;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d{1,7})?$/.exec(s);
  if (!m) return null;
  // เฟส 0 รองรับเฉพาะเขตเวลาไม่มี DST ที่รู้จัก — KRS อยู่ไทย ([OPEN — KRS] เขตเวลาของ updated_at)
  const offset = timezone === 'Asia/Bangkok' ? '+07:00' : timezone === 'UTC' ? 'Z' : null;
  if (!offset) return null;
  const frac = (m[3] ?? '.000').slice(0, 4).padEnd(4, '0');
  return `${m[1]}T${m[2]}${frac}${offset}`;
}

function fail(
  errorClass: 'AUTH' | 'TRANSIENT' | 'VALIDATION',
  code: string,
  message: string,
): Extract<KrsSoReadResult, { ok: false }> {
  return { ok: false, errorClass, problem: { code, message: message.slice(0, 300) } };
}
