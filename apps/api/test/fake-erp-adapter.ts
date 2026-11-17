import type { ErpCapability } from '@tms/domain';
import type {
  CanonicalDocument,
  ConnectorConfigField,
  ErpAdapter,
  ErpContext,
  ExternalRef,
  HealthResult,
  PushResult,
} from '../src/modules/erp/erp-adapter';
import type { ErrorClass } from '../src/modules/integration/outbox.types';

/**
 * ErpAdapter จำลองสำหรับ test ของ framework (ST7-T13) — ไม่ใช่ DemoProvider (ST7-T14)
 * กันซ้ำด้วย idempotencyKey · `fail` ฉีด ErrorClass · `health` กำหนดผล healthCheck · credential ผิด (`apiKey` ≠ GOOD_KEY) = AUTH
 */
export const GOOD_KEY = 'fake-api-key-0123456789';

export class FakeErpAdapter implements ErpAdapter {
  readonly displayName: string;
  readonly configFields: readonly ConnectorConfigField[] = [
    { key: 'baseUrl', secret: false, required: true, kind: 'url' },
    { key: 'apiKey', secret: true, required: true, kind: 'string' },
  ];
  private readonly caps: ErpCapability[];
  /** สิ่งที่ "ERP" รับแล้ว ต่อ idempotency key */
  readonly received = new Map<string, { op: string; externalId: string; ctx: ErpContext }>();
  calls: { op: string; ctx: ErpContext; doc?: unknown }[] = [];
  fail?: { errorClass: ErrorClass; message?: string };
  health?: HealthResult;

  constructor(
    readonly key = 'fake-erp',
    caps: ErpCapability[] = ['pushInvoice', 'fetchDocument', 'ownsDocumentNumber'],
  ) {
    this.caps = caps;
    this.displayName = `Fake ${key}`;
    const self = this as unknown as Record<string, unknown>;
    // method ⇔ capability (assertAdapterShape)
    if (!caps.includes('pushInvoice')) self.pushInvoice = undefined;
    if (!caps.includes('pushCreditNote')) self.pushCreditNote = undefined;
    if (!caps.includes('fetchDocument')) self.fetchDocument = undefined;
  }

  capabilities(): ReadonlySet<ErpCapability> {
    return new Set(this.caps);
  }

  async healthCheck(ctx: ErpContext): Promise<HealthResult> {
    if (this.health) return this.health;
    if (ctx.config.apiKey !== GOOD_KEY)
      return {
        ok: false,
        errorClass: 'AUTH',
        problem: { code: 'unauthorized', message: 'bad key' },
      };
    return { ok: true };
  }

  private push(op: string, ctx: ErpContext, doc: CanonicalDocument): PushResult {
    this.calls.push({ op, ctx, doc });
    if (ctx.config.apiKey !== GOOD_KEY)
      return {
        ok: false,
        errorClass: 'AUTH',
        retryable: false,
        problem: { code: 'unauthorized', message: 'bad key' },
      };
    if (this.fail)
      return {
        ok: false,
        errorClass: this.fail.errorClass,
        retryable: this.fail.errorClass === 'TRANSIENT',
        problem: { code: this.fail.errorClass.toLowerCase(), message: this.fail.message ?? 'fail' },
      };
    const k = ctx.idempotencyKey ?? `${op}:${doc.id}`;
    const prev = this.received.get(k);
    if (prev)
      return { ok: true, externalId: prev.externalId, externalDocNo: `ERP-${prev.externalId}` };
    const externalId = `ext-${this.received.size + 1}`;
    this.received.set(k, { op, externalId, ctx });
    return { ok: true, externalId, externalDocNo: `ERP-${externalId}` };
  }

  async pushInvoice(ctx: ErpContext, inv: CanonicalDocument): Promise<PushResult> {
    return this.push('pushInvoice', ctx, inv);
  }

  async pushCreditNote(ctx: ErpContext, note: CanonicalDocument): Promise<PushResult> {
    return this.push('pushCreditNote', ctx, note);
  }

  async fetchDocument(ctx: ErpContext, ref: ExternalRef): Promise<CanonicalDocument | null> {
    this.calls.push({ op: 'fetchDocument', ctx });
    return ref.externalId ? { id: ref.localId, number: ref.number } : null;
  }

  reset() {
    this.received.clear();
    this.calls = [];
    this.fail = undefined;
    this.health = undefined;
  }
}
