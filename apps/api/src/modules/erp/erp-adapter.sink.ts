import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Connector } from '@prisma/client';
import {
  ERP_OPERATION_CAPABILITY,
  type ErpOperation,
  isErpOperation,
  SOR_TAX_PUSH_CAPABILITIES,
} from '@tms/domain';
import { Clock } from '../../common/clock';
import { EntitlementService } from '../entitlements/entitlement.service';
import { OutboxSinkRegistry } from '../integration/outbox-sink.registry';
import { OutboxSinkError, type OutboxDelivery, type OutboxSink } from '../integration/outbox.types';
import { ConnectorResolver } from './connector-resolver';
import { ConnectorsService, HEALTH_STOP_CLASSES, redactSecrets } from './connectors.service';
import { ErpMasterCodesService, type PushPreparation } from './erp-master-codes.service';
import {
  type CanonicalDocument,
  type ErpAdapter,
  ErpAdapterError,
  type ErpContext,
  isPendingCapability,
  NOT_IMPLEMENTED,
  type ExternalRef,
  type PushResult,
} from './erp-adapter';

export const ERP_SINK = 'erp';

/** entity ที่เก็บ external_mapping หลัง push สำเร็จ (ST8-T16) */
const MAPPED_ENTITIES: ReadonlySet<string> = new Set(['invoice', 'settlement']);

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

/**
 * ErpAdapter เสียบเป็น sink `erp` ของ integration outbox (ST7-T13; docs/01 §3.7 kind ADAPTER, §6.2–6.3) — **คิวเดียว** กับ webhook
 * คำสั่ง: target_id = connector id · operation ∈ ERP_OPERATION_CAPABILITY (PUSH_INVOICE ฯลฯ) · payload = canonical (ST7-T15)
 * - ยกเลิกการเชื่อม / ไม่มี connector → SKIPPED (CAPABILITY — INT-016 หยุดส่งทันที)
 * - PAUSED / ERROR / tenant ถูกระงับ / แพ็กเกจไม่มี `conn` / adapter ไม่ได้ติดตั้ง → คงคำสั่งไว้ (AUTH = PENDING ไม่นับครั้ง)
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
 * การสร้างคำสั่งหลัง finalize + ประตู syncFromDate + external_mapping = ST7-T15/T16
 */
@Injectable()
export class ErpAdapterSink implements OutboxSink, OnModuleInit {
  readonly key = ERP_SINK;

  constructor(
    private readonly registry: OutboxSinkRegistry,
    private readonly connectors: ConnectorsService,
    private readonly resolver: ConnectorResolver,
    private readonly entitlements: EntitlementService,
    private readonly masterCodes: ErpMasterCodesService,
    private readonly clock: Clock,
  ) {}

  onModuleInit() {
    if (!this.registry.get(this.key)) this.registry.register(this);
  }

  async deliver(d: OutboxDelivery): Promise<{ result: Record<string, unknown> }> {
    const id = d.targetId;
    const { connector, tenant } = await d.withTx(async (tx) => ({
      connector: id ? await tx.connector.findUnique({ where: { id } }) : null,
      tenant: await tx.tenant.findUnique({
        where: { id: d.tenantId },
        select: { status: true, mode: true },
      }),
    }));
    // ST7-T09 กันชั้นที่ 2: sandbox ไม่ส่งอะไรเข้า ERP จริงเลย (connector สร้างใน sandbox ไม่ได้อยู่แล้ว — @LiveOnly)
    if (tenant?.mode === 'test')
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
    if (!(await this.entitlements.enabled(d.tenantId, 'conn')))
      throw new OutboxSinkError('connectors not in plan — paused', 'AUTH', { code: 'feature_off' });
    const resolved = this.resolver.describe(connector);
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
    // ST8-T03 adapter ประกาศแต่ยังไม่ได้ทำ → พักไว้ (ไม่ทิ้ง ไม่เสียจำนวนครั้ง) จนกว่า deploy ตัวที่ทำแล้ว
    if (isPendingCapability(adapter, cap)) throw parkedNotImplemented(cap);
    if (!adapter.capabilities().has(cap)) {
      // adapter ทำไม่ได้จริง → SKIPPED + แจ้งบัญชี (docs/01 §6.3 CAPABILITY)
      // ST8-T16 แจ้งยกเลิกเอกสารที่ ERP ไม่รองรับ = งานที่บัญชีต้องยกเลิกในระบบบัญชีเอง (`void_manual_required`)
      const code =
        d.operation === 'VOID_DOCUMENT' ? 'void_manual_required' : 'capability_not_supported';
      await this.skipped(d, connector, code);
      throw new OutboxSinkError(
        code === 'void_manual_required'
          ? 'ERP cannot cancel this document via API — cancel it in the accounting system manually'
          : `capability ${cap} not supported`,
        'CAPABILITY',
        { code, capability: cap },
      );
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
    // ST7-T18 ประตู mapping + ST8-T06 ผังรหัสที่ adapter ประกาศ (docs/01 §7.4) — ตรวจหลังเงื่อนไข "ส่งได้" ทั้งหมด
    // (คำสั่งที่พัก/ข้ามไม่ถูกตัดสินว่าล้ม) · คำสั่งดึงข้อมูล (FETCH_*) ไม่มีเอกสารให้ตรวจ
    const operation = d.operation as ErpOperation; // ตรวจด้วย isErpOperation ข้างบนแล้ว
    const secrets = connector.credentialKeys.map((k) => ctx.config[k] ?? '');
    if (PUSH_OPERATIONS.has(operation)) {
      // รูปของ payload ก่อนเข้าประตู (REPLACE_DOCUMENT ต้องมีทั้ง ref และ document)
      if (operation === 'REPLACE_DOCUMENT' && (!payload.ref || !payload.document))
        throw new OutboxSinkError('ref and document required', 'VALIDATION', {
          code: 'invalid_payload',
        });
      const doc = payload.document ?? (payload as CanonicalDocument);
      let prep: PushPreparation;
      try {
        prep = await d.withTx((tx) =>
          this.masterCodes.prepareForPush(tx, connector.id, adapter, ctx, operation, doc),
        );
      } catch (e) {
        // adapter.masterCodeRefs พัง / ฐานข้อมูลล้ม — ลองใหม่ตาม policy · ข้อความตัด credential ก่อนเก็บ
        const msg = redactSecrets(String((e as Error)?.message ?? e), secrets).slice(0, 500);
        throw new OutboxSinkError(msg || 'master code check failed', 'TRANSIENT', {
          code: 'erp_master_code_check_failed',
          message: msg,
        });
      }
      if (!prep.ok)
        throw new OutboxSinkError(prep.problem.message, 'VALIDATION', { ...prep.problem });
      if (payload.document) payload.document = prep.document;
      else Object.assign(payload, prep.document);
      ctx.masterCodes = prep.masterCodes;
    }
    try {
      return await this.call(d, adapter, ctx, payload, secrets, connector);
    } catch (e) {
      if (e instanceof OutboxSinkError) {
        if (e.errorClass === 'TRANSIENT') await this.stopIfDown(d, connector);
        throw e;
      }
      if (e instanceof ErpAdapterError) {
        if (e.problem?.code === NOT_IMPLEMENTED) throw parkedNotImplemented(cap);
        const problem = {
          code: redactSecrets(String(e.problem?.code ?? 'error'), secrets).slice(0, 60),
          message: redactSecrets(String(e.problem?.message ?? ''), secrets).slice(0, 500),
        };
        if (e.errorClass === 'AUTH')
          await d.withTx((tx) => this.connectors.markError(tx, connector, problem));
        if (e.errorClass === 'TRANSIENT') await this.stopIfDown(d, connector);
        throw new OutboxSinkError(problem.message || problem.code, e.errorClass, problem);
      }
      // adapter throw = TRANSIENT (docs/01 §6.3) — ข้อความอาจมี credential (URL/header ของ HTTP client) → ตัดก่อนเก็บ
      const msg = redactSecrets(String((e as Error)?.message ?? e), secrets).slice(0, 500);
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
      await d.withTx((tx) =>
        this.connectors.applySystemHealth(tx, connector.id, h, this.clock.now()),
      );
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
  ): Promise<void> {
    if (!MAPPED_ENTITIES.has(d.entityType)) return;
    const doc = payload.document ?? (payload as CanonicalDocument);
    const number = typeof doc?.number === 'string' ? doc.number.slice(0, 60) : null;
    const hash = typeof doc?.sync?.hash === 'string' ? doc.sync.hash.slice(0, 64) : null;
    const now = this.clock.now();
    await d.withTx(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO external_mapping (tenant_id, connector_id, entity_type, local_id, local_number, external_id,
                                      external_doc_no, external_status, payload_hash, synced_at, updated_at)
        VALUES (${d.tenantId}::uuid, ${c.id}::uuid, ${d.entityType}, ${d.localId}::uuid, ${number},
                ${String(r.externalId).slice(0, 200)}, ${r.externalDocNo?.slice(0, 100) ?? null}, 'DRAFT',
                ${hash}, ${now}, now())
        ON CONFLICT (tenant_id, connector_id, entity_type, local_id) DO UPDATE
           SET external_id = EXCLUDED.external_id,
               local_number = coalesce(EXCLUDED.local_number, external_mapping.local_number),
               external_doc_no = coalesce(external_mapping.external_doc_no, EXCLUDED.external_doc_no),
               external_status = coalesce(external_mapping.external_status, EXCLUDED.external_status),
               payload_hash = EXCLUDED.payload_hash, synced_at = EXCLUDED.synced_at, updated_at = now()`;
    });
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

  private async call(
    d: OutboxDelivery,
    adapter: ErpAdapter,
    ctx: ErpContext,
    payload: { document?: CanonicalDocument; ref?: ExternalRef },
    secrets: string[],
    connector: Connector,
  ): Promise<{ result: Record<string, unknown> }> {
    let r: PushResult;
    switch (d.operation) {
      case 'PUSH_INVOICE':
        r = await adapter.pushInvoice!(ctx, payload.document ?? (payload as CanonicalDocument));
        break;
      case 'PUSH_CREDIT_NOTE':
        r = await adapter.pushCreditNote!(ctx, payload.document ?? (payload as CanonicalDocument));
        break;
      case 'PUSH_SETTLEMENT':
        r = await adapter.pushSettlement!(ctx, payload.document ?? (payload as CanonicalDocument));
        break;
      case 'REPLACE_DOCUMENT':
        if (!payload.ref || !payload.document)
          throw new OutboxSinkError('ref and document required', 'VALIDATION', {
            code: 'invalid_payload',
          });
        r = await adapter.replaceDocument!(ctx, payload.ref, payload.document);
        break;
      case 'FETCH_DOCUMENT': {
        if (!payload.ref)
          throw new OutboxSinkError('ref required', 'VALIDATION', { code: 'invalid_payload' });
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
        // ERP ที่มี pushCreditNote: ส่งการยกเลิกเป็นใบลดหนี้ — ออกแบบใน ST7-T16 (ยังไม่ส่ง ไม่เดา)
        throw new OutboxSinkError('void via credit note is not implemented yet', 'VALIDATION', {
          code: 'void_not_implemented',
        });
      default:
        throw new OutboxSinkError(`unknown operation ${d.operation}`, 'VALIDATION', {
          code: 'unknown_operation',
        });
    }
    if (r.ok) {
      await this.recordMapping(d, connector, payload, r);
      return {
        result: {
          externalId: r.externalId,
          externalDocNo: r.externalDocNo ?? null,
          externalVersion: r.externalVersion ?? null,
        },
      };
    }
    if (r.problem?.code === NOT_IMPLEMENTED)
      throw parkedNotImplemented(
        ERP_OPERATION_CAPABILITY[d.operation as keyof typeof ERP_OPERATION_CAPABILITY],
      );
    const problem = {
      code: redactSecrets(String(r.problem?.code ?? 'error'), secrets).slice(0, 60),
      message: redactSecrets(String(r.problem?.message ?? ''), secrets).slice(0, 500),
    };
    if (r.errorClass === 'AUTH')
      await d.withTx((tx) => this.connectors.markError(tx, connector, problem));
    throw new OutboxSinkError(problem.message || problem.code, r.errorClass, {
      ...problem,
      ...(Array.isArray(r.problem?.fields)
        ? {
            fields: r.problem.fields.slice(0, 50).map((f) => ({
              field: String(f.field).slice(0, 120),
              code: String(f.code).slice(0, 60),
              message: redactSecrets(String(f.message), secrets).slice(0, 300),
            })),
          }
        : {}),
    });
  }
}
