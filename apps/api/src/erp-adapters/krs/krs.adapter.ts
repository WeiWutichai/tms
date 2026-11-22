import type { ErpCapability, ErpOperation } from '@tms/domain';
import type { PullPage } from '../../modules/connectors/order-source.port';
import {
  type CanonicalDocument,
  type CanonicalInvoice,
  type ConnectorConfigField,
  type ErpAdapter,
  type ErpContext,
  type ExternalRef,
  type HealthResult,
  type MasterCodeReadiness,
  type MasterCodeRef,
  notImplementedError,
  notImplementedResult,
  type PushResult,
} from '../../modules/erp/erp-adapter';
import { safeHttpRequest, type SendOptions } from '../../modules/webhooks/webhook-http';
import { krsMasterCodeRefs, krsPushReadiness } from './krs-master-codes';
import { probeKrsSoSource, pullKrsOrders } from './krs-so-poller';

/**
 * KrsAdapter — โครง (ST8-T03; docs/04 G4 KRS; docs/01 Appendix A.1–A.2, A.5) · KRS เป็นแค่ adapter หนึ่งหลัง `ErpAdapter`
 * core ไม่รู้จักไฟล์นี้ (ลงทะเบียนผ่าน `src/erp-adapters/index.ts` เท่านั้น)
 *
 * - capabilities ตาม docs/01 A.2: `{pullOrders, pushInvoice, fetchDocument, replaceDocument}` + ธง `ownsDocumentNumber`
 *   (KRS ออก `voucherNo` เอง) — **ไม่มี** pushCreditNote / pushSettlement / fetchPaymentStatus / postedStatus / listDocuments
 *   และไม่ดึงผังรหัส (`masterCodeKinds` ว่าง — plan/11 #8: ไม่มี getMasters → นำเข้าไฟล์ ST7-T18)
 * - ST8-T06 `masterCodeRefs`: หน่วย/พนักงานขาย (บังคับ) + itemCode/accountCode ต้องอยู่ใน `erp_master_code` ก่อนส่ง (`krs-master-codes.ts`)
 * - pullOrders = ST8-T04 (ทำแล้ว — `krs-so-poller.ts`)
 * - method ของโครงยังไม่ทำ → `pendingCapabilities` + ตอบ CAPABILITY `not_implemented` (core พักคำสั่งไว้ ไม่ทิ้ง):
 *   pushInvoice = ST8-T08, replaceDocument = ST8-T09/T11, fetchDocument = ST8-T10
 * - ค่าตั้ง: `baseUrl` (เช่น `https://api-pueanphet.krs.co.th/api`), credential `apiKey` (header `X-API-Key` — เข้ารหัส FieldCipher, write-only),
 *   SQL Server login แบบอ่านอย่างเดียว (`sqlServer`/`sqlDatabase`/`sqlUser` + credential `sqlPassword`) **เก็บไว้เฉย ๆ** จนกว่า KRS เลือกทาง view SQL (ST8-T04 อ่านผ่าน HTTP stub)
 *   (ยังไม่มี dependency SQL Server — ST8-T02 อ่าน SO ผ่าน HTTP stub `GET /salesorder?since=`: `krs-so-source.ts`) · `healthTransactionNo` = เลข `transactionNo` ของใบที่รู้จักแล้ว ใช้ทดสอบ (docs/01 A.2)
 * - healthCheck = `GET {baseUrl}/invoice/{healthTransactionNo | 0}` ผ่าน HTTP client กัน SSRF ตัวเดียวกับ webhook
 *   (resolve + ตรวจ IP + ต่อด้วย address ที่ตรวจแล้ว · ไม่ follow redirect · timeout 10 วิ):
 *   200/404 = ถึงปลายทางและ key ใช้ได้ (KRS ตรวจ key ก่อนหาใบ — A.1) · 401/403 = AUTH · 503/5xx/429/timeout/เครือข่าย = TRANSIENT
 *   (core หยุดคิวของ connector — `HEALTH_STOP_CLASSES`) · อื่น ๆ (3xx/400/405) = VALIDATION (ค่าตั้ง baseUrl น่าจะผิด)
 *   **[OPEN — KRS]** ไม่มี endpoint health เฉพาะ — ถ้า baseUrl ชี้ผิด path แต่ host ตอบ 404 จะดูเหมือนผ่าน (plan/08)
 * - ข้อความ error ไม่มี credential (ไม่ใส่ header/URL ที่มี key — key อยู่ใน header เท่านั้น)
 */
export const KRS_ADAPTER_KEY = 'krs';

/** เวลารอคำตอบของ healthCheck (core ตัดที่ 15 วิอีกชั้น) */
export const KRS_HEALTH_TIMEOUT_MS = 10_000;
/** เลขที่ใช้ทดสอบเมื่อยังไม่ตั้ง `healthTransactionNo` — ไม่มีใบนี้ = 404 (แปลว่าถึงปลายทาง + key ใช้ได้) */
export const KRS_HEALTH_PROBE_DEFAULT = '0';

const CAPS: readonly ErpCapability[] = Object.freeze([
  'pullOrders',
  'pushInvoice',
  'fetchDocument',
  'replaceDocument',
  'ownsDocumentNumber',
] as ErpCapability[]);

export class KrsAdapter implements ErpAdapter {
  readonly key = KRS_ADAPTER_KEY;
  readonly displayName = 'KRS';
  readonly configFields: readonly ConnectorConfigField[] = Object.freeze([
    { key: 'baseUrl', secret: false, required: true, kind: 'url', maxLength: 300 },
    { key: 'apiKey', secret: true, required: true, kind: 'string', maxLength: 500 },
    { key: 'healthTransactionNo', secret: false, required: false, kind: 'string', maxLength: 40 },
    /** ST8-T06 รหัสพนักงานขายของ KRS (`salePerson` หัวใบ — ต้องอยู่ในผังรหัส SALESPERSON; docs/01 A.3) */
    { key: 'salePerson', secret: false, required: false, kind: 'string', maxLength: 64 },
    /** SQL Server read-only (docs/01 A.4) — ใช้เมื่อ KRS เลือกทาง view SQL ([OPEN — KRS] KRS-11) */
    { key: 'sqlServer', secret: false, required: false, kind: 'string', maxLength: 200 },
    { key: 'sqlDatabase', secret: false, required: false, kind: 'string', maxLength: 128 },
    { key: 'sqlUser', secret: false, required: false, kind: 'string', maxLength: 128 },
    { key: 'sqlPassword', secret: true, required: false, kind: 'string', maxLength: 200 },
  ] satisfies ConnectorConfigField[]);

  /** ST8-T07 สัญญา KRS บังคับ `carPerson` ทุกรายการ (docs/01 A.3) → ต้องมีชื่อคนขับใน canonical */
  readonly personalDataNeeds = Object.freeze(['trip.driverName'] as const);

  /** test: ตัวเลือกของ HTTP client (เช่น resolver) */
  constructor(private readonly http: Pick<SendOptions, 'allowPrivate' | 'resolver'> = {}) {}

  capabilities(): ReadonlySet<ErpCapability> {
    return new Set(CAPS);
  }

  /**
   * โครง: ทุก capability ยังไม่ได้ทำ → core ไม่เปิดเป็นค่าเริ่มต้น เปิดไม่ได้ แสดง "ยังไม่รองรับ" และพักคำสั่งที่ค้าง
   * (เอาออกจากรายการเมื่อทำเสร็จ — pullOrders ทำแล้ว ST8-T04; ค้าง: pushInvoice + ownsDocumentNumber ST8-T08, replaceDocument ST8-T09/T11, fetchDocument ST8-T10)
   */
  readonly pendingCapabilities: readonly ErpCapability[] = Object.freeze(
    CAPS.filter((c) => c !== 'pullOrders'),
  );

  /** ST8-T06 ค่าที่ต้องอยู่ในผังรหัส KRS ก่อนส่ง (หน่วย/พนักงานขาย/itemCode/accountCode — `krs-master-codes.ts`) */
  masterCodeRefs(
    ctx: ErpContext,
    operation: ErpOperation,
    doc: CanonicalDocument,
  ): readonly MasterCodeRef[] {
    return krsMasterCodeRefs(ctx, operation, doc);
  }

  /** ST8-T06 ต้องมีพนักงานขายในผัง + ผังหน่วย ก่อนเปิดส่งใบ */
  pushReadiness(ctx: ErpContext): MasterCodeReadiness {
    return krsPushReadiness(ctx);
  }

  async healthCheck(ctx: ErpContext): Promise<HealthResult> {
    const base = (ctx.config.baseUrl ?? '').trim().replace(/\/+$/, '');
    const key = ctx.config.apiKey ?? '';
    if (!base) return fail('VALIDATION', 'config_missing', 'baseUrl is not set');
    if (!key) return fail('AUTH', 'credentials_missing', 'apiKey is not set');
    const probe = (ctx.config.healthTransactionNo ?? '').trim() || KRS_HEALTH_PROBE_DEFAULT;
    const r = await safeHttpRequest(
      'GET',
      `${base}/invoice/${encodeURIComponent(probe)}`,
      { 'X-API-Key': key, Accept: 'application/json' },
      '',
      { timeoutMs: KRS_HEALTH_TIMEOUT_MS, signal: ctx.signal, ...this.http },
    );
    if (r.status === null) {
      switch (r.errorCode) {
        case 'timeout':
          return fail(
            'TRANSIENT',
            'timeout',
            `KRS did not answer within ${KRS_HEALTH_TIMEOUT_MS} ms`,
          );
        case 'network':
        case 'aborted':
          return fail('TRANSIENT', 'unreachable', `KRS unreachable: ${r.errorMessage ?? ''}`);
        case 'ssrf_blocked':
          return fail('VALIDATION', 'url_not_allowed', r.errorMessage ?? 'destination not allowed');
        default:
          return fail('VALIDATION', 'invalid_request', r.errorMessage ?? 'cannot build request');
      }
    }
    if (r.status === 200 || r.status === 404) {
      // ST8-T04 เปิด pullOrders = แหล่ง SO ต้องอ่านได้ด้วย (view/คอลัมน์เสีย → ไม่ผ่าน คง ERROR พร้อมเหตุเดิม)
      if (ctx.capabilitiesEnabled?.includes('pullOrders')) {
        const so = await probeKrsSoSource(ctx, this.http);
        if (so) return fail(so.errorClass, so.code, so.message);
      }
      return {
        ok: true,
        detail: { probe: r.status === 200 ? 'found' : 'not_found', durationMs: r.durationMs },
      };
    }
    if (r.status === 401 || r.status === 403)
      return fail('AUTH', 'unauthorized', `KRS rejected the API key (HTTP ${r.status})`);
    if (r.status === 503)
      return fail('TRANSIENT', 'service_unavailable', 'KRS database unavailable (HTTP 503)');
    if (r.status === 429 || r.status >= 500)
      return fail('TRANSIENT', `http_${r.status}`, `KRS answered HTTP ${r.status}`);
    return fail('VALIDATION', `http_${r.status}`, `unexpected HTTP ${r.status} — check baseUrl`);
  }

  /**
   * ST8-T04 SO poller (docs/01 A.2/A.4) — อ่านแหล่ง SO แบบ watermark (`krs-so-source.ts`) → ExternalOrder
   * `KRS-{company}-{soNo}` (รายละเอียด/กรณีผิดปกติ: `krs-so-poller.ts`) · ทาง SQL read-only view ทำเมื่อ KRS เลือกทาง A
   */
  async pullOrders(ctx: ErpContext, since: string | null, limit: number): Promise<PullPage> {
    return pullKrsOrders(ctx, since, limit, this.http);
  }

  // ---------- capability ที่ยังไม่ทำ (โครง) ----------

  /** ST8-T08 — `POST /invoice` (docs/01 A.2/A.3) */
  async pushInvoice(_ctx: ErpContext, _inv: CanonicalInvoice): Promise<PushResult> {
    return notImplementedResult('pushInvoice');
  }

  /** ST8-T09/T11 — `PUT /invoice/{transactionNo}` (fallback ของ credit/debit note — docs/01 A.2) */
  async replaceDocument(
    _ctx: ErpContext,
    _ref: ExternalRef,
    _inv: CanonicalInvoice,
  ): Promise<PushResult> {
    return notImplementedResult('replaceDocument');
  }

  /** ST8-T10 — `GET /invoice/{transactionNo}` → CanonicalInvoice */
  async fetchDocument(_ctx: ErpContext, _ref: ExternalRef): Promise<CanonicalDocument | null> {
    throw notImplementedError('fetchDocument');
  }
}

function fail(
  errorClass: Exclude<HealthResult, { ok: true }>['errorClass'],
  code: string,
  message: string,
): HealthResult {
  return { ok: false, errorClass, problem: { code, message: message.slice(0, 300) } };
}
