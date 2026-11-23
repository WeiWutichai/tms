import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Connector } from '@prisma/client';
import {
  ERP_OPERATION_CAPABILITY,
  type ErpCapability,
  type ErpOperation,
  fieldChangePolicy,
  isErpOperation,
  type SorChangeDecision,
  SOR_PAYMENT_RECEIVED_STATUSES,
  SOR_TAX_PUSH_CAPABILITIES,
} from '@tms/domain';
import { Clock } from '../../common/clock';
import type { Tx } from '../../db/db.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { OutboxSinkRegistry } from '../integration/outbox-sink.registry';
import {
  OutboxSinkError,
  type OutboxDelivery,
  type OutboxSink,
  type SettledCommand,
} from '../integration/outbox.types';
import { DbService } from '../../db/db.service';
import { NotificationEvents } from '../notifications/notification-events';
import { canonicalJson } from '../integration/outbox.service';
import {
  changedSyncParts,
  documentDate,
  type SyncPart,
  syncParts,
  withSyncHash,
} from './canonical';
import { canonicalProblems } from './canonical-validation';
import { ConnectorResolver } from './connector-resolver';
import { ConnectorsService, HEALTH_STOP_CLASSES, redactSecrets } from './connectors.service';
import { ErpMasterCodesService, type PushPreparation } from './erp-master-codes.service';
import { recordSyncLog } from './erp-sync-log';
import { ExternalMappingService } from './external-mapping.service';
import { sorOf } from './system-of-record.policy';
import { injectPersonalData, redactNationalIds } from './personal-data';
import {
  type CanonicalDocument,
  type ErpAdapter,
  ErpAdapterError,
  type ErpContext,
  type ErpHttpCall,
  isPendingCapability,
  NOT_IMPLEMENTED,
  type ExternalRef,
  type PushResult,
} from './erp-adapter';

export const ERP_SINK = 'erp';

/**
 * ตัด credential (`redactSecrets`) + เลขบัตรประชาชนที่ใส่ ณ ตอนส่ง (D-80 `redactNationalIds` — รวมรูปมีขีด/เว้นวรรค/ถูกตัดกลางเลข)
 * ออกจากข้อความ ก่อนเก็บใน `last_error` / `result`
 */
function scrub(text: string, secrets: readonly string[]): string {
  return redactNationalIds(redactSecrets(text, secrets), secrets);
}

/**
 * ST8-T16 สถานะของเอกสารต้นทางตอนจะส่ง — `CANCELLED` = ไม่ส่ง · ไม่พบ/ชนิดอื่น = `OK` (ไม่ตัดสินแทน)
 * ใบแจ้งหนี้: CANCELLED (ST5-T10) · ใบสำคัญจ่าย: ส่งได้เฉพาะ PAID (D-58) อื่น ๆ (ยกเลิก) = CANCELLED
 */
async function sourceState(
  tx: Tx,
  entityType: string,
  localId: string,
): Promise<'OK' | 'CANCELLED'> {
  if (entityType === 'invoice') {
    const r = await tx.invoice.findUnique({ where: { id: localId }, select: { status: true } });
    return r?.status === 'CANCELLED' ? 'CANCELLED' : 'OK';
  }
  if (entityType === 'settlement') {
    const r = await tx.carrierSettlement.findUnique({
      where: { id: localId },
      select: { status: true },
    });
    return r && r.status !== 'PAID' ? 'CANCELLED' : 'OK';
  }
  return 'OK';
}

/**
 * ST7-T15 key กันซ้ำที่ส่งให้ adapter ของคำสั่งส่งเอกสาร = ส่วนหน้าของ key คำสั่ง (`sink:target:entity:local`) + hash ของ
 * **เอกสารที่ส่งจริง** (หลังใส่รหัสฝั่ง ERP ณ ตอนส่ง) — ลองใหม่ด้วยเนื้อหาเดิม = key เดิม (ERP คืนของเดิม) ·
 * เนื้อหาเปลี่ยน (เช่น แก้รหัสลูกค้าแล้วส่งคำสั่งเดิมใหม่) = key ใหม่ → ERP ที่กันซ้ำด้วย key ไม่คืนของเก่าเงียบ ๆ
 */
export function sentIdempotencyKey(commandKey: string, sentHash: string): string {
  // `sink:target:entity:local` (4 ส่วนแรก) — คำสั่งส่งใหม่ (ST7-T16 `resend`) มีส่วนท้าย `:resend-…` ต่อจาก hash ของคำสั่ง
  // แต่ key ที่ ERP เห็นต้องเหมือนการส่งครั้งก่อนเมื่อเนื้อหาเดิม (ERP คืนของเดิม ไม่สร้างใบที่สอง)
  const parts = commandKey.split(':');
  const head = parts.length >= 5 ? parts.slice(0, 4).join(':') : parts.slice(0, -1).join(':');
  return `${head || commandKey}:${sentHash}`;
}

/** รหัสคู่ค้าฝั่ง ERP ในเอกสารที่ส่งจริง (null = ไม่มีรหัส — adapter จับคู่เอง) · เอกสารไม่มีคู่ค้าชนิดนั้น = ไม่มี key */
function partyCodesOf(doc: CanonicalDocument): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [field, key] of [
    ['customer', 'customerExternalId'],
    ['carrier', 'carrierExternalId'],
  ] as const) {
    const p = (doc as Record<string, unknown>)[field];
    if (p && typeof p === 'object')
      out[key] =
        typeof (p as { externalId?: unknown }).externalId === 'string'
          ? ((p as { externalId: string }).externalId as string)
          : null;
  }
  return out;
}

/** ST8-T08 จำนวนเอกสารฝั่ง ERP สูงสุดที่เก็บต่อเอกสาร TMS (`detail.documents`) */
const MAX_EXTERNAL_DOCUMENTS = 200;

/**
 * ST8-T08 เอกสารฝั่ง ERP ของผล push (ตัดขนาด/รูปผิดทิ้ง) — มีเพียงใบเดียว/ไม่มี = null (เก็บแบบเดิมใน external_id)
 */
function externalDocumentsOf(
  r: Extract<PushResult, { ok: true }>,
): Record<string, unknown>[] | null {
  if (!Array.isArray(r.documents) || r.documents.length < 2) return null;
  return r.documents.slice(0, MAX_EXTERNAL_DOCUMENTS).map((p) => ({
    ref: String(p.ref ?? '').slice(0, 100),
    externalId: String(p.externalId ?? '').slice(0, 100),
    externalDocNo: typeof p.externalDocNo === 'string' ? p.externalDocNo.slice(0, 100) : null,
    group: typeof p.group === 'string' ? p.group.slice(0, 40) : null,
    lineNos: Array.isArray(p.lineNos)
      ? (p.lineNos as readonly unknown[]).filter((n) => Number.isInteger(n)).slice(0, 2000)
      : [],
  }));
}

/** entity ที่เก็บ external_mapping หลัง push สำเร็จ (ST8-T16) */
const MAPPED_ENTITIES: Readonly<Record<string, 'INVOICE' | 'SETTLEMENT'>> = {
  invoice: 'INVOICE',
  settlement: 'SETTLEMENT',
};

/**
 * D68-57 SKIPPED ที่ไม่ต้องแจ้งบัญชี (ทีละคำสั่ง): ส่งถึงแล้ว (`payload_unchanged`) · เอกสารถูกยกเลิกก่อนส่ง (`document_cancelled` — ไม่มีอะไรใน ERP)
 * · sandbox (`sandbox_unsupported` — ไม่ส่งออกนอกระบบโดยตั้งใจ)
 */
const NOT_NOTIFIED_SKIPS: ReadonlySet<string> = new Set([
  // review M1: ยกเลิกการเชื่อมแจ้งฉบับเดียวจาก `ConnectorsService.disconnect` (จำนวนคำสั่งค้าง) — ไม่แจ้งทีละคำสั่ง
  'connector_disconnected',
  'payload_unchanged',
  'document_cancelled',
  'sandbox_unsupported',
  // ST7-T16 เอกสารก่อนวันเริ่มซิงก์ — บัญชีคีย์ไว้เองก่อน go-live (docs/01 §6.4) ไม่ใช่งานที่ต้องทำ
  'before_sync_from_date',
]);

/** คำสั่งที่แจ้งบัญชีเมื่อไม่ถึง ERP (ส่งเอกสาร + แจ้งยกเลิกเอกสาร) */
const DOCUMENT_OPERATIONS: ReadonlySet<string> = new Set([
  'PUSH_INVOICE',
  'PUSH_CREDIT_NOTE',
  'PUSH_SETTLEMENT',
  'REPLACE_DOCUMENT',
  'VOID_DOCUMENT',
]);

/** คำสั่งที่ส่งเอกสารเข้า ERP (ผ่านประตู mapping/ผังรหัสก่อน) */
const PUSH_OPERATIONS: ReadonlySet<string> = new Set([
  'PUSH_INVOICE',
  'PUSH_CREDIT_NOTE',
  'PUSH_SETTLEMENT',
  'REPLACE_DOCUMENT',
]);

/** ST8-T03 คำสั่งของ capability ที่ adapter ยังไม่ได้ทำ = พัก (class AUTH = PENDING ไม่นับครั้ง — เหมือน `capability_off`) ไม่ใช่ SKIPPED */
function parkedNotImplemented(cap: string): OutboxSinkError {
  return new OutboxSinkError(`capability ${cap} not implemented yet — parked`, 'AUTH', {
    code: 'capability_not_implemented',
    capability: cap,
  });
}

/** ST7-T16 สถานะของการส่ง 1 ครั้ง (sync log + ผลต่อ mapping เมื่อล้ม) */
interface DeliveryState {
  calls: ErpHttpCall[];
  secrets: string[];
  connector: Connector | null;
  number: string | null;
  /** review: เรียก adapter ส่ง/แทนที่/อ่านเอกสารแล้ว — ผลต่อ mapping เฉพาะความล้มที่ adapter ตอบ (ไม่ใช่ประตูก่อนถึง adapter) */
  adapterCalled: boolean;
  /** capability ที่ใช้จริงในการเรียกครั้งนี้ (แทนที่ = replaceDocument) — ใช้พักคำสั่งเมื่อ adapter ตอบ not_implemented */
  cap: ErpCapability | null;
}

/** ST7-T16 เนื้อหาของเอกสารสองฝั่งตรงกันไหม (ไม่นับ `sync` และเลขฝั่ง ERP ที่ adapter แนบกลับ) */
function sameContent(remote: CanonicalDocument, sent: CanonicalDocument): boolean {
  const strip = (x: CanonicalDocument) => {
    const { sync: _s, externalId: _e, externalDocNo: _n, ...rest } = x as Record<string, unknown>;
    return canonicalJson(rest);
  };
  return strip(remote) === strip(sent);
}

/** ST7-T16 วิธีส่งเอกสารเข้า adapter: สร้างใหม่ (push ตามชนิดเอกสาร) หรือแทนที่ฉบับที่อยู่ใน ERP (replaceDocument) */
type SendMode = { kind: 'push' } | { kind: 'replace'; ref: ExternalRef };

/** ชนิดเอกสาร → method push (REPLACE_DOCUMENT ของเอกสารที่ยังไม่อยู่ใน ERP = ส่งใหม่ด้วย method นี้) */
const PUSH_CAPABILITY_OF: Readonly<Record<string, ErpCapability>> = {
  invoice: 'pushInvoice',
  settlement: 'pushSettlement',
};

/**
 * ST7-T16 รวมคำตัดสินของทุกกลุ่มที่เปลี่ยน (docs/04 G3): BLOCKED > REGENERATE > AUTO_SYNC ·
 * กลุ่ม `OTHER` (ช่องที่ไม่อยู่ในกลุ่มใด) = REGENERATE (ระมัดระวัง — ให้คนตัดสิน)
 */
function combineDecisions(decisions: SorChangeDecision[]): SorChangeDecision {
  const blocked = decisions.find((x) => x.mode === 'BLOCKED');
  if (blocked) return blocked;
  if (decisions.some((x) => x.mode === 'REGENERATE')) return { mode: 'REGENERATE' };
  return { mode: 'AUTO_SYNC' };
}

/**
 * ErpAdapter เสียบเป็น sink `erp` ของ integration outbox (ST7-T13; docs/01 §3.7 kind ADAPTER, §6.2–6.3) — **คิวเดียว** กับ webhook
 * คำสั่ง: target_id = connector id · operation ∈ ERP_OPERATION_CAPABILITY (PUSH_INVOICE ฯลฯ) · payload = canonical (ST7-T15)
 * - ยกเลิกการเชื่อม / ไม่มี connector → SKIPPED (CAPABILITY — INT-016 หยุดส่งทันที)
 * - PAUSED / ERROR / tenant ถูกระงับ / แพ็กเกจไม่มี `conn` / adapter ไม่ได้ติดตั้ง → คงคำสั่งไว้ (AUTH = PENDING ไม่นับครั้ง)
 * - D-81 · D68-57 healthCheck กำลังล้ม (`health_failing_since` มีค่า) → พักทั้งคิว `connector_unhealthy` (AUTH = PENDING ไม่นับครั้ง)
 * - D-81 · D68-57 คำสั่งส่ง/ยกเลิกเอกสารจบ FAILED_FINAL / SKIPPED (ที่ต้องมีคนทำ) → แจ้งฝ่ายบัญชี (`onSettled`)
 * - capability ไม่ได้เปิด/ไม่รองรับ → SKIPPED (CAPABILITY — docs/01 §6.3)
 * - adapter ตอบ AUTH → connector = ERROR (หยุดทั้งตัว) แล้วคำสั่งรอ · class อื่นตาม retry policy ของ dispatcher
 * - ST8-T03 adapter ตอบ/throw TRANSIENT → เรียก healthCheck 1 ครั้ง: AUTH = ERROR ทันที · TRANSIENT = นับเวลาล้มต่อเนื่อง
 *   ครบ 30 นาที → ERROR หยุดทั้งคิว (spec/07 §1; docs/01 A.5) · ผ่าน = ล้มเฉพาะใบนี้ ลองใหม่ตาม policy
 * - adapter throw `ErpAdapterError` = ผลตาม class ที่ระบุ · capability ที่ยังไม่ได้ทำ (`pendingCapabilities` หรือตอบ `not_implemented`)
 *   = พักไว้ `capability_not_implemented` (PENDING ไม่นับครั้ง — ไม่ SKIPPED)
 * - ST7-T18 ประตู mapping: ค่าบริการในเอกสาร (`lines[].serviceItem.id`) ที่ยังไม่จับคู่รหัสสินค้า ERP → FAILED_FINAL
 *   (VALIDATION `erp_mapping_incomplete` + ลิงก์หน้า mapping — plan/11 #9: ไม่กันการออกเอกสาร) · ครบ = ใส่รหัสลง
 *   `serviceItem.externalId` ก่อนส่ง adapter (docs/01 §7.2)
 * - ST8-T06 ค่าที่ adapter ประกาศใน `masterCodeRefs` (เช่น หน่วย/พนักงานขายของ KRS) ไม่อยู่ใน `erp_master_code` → FAILED_FINAL
 *   (VALIDATION `erp_master_code_unknown` + ลิงก์) · ผ่าน = รหัสที่หาได้อยู่ใน `ctx.masterCodes`
 * - ST7-T15 (docs/01 §3.7, §7.4; docs/04 G3) ก่อนเรียก adapter ของคำสั่งส่งเอกสาร:
 *   1) รูปของ canonical ผิด (ไม่มีเลข TMS / วันที่ / ยอดเงินผิดรูป) → FAILED_FINAL (VALIDATION `invalid_payload` + `fields`)
 *   2) ใส่รหัสคู่ค้าฝั่ง ERP จาก external_mapping `SYNCED` ณ ตอนส่ง (`customer.externalId` / `carrier.externalId`) แล้วเข้าประตู mapping
 *   3) คำนวณ `sync.hash` ของเอกสารที่จะส่งจริง — เท่ากับ `last_synced_hash` ของ mapping ที่ `SYNCED` = ไม่เรียก adapter:
 *      · คำสั่งที่ **ยังไม่เคยจบ** (เช่น worker เสีย lease หลังบันทึก mapping แล้ว) = **DONE** `{externalId, externalDocNo, unchanged: true}`
 *        (สำเร็จแบบ idempotent — คำสั่งส่งเอกสารไม่กลายเป็น SKIPPED ทั้งที่ส่งถึงแล้ว)
 *      · คำสั่งที่เคย DONE แล้วถูกส่งซ้ำ = **SKIPPED `payload_unchanged`**
 *      · เอกสารฝั่ง ERP ถูกยกเลิกแล้ว (`external_status = VOIDED`) = ไม่ข้าม (ส่งใหม่ได้)
 *      หมายเหตุ ST7-T19: SKIPPED ทุกแบบใช้ class `CAPABILITY` (ตาราง docs/01 §6.3 ไม่มี class ที่ตรงกว่า) — หน้าคิว/ตัวนับต้องแยกด้วย
 *      `last_error.code` (`payload_unchanged` ไม่ใช่งานที่คนต้องทำ) ไม่ใช่ด้วย `error_class`
 *   4) key กันซ้ำที่ส่งให้ adapter = `sentIdempotencyKey` (ผูกกับ hash ของเอกสารที่ส่งจริง)
 *   5) สำเร็จ + adapter ยืนยันว่ารับเนื้อหาครั้งนี้ (`applied: true`) → external_mapping `SYNCED` + hash นั้น + `external_id` /
 *      `external_doc_no` / `external_version` · **ไม่ยืนยัน** (ERP คืนของเดิม) → ไม่เลื่อน `last_synced_hash`, mapping = `MISMATCH`
 *      (`erp_not_applied` / `erp_content_unverified`) รอ reconcile / REPLACE_DOCUMENT (ST7-T16) — ทางระมัดระวัง: ไม่ถือว่าตรงถ้าไม่มีหลักฐาน
 *   6) ผลของคำสั่ง (`result`) มี `sentHash` + รหัสลูกค้า/รถร่วมฝั่ง ERP ที่ใส่ ณ ตอนส่ง (ตรวจย้อนหลังได้ว่าส่งด้วยรหัสใด)
 * - D-80 ข้อมูลส่วนบุคคลที่ adapter ประกาศใน `personalDataNeeds` (`carrier.taxId` = เลขบัตรประชาชนรถร่วมบุคคลธรรมดา) ใส่ **ณ ตอนส่ง**
 *   หลังประตู mapping (`injectPersonalData`) — payload ในคิวไม่มีเลขเต็ม · `sync.hash` คำนวณโดยแทนเลขด้วย blind index (HMAC)
 *   · ลง audit `connector.pii_sent` ทุกครั้งที่ส่งออก (ไม่มีตัวเลข) · `result` มีแค่ชื่อช่อง (`personalDataSent`) ·
 *   ข้อความ error จาก adapter/ปลายทางถูกตัดเลขออก (`scrub` — รวมรูปมีขีด/เว้นวรรค/ถูกตัดกลางเลข) ก่อนเก็บใน `last_error`
 * ST8-T16 (ส่วนหนึ่งของ ST7-T15/T16): คำสั่งหลัง finalize/บันทึกจ่าย/ยกเลิก = `ErpSyncService` · push สำเร็จ → external_mapping · ประตู syncFromDate = ST7-T16
 */
@Injectable()
export class ErpAdapterSink implements OutboxSink, OnModuleInit {
  readonly key = ERP_SINK;
  private readonly logger = new Logger('ErpAdapterSink');

  constructor(
    private readonly registry: OutboxSinkRegistry,
    private readonly connectors: ConnectorsService,
    private readonly resolver: ConnectorResolver,
    private readonly entitlements: EntitlementService,
    private readonly masterCodes: ErpMasterCodesService,
    private readonly clock: Clock,
    private readonly mappings: ExternalMappingService,
    private readonly db: DbService,
    private readonly events: NotificationEvents,
  ) {}

  onModuleInit() {
    if (!this.registry.get(this.key)) this.registry.register(this);
  }

  /**
   * D-81 · D68-57 (+ เงื่อนไข D68-09) เอกสารไม่ถูกส่งเข้า ERP → แจ้งฝ่ายบัญชี (docs/01 §6.3 CAPABILITY "SKIPPED + แจ้งบัญชี";
   * FAILED_FINAL ทุก class รวม `erp_mapping_incomplete`) — เฉพาะคำสั่งส่ง/ยกเลิกเอกสาร (ไม่ใช่คำสั่งดึงข้อมูล)
   * · SKIPPED ที่ไม่ใช่งานของคน (`NOT_NOTIFIED_SKIPS`) ไม่แจ้ง · แจ้งใน transaction ของ tenant (RLS) แยกจากการบันทึกผลคำสั่ง
   */
  async onSettled(c: SettledCommand): Promise<void> {
    if (!DOCUMENT_OPERATIONS.has(c.operation) || !c.targetId) return;
    if (c.status === 'SKIPPED' && (!c.code || NOT_NOTIFIED_SKIPS.has(c.code))) return;
    const connectorId = c.targetId;
    const p = (c.payload ?? {}) as { document?: { number?: unknown }; number?: unknown };
    const no = p.document?.number ?? p.number;
    await this.db.withTenant(c.tenantId, async (tx) => {
      const connector = await tx.connector.findUnique({
        where: { id: connectorId },
        select: { adapterKey: true },
      });
      await this.events.documentNotSent(tx, {
        tenantId: c.tenantId,
        connectorId,
        errorClass: c.errorClass,
        entityType: c.entityType,
        localId: c.localId,
        documentNo: typeof no === 'string' && no ? no : null,
        label: connector ? this.connectors.adapterLabel(connector.adapterKey) : '-',
        outcome: c.status,
        code: (c.code ?? c.errorClass ?? 'error').slice(0, 60),
      });
    });
  }

  async deliver(d: OutboxDelivery): Promise<{ result: Record<string, unknown> }> {
    const st: DeliveryState = {
      calls: [],
      secrets: [],
      connector: null,
      number: null,
      adapterCalled: false,
      cap: null,
    };
    try {
      return await this.deliverOnce(d, st);
    } catch (e) {
      if (e instanceof OutboxSinkError) await this.afterFailure(d, st, e);
      throw e;
    } finally {
      await this.flushSyncLog(d, st);
    }
  }

  /**
   * ST7-T16 sync log (docs/01 §6.4): 1 แถวต่อ 1 HTTP call ที่ adapter รายงาน — ตัด credential + ข้อมูลส่วนบุคคลที่ใส่ ณ ตอนส่ง
   * บันทึกไม่ได้ = log เตือน (ไม่เปลี่ยนผลของคำสั่ง — การส่งเกิดขึ้นแล้ว)
   */
  private async flushSyncLog(d: OutboxDelivery, st: DeliveryState): Promise<void> {
    const c = st.connector;
    if (!c || !st.calls.length) return;
    try {
      await d.withTx((tx) =>
        recordSyncLog(
          tx,
          {
            tenantId: d.tenantId,
            connectorId: c.id,
            outboxId: d.id,
            attempt: d.attempt,
            operation: d.operation,
            entityType: d.entityType,
            localId: d.localId,
            localNumber: st.number,
          },
          st.calls,
          st.secrets,
          this.clock.now(),
        ),
      );
    } catch (e) {
      this.logger.warn(`sync log ${d.id}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }

  /**
   * ST7-T16 ผลต่อ `external_mapping` ของคำสั่งส่งเอกสารที่ล้ม (docs/01 §6.3):
   * - VALIDATION → mapping `FAILED` (เอกสารยังไม่อยู่ใน ERP) · เอกสารอยู่ใน ERP แล้ว (แทนที่ไม่ผ่าน) = `MISMATCH` — ERP ยังถือฉบับเดิม
   *   (ไม่ใช้ FAILED กับเอกสารที่อยู่ใน ERP: ทาง reconcile / ดึงสถานะรับชำระยังต้องเห็นเอกสารนั้น)
   * - NOT_FOUND (ตอนแทนที่/อ่าน) ของเอกสารที่ mapping บอกว่าอยู่ใน ERP → mapping `MISMATCH` + `reconcile_result` REMOTE_MISSING ให้คนตัดสิน
   * บันทึกไม่ได้ = log เตือน (ผลของคำสั่งยังเป็นตาม class)
   */
  private async afterFailure(d: OutboxDelivery, st: DeliveryState, e: OutboxSinkError) {
    const c = st.connector;
    const entity = MAPPED_ENTITIES[d.entityType];
    if (!c || !entity || !st.adapterCalled) return;
    const push = PUSH_OPERATIONS.has(d.operation);
    const validation = e.errorClass === 'VALIDATION' && push;
    const notFound = e.errorClass === 'NOT_FOUND' && (push || d.operation === 'FETCH_DOCUMENT');
    if (!validation && !notFound) return;
    const now = this.clock.now();
    const code = typeof e.detail?.code === 'string' ? e.detail.code.slice(0, 60) : null;
    try {
      await d.withTx(async (tx) => {
        const m = await tx.externalMapping.findUnique({
          where: {
            connectorId_entityType_localId: {
              connectorId: c.id,
              entityType: entity,
              localId: d.localId,
            },
          },
        });
        const inErp = !!m?.externalId && m.externalStatus !== 'VOIDED';
        if (validation) {
          if (inErp)
            this.logger.warn(`VALIDATION on document already in ERP ${d.localId} → mapping FAILED`);
          const lastError = {
            code: code ?? 'validation',
            errorClass: 'VALIDATION',
            outboxId: d.id,
            at: now.toISOString(),
          };
          if (m)
            await tx.externalMapping.update({
              where: { id: m.id },
              data: {
                // docs/01 §6.3 VALIDATION → mapping FAILED (รวมเอกสารที่อยู่ใน ERP แล้ว — ทีมเสนอ MISMATCH: คำถามค้าง #85)
                status: 'FAILED',
                lastError,
                updatedBy: 'system:erp-sink',
                version: { increment: 1 },
              },
            });
          else
            await tx.externalMapping.create({
              data: {
                tenantId: d.tenantId,
                connectorId: c.id,
                entityType: entity,
                localId: d.localId,
                localNumber: st.number,
                status: 'FAILED',
                lastError,
                createdBy: 'system:erp-sink',
              },
            });
          return;
        }
        // NOT_FOUND: ไม่มีเอกสารที่คิดว่าอยู่ใน ERP = ไม่มีอะไรหาย (เช่น push ใบใหม่แล้ว ERP ตอบ 404) — ผลของคำสั่งตาม class อย่างเดียว
        if (!m || !inErp) return;
        await tx.externalMapping.update({
          where: { id: m.id },
          data: {
            status: 'MISMATCH',
            lastError: {
              code: 'remote_missing',
              errorClass: 'NOT_FOUND',
              outboxId: d.id,
              at: now.toISOString(),
            },
            updatedBy: 'system:erp-sink',
            version: { increment: 1 },
          },
        });
        await this.remoteMissing(tx, d, c, entity, m.localNumber ?? st.number, m.externalId!, now);
      });
    } catch (err) {
      this.logger.warn(
        `mapping after ${e.errorClass} ${d.id}: ${String((err as Error)?.message ?? err).slice(0, 200)}`,
      );
    }
  }

  /**
   * ST7-T16 NOT_FOUND → `reconcile_result` REMOTE_MISSING (docs/01 §6.3 "เอกสารถูกลบฝั่ง ERP → ให้คนตัดสิน") — severity MONEY
   * (ยอดทั้งใบไม่อยู่ใน ERP) · ส่วนต่างเดิมที่ยังเปิด = ไม่สร้างซ้ำ (diff_hash) · audit `reconcile.mismatch_found` (ระบบเป็นผู้กระทำ)
   */
  private async remoteMissing(
    tx: Tx,
    d: OutboxDelivery,
    c: Connector,
    entity: 'INVOICE' | 'SETTLEMENT',
    number: string | null,
    externalId: string,
    now: Date,
  ) {
    const diff = {
      check: 'DOCUMENT',
      code: 'remote_missing',
      externalId: externalId.slice(0, 100),
    };
    const diffHash = createHash('sha256').update(canonicalJson(diff)).digest('hex');
    const scope = { connectorId: c.id, entityType: entity, localId: d.localId, resolvedAt: null };
    const same = await tx.reconcileResult.findFirst({ where: { ...scope, diffHash } });
    if (same) {
      await tx.reconcileResult.update({ where: { id: same.id }, data: { lastSeenAt: now } });
      return;
    }
    const row = await tx.reconcileResult.create({
      data: {
        tenantId: d.tenantId,
        connectorId: c.id,
        entityType: entity,
        localId: d.localId,
        localNumber: number?.slice(0, 60) ?? null,
        runAt: now,
        source: 'AFTER_PUSH',
        localSnapshot: { number, operation: d.operation },
        remoteSnapshot: { externalId: diff.externalId, found: false },
        diff,
        diffHash,
        result: 'REMOTE_MISSING',
        severity: 'MONEY',
        lastSeenAt: now,
      },
    });
    await tx.auditLog.create({
      data: {
        tenantId: d.tenantId,
        action: 'reconcile.mismatch_found',
        entityType: 'reconcile_result',
        entityId: row.id,
        after: {
          check: diff.check,
          code: diff.code,
          result: 'REMOTE_MISSING',
          severity: 'MONEY',
          connector: c.adapterKey,
          entity,
          localNumber: number,
          outboxId: d.id,
        },
        reason: 'erp_not_found',
      },
    });
  }

  private async deliverOnce(
    d: OutboxDelivery,
    st: DeliveryState,
  ): Promise<{ result: Record<string, unknown> }> {
    const id = d.targetId;
    const { connector, tenant } = await d.withTx(async (tx) => ({
      connector: id ? await tx.connector.findUnique({ where: { id } }) : null,
      tenant: await tx.tenant.findUnique({
        where: { id: d.tenantId },
        select: { status: true, mode: true },
      }),
    }));
    // ST7-T09 กันชั้นที่ 2: sandbox ไม่ส่งอะไรเข้า ERP จริงเลย — D-81 · D68-58/96 ยกเว้น DemoProvider (ERP จำลองในระบบ ไม่ออกนอกระบบ)
    const sandbox = tenant?.mode === 'test';
    if (sandbox && !(connector && this.resolver.isSandboxAdapter(connector.adapterKey)))
      throw new OutboxSinkError('sandbox tenant — ERP push suppressed', 'CAPABILITY', {
        code: 'sandbox_unsupported',
      });
    if (!connector || connector.status === 'DISCONNECTED') {
      // INT-016 หยุดส่งทันที — ข้าม แต่ลง audit ให้หน้าคิว (ST7-T19) แสดง/แจ้งบัญชี
      if (connector) await this.skipped(d, connector, 'connector_disconnected');
      throw new OutboxSinkError('connector disconnected', 'CAPABILITY', {
        code: 'connector_disconnected',
      });
    }
    if (tenant && (tenant.status === 'SUSPENDED' || tenant.status === 'CANCELLED'))
      throw new OutboxSinkError('tenant is not active — paused', 'AUTH', { code: 'tenant_paused' });
    if (connector.status !== 'ACTIVE')
      throw new OutboxSinkError(`connector ${connector.status.toLowerCase()}`, 'AUTH', {
        code: 'connector_not_active',
        status: connector.status,
      });
    // D-81 · D68-57 healthCheck ของ connector กำลังล้ม (TRANSIENT ต่อเนื่อง — ยังไม่ครบ 30 นาทีที่จะเป็น ERROR, D68-65) → พักทั้งคิว
    // ไม่ยิงปลายทาง ไม่เสียจำนวนครั้ง (docs/01 §6.3 "ถ้า healthCheck ล้ม → หยุดทั้งคิวของ connector นั้น") · ผ่านเมื่อไร worker
    // (`recheckUnhealthy` ทุก 5 นาที) / ผู้ดูแลกด "ทดสอบการเชื่อมต่อ" ล้างเวลาแล้วปลุกคิว (`wakeParked`)
    if (connector.healthFailingSince)
      throw new OutboxSinkError('connector health check failing — queue paused', 'AUTH', {
        code: 'connector_unhealthy',
        since: connector.healthFailingSince.toISOString(),
      });
    if (!(await this.entitlements.enabled(d.tenantId, 'conn')))
      throw new OutboxSinkError('connectors not in plan — paused', 'AUTH', { code: 'feature_off' });
    const resolved = this.resolver.describe(connector, null, undefined, sandbox);
    const adapter = resolved.adapter;
    if (!adapter)
      throw new OutboxSinkError('adapter not installed — paused', 'AUTH', {
        code: 'adapter_unavailable',
        adapterKey: connector.adapterKey,
      });
    if (!isErpOperation(d.operation))
      throw new OutboxSinkError(`unknown operation ${d.operation}`, 'VALIDATION', {
        code: 'unknown_operation',
      });
    const cap = ERP_OPERATION_CAPABILITY[d.operation];
    // ST8-T16 (review L3) แจ้งยกเลิกเอกสารที่ส่งไปแล้ว: ยังไม่มี adapter ใดยกเลิกผ่าน API (void ผ่านใบลดหนี้ = ST7-T16)
    // → งานที่บัญชีต้องตรวจ/ยกเลิกในระบบบัญชีเอง (SKIPPED + audit แจ้งบัญชี) ทุก adapter
    if (d.operation === 'VOID_DOCUMENT') {
      await this.skipped(d, connector, 'void_manual_required');
      throw new OutboxSinkError(
        'document was cancelled in TMS — check and cancel it in the accounting system manually',
        'CAPABILITY',
        { code: 'void_manual_required', capability: cap },
      );
    }
    // ST8-T03 adapter ประกาศแต่ยังไม่ได้ทำ → พักไว้ (ไม่ทิ้ง ไม่เสียจำนวนครั้ง) จนกว่า deploy ตัวที่ทำแล้ว
    if (isPendingCapability(adapter, cap)) throw parkedNotImplemented(cap);
    if (!adapter.capabilities().has(cap)) {
      // adapter ทำไม่ได้จริง → SKIPPED + แจ้งบัญชี (docs/01 §6.3 CAPABILITY)
      await this.skipped(d, connector, 'capability_not_supported');
      throw new OutboxSinkError(`capability ${cap} not supported`, 'CAPABILITY', {
        code: 'capability_not_supported',
        capability: cap,
      });
    }
    if (!resolved.capabilities.includes(cap))
      // tenant ปิดไว้ (adapter รองรับ) → พักคำสั่ง ไม่ทิ้ง — เปิดกลับแล้วส่งต่อ (ConnectorsService.update ปลุก)
      throw new OutboxSinkError(`capability ${cap} turned off — parked`, 'AUTH', {
        code: 'capability_off',
        capability: cap,
      });

    // ST7-T17 ยังไม่เลือกเจ้าของเอกสารภาษี → พักคำสั่งส่งเอกสารภาษี (ไม่ทิ้ง ไม่เสียจำนวนครั้ง) จนกว่าจะเลือก (setSystemOfRecord ปลุก)
    if (
      !connector.taxDocumentOwner &&
      (SOR_TAX_PUSH_CAPABILITIES as readonly string[]).includes(cap)
    )
      throw new OutboxSinkError(`tax document owner not chosen — parked`, 'AUTH', {
        code: 'sor_not_chosen',
        capability: cap,
      });

    // ST8-T16 (review M1) ตรวจสถานะเอกสารต้นทางก่อนส่งทุกครั้ง — ยกเลิกแล้ว (เช่น ยกเลิกใบระหว่างคำสั่งรอคิว/พักไว้) = ไม่ส่ง
    if (
      d.operation === 'PUSH_INVOICE' ||
      d.operation === 'PUSH_SETTLEMENT' ||
      (d.operation === 'REPLACE_DOCUMENT' && MAPPED_ENTITIES[d.entityType])
    ) {
      const state = await d.withTx((tx) => sourceState(tx, d.entityType, d.localId));
      if (state === 'CANCELLED') {
        await this.skipped(d, connector, 'document_cancelled');
        throw new OutboxSinkError('source document was cancelled — not sent', 'CAPABILITY', {
          code: 'document_cancelled',
        });
      }
    }

    // ST7-T16 ประตู `syncFromDate` (docs/01 §6.4; docs/04 G3): เอกสารที่วันที่ก่อนวันเริ่มซิงก์ไม่ถูกส่ง (บัญชีคีย์ไว้เองก่อน go-live)
    // ตรวจ ณ ตอนส่งด้วย — คำสั่งที่ค้าง/พักไว้ก่อนผู้ดูแลเลื่อนวันเริ่มซิงก์ก็ไม่ถูกส่ง · ไม่แจ้งบัญชี (ไม่ใช่งานที่ต้องทำ)
    if (PUSH_OPERATIONS.has(d.operation) && connector.syncFromDate) {
      const from = connector.syncFromDate.toISOString().slice(0, 10);
      const p = (d.payload ?? {}) as { document?: unknown };
      const date = documentDate(p.document ?? p);
      if (date && date < from)
        throw new OutboxSinkError(
          'document is dated before the connector sync start date — not sent',
          'CAPABILITY',
          { code: 'before_sync_from_date', documentDate: date, syncFromDate: from },
        );
    }

    // สำเนาตื้น — ใส่รหัส ERP ที่จับคู่โดยไม่แก้ payload ที่เก็บในคิว
    const payload = { ...((d.payload ?? {}) as Record<string, unknown>) } as {
      document?: CanonicalDocument;
      ref?: ExternalRef;
      branchId?: string;
    };
    const ctx = this.connectors.contextOf(connector, {
      idempotencyKey: d.idempotencyKey,
      signal: d.signal,
      branchId: typeof payload.branchId === 'string' ? payload.branchId : null,
    });
    // ST7-T16 sync log: adapter รายงานทุก HTTP call (บันทึกหลังจบการส่งใน `deliver`)
    ctx.onHttpCall = (call) => {
      if (st.calls.length < 50) st.calls.push(call);
    };
    st.connector = connector;
    // ST7-T18 ประตู mapping + ST8-T06 ผังรหัสที่ adapter ประกาศ (docs/01 §7.4) — ตรวจหลังเงื่อนไข "ส่งได้" ทั้งหมด
    // (คำสั่งที่พัก/ข้ามไม่ถูกตัดสินว่าล้ม) · คำสั่งดึงข้อมูล (FETCH_*) ไม่มีเอกสารให้ตรวจ
    const operation = d.operation as ErpOperation; // ตรวจด้วย isErpOperation ข้างบนแล้ว
    const secrets = connector.credentialKeys.map((k) => ctx.config[k] ?? '');
    st.secrets = secrets;
    /** ST7-T15 สิ่งที่ส่งจริง (เก็บในผลของคำสั่ง): hash + รหัสคู่ค้าฝั่ง ERP ที่ใส่ ณ ตอนส่ง */
    let sent: Record<string, unknown> = {};
    /** ST7-T16 วิธีส่ง (สร้างใหม่ / แทนที่ฉบับใน ERP) + hash ต่อกลุ่ม field ของสิ่งที่ส่ง */
    let mode: SendMode = { kind: 'push' };
    let parts: Record<SyncPart, string> | null = null;
    if (PUSH_OPERATIONS.has(operation)) {
      // รูปของ payload ก่อนเข้าประตู (REPLACE_DOCUMENT ต้องมีทั้ง ref และ document)
      if (operation === 'REPLACE_DOCUMENT' && (!payload.ref || !payload.document))
        throw new OutboxSinkError('ref and document required', 'VALIDATION', {
          code: 'invalid_payload',
        });
      const doc = payload.document ?? (payload as CanonicalDocument);
      st.number = typeof doc?.number === 'string' ? doc.number.slice(0, 60) : null;
      // ST7-T15 รูปของ canonical (เลข TMS ที่ส่งไปช่อง ref ของ ERP, วันที่, ยอดเงิน) — ผิด = ไม่ถึง adapter
      const shape = canonicalProblems(doc);
      if (shape.length)
        throw new OutboxSinkError('canonical payload is invalid', 'VALIDATION', {
          code: 'invalid_payload',
          message: 'ข้อมูลเอกสารที่จะส่งเข้าระบบบัญชีไม่ครบหรือผิดรูป',
          fields: shape,
        });
      let prep: PushPreparation;
      try {
        prep = await d.withTx(async (tx) =>
          this.masterCodes.prepareForPush(
            tx,
            connector.id,
            adapter,
            ctx,
            operation,
            // ST7-T15 รหัสลูกค้า/รถร่วมฝั่ง ERP จาก external_mapping ณ ตอนส่ง (docs/01 §7.4)
            await this.mappings.withPartyCodes(tx, connector.id, doc),
          ),
        );
      } catch (e) {
        // adapter.masterCodeRefs พัง / ฐานข้อมูลล้ม — ลองใหม่ตาม policy · ข้อความตัด credential ก่อนเก็บ
        const msg = scrub(String((e as Error)?.message ?? e), secrets).slice(0, 500);
        throw new OutboxSinkError(msg || 'master code check failed', 'TRANSIENT', {
          code: 'erp_master_code_check_failed',
          message: msg,
        });
      }
      if (!prep.ok)
        throw new OutboxSinkError(prep.problem.message, 'VALIDATION', { ...prep.problem });
      // D-80 ข้อมูลส่วนบุคคลที่ adapter ประกาศ — ใส่ ณ ตอนส่งเท่านั้น (ไม่อยู่ใน payload ของคิว)
      const pii = await d.withTx((tx) =>
        injectPersonalData(tx, prep.document, adapter.personalDataNeeds ?? []),
      );
      secrets.push(...pii.secrets);
      // ST7-T15 hash ของเอกสารที่จะส่งจริง (หลังใส่รหัสฝั่ง ERP) — เท่ากับที่ส่งสำเร็จล่าสุด = ไม่ส่งซ้ำ
      // D-80 ช่องข้อมูลส่วนบุคคลนับใน hash ในรูป blind index (เลขเปลี่ยน = hash เปลี่ยน · hash ย้อนหาเลขไม่ได้)
      const hashed = withSyncHash(pii.forHash);
      const ready = { ...pii.document, sync: hashed.sync } as CanonicalDocument;
      parts = syncParts(pii.forHash as CanonicalDocument);
      const entity = MAPPED_ENTITIES[d.entityType];
      if (entity) {
        const prior = await d.withTx((tx) =>
          tx.externalMapping.findUnique({
            where: {
              connectorId_entityType_localId: {
                connectorId: connector.id,
                entityType: entity,
                localId: d.localId,
              },
            },
            select: {
              status: true,
              lastSyncedHash: true,
              externalId: true,
              externalDocNo: true,
              externalVersion: true,
              externalStatus: true,
              lastSyncedParts: true,
            },
          }),
        );
        if (
          prior?.status === 'SYNCED' &&
          prior.externalId &&
          // เอกสารฝั่ง ERP ถูกยกเลิกแล้ว = ของที่ "ส่งสำเร็จล่าสุด" ใช้ไม่ได้อีก → ไม่ข้าม (ส่งใหม่ได้)
          prior.externalStatus !== 'VOIDED' &&
          prior.lastSyncedHash === ready.sync!.hash
        ) {
          // คำสั่งนี้เคยจบ DONE มาก่อนไหม (มี `result` ค้างจากรอบก่อน — ส่งซ้ำด้วยมือ) หรือยังไม่เคยจบ (เสีย lease หลังบันทึก mapping)
          const self = await d.withTx((tx) =>
            tx.integrationOutbox.findUnique({ where: { id: d.id }, select: { result: true } }),
          );
          if (self?.result == null)
            return {
              result: {
                externalId: prior.externalId,
                externalDocNo: prior.externalDocNo,
                externalVersion: prior.externalVersion,
                unchanged: true,
                sentHash: ready.sync!.hash,
              },
            };
          throw new OutboxSinkError(
            'payload unchanged since the last successful sync — not sent',
            'CAPABILITY',
            {
              code: 'payload_unchanged',
              externalId: prior.externalId,
              externalDocNo: prior.externalDocNo,
            },
          );
        }
        mode = await this.sendMode(
          d,
          connector,
          adapter,
          resolved.capabilities,
          prior,
          ready,
          parts,
        );
      } else if (d.operation === 'REPLACE_DOCUMENT' && payload.ref)
        mode = { kind: 'replace', ref: payload.ref };
      if (payload.document) payload.document = ready;
      else Object.assign(payload, ready);
      ctx.masterCodes = prep.masterCodes;
      // ST7-T15 key กันซ้ำฝั่ง ERP ผูกกับเนื้อหาที่ส่งจริง
      ctx.idempotencyKey = sentIdempotencyKey(d.idempotencyKey, ready.sync!.hash);
      sent = {
        sentHash: ready.sync!.hash,
        ...partyCodesOf(ready),
        ...(pii.fields.length ? { personalDataSent: pii.fields } : {}),
      };
      // D-80 ลง audit ก่อนเรียก adapter — เรียกแล้ว = ข้อมูล**อาจ**ออกนอก TMS แล้วแม้ผลจะล้ม (ทุกครั้งที่ส่ง/ลองใหม่)
      // `mayInclude`: core ส่งค่าให้ adapter แล้ว แต่ adapter อาจไม่ได้ใช้จริง (เช่น จับคู่คู่ค้าด้วยรหัสที่ map ไว้) — core ไม่รู้
      if (pii.fields.length)
        await d.withTx((tx) =>
          tx.auditLog.create({
            data: {
              tenantId: d.tenantId,
              action: 'connector.pii_sent',
              entityType: 'connector',
              entityId: connector.id,
              after: {
                outboxId: d.id,
                operation: d.operation,
                entityType: d.entityType,
                localId: d.localId,
                fields: pii.fields,
                mayInclude: true,
              },
              reason: 'adapter_personal_data_needs',
            },
          }),
        );
    }
    try {
      return await this.call(
        d,
        st,
        adapter,
        resolved.capabilities,
        ctx,
        payload,
        secrets,
        connector,
        {
          sent,
          mode,
          parts,
        },
      );
    } catch (e) {
      if (e instanceof OutboxSinkError) {
        if (e.errorClass === 'TRANSIENT') await this.stopIfDown(d, connector);
        throw e;
      }
      if (e instanceof ErpAdapterError) {
        if (e.problem?.code === NOT_IMPLEMENTED) throw parkedNotImplemented(st.cap ?? cap);
        const problem = {
          code: scrub(String(e.problem?.code ?? 'error'), secrets).slice(0, 60),
          message: scrub(String(e.problem?.message ?? ''), secrets).slice(0, 500),
        };
        if (e.errorClass === 'AUTH')
          await d.withTx((tx) => this.connectors.markError(tx, connector, problem));
        if (e.errorClass === 'TRANSIENT') await this.stopIfDown(d, connector);
        throw new OutboxSinkError(problem.message || problem.code, e.errorClass, problem);
      }
      // adapter throw = TRANSIENT (docs/01 §6.3) — ข้อความอาจมี credential (URL/header ของ HTTP client) → ตัดก่อนเก็บ
      const msg = scrub(String((e as Error)?.message ?? e), secrets).slice(0, 500);
      await this.stopIfDown(d, connector);
      throw new OutboxSinkError(msg || 'adapter error', 'TRANSIENT', {
        code: 'adapter_threw',
        message: msg,
      });
    }
  }

  /**
   * ST8-T03 ส่งล้มแบบ TRANSIENT → ถาม healthCheck ว่าปลายทางล่มทั้งตัวไหม (docs/01 A.5) แล้วบันทึกแบบ "ระบบ"
   * (`applySystemHealth`: AUTH = ERROR ทันที · TRANSIENT = จดเวลาเริ่มล้ม ครบ 30 นาทีต่อเนื่อง = ERROR หยุดทั้งคิว — spec/07 §1)
   * ไม่ throw (ผลของคำสั่งนี้ยังเป็น TRANSIENT ตามเดิม) · ไม่ทำตอนถูกยกเลิก (lease หลุด/ปิด worker)
   */
  private async stopIfDown(d: OutboxDelivery, connector: Connector): Promise<void> {
    if (d.signal.aborted) return;
    try {
      const h = await this.connectors.runHealth(connector);
      if (!h.ok && !HEALTH_STOP_CLASSES.has(h.errorClass)) return;
      const back = await d.withTx((tx) =>
        this.connectors.applySystemHealth(tx, connector.id, h, this.clock.now()),
      );
      if (back) await this.connectors.wakeParked(d.tenantId, connector.id);
    } catch {
      /* ตรวจไม่ได้ = คงสถานะเดิม (คำสั่งนี้ลองใหม่ตาม policy) */
    }
  }

  /**
   * ST8-T16 push สำเร็จ → `external_mapping` (เลข/สถานะฝั่ง ERP + hash ของ payload ที่ส่ง) — ส่งซ้ำ = อัปเดตแถวเดิม
   * ไม่ทับเลขเอกสาร/สถานะที่ได้จาก webhook แล้ว (ERP ตอบ "มีอยู่แล้ว" กับร่างที่ลงบัญชีไปแล้ว)
   */
  private async recordMapping(
    d: OutboxDelivery,
    c: Connector,
    payload: { document?: CanonicalDocument },
    r: Extract<PushResult, { ok: true }>,
    applied: boolean,
    parts: Record<SyncPart, string> | null = null,
  ): Promise<void> {
    const entity = MAPPED_ENTITIES[d.entityType];
    if (!entity) return;
    const doc = payload.document ?? (payload as CanonicalDocument);
    const number = typeof doc?.number === 'string' ? doc.number.slice(0, 60) : null;
    const hash = typeof doc?.sync?.hash === 'string' ? doc.sync.hash.slice(0, 64) : null;
    // ST7-T15 revision/ETag ฝั่ง ERP (ถ้ามี — docs/01 §3.7 `external_version`)
    const version = typeof r.externalVersion === 'string' ? r.externalVersion.slice(0, 100) : null;
    const now = this.clock.now();
    const partsJson = parts ? JSON.stringify(parts) : null;
    // ST8-T08 เอกสาร TMS ใบเดียว = หลายเอกสารฝั่ง ERP (เช่น KRS แยกตาม vat_type) → เก็บทุกใบใน `detail.documents`
    // (key หลัก external_id / external_doc_no = ใบแรก) · ส่งครั้งใหม่เป็นใบเดียว = ลบรายการเดิมออก
    const docs = externalDocumentsOf(r);
    const docsJson = docs ? JSON.stringify({ documents: docs }) : null;
    await d.withTx(async (tx) => {
      if (applied) {
        await tx.$executeRaw`
          INSERT INTO external_mapping (id, tenant_id, connector_id, entity_type, local_id, local_number, external_id,
                                        external_doc_no, external_version, external_status, status, last_synced_hash,
                                        last_synced_parts, last_synced_at, detail, created_by, updated_at)
          VALUES (gen_random_uuid(), ${d.tenantId}::uuid, ${c.id}::uuid, ${entity}::"ExternalEntityType",
                  ${d.localId}::uuid, ${number}, ${String(r.externalId).slice(0, 100)},
                  ${r.externalDocNo?.slice(0, 100) ?? null}, ${version}, 'DRAFT', 'SYNCED', ${hash},
                  ${partsJson}::jsonb, ${now}, ${docsJson}::jsonb, 'system:erp-sink', now())
          ON CONFLICT (connector_id, entity_type, local_id) DO UPDATE
             SET external_id = EXCLUDED.external_id,
                 detail = CASE WHEN EXCLUDED.detail IS NOT NULL
                               THEN coalesce(external_mapping.detail, '{}'::jsonb) || EXCLUDED.detail
                               WHEN external_mapping.detail ? 'documents'
                               THEN external_mapping.detail - 'documents'
                               ELSE external_mapping.detail END,
                 local_number = coalesce(EXCLUDED.local_number, external_mapping.local_number),
                 external_doc_no = coalesce(external_mapping.external_doc_no, EXCLUDED.external_doc_no),
                 external_version = coalesce(EXCLUDED.external_version, external_mapping.external_version),
                 external_status = coalesce(external_mapping.external_status, EXCLUDED.external_status),
                 status = 'SYNCED', last_error = NULL,
                 last_synced_hash = EXCLUDED.last_synced_hash, last_synced_parts = EXCLUDED.last_synced_parts,
                 last_synced_at = EXCLUDED.last_synced_at,
                 updated_by = 'system:erp-sink', version = external_mapping.version + 1, updated_at = now()`;
        return;
      }
      // ST7-T15 ERP คืนเอกสารเดิม (ไม่ยืนยันว่ารับเนื้อหาครั้งนี้) → **ไม่เลื่อน `last_synced_hash`**
      // - hash เดิมตรงกับที่ส่ง (เช่น ส่งใหม่หลังเอกสารฝั่ง ERP ถูกยกเลิก) = คงสถานะเดิม
      // - มี hash เดิมที่ต่าง = ERP ยังถือเนื้อหาเก่า → MISMATCH `erp_not_applied`
      // - ยังไม่เคยมี mapping (ผลของรอบก่อนไม่ถูกบันทึก) = รู้ id แต่ไม่รู้เนื้อหา → MISMATCH `erp_content_unverified` (hash ว่าง)
      // ปิดด้วย reconcile / REPLACE_DOCUMENT (ST7-T16) — ทางระมัดระวัง: ไม่ถือว่าตรงถ้าไม่มีหลักฐาน
      const problem = (code: string) =>
        JSON.stringify({ code, sentHash: hash, at: now.toISOString() });
      await tx.$executeRaw`
        INSERT INTO external_mapping (id, tenant_id, connector_id, entity_type, local_id, local_number, external_id,
                                      external_doc_no, external_version, external_status, status, last_error,
                                      created_by, updated_at)
        VALUES (gen_random_uuid(), ${d.tenantId}::uuid, ${c.id}::uuid, ${entity}::"ExternalEntityType",
                ${d.localId}::uuid, ${number}, ${String(r.externalId).slice(0, 100)},
                ${r.externalDocNo?.slice(0, 100) ?? null}, ${version}, 'DRAFT', 'MISMATCH',
                ${problem('erp_content_unverified')}::jsonb, 'system:erp-sink', now())
        ON CONFLICT (connector_id, entity_type, local_id) DO UPDATE
           SET external_id = coalesce(external_mapping.external_id, EXCLUDED.external_id),
               local_number = coalesce(EXCLUDED.local_number, external_mapping.local_number),
               external_doc_no = coalesce(external_mapping.external_doc_no, EXCLUDED.external_doc_no),
               external_status = coalesce(external_mapping.external_status, EXCLUDED.external_status),
               status = CASE WHEN external_mapping.last_synced_hash IS NOT DISTINCT FROM ${hash}
                             THEN external_mapping.status ELSE 'MISMATCH'::"ExternalMappingStatus" END,
               last_error = CASE WHEN external_mapping.last_synced_hash IS NOT DISTINCT FROM ${hash}
                                 THEN external_mapping.last_error
                                 WHEN external_mapping.last_synced_hash IS NULL
                                 THEN ${problem('erp_content_unverified')}::jsonb
                                 ELSE ${problem('erp_not_applied')}::jsonb END,
               updated_by = 'system:erp-sink', version = external_mapping.version + 1, updated_at = now()`;
    });
  }

  /**
   * review: หลักฐานว่าเอกสารนี้ (ยังไม่มี id ฝั่ง ERP) อาจเคยถึง ERP แล้ว — คืนชนิดหลักฐาน / null
   * - `AMBIGUOUS` คำสั่งนี้ล้มแบบไม่รู้ผลรอบก่อน · `LEASE_RECLAIMED` ครั้งก่อนไม่ได้บันทึกผล (worker ตาย/ปิดระหว่างส่ง)
   * - `SYNC_LOG` มี POST/PUT ของเอกสารนี้ไป connector นี้ในบันทึกการซิงก์ (คำสั่งใดก็ได้ — รวมคำสั่งที่ส่งใหม่)
   * - `EARLIER_COMMAND` คำสั่งก่อนหน้าของเอกสารนี้จบแบบไม่รู้ผล (AMBIGUOUS / lease_expired / worker_shutdown)
   */
  private async earlierSend(d: OutboxDelivery, c: Connector): Promise<string | null> {
    return d.withTx(async (tx) => {
      const self = await tx.integrationOutbox.findUnique({
        where: { id: d.id },
        select: { errorClass: true, lastError: true },
      });
      const code = (self?.lastError as { code?: unknown } | null)?.code;
      if (self?.errorClass === 'AMBIGUOUS') return 'AMBIGUOUS';
      if (d.attempt > 1 && (self?.errorClass == null || code === 'worker_shutdown'))
        return 'LEASE_RECLAIMED';
      const sent = await tx.erpSyncLog.findFirst({
        where: {
          connectorId: c.id,
          entityType: d.entityType,
          localId: d.localId,
          method: { in: ['POST', 'PUT'] },
        },
        select: { id: true },
      });
      if (sent) return 'SYNC_LOG';
      const unsure = await tx.integrationOutbox.findFirst({
        where: {
          sink: ERP_SINK,
          targetId: c.id,
          entityType: d.entityType,
          localId: d.localId,
          id: { not: d.id },
          OR: [
            { errorClass: 'AMBIGUOUS' },
            { lastError: { path: ['code'], equals: 'lease_expired' } },
            { lastError: { path: ['code'], equals: 'worker_shutdown' } },
          ],
        },
        select: { id: true },
      });
      return unsure ? 'EARLIER_COMMAND' : null;
    });
  }

  /** แจ้งฝ่ายบัญชีให้ทำต่อด้วยมือ (คำสั่งที่จบ DONE แต่ยังต้องมีคน — เช่น DUPLICATE ที่หา id ฝั่ง ERP ไม่ได้) */
  private async notifyManual(d: OutboxDelivery, c: Connector, number: string | null) {
    try {
      await d.withTx((tx) =>
        this.events.documentNotSent(tx, {
          tenantId: d.tenantId,
          connectorId: c.id,
          errorClass: 'DUPLICATE',
          entityType: d.entityType,
          localId: d.localId,
          documentNo: number,
          label: this.connectors.adapterLabel(c.adapterKey),
          outcome: 'FAILED_FINAL',
          code: 'duplicate_unresolved',
        }),
      );
    } catch (e) {
      this.logger.warn(`notify ${d.id}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }

  /** อ้างอิงเอกสารของเรา (ยังไม่รู้ id ฝั่ง ERP) — ใช้ค้นด้วยเลขอ้างอิง */
  private refOf(d: OutboxDelivery, doc: CanonicalDocument): ExternalRef {
    return {
      entityType: d.entityType,
      localId: d.localId,
      number: String(doc?.number ?? ''),
      externalId: null,
    };
  }

  /** ST7-T16 DUPLICATE ที่หาเอกสารฝั่ง ERP ไม่เจอ → mapping MISMATCH `duplicate_unresolved` (คงค่าเดิมที่มี) */
  private async duplicateUnresolved(
    d: OutboxDelivery,
    c: Connector,
    entity: 'INVOICE' | 'SETTLEMENT',
    number: string | null,
  ) {
    const lastError = JSON.stringify({
      code: 'duplicate_unresolved',
      errorClass: 'DUPLICATE',
      outboxId: d.id,
      at: this.clock.now().toISOString(),
    });
    await d.withTx(
      (tx) => tx.$executeRaw`
        INSERT INTO external_mapping (id, tenant_id, connector_id, entity_type, local_id, local_number, status, last_error,
                                      created_by, updated_at)
        VALUES (gen_random_uuid(), ${d.tenantId}::uuid, ${c.id}::uuid, ${entity}::"ExternalEntityType",
                ${d.localId}::uuid, ${number?.slice(0, 60) ?? null}, 'MISMATCH', ${lastError}::jsonb,
                'system:erp-sink', now())
        ON CONFLICT (connector_id, entity_type, local_id) DO UPDATE
           SET status = 'MISMATCH', last_error = EXCLUDED.last_error,
               local_number = coalesce(external_mapping.local_number, EXCLUDED.local_number),
               updated_by = 'system:erp-sink', version = external_mapping.version + 1, updated_at = now()`,
    );
  }

  private async skipped(d: OutboxDelivery, c: Connector, code: string) {
    await d.withTx((tx) =>
      this.connectors.recordSkipped(
        tx,
        c,
        { id: d.id, operation: d.operation, entityType: d.entityType, localId: d.localId },
        code,
      ),
    );
  }

  /** capability ใช้ได้จริงกับ connector นี้: adapter ทำแล้ว (ไม่ pending) ∩ tenant เปิด */
  private usable(adapter: ErpAdapter, enabled: readonly string[], cap: ErpCapability): boolean {
    return (
      adapter.capabilities().has(cap) && !isPendingCapability(adapter, cap) && enabled.includes(cap)
    );
  }

  /**
   * review: capability ที่ adapter ประกาศแต่ยังไม่ได้ทำ (`pendingCapabilities`) = **พักคำสั่ง** (PENDING ไม่นับครั้ง — docs/01 §6.3
   * CAPABILITY, D-81 · D68-65) ไม่ใช่ SKIPPED · ใช้ได้ = true · ไม่รองรับ/tenant ไม่เปิด = false (ผู้เรียกตัดสินต่อ)
   */
  private usableOrPark(
    adapter: ErpAdapter,
    enabled: readonly string[],
    cap: ErpCapability,
  ): boolean {
    if (adapter.capabilities().has(cap) && isPendingCapability(adapter, cap))
      throw parkedNotImplemented(cap);
    return this.usable(adapter, enabled, cap);
  }

  /** คำสั่งส่งเอกสารที่ไม่ส่ง (SKIPPED + audit + แจ้งบัญชีตาม `onSettled`) */
  private async skip(
    d: OutboxDelivery,
    c: Connector,
    code: string,
    message: string,
    detail: Record<string, unknown> = {},
  ): Promise<never> {
    await this.skipped(d, c, code);
    throw new OutboxSinkError(message, 'CAPABILITY', { code, ...detail });
  }

  /**
   * ST7-T16 (+ ST7-T17) เอกสารที่ส่งแล้วถูกเปลี่ยน → ส่งการเปลี่ยนแบบไหน (docs/04 G3 System-of-record; docs/01 §6.1 `replaceDocument`)
   * - `documentInErp` = external_mapping ของ**เอกสารนั้น**มี external_id และฝั่ง ERP ไม่ได้ยกเลิก (ไม่ใช่ค่าระดับ connector)
   * - ไม่อยู่ใน ERP → ส่งเป็นเอกสารใหม่ (push) · REPLACE_DOCUMENT ของเอกสารที่ยังไม่อยู่ใน ERP = push ด้วย method ของชนิดเอกสาร
   * - อยู่ใน ERP + เนื้อหาต่าง: กลุ่ม field ที่เปลี่ยน (hash ต่อกลุ่มเทียบ `last_synced_parts`; ไม่รู้ = ทุกกลุ่ม) → `fieldChangePolicy`
   *   · รับชำระแล้ว → SKIPPED `paid_locked` (กฎ "แก้ได้จนรับชำระ" — ไม่ส่ง)
   *   · กลุ่มที่ต้อง regenerate (ลูกค้า / ช่องนอกกลุ่ม) → SKIPPED `regenerate_required` (ยกเลิกใบเดิมในระบบบัญชีแล้วออกใหม่ — ทำมือ)
   *   · auto-sync → แทนที่ทั้งใบด้วย `replaceDocument` (canonical ฉบับที่ออก + รหัส ณ ตอนส่ง) · ERP แจ้งว่าลงบัญชีแล้ว (`POSTED`)
   *     → SKIPPED `replace_requires_approval` (docs/01 §6.1 ต้องอนุมัติ — ยังไม่มีขั้นอนุมัติ) · adapter ไม่มี/ไม่เปิด replaceDocument
   *     → SKIPPED `replace_not_supported` (docs/01 §6.1: ไม่มีทั้ง pushCreditNote/replaceDocument → แจ้งบัญชีทำมือ; TMS ไม่ออกใบลด/เพิ่มหนี้ — D-54)
   * เอกสารภาษีที่ออกแล้วใน TMS ไม่ถูกแก้ที่นี่ — ส่งเฉพาะสิ่งที่ TMS ถืออยู่ (ฉบับที่ออก) ไปแทนฉบับใน ERP
   */
  private async sendMode(
    d: OutboxDelivery,
    connector: Connector,
    adapter: ErpAdapter,
    enabled: readonly string[],
    prior: {
      externalId: string | null;
      externalDocNo: string | null;
      externalStatus: string | null;
      lastSyncedParts: unknown;
    } | null,
    ready: CanonicalDocument,
    parts: Record<SyncPart, string>,
  ): Promise<SendMode> {
    const inErp = !!prior?.externalId && prior.externalStatus !== 'VOIDED';
    if (!prior || !inErp) {
      if (d.operation === 'REPLACE_DOCUMENT') {
        const cap = PUSH_CAPABILITY_OF[d.entityType];
        if (!cap || !this.usableOrPark(adapter, enabled, cap))
          await this.skip(
            d,
            connector,
            'capability_not_supported',
            `capability ${cap} not supported`,
            {
              capability: cap ?? null,
            },
          );
      }
      return { kind: 'push' };
    }
    const changed = changedSyncParts(prior.lastSyncedParts, parts);
    const status =
      d.entityType === 'invoice'
        ? ((
            await d.withTx((tx) =>
              tx.invoice.findUnique({ where: { id: d.localId }, select: { status: true } }),
            )
          )?.status ?? null)
        : null;
    // review: "แก้ได้จนรับชำระ" เป็นกฎ — ใบที่รับชำระแล้วไม่แทนที่ใน ERP เลย แม้ไม่มีกลุ่มที่เปลี่ยน (เช่น ส่งใหม่หลัง MISMATCH)
    if (status && (SOR_PAYMENT_RECEIVED_STATUSES as readonly string[]).includes(status))
      await this.skip(d, connector, 'paid_locked', 'document already paid — changes are not sent', {
        changed,
        externalId: prior.externalId,
        externalDocNo: prior.externalDocNo,
      });
    const sor = sorOf(connector);
    const decision = combineDecisions(
      changed.map((g) =>
        g === 'OTHER' ? { mode: 'REGENERATE' } : fieldChangePolicy(sor, g, status, true),
      ),
    );
    const detail = {
      changed,
      externalId: prior.externalId,
      externalDocNo: prior.externalDocNo,
    };
    if (decision.mode === 'BLOCKED')
      await this.skip(
        d,
        connector,
        'paid_locked',
        'document already paid — changes are not sent',
        detail,
      );
    if (decision.mode === 'REGENERATE')
      await this.skip(
        d,
        connector,
        'regenerate_required',
        'change requires regenerating the document in the accounting system — not sent',
        detail,
      );
    if (prior.externalStatus === 'POSTED')
      await this.skip(
        d,
        connector,
        'replace_requires_approval',
        'document is posted in the accounting system — replacing needs approval',
        detail,
      );
    if (!this.usableOrPark(adapter, enabled, 'replaceDocument'))
      await this.skip(
        d,
        connector,
        'replace_not_supported',
        'accounting system cannot replace the document — update it manually',
        detail,
      );
    return {
      kind: 'replace',
      ref: {
        entityType: d.entityType,
        localId: d.localId,
        number: String(ready.number),
        externalId: prior.externalId,
      },
    };
  }

  /**
   * ST7-T16 หาเอกสารของเราฝั่ง ERP (docs/01 §6.3 AMBIGUOUS / DUPLICATE): `listDocuments` ค้นด้วยเลขอ้างอิงของเรา →
   * `fetchDocument` แล้วเทียบเนื้อหา · ไม่มีทั้งสอง capability = `searched: false`
   * พบด้วย list อย่างเดียว (ไม่มี fetch) = รู้ id แต่ไม่รู้เนื้อหา (`same: null`) · throw = ปลายทางล่ม (ผู้เรียกให้ลองใหม่)
   */
  private async lookup(
    adapter: ErpAdapter,
    enabled: readonly string[],
    ctx: ErpContext,
    ref: ExternalRef,
    sent: CanonicalDocument,
  ): Promise<
    | { searched: false }
    | { searched: true; found: false }
    | {
        searched: true;
        found: true;
        externalId: string;
        externalDocNo: string | null;
        same: boolean | null;
      }
  > {
    const canList = this.usable(adapter, enabled, 'listDocuments') && !!adapter.listDocuments;
    const canFetch = this.usable(adapter, enabled, 'fetchDocument') && !!adapter.fetchDocument;
    if (!canList && !canFetch) {
      // review: ค้นได้เมื่อ adapter ทำเสร็จ (ประกาศแต่ยัง pending) → พักคำสั่ง ไม่ส่งซ้ำแบบไม่รู้ผล
      for (const cap of ['fetchDocument', 'listDocuments'] as const)
        if (adapter.capabilities().has(cap) && isPendingCapability(adapter, cap))
          throw parkedNotImplemented(cap);
      return { searched: false };
    }
    let externalId = ref.externalId;
    if (!externalId && canList) {
      const page = await adapter.listDocuments!(ctx, { ref: ref.number, limit: 10 });
      const hit = (page?.items ?? []).find(
        (i) =>
          i.number === ref.number && !!i.externalId && (!i.localId || i.localId === ref.localId),
      );
      externalId = hit?.externalId ?? null;
      if (!canFetch)
        return externalId
          ? { searched: true, found: true, externalId, externalDocNo: null, same: null }
          : { searched: true, found: false };
      if (!externalId) return { searched: true, found: false };
    }
    const got = await adapter.fetchDocument!(ctx, { ...ref, externalId });
    const gotId =
      typeof got?.externalId === 'string' && got.externalId ? got.externalId : externalId;
    if (!got || !gotId) return { searched: true, found: false };
    return {
      searched: true,
      found: true,
      externalId: gotId.slice(0, 100),
      externalDocNo: typeof got.externalDocNo === 'string' ? got.externalDocNo.slice(0, 100) : null,
      same: sameContent(got, sent),
    };
  }

  private async call(
    d: OutboxDelivery,
    st: DeliveryState,
    adapter: ErpAdapter,
    enabled: readonly string[],
    ctx: ErpContext,
    payload: { document?: CanonicalDocument; ref?: ExternalRef },
    secrets: string[],
    connector: Connector,
    o: { sent: Record<string, unknown>; mode: SendMode; parts: Record<SyncPart, string> | null },
  ): Promise<{ result: Record<string, unknown> }> {
    const { sent, mode, parts } = o;
    const doc = payload.document ?? (payload as CanonicalDocument);
    const entity = MAPPED_ENTITIES[d.entityType];
    /** ST7-T16 พบเอกสารของเราฝั่ง ERP แล้ว (หลัง AMBIGUOUS / DUPLICATE) → mapping + ผล DONE */
    const recovered = async (
      found: { externalId: string; externalDocNo: string | null; same: boolean | null },
      after: 'AMBIGUOUS' | 'EARLIER_SEND' | 'DUPLICATE',
    ) => {
      const applied = found.same === true;
      await this.recordMapping(
        d,
        connector,
        payload,
        { ok: true, externalId: found.externalId, externalDocNo: found.externalDocNo ?? undefined },
        applied,
        parts,
      );
      return {
        result: {
          externalId: found.externalId,
          externalDocNo: found.externalDocNo,
          externalVersion: null,
          applied,
          recoveredAfter: after,
          ...sent,
        },
      };
    };
    let r: PushResult;
    if (mode.kind === 'replace') {
      st.cap = 'replaceDocument';
      st.adapterCalled = true;
      r = await adapter.replaceDocument!(ctx, mode.ref, doc);
    } else
      switch (d.operation) {
        case 'PUSH_INVOICE':
        case 'PUSH_CREDIT_NOTE':
        case 'PUSH_SETTLEMENT':
        case 'REPLACE_DOCUMENT': {
          // ST7-T16 (docs/01 §6.3 AMBIGUOUS + review): เอกสารยังไม่มี id ฝั่ง ERP แต่มีหลักฐานว่าอาจเคยส่งถึงแล้ว
          // (AMBIGUOUS รอบก่อน · lease หลุด/worker ปิดระหว่างส่ง · sync log มี POST/PUT ของเอกสารนี้ · คำสั่งเดิมเคยค้างแบบไม่รู้ผล)
          // → หาเอกสารของเราฝั่ง ERP ก่อน (list/fetch) · พบ = จบด้วย mapping ไม่ส่งซ้ำ · ไม่พบ/ค้นไม่ได้ = ส่ง (ERP กันซ้ำด้วยเลขอ้างอิง)
          // ค้นแล้วปลายทางล่ม = TRANSIENT (ลองใหม่ตามตาราง — ไม่ส่งแบบไม่รู้ผล)
          if (entity) {
            const evidence = await this.earlierSend(d, connector);
            if (evidence) {
              let f: Awaited<ReturnType<ErpAdapterSink['lookup']>>;
              try {
                f = await this.lookup(adapter, enabled, ctx, this.refOf(d, doc), doc);
              } catch (e) {
                if (e instanceof OutboxSinkError) throw e;
                const msg = scrub(String((e as Error)?.message ?? e), secrets).slice(0, 500);
                throw new OutboxSinkError(msg || 'lookup failed', 'TRANSIENT', {
                  code: 'erp_lookup_failed',
                  message: msg,
                  evidence,
                });
              }
              if (f.searched && f.found)
                return recovered(f, evidence === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'EARLIER_SEND');
            }
          }
          const method =
            d.operation === 'PUSH_CREDIT_NOTE'
              ? 'pushCreditNote'
              : PUSH_CAPABILITY_OF[d.entityType] === 'pushSettlement' ||
                  d.operation === 'PUSH_SETTLEMENT'
                ? 'pushSettlement'
                : 'pushInvoice';
          st.cap = method;
          st.adapterCalled = true;
          r = await adapter[method]!(ctx, doc);
          break;
        }
        case 'FETCH_DOCUMENT': {
          if (!payload.ref)
            throw new OutboxSinkError('ref required', 'VALIDATION', { code: 'invalid_payload' });
          st.adapterCalled = true;
          const doc = await adapter.fetchDocument!(ctx, payload.ref);
          return { result: { found: !!doc, document: doc } };
        }
        case 'FETCH_PAYMENT_STATUS': {
          if (!payload.ref)
            throw new OutboxSinkError('ref required', 'VALIDATION', { code: 'invalid_payload' });
          const st = await adapter.fetchPaymentStatus!(ctx, payload.ref);
          return { result: { found: !!st, paymentStatus: st } };
        }
        case 'VOID_DOCUMENT':
          // ไม่ถึงที่นี่ (deliver ข้ามเป็น `void_manual_required` ก่อน) — ST7-T16: void ผ่านใบลดหนี้ต้องมีใบลดหนี้จริงใน TMS
          // ซึ่งเฟส 0 ไม่ออก (D-54) → [OPEN — PO/นักบัญชี] ไม่ส่ง ไม่เดา
          throw new OutboxSinkError('void via credit note is not implemented yet', 'VALIDATION', {
            code: 'void_not_implemented',
          });
        default:
          throw new OutboxSinkError(`unknown operation ${d.operation}`, 'VALIDATION', {
            code: 'unknown_operation',
          });
      }
    if (r.ok) {
      const applied = r.applied === true;
      await this.recordMapping(d, connector, payload, r, applied, parts);
      const docs = externalDocumentsOf(r);
      return {
        result: {
          externalId: r.externalId,
          externalDocNo: r.externalDocNo ?? null,
          externalVersion: r.externalVersion ?? null,
          applied,
          ...(docs ? { documents: docs } : {}),
          ...sent,
        },
      };
    }
    // ST7-T16 DUPLICATE (docs/01 §6.3): ERP มีเลขอ้างอิงนี้แล้ว — ไม่ใช่ error: หาเอกสารฝั่ง ERP แล้วบันทึก mapping (SYNCED เมื่อเนื้อหาตรง
    // · MISMATCH เมื่อต่าง/ไม่รู้) · หาไม่เจอ = FAILED_FINAL `duplicate_unresolved` ให้คนกรอกเลขจากระบบบัญชี (mapping MISMATCH)
    if (r.errorClass === 'DUPLICATE' && entity && mode.kind === 'push') {
      let f: Awaited<ReturnType<ErpAdapterSink['lookup']>>;
      try {
        f = await this.lookup(adapter, enabled, ctx, this.refOf(d, doc), doc);
      } catch (e) {
        const msg = scrub(String((e as Error)?.message ?? e), secrets).slice(0, 500);
        throw new OutboxSinkError(msg || 'lookup failed', 'TRANSIENT', {
          code: 'duplicate_lookup_failed',
          message: msg,
        });
      }
      if (f.searched && f.found) return recovered(f, 'DUPLICATE');
      await this.duplicateUnresolved(
        d,
        connector,
        entity,
        typeof doc?.number === 'string' ? doc.number : null,
      );
      // docs/01 §6.3 DUPLICATE → outbox DONE (dispatcher) · หา id ไม่ได้ = ต้องให้คนกรอกเลขจากระบบบัญชี → แจ้งบัญชีเอง
      // (DONE ไม่ผ่าน onSettled — ไม่ให้เงียบ) · ทีมเสนอ FAILED_FINAL: คำถามค้าง #85
      await this.notifyManual(d, connector, typeof doc?.number === 'string' ? doc.number : null);
      throw new OutboxSinkError(
        'accounting system already has this reference but the document could not be found — enter its id manually',
        'DUPLICATE',
        { code: 'duplicate_unresolved', manualExternalIdRequired: true, searched: f.searched },
      );
    }
    if (r.problem?.code === NOT_IMPLEMENTED)
      throw parkedNotImplemented(
        st.cap ?? ERP_OPERATION_CAPABILITY[d.operation as keyof typeof ERP_OPERATION_CAPABILITY],
      );
    const problem = {
      code: scrub(String(r.problem?.code ?? 'error'), secrets).slice(0, 60),
      message: scrub(String(r.problem?.message ?? ''), secrets).slice(0, 500),
    };
    if (r.errorClass === 'AUTH')
      await d.withTx((tx) => this.connectors.markError(tx, connector, problem));
    throw new OutboxSinkError(problem.message || problem.code, r.errorClass, {
      ...problem,
      ...(Array.isArray(r.problem?.fields)
        ? {
            fields: r.problem.fields.slice(0, 50).map((f) => ({
              field: scrub(String(f.field), secrets).slice(0, 120),
              code: String(f.code).slice(0, 60),
              message: scrub(String(f.message), secrets).slice(0, 300),
            })),
          }
        : {}),
    });
  }
}
