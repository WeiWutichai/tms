import type { ErpCapability } from '@tms/domain';
import type { ExternalOrder, PullPage } from '../../modules/connectors/order-source.port';
import type {
  CanonicalDocument,
  ConnectorConfigField,
  ErpAdapter,
  ErpContext,
  ExternalRef,
  HealthResult,
  ListDocumentsQuery,
  PaymentStatus,
  PushResult,
} from '../../modules/erp/erp-adapter';
import type { ErrorClass } from '../../modules/integration/outbox.types';

/**
 * DemoProvider (ST7-T14; docs/04 G3 "Provider factory + StandaloneProvider + DemoProvider"; docs/04 J Environments)
 * ERP **จำลองในหน่วยความจำ** สำหรับสาธิต/staging/sandbox และ test — ไม่ติดต่อภายนอก ไม่ส่งข้อมูลไปที่ใด
 *
 * - `localOnly` → ลงทะเบียนได้เฉพาะ dev/test หรือ `ERP_DEMO_ADAPTERS=1` (production ไม่มี) · catalog ติดธง `demo: true`
 * - ไม่เป็นค่าเริ่มต้นของ tenant ใด (ไม่มีแถว connector = Standalone) — ต้องสร้าง connector `adapterKey: demo` เอง
 * - ข้อมูลอยู่ใน process (หายเมื่อ restart) แยกตาม (tenant, connector) — ไม่ข้าม tenant
 * - พฤติกรรมกำหนดได้ (deterministic) จากค่าตั้งที่ไม่ลับของ connector:
 *   `failMode` ฉีด ErrorClass ให้ทุก push/replace (และ healthCheck เมื่อ AUTH) · `failTimes` ล้มกี่ครั้งต่อเอกสารก่อนสำเร็จ ·
 *   `paymentStatus` ผลของ fetchPaymentStatus
 * - credential `apiKey`: ค่าใดก็ได้ ยกเว้น `invalid` (= credential ผิด → AUTH) — ไว้สาธิตการทดสอบการเชื่อมต่อล้ม
 * - กันซ้ำ 2 ชั้นเหมือน ERP จริง (docs/01 §6.2): idempotencyKey เดิม = ผลเดิม · เลขอ้างอิงของเราซ้ำด้วย key อื่น = DUPLICATE
 * - ไม่ประกาศ `ownsDocumentNumber` (TMS ออกเลขเอง — โหมดออกเลขฝั่ง ERP = ST7-T17) และ `postedStatus`
 */
export const DEMO_ADAPTER_KEY = 'demo';

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
] as const;
export type DemoFailMode = (typeof DEMO_FAIL_MODES)[number];

/** `always` = ล้มทุกครั้ง · ตัวเลข = ล้ม n ครั้งแรกของเอกสารนั้นแล้วสำเร็จ (สาธิต retry) */
export const DEMO_FAIL_TIMES = ['always', '1', '2', '3'] as const;
export const DEMO_PAYMENT_STATUSES = ['UNPAID', 'PARTIALLY_PAID', 'PAID'] as const;
/** credential ที่ถือว่าผิด */
export const DEMO_INVALID_KEY = 'invalid';
/** จำนวน order ตัวอย่างที่ pullOrders คืน (ต่อ connector) */
export const DEMO_SAMPLE_ORDERS = 5;

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
  seq: number;
  /** externalId → เอกสาร */
  docs: Map<string, StoredDoc>;
  /** idempotencyKey → externalId */
  byKey: Map<string, string>;
  /** `${kind}:${number}` → externalId (ERP กันเลขอ้างอิงซ้ำ) */
  byRef: Map<string, string>;
  /** idempotencyKey/ref → จำนวนครั้งที่ล้มไปแล้ว (failTimes) */
  failures: Map<string, number>;
  /** วันที่ของ order ตัวอย่าง (กำหนดตอนดึงครั้งแรก — ดึงซ้ำได้ข้อมูลเดิม) */
  orderDate: string | null;
}

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

  // ---------- สถานะภายใน (test/สาธิต) ----------

  private scope(ctx: ErpContext): Scope {
    const id = `${ctx.tenantId}:${ctx.connectorId ?? '-'}`;
    let s = this.scopes.get(id);
    if (!s) {
      s = {
        seq: 0,
        docs: new Map(),
        byKey: new Map(),
        byRef: new Map(),
        failures: new Map(),
        orderDate: null,
      };
      this.scopes.set(id, s);
    }
    return s;
  }

  /** เอกสารที่ "ERP จำลอง" ได้รับของ connector นี้ (สำเนา) */
  documents(tenantId: string, connectorId: string | null): StoredDoc[] {
    const s = this.scopes.get(`${tenantId}:${connectorId ?? '-'}`);
    return s ? [...s.docs.values()].map(clone) : [];
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

  private store(s: Scope, kind: Kind, doc: CanonicalDocument, key: string): StoredDoc {
    s.seq += 1;
    const n = String(s.seq).padStart(6, '0');
    const at = this.now().toISOString();
    const stored: StoredDoc = {
      kind,
      externalId: `DEMO-${KIND_PREFIX[kind]}-${n}`,
      externalDocNo: `DM${KIND_PREFIX[kind]}${n}`,
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

  private ok(d: StoredDoc): PushResult {
    return {
      ok: true,
      externalId: d.externalId,
      externalDocNo: d.externalDocNo,
      externalVersion: String(d.version),
      raw: { demo: true },
    };
  }

  private async push(kind: Kind, ctx: ErpContext, doc: CanonicalDocument): Promise<PushResult> {
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
        this.store(s, kind, doc, key);
      return this.failure(mode, number);
    }
    if (prev) return this.ok(s.docs.get(prev)!);
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
    return this.ok(this.store(s, kind, doc, key));
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
    if (this.badKey(ctx)) return this.authFailure();
    const s = this.scope(ctx);
    const mode = this.failMode(ctx);
    const key = ctx.idempotencyKey ?? `replace:${ref.localId}:${ref.externalId ?? ref.number}`;
    if (mode !== 'none' && this.shouldFail(s, ctx, key)) return this.failure(mode, ref.number);
    const d = this.find(s, ref);
    if (!d) return this.failure('NOT_FOUND', ref.number);
    // key เดิม = แก้ไปแล้ว ไม่เพิ่มฉบับ
    if (s.byKey.get(key) !== d.externalId) {
      d.version += 1;
      d.document = clone(inv);
      d.updatedAt = this.now().toISOString();
      s.byKey.set(key, d.externalId);
    }
    return this.ok(d);
  }

  async fetchDocument(ctx: ErpContext, ref: ExternalRef): Promise<CanonicalDocument | null> {
    if (this.badKey(ctx)) throw new Error('demo ERP rejected the API key (simulated)');
    const d = this.find(this.scopes.get(this.scopeId(ctx)), ref);
    return d
      ? { ...clone(d.document), externalId: d.externalId, externalDocNo: d.externalDocNo }
      : null;
  }

  async fetchPaymentStatus(ctx: ErpContext, ref: ExternalRef): Promise<PaymentStatus | null> {
    if (this.badKey(ctx)) throw new Error('demo ERP rejected the API key (simulated)');
    const d = this.find(this.scopes.get(this.scopeId(ctx)), ref);
    if (!d) return null;
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
    return { status, paidAmount: fromSatang(paid), paidAt: d.receivedAt };
  }

  async listDocuments(
    ctx: ErpContext,
    q: ListDocumentsQuery,
  ): Promise<{ items: ExternalRef[]; next: string | null }> {
    if (this.badKey(ctx)) throw new Error('demo ERP rejected the API key (simulated)');
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
    return { items, next: null };
  }

  /**
   * order ตัวอย่าง 5 ใบต่อ connector (เลข `DEMO-SO-0001`…) — รหัสลูกค้า/สถานที่/ประเภทรถเป็นรหัสตัวอย่าง
   * (ยังไม่ map = ใบค้าง CUSTOMER/LOCATION_UNMAPPED ตามกติกาของ ST3-T05 — สาธิตการ map ได้)
   * cursor = ลำดับ · ล้มตาม `failMode` TRANSIENT/AUTH (throw — core ไม่เลื่อน cursor)
   */
  async pullOrders(ctx: ErpContext, since: string | null, limit: number): Promise<PullPage> {
    const mode = this.failMode(ctx);
    if (this.badKey(ctx) || mode === 'AUTH')
      throw new Error('demo ERP rejected the API key (simulated)');
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
