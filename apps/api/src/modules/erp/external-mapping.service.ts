import { Injectable, Logger } from '@nestjs/common';
import type { Connector, ExternalMapping } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { refToId } from '../../common/external-id';
import { encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { lockKey, lockReferenced } from '../master/master-kit';
import type { CanonicalDocument } from './erp-adapter';
import { ErpAdapterRegistry } from './erp-adapter.registry';
import { ERP_CODE_RE } from './erp-master-codes.service';

/** ผลการจำรหัสลูกค้าของช่องทาง connector (ชุดเดียวกับ `AliasLearnResult` ของ OrderMatchingService) */
export type SourceCodeLearnResult = 'learned' | 'exists' | 'too_long' | 'empty';

/** แถวหน้าจอ "รหัสระบบบัญชี" ของลูกค้า/รถร่วม 1 connector */
export interface CustomerErpCodeView {
  connector: Connector;
  displayName: string;
  row: ExternalMapping | null;
}
export type PartyErpCodeView = CustomerErpCodeView;

const ENTITY = 'CUSTOMER' as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** ช่องคู่ค้าใน canonical → entity ของ external_mapping (docs/01 §7.1 `customer`, §7.3 `carrier`) */
const PARTY_FIELDS = [
  ['customer', 'CUSTOMER'],
  ['carrier', 'CARRIER'],
] as const;

/**
 * ST7-T15 คู่ค้าที่มีรหัสฝั่ง ERP ใน external_mapping (docs/01 §7.4): ลูกค้า (ใบแจ้งหนี้) · รถร่วม (ใบสำคัญจ่าย)
 * ค่าบริการ (`SERVICE_ITEM`) อยู่ที่ `erp_code_mapping` ของ ST7-T18 (ตรวจกับผังรหัส ERP) — ไม่เก็บซ้ำที่นี่ (spec/12 §3)
 */
export type PartyEntity = 'CUSTOMER' | 'CARRIER';
const PARTY = {
  CUSTOMER: { idKind: 'customer', audit: 'customer', th: 'ลูกค้า', mappedKey: 'mappedCustomerId' },
  CARRIER: { idKind: 'carrier', audit: 'carrier', th: 'รถร่วม', mappedKey: 'mappedCarrierId' },
} as const;

/** สถานะซิงก์ของเอกสาร 1 ใบกับระบบบัญชี (ST7-T15 — `sync` ของใบแจ้งหนี้/ใบสำคัญจ่าย; docs/01 §4.4 "sync แยกฟิลด์") */
export interface DocumentSyncView {
  connectorId: string;
  state: string;
  externalId: string | null;
  externalDocNo: string | null;
  externalStatus: string | null;
  lastSyncedAt: Date | null;
  /** ST8-T08 เอกสารฝั่ง ERP ทุกใบเมื่อถูกแยกเป็นหลายใบ (`detail.documents`) — ใบเดียว = [] */
  externalDocuments: {
    ref: string;
    externalId: string;
    externalDocNo: string | null;
    group: string | null;
  }[];
}
/** รหัสที่เก็บได้ (ตรงกับ CHECK ใน migration 0141 — ≤ 100 · ใช้รูปแบบเดียวกับผังรหัส ERP ≤ 64) */
const MAX_CODE = 64;

/** ป้ายที่มาของใบจาก connector `ERP:{adapterKey}` → adapterKey · อื่น ๆ = null */
export function connectorKeyOfSource(source: string): string | null {
  const m = /^ERP:([a-z0-9][a-z0-9_-]{0,31})$/.exec(source);
  return m ? m[1]! : null;
}

/**
 * `external_mapping` ของลูกค้า (ST8-T05; docs/01 §3.7, A.4) — **ไม่ผูก ERP ใด**
 *
 * 1 แถวต่อ (connector, ลูกค้า): `external_id` = รหัสลูกค้าในระบบบัญชี (ใช้ส่งเอกสาร — KRS `custOrSuppCode` ของ PP) ·
 * `source_code` = รหัสลูกค้าในข้อมูลขาเข้าของ connector (ใช้จับคู่ตอนดึง — KRS รหัส NSF ใน SO)
 *
 * - **จับคู่ตอนดึง** (`matchCustomer`): ใบที่มา `ERP:{key}` + รหัสลูกค้าต้นทาง → แถวที่ `source_code` ตรง ของ connector ที่ยังไม่ยกเลิก
 *   ที่ adapter เดียวกัน (2 นิติบุคคลใช้ adapter เดียวกันแล้วรหัสเดียวกันชี้คนละลูกค้า = กำกวม → ไม่จับคู่ ให้คนตัดสิน)
 * - **หน้าใบค้าง "จับคู่ลูกค้า"** (`learnCustomerSourceCode`, สิทธิ์ orders:write): ตั้ง **`source_code` อย่างเดียว** — ไม่ตั้งรหัสในระบบบัญชี
 *   (review H1: รหัส NSF = PP หรือไม่ ยังไม่ยืนยัน [OPEN — KRS A.6] → ไม่เดา) · รหัสเป็นของลูกค้าอื่น (mapping หรือ alias เดิมของช่องทาง)
 *   → 409 `alias_conflict` เว้นยืนยัน + เหตุผล (ย้ายทั้งคู่ — audit) · ลูกค้ามี `source_code` อื่นแล้ว / รหัสยาวเกิน = คืน null (ผู้เรียกจำเป็น alias)
 * - **หน้าลูกค้า แท็บ "รหัสระบบบัญชี"** (`setForCustomer`, สิทธิ์ settings:write): คนกรอกรหัสในระบบบัญชีเอง · เปลี่ยน/ล้างรหัสที่ตั้งแล้ว
 *   ต้องมีเหตุผล (≥ 10 — audit) · ไม่แตะ `source_code`
 * - ไม่มี hard delete · audit ทุกการเปลี่ยน (`external_mapping.changed`)
 */
@Injectable()
export class ExternalMappingService {
  private readonly logger = new Logger(ExternalMappingService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly adapters: ErpAdapterRegistry,
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
    // รหัสยาว/รูปแบบที่ external_mapping เก็บไม่ได้ → ใช้ alias ของช่องทางแบบเดิม (ST3-T06)
    if (code.length > MAX_CODE || !ERP_CODE_RE.test(code)) return null;
    // alias เดิมของช่องทางนี้ชี้ลูกค้าอื่น → ห้ามทับเงียบ (mapping ชนะ alias ตอนจับคู่) — ยืนยันแล้วย้าย alias มาด้วย
    await lockKey(tx, `customer_alias:EXTERNAL_ID:${q.source}:${code}`);
    const alias = await tx.customerAlias.findFirst({
      where: { kind: 'EXTERNAL_ID', source: q.source, valueKey: code },
      select: { id: true, customerId: true },
    });
    if (alias && alias.customerId !== q.customerId) {
      this.conflict(alias.customerId, code, q);
      const ctx = requestContext.require();
      await tx.$executeRaw`
        UPDATE customer_alias SET customer_id = ${q.customerId}::uuid, created_by = ${ctx.actorId ?? null},
               updated_at = now() WHERE id = ${alias.id}::uuid`;
      await this.audit.record({
        action: 'customer.alias_reassigned',
        entityType: 'customer',
        entityId: q.customerId,
        before: { aliasOf: encodeId('customer', alias.customerId) },
        after: { kind: 'EXTERNAL_ID', source: q.source, value: code },
        reason: q.reason!,
      });
    }
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
        this.conflict(owner.localId, code, q);
        await this.write(tx, owner, { sourceCode: null }, q.reason ?? null);
      }
      // ลูกค้ามีรหัสต้นทางอื่นอยู่แล้ว → ไม่ทับ (ใบที่ใช้รหัสเดิมยังจับคู่ได้) — ผู้เรียกจำเป็น alias ของช่องทาง
      if (mine?.sourceCode && mine.sourceCode !== code) {
        result = null;
        continue;
      }
      // รหัสต้นทางอย่างเดียว — รหัสในระบบบัญชีคนกรอกเองที่หน้าลูกค้า (ไม่เดา — [OPEN — KRS A.6])
      if (mine) await this.write(tx, mine, { sourceCode: code }, owner ? (q.reason ?? null) : null);
      else
        await this.create(
          tx,
          c,
          q.customerId,
          { sourceCode: code, externalId: null },
          owner ? (q.reason ?? null) : null,
        );
      if (result !== null) result = 'learned';
    }
    return result;
  }

  /** รหัสเดิมเป็นของลูกค้าอื่น — ต้องยืนยัน + เหตุผล (กติกาเดียวกับย้าย alias — ST3-T06) */
  private conflict(
    ownerCustomerId: string,
    code: string,
    q: { confirmReassign?: boolean; reason?: string | null },
  ): void {
    if (!q.confirmReassign || !q.reason)
      throw new ProblemException('alias_conflict', undefined, undefined, {
        aliasKind: 'EXTERNAL_ID',
        aliasValue: code,
        mappedCustomerId: encodeId('customer', ownerCustomerId),
      });
  }

  private async create(
    tx: Tx,
    c: Connector,
    customerId: string,
    v: { sourceCode: string | null; externalId: string | null },
    reason: string | null = null,
    entity: PartyEntity = ENTITY,
  ): Promise<ExternalMapping> {
    const ctx = requestContext.require();
    const row = await tx.externalMapping.create({
      data: {
        tenantId: ctx.tenantId!,
        connectorId: c.id,
        entityType: entity,
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
      entityType: PARTY[entity].audit,
      entityId: customerId,
      before: { connectorId: c.id, externalId: null, sourceCode: null },
      after: { connectorId: c.id, externalId: v.externalId, sourceCode: v.sourceCode },
      ...(reason ? { reason } : {}),
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
      entityType: row.entityType === 'CARRIER' ? PARTY.CARRIER.audit : PARTY.CUSTOMER.audit,
      entityId: row.localId,
      before: {
        connectorId: row.connectorId,
        externalId: row.externalId,
        sourceCode: row.sourceCode,
      },
      after: { connectorId: row.connectorId, ...next },
      ...(reason ? { reason } : {}),
    });
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // หน้าลูกค้า แท็บ "รหัสระบบบัญชี" (ต้นแบบ TMS v4 cust `erpc`)

  /** connector ที่ยังไม่ยกเลิกทุกตัว + รหัสของลูกค้านี้ (ไม่มีแถว = ยังไม่ map) */
  async listForCustomer(customerRef: string, tx: Tx = this.db.tx): Promise<CustomerErpCodeView[]> {
    return this.listFor(ENTITY, await this.customerIdOf(tx, customerRef), tx);
  }

  /** ST7-T15 รหัสรถร่วมในระบบบัญชีแต่ละตัวที่เชื่อมต่อ (ไม่มีแถว = ยังไม่ map) */
  async listForCarrier(carrierRef: string, tx: Tx = this.db.tx): Promise<PartyErpCodeView[]> {
    return this.listFor('CARRIER', await this.carrierIdOf(tx, carrierRef), tx);
  }

  private async listFor(
    entity: PartyEntity,
    customerId: string,
    tx: Tx,
  ): Promise<PartyErpCodeView[]> {
    const cons = await tx.connector.findMany({
      where: { status: { not: 'DISCONNECTED' } },
      orderBy: { createdAt: 'asc' },
    });
    const rows = await tx.externalMapping.findMany({
      where: {
        entityType: entity,
        localId: customerId,
        connectorId: { in: cons.map((c) => c.id) },
      },
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
    body: { externalId?: string | null; reason?: string | null },
    expected?: number,
    tx: Tx = this.db.tx,
  ): Promise<CustomerErpCodeView> {
    const customerId = await this.customerIdOf(tx, customerRef);
    return this.setFor(ENTITY, customerId, connectorRef, body, expected, tx);
  }

  /**
   * ST7-T15 ตั้ง/ล้าง (null) รหัสรถร่วมในระบบบัญชีของ connector 1 ตัว — กติกาเดียวกับลูกค้า (If-Match, เหตุผลเมื่อเปลี่ยน/ล้าง,
   * รหัสผูกกับรถร่วมอื่น = 409 `external_id_conflict`, audit `external_mapping.changed`)
   */
  async setForCarrier(
    carrierRef: string,
    connectorRef: string,
    body: { externalId?: string | null; reason?: string | null },
    expected?: number,
    tx: Tx = this.db.tx,
  ): Promise<PartyErpCodeView> {
    const carrierId = await this.carrierIdOf(tx, carrierRef);
    return this.setFor('CARRIER', carrierId, connectorRef, body, expected, tx);
  }

  private async setFor(
    entity: PartyEntity,
    customerId: string,
    connectorRef: string,
    body: { externalId?: string | null; reason?: string | null },
    expected: number | undefined,
    tx: Tx,
  ): Promise<PartyErpCodeView> {
    const party = PARTY[entity];
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
        {
          field: 'externalId',
          code: 'invalid_format',
          message: 'รหัสยาว 1–64 ตัว ไม่มีอักขระควบคุม',
        },
      ]);
    const [ref] = await lockReferenced(tx, party.idKind, [customerId]);
    if (!ref) throw new ProblemException('not_found');
    await lockKey(tx, `external_mapping:${c.id}:${entity}:local:${customerId}`);
    if (raw) await lockKey(tx, `external_mapping:${c.id}:${entity}:ext:${raw}`);
    const key = {
      connectorId_entityType_localId: {
        connectorId: c.id,
        entityType: entity,
        localId: customerId,
      },
    };
    const before = await tx.externalMapping.findUnique({ where: key });
    if (expected !== undefined && (before?.version ?? 0) !== expected)
      throw new ProblemException('precondition_failed');
    const externalId = raw || null;
    if (externalId) {
      const other = await tx.externalMapping.findFirst({
        where: { connectorId: c.id, entityType: entity, externalId, localId: { not: customerId } },
        select: { localId: true },
      });
      if (other)
        throw new ProblemException(
          'external_id_conflict',
          undefined,
          [
            {
              field: 'externalId',
              code: 'duplicate',
              message: `รหัสนี้ผูกกับ${party.th}อื่นแล้ว`,
            },
          ],
          { [party.mappedKey]: encodeId(party.idKind, other.localId) },
        );
    }
    // เปลี่ยน/ล้างรหัสที่ตั้งไว้แล้ว = ต้องมีเหตุผล (review M2 — ใบแจ้งหนี้ถัดไปส่งด้วยรหัสใหม่ · audit)
    const reason = body.reason?.trim() || null;
    if (before?.externalId && before.externalId !== externalId && (!reason || reason.length < 10))
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'reason',
          code: 'required',
          message: 'เปลี่ยนหรือยกเลิกรหัสที่ตั้งไว้แล้วต้องระบุเหตุผลอย่างน้อย 10 ตัวอักษร',
        },
      ]);
    let row: ExternalMapping;
    if (!before) {
      if (!externalId) return this.view(c, null);
      row = await this.create(tx, c, customerId, { externalId, sourceCode: null }, reason, entity);
    } else {
      row = await this.write(tx, before, { externalId }, reason);
    }
    return this.view(c, row);
  }

  private view(c: Connector, row: ExternalMapping | null): CustomerErpCodeView {
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
    return this.partyErpCode(tx, connectorId, ENTITY, customerId);
  }

  /**
   * ST7-T15 รหัสคู่ค้า (ลูกค้า/รถร่วม) ในระบบบัญชีของ connector **ณ ตอนนี้** — เฉพาะ mapping สถานะ `SYNCED` (docs/01 §7.4)
   * null = ยังไม่ map / ยกเลิกแล้ว · **SYNCED เท่านั้น** (เดิมรับทุกสถานะที่ไม่ใช่ RETIRED): แถวคู่ค้าที่เขียนผ่าน API มีแค่ SYNCED (มีรหัส) /
   * PENDING (ไม่มีรหัส) จึงได้ผลเท่าเดิม — FAILED / MISMATCH (สงวนให้ sync master / reconcile ภายหลัง) = รหัสที่ยังไม่ยืนยัน ไม่นำไปส่งเอกสาร
   */
  async partyErpCode(
    tx: Tx,
    connectorId: string,
    entity: PartyEntity,
    localId: string,
  ): Promise<string | null> {
    const r = await tx.externalMapping.findUnique({
      where: { connectorId_entityType_localId: { connectorId, entityType: entity, localId } },
      select: { externalId: true, status: true },
    });
    return r && r.status === 'SYNCED' ? r.externalId : null;
  }

  /**
   * ST7-T15 ใส่รหัสคู่ค้าฝั่ง ERP ลง canonical **ณ ตอนส่ง** (`customer.externalId` / `carrier.externalId` — docs/01 §7.1, §7.3, §7.4)
   * ตารางเป็นตัวตัดสิน: mapping `SYNCED` = รหัสนั้น · ไม่มี/ล้างแล้ว = null (ทับค่าที่ตรึงตอนสร้างคำสั่ง — คน map/แก้รหัสทีหลังแล้วส่งคำสั่งเดิมใหม่ได้)
   * คู่ค้าที่ `id` ไม่ใช่ uuid ภายใน (payload ที่ไม่ได้มาจากตัวสร้างของ core) = ไม่แตะ · คืนสำเนา ไม่แก้ `doc`
   */
  async withPartyCodes<T extends CanonicalDocument>(
    tx: Tx,
    connectorId: string,
    doc: T,
  ): Promise<T> {
    let out = doc;
    for (const [field, entity] of PARTY_FIELDS) {
      const party = (doc as Record<string, unknown>)[field] as
        { id?: unknown; externalId?: unknown } | null | undefined;
      if (!party || typeof party !== 'object' || typeof party.id !== 'string') continue;
      if (!UUID_RE.test(party.id)) continue;
      const code = await this.partyErpCode(tx, connectorId, entity, party.id);
      if ((party.externalId ?? null) === code) continue;
      out = { ...out, [field]: { ...party, externalId: code } };
    }
    return out;
  }

  /**
   * ST7-T15 ผลการส่งเอกสาร 1 ใบเข้าระบบบัญชี (`external_mapping` ของเอกสาร) — ไม่มีแถว = null
   * (ไม่มี connector / connector ยกเลิกการเชื่อมแล้ว / ยังรอคิว / ส่งไม่สำเร็จ — ดูคิวของ connector) · หลาย connector = ตัวที่ส่งล่าสุด
   */
  async documentSync(
    entity: 'INVOICE' | 'SETTLEMENT',
    localId: string,
    tx: Tx = this.db.tx,
  ): Promise<DocumentSyncView | null> {
    const rows = await tx.externalMapping.findMany({
      // connector ที่ยกเลิกการเชื่อมแล้วไม่นับ (เอกสารไม่ได้ซิงก์กับระบบนั้นอีก — INT-016)
      where: {
        entityType: entity,
        localId,
        status: { not: 'RETIRED' },
        connector: { status: { not: 'DISCONNECTED' } },
      },
      orderBy: [{ lastSyncedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: 1,
    });
    const r = rows[0];
    if (!r) return null;
    return {
      connectorId: r.connectorId,
      state: r.status,
      externalId: r.externalId,
      externalDocNo: r.externalDocNo,
      externalStatus: r.externalStatus,
      lastSyncedAt: r.lastSyncedAt,
      externalDocuments: externalDocumentsOfDetail(r.detail),
    };
  }

  /** `{id}` หรือ `ext:{externalId}` ของรถร่วม (ST7-T02) → uuid · ไม่พบ/ลบแล้ว/tenant อื่น = 404 */
  private async carrierIdOf(tx: Tx, ref: string): Promise<string> {
    const id = await refToId('carrier', ref, tx.carrier);
    const c = await tx.carrier.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!c) throw new ProblemException('not_found');
    return c.id;
  }

  /** `{id}` หรือ `ext:{externalId}` ของลูกค้า (ST7-T02) → uuid · ไม่พบ/ลบแล้ว/tenant อื่น = 404 */
  private async customerIdOf(tx: Tx, ref: string): Promise<string> {
    const id = await refToId('customer', ref, tx.customer);
    const c = await tx.customer.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!c) throw new ProblemException('not_found');
    return c.id;
  }
}

/** ST8-T08 `detail.documents` ของ external_mapping (เขียนโดย ErpAdapterSink) → รายการที่แสดงได้ · รูปผิด = ตัดทิ้ง */
export function externalDocumentsOfDetail(detail: unknown): DocumentSyncView['externalDocuments'] {
  const list = (detail as { documents?: unknown } | null)?.documents;
  if (!Array.isArray(list)) return [];
  return list.flatMap((d) => {
    const x = (d ?? {}) as Record<string, unknown>;
    if (typeof x.externalId !== 'string' || !x.externalId) return [];
    return [
      {
        ref: typeof x.ref === 'string' ? x.ref : '',
        externalId: x.externalId,
        externalDocNo: typeof x.externalDocNo === 'string' ? x.externalDocNo : null,
        group: typeof x.group === 'string' ? x.group : null,
      },
    ];
  });
}
