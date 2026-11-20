import { Injectable, Logger } from '@nestjs/common';
import type { Connector, ExternalMapping } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { refToId } from '../../common/external-id';
import { encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { lockKey, lockReferenced } from '../master/master-kit';
import { ConnectorsService } from './connectors.service';
import { ErpAdapterRegistry } from './erp-adapter.registry';
import { ERP_CODE_RE } from './erp-master-codes.service';

/** ผลการจำรหัสลูกค้าของช่องทาง connector (ชุดเดียวกับ `AliasLearnResult` ของ OrderMatchingService) */
export type SourceCodeLearnResult = 'learned' | 'exists' | 'too_long' | 'empty';

/** แถวหน้าจอ "รหัสระบบบัญชี" ของลูกค้า 1 connector */
export interface CustomerErpCodeView {
  connector: Connector;
  displayName: string;
  row: ExternalMapping | null;
}

const ENTITY = 'CUSTOMER' as const;
/** รหัสที่เก็บได้ (ตรงกับ CHECK ใน migration 0141 — ≤ 100 · ใช้รูปแบบเดียวกับผังรหัส ERP ≤ 64) */
const MAX_CODE = 64;

/** ป้ายที่มาของใบจาก connector `ERP:{adapterKey}` → adapterKey · อื่น ๆ = null */
export function connectorKeyOfSource(source: string): string | null {
  const m = /^ERP:([a-z0-9][a-z0-9_-]{0,31})$/.exec(source);
  return m ? m[1]! : null;
}

/**
 * `external_mapping` ของลูกค้า (ST8-T05; docs/01 §3.7, A.4) — **ไม่ผูก ERP ใด** (KRS เป็นแค่ adapter ที่ประกาศ `deriveCustomerCode`)
 *
 * 1 แถวต่อ (connector, ลูกค้า): `external_id` = รหัสลูกค้าในระบบบัญชี (ใช้ส่งเอกสาร — KRS `custOrSuppCode` ของ PP) ·
 * `source_code` = รหัสลูกค้าในข้อมูลขาเข้าของ connector (ใช้จับคู่ตอนดึง — KRS รหัส NSF ใน SO)
 *
 * - **จับคู่ตอนดึง** (`matchCustomer`): ใบที่มา `ERP:{key}` + รหัสลูกค้าต้นทาง → แถวที่ `source_code` ตรง ของ connector ที่ยังไม่ยกเลิก
 *   ที่ adapter เดียวกัน (2 นิติบุคคลใช้ adapter เดียวกันแล้วรหัสเดียวกันชี้คนละลูกค้า = กำกวม → ไม่จับคู่ ให้คนตัดสิน)
 * - **คน map ครั้งเดียวได้สองรหัส** (`learnCustomerSourceCode` — จากหน้าใบค้าง "จับคู่ลูกค้า"): ตั้ง `source_code` และถ้ายังไม่มี
 *   `external_id` ให้ adapter เดา (`deriveCustomerCode(ctx, 'erp', code)` — KRS: รหัสเดียวกัน [OPEN — KRS] A.6) · เดาไม่ได้/ชนกับลูกค้าอื่น
 *   = PENDING (กรอกเองในแท็บ "รหัสระบบบัญชี") · รหัสเดิมเป็นของลูกค้าอื่น → 409 `alias_conflict` เว้นยืนยัน + เหตุผล (ย้าย — audit)
 *   · ลูกค้ามี `source_code` อื่นอยู่แล้ว = คืน null (ผู้เรียกจำเป็น alias ของช่องทาง — ลูกค้า 1 รายมีหลายรหัสต้นทางได้)
 * - **หน้าลูกค้า** (`setForCustomer`): กรอกรหัสในระบบบัญชี — ยังไม่มี `source_code` ให้ adapter เดากลับ (`'source'`) ถ้ายังไม่เป็นของลูกค้าอื่น
 * - ไม่มี hard delete · audit ทุกการเปลี่ยน (`external_mapping.changed`)
 */
@Injectable()
export class ExternalMappingService {
  private readonly logger = new Logger(ExternalMappingService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly adapters: ErpAdapterRegistry,
    private readonly connectors: ConnectorsService,
  ) {}

  /** connector ที่ยังไม่ยกเลิกของ adapter ตามป้ายที่มา — ช่องทางอื่น = [] */
  async connectorsOfSource(tx: Tx, source: string): Promise<Connector[]> {
    const key = connectorKeyOfSource(source);
    if (!key) return [];
    return tx.connector.findMany({
      where: { adapterKey: key, status: { not: 'DISCONNECTED' } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** ลูกค้าที่ `source_code` ตรง (ใช้งานอยู่) — ไม่พบ/กำกวม = null */
  async matchCustomer(tx: Tx, source: string, code: string): Promise<string | null> {
    const cons = await this.connectorsOfSource(tx, source);
    if (!cons.length) return null;
    const rows = await tx.externalMapping.findMany({
      where: {
        entityType: ENTITY,
        connectorId: { in: cons.map((c) => c.id) },
        sourceCode: code,
        status: { not: 'RETIRED' },
      },
      select: { localId: true },
    });
    const ids = [...new Set(rows.map((r) => r.localId))];
    if (ids.length !== 1) return null;
    const [ref] = await lockReferenced(tx, 'customer', ids);
    return ref?.status === 'ACTIVE' ? ids[0]! : null;
  }

  /**
   * คนจับคู่ลูกค้าให้ใบจาก connector (หน้าใบค้าง) → จำรหัสต้นทางใน external_mapping ทุก connector ของ adapter นั้น
   * null = ไม่ใช่ช่องทาง connector / ไม่มี connector / ลูกค้ามีรหัสต้นทางอื่นแล้ว (ผู้เรียกใช้ alias ของช่องทางแทน)
   */
  async learnCustomerSourceCode(
    tx: Tx,
    q: {
      source: string;
      code: string;
      customerId: string;
      confirmReassign?: boolean;
      reason?: string | null;
    },
  ): Promise<SourceCodeLearnResult | null> {
    const code = q.code.trim();
    if (!code) return 'empty';
    const cons = await this.connectorsOfSource(tx, q.source);
    if (!cons.length) return null;
    if (code.length > MAX_CODE || !ERP_CODE_RE.test(code)) return 'too_long';
    let result: SourceCodeLearnResult | null = 'exists';
    for (const c of cons) {
      await lockKey(tx, `external_mapping:${c.id}:${ENTITY}:src:${code}`);
      await lockKey(tx, `external_mapping:${c.id}:${ENTITY}:local:${q.customerId}`);
      const owner = await tx.externalMapping.findFirst({
        where: { connectorId: c.id, entityType: ENTITY, sourceCode: code },
      });
      if (owner && owner.localId === q.customerId) continue;
      const mine = await tx.externalMapping.findUnique({
        where: {
          connectorId_entityType_localId: {
            connectorId: c.id,
            entityType: ENTITY,
            localId: q.customerId,
          },
        },
      });
      // รหัสนี้เป็นของลูกค้าอื่น → ต้องยืนยัน + เหตุผล แล้วย้าย (ถอดจากลูกค้าเดิม)
      if (owner) {
        this.conflict(owner, code, q);
        await this.write(tx, owner, { sourceCode: null }, q.reason ?? null);
      }
      // ลูกค้ามีรหัสต้นทางอื่นอยู่แล้ว → ไม่ทับ (ใบที่ใช้รหัสเดิมยังจับคู่ได้) — ผู้เรียกจำเป็น alias ของช่องทาง
      if (mine?.sourceCode && mine.sourceCode !== code) {
        result = null;
        continue;
      }
      if (mine) {
        const patch: Partial<Pick<ExternalMapping, 'sourceCode' | 'externalId'>> = {
          sourceCode: code,
        };
        if (!mine.externalId) {
          const erp = await this.derive(tx, c, 'erp', code, q.customerId);
          if (erp) patch.externalId = erp;
        }
        await this.write(tx, mine, patch, owner ? (q.reason ?? null) : null);
      } else {
        const erp = await this.derive(tx, c, 'erp', code, q.customerId);
        await this.create(tx, c, q.customerId, { sourceCode: code, externalId: erp });
      }
      if (result !== null) result = 'learned';
    }
    return result;
  }

  /** รหัสเดิมเป็นของลูกค้าอื่น — ต้องยืนยัน + เหตุผล (กติกาเดียวกับย้าย alias — ST3-T06) */
  private conflict(
    owner: ExternalMapping,
    code: string,
    q: { confirmReassign?: boolean; reason?: string | null },
  ): void {
    if (!q.confirmReassign || !q.reason)
      throw new ProblemException('alias_conflict', undefined, undefined, {
        aliasKind: 'EXTERNAL_ID',
        aliasValue: code,
        mappedCustomerId: encodeId('customer', owner.localId),
      });
  }

  /** รหัสอีกฝั่งจาก adapter — ไม่ประกาศ/ล้ม/ผิดรูป/เป็นของลูกค้าอื่นแล้ว = null */
  private async derive(
    tx: Tx,
    c: Connector,
    target: 'erp' | 'source',
    code: string,
    customerId: string,
  ): Promise<string | null> {
    const adapter = this.adapters.get(c.adapterKey);
    if (!adapter?.deriveCustomerCode) return null;
    let v: unknown;
    try {
      v = adapter.deriveCustomerCode(this.connectors.contextOf(c), target, code);
    } catch (e) {
      this.logger.warn(`connector ${c.id}: deriveCustomerCode failed — ${String(e)}`);
      return null;
    }
    if (typeof v !== 'string') return null;
    const out = v.trim();
    if (!out || out.length > MAX_CODE || !ERP_CODE_RE.test(out)) return null;
    const taken = await tx.externalMapping.findFirst({
      where: {
        connectorId: c.id,
        entityType: ENTITY,
        ...(target === 'erp' ? { externalId: out } : { sourceCode: out }),
        localId: { not: customerId },
      },
      select: { id: true },
    });
    return taken ? null : out;
  }

  private async create(
    tx: Tx,
    c: Connector,
    customerId: string,
    v: { sourceCode: string | null; externalId: string | null },
  ): Promise<ExternalMapping> {
    const ctx = requestContext.require();
    const row = await tx.externalMapping.create({
      data: {
        tenantId: ctx.tenantId!,
        connectorId: c.id,
        entityType: ENTITY,
        localId: customerId,
        sourceCode: v.sourceCode,
        externalId: v.externalId,
        status: v.externalId ? 'SYNCED' : 'PENDING',
        createdBy: ctx.actorId ?? null,
        updatedBy: ctx.actorId ?? null,
      },
    });
    await this.audit.record({
      action: 'external_mapping.changed',
      entityType: 'customer',
      entityId: customerId,
      before: { connectorId: c.id, externalId: null, sourceCode: null },
      after: { connectorId: c.id, externalId: v.externalId, sourceCode: v.sourceCode },
    });
    return row;
  }

  private async write(
    tx: Tx,
    row: ExternalMapping,
    patch: Partial<Pick<ExternalMapping, 'sourceCode' | 'externalId'>>,
    reason: string | null,
  ): Promise<ExternalMapping> {
    const next = {
      sourceCode: patch.sourceCode !== undefined ? patch.sourceCode : row.sourceCode,
      externalId: patch.externalId !== undefined ? patch.externalId : row.externalId,
    };
    if (next.sourceCode === row.sourceCode && next.externalId === row.externalId) return row;
    const ctx = requestContext.require();
    const out = await tx.externalMapping.update({
      where: { id: row.id },
      data: {
        ...next,
        status: next.externalId ? 'SYNCED' : 'PENDING',
        updatedBy: ctx.actorId ?? null,
        version: { increment: 1 },
      },
    });
    await this.audit.record({
      action: 'external_mapping.changed',
      entityType: 'customer',
      entityId: row.localId,
      before: { connectorId: row.connectorId, externalId: row.externalId, sourceCode: row.sourceCode },
      after: { connectorId: row.connectorId, ...next },
      ...(reason ? { reason } : {}),
    });
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // หน้าลูกค้า แท็บ "รหัสระบบบัญชี" (ต้นแบบ TMS v4 cust `erpc`)

  /** connector ที่ยังไม่ยกเลิกทุกตัว + รหัสของลูกค้านี้ (ไม่มีแถว = ยังไม่ map) */
  async listForCustomer(customerRef: string, tx: Tx = this.db.tx): Promise<CustomerErpCodeView[]> {
    const customerId = await this.customerIdOf(tx, customerRef);
    const cons = await tx.connector.findMany({
      where: { status: { not: 'DISCONNECTED' } },
      orderBy: { createdAt: 'asc' },
    });
    const rows = await tx.externalMapping.findMany({
      where: { entityType: ENTITY, localId: customerId, connectorId: { in: cons.map((c) => c.id) } },
    });
    return cons.map((c) => ({
      connector: c,
      displayName: this.adapters.get(c.adapterKey)?.displayName ?? c.adapterKey,
      row: rows.find((r) => r.connectorId === c.id) ?? null,
    }));
  }

  /**
   * ตั้ง/ล้าง (null) รหัสลูกค้าในระบบบัญชีของ connector 1 ตัว — If-Match = `version` ของแถว (ยังไม่มี = 0)
   * รหัสเป็นของลูกค้าอื่นแล้ว → 409 `external_id_conflict` · ยังไม่มี `source_code` → adapter เดากลับ (ไม่ชนลูกค้าอื่น)
   */
  async setForCustomer(
    customerRef: string,
    connectorRef: string,
    body: { externalId?: string | null },
    expected?: number,
    tx: Tx = this.db.tx,
  ): Promise<CustomerErpCodeView> {
    const customerId = await this.customerIdOf(tx, customerRef);
    const connectorId = tryDecodeId('connector', connectorRef);
    const c = connectorId ? await tx.connector.findUnique({ where: { id: connectorId } }) : null;
    if (!c) throw new ProblemException('not_found');
    if (c.status === 'DISCONNECTED') throw new ProblemException('invalid_state_transition');
    if (body.externalId === undefined)
      throw new ProblemException('validation_failed', undefined, [
        { field: 'externalId', code: 'required', message: 'ระบุรหัส หรือ null เพื่อยกเลิก' },
      ]);
    const raw = body.externalId?.trim() ?? '';
    if (raw && (raw.length > MAX_CODE || !ERP_CODE_RE.test(raw)))
      throw new ProblemException('validation_failed', undefined, [
        { field: 'externalId', code: 'invalid_format', message: 'รหัสยาว 1–64 ตัว ไม่มีอักขระควบคุม' },
      ]);
    const [ref] = await lockReferenced(tx, 'customer', [customerId]);
    if (!ref) throw new ProblemException('not_found');
    await lockKey(tx, `external_mapping:${c.id}:${ENTITY}:local:${customerId}`);
    if (raw) await lockKey(tx, `external_mapping:${c.id}:${ENTITY}:ext:${raw}`);
    const key = {
      connectorId_entityType_localId: { connectorId: c.id, entityType: ENTITY, localId: customerId },
    };
    const before = await tx.externalMapping.findUnique({ where: key });
    if (expected !== undefined && (before?.version ?? 0) !== expected)
      throw new ProblemException('precondition_failed');
    const externalId = raw || null;
    if (externalId) {
      const other = await tx.externalMapping.findFirst({
        where: { connectorId: c.id, entityType: ENTITY, externalId, localId: { not: customerId } },
        select: { localId: true },
      });
      if (other)
        throw new ProblemException('external_id_conflict', undefined, [
          { field: 'externalId', code: 'duplicate', message: 'รหัสนี้ผูกกับลูกค้าอื่นแล้ว' },
        ], { mappedCustomerId: encodeId('customer', other.localId) });
    }
    let row: ExternalMapping;
    if (!before) {
      const src = externalId ? await this.derive(tx, c, 'source', externalId, customerId) : null;
      row = await this.create(tx, c, customerId, { externalId, sourceCode: src });
    } else {
      const patch: Partial<Pick<ExternalMapping, 'sourceCode' | 'externalId'>> = { externalId };
      if (!before.sourceCode && externalId) {
        const src = await this.derive(tx, c, 'source', externalId, customerId);
        if (src) patch.sourceCode = src;
      }
      row = await this.write(tx, before, patch, null);
    }
    return {
      connector: c,
      displayName: this.adapters.get(c.adapterKey)?.displayName ?? c.adapterKey,
      row,
    };
  }

  /**
   * รหัสลูกค้าในระบบบัญชีของ connector (canonical `customer.externalId` ตอนสร้างคำสั่งส่งเอกสาร — ST7-T15/T16, ST8-T08)
   * null = ยังไม่ map → ประตูก่อนส่งกัน (`erp_master_code_unknown` CUSTOMER MISSING — ST8-T06)
   */
  async customerErpCode(tx: Tx, connectorId: string, customerId: string): Promise<string | null> {
    const r = await tx.externalMapping.findUnique({
      where: {
        connectorId_entityType_localId: { connectorId, entityType: ENTITY, localId: customerId },
      },
      select: { externalId: true, status: true },
    });
    return r && r.status !== 'RETIRED' ? r.externalId : null;
  }

  /** `{id}` หรือ `ext:{externalId}` ของลูกค้า (ST7-T02) → uuid · ไม่พบ/ลบแล้ว/tenant อื่น = 404 */
  private async customerIdOf(tx: Tx, ref: string): Promise<string> {
    const id = await refToId('customer', ref, tx.customer);
    const c = await tx.customer.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!c) throw new ProblemException('not_found');
    return c.id;
  }
}
