import type { ErpCapability } from '@tms/domain';
import {
  type CanonicalInvoicePayload,
  type CanonicalParty,
  type CanonicalSettlementPayload,
  isCanonicalInvoice,
  isCanonicalSettlement,
} from '../../modules/erp/canonical';
import type {
  CanonicalInvoice,
  CanonicalSettlement,
  ConnectorConfigField,
  ErpAdapter,
  ErpContext,
  HealthResult,
  PushResult,
} from '../../modules/erp/erp-adapter';
import { AS_HEALTH_TIMEOUT_MS, asCall, fail, type HttpOpts } from './accountsystem-http';
import { accountSystemInbound } from './accountsystem-inbound';
import {
  AS_CONTACT_SOURCE,
  type AsDraftDocument,
  invoiceDraft,
  settlementDraft,
} from './accountsystem-payload';

/**
 * AccountSystemAdapter (ST8-T16; plan/05 D-54–D-58; plan/00b RB-23) — ระบบบัญชีของ Innovera หลัง `ErpAdapter`
 * core ไม่รู้จักไฟล์นี้ (ลงทะเบียนผ่าน `src/erp-adapters/index.ts` เท่านั้น — lint-adapters กฎ 4 ห้ามชื่อนี้ใน core)
 *
 * - capabilities: `pushInvoice` (ใบแจ้งหนี้ที่ออกเลข → **IV ร่าง**) + `pushSettlement` (ใบสำคัญจ่ายที่จ่ายแล้ว → **AP ร่าง** + WHT ประมาณการ)
 *   + webhook ขาเข้า (`inbound`) · ไม่มี pushCreditNote/replaceDocument → ยกเลิกใบใน TMS = งานยกเลิกด้วยมือ (AccountSystem ไม่มี API void)
 * - `taxDocumentOwner = ERP` ตายตัว (D-55 — AccountSystem ออกใบกำกับภาษี/ใบเสร็จ/ใบลด-เพิ่มหนี้/50 ทวิ/รายงานภาษี)
 * - กันซ้ำ: `external_source` (`tms.invoice`/`tms.settlement`) + `external_ref` = เลข TMS → AccountSystem คืน id เดิม (`created:false`)
 * - คู่ค้า (`contact_code`): รหัสลูกค้าฝั่ง ERP จาก mapping ถ้ามี (`customer.externalId` — ST7-T15/ST8-T05) → ไม่มี:
 *   `contactMatch=taxId` (ค่าเริ่ม) = `PUT ext/v1/contacts` จับคู่ด้วยเลขผู้เสียภาษี + สาขา (หรือรหัส TMS เมื่อไม่มีเลข) — ไม่พบ AccountSystem สร้าง `EXT-####`
 *   · `contactMatch=tmsCode` = ใช้รหัสลูกค้า/รถร่วมของ TMS ตรง ๆ (ต้องตั้งรหัสเดียวกันใน AccountSystem ก่อน — ไม่พบ = 422 VALIDATION)
 * - ค่าตั้ง: `baseUrl` (origin ของ accounting-api) · credential `apiKey` (`inn_…` — scope `documents:draft`, `documents:read`
 *   และ `contacts:draft` เมื่อจับคู่ด้วยเลขภาษี) · credential `webhookSecret` (`whsec_…` จาก `POST ext/v1/webhooks`)
 * - healthCheck = `GET ext/v1/documents?external_ref=…` (+ `PUT ext/v1/contacts []` เมื่อจับคู่ด้วยเลขภาษี) ผ่าน HTTP client กัน SSRF
 */
export const ACCOUNTSYSTEM_ADAPTER_KEY = 'accountsystem';

const CAPS: readonly ErpCapability[] = Object.freeze([
  'pushInvoice',
  'pushSettlement',
] as ErpCapability[]);
const HEALTH_REF = '__tms_health_check__';

export class AccountSystemAdapter implements ErpAdapter {
  readonly key = ACCOUNTSYSTEM_ADAPTER_KEY;
  readonly displayName = 'AccountSystem';
  readonly configFields: readonly ConnectorConfigField[] = Object.freeze([
    { key: 'baseUrl', secret: false, required: true, kind: 'url', maxLength: 300 },
    { key: 'apiKey', secret: true, required: true, kind: 'string', maxLength: 200 },
    { key: 'webhookSecret', secret: true, required: false, kind: 'string', maxLength: 200 },
    {
      key: 'contactMatch',
      secret: false,
      required: false,
      kind: 'string',
      maxLength: 20,
      options: ['taxId', 'tmsCode'],
    },
  ] satisfies ConnectorConfigField[]);
  readonly fixedSystemOfRecord = Object.freeze({ taxDocumentOwner: 'ERP' as const });
  readonly inbound = accountSystemInbound;

  /** test: ตัวเลือกของ HTTP client (เช่น ยอม 127.0.0.1 ของ mock) */
  constructor(private readonly http: HttpOpts = {}) {}

  capabilities(): ReadonlySet<ErpCapability> {
    return new Set(CAPS);
  }

  async healthCheck(ctx: ErpContext): Promise<HealthResult> {
    const r = await asCall(
      ctx,
      'GET',
      `/ext/v1/documents?external_ref=${HEALTH_REF}&external_source=tms.health`,
      undefined,
      this.http,
      AS_HEALTH_TIMEOUT_MS,
    );
    if (!r.ok) return r;
    if (!Array.isArray(r.json))
      return fail(
        'VALIDATION',
        'unexpected_response',
        'not an AccountSystem ext/v1 API — check baseUrl',
      );
    if (this.contactMode(ctx) === 'taxId') {
      const c = await asCall(ctx, 'PUT', '/ext/v1/contacts', [], this.http, AS_HEALTH_TIMEOUT_MS);
      if (!c.ok) return c;
    }
    return { ok: true, detail: { contactMatch: this.contactMode(ctx) } };
  }

  async pushInvoice(ctx: ErpContext, doc: CanonicalInvoice): Promise<PushResult> {
    if (!isCanonicalInvoice(doc)) return fail('VALIDATION', 'invalid_payload', 'not an invoice');
    const inv = doc as CanonicalInvoicePayload;
    const contact = await this.contactCode(ctx, inv.customer, 'customer');
    if (!contact.ok) return contact;
    let draft: AsDraftDocument;
    try {
      draft = invoiceDraft(ctx, inv, contact.code);
    } catch (e) {
      return fail('VALIDATION', 'invalid_payload', String((e as Error).message));
    }
    return this.create(ctx, draft);
  }

  async pushSettlement(ctx: ErpContext, doc: CanonicalSettlement): Promise<PushResult> {
    if (!isCanonicalSettlement(doc))
      return fail('VALIDATION', 'invalid_payload', 'not a settlement');
    const s = doc as CanonicalSettlementPayload;
    const contact = await this.contactCode(ctx, s.carrier, 'carrier');
    if (!contact.ok) return contact;
    let draft: AsDraftDocument;
    try {
      draft = settlementDraft(ctx, s, contact.code);
    } catch (e) {
      return fail('VALIDATION', 'invalid_payload', String((e as Error).message));
    }
    return this.create(ctx, draft);
  }

  private contactMode(ctx: ErpContext): 'taxId' | 'tmsCode' {
    return ctx.config.contactMatch === 'tmsCode' ? 'tmsCode' : 'taxId';
  }

  /** รหัสคู่ค้าฝั่ง AccountSystem */
  private async contactCode(
    ctx: ErpContext,
    p: CanonicalParty & { externalId?: string | null; entityType?: string },
    role: 'customer' | 'carrier',
  ): Promise<{ ok: true; code: string } | Extract<PushResult, { ok: false }>> {
    if (p.externalId) return { ok: true, code: p.externalId };
    if (this.contactMode(ctx) === 'tmsCode') return { ok: true, code: p.code };
    const row = {
      ...(p.taxId ? { tax_id: p.taxId, branch_code: p.branchCode ?? null } : {}),
      external_source: AS_CONTACT_SOURCE[role],
      external_ref: p.code,
      name: p.legalName,
      kind: role === 'customer' ? 'customer' : 'vendor',
    };
    const r = await asCall(ctx, 'PUT', '/ext/v1/contacts', [row], this.http);
    if (!r.ok) return r;
    const code = Array.isArray(r.json) ? (r.json[0] as { code?: unknown } | undefined)?.code : null;
    if (typeof code !== 'string' || !code)
      return fail('TRANSIENT', 'invalid_response', 'contacts sync returned no code');
    return { ok: true, code };
  }

  private async create(ctx: ErpContext, draft: AsDraftDocument): Promise<PushResult> {
    const r = await asCall(ctx, 'POST', '/ext/v1/documents', draft, this.http);
    if (!r.ok) return r;
    const j = r.json as { id?: unknown; created?: unknown } | null;
    if (!j || typeof j.id !== 'string' || !j.id)
      return fail('TRANSIENT', 'invalid_response', 'AccountSystem returned no document id');
    return {
      ok: true,
      externalId: j.id,
      raw: { created: j.created === true, docType: draft.doc_type },
    };
  }
}
