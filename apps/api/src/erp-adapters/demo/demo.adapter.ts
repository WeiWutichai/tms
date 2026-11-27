import { createHash } from 'node:crypto';
import type { ErpCapability, ErpMasterCodeKind } from '@tms/domain';
import type { ExternalOrder, PullPage } from '../../modules/connectors/order-source.port';
import type {
  CanonicalDocument,
  ConnectorConfigField,
  ErpAdapter,
  ErpContext,
  ErpMasterCodeEntry,
  ExternalRef,
  HealthResult,
  InboundEvent,
  InboundHandleResult,
  InboundRequest,
  InboundWebhookHandler,
  ListDocumentsQuery,
  PaymentStatus,
  PushResult,
} from '../../modules/erp/erp-adapter';
import { ErpAdapterError } from '../../modules/erp/erp-adapter';
import { verifyWebhookSignature } from '../../modules/webhooks/signature';
import type { ErrorClass } from '../../modules/integration/outbox.types';

/**
 * DemoProvider (ST7-T14; docs/04 G3 "Provider factory + StandaloneProvider + DemoProvider"; docs/04 J Environments)
 * ERP **จำลองในหน่วยความจำ** สำหรับสาธิต/staging/sandbox และ test — ไม่ติดต่อภายนอก ไม่ส่งข้อมูลไปที่ใด
 *
 * - `localOnly` → ทุก tenant ใน dev/test หรือ `ERP_DEMO_ADAPTERS=1` (staging) · NODE_ENV=production = เฉพาะ tenant sandbox
 *   (D-81 · D68-58/96 — `ErpAdapterRegistry.usableIn`) · catalog ติดธง `demo: true`
 * - ไม่เป็นค่าเริ่มต้นของ tenant ใด (ไม่มีแถว connector = Standalone) — ต้องสร้าง connector `adapterKey: demo` เอง
 * - ข้อมูลอยู่ใน process (หายเมื่อ restart) แยกตาม (tenant, connector) — ไม่ข้าม tenant · ยกเลิกการเชื่อม = ทิ้ง (`forget`) ·
 *   เก็บไม่เกิน `DEMO_MAX_SCOPES` ชุดต่อ process (ใช้ล่าสุดอยู่ต่อ — LRU; ชุดเก่าสุดถูกทิ้ง) กันหน่วยความจำโตไม่จำกัดใน sandbox
 *   **ข้อจำกัดของ demo:** การจับเลขอ้างอิงซ้ำ (DUPLICATE), fetch/สถานะรับชำระ/list และจำนวนเอกสารใน healthCheck
 *   เห็นเฉพาะสิ่งที่ process นี้ได้รับตั้งแต่บูต (API กับ worker คนละ process — push/fetch ผ่าน outbox อยู่ใน worker เดียวกัน)
 * - เลขภายนอก `DEMO-INV-{hash 12 ตัว}` มาจาก hash ของ (tenant, connector, ประเภท, idempotency key) — restart ไม่ให้เลขซ้ำกับเอกสารอื่น
 * - พฤติกรรมกำหนดได้ (deterministic) จากค่าตั้งที่ไม่ลับของ connector:
 *   `failMode` ฉีด ErrorClass ให้ทุก push/replace (และ healthCheck เมื่อ AUTH) · `failTimes` ล้มกี่ครั้งต่อเอกสารก่อนสำเร็จ ·
 *   `paymentStatus` ผลของ fetchPaymentStatus (ทุกเอกสาร) · ST7-T21 `setPaymentStatus()` ตั้งรายเอกสาร (test/สาธิต)
 * - ST7-T16 รายงาน "HTTP call จำลอง" ทุกครั้งผ่าน `ctx.onHttpCall` (sync log — ไม่มีการเรียกออกจริง; host `demo-erp.invalid`)
 * - credential `apiKey`: ค่าใดก็ได้ ยกเว้น `invalid` (= credential ผิด → AUTH) — ไว้สาธิตการทดสอบการเชื่อมต่อล้ม
 * - กันซ้ำ 2 ชั้นเหมือน ERP จริง (docs/01 §6.2): idempotencyKey เดิม = ผลเดิม · เลขอ้างอิงของเราซ้ำด้วย key อื่น = DUPLICATE
 * - ไม่ประกาศ `ownsDocumentNumber` (TMS ออกเลขเอง — โหมดออกเลขฝั่ง ERP = ST7-T17) และ `postedStatus`
 * - webhook ขาเข้า (ST7-T22): header `X-Demo-Signature: t=<unix>,v1=<hex>` = HMAC-SHA256(credential `inboundSecret`,
 *   `${t}.${rawBody}`) รูปเดียวกับ webhook ขาออกของเรา (±300 วิ) · body `{"id","type","occurredAt"?}` ·
 *   type `orders.changed` → ขอให้ core ดึง order ทันที · `demo.fail` → ล้ม (ไม่ลองใหม่) · `demo.retry` → throw (ลองใหม่)
 */
export const DEMO_ADAPTER_KEY = 'demo';
/** review L1 จำนวนชุดข้อมูล (tenant, connector) สูงสุดที่เก็บในหน่วยความจำต่อ process */
export const DEMO_MAX_SCOPES = 500;

/** ErrorClass ที่ฉีดได้ (docs/01 §6.3) — `none` = ทำงานปกติ */
export const DEMO_FAIL_MODES = [
  'none',
  'TRANSIENT',
  'AMBIGUOUS',
  'DUPLICATE',
  'VALIDATION',
  'AUTH',
  'NOT_FOUND',
  'PERIOD_CLOSED',
  /** ST7-T16 ERP ตอบว่าไม่รองรับคำสั่งนี้ (ครบ 8 class ของ docs/01 §6.3) */
  'CAPABILITY',
] as const;
export type DemoFailMode = (typeof DEMO_FAIL_MODES)[number];

/** `always` = ล้มทุกครั้ง · ตัวเลข = ล้ม n ครั้งแรกของเอกสารนั้นแล้วสำเร็จ (สาธิต retry) */
export const DEMO_FAIL_TIMES = ['always', '1', '2', '3'] as const;
export const DEMO_PAYMENT_STATUSES = ['UNPAID', 'PARTIALLY_PAID', 'PAID'] as const;
/** credential ที่ถือว่าผิด */
export const DEMO_INVALID_KEY = 'invalid';
/** จำนวน order ตัวอย่างที่ pullOrders คืน (ต่อ connector) */
export const DEMO_SAMPLE_ORDERS = 5;

/**
 * ผังรหัสตัวอย่างของ Demo ERP (ST7-T18) — ทุกชนิดดึงได้ · ค่าเป็นตัวอย่างสาธิตเท่านั้น
 * VAT_RATE เป็นข้อมูลอ้างอิงของ ERP (ไม่ใช่กฎภาษีของ TMS)
 */
export const DEMO_MASTER_CODES: Readonly<Record<ErpMasterCodeKind, readonly ErpMasterCodeEntry[]>> =
  Object.freeze({
    UNIT: [
      { code: 'TRIP', name: 'เที่ยว' },
      { code: 'TON', name: 'ตัน' },
      { code: 'KM', name: 'กม.' },
      { code: 'HR', name: 'ชั่วโมง' },
    ],
    SALESPERSON: [
      { code: 'S001', name: 'พนักงานขาย ตัวอย่าง 1' },
      { code: 'S002', name: 'พนักงานขาย ตัวอย่าง 2' },
    ],
    ACCOUNT: [
      { code: '4100-01', name: 'รายได้ค่าขนส่ง' },
      { code: '4100-02', name: 'รายได้ค่าบริการ' },
    ],
    ITEM: [
      { code: 'SV-FRT-01', name: 'ค่าขนส่ง' },
      { code: 'SV-WAIT', name: 'ค่ารอคิว' },
      { code: 'SV-LABOR', name: 'ค่าแรงลงสินค้า' },
      { code: 'SV-OVN', name: 'ค่าค้างคืน' },
      { code: 'SV-TOLL', name: 'ค่าทางด่วน' },
      { code: 'SV-FUEL', name: 'Fuel surcharge' },
    ],
    VAT_RATE: [
      { code: 'V7', name: 'VAT 7%', rate: '7.00' },
      { code: 'V0', name: 'VAT 0%', rate: '0.00' },
      { code: 'VEX', name: 'ยกเว้น VAT', rate: null },
    ],
  });

const CAPS: readonly ErpCapability[] = [
  'pullOrders',
  'pushInvoice',
  'pushCreditNote',
  'pushSettlement',
  'fetchDocument',
  'fetchPaymentStatus',
  'listDocuments',
  'replaceDocument',
];

type Kind = 'invoice' | 'adjustment' | 'settlement';
const KIND_PREFIX: Record<Kind, string> = { invoice: 'INV', adjustment: 'ADJ', settlement: 'STL' };

interface StoredDoc {
  kind: Kind;
  externalId: string;
  externalDocNo: string;
  version: number;
  number: string;
  localId: string;
  document: CanonicalDocument;
  receivedAt: string;
  updatedAt: string;
}

interface Scope {
  /** externalId → เอกสาร */
  docs: Map<string, StoredDoc>;
  /** idempotencyKey → externalId */
  byKey: Map<string, string>;
  /** `${kind}:${number}` → externalId (ERP กันเลขอ้างอิงซ้ำ) */
  byRef: Map<string, string>;
  /** ST7-T18 ผังรหัสที่ test/สาธิตตั้งทับ (ไม่มี = DEMO_MASTER_CODES) */
  masterCodes: Map<ErpMasterCodeKind, ErpMasterCodeEntry[]>;
  /** ST7-T21 เลขเอกสารของเรา → สถานะรับชำระที่ "ERP จำลอง" รายงาน (test/สาธิตตั้ง) */
  payments: Map<string, PaymentStatus>;
  /** idempotencyKey/ref → จำนวนครั้งที่ล้มไปแล้ว (failTimes) */
  failures: Map<string, number>;
  /** วันที่ของ order ตัวอย่าง (กำหนดตอนดึงครั้งแรก — ดึงซ้ำได้ข้อมูลเดิม) */
  orderDate: string | null;
  /** webhook ขาเข้าที่ handle แล้ว (ตามลำดับ) */
  inbound: InboundEvent[];
}

/** header ลายเซ็นของ webhook ขาเข้าจาก Demo ERP */
export const DEMO_INBOUND_SIGNATURE_HEADER = 'x-demo-signature';

/** ส่วนท้ายของเลขภายนอก: 12 ตัวแรกของ sha256 (ตัวใหญ่) */
export function demoExternalSuffix(scope: string, kind: string, key: string): string {
  return createHash('sha256')
    .update(`${scope}|${kind}|${key}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
}

/** ST7-T16 HTTP status จำลองต่อ ErrorClass (sync log) — AMBIGUOUS = ไม่ได้ response */
const DEMO_HTTP_STATUS: Record<ErrorClass, number | null> = {
  TRANSIENT: 503,
  AMBIGUOUS: null,
  DUPLICATE: 409,
  VALIDATION: 422,
  AUTH: 401,
  NOT_FOUND: 404,
  PERIOD_CLOSED: 422,
  CAPABILITY: 501,
};

const isMoney = (v: unknown): v is string => typeof v === 'string' && /^-?\d+(\.\d{1,2})?$/.test(v);

/** สตริงเงิน → สตางค์ (BigInt — ห้าม float) */
function toSatang(v: string): bigint {
  const neg = v.startsWith('-');
  const [i, f = ''] = (neg ? v.slice(1) : v).split('.');
  const n = BigInt(i!) * 100n + BigInt((f + '00').slice(0, 2));
  return neg ? -n : n;
}

function fromSatang(n: bigint): string {
  const neg = n < 0n;
  const a = neg ? -n : n;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}

function clone<T>(v: T): T {
  try {
    return structuredClone(v);
  } catch {
    return JSON.parse(JSON.stringify(v ?? null)) as T;
  }
}

export class DemoAdapter implements ErpAdapter {
  readonly key = DEMO_ADAPTER_KEY;
  readonly displayName = 'Demo ERP (simulated)';
  readonly localOnly = true;
  readonly configFields: readonly ConnectorConfigField[] = Object.freeze([
    { key: 'apiKey', secret: true, required: true, kind: 'string', maxLength: 200 },
    /** ST7-T22 secret ที่ Demo ERP ใช้เซ็น webhook ขาเข้า — ไม่ตั้ง = ลายเซ็นไม่มีวันผ่าน */
    { key: 'inboundSecret', secret: true, required: false, kind: 'string', maxLength: 200 },
    { key: 'failMode', secret: false, required: false, kind: 'string', options: DEMO_FAIL_MODES },
    { key: 'failTimes', secret: false, required: false, kind: 'string', options: DEMO_FAIL_TIMES },
    {
      key: 'paymentStatus',
      secret: false,
      required: false,
      kind: 'string',
      options: DEMO_PAYMENT_STATUSES,
    },
  ] satisfies ConnectorConfigField[]);

  private readonly scopes = new Map<string, Scope>();
  /** test/สาธิต: นาฬิกา (ค่าเริ่ม = เวลาจริง) */
  now: () => Date = () => new Date();

  capabilities(): ReadonlySet<ErpCapability> {
    return new Set(CAPS);
  }

  /** ST7-T18 ดึงผังรหัสได้ทุกชนิด */
  readonly masterCodeKinds: readonly ErpMasterCodeKind[] = Object.freeze([
    'UNIT',
    'SALESPERSON',
    'ACCOUNT',
    'ITEM',
    'VAT_RATE',
  ] as ErpMasterCodeKind[]);

  /** credential ผิด / failMode AUTH หรือ TRANSIENT = throw (core ไม่เปลี่ยนผังรหัสเดิม) */
  async fetchMasterCodes(ctx: ErpContext, kind: ErpMasterCodeKind): Promise<ErpMasterCodeEntry[]> {
    if (this.badKey(ctx) || this.failMode(ctx) === 'AUTH') throw this.authError();
    if (this.failMode(ctx) === 'TRANSIENT')
      throw new Error('demo ERP is unavailable (simulated 503)');
    const own = this.scope(ctx).masterCodes.get(kind);
    return clone(own ?? [...DEMO_MASTER_CODES[kind]]);
  }

  // ---------- สถานะภายใน (test/สาธิต) ----------

  /** review L1: connector ถูกยกเลิกการเชื่อม → ทิ้งข้อมูลจำลองของ connector นี้ */
  forget(tenantId: string, connectorId: string): void {
    this.scopes.delete(`${tenantId}:${connectorId}`);
  }

  private scope(ctx: ErpContext): Scope {
    const id = `${ctx.tenantId}:${ctx.connectorId ?? '-'}`;
    let s = this.scopes.get(id);
    if (s) {
      // LRU: ย้ายไปท้าย (ใช้ล่าสุด)
      this.scopes.delete(id);
      this.scopes.set(id, s);
    } else {
      s = {
        docs: new Map(),
        byKey: new Map(),
        byRef: new Map(),
        failures: new Map(),
        masterCodes: new Map(),
        payments: new Map(),
        orderDate: null,
        inbound: [],
      };
      this.scopes.set(id, s);
      while (this.scopes.size > DEMO_MAX_SCOPES)
        this.scopes.delete(this.scopes.keys().next().value as string);
    }
    return s;
  }

  /** เอกสารที่ "ERP จำลอง" ได้รับของ connector นี้ (สำเนา) */
  documents(tenantId: string, connectorId: string | null): StoredDoc[] {
    const s = this.scopes.get(`${tenantId}:${connectorId ?? '-'}`);
    return s ? [...s.docs.values()].map(clone) : [];
  }

  /** webhook ขาเข้าที่ "ERP จำลอง" ส่งแล้ว TMS ประมวลผล (สำเนา) */
  inboundHandled(tenantId: string, connectorId: string | null): InboundEvent[] {
    const s = this.scopes.get(`${tenantId}:${connectorId ?? '-'}`);
    return s ? s.inbound.map(clone) : [];
  }

  /** test/สาธิต: ตั้งผังรหัสของชนิดหนึ่งให้ connector นี้ (จำลอง "ERP เพิ่ม/ลบรหัส") */
  setMasterCodes(
    tenantId: string,
    connectorId: string,
    kind: ErpMasterCodeKind,
    entries: ErpMasterCodeEntry[],
  ): void {
    this.scope({ tenantId, connectorId } as ErpContext).masterCodes.set(kind, clone(entries));
  }

  /**
   * ST7-T21 test/สาธิต: "ERP จำลอง" รายงานสถานะรับชำระของเอกสารเลขนี้ (เลขเอกสารของเรา เช่น invoice_no) —
   * `null` = กลับไปใช้ค่าตั้ง `paymentStatus` ของ connector · ต้องเป็นเอกสารที่ ERP จำลองได้รับแล้ว จึงมีผลตอน fetchPaymentStatus
   */
  setPaymentStatus(
    tenantId: string,
    connectorId: string,
    number: string,
    status: PaymentStatus | null,
  ): void {
    const s = this.scope({ tenantId, connectorId } as ErpContext);
    if (status) s.payments.set(number, clone(status));
    else s.payments.delete(number);
  }

  /** ล้างข้อมูลจำลองทั้งหมด (หรือของ tenant เดียว) */
  reset(tenantId?: string): void {
    if (!tenantId) return this.scopes.clear();
    for (const k of [...this.scopes.keys()])
      if (k.startsWith(`${tenantId}:`)) this.scopes.delete(k);
  }

  // ---------- ค่าตั้ง ----------

  private failMode(ctx: ErpContext): DemoFailMode {
    const v = ctx.config.failMode;
    return (DEMO_FAIL_MODES as readonly string[]).includes(v ?? '') ? (v as DemoFailMode) : 'none';
  }

  private badKey(ctx: ErpContext): boolean {
    return !ctx.config.apiKey || ctx.config.apiKey === DEMO_INVALID_KEY;
  }

  /** ถึงคราวล้มไหม (นับต่อเอกสาร) — `always`/ไม่ตั้ง = ล้มทุกครั้ง */
  private shouldFail(s: Scope, ctx: ErpContext, counterKey: string): boolean {
    const t = ctx.config.failTimes;
    if (!t || t === 'always' || !/^\d+$/.test(t)) return true;
    const n = s.failures.get(counterKey) ?? 0;
    if (n >= Number(t)) return false;
    s.failures.set(counterKey, n + 1);
    return true;
  }

  /**
   * P1-ST5-T01 (conformance) อ่านกลับ/ดึง order ด้วย credential ผิด = `ErpAdapterError('AUTH')` — Error ธรรมดา core ถือเป็น TRANSIENT
   * (ยิงซ้ำ/ไม่หยุด connector) ซึ่งขัด docs/01 §6.3 + D68-47
   */
  private authError(): ErpAdapterError {
    return new ErpAdapterError('AUTH', {
      code: 'unauthorized',
      message: 'demo ERP rejected the API key (simulated)',
    });
  }

  private authFailure(): PushResult {
    return {
      ok: false,
      errorClass: 'AUTH',
      retryable: false,
      problem: { code: 'unauthorized', message: 'demo ERP rejected the API key (simulated)' },
    };
  }

  // ---------- ErpAdapter ----------

  async healthCheck(ctx: ErpContext): Promise<HealthResult> {
    if (this.badKey(ctx) || this.failMode(ctx) === 'AUTH')
      return {
        ok: false,
        errorClass: 'AUTH',
        problem: { code: 'unauthorized', message: 'demo ERP rejected the API key (simulated)' },
      };
    return {
      ok: true,
      detail: { demo: true, documents: this.scopes.get(this.scopeId(ctx))?.docs.size ?? 0 },
    };
  }

  private scopeId(ctx: ErpContext) {
    return `${ctx.tenantId}:${ctx.connectorId ?? '-'}`;
  }

  private failure(cls: Exclude<DemoFailMode, 'none'>, ref: string): PushResult {
    const problems: Record<Exclude<DemoFailMode, 'none'>, { code: string; message: string }> = {
      TRANSIENT: {
        code: 'service_unavailable',
        message: 'demo ERP is unavailable (simulated 503)',
      },
      AMBIGUOUS: {
        code: 'timeout_after_send',
        message: 'demo ERP timed out after receiving the request (simulated)',
      },
      DUPLICATE: { code: 'duplicate_reference', message: `reference ${ref} already exists` },
      VALIDATION: {
        code: 'customer_unmapped',
        message: 'demo ERP does not know the customer code (simulated)',
      },
      AUTH: { code: 'unauthorized', message: 'demo ERP rejected the API key (simulated)' },
      NOT_FOUND: { code: 'not_found', message: 'document not found in demo ERP (simulated)' },
      PERIOD_CLOSED: {
        code: 'period_closed',
        message: 'accounting period is closed in demo ERP (simulated)',
      },
      CAPABILITY: {
        code: 'unsupported_operation',
        message: 'demo ERP does not support this operation (simulated)',
      },
    };
    const p = problems[cls];
    return {
      ok: false,
      errorClass: cls as ErrorClass,
      retryable: cls === 'TRANSIENT' || cls === 'AMBIGUOUS',
      problem: {
        ...p,
        ...(cls === 'VALIDATION'
          ? { fields: [{ field: 'customer.externalId', code: 'unknown', message: p.message }] }
          : {}),
      },
    };
  }

  /** ST7-T16 รายงาน HTTP call จำลอง 1 ครั้ง (sync log) — สถานะตามผล (AMBIGUOUS = ไม่ได้ response) */
  private report(
    ctx: ErpContext,
    method: string,
    path: string,
    requestBody: unknown,
    r: PushResult | { found: unknown },
  ): void {
    const status =
      'found' in r
        ? r.found
          ? 200
          : 404
        : r.ok
          ? method === 'POST'
            ? 201
            : 200
          : DEMO_HTTP_STATUS[r.errorClass];
    try {
      ctx.onHttpCall?.({
        method,
        url: `https://demo-erp.invalid/api${path}`,
        requestBody,
        status,
        responseBody:
          'found' in r
            ? r.found
            : r.ok
              ? { externalId: r.externalId, externalDocNo: r.externalDocNo ?? null }
              : { error: r.problem.code, message: r.problem.message },
        errorCode: 'found' in r || r.ok ? null : r.problem.code,
        durationMs: 0,
        at: this.now(),
      });
    } catch {
      /* ตัวบันทึกล้ม = ไม่กระทบผล */
    }
  }

  private store(
    s: Scope,
    ctx: ErpContext,
    kind: Kind,
    doc: CanonicalDocument,
    key: string,
  ): StoredDoc {
    // เลขภายนอกจาก hash ของ (tenant, connector, ประเภท, idempotency key) — ไม่ใช่ลำดับในหน่วยความจำ:
    // restart / หลาย process ไม่มีวันให้เลขเดิมกับเอกสารอื่น และคำสั่งเดิมได้เลขเดิมเสมอ (review ST7-T14)
    const n = demoExternalSuffix(this.scopeId(ctx), kind, key);
    const at = this.now().toISOString();
    const stored: StoredDoc = {
      kind,
      externalId: `DEMO-${KIND_PREFIX[kind]}-${n}`,
      externalDocNo: `DM${KIND_PREFIX[kind]}${n.slice(0, 10)}`,
      version: 1,
      number: String(doc.number),
      localId: String(doc.id),
      document: clone(doc),
      receivedAt: at,
      updatedAt: at,
    };
    s.docs.set(stored.externalId, stored);
    s.byKey.set(key, stored.externalId);
    s.byRef.set(`${kind}:${stored.number}`, stored.externalId);
    return stored;
  }

  /** `applied` = ERP ถือเนื้อหาของ payload ครั้งนี้ (สร้าง/แทนที่ หรือของเดิมตรงกันทุกช่อง) — คืนของเดิมที่เนื้อหาต่าง = false (ST7-T15) */
  private ok(d: StoredDoc, applied: boolean): PushResult {
    return {
      ok: true,
      externalId: d.externalId,
      externalDocNo: d.externalDocNo,
      externalVersion: String(d.version),
      applied,
      raw: { demo: true },
    };
  }

  private async push(kind: Kind, ctx: ErpContext, doc: CanonicalDocument): Promise<PushResult> {
    const r = await this.pushInner(kind, ctx, doc);
    this.report(ctx, 'POST', `/${kind}s`, doc, r);
    return r;
  }

  private async pushInner(
    kind: Kind,
    ctx: ErpContext,
    doc: CanonicalDocument,
  ): Promise<PushResult> {
    if (this.badKey(ctx)) return this.authFailure();
    const s = this.scope(ctx);
    const number = String(doc?.number ?? '');
    const key = ctx.idempotencyKey ?? `${kind}:${String(doc?.id ?? '')}:${number}`;
    // ชั้น ERP: key เดิม = ผลเดิม (ส่งซ้ำหลัง AMBIGUOUS ไม่สร้างใบที่สอง)
    const prev = s.byKey.get(key);
    const mode = this.failMode(ctx);
    if (mode !== 'none' && this.shouldFail(s, ctx, key)) {
      // AMBIGUOUS/DUPLICATE: ERP "ได้รับแล้ว" แต่ผู้ส่งไม่รู้ผล → บันทึกไว้ก่อนแล้วตอบล้ม (ส่งใหม่ด้วย key เดิมได้ใบเดิม)
      if ((mode === 'AMBIGUOUS' || mode === 'DUPLICATE') && !prev && number)
        this.store(s, ctx, kind, doc, key);
      return this.failure(mode, number);
    }
    // key เดิม = คืนของเดิม ไม่แก้เนื้อหา — `applied` เฉพาะเมื่อเนื้อหาที่เก็บไว้ตรงกับ payload ครั้งนี้จริง
    if (prev) {
      const stored = s.docs.get(prev)!;
      return this.ok(stored, JSON.stringify(stored.document) === JSON.stringify(doc));
    }
    if (!number || !doc?.id)
      return {
        ok: false,
        errorClass: 'VALIDATION',
        retryable: false,
        problem: { code: 'invalid_payload', message: 'document id and number are required' },
      };
    // เลขอ้างอิงของเราซ้ำด้วยคำสั่งอื่น = ERP ปฏิเสธว่าซ้ำ (core ตาม fetchDocument ต่อ — docs/01 §6.3)
    const dup = s.byRef.get(`${kind}:${number}`);
    if (dup) return { ...this.failure('DUPLICATE', number), raw: { externalId: dup } };
    return this.ok(this.store(s, ctx, kind, doc, key), true);
  }

  pushInvoice(ctx: ErpContext, inv: CanonicalDocument): Promise<PushResult> {
    return this.push('invoice', ctx, inv);
  }

  pushCreditNote(ctx: ErpContext, note: CanonicalDocument): Promise<PushResult> {
    return this.push('adjustment', ctx, note);
  }

  pushSettlement(ctx: ErpContext, stl: CanonicalDocument): Promise<PushResult> {
    return this.push('settlement', ctx, stl);
  }

  private find(s: Scope | undefined, ref: ExternalRef): StoredDoc | null {
    if (!s) return null;
    if (ref.externalId) return s.docs.get(ref.externalId) ?? null;
    for (const d of s.docs.values()) if (d.number === ref.number) return d;
    return null;
  }

  async replaceDocument(
    ctx: ErpContext,
    ref: ExternalRef,
    inv: CanonicalDocument,
  ): Promise<PushResult> {
    const r = this.replaceInner(ctx, ref, inv);
    this.report(ctx, 'PUT', `/documents/${ref.externalId ?? ref.number}`, inv, r);
    return r;
  }

  private replaceInner(ctx: ErpContext, ref: ExternalRef, inv: CanonicalDocument): PushResult {
    if (this.badKey(ctx)) return this.authFailure();
    const s = this.scope(ctx);
    const mode = this.failMode(ctx);
    const key = ctx.idempotencyKey ?? `replace:${ref.localId}:${ref.externalId ?? ref.number}`;
    if (mode !== 'none' && this.shouldFail(s, ctx, key)) return this.failure(mode, ref.number);
    const d = this.find(s, ref);
    if (!d) return this.failure('NOT_FOUND', ref.number);
    // key เดิม = แก้ไปแล้ว ไม่เพิ่มฉบับ
    const replaced = s.byKey.get(key) !== d.externalId;
    if (replaced) {
      d.version += 1;
      d.document = clone(inv);
      d.updatedAt = this.now().toISOString();
      s.byKey.set(key, d.externalId);
    }
    return this.ok(d, replaced || JSON.stringify(d.document) === JSON.stringify(inv));
  }

  async fetchDocument(ctx: ErpContext, ref: ExternalRef): Promise<CanonicalDocument | null> {
    if (this.badKey(ctx)) throw this.authError();
    const d = this.find(this.scopes.get(this.scopeId(ctx)), ref);
    const out = d
      ? { ...clone(d.document), externalId: d.externalId, externalDocNo: d.externalDocNo }
      : null;
    this.report(ctx, 'GET', `/documents/${ref.externalId ?? ref.number}`, undefined, {
      found: out,
    });
    return out;
  }

  async fetchPaymentStatus(ctx: ErpContext, ref: ExternalRef): Promise<PaymentStatus | null> {
    if (this.badKey(ctx)) throw this.authError();
    const d = this.find(this.scopes.get(this.scopeId(ctx)), ref);
    if (!d) return null;
    // ST7-T21 สถานะที่ test/สาธิตตั้งให้เอกสารใบนี้โดยตรง (ไม่มี = ตามค่าตั้ง `paymentStatus` ของ connector)
    const forced = this.scopes.get(this.scopeId(ctx))?.payments.get(d.number);
    if (forced) return { ...forced };
    const status = (DEMO_PAYMENT_STATUSES as readonly string[]).includes(
      ctx.config.paymentStatus ?? '',
    )
      ? (ctx.config.paymentStatus as PaymentStatus['status'])
      : 'UNPAID';
    const totals = (d.document as { totals?: { total?: unknown } }).totals;
    const total = isMoney(totals?.total) ? toSatang(totals.total) : 0n;
    if (status === 'UNPAID') return { status, paidAmount: '0.00', paidAt: null };
    // ชำระบางส่วน = ครึ่งหนึ่ง (ปัดลงเป็นสตางค์) — ค่าคงที่ให้ผลซ้ำได้
    const paid = status === 'PAID' ? total : total / 2n;
    // ST7-T21 สัญญา: บอก WHT เสมอเมื่อมียอดตัดหนี้ (demo = ไม่มี WHT) — ไม่บอก core จะไม่สร้างรายการรับชำระ
    return { status, paidAmount: fromSatang(paid), whtAmount: '0.00', paidAt: d.receivedAt };
  }

  async listDocuments(
    ctx: ErpContext,
    q: ListDocumentsQuery,
  ): Promise<{ items: ExternalRef[]; next: string | null }> {
    if (this.badKey(ctx)) throw this.authError();
    const s = this.scopes.get(this.scopeId(ctx));
    const all = s ? [...s.docs.values()] : [];
    const items = all
      .filter((d) => (q.ref ? d.number === q.ref : true))
      .filter((d) => (q.updatedAfter ? d.updatedAt > q.updatedAfter : true))
      .sort((a, b) => a.externalId.localeCompare(b.externalId))
      .slice(0, Math.max(0, q.limit))
      .map((d) => ({
        entityType: d.kind,
        localId: d.localId,
        number: d.number,
        externalId: d.externalId,
      }));
    this.report(ctx, 'GET', `/documents?ref=${q.ref ?? ''}`, undefined, { found: { items } });
    return { items, next: null };
  }

  readonly inbound: InboundWebhookHandler = {
    verify: (ctx: ErpContext, req: InboundRequest): boolean => {
      const secret = ctx.config.inboundSecret;
      if (!secret) return false;
      return verifyWebhookSignature({
        secret,
        header: req.headers[DEMO_INBOUND_SIGNATURE_HEADER],
        rawBody: req.rawBody.toString('utf8'),
        nowSec: Math.floor(req.receivedAt.getTime() / 1000),
      }).ok;
    },
    parse: (_ctx: ErpContext, req: InboundRequest): InboundEvent | null => {
      let body: unknown;
      try {
        body = JSON.parse(req.rawBody.toString('utf8'));
      } catch {
        return null;
      }
      const b = body as { id?: unknown; type?: unknown; occurredAt?: unknown } | null;
      if (!b || typeof b.id !== 'string' || typeof b.type !== 'string') return null;
      return {
        eventKey: b.id,
        type: b.type,
        occurredAt: typeof b.occurredAt === 'string' ? b.occurredAt : null,
      };
    },
    handle: async (ctx: ErpContext, event: InboundEvent): Promise<InboundHandleResult> => {
      if (event.type === 'demo.retry') throw new Error('demo ERP handler unavailable (simulated)');
      if (event.type === 'demo.fail')
        return {
          ok: false,
          retryable: false,
          problem: { code: 'unsupported_event', message: 'demo ERP event rejected (simulated)' },
        };
      this.scope(ctx).inbound.push({ ...event });
      return {
        ok: true,
        triggers: event.type === 'orders.changed' ? ['pullOrders'] : [],
        summary: { demo: true, type: event.type },
      };
    },
  };

  /**
   * order ตัวอย่าง 5 ใบต่อ connector (เลข `DEMO-SO-0001`…) — รหัสลูกค้า/สถานที่/ประเภทรถเป็นรหัสตัวอย่าง
   * (ยังไม่ map = ใบค้าง CUSTOMER/LOCATION_UNMAPPED ตามกติกาของ ST3-T05 — สาธิตการ map ได้)
   * cursor = ลำดับ · ล้มตาม `failMode` TRANSIENT/AUTH (throw — core ไม่เลื่อน cursor)
   */
  async pullOrders(ctx: ErpContext, since: string | null, limit: number): Promise<PullPage> {
    const mode = this.failMode(ctx);
    if (this.badKey(ctx) || mode === 'AUTH') throw this.authError();
    if (mode === 'TRANSIENT') throw new Error('demo ERP is unavailable (simulated 503)');
    const s = this.scope(ctx);
    s.orderDate ??= new Date(this.now().getTime() + 7 * 3600_000 + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const from = since && /^\d+$/.test(since) ? Number(since) : 0;
    const count = Math.max(0, Math.min(limit, DEMO_SAMPLE_ORDERS - from));
    const orders: ExternalOrder[] = Array.from({ length: count }, (_, i) => {
      const n = String(from + i + 1).padStart(4, '0');
      return {
        externalId: `DEMO-SO-${n}`,
        customer: { code: 'DEMO-C001', name: 'Demo Customer Co., Ltd.' },
        customerRef: `DEMO-PO-${n}`,
        requestedDate: s.orderDate,
        vehicleTypeCode: 'DEMO-6W',
        stops: [
          { type: 'PICKUP', siteCode: 'DEMO-S01', text: 'Demo Warehouse' },
          { type: 'DELIVERY', siteCode: 'DEMO-S02', text: 'Demo Store' },
        ],
        lines: [{ itemCode: 'DEMO-P01', description: 'Demo goods', qty: '10', unit: 'BOX' }],
        raw: { demo: true, soNo: `DEMO-SO-${n}` },
      };
    });
    const next = from + count;
    return { orders, nextCursor: String(next), hasMore: next < DEMO_SAMPLE_ORDERS };
  }
}
