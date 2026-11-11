import { Injectable } from '@nestjs/common';
import { Prisma, type ActiveStatus, type Customer } from '@prisma/client';
import type { TransitionTable } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { StateService } from '../../state/state.service';
import {
  assertNotReferenced,
  deletedFilter,
  emitMasterEvent,
  isNoopUpdate,
  likeEscape,
  lockForRemoval,
  lockKey,
  masterKeyset,
  nextCode,
  statusFilter,
  upsertByExternalId,
} from '../master/master-kit';
import { EXPORT_MAX_ROWS } from '../master/export';
import type {
  CreateCustomerDto,
  CustomerAddressDto,
  CustomerContactDto,
  CustomerDto,
  CustomerFieldsDto,
  CustomerListQuery,
  UpdateCustomerDto,
  UpsertCustomerDto,
} from './customer.dto';
import { iEquals } from '../../common/ilike';

export const CUSTOMER_CODE_PREFIX = 'CUS';
const DECIMAL_FIELDS = ['whtExpectedRate', 'creditLimit'] as const;
type CustomerEvent = 'activate' | 'deactivate';
export const CUSTOMER_TRANSITIONS: TransitionTable<ActiveStatus, CustomerEvent> = {
  ACTIVE: { deactivate: 'INACTIVE' },
  INACTIVE: { activate: 'ACTIVE' },
};

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

export function toCustomerDto(c: Customer, salesOwnerName?: string | null): CustomerDto {
  return {
    id: encodeId('customer', c.id),
    code: c.code,
    externalId: c.externalId,
    legalName: c.legalName,
    taxId: c.taxId,
    branchCode: c.branchCode,
    billingAddress: (c.billingAddress as unknown as CustomerAddressDto | null) ?? null,
    contacts: (c.contacts as unknown as CustomerContactDto[]) ?? [],
    creditTermDays: c.paymentTermDays,
    billingCycle: c.billingCycle,
    taxInvoiceMode: c.taxInvoiceMode,
    defaultVatType: c.defaultVatType,
    whtExpectedRate: c.whtExpectedRate ? c.whtExpectedRate.toFixed(2) : null,
    creditLimit: c.creditLimit ? c.creditLimit.toFixed(2) : null,
    vatRegistered: c.vatRegistered,
    etaxCapable: c.etaxCapable,
    freeTimeMin: c.freeTimeMin,
    billingCompanyId: c.defaultBillingCompanyId
      ? encodeId('company', c.defaultBillingCompanyId)
      : null,
    salesOwner: c.salesOwnerUserId
      ? { id: encodeId('user', c.salesOwnerUserId), name: salesOwnerName ?? null }
      : null,
    status: c.status.toLowerCase() as CustomerDto['status'],
    ...(c.deletedAt ? { deletedAt: c.deletedAt.toISOString() } : {}),
    version: c.version,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/** snapshot สำหรับ audit/event — ไม่มี updatedAt/version (diff ไม่นับ) */
function auditView(c: Customer): Record<string, unknown> {
  const { updatedAt: _u, version: _v, ...rest } = toCustomerDto(c);
  return rest;
}

/**
 * ลูกค้า (ST2-T01; docs/01 §3.2, docs/04 B, spec/02 §1) — slice ต้นแบบของ master ทุกตัว
 * ไม่มีลบจริง: "ลบ" = soft delete เฉพาะลูกค้าที่ไม่เคยถูกอ้างอิง (MD-004); ที่ถูกอ้างอิงแล้ว → ปิดใช้
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly db: DbService,
    private readonly state: StateService,
    private readonly audit: AuditService,
  ) {}

  // ---------- read ----------

  private where(q: CustomerListQuery): Prisma.CustomerWhereInput {
    const and: Prisma.CustomerWhereInput[] = [deletedFilter(q)];
    const status = statusFilter(q.status);
    if (status) and.push({ status });
    if (q.billingCycle) and.push({ billingCycle: q.billingCycle });
    if (q.externalId) and.push({ externalId: q.externalId });
    const like = (v: string) => ({ contains: likeEscape(v), mode: 'insensitive' as const });
    if (q.code) and.push({ code: like(q.code) });
    if (q.name) and.push({ legalName: like(q.name) });
    if (q.q) {
      const digits = q.q.replace(/\D/g, '');
      and.push({
        OR: [
          { code: like(q.q) },
          { legalName: like(q.q) },
          { externalId: like(q.q) },
          ...(digits.length >= 3 ? [{ taxId: { contains: digits } }] : []),
        ],
      });
    }
    return { AND: and };
  }

  async list(q: CustomerListQuery) {
    const k = masterKeyset(q);
    const rows = await this.db.tx.customer.findMany({
      where: { AND: [this.where(q), k.where] },
      orderBy: k.orderBy,
      take: k.take,
    });
    const names = await this.ownerNames(rows);
    return k.page(rows, (r) => toCustomerDto(r, names.get(r.salesOwnerUserId ?? '')));
  }

  /** แถวสำหรับส่งออก (ตามตัวกรองเดียวกับ list หรือ id ที่เลือก) — เกินเพดาน → 422 */
  async exportRows(q: CustomerListQuery & { ids?: string }) {
    const ids = q.ids?.split(',').map((x) => tryDecodeId('customer', x)!);
    const where = ids ? { AND: [this.where(q), { id: { in: ids } }] } : this.where(q);
    const rows = await this.db.tx.customer.findMany({
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
    const names = await this.ownerNames(rows);
    return rows.map((r) => toCustomerDto(r, names.get(r.salesOwnerUserId ?? '')));
  }

  async summary() {
    const g = await this.db.tx.customer.groupBy({
      by: ['status'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    const n = (s: ActiveStatus) => g.find((x) => x.status === s)?._count._all ?? 0;
    const noTaxId = await this.db.tx.customer.count({ where: { deletedAt: null, taxId: null } });
    return {
      total: n('ACTIVE') + n('INACTIVE'),
      active: n('ACTIVE'),
      inactive: n('INACTIVE'),
      noTaxId,
    };
  }

  async nextCode(): Promise<string> {
    return nextCode(this.db.tx, 'customer', CUSTOMER_CODE_PREFIX);
  }

  async get(id: string): Promise<Customer> {
    const c = await this.db.tx.customer.findFirst({ where: { id, deletedAt: null } });
    if (!c) throw new ProblemException('not_found');
    return c;
  }

  async getByExternalId(externalId: string): Promise<Customer> {
    const c = await this.db.tx.customer.findFirst({ where: { externalId, deletedAt: null } });
    if (!c) throw new ProblemException('not_found');
    return c;
  }

  async dto(c: Customer): Promise<CustomerDto> {
    const names = await this.ownerNames([c]);
    return toCustomerDto(c, names.get(c.salesOwnerUserId ?? ''));
  }

  private async ownerNames(rows: Customer[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((r) => r.salesOwnerUserId).filter((x): x is string => !!x))];
    if (!ids.length) return new Map();
    const users = await this.db.tx.appUser.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  // ---------- write ----------

  /** แปลง DTO → คอลัมน์ + ตรวจ id ที่อ้างถึง (นิติบุคคล/ผู้ใช้ต้องมีใน tenant) */
  private async toData(input: CustomerFieldsDto & { legalName?: string }) {
    const tx = this.db.tx;
    const data: Prisma.CustomerUncheckedUpdateInput = {};
    if (input.legalName !== undefined) data.legalName = input.legalName;
    if (input.taxId !== undefined) data.taxId = input.taxId;
    if (input.branchCode !== undefined) data.branchCode = input.branchCode;
    if (input.billingAddress !== undefined)
      data.billingAddress =
        input.billingAddress === null ? Prisma.DbNull : ({ ...input.billingAddress } as object);
    if (input.contacts !== undefined) {
      if (input.contacts.filter((c) => c.isPrimary).length > 1)
        throw field422('contacts', 'one_primary', 'only one contact can be primary');
      data.contacts = input.contacts.map((c) => ({ ...c })) as object[];
    }
    if (input.creditTermDays !== undefined) data.paymentTermDays = input.creditTermDays;
    if (input.billingCycle !== undefined) data.billingCycle = input.billingCycle;
    if (input.taxInvoiceMode !== undefined) data.taxInvoiceMode = input.taxInvoiceMode;
    if (input.defaultVatType !== undefined) data.defaultVatType = input.defaultVatType;
    if (input.whtExpectedRate !== undefined) data.whtExpectedRate = input.whtExpectedRate;
    if (input.creditLimit !== undefined) data.creditLimit = input.creditLimit;
    if (input.vatRegistered !== undefined) data.vatRegistered = input.vatRegistered;
    if (input.etaxCapable !== undefined) data.etaxCapable = input.etaxCapable;
    if (input.freeTimeMin !== undefined) data.freeTimeMin = input.freeTimeMin;
    if (input.billingCompanyId !== undefined) {
      if (input.billingCompanyId === null) data.defaultBillingCompanyId = null;
      else {
        const id = tryDecodeId('company', input.billingCompanyId);
        const co = id ? await tx.company.findUnique({ where: { id } }) : null;
        if (!co || co.status !== 'ACTIVE')
          throw field422('billingCompanyId', 'not_found', 'legal entity not found or inactive');
        data.defaultBillingCompanyId = co.id;
      }
    }
    if (input.salesOwnerUserId !== undefined) {
      if (input.salesOwnerUserId === null) data.salesOwnerUserId = null;
      else {
        const id = tryDecodeId('user', input.salesOwnerUserId);
        const u = id
          ? await tx.appUser.findFirst({ where: { id, deletedAt: null }, select: { id: true } })
          : null;
        if (!u) throw field422('salesOwnerUserId', 'not_found', 'user not found');
        data.salesOwnerUserId = u.id;
      }
    }
    return data;
  }

  /** MD-020: (taxId, branchCode) ห้ามซ้ำ — ซ้ำ → 409 พร้อมรายการเดิม */
  private async assertUniqueTax(
    taxId: string | null,
    branchCode: string | null,
    exceptId?: string,
  ) {
    if (!taxId) return;
    await lockKey(this.db.tx, `customer.tax:${taxId}:${branchCode ?? ''}`);
    const dup = await this.db.tx.customer.findFirst({
      where: {
        taxId,
        branchCode,
        deletedAt: null,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
    });
    if (dup)
      throw new ProblemException(
        'duplicate',
        undefined,
        [{ field: 'taxId', code: 'duplicate', message: `customer already exists: ${dup.code}` }],
        {
          existing: { id: encodeId('customer', dup.id), code: dup.code, legalName: dup.legalName },
        },
      );
  }

  private async assertUniqueExternal(externalId: string, exceptId?: string) {
    const dup = await this.db.tx.customer.findFirst({
      where: { externalId, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (dup)
      throw new ProblemException('duplicate', undefined, [
        { field: 'externalId', code: 'duplicate', message: 'externalId already used' },
      ]);
  }

  async create(
    input: CreateCustomerDto | (UpsertCustomerDto & { externalId: string }),
  ): Promise<Customer> {
    const tx = this.db.tx;
    const data = await this.toData(input);
    const branchCode = input.branchCode ?? (input.taxId ? '00000' : null);
    await this.assertUniqueTax(input.taxId ?? null, branchCode);
    if (input.externalId) await this.assertUniqueExternal(input.externalId);
    await lockKey(tx, 'customer.code');
    let code = input.code;
    if (code) {
      const taken = await tx.customer.findFirst({
        where: { code: iEquals(code) },
        select: { id: true },
      });
      if (taken)
        throw new ProblemException('duplicate', undefined, [
          { field: 'code', code: 'duplicate', message: 'code already exists' },
        ]);
    } else code = await nextCode(tx, 'customer', CUSTOMER_CODE_PREFIX);
    const c = await tx.customer.create({
      data: {
        ...(data as object),
        legalName: input.legalName,
        branchCode,
        code,
        externalId: input.externalId ?? null,
      } as Prisma.CustomerUncheckedCreateInput, // tenantId เติมโดย tenantExtension
    });
    await this.audit.record({
      action: 'customer.created',
      entityType: 'customer',
      entityId: c.id,
      after: auditView(c),
    });
    await emitMasterEvent(tx, 'customer.created', 'customer', c.id, toCustomerDto(c));
    return c;
  }

  async update(id: string, input: UpdateCustomerDto, expected?: number): Promise<Customer> {
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    const data = await this.toData(input);
    const taxId = input.taxId !== undefined ? input.taxId : current.taxId;
    const branchCode = input.branchCode ?? current.branchCode ?? (taxId ? '00000' : null);
    if (input.taxId !== undefined || input.branchCode !== undefined) {
      data.branchCode = branchCode;
      await this.assertUniqueTax(taxId, branchCode, current.id);
    }
    if (input.externalId !== undefined) {
      if (input.externalId) await this.assertUniqueExternal(input.externalId, current.id);
      data.externalId = input.externalId;
    }
    if (isNoopUpdate(current, data as Record<string, unknown>, DECIMAL_FIELDS)) return current; // ส่งซ้ำค่าเดิม (เช่น PUT external) ไม่เพิ่ม version
    const c = await this.bumpVersion(current, data);
    const before = auditView(current);
    const after = auditView(c);
    await this.audit.changed('customer.updated', 'customer', c.id, before, after);
    const changed = Object.keys(after).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    if (changed.length)
      await emitMasterEvent(this.db.tx, 'customer.updated', 'customer', c.id, toCustomerDto(c), {
        changedFields: changed,
      });
    return c;
  }

  /** PUT /customers/external/{externalId} — idempotent (ส่งซ้ำ = อัปเดตแถวเดิม) */
  async upsertExternal(externalId: string, input: UpsertCustomerDto, expected?: number) {
    const tx = this.db.tx;
    return upsertByExternalId(tx, 'customer', externalId, {
      // รายการที่ลบแล้วย้าย externalId ไป deleted_external_id → ERP ส่งซ้ำได้ (สร้างใหม่)
      find: () => tx.customer.findFirst({ where: { externalId, deletedAt: null } }),
      create: () => this.create({ ...input, externalId }),
      update: (cur) => {
        const { code: _code, ...rest } = input;
        return this.update(cur.id, rest, expected);
      },
    });
  }

  async changeStatus(id: string, event: CustomerEvent, reason?: string, expected?: number) {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    let updated!: Customer;
    await this.state.transition(tx, {
      docType: 'customer',
      docId: id,
      table: CUSTOMER_TRANSITIONS,
      from: current.status,
      event,
      note: reason ?? null,
      eventType: event === 'deactivate' ? 'customer.deactivated' : 'customer.reactivated',
      apply: async (to) => {
        updated = await this.bumpVersion(current, { status: to });
        await this.audit.changed(
          event === 'deactivate' ? 'customer.deactivated' : 'customer.reactivated',
          'customer',
          id,
          auditView(current),
          auditView(updated),
          reason,
        );
        return toCustomerDto(updated) as unknown as Record<string, unknown>;
      },
    });
    return updated;
  }

  /** MD-004: ลบได้เฉพาะลูกค้าที่ไม่เคยถูกอ้างอิง → soft delete; ถูกอ้างอิง → 409 `in_use` (ให้ปิดใช้แทน) */
  async remove(id: string, reason: string, expected?: number): Promise<void> {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    await lockForRemoval(tx, 'customer', id); // กันสร้างสถานที่/สินค้าที่อ้างลูกค้าระหว่างลบ (lockReferenced)
    await assertNotReferenced([
      { name: 'salesOrders', count: () => tx.salesOrder.count({ where: { customerId: id } }) },
      {
        name: 'deliveryOrders',
        count: () => tx.deliveryOrder.count({ where: { customerId: id } }),
      },
      { name: 'rateCards', count: () => tx.rateCard.count({ where: { customerId: id } }) },
      {
        name: 'sites',
        count: () => tx.customerSite.count({ where: { customerId: id, deletedAt: null } }),
      },
      // ST2-T10: สินค้าของลูกค้ารายนี้ (ไม่นับที่ลบ)
      {
        name: 'products',
        count: () => tx.product.count({ where: { customerId: id, deletedAt: null } }),
      },
    ]);
    // ปล่อย externalId ให้ระบบต้นทางส่งรายการใหม่ได้ — เก็บค่าเดิมไว้ใน deleted_external_id (ตรวจย้อนได้)
    await this.bumpVersion(current, {
      deletedAt: new Date(),
      externalId: null,
      deletedExternalId: current.externalId,
    });
    await this.audit.record({
      action: 'customer.deleted',
      entityType: 'customer',
      entityId: id,
      before: auditView(current),
      reason,
    });
    await emitMasterEvent(tx, 'customer.deleted', 'customer', id, toCustomerDto(current));
  }

  /** optimistic lock: update เฉพาะเมื่อ version ยังเท่าเดิม ไม่งั้น 412 */
  private async bumpVersion(
    current: Customer,
    data: Prisma.CustomerUncheckedUpdateInput,
  ): Promise<Customer> {
    const tx = this.db.tx;
    const r = await tx.customer.updateMany({
      where: { id: current.id, version: current.version, deletedAt: null },
      data: { ...data, version: { increment: 1 } },
    });
    if (r.count !== 1) throw new ProblemException('precondition_failed');
    return (await tx.customer.findUnique({ where: { id: current.id } }))!;
  }
}
