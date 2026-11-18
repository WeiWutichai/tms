import {
  CONNECTOR_KEY_RE,
  ERP_CAPABILITIES,
  ERP_FLAG_CAPABILITIES,
  type ErpCapability,
  isErpCapability,
} from '@tms/domain';
import type { ErrorClass } from '../integration/outbox.types';
import type { PullPage } from '../connectors/order-source.port';

/**
 * สัญญากลางของทุก ERP / โปรแกรมบัญชี (ST7-T13; docs/01 §6.1 `ErpAdapter`; docs/04 G3)
 *
 * - core รู้จักแค่ interface นี้ + `capabilities()` — **ห้าม import adapter ใดตรง ๆ** (ตรวจด้วย `scripts/lint-adapters.mjs`)
 *   adapter อยู่ใต้ `src/erp-adapters/<key>/` และลงทะเบียนผ่าน `src/erp-adapters/index.ts` (composition root ที่เดียว)
 * - ไม่มี connector = `STANDALONE_ADAPTER` (capabilities ว่าง) → ทุก flow เดินใน TMS เอง (docs/01 §1 #1)
 * - adapter **ห้ามเขียนฐานข้อมูล TMS** และห้ามถือ transaction — core เรียกนอก transaction แล้วบันทึกผลเอง
 * - error ของปลายทาง → คืน `PushResult.ok=false` พร้อม `ErrorClass` กลาง (docs/01 §6.3) ไม่ใช่ HTTP code ของ ERP;
 *   throw = TRANSIENT (outbox ลองใหม่) · ห้ามมี credential ใน `problem`/`raw`/`message` (contract test ตรวจ)
 * - implementation จริง: StandaloneProvider/DemoProvider (ST7-T14), FileExportAdapter (ST7-T23), KrsAdapter (ST8-T03)
 * - canonical payload ละเอียด (docs/01 §7) มาใน ST7-T15 — ที่นี่ประกาศเฉพาะช่องที่ทุก adapter อาศัย
 */

/**
 * ช่องตั้งค่าของ adapter (หน้า connector ST7-T20 สร้างฟอร์มจากรายการนี้ — ป้ายภาษาไทยอยู่ใน i18n ของเว็บตาม key)
 * กติกา `secret` (ST7-T13):
 * - ค่าใดที่ใช้ยืนยันตัวตน/ให้สิทธิ์ (API key, password, client secret, token, private key, connection string ที่มีรหัสผ่าน) **ต้อง** `secret: true`
 * - `secret: true` → เก็บใน `connector.credentials_enc` (FieldCipher) · ส่งผ่าน `PUT /connectors/{id}/credentials` หรือ `credentials` ตอนสร้าง
 *   · API คืนแค่ชื่อช่องใน `credentialKeys` · audit บันทึกแค่ชื่อช่อง · ข้อความ error ถูกตัดค่า (ตัวจริง/URL-encoded/base64)
 * - `secret: false` → เก็บใน `connector.settings` แบบอ่านได้ ส่งกลับทาง API — ใช้กับค่าที่เปิดเผยได้เท่านั้น (base URL, รหัสบริษัท, timeout)
 * - ห้ามใส่ credential ใน URL ของช่อง `kind: 'url'` (เช่น `https://user:pass@…`) — แยกเป็นช่อง secret
 * - เปลี่ยนช่องจาก secret เป็นไม่ secret (หรือกลับกัน) = ต้องย้ายข้อมูลของ connector เดิม — ห้ามทำโดยไม่มี migration
 */
export interface ConnectorConfigField {
  /** a-z/0-9/camelCase */
  readonly key: string;
  /** true = credential: เก็บเข้ารหัส ไม่ส่งกลับทาง API ไม่ลง audit/log */
  readonly secret: boolean;
  readonly required: boolean;
  /** `url` = ต้องเป็น https:// (http:// ได้เฉพาะ dev/test) */
  readonly kind: 'string' | 'url';
  readonly maxLength?: number;
  /**
   * ค่าที่เลือกได้ (ST7-T14) — มี = ค่าต้องอยู่ในรายการ (422 `invalid_option`) · หน้า connector (ST7-T20) แสดงเป็นตัวเลือก
   * ใช้กับช่องที่ไม่ลับเท่านั้น
   */
  readonly options?: readonly string[];
}

/** บริบทของการเรียก adapter 1 ครั้ง — สร้างโดย core ต่อ connector (ไม่ cache ข้ามคำขอ) */
export interface ErpContext {
  tenantId: string;
  /** null = Standalone (ไม่มี connector) */
  connectorId: string | null;
  /** นิติบุคคล TMS ที่ connector ผูก (null = ทุกนิติบุคคล) */
  companyId: string | null;
  /** รหัสบริษัท/สาขาฝั่ง ERP ของเอกสารนี้ (routing ตามนิติบุคคล — docs/04 A4) */
  erpCompanyCode: string | null;
  /** ค่าตั้ง (settings + credential ที่ถอดแล้ว) — อยู่ในหน่วยความจำเท่านั้น ห้าม log/คืนกลับ */
  config: Readonly<Record<string, string>>;
  /** ส่งให้ ERP กันซ้ำ (docs/01 §6.2 ชั้น ERP) — คำสั่งจาก outbox มีเสมอ */
  idempotencyKey?: string;
  /** ยกเลิกเมื่อ lease ของคำสั่งหลุด/ปิด worker */
  signal?: AbortSignal;
}

export interface Problem {
  /** รหัสสั้นของเรา/ERP เช่น `period_closed`, `customer_unmapped` */
  code: string;
  message: string;
  fields?: { field: string; code: string; message: string }[];
}

/** docs/01 §6.1 `PushResult` */
export type PushResult =
  | {
      ok: true;
      externalId: string;
      externalDocNo?: string;
      externalVersion?: string;
      raw?: unknown;
    }
  | { ok: false; errorClass: ErrorClass; retryable: boolean; problem: Problem; raw?: unknown };

export type HealthResult =
  | { ok: true; detail?: Record<string, unknown> }
  | { ok: false; errorClass: ErrorClass; problem: Problem };

/** อ้างอิงเอกสารฝั่ง ERP (จาก external_mapping — ST7-T15) */
export interface ExternalRef {
  entityType: string;
  localId: string;
  /** เลขอ้างอิงของเรา (invoice_no ฯลฯ) — ใช้ค้นถ้ายังไม่มี externalId */
  number: string;
  externalId: string | null;
}

/** ฐานของ canonical payload (docs/01 §7) — ช่องเต็มกำหนดใน ST7-T15 */
export interface CanonicalDocument {
  id: string;
  number: string;
  sync?: { hash: string };
  [field: string]: unknown;
}
export type CanonicalInvoice = CanonicalDocument;
/** credit/debit note (docs/01 §7.3) */
export type CanonicalAdjustment = CanonicalDocument;
export type CanonicalSettlement = CanonicalDocument;

/** สถานะรับชำระจาก ERP — เงินเป็นสตริงทศนิยม 2 ตำแหน่ง (ห้าม float) */
export interface PaymentStatus {
  status: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';
  paidAmount: string;
  /** ISO 8601 */
  paidAt: string | null;
}

export interface ListDocumentsQuery {
  updatedAfter?: string;
  /** เลขอ้างอิงของเรา */
  ref?: string;
  limit: number;
}

// ---------- webhook ขาเข้า (ST7-T22; docs/04 G3 "Inbound webhook ledger" I10) ----------

/** คำขอ webhook ขาเข้า 1 ครั้ง (หลังตรวจ token ใน URL แล้ว) */
export interface InboundRequest {
  /** header ทั้งหมด (ชื่อตัวพิมพ์เล็ก) */
  readonly headers: Readonly<Record<string, string>>;
  /** body ดิบตามที่ได้รับ (ใช้คำนวณลายเซ็น — ห้ามแปลงก่อนตรวจ) */
  readonly rawBody: Buffer;
  readonly receivedAt: Date;
}

/** event ที่ adapter แยกจาก body (1 คำขอ = 1 event) */
export interface InboundEvent {
  /** รหัส event ของผู้ให้บริการ (ไม่ซ้ำต่อผู้ให้บริการ) — กันซ้ำด้วย (tenant, provider, eventKey) · 1–200 ตัว */
  eventKey: string;
  /** ชนิด event ของผู้ให้บริการ เช่น `invoice.paid` · 1–100 ตัว */
  type: string;
  /** เวลาที่เกิดฝั่งผู้ให้บริการ (ISO 8601) ถ้ามี */
  occurredAt?: string | null;
}

/**
 * สิ่งที่ core ทำต่อหลัง adapter ประมวลผลสำเร็จ (ไม่ผูก ERP ใด) — ทำเฉพาะเมื่อ connector เปิด capability นั้น
 * `pullOrders` = ตั้งรอบดึง order ทันที (ไม่รอรอบ 5 นาที — ไม่สร้างซ้ำถ้ามีรอบค้าง)
 */
export type InboundTrigger = 'pullOrders';
export const INBOUND_TRIGGERS: readonly InboundTrigger[] = ['pullOrders'];

export type InboundHandleResult =
  | { ok: true; triggers?: readonly InboundTrigger[]; summary?: Record<string, unknown> }
  | { ok: false; retryable: boolean; problem: Problem };

/**
 * ความสามารถรับ webhook ขาเข้า (ไม่บังคับ — ไม่มี = URL รับ webhook ของ connector นี้ตอบ 401 เสมอ)
 * ไม่ใช่ `Capability` ของ docs/01 §6.1 (ไม่มีสวิตช์ต่อ tenant — เปิด/ปิดด้วยการออก/เพิกถอน token ของ connector)
 * - `verify` ตรวจลายเซ็นกับ credential ของ connector (ctx.config) **ก่อน** core เขียนอะไรลงฐาน — false/throw = 401 ·
 *   ต้องเทียบแบบเวลาคงที่ และปฏิเสธ timestamp เก่า (กัน replay) ถ้าผู้ให้บริการส่งมา · ห้ามมีผลข้างเคียง
 * - `parse` เรียกหลังลายเซ็นผ่านเท่านั้น — null = รูปแบบที่ไม่รู้จัก (400) · ห้ามเรียกภายนอก
 * - `handle` เรียกใน worker (นอก transaction) ครั้งเดียวต่อ event ที่บันทึกใหม่ (ctx.idempotencyKey = `provider:eventKey`)
 *   · throw = ล้มแบบลองใหม่ได้ · ห้ามเขียนฐาน TMS (คืน `triggers` ให้ core ทำต่อ)
 */
export interface InboundWebhookHandler {
  verify(ctx: ErpContext, req: InboundRequest): boolean | Promise<boolean>;
  parse(ctx: ErpContext, req: InboundRequest): InboundEvent | null;
  handle(
    ctx: ErpContext,
    event: InboundEvent,
    req: Pick<InboundRequest, 'rawBody'>,
  ): Promise<InboundHandleResult>;
}

/**
 * docs/01 §6.1 — method ที่มี ⇔ ประกาศ capability ชื่อเดียวกัน (`adapterShapeProblems`)
 * ธง `postedStatus` / `ownsDocumentNumber` ไม่มี method
 */
export interface ErpAdapter {
  /** รหัส connector (CONNECTOR_KEY_RE) = `connector.adapter_key` — ห้ามซ้ำ, `standalone` สงวนไว้ */
  readonly key: string;
  /** ชื่อแสดง (ชื่อผลิตภัณฑ์) — UI แสดงเฉพาะเมื่อเปิดใช้ (spec/07 INT-010) */
  readonly displayName: string;
  readonly configFields: readonly ConnectorConfigField[];
  /**
   * adapter จำลอง (Demo) — ลงทะเบียน/เปิดได้เฉพาะ dev/test/staging ที่อนุญาต · catalog (`GET /connectors/adapters`)
   * แสดง `demo: true` ให้หน้าจอติดป้าย "จำลอง" (ST7-T14) · ไม่มีวันเป็นค่าเริ่มต้น (ไม่มี connector = Standalone เสมอ)
   */
  readonly localOnly?: boolean;
  capabilities(): ReadonlySet<ErpCapability>;
  /** ไม่ throw — ปลายทางล่ม/credential ผิด = `{ok:false}` */
  healthCheck(ctx: ErpContext): Promise<HealthResult>;

  /** inbound — สัญญาเดียวกับ OrderSourcePort (ST3-T05): core แปลงต่อและเรียก upsert ทางเดียวกับ API */
  pullOrders?(ctx: ErpContext, since: string | null, limit: number): Promise<PullPage>;
  pushInvoice?(ctx: ErpContext, inv: CanonicalInvoice): Promise<PushResult>;
  /** ใช้ทั้ง credit/debit note */
  pushCreditNote?(ctx: ErpContext, note: CanonicalAdjustment): Promise<PushResult>;
  pushSettlement?(ctx: ErpContext, stl: CanonicalSettlement): Promise<PushResult>;
  /** แก้ทั้งใบ (fallback เมื่อไม่มี pushCreditNote — docs/01 §6.1) */
  replaceDocument?(ctx: ErpContext, ref: ExternalRef, inv: CanonicalInvoice): Promise<PushResult>;
  fetchDocument?(ctx: ErpContext, ref: ExternalRef): Promise<CanonicalDocument | null>;
  fetchPaymentStatus?(ctx: ErpContext, ref: ExternalRef): Promise<PaymentStatus | null>;
  listDocuments?(
    ctx: ErpContext,
    q: ListDocumentsQuery,
  ): Promise<{ items: ExternalRef[]; next: string | null }>;
  /** ST7-T22 webhook ขาเข้า (ไม่บังคับ) */
  readonly inbound?: InboundWebhookHandler;
}

/** capability → ชื่อ method (ธงไม่มี method) */
export const CAPABILITY_METHOD = {
  pullOrders: 'pullOrders',
  pushInvoice: 'pushInvoice',
  pushCreditNote: 'pushCreditNote',
  pushSettlement: 'pushSettlement',
  replaceDocument: 'replaceDocument',
  fetchDocument: 'fetchDocument',
  fetchPaymentStatus: 'fetchPaymentStatus',
  listDocuments: 'listDocuments',
} as const satisfies Partial<Record<ErpCapability, keyof ErpAdapter>>;

export const STANDALONE_KEY = 'standalone';
const CONFIG_KEY_RE = /^[a-z][a-zA-Z0-9]{0,39}$/;

/**
 * ตรวจรูปของ adapter (ใช้ตอนลงทะเบียน + contract test) — คืนรายการปัญหา (ว่าง = ผ่าน)
 * method ที่มี ⇔ capability ที่ประกาศ: ประกาศแต่ไม่มี method = core เรียกแล้วพัง · มี method แต่ไม่ประกาศ = UI ซ่อนสิ่งที่ทำได้
 */
export function adapterShapeProblems(a: ErpAdapter): string[] {
  const out: string[] = [];
  if (!CONNECTOR_KEY_RE.test(a.key)) out.push(`key '${a.key}' must match ${CONNECTOR_KEY_RE}`);
  if (!a.displayName?.trim()) out.push('displayName required');
  let caps: ReadonlySet<string>;
  try {
    caps = a.capabilities();
  } catch (e) {
    return [...out, `capabilities() threw: ${String(e)}`];
  }
  if (!(caps instanceof Set)) return [...out, 'capabilities() must return a Set'];
  for (const c of caps) if (!isErpCapability(c)) out.push(`unknown capability '${String(c)}'`);
  for (const c of ERP_CAPABILITIES) {
    if (ERP_FLAG_CAPABILITIES.includes(c)) continue;
    const m = CAPABILITY_METHOD[c as keyof typeof CAPABILITY_METHOD];
    const has = typeof (a as unknown as Record<string, unknown>)[m] === 'function';
    if (caps.has(c) && !has) out.push(`capability '${c}' declared but method ${m}() missing`);
    if (!caps.has(c) && has) out.push(`method ${m}() present but capability '${c}' not declared`);
  }
  if (typeof a.healthCheck !== 'function') out.push('healthCheck() required');
  if (a.inbound !== undefined)
    for (const m of ['verify', 'parse', 'handle'] as const)
      if (typeof a.inbound?.[m] !== 'function') out.push(`inbound.${m}() required`);
  const seen = new Set<string>();
  for (const f of a.configFields ?? []) {
    if (!CONFIG_KEY_RE.test(f.key)) out.push(`config field key '${f.key}' invalid`);
    if (seen.has(f.key)) out.push(`config field '${f.key}' repeated`);
    seen.add(f.key);
    if (f.kind !== 'string' && f.kind !== 'url')
      out.push(`config field '${f.key}' kind must be string|url`);
    if (f.options !== undefined) {
      if (f.secret) out.push(`config field '${f.key}' is secret — options not allowed`);
      if (
        !Array.isArray(f.options) ||
        !f.options.length ||
        f.options.some((o) => typeof o !== 'string' || !o)
      )
        out.push(`config field '${f.key}' options must be non-empty strings`);
    }
  }
  return out;
}

/**
 * "ไม่เชื่อม — ใช้ TMS ออกเอกสารเอง" (spec/07 §1 การ์ดแรก; docs/01 §6.1 `StandaloneAdapter`)
 * ค่าเริ่มต้นของทุก tenant/นิติบุคคลที่ไม่มี connector — ไม่มี capability ใด, healthCheck ผ่านเสมอ, ไม่ติดต่อภายนอก
 * อยู่ใน core เพราะเป็นความหมายของ "ไม่มี connector" ไม่ใช่ ERP ตัวหนึ่ง (= `StandaloneProvider` ของ docs/04 G3 — ST7-T14)
 * flow เอกสารถามว่ามีขั้น sync ไหมจาก `documentSyncMode(capabilities, …)` ของ @tms/domain (Standalone = NOT_APPLICABLE ทุกประเภท)
 */
export const STANDALONE_ADAPTER: ErpAdapter = Object.freeze({
  key: STANDALONE_KEY,
  displayName: 'Standalone',
  configFields: Object.freeze([]) as readonly ConnectorConfigField[],
  capabilities: () => new Set<ErpCapability>(),
  healthCheck: async () => ({ ok: true as const }),
});
