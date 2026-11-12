import { Injectable } from '@nestjs/common';
import { Prisma, type ActiveStatus, type Carrier } from '@prisma/client';
import type { TransitionTable } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { scopeAllows } from '@tms/domain';
import { BlindIndex } from '../../common/blind-index';
import { FieldCipher } from '../../common/crypto';
import { requestContext } from '../../common/request-context';
import { encodeId, tryDecodeId } from '../../common/ids';
import { iEquals } from '../../common/ilike';
import { ProblemException } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { StateService } from '../../state/state.service';
import { EXPORT_MAX_ROWS } from '../master/export';
import {
  assertNotReferenced,
  lockForRemoval,
  deletedFilter,
  emitMasterEvent,
  isNoopUpdate,
  likeEscape,
  lockKey,
  masterKeyset,
  nextCode,
  statusFilter,
  upsertByExternalId,
} from '../master/master-kit';
import type {
  BankCode,
  CarrierAddressDto,
  CarrierDto,
  CarrierListQuery,
  CarrierWhtRate,
  CreateCarrierDto,
  RevealField,
  UpdateCarrierDto,
  UpsertCarrierDto,
} from './carrier.dto';

export const CARRIER_CODE_PREFIX = 'SUB';
/** ความลึกสูงสุดของสายสังกัด (กันข้อมูลวน/เสียทำให้เดินไม่จบ) */
const MAX_DEPTH = 50;
const DECIMAL_FIELDS = ['whtRateDefault'] as const;
/** ค่าที่แสดงแทนเลขลับ (NFR-304: `•••• 1234`) */
export const mask = (last4: string | null | undefined) => (last4 ? `•••• ${last4}` : null);

type CarEvent = 'activate' | 'deactivate';
export const CARRIER_TRANSITIONS: TransitionTable<ActiveStatus, CarEvent> = {
  ACTIVE: { deactivate: 'INACTIVE' },
  INACTIVE: { activate: 'ACTIVE' },
};

type Usage = { vehicles: number; drivers: number; children: number };
type Ref = { id: string; code: string; legalName: string };
const NO_USAGE: Usage = { vehicles: 0, drivers: 0, children: 0 };

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

export function toCarrierDto(c: Carrier, usage: Usage = NO_USAGE, parent?: Ref | null): CarrierDto {
  return {
    id: encodeId('carrier', c.id),
    code: c.code,
    externalId: c.externalId,
    legalName: c.legalName,
    entityType: c.entityType,
    whtForm: c.entityType === 'INDIVIDUAL' ? 'PND3' : 'PND53',
    taxId: c.entityType === 'JURISTIC' ? c.taxId : null,
    taxIdLast4: c.taxIdLast4,
    branchCode: c.branchCode,
    address: (c.address as CarrierAddressDto | null) ?? null,
    whtRate: c.whtRateDefault.toFixed(2) as CarrierWhtRate,
    bankAccount:
      c.bankCode && c.bankAccountLast4 && c.bankAccountName
        ? {
            bankCode: c.bankCode as BankCode,
            last4: c.bankAccountLast4,
            accountName: c.bankAccountName,
          }
        : null,
    paymentTermDays: c.paymentTermDays,
    requirePodToPay: c.requirePodToPay,
    phone: c.phone,
    lineContact: c.lineContact,
    parent: parent
      ? { id: encodeId('carrier', parent.id), code: parent.code, legalName: parent.legalName }
      : null,
    billingCompanyId: c.billingCompanyId ? encodeId('company', c.billingCompanyId) : null,
    maxTripsPerDay: c.maxTripsPerDay,
    priority: c.priority,
    usage,
    status: c.status.toLowerCase() as CarrierDto['status'],
    ...(c.deletedAt ? { deletedAt: c.deletedAt.toISOString() } : {}),
    version: c.version,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/**
 * snapshot สำหรับ audit — ไม่มีค่าลับ (เลขบัตร/เลขบัญชีเป็น `•••• 1234`) ไม่มี updatedAt/version/usage
 * parent เก็บเป็นรหัส (ไม่ใช่ object) ให้ diff อ่านง่าย
 */
export function auditView(c: Carrier, parent?: Ref | null): Record<string, unknown> {
  const {
    updatedAt: _u,
    version: _v,
    usage: _x,
    whtForm: _w,
    taxId: _t,
    taxIdLast4: _l,
    bankAccount: b,
    parent: _p,
    ...rest
  } = toCarrierDto(c);
  return {
    ...rest,
    taxId: c.entityType === 'JURISTIC' ? c.taxId : mask(c.taxIdLast4),
    bankAccount: b ? `${b.bankCode} ${mask(b.last4)} ${b.accountName}` : null,
    parentCarrierId: c.parentCarrierId
      ? (parent?.code ?? encodeId('carrier', c.parentCarrierId))
      : null,
  };
}

/**
 * รถร่วม / ผู้รับเหมา (ST2-T05; docs/04 B Carrier, docs/01 §3.2, spec/10 Carrier) — ใช้ master kit ของ ST2-T01
 * - เลขบัตรประชาชน (บุคคลธรรมดา) และเลขบัญชีธนาคารเข้ารหัสด้วย FieldCipher + เก็บ 4 หลักท้าย — response/audit/event/export ไม่มีค่าเต็ม
 * - ดูค่าเต็มได้ทาง `reveal` (สิทธิ์ settlements:pay) และลง audit ทุกครั้ง (spec/11 NFR-153)
 * - carrier เป็น principal แยกของ portal/magic link (A3) — ไม่สร้าง app_user จึงไม่นับ seat
 * - ลบได้เฉพาะที่ไม่เคยถูกอ้างอิง (รถ คนขับ rate card เที่ยว ต้นทุนรถ carrier ลูก) → soft delete (MD-004)
 */
@Injectable()
export class CarriersService {
  private cipherInstance?: FieldCipher;
  private blindInstance?: BlindIndex;
  constructor(
    private readonly db: DbService,
    private readonly state: StateService,
    private readonly audit: AuditService,
  ) {}

  private get cipher(): FieldCipher {
    return (this.cipherInstance ??= new FieldCipher());
  }

  private get blind(): BlindIndex {
    return (this.blindInstance ??= new BlindIndex());
  }

  /** ถอดรหัส — กุญแจเดิมถูกถอดออกแล้ว → 409 `secret_unreadable` (ไม่ใช่ 500) */
  private decrypt(value: string, field: string): string {
    try {
      return this.cipher.decrypt(value);
    } catch {
      throw new ProblemException('secret_unreadable', `${field} cannot be decrypted`, [
        { field, code: 'secret_unreadable', message: 'stored value cannot be decrypted' },
      ]);
    }
  }

  // ---------- read ----------

  private where(q: CarrierListQuery): Prisma.CarrierWhereInput {
    const and: Prisma.CarrierWhereInput[] = [deletedFilter(q)];
    const status = statusFilter(q.status);
    if (status) and.push({ status });
    if (q.externalId) and.push({ externalId: q.externalId });
    if (q.entityType) and.push({ entityType: q.entityType });
    if (q.parentCarrierId)
      and.push({ parentCarrierId: tryDecodeId('carrier', q.parentCarrierId) ?? undefined });
    const like = (v: string) => ({ contains: likeEscape(v), mode: 'insensitive' as const });
    if (q.name) and.push({ legalName: like(q.name) });
    if (q.q) {
      const digits = q.q.replace(/[\s-]/g, '');
      and.push({
        OR: [
          { code: like(q.q) },
          { legalName: like(q.q) },
          { externalId: like(q.q) },
          // เลขภาษีนิติบุคคลค้นบางส่วนได้ · บุคคลธรรมดาค้นได้เฉพาะ 4 หลักท้าย (เลขเต็มเข้ารหัส)
          ...(/^\d{3,13}$/.test(digits) ? [{ taxId: { contains: digits } }] : []),
          ...(/^\d{4}$/.test(digits) ? [{ taxIdLast4: digits }] : []),
        ],
      });
    }
    return { AND: and };
  }

  private async usage(ids: string[]): Promise<Map<string, Usage>> {
    const out = new Map<string, Usage>();
    if (!ids.length) return out;
    const tx = this.db.tx;
    const [veh, drv, kids] = await Promise.all([
      tx.vehicle.groupBy({
        by: ['carrierId'],
        where: { carrierId: { in: ids }, status: { not: 'RETIRED' }, deletedAt: null },
        _count: { _all: true },
      }),
      tx.driver.groupBy({
        by: ['carrierId'],
        where: { carrierId: { in: ids }, deletedAt: null, status: { not: 'INACTIVE' } },
        _count: { _all: true },
      }),
      tx.carrier.groupBy({
        by: ['parentCarrierId'],
        where: { parentCarrierId: { in: ids }, deletedAt: null },
        _count: { _all: true },
      }),
    ]);
    for (const id of ids) out.set(id, { ...NO_USAGE });
    for (const g of veh) if (g.carrierId) out.get(g.carrierId)!.vehicles = g._count._all;
    for (const g of drv) if (g.carrierId) out.get(g.carrierId)!.drivers = g._count._all;
    for (const g of kids)
      if (g.parentCarrierId) out.get(g.parentCarrierId)!.children = g._count._all;
    return out;
  }

  private async parents(rows: Carrier[]): Promise<Map<string, Ref>> {
    const ids = [...new Set(rows.map((r) => r.parentCarrierId).filter((x): x is string => !!x))];
    if (!ids.length) return new Map();
    const ps = await this.db.tx.carrier.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, code: true, legalName: true },
    });
    return new Map(ps.map((p) => [p.id, p]));
  }

  private async toDtos(rows: Carrier[]): Promise<CarrierDto[]> {
    const [u, p] = await Promise.all([this.usage(rows.map((r) => r.id)), this.parents(rows)]);
    return rows.map((r) => toCarrierDto(r, u.get(r.id), p.get(r.parentCarrierId ?? '') ?? null));
  }

  async list(q: CarrierListQuery) {
    const k = masterKeyset(q);
    const rows = await this.db.tx.carrier.findMany({
      where: { AND: [this.where(q), k.where] },
      orderBy: k.orderBy,
      take: k.take,
    });
    const dtos = new Map(
      (await this.toDtos(rows.slice(0, q.limit ?? 50))).map((d, i) => [rows[i]!.id, d]),
    );
    return k.page(rows, (r) => dtos.get(r.id) ?? toCarrierDto(r));
  }

  /** แถวสำหรับส่งออก (ตามตัวกรองเดียวกับ list หรือ id ที่เลือก) — เกินเพดาน → 422 */
  async exportRows(q: CarrierListQuery & { ids?: string }) {
    const ids = q.ids?.split(',').map((x) => tryDecodeId('carrier', x)!);
    const where = ids ? { AND: [this.where(q), { id: { in: ids } }] } : this.where(q);
    const rows = await this.db.tx.carrier.findMany({
      where,
      orderBy: [{ code: 'asc' }],
      take: EXPORT_MAX_ROWS + 1,
    });
    if (rows.length > EXPORT_MAX_ROWS)
      throw field422(
        'query',
        'too_many_rows',
        `export is limited to ${EXPORT_MAX_ROWS} rows — narrow the filter`,
      );
    return this.toDtos(rows);
  }

  async summary() {
    const g = await this.db.tx.carrier.groupBy({
      by: ['status', 'entityType'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    const n = (f: (x: (typeof g)[number]) => boolean) =>
      g.filter(f).reduce((a, x) => a + x._count._all, 0);
    return {
      total: n(() => true),
      active: n((x) => x.status === 'ACTIVE'),
      inactive: n((x) => x.status === 'INACTIVE'),
      individual: n((x) => x.entityType === 'INDIVIDUAL'),
      juristic: n((x) => x.entityType === 'JURISTIC'),
    };
  }

  async nextCode(): Promise<string> {
    return nextCode(this.db.tx, 'carrier', CARRIER_CODE_PREFIX);
  }

  async get(id: string): Promise<Carrier> {
    const c = await this.db.tx.carrier.findFirst({ where: { id, deletedAt: null } });
    if (!c) throw new ProblemException('not_found');
    return c;
  }

  async getByExternalId(externalId: string): Promise<Carrier> {
    const c = await this.db.tx.carrier.findFirst({ where: { externalId, deletedAt: null } });
    if (!c) throw new ProblemException('not_found');
    return c;
  }

  async dto(c: Carrier): Promise<CarrierDto> {
    return (await this.toDtos([c]))[0]!;
  }

  /** ค่าเต็มของเลขลับ (ถอดรหัส) — ลง audit `carrier.pii_revealed` (spec/11 NFR-153) */
  async reveal(c: Carrier, field: RevealField, reason?: string): Promise<string | null> {
    let value: string | null;
    if (field === 'taxId')
      value = c.taxId ?? (c.taxIdEnc ? this.decrypt(c.taxIdEnc, 'taxId') : null);
    else value = c.bankAccountEnc ? this.decrypt(c.bankAccountEnc, 'bankAccount') : null;
    await this.audit.record({
      action: 'carrier.pii_revealed',
      entityType: 'carrier',
      entityId: c.id,
      after: { field },
      reason,
    });
    return value;
  }

  // ---------- write ----------

  /**
   * id ของ carrier ที่จะเป็นสังกัด: อยู่ใน tenant, ไม่ถูกลบ, ใช้งานอยู่, ไม่ใช่ตัวเอง, ไม่วน
   * lock ทั้งต้นไม้ของ tenant ก่อนอ่าน (คำขอพร้อมกัน A→B / B→A ต้องรอกัน แล้วอ่านข้อมูลใหม่) · เดินขึ้นไม่เกิน 50 ชั้น
   */
  private async resolveParent(value: string, selfId?: string): Promise<string> {
    const tx = this.db.tx;
    await lockKey(tx, 'carrier.tree');
    const id = tryDecodeId('carrier', value);
    const p = id ? await tx.carrier.findFirst({ where: { id, deletedAt: null } }) : null;
    if (!p) throw field422('parentCarrierId', 'not_found', 'parent carrier not found');
    if (p.status !== 'ACTIVE')
      throw field422('parentCarrierId', 'inactive', 'parent carrier is suspended');
    if (selfId) {
      if (p.id === selfId)
        throw field422('parentCarrierId', 'parent_cycle', 'cannot be own parent');
      const seen = new Set<string>([p.id]);
      let cur: string | null = p.parentCarrierId;
      while (cur) {
        if (cur === selfId)
          throw field422('parentCarrierId', 'parent_cycle', 'parent chain would loop');
        if (seen.has(cur) || seen.size >= MAX_DEPTH)
          throw field422('parentCarrierId', 'parent_depth', 'parent chain too deep or broken');
        seen.add(cur);
        const up: { parentCarrierId: string | null } | null = await tx.carrier.findUnique({
          where: { id: cur },
          select: { parentCarrierId: true },
        });
        cur = up?.parentCarrierId ?? null;
      }
    }
    return p.id;
  }

  /** เขียนเลขผู้เสียภาษี: นิติบุคคลเก็บตรง · บุคคลธรรมดาเข้ารหัส + blind index (เขียนใหม่ทุกครั้งที่ส่งมา) */
  private writeTax(
    data: Prisma.CarrierUncheckedUpdateInput,
    type: 'INDIVIDUAL' | 'JURISTIC',
    tax: string,
  ) {
    if (type === 'JURISTIC') {
      // เลขนิติบุคคลขึ้นต้นด้วย 0 (เลขบัตรประชาชนขึ้นต้น 1–8) — กันกรอกเลขบัตรลงช่องที่เก็บแบบเปิด [DECISION spec/12 §3]
      if (!tax.startsWith('0'))
        throw field422('taxId', 'juristic_prefix', 'juristic taxId must start with 0');
      data.taxId = tax;
      data.taxIdEnc = null;
      data.taxIdHash = null;
    } else {
      data.taxId = null;
      data.taxIdEnc = this.cipher.encrypt(tax);
      data.taxIdHash = this.blind.of(tax);
    }
    data.taxIdLast4 = tax.slice(-4);
  }

  /**
   * แปลง DTO → คอลัมน์ (รวมการเข้ารหัส) — `current` = แถวเดิม (ตอนแก้)
   * เลขลับที่ส่งมาเท่าเดิม (ถอดรหัสเทียบ) ไม่เขียนใหม่ → ส่งซ้ำไม่เพิ่ม version
   * คืน `secrets` = ช่องลับที่เปลี่ยนจริง (ใช้ทำ audit)
   */
  private async toData(
    input: UpdateCarrierDto | CreateCarrierDto,
    current?: Carrier,
  ): Promise<{ data: Prisma.CarrierUncheckedUpdateInput; secrets: string[] }> {
    const tx = this.db.tx;
    const data: Prisma.CarrierUncheckedUpdateInput = {};
    const secrets: string[] = [];
    if (input.legalName !== undefined) data.legalName = input.legalName;

    // ---- เลขผู้เสียภาษี ----
    // ไม่ถอดรหัสเลขเดิมเพื่อย้ายไปเก็บแบบเปิด: เปลี่ยนประเภทต้องส่งเลขใหม่มาด้วย (กันเลขบัตรรั่ว — review ST2-T05)
    const type = (input.entityType ?? current?.entityType) as 'INDIVIDUAL' | 'JURISTIC';
    if (input.entityType !== undefined) data.entityType = input.entityType;
    const typeChanged =
      !!current && input.entityType !== undefined && input.entityType !== current.entityType;
    if (input.taxId !== undefined) {
      this.writeTax(data, type, input.taxId);
      if (current && (type === 'INDIVIDUAL' || current.entityType === 'INDIVIDUAL'))
        secrets.push('taxId');
    } else if (!current) throw field422('taxId', 'required', 'taxId is required');
    else if (typeChanged && (current.taxId || current.taxIdEnc))
      throw field422(
        'taxId',
        'required_on_type_change',
        'changing entityType requires taxId in the same request',
      );
    else if (
      input.entityType !== undefined &&
      current.taxIdEnc &&
      this.cipher.needsRotation(current.taxIdEnc)
    )
      // หมุน key: ส่งช่องเลขภาษีมา (ประเภทเดิม) → เข้ารหัสใหม่ด้วย key ปัจจุบัน
      data.taxIdEnc = this.cipher.encrypt(this.decrypt(current.taxIdEnc, 'taxId'));

    // ---- สาขา: นิติบุคคลไม่ส่ง = 00000 · บุคคลธรรมดาไม่มีสาขา ----
    let branch = input.branchCode !== undefined ? input.branchCode : (current?.branchCode ?? null);
    if (type === 'INDIVIDUAL') {
      if (input.branchCode)
        throw field422('branchCode', 'individual', 'individuals have no branch');
      branch = null;
    } else if (!branch) branch = '00000';
    if (!current || branch !== current.branchCode) data.branchCode = branch;

    if (input.address !== undefined)
      data.address = input.address === null ? Prisma.DbNull : ({ ...input.address } as object);
    if (input.whtRate !== undefined) data.whtRateDefault = input.whtRate;

    // ---- บัญชีธนาคาร: เลขบัญชีเข้ารหัส + 4 หลักท้าย · แก้ได้เฉพาะ settlements:pay (ชั่วคราวจนกว่าจะตัดสิน step-up NFR-107) ----
    if (input.bankAccount !== undefined) {
      if (!scopeAllows(requestContext.require().scopes ?? [], 'settlements:pay'))
        throw new ProblemException('forbidden', 'changing bankAccount requires settlements:pay');
      const b = input.bankAccount;
      if (b === null) {
        data.bankCode = null;
        data.bankAccountEnc = null;
        data.bankAccountLast4 = null;
        data.bankAccountName = null;
        if (current?.bankAccountEnc) secrets.push('bankAccount');
      } else {
        data.bankCode = b.bankCode;
        data.bankAccountName = b.accountName;
        if (b.accountNo) {
          // เทียบเลขเดิมได้ (ผู้แก้บัญชีมีสิทธิ์ settlements:pay = ดูเลขเต็มได้อยู่แล้ว จึงไม่เป็นช่องเดาเลข)
          // ส่งซ้ำเลขเดิม = ไม่เขียน (PUT external ส่งซ้ำไม่เพิ่ม version) · ถอดเลขเดิมไม่ได้/ต้องหมุน key = เขียนใหม่
          let same = false;
          if (current?.bankAccountEnc && !this.cipher.needsRotation(current.bankAccountEnc))
            try {
              same = this.cipher.decrypt(current.bankAccountEnc) === b.accountNo;
            } catch {
              same = false;
            }
          if (!same) {
            data.bankAccountEnc = this.cipher.encrypt(b.accountNo);
            data.bankAccountLast4 = b.accountNo.slice(-4);
            if (current) secrets.push('bankAccount');
          }
        } else if (!current?.bankAccountEnc)
          throw field422('bankAccount.accountNo', 'required', 'accountNo is required');
        else if (this.cipher.needsRotation(current.bankAccountEnc))
          data.bankAccountEnc = this.cipher.encrypt(
            this.decrypt(current.bankAccountEnc, 'bankAccount'),
          );
      }
    }
    if (input.paymentTermDays !== undefined) data.paymentTermDays = input.paymentTermDays;
    if (input.requirePodToPay !== undefined) data.requirePodToPay = input.requirePodToPay;
    if (input.phone !== undefined) data.phone = input.phone;
    if (input.lineContact !== undefined) data.lineContact = input.lineContact;
    if (input.maxTripsPerDay !== undefined) data.maxTripsPerDay = input.maxTripsPerDay;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.parentCarrierId !== undefined) {
      const same =
        !!current?.parentCarrierId &&
        tryDecodeId('carrier', input.parentCarrierId ?? '') === current.parentCarrierId;
      data.parentCarrierId =
        input.parentCarrierId === null
          ? null
          : same
            ? current!.parentCarrierId
            : await this.resolveParent(input.parentCarrierId, current?.id);
    }
    if (input.billingCompanyId !== undefined) {
      if (input.billingCompanyId === null) data.billingCompanyId = null;
      else {
        const id = tryDecodeId('company', input.billingCompanyId);
        const co = id ? await tx.company.findUnique({ where: { id } }) : null;
        if (!co || co.status !== 'ACTIVE')
          throw field422('billingCompanyId', 'not_found', 'legal entity not found or inactive');
        data.billingCompanyId = co.id;
      }
    }
    return { data, secrets };
  }

  /** นิติบุคคล: (เลขผู้เสียภาษี, สาขา) ห้ามซ้ำ (เหมือน MD-020) → 409 พร้อมรายการเดิม */
  private async assertUniqueTax(data: Prisma.CarrierUncheckedUpdateInput, current?: Carrier) {
    const taxId = (data.taxId !== undefined ? data.taxId : current?.taxId) as string | null;
    const branch = (data.branchCode !== undefined ? data.branchCode : current?.branchCode) as
      string | null;
    const hash = data.taxIdHash as string | null | undefined;
    if (hash) {
      await lockKey(this.db.tx, `carrier.taxhash:${hash}`);
      const dup = await this.db.tx.carrier.findFirst({
        where: {
          taxIdHash: hash,
          deletedAt: null,
          ...(current ? { id: { not: current.id } } : {}),
        },
      });
      if (dup) {
        // เลขบัตรประชาชนซ้ำ: บอกรายการเดิมเฉพาะผู้ดูเลขเต็มได้ (settlements:pay) + บันทึก audit แยก transaction
        // กันใช้การสร้างผู้รับเหมาเดาเลขบัตรของคนอื่น (review ST2-T08 — แบบเดียวกับคนขับ)
        await this.audit.recordDetached({
          action: 'carrier.tax_id_duplicate',
          entityType: 'carrier',
          entityId: dup.id,
          after: { field: 'taxId' },
        });
        const showWho = scopeAllows(requestContext.require().scopes ?? [], 'settlements:pay');
        throw new ProblemException(
          'duplicate',
          undefined,
          [
            {
              field: 'taxId',
              code: 'duplicate',
              message: showWho ? `carrier already exists: ${dup.code}` : 'already exists',
            },
          ],
          showWho
            ? {
                existing: {
                  id: encodeId('carrier', dup.id),
                  code: dup.code,
                  legalName: dup.legalName,
                },
              }
            : undefined,
        );
      }
    }
    if (!taxId) return;
    if (current && taxId === current.taxId && branch === current.branchCode) return;
    await lockKey(this.db.tx, `carrier.tax:${taxId}:${branch ?? ''}`);
    const dup = await this.db.tx.carrier.findFirst({
      where: {
        taxId,
        branchCode: branch,
        deletedAt: null,
        ...(current ? { id: { not: current.id } } : {}),
      },
    });
    if (dup)
      throw new ProblemException(
        'duplicate',
        undefined,
        [{ field: 'taxId', code: 'duplicate', message: `carrier already exists: ${dup.code}` }],
        { existing: { id: encodeId('carrier', dup.id), code: dup.code, legalName: dup.legalName } },
      );
  }

  private async assertUniqueExternal(externalId: string, exceptId?: string) {
    const dup = await this.db.tx.carrier.findFirst({
      where: { externalId, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (dup)
      throw new ProblemException('duplicate', undefined, [
        { field: 'externalId', code: 'duplicate', message: 'externalId already used' },
      ]);
  }

  private async parentOf(c: Carrier): Promise<Ref | null> {
    if (!c.parentCarrierId) return null;
    return this.db.tx.carrier.findUnique({
      where: { id: c.parentCarrierId },
      select: { id: true, code: true, legalName: true },
    });
  }

  async create(
    input: CreateCarrierDto | (UpsertCarrierDto & { externalId: string }),
  ): Promise<Carrier> {
    const tx = this.db.tx;
    const { data } = await this.toData(input);
    await this.assertUniqueTax(data);
    if (input.externalId) {
      await lockKey(tx, `carrier.ext:${input.externalId}`);
      await this.assertUniqueExternal(input.externalId);
    }
    await lockKey(tx, 'carrier.code');
    let code = input.code;
    if (code) {
      const taken = await tx.carrier.findFirst({
        where: { code: iEquals(code) },
        select: { id: true },
      });
      if (taken)
        throw new ProblemException('duplicate', undefined, [
          { field: 'code', code: 'duplicate', message: 'code already exists' },
        ]);
    } else code = await nextCode(tx, 'carrier', CARRIER_CODE_PREFIX);
    const c = await tx.carrier.create({
      data: {
        ...(data as object),
        code,
        externalId: input.externalId ?? null,
      } as Prisma.CarrierUncheckedCreateInput, // tenantId เติมโดย tenantExtension
    });
    const parent = await this.parentOf(c);
    await this.audit.record({
      action: 'carrier.created',
      entityType: 'carrier',
      entityId: c.id,
      after: auditView(c, parent),
    });
    await emitMasterEvent(
      tx,
      'carrier.created',
      'carrier',
      c.id,
      toCarrierDto(c, NO_USAGE, parent),
    );
    return c;
  }

  async update(id: string, input: UpdateCarrierDto, expected?: number): Promise<Carrier> {
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    const { data, secrets } = await this.toData(input, current);
    await this.assertUniqueTax(data, current);
    if (input.externalId !== undefined) {
      if (input.externalId) await this.assertUniqueExternal(input.externalId, current.id);
      data.externalId = input.externalId;
    }
    if (isNoopUpdate(current, data as Record<string, unknown>, DECIMAL_FIELDS)) return current; // ส่งซ้ำค่าเดิมไม่เพิ่ม version
    const c = await this.bumpVersion(current, data);
    const [pBefore, pAfter] = await Promise.all([this.parentOf(current), this.parentOf(c)]);
    const before = auditView(current, pBefore);
    const after = auditView(c, pAfter);
    // ข้างใดข้างหนึ่งเป็นบุคคลธรรมดา (เลขเข้ารหัส) → ปิดบังทั้งก่อน/หลัง
    const encPath = current.entityType === 'INDIVIDUAL' || c.entityType === 'INDIVIDUAL';
    if (encPath) {
      before.taxId = mask(current.taxIdLast4);
      after.taxId = mask(c.taxIdLast4);
    }
    // เลขลับเปลี่ยนแต่ 4 หลักท้ายเท่าเดิม → ค่าก่อนเป็น •••• (ให้ประวัติเห็นว่าเปลี่ยน โดยไม่มีเลขเต็ม)
    for (const k of secrets)
      if (JSON.stringify(before[k]) === JSON.stringify(after[k])) before[k] = '••••';
    await this.audit.changed('carrier.updated', 'carrier', c.id, before, after);
    const changed = Object.keys(after).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    if (changed.length)
      await emitMasterEvent(
        this.db.tx,
        'carrier.updated',
        'carrier',
        c.id,
        encPath
          ? { ...toCarrierDto(c, NO_USAGE, pAfter), taxId: null }
          : toCarrierDto(c, NO_USAGE, pAfter),
        { changedFields: changed },
      );
    return c;
  }

  /** PUT /carriers/external/{externalId} — idempotent (ส่งซ้ำ = อัปเดตแถวเดิม) */
  async upsertExternal(externalId: string, input: UpsertCarrierDto, expected?: number) {
    const tx = this.db.tx;
    return upsertByExternalId(tx, 'carrier', externalId, {
      find: () => tx.carrier.findFirst({ where: { externalId, deletedAt: null } }),
      create: () => this.create({ ...input, externalId }),
      update: (cur) => {
        const { code: _code, ...rest } = input;
        return this.update(cur.id, rest, expected);
      },
    });
  }

  /** ระงับชั่วคราว / เปิดใช้ — ระงับ (เหตุผล ≥ 10) ไม่บล็อกเพราะรถในสังกัด (ระงับ = ไม่เสนองานใหม่) */
  async changeStatus(id: string, event: CarEvent, reason?: string, expected?: number) {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    const parent = await this.parentOf(current);
    let updated!: Carrier;
    await this.state.transition(tx, {
      docType: 'carrier',
      docId: id,
      table: CARRIER_TRANSITIONS,
      from: current.status,
      event,
      note: reason ?? null,
      eventType: event === 'deactivate' ? 'carrier.deactivated' : 'carrier.reactivated',
      apply: async (to) => {
        updated = await this.bumpVersion(current, { status: to });
        await this.audit.changed(
          event === 'deactivate' ? 'carrier.deactivated' : 'carrier.reactivated',
          'carrier',
          id,
          auditView(current, parent),
          auditView(updated, parent),
          reason,
        );
        return toCarrierDto(updated, NO_USAGE, parent) as unknown as Record<string, unknown>;
      },
    });
    return updated;
  }

  /** MD-004: ลบได้เฉพาะที่ไม่เคยถูกอ้างอิง → soft delete; ถูกอ้างอิง → 409 `in_use` (ให้ระงับแทน) */
  async remove(id: string, reason: string, expected?: number): Promise<void> {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    await lockKey(tx, 'carrier.tree'); // กันมี carrier ลูกเพิ่มระหว่างตรวจ
    // กันสร้าง rate card ขาซื้อที่อ้างรถร่วมนี้ระหว่างลบ (rate card ล็อก FOR SHARE — lockReferenced) — ST2-T14
    await lockForRemoval(tx, 'carrier', id);
    await assertNotReferenced(
      [
        {
          name: 'vehicles',
          count: () =>
            tx.vehicle.count({
              where: { carrierId: id, status: { not: 'RETIRED' }, deletedAt: null },
            }),
        },
        {
          // รถปลดระวางไม่นับใน "จำนวนรถ" แต่ยังอ้างถึงอยู่ — แยกให้ข้อความอธิบายได้ (QA ST2-T05)
          name: 'retiredVehicles',
          count: () =>
            tx.vehicle.count({ where: { carrierId: id, status: 'RETIRED', deletedAt: null } }),
        },
        {
          name: 'drivers',
          count: () =>
            tx.driver.count({
              where: { carrierId: id, deletedAt: null, status: { not: 'INACTIVE' } },
            }),
        },
        {
          // คนขับปิดใช้งานยังอ้างถึงผู้รับเหมา (ประวัติ) — แยกให้ข้อความอธิบายได้ (review ST2-T08, แบบเดียวกับรถปลดระวาง)
          name: 'inactiveDrivers',
          count: () =>
            tx.driver.count({ where: { carrierId: id, deletedAt: null, status: 'INACTIVE' } }),
        },
        { name: 'rateCards', count: () => tx.rateCard.count({ where: { carrierId: id } }) },
        { name: 'trips', count: () => tx.trip.count({ where: { carrierId: id } }) },
        { name: 'tripCosts', count: () => tx.tripCost.count({ where: { carrierId: id } }) },
        {
          name: 'children',
          count: () => tx.carrier.count({ where: { parentCarrierId: id, deletedAt: null } }),
        },
      ],
      { action: 'deactivate', th: 'ระงับชั่วคราว', en: 'suspend' },
    );
    const parent = await this.parentOf(current);
    await this.bumpVersion(current, {
      deletedAt: new Date(),
      externalId: null,
      deletedExternalId: current.externalId,
    });
    await this.audit.record({
      action: 'carrier.deleted',
      entityType: 'carrier',
      entityId: id,
      before: auditView(current, parent),
      reason,
    });
    await emitMasterEvent(
      tx,
      'carrier.deleted',
      'carrier',
      id,
      toCarrierDto(current, NO_USAGE, parent),
    );
  }

  /** optimistic lock: update เฉพาะเมื่อ version ยังเท่าเดิม ไม่งั้น 412 */
  private async bumpVersion(
    current: Carrier,
    data: Prisma.CarrierUncheckedUpdateInput,
  ): Promise<Carrier> {
    const tx = this.db.tx;
    const r = await tx.carrier.updateMany({
      where: { id: current.id, version: current.version, deletedAt: null },
      data: { ...data, version: { increment: 1 } },
    });
    if (r.count !== 1) throw new ProblemException('precondition_failed');
    return (await tx.carrier.findUnique({ where: { id: current.id } }))!;
  }
}
