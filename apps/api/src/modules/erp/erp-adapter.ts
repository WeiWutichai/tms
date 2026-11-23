import {
  CONNECTOR_KEY_RE,
  ERP_CAPABILITIES,
  ERP_FLAG_CAPABILITIES,
  type ErpCapability,
  type ErpMasterCodeKind,
  type ErpOperation,
  isErpCapability,
  type SorOwner,
  isErpMasterCodeKind,
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
 * - implementation จริง: StandaloneProvider/DemoProvider (ST7-T14), FileExportAdapter (ST7-T23), adapter `krs` (ST8-T03)
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
  /**
   * ST8-T04 capability ที่ tenant เปิดกับ connector นี้ (`capabilities_enabled`) — adapter ใช้ตัดสินว่า healthCheck
   * ต้องตรวจส่วนไหน (เช่น เปิด pullOrders = ตรวจแหล่ง SO ด้วย) · ไม่มี = ไม่รู้ (contract test / Standalone)
   */
  capabilitiesEnabled?: readonly string[];
  /**
   * ST8-T06 ค่าจากเอกสารที่ core ตรวจตาม `masterCodeRefs` ของ adapter แล้ว — ชนิด → (ค่าในเอกสาร trim + ตัวพิมพ์เล็ก → รหัส/ชื่อ)
   * มีเฉพาะตอนส่งคำสั่ง push · payload builder ใช้ `resolvedMasterCode()` / `resolvedMasterCodeName()`
   * ทุกค่าที่ประกาศและไม่ถูกกันอยู่ในนี้: หาเจอในผัง = รหัสตามผัง · ไม่ได้ตรวจ (ช่องไม่บังคับที่ยังไม่มีผัง / CUSTOMER) = **ค่าดิบ** (name null)
   */
  masterCodes?: ResolvedMasterCodes;
  /**
   * ST7-T16 sync log (docs/01 §6.4 "1 แถวต่อ 1 HTTP call"): adapter **ต้อง**เรียกทุกครั้งที่ยิง HTTP ไประบบภายนอก (สำเร็จ/ล้ม)
   * core ตัด credential + เลขบัตรประชาชน, ตัด query string และขนาด body ก่อนเก็บ — adapter ส่งค่าดิบได้ **ยกเว้น header** (ห้ามส่ง)
   * ไม่มี = ไม่บันทึก (เช่น contract test / healthCheck) · ห้าม throw
   */
  onHttpCall?: (call: ErpHttpCall) => void;
  /**
   * ST8-T08 (review H1) เอกสารฝั่ง ERP ที่สร้างไปแล้วจากการส่งเอกสารนี้ครั้งก่อนที่ไม่ครบ (`PushResult.documents` ของผลล้ม) —
   * adapter ที่แยกใบ **ต้องไม่สร้างซ้ำ** ใบที่ `ref` อยู่ในนี้ · ไม่มี = ยังไม่เคยสร้าง
   */
  priorDocuments?: readonly ExternalDocumentPart[];
}

/** ST7-T16 การเรียก HTTP 1 ครั้งของ adapter (ส่งให้ `ErpContext.onHttpCall`) — ไม่มี header */
export interface ErpHttpCall {
  method: string;
  /** URL เต็ม (core เก็บแค่ origin + path) */
  url: string;
  /** body ที่ส่ง (สตริงหรือ object) */
  requestBody?: unknown;
  /** null = ไม่ได้ response (timeout / เครือข่าย) */
  status: number | null;
  responseBody?: unknown;
  /** รหัสสั้นของผล (เช่น `timeout`, `http_503`) */
  errorCode?: string | null;
  durationMs: number;
  /** เวลาเริ่มเรียก (ไม่มี = เวลาที่ core ได้รับรายงาน) */
  at?: Date;
}

/**
 * ST8-T06 ชนิดของค่าที่ adapter ให้ core ตรวจ: ผังรหัส ERP (`erp_master_code`) หรือรหัสคู่ค้าฝั่ง ERP จาก `external_mapping`
 * (`CUSTOMER` = ลูกค้า · `CARRIER` = รถร่วม/ผู้ขาย — ST7-T15)
 */
export type MasterCodeRefKind = ErpMasterCodeKind | 'CUSTOMER' | 'CARRIER';

/** ค่าที่ตรวจแล้ว 1 ค่า */
export interface ResolvedMasterCode {
  code: string;
  /** ชื่อตามผัง (เช่น `saleName` ของ KRS) — ไม่ได้มาจากผัง = null */
  name: string | null;
  /** ST8-T07 true = หาเจอในผังรหัสที่นำเข้าแล้ว · ไม่มี/false = ค่าดิบที่ยังไม่ได้ตรวจกับผัง (ช่องไม่บังคับที่ยังไม่มีผัง / รหัสคู่ค้า) */
  fromCatalogue?: boolean;
}

/**
 * ST8-T07 ข้อมูลส่วนบุคคลใน canonical ที่เป็น "ตัวเลือก" (PDPA — ส่งออกนอก TMS เท่าที่ปลายทางต้องใช้)
 * core **ไม่ใส่** ลง payload ของคำสั่ง เว้นแต่ adapter ของ connector ประกาศใน `ErpAdapter.personalDataNeeds`
 * - `trip.driverName` ชื่อคนขับของเที่ยว — ใส่ตอนสร้าง canonical (อยู่ใน payload ของคำสั่ง)
 * - `carrier.taxId` (D-80) เลขบัตรประชาชนเต็มของรถร่วมบุคคลธรรมดาในใบสำคัญจ่าย — sink ใส่ **ณ ตอนส่ง** เท่านั้น
 *   (payload ที่เก็บในคิว/ผลของคำสั่งไม่มีเลขเต็ม · ลง audit `connector.pii_sent`) — ดู `personal-data.ts`
 */
export type CanonicalPersonalField = 'trip.driverName' | 'carrier.taxId';

/** ST8-T06 ผลตรวจต่อชนิด (key = ค่าในเอกสารแบบ trim + ตัวพิมพ์เล็ก) */
export type ResolvedMasterCodes = Readonly<
  Partial<Record<MasterCodeRefKind, ReadonlyMap<string, ResolvedMasterCode>>>
>;

/** รหัสของค่าจากเอกสาร (ไม่ได้ประกาศใน refs = null) */
export function resolvedMasterCode(
  ctx: Pick<ErpContext, 'masterCodes'>,
  kind: MasterCodeRefKind,
  value: string | null | undefined,
): string | null {
  const v = value?.trim().toLowerCase();
  return (v && ctx.masterCodes?.[kind]?.get(v)?.code) || null;
}

/** ชื่อตามผังของค่าจากเอกสาร (เช่น ชื่อพนักงานขาย) — ไม่มีชื่อ/ไม่ได้มาจากผัง = null */
export function resolvedMasterCodeName(
  ctx: Pick<ErpContext, 'masterCodes'>,
  kind: MasterCodeRefKind,
  value: string | null | undefined,
): string | null {
  const v = value?.trim().toLowerCase();
  return (v && ctx.masterCodes?.[kind]?.get(v)?.name) || null;
}

/**
 * ST8-T06 ค่า 1 ค่าในเอกสารที่ ERP บังคับให้เป็นรหัสที่ ERP รู้จัก — adapter ประกาศ core ตรวจก่อนส่ง
 * (docs/01 §7.4 "รหัสที่ ERP ยอมรับ … validate ก่อนเข้า outbox", A.3 "Validation เฉพาะ KRS")
 * - ชนิดผังรหัส → ต้องอยู่ใน `erp_master_code` ที่ใช้งานของ connector
 * - `CUSTOMER` → ต้องมีรหัสลูกค้าฝั่ง ERP (`customer.externalId` ของ canonical = external_mapping(CUSTOMER) — docs/01 §7.1)
 *   · `CARRIER` → รหัสรถร่วมฝั่ง ERP (`carrier.externalId` = external_mapping(CARRIER) — docs/01 §7.3)
 *   ST7-T15: ก่อนถึง adapter core ใส่ค่าทั้งสองจาก `external_mapping` สถานะ `SYNCED` **ณ ตอนส่ง** (ทับค่าที่ตรึงตอนสร้างคำสั่ง)
 *   → ตรวจ "มีค่า" = ตรวจกับตาราง · ไม่มี = MISSING (`strict`) — แก้ mapping แล้วส่งคำสั่งเดิมใหม่ได้
 */
export interface MasterCodeRef {
  kind: MasterCodeRefKind;
  /** ค่าในเอกสาร · null/ว่าง = ไม่มีค่า (strict = ถูกกัน) */
  value: string | null;
  /** ช่องที่มาของค่า สำหรับแสดงในคิว เช่น `lines[2].unitLabel` · `salePerson` (ห้ามมี credential) */
  field: string;
  /**
   * true = ต้องมีค่าและต้องอยู่ในผังรหัสที่ใช้งาน (ยังไม่มีผังชนิดนี้ = ถูกกัน — ให้นำเข้าผังรหัสก่อน)
   * false = ช่องไม่บังคับ: ตรวจเฉพาะเมื่อมีค่า **และ** connector เคยมีผังชนิดนี้ (กฎเดียวกับ `erpItemMappingStatus`) — ไม่ตรวจ = ใช้ค่าดิบ
   */
  strict: boolean;
  /** หาด้วย "ชื่อ" ของรหัสได้ด้วย (เปิดเฉพาะค่าที่ TMS เก็บเป็นข้อความ เช่น หน่วย "เที่ยว") — ไม่ระบุ = ตรงรหัสเท่านั้น */
  matchByName?: boolean;
}

/**
 * ST8-T06 สิ่งที่ต้องพร้อมก่อนส่งเอกสารเข้า ERP ได้ (ตรวจตอนเปิด capability ส่งเอกสาร และแสดงในผลทดสอบการเชื่อมต่อ)
 * `refs` = ค่าจากค่าตั้งที่ต้องอยู่ในผัง (เช่น พนักงานขายของ KRS) · `catalogues` = ชนิดผังรหัสที่ต้องนำเข้าแล้ว (เช่น หน่วย)
 */
export interface MasterCodeReadiness {
  refs: readonly MasterCodeRef[];
  catalogues: readonly ErpMasterCodeKind[];
}

export interface Problem {
  /** รหัสสั้นของเรา/ERP เช่น `period_closed`, `customer_unmapped` */
  code: string;
  message: string;
  fields?: { field: string; code: string; message: string }[];
}

/**
 * error ที่ adapter โยนพร้อม ErrorClass กลาง (ST8-T03) — ใช้กับ method ที่คืนผลแบบ `PushResult` ไม่ได้
 * (`fetchDocument`, `pullOrders` ฯลฯ) · core (ErpAdapterSink) แปลงเป็นผลของคำสั่งตาม class (`not_implemented` = พักไว้ ฯลฯ)
 * throw แบบอื่น = TRANSIENT เหมือนเดิม · `problem` ห้ามมี credential (core ตัดซ้ำอีกชั้น)
 */
export class ErpAdapterError extends Error {
  constructor(
    readonly errorClass: ErrorClass,
    readonly problem: Problem,
  ) {
    super(problem.message || problem.code);
    this.name = 'ErpAdapterError';
  }
}

/** รหัสของ capability ที่ adapter ประกาศแล้วแต่ยังไม่ได้ทำ (โครง adapter — เช่น adapter `krs` ก่อน ST8-T04/T08/T10) */
export const NOT_IMPLEMENTED = 'not_implemented';

/** ผล push ของ capability ที่ยังไม่ได้ทำ — CAPABILITY `not_implemented` (core พักคำสั่งไว้ ไม่ทิ้ง — ErpAdapterSink) */
export function notImplementedResult(capability: ErpCapability): PushResult {
  return {
    ok: false,
    errorClass: 'CAPABILITY',
    retryable: false,
    problem: { code: NOT_IMPLEMENTED, message: `${capability} is not implemented yet` },
  };
}

/** error ของ capability ที่ยังไม่ได้ทำ (method ที่คืน PushResult ไม่ได้) */
export function notImplementedError(capability: ErpCapability): ErpAdapterError {
  return new ErpAdapterError('CAPABILITY', {
    code: NOT_IMPLEMENTED,
    message: `${capability} is not implemented yet`,
  });
}

/** docs/01 §6.1 `PushResult` */
export type PushResult =
  | {
      ok: true;
      externalId: string;
      externalDocNo?: string;
      externalVersion?: string;
      /**
       * ST7-T15 ERP **ถือเนื้อหาของ payload ครั้งนี้** = true (สร้างใหม่ / แทนที่ หรือ adapter ตรวจแล้วว่าของเดิมตรงกัน) ·
       * false = ERP มีเอกสารนี้อยู่แล้วและ adapter **ยืนยันไม่ได้** ว่าเนื้อหาตรงกับ payload ครั้งนี้ (กันซ้ำด้วย key/เลขอ้างอิง — คืนของเดิม)
       * adapter ต้องตอบตามจริง (contract test บังคับ boolean) — core เลื่อน `last_synced_hash` เฉพาะเมื่อ true;
       * ไม่ระบุ = ถือว่า false (ไม่ยืนยันว่าเนื้อหาตรง)
       */
      applied?: boolean;
      /**
       * ST8-T08 ERP เก็บเอกสาร TMS ใบนี้เป็น**หลายเอกสาร** (เช่น KRS แยกใบตาม `vat_type` / แบ่งใบเมื่อเกินเพดานขนาด — docs/01 A.6)
       * ทุกเอกสารตามลำดับ · ตัวแรก = `externalId` / `externalDocNo` ของผลนี้ (key หลักของ external_mapping) ·
       * core เก็บทั้งรายการใน `external_mapping.detail.documents` · ไม่มี/1 รายการ = เอกสารเดียว (แบบเดิม)
       */
      documents?: readonly ExternalDocumentPart[];
      raw?: unknown;
    }
  | {
      ok: false;
      errorClass: ErrorClass;
      retryable: boolean;
      problem: Problem;
      /**
       * ST8-T08 (review H1/M2) เอกสารฝั่ง ERP ที่ถูกสร้างแล้วจากการส่งเอกสาร TMS ใบนี้ (รวมที่ได้จาก `ctx.priorDocuments`) — ไม่ระบุ = adapter ไม่รายงาน
       * มีรายการ = core เก็บใน external_mapping (ยังไม่ SYNCED) แล้วส่งกลับมาใน `ctx.priorDocuments` รอบถัดไป · `[]` = ไม่มีเอกสารใดถูกสร้าง
       */
      documents?: readonly ExternalDocumentPart[];
      /**
       * true = adapter **รู้แน่** ว่าฝั่ง ERP มีเฉพาะ `documents` (ใบที่ล้มได้คำตอบชัด/ไม่ได้ส่งออกไป) → core ส่งซ้ำได้โดยไม่ต้องค้นก่อน ·
       * false/ไม่ระบุ = อาจมีเอกสารเพิ่ม (timeout / สายหลุด) → core ค้นก่อนส่งซ้ำตามกติกา ST7-T16
       */
      documentsComplete?: boolean;
      raw?: unknown;
    };

/** ST8-T08 จำนวนเอกสารฝั่ง ERP สูงสุดต่อเอกสาร TMS — adapter ที่แยกใบต้องไม่สร้างเกินนี้ (เกิน = VALIDATION ก่อนส่ง) */
export const MAX_EXTERNAL_DOCUMENTS = 200;

/** ST8-T08 เอกสาร 1 ใบฝั่ง ERP ของเอกสาร TMS ที่ถูกแยกเป็นหลายใบ (`PushResult.documents`) */
export interface ExternalDocumentPart {
  /** เลขอ้างอิงที่เราส่ง (เช่น `tmsVoucherNo` ของ KRS) */
  ref: string;
  externalId: string;
  externalDocNo: string | null;
  /** กลุ่มที่แยก (เช่น `vat_type` ของรายการในใบนี้) — ไม่แยกตามกลุ่ม = null */
  group: string | null;
  /** `lineNo` ของ canonical ที่อยู่ในเอกสารนี้ */
  lineNos: readonly number[];
}

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
  /**
   * ST8-T10 เอกสาร TMS ใบนี้อยู่ฝั่ง ERP เป็น**หลายเอกสาร** (`PushResult.documents` / `external_mapping.detail.documents`) —
   * `fetchDocument` ต้องอ่านทุกใบแล้วรวมเป็น canonical เดียว (ลำดับตามที่ส่ง · `externalId` = ใบแรก) · ไม่มี = เอกสารเดียว
   */
  documents?: readonly ExternalDocumentPart[];
}

/**
 * ST8-T10 การเรียก HTTP ที่บันทึกใน sync log แล้ว (body = ข้อความที่ตัด credential/ข้อมูลส่วนบุคคล และอาจถูกตัดท้าย) —
 * ส่งให้ `ErpAdapter.documentsFromSyncLog`
 */
export interface LoggedHttpCall {
  method: string;
  url: string;
  status: number | null;
  requestBody: string | null;
  responseBody: string | null;
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

/**
 * สถานะรับชำระจาก ERP — เงินเป็นสตริงทศนิยม 2 ตำแหน่ง (ห้าม float)
 * ST7-T21 สัญญาที่ core ใช้กระทบยอด (Payment status pull): ยอด**สะสม**ของเอกสารใบนั้นฝั่ง ERP ณ เวลาที่ถาม
 * - `paidAmount` = ยอดที่ ERP **ตัดหนี้ใบนี้แล้ว** (สะสม — รวม WHT ที่ลูกค้าหัก ถ้า ERP ตัดหนี้ด้วย WHT) · UNPAID ⇔ "0.00"
 * - `whtAmount` (ไม่บังคับ) = ส่วนของ `paidAmount` ที่เป็น WHT ที่ลูกค้าหัก (สะสม) — ไม่ส่ง = ไม่ทราบ (core บันทึก WHT 0 ไม่เดาเอง)
 * - PAID แต่ `paidAmount` < ยอดรวมของใบใน TMS = core ไม่เดาว่าส่วนที่ขาดคืออะไร → MISMATCH ให้คนตัดสิน
 * - adapter ต้องแจ้งรับชำระ**ทางเดียว**: `fetchPaymentStatus` (core มาดึง) หรือ webhook ขาเข้า (effect `paymentReceived`) —
 *   connector ที่เปิด `fetchPaymentStatus` แล้วส่ง `paymentReceived` มาด้วย = core ไม่บันทึก ส่งเข้าคิวตรวจ (กันนับเงินซ้ำ)
 */
export interface PaymentStatus {
  status: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';
  paidAmount: string;
  whtAmount?: string;
  /** ISO 8601 — เวลารับชำระล่าสุดฝั่ง ERP */
  paidAt: string | null;
}

export interface ListDocumentsQuery {
  updatedAfter?: string;
  /** เลขอ้างอิงของเรา */
  ref?: string;
  limit: number;
}

// ---------- ผังรหัส ERP (ST7-T18; docs/04 G3 "Sync master ลงมา", docs/01 §7.4) ----------

/** รหัส 1 ตัวที่ ERP ยอมรับ (adapter คืน — core บันทึกลง `erp_master_code`) */
export interface ErpMasterCodeEntry {
  /** 1–64 ตัว ตามที่ ERP ใช้ */
  code: string;
  name?: string | null;
  /** เฉพาะ VAT_RATE: อัตรา % เป็นสตริงทศนิยม เช่น "7.00" (ห้าม float) — ข้อมูลอ้างอิง ไม่เปลี่ยนการคำนวณภาษีของ TMS */
  rate?: string | null;
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

/**
 * ST8-T16 ผลทางธุรกิจของ event ขาเข้าที่ core บันทึกเอง (adapter ห้ามเขียนฐาน) — ไม่ผูก ERP ใด
 * เงินเป็นสตริงทศนิยม 2 ตำแหน่ง (ห้าม float) · วันที่ `YYYY-MM-DD` (วันตามปฏิทินไทย) · ข้อความห้ามมี credential
 * - `externalDocument` เอกสารที่ TMS ส่งไป (ร่าง) ถูกลงบัญชี/ยกเลิกฝั่ง ERP → core อัปเดต `external_mapping`
 *   (หาเอกสาร TMS จาก `externalId` ที่ได้ตอน push หรือเลข TMS `localNumber`) · VOIDED = **ไม่ยกเลิกใบ TMS อัตโนมัติ** → ขึ้นคิวให้คนตัดสิน
 * - `paymentReceived` ลูกค้าชำระใบแจ้งหนี้ใน ERP (D-57) → core สร้าง `payment` (source CONNECTOR) + คำนวณสถานะใบ (ST5-T18)
 *   `amount` = ยอดตัดหนี้รวม WHT (ความหมายเดียวกับ `payment_allocation.amount`) · ยอดเกินค้าง/ใบชำระไม่ได้ = ขึ้นคิวตรวจ (ไม่สร้าง)
 * - `paymentMade` ERP จ่ายเจ้าหนี้ (ใบสำคัญจ่ายที่ TMS ส่งเป็นร่าง) → core เก็บเลขเอกสารจ่าย/เลข 50 ทวิ ใน mapping ของใบสำคัญจ่าย
 */
export type InboundEffect =
  | {
      kind: 'externalDocument';
      /** null = adapter ไม่รู้ชนิดฝั่ง TMS (เช่น ใบรับเงินของ ERP) → core หาจาก externalId ใน mapping การรับชำระ */
      entityType: 'invoice' | 'settlement' | null;
      externalId: string | null;
      localNumber: string | null;
      externalDocNo: string | null;
      status: 'POSTED' | 'VOIDED';
      reason?: string | null;
      /** ยอดรวมเอกสารที่ ERP ลงบัญชี (สตริงเงิน) — core เทียบกับยอด TMS (ไม่ตรง = คิวตรวจ) */
      externalTotal?: string | null;
    }
  | {
      kind: 'paymentReceived';
      externalId: string;
      externalDocNo: string | null;
      receivedDate: string;
      allocations: readonly {
        externalId: string | null;
        localNumber: string | null;
        amount: string;
        whtAmount: string;
      }[];
    }
  | {
      kind: 'paymentMade';
      externalId: string;
      externalDocNo: string | null;
      allocations: readonly { externalId: string; amount: string; whtAmount: string }[];
      certificates: readonly string[];
    };

export type InboundHandleResult =
  | {
      ok: true;
      triggers?: readonly InboundTrigger[];
      summary?: Record<string, unknown>;
      /** ST8-T16 ผลที่ core บันทึกใน transaction เดียวกับการปิด event (ไม่มี = ไม่มีผลทางธุรกิจ) */
      effects?: readonly InboundEffect[];
    }
  | { ok: false; retryable: boolean; problem: Problem };

/**
 * ความสามารถรับ webhook ขาเข้า (ไม่บังคับ — ไม่มี = URL รับ webhook ของ connector นี้ตอบ 401 เสมอ)
 * ไม่ใช่ `Capability` ของ docs/01 §6.1 (ไม่มีสวิตช์ต่อ tenant — เปิด/ปิดด้วยการออก/เพิกถอน token ของ connector)
 * - `verify` ตรวจลายเซ็นกับ credential ของ connector (ctx.config) **ก่อน** core เขียนอะไรลงฐาน — false/throw = 401 ·
 *   ต้องเทียบแบบเวลาคงที่ และปฏิเสธ timestamp เก่า (กัน replay) ถ้าผู้ให้บริการส่งมา · ห้ามมีผลข้างเคียง
 * - `parse` เรียกหลังลายเซ็นผ่านเท่านั้น — null = รูปแบบที่ไม่รู้จัก (400) · ห้ามเรียกภายนอก
 * - `handle` เรียกใน worker (นอก transaction) สำหรับ event ที่บันทึกใหม่ (ctx.idempotencyKey = `provider:eventKey`)
 *   · **ต้อง idempotent** — core เรียกครั้งเดียวต่อ event ตามปกติ แต่อาจถูกเรียกซ้ำ/ซ้อนได้ (timeout ของ handle,
 *   lease ของ job หมดระหว่างทำ, ลองใหม่หลัง throw) · throw = ล้มแบบลองใหม่ได้ · ห้ามเขียนฐาน TMS (คืน `triggers` ให้ core ทำต่อ)
 *   · ไม่ถูกเรียกเมื่อบริษัทถูกระงับ หรือ connector ไม่ ACTIVE (event คง RECEIVED)
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
   * adapter จำลอง (Demo) — ทุก tenant ใน dev/test/staging ที่อนุญาต · production = เฉพาะ tenant sandbox (D68-96) · catalog (`GET /connectors/adapters`)
   * แสดง `demo: true` ให้หน้าจอติดป้าย "จำลอง" (ST7-T14) · ไม่มีวันเป็นค่าเริ่มต้น (ไม่มี connector = Standalone เสมอ)
   */
  readonly localOnly?: boolean;
  /**
   * D-81 review L1 (ไม่บังคับ): connector ถูกยกเลิกการเชื่อม → ทิ้งสถานะในหน่วยความจำของ (tenant, connector) นี้ (เช่น DemoProvider)
   * core เรียกหลังเปลี่ยนเป็น DISCONNECTED ใน process ที่รับคำขอ — ห้าม throw/ติดต่อภายนอก
   */
  forget?(tenantId: string, connectorId: string): void;
  capabilities(): ReadonlySet<ErpCapability>;
  /**
   * ST8-T03 capability ที่ประกาศแล้วแต่ยังไม่ได้ทำ (โครง adapter) — ต้องอยู่ใน `capabilities()` ด้วย (มี method ที่ตอบ `not_implemented`)
   * core: ไม่นับเป็น "รองรับ" (`readyCapabilities`) → ไม่เปิดเป็นค่าเริ่มต้น เปิดไม่ได้ (422) ไม่มีผลกับ flow เอกสาร ·
   * catalog/หน้าจอแสดงเป็น "ยังไม่รองรับ" · คำสั่งในคิวที่ค้างอยู่ = พักไว้ (ไม่ SKIPPED ไม่เสียจำนวนครั้ง)
   */
  readonly pendingCapabilities?: readonly ErpCapability[];
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
  /**
   * อ่านเอกสารฝั่ง ERP กลับเป็น canonical (docs/01 §6.5 "adapter แปลง response ERP กลับเป็น canonical") · ไม่พบ = `null`
   * หรือโยน `ErpAdapterError` class `NOT_FOUND` · ปลายทางล่ม = throw (TRANSIENT) · `ref.documents` = อ่านทุกใบแล้วรวมเป็นใบเดียว
   * ST8-T10 `hint` (ไม่บังคับ) = canonical ที่ TMS ส่งไป — ใช้**จับคู่รายการ**เท่านั้น (เช่น จับด้วยเลข DO เมื่อ ERP เรียงเลขบรรทัดใหม่)
   * ห้ามเอาค่าจาก hint มาเติมแทนข้อมูลฝั่ง ERP
   */
  fetchDocument?(
    ctx: ErpContext,
    ref: ExternalRef,
    hint?: CanonicalDocument,
  ): Promise<CanonicalDocument | null>;
  /**
   * ST8-T10 `fetchDocument` ค้นด้วยเลขอ้างอิงของเรา (`ref.number`) ไม่ได้ — ต้องมี `externalId` (เช่น ERP ไม่มี endpoint ค้น/list)
   * core ค้นหลัง AMBIGUOUS / DUPLICATE ได้เฉพาะเมื่อรู้ id ฝั่ง ERP แล้ว (mapping ที่ส่งไม่ครบ หรือ response สำเร็จใน sync log —
   * `documentsFromSyncLog`) · ไม่รู้ id = ถือว่าค้นไม่ได้ (ERP กันซ้ำด้วยเลขอ้างอิงของเรา — docs/01 §6.3, A.5)
   */
  readonly fetchNeedsExternalId?: boolean;
  /**
   * ST8-T10 (ไม่บังคับ — ฟังก์ชันบริสุทธิ์ ห้ามเรียกภายนอก/throw) เอกสารฝั่ง ERP ที่ถูกสร้างแล้วตามหลักฐานใน sync log ของเอกสารนี้
   * (เช่น response 201 ที่มีเลขเอกสาร แต่ผลของคำสั่งไม่ถูกบันทึก) — core ส่งเฉพาะการเรียก POST/PUT ที่ได้ 2xx เรียงตามเวลา
   */
  documentsFromSyncLog?(calls: readonly LoggedHttpCall[]): ExternalDocumentPart[];
  /**
   * ST8-T10 (ไม่บังคับ — ฟังก์ชันบริสุทธิ์) ส่วนของ canonical ที่ ERP เก็บได้ ในรูปเดียวกับผลของ `fetchDocument`
   * (ERP ที่เก็บไม่ครบทุกช่องของ canonical) — core เทียบผลของ `fetchDocument` กับค่านี้แทน canonical ทั้งก้อน · null = เทียบไม่ได้
   * ไม่มี = ERP เก็บ canonical ทั้งก้อน (เทียบตรง)
   */
  comparableDocument?(ctx: ErpContext, doc: CanonicalDocument): CanonicalDocument | null;
  fetchPaymentStatus?(ctx: ErpContext, ref: ExternalRef): Promise<PaymentStatus | null>;
  listDocuments?(
    ctx: ErpContext,
    q: ListDocumentsQuery,
  ): Promise<{ items: ExternalRef[]; next: string | null }>;
  /** ST7-T22 webhook ขาเข้า (ไม่บังคับ) */
  readonly inbound?: InboundWebhookHandler;

  /**
   * ST7-T18 ชนิดรหัส master ที่ดึงจาก ERP ได้ (ไม่ใช่ `Capability` ของ docs/01 §6.1 — ไม่มีสวิตช์ต่อ tenant; ผู้ดูแลกดซิงก์เอง)
   * ไม่มี/ว่าง = ดึงไม่ได้ → นำเข้าไฟล์ (`erp_master_code` import) · มี ⇔ ต้องมี `fetchMasterCodes`
   */
  readonly masterCodeKinds?: readonly ErpMasterCodeKind[];
  /**
   * รายการรหัส **ทั้งชุด** ของชนิดนั้น (core ปิดใช้รหัสที่ไม่อยู่ในชุด) · เรียกนอก transaction · throw/ปลายทางล่ม = core ไม่เปลี่ยนข้อมูล
   * ห้ามมี credential ในข้อความ error
   */
  fetchMasterCodes?(ctx: ErpContext, kind: ErpMasterCodeKind): Promise<ErpMasterCodeEntry[]>;
  /**
   * ST8-T06 ค่าในเอกสารที่ต้องเป็นรหัสในผังรหัส ERP (เช่น หน่วย/พนักงานขาย) — core (`ErpMasterCodesService.prepareForPush`)
   * ตรวจกับ `erp_master_code` ของ connector ก่อนส่ง: ไม่พบ = คำสั่ง FAILED_FINAL(VALIDATION) `erp_master_code_unknown`
   * (เอกสารยังออกได้ — plan/11 #9) · พบ = ใส่ผลใน `ctx.masterCodes` · ฟังก์ชันบริสุทธิ์ ห้ามเรียกภายนอก/throw
   * ไม่มี = ไม่ตรวจเพิ่ม (นอกจาก mapping ค่าบริการของ ST7-T18)
   */
  masterCodeRefs?(
    ctx: ErpContext,
    operation: ErpOperation,
    doc: CanonicalDocument,
  ): readonly MasterCodeRef[];
  /** ST8-T06 ความพร้อมของผังรหัสก่อนส่งเอกสาร (ฟังก์ชันบริสุทธิ์ จากค่าตั้ง) — ไม่มี = ไม่ตรวจ */
  pushReadiness?(ctx: ErpContext): MasterCodeReadiness;
  /**
   * ST8-T16 system-of-record ที่ adapter กำหนดตายตัว (D-55) — core ตั้งค่าให้ตอนสร้าง connector และไม่ยอมให้เปลี่ยน (422 `sor_fixed`)
   * ไม่มี = ผู้ดูแลเลือกเอง (ST7-T17)
   */
  readonly fixedSystemOfRecord?: { readonly taxDocumentOwner?: SorOwner };
  /**
   * ST8-T07 ข้อมูลส่วนบุคคลแบบตัวเลือกที่ adapter ต้องใช้ใน canonical (เช่น ชื่อคนขับ) — ไม่ประกาศ = core ไม่ใส่ลง payload ของคำสั่ง
   * (ประกาศเท่าที่สัญญาของปลายทางบังคับเท่านั้น)
   */
  readonly personalDataNeeds?: readonly CanonicalPersonalField[];
  /**
   * D-64 (ST8-T08) ค่าแทนที่ adapter ใช้เมื่อเอกสารไม่มีค่าที่ปลายทางบังคับ — core เตือนผู้ใช้ตั้งแต่ร่าง/ก่อนออกเอกสาร (ไม่บล็อก)
   * ผ่าน `erpWarnings` ของ `GET /invoices/{id}` · `trip.driverName→trip.carrierName` = เที่ยวที่ไม่มีชื่อคนขับ (เช่น รถร่วม)
   * ส่งชื่อบริษัทรถร่วมแทนชื่อคนขับ
   */
  readonly fieldSubstitutions?: readonly ErpFieldSubstitution[];
}

/** D-64 ค่าแทนที่ที่ adapter ประกาศได้ (`ErpAdapter.fieldSubstitutions`) */
export type ErpFieldSubstitution = 'trip.driverName→trip.carrierName';

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

/** capability ที่ใช้งานได้จริง = ที่ประกาศ − ที่ยังไม่ได้ทำ (`pendingCapabilities`) — core ใช้ชุดนี้ตัดสินทุกอย่าง */
export function readyCapabilities(a: ErpAdapter): ReadonlySet<ErpCapability> {
  const pending = new Set(a.pendingCapabilities ?? []);
  return new Set([...a.capabilities()].filter((c) => !pending.has(c)));
}

/** capability นี้ adapter ประกาศแต่ยังไม่ได้ทำ */
export function isPendingCapability(a: ErpAdapter, c: ErpCapability): boolean {
  return (a.pendingCapabilities ?? []).includes(c) && a.capabilities().has(c);
}

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
  for (const c of a.pendingCapabilities ?? [])
    if (!caps.has(c)) out.push(`pending capability '${String(c)}' not declared in capabilities()`);
  // ST8-T10 ส่วนเสริมของการอ่านเอกสาร ใช้ได้เฉพาะ adapter ที่มี fetchDocument
  if (typeof a.fetchDocument !== 'function')
    for (const m of ['fetchNeedsExternalId', 'documentsFromSyncLog', 'comparableDocument'] as const)
      if (a[m] !== undefined) out.push(`${m} declared but fetchDocument() missing`);
  const kinds = a.masterCodeKinds ?? [];
  for (const k of kinds)
    if (!isErpMasterCodeKind(k)) out.push(`unknown master code kind '${String(k)}'`);
  const hasFetch = typeof a.fetchMasterCodes === 'function';
  if (kinds.length && !hasFetch)
    out.push('masterCodeKinds declared but fetchMasterCodes() missing');
  if (!kinds.length && hasFetch) out.push('fetchMasterCodes() present but masterCodeKinds empty');
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
