import { Injectable } from '@nestjs/common';
import { Prisma, type ActiveStatus, type Product, type Unit } from '@prisma/client';
import type { TransitionTable } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { StateService } from '../../state/state.service';
import { EXPORT_MAX_ROWS } from '../master/export';
import {
  deletedFilter,
  emitMasterEvent,
  iEquals,
  isNoopUpdate,
  likeEscape,
  lockKey,
  lockReferenced,
  masterKeyset,
  nextCode,
  stableStringify,
  statusFilter,
  upsertByExternalId,
} from '../master/master-kit';
import type {
  AltUnitInputDto,
  CreateProductDto,
  ProductDto,
  ProductListQuery,
  ProductRequiredCapability,
  ProductSummaryDto,
  ProductUnitRefDto,
  UpdateProductDto,
  UpsertProductDto,
} from './product.dto';
import type { UnitKind } from './unit.dto';

export const PRODUCT_CODE_PREFIX = 'P';
const ENTITY = 'product';
const DECIMAL_FIELDS = ['weightPerUnitKg', 'volumePerUnitCbm', 'tempMinC', 'tempMaxC'] as const;
type ProductEvent = 'activate' | 'deactivate';
export const PRODUCT_TRANSITIONS: TransitionTable<ActiveStatus, ProductEvent> = {
  ACTIVE: { deactivate: 'INACTIVE' },
  INACTIVE: { activate: 'ACTIVE' },
};

const UNIT_SELECT = { id: true, code: true, nameTh: true, kind: true, status: true } as const;
const INCLUDE = {
  customer: { select: { id: true, code: true, legalName: true } },
  baseUnit: { select: UNIT_SELECT },
  altUnits: { include: { unit: { select: UNIT_SELECT } }, orderBy: { createdAt: 'asc' } },
} as const;
type UnitRef = Pick<Unit, 'id' | 'code' | 'nameTh' | 'kind' | 'status'>;
export type ProductFull = Product & {
  customer: { id: string; code: string; legalName: string } | null;
  baseUnit: UnitRef;
  altUnits: { unitId: string; factorToBase: Prisma.Decimal; unit: UnitRef }[];
};

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);
const num = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));

const unitRef = (u: UnitRef): ProductUnitRefDto => ({
  id: encodeId('unit', u.id),
  code: u.code,
  name: u.nameTh,
  kind: u.kind as UnitKind,
  status: u.status.toLowerCase() as ProductUnitRefDto['status'],
});

/**
 * ป้ายความสามารถของประเภทรถที่สินค้าต้องการ — ใช้ชื่อเดียวกับ `vehicle_type.capability_tags` (ST2-T04)
 * ST2-T16 (compatibility) เทียบ: REFRIGERATED + ช่วงอุณหภูมิรถครอบคลุม (MD-072), HAZMAT (MD-071)
 */
export function requiredCapabilities(
  p: Pick<Product, 'tempControlled' | 'hazardous'>,
): ProductRequiredCapability[] {
  const out: ProductRequiredCapability[] = [];
  if (p.tempControlled) out.push('REFRIGERATED');
  if (p.hazardous) out.push('HAZMAT');
  return out;
}

export function toProductDto(p: ProductFull): ProductDto {
  return {
    id: encodeId('product', p.id),
    code: p.code,
    externalId: p.externalId,
    name: p.nameTh,
    customer: p.customer
      ? {
          id: encodeId('customer', p.customer.id),
          code: p.customer.code,
          name: p.customer.legalName,
        }
      : null,
    unit: unitRef(p.baseUnit),
    weightPerUnitKg: num(p.weightPerUnitKg),
    volumePerUnitCbm: num(p.volumePerUnitCbm),
    altUnits: p.altUnits.map((a) => ({
      unit: unitRef(a.unit),
      factorToBase: Number(a.factorToBase),
    })),
    fragile: p.fragile,
    hazardous: p.hazardous,
    unNumber: p.unNumber,
    hazardClass: p.hazardClass,
    tempControlled: p.tempControlled,
    tempMinC: num(p.tempMinC),
    tempMaxC: num(p.tempMaxC),
    stackable: p.stackable,
    barcode: p.barcode,
    requiredCapabilities: requiredCapabilities(p),
    status: p.status.toLowerCase() as ProductDto['status'],
    ...(p.deletedAt ? { deletedAt: p.deletedAt.toISOString() } : {}),
    version: p.version,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** snapshot สำหรับ audit — ลูกค้า/หน่วยเป็น id+รหัส (ชื่อของ master อื่นเปลี่ยนได้ ไม่นับเป็น diff ของสินค้า) */
export function productAuditView(p: ProductFull): Record<string, unknown> {
  const {
    updatedAt: _u,
    version: _v,
    customer,
    unit,
    altUnits,
    requiredCapabilities: _r,
    ...rest
  } = toProductDto(p);
  return {
    ...rest,
    customerId: customer?.id ?? null,
    unitId: unit.id,
    altUnits: altUnits.map((a) => `${a.unit.code}=${a.factorToBase}`),
  };
}

/** หน่วยแปลงในรูปเทียบได้ (เรียงตาม unitId) — ใช้ตัดสิน no-op */
const altKey = (rows: { unitId: string; factorToBase: Prisma.Decimal | number }[]) =>
  stableStringify(
    [...rows]
      .sort((a, b) => a.unitId.localeCompare(b.unitId))
      .map((r) => [r.unitId, new Prisma.Decimal(r.factorToBase).toFixed(6)]),
  );

/**
 * สินค้า (ST2-T10; docs/04 B สินค้า/หน่วย, spec/02 §3) — ใช้ master kit ของ ST2-T01
 * - หน่วยหลักอ้าง master หน่วย (`unit`): หน่วยนับ (COUNT) ต้องมีน้ำหนักต่อหน่วย; หน่วยน้ำหนัก/ปริมาตร = ตัวแปลงของหน่วย (ระบบใส่ให้)
 * - อันตราย ↔ เลข UN + class · ควบคุมอุณหภูมิ ↔ ช่วง −40…+30 °C (min < max) — เอาออก = ล้างค่าให้เอง
 * - ลูกค้า (ไม่บังคับ) = สินค้าของลูกค้ารายเดียว; ลูกค้า/หน่วยที่อ้างใหม่ต้องใช้งานอยู่ (ล็อก FOR SHARE กันถูกลบระหว่างบันทึก)
 * - ยังไม่มีเอกสารอ้าง product_id (SO/DO ใน ST3 เก็บ snapshot — MD-005) → ลบได้เสมอ (soft delete)
 */
@Injectable()
export class ProductsService {
  constructor(
    private readonly db: DbService,
    private readonly state: StateService,
    private readonly audit: AuditService,
  ) {}

  // ---------- read ----------

  private where(q: ProductListQuery): Prisma.ProductWhereInput {
    const and: Prisma.ProductWhereInput[] = [deletedFilter(q)];
    const status = statusFilter(q.status);
    if (status) and.push({ status });
    if (q.externalId) and.push({ externalId: q.externalId });
    if (q.unitId) and.push({ baseUnitId: tryDecodeId('unit', q.unitId)! });
    if (q.customerId)
      and.push({
        customerId: q.customerId === 'none' ? null : tryDecodeId('customer', q.customerId)!,
      });
    const anySpecial: Prisma.ProductWhereInput = {
      OR: [{ fragile: true }, { hazardous: true }, { tempControlled: true }],
    };
    if (q.special === 'none') and.push({ fragile: false, hazardous: false, tempControlled: false });
    else if (q.special === 'any') and.push(anySpecial);
    else if (q.special === 'fragile') and.push({ fragile: true });
    else if (q.special === 'hazardous') and.push({ hazardous: true });
    else if (q.special === 'temp') and.push({ tempControlled: true });
    const like = (v: string) => ({ contains: likeEscape(v), mode: 'insensitive' as const });
    if (q.name) and.push({ OR: [{ nameTh: like(q.name) }, { code: like(q.name) }] });
    if (q.q)
      and.push({
        OR: [
          { code: like(q.q) },
          { nameTh: like(q.q) },
          { externalId: like(q.q) },
          { barcode: like(q.q) },
        ],
      });
    return { AND: and };
  }

  async list(q: ProductListQuery) {
    const k = masterKeyset(q);
    const rows = await this.db.tx.product.findMany({
      where: { AND: [this.where(q), k.where] },
      orderBy: k.orderBy,
      take: k.take,
      include: INCLUDE,
    });
    return k.page(rows as ProductFull[], toProductDto);
  }

  async exportRows(q: ProductListQuery & { ids?: string }) {
    const ids = q.ids?.split(',').map((x) => tryDecodeId('product', x)!);
    const where = ids ? { AND: [this.where(q), { id: { in: ids } }] } : this.where(q);
    const rows = await this.db.tx.product.findMany({
      where,
      orderBy: [{ code: 'asc' }],
      take: EXPORT_MAX_ROWS + 1,
      include: INCLUDE,
    });
    if (rows.length > EXPORT_MAX_ROWS)
      throw field422(
        'query',
        'too_many_rows',
        `export is limited to ${EXPORT_MAX_ROWS} rows — narrow the filter`,
      );
    return (rows as ProductFull[]).map(toProductDto);
  }

  async summary(): Promise<ProductSummaryDto> {
    const tx = this.db.tx;
    const g = await tx.product.groupBy({
      by: ['status'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    const n = (s: ActiveStatus) => g.find((x) => x.status === s)?._count._all ?? 0;
    const [special, units] = await Promise.all([
      tx.product.count({
        where: {
          deletedAt: null,
          OR: [{ fragile: true }, { hazardous: true }, { tempControlled: true }],
        },
      }),
      tx.product.groupBy({ by: ['baseUnitId'], where: { deletedAt: null } }),
    ]);
    const total = n('ACTIVE') + n('INACTIVE');
    return {
      total,
      active: n('ACTIVE'),
      inactive: n('INACTIVE'),
      general: total - special,
      special,
      unitsUsed: units.length,
    };
  }

  async nextCode(): Promise<string> {
    return nextCode(this.db.tx, 'product', PRODUCT_CODE_PREFIX);
  }

  async get(id: string): Promise<ProductFull> {
    const p = await this.db.tx.product.findFirst({
      where: { id, deletedAt: null },
      include: INCLUDE,
    });
    if (!p) throw new ProblemException('not_found');
    return p as ProductFull;
  }

  async getByExternalId(externalId: string): Promise<ProductFull> {
    const p = await this.db.tx.product.findFirst({
      where: { externalId, deletedAt: null },
      include: INCLUDE,
    });
    if (!p) throw new ProblemException('not_found');
    return p as ProductFull;
  }

  // ---------- write ----------

  /** `unt_…` หรือ `code:BAG` → แถวหน่วย (ยังไม่ล็อก) · ไม่พบ/ลบแล้ว → 422 `reference_not_found` */
  private async findUnit(ref: string, field: string): Promise<Unit> {
    const tx = this.db.tx;
    const u = ref.startsWith('code:')
      ? await tx.unit.findFirst({ where: { code: iEquals(ref.slice(5)), deletedAt: null } })
      : await tx.unit.findFirst({
          where: { id: tryDecodeId('unit', ref) ?? undefined, deletedAt: null },
        });
    if (!u) throw field422(field, 'reference_not_found', 'unit not found');
    return u;
  }

  /**
   * ล็อก (FOR SHARE) หน่วย/ลูกค้าที่จะอ้างใหม่ — กันถูกลบระหว่างบันทึก แล้วตรวจว่ายังใช้งานอยู่
   * ลำดับล็อกทั้งระบบ: ext → แถวที่อ้าง (ลูกค้า → หน่วย) → code
   */
  private async lockRefs(
    customer: string | null | undefined,
    units: { id: string; field: string }[],
  ): Promise<void> {
    const tx = this.db.tx;
    if (customer) {
      const [c] = await lockReferenced(tx, 'customer', [customer]);
      if (!c) throw field422('customerId', 'reference_not_found', 'customer not found');
      if (c.status !== 'ACTIVE')
        throw field422('customerId', 'customer_inactive', 'customer is inactive');
    }
    if (!units.length) return;
    const rows = await lockReferenced(
      tx,
      'unit',
      units.map((u) => u.id),
    );
    for (const u of units) {
      const r = rows.find((x) => x.id === u.id);
      if (!r) throw field422(u.field, 'reference_not_found', 'unit not found');
      if (r.status !== 'ACTIVE') throw field422(u.field, 'unit_inactive', 'unit is inactive');
    }
  }

  /**
   * รวมค่าที่ส่งมากับค่าเดิม → คอลัมน์ + กฎ spec/02 §3 + หน่วยแปลงชุดใหม่ (undefined = ไม่เปลี่ยน)
   * ค่าที่ต้องล็อกคืนใน `lock` (เฉพาะที่อ้างใหม่ — ค่าเดิมที่ปิดใช้ไปแล้วคงไว้ได้)
   */
  private async build(input: UpdateProductDto | CreateProductDto, current?: ProductFull) {
    const data: Prisma.ProductUncheckedUpdateInput = {};
    const lockUnits: { id: string; field: string }[] = [];
    let lockCustomer: string | null | undefined;
    if (input.name !== undefined) data.nameTh = input.name;
    if (input.code !== undefined && 'code' in input && current) data.code = input.code;

    // ---- ลูกค้า ----
    if (input.customerId !== undefined) {
      const cid = input.customerId === null ? null : tryDecodeId('customer', input.customerId);
      if (input.customerId !== null && !cid)
        throw field422('customerId', 'reference_not_found', 'customer not found');
      if (cid !== (current?.customerId ?? null)) lockCustomer = cid;
      data.customerId = cid;
    }

    // ---- หน่วยหลัก ----
    let base: Pick<Unit, 'id' | 'kind' | 'toKg' | 'toCbm'>;
    if (input.unitId !== undefined) {
      const u = await this.findUnit(input.unitId, 'unitId');
      if (u.id !== current?.baseUnitId) lockUnits.push({ id: u.id, field: 'unitId' });
      data.baseUnitId = u.id;
      base = u;
    } else {
      base = (await this.db.tx.unit.findUniqueOrThrow({ where: { id: current!.baseUnitId } }))!;
    }

    // ---- น้ำหนัก/ปริมาตรต่อหน่วย (MD-070 ใช้คำนวณ) ----
    const pick = <T>(v: T | undefined, cur: T | null | undefined) =>
      v !== undefined ? v : (cur ?? null);
    let weight = pick(input.weightPerUnitKg, num(current?.weightPerUnitKg ?? null));
    let volume = pick(input.volumePerUnitCbm, num(current?.volumePerUnitCbm ?? null));
    const unitChanged = data.baseUnitId !== undefined && data.baseUnitId !== current?.baseUnitId;
    if (base.kind === 'WEIGHT') {
      const fixed = new Prisma.Decimal(base.toKg!).toDecimalPlaces(3).toNumber();
      if (input.weightPerUnitKg != null && input.weightPerUnitKg !== fixed)
        throw field422(
          'weightPerUnitKg',
          'fixed_by_unit',
          `weight is fixed by the unit (${fixed} kg)`,
        );
      weight = fixed;
    } else if (base.kind === 'VOLUME') {
      const fixed = new Prisma.Decimal(base.toCbm!).toDecimalPlaces(4).toNumber();
      if (input.volumePerUnitCbm != null && input.volumePerUnitCbm !== fixed)
        throw field422(
          'volumePerUnitCbm',
          'fixed_by_unit',
          `volume is fixed by the unit (${fixed} cbm)`,
        );
      volume = fixed;
    }
    if (base.kind === 'COUNT' && (weight === null || weight === undefined))
      throw field422('weightPerUnitKg', 'required', 'weightPerUnitKg is required for COUNT units');
    if (weight !== null && !(weight > 0))
      throw field422('weightPerUnitKg', 'min', 'weightPerUnitKg must be > 0');
    if (input.weightPerUnitKg !== undefined || unitChanged || !current)
      data.weightPerUnitKg = weight;
    if (input.volumePerUnitCbm !== undefined || unitChanged || !current)
      data.volumePerUnitCbm = volume;

    // ---- อันตราย ----
    const hazardous = input.hazardous ?? current?.hazardous ?? false;
    let un = pick(input.unNumber, current?.unNumber);
    let cls = pick(input.hazardClass, current?.hazardClass);
    if (!hazardous) {
      if (input.unNumber != null)
        throw field422('unNumber', 'not_hazardous', 'unNumber applies to hazardous products only');
      if (input.hazardClass != null)
        throw field422(
          'hazardClass',
          'not_hazardous',
          'hazardClass applies to hazardous products only',
        );
      un = null;
      cls = null;
    } else {
      if (!un) throw field422('unNumber', 'required', 'hazardous product requires unNumber');
      if (!cls) throw field422('hazardClass', 'required', 'hazardous product requires hazardClass');
    }
    if (input.hazardous !== undefined) data.hazardous = hazardous;
    if (
      input.hazardous !== undefined ||
      input.unNumber !== undefined ||
      input.hazardClass !== undefined ||
      !current
    ) {
      data.unNumber = un;
      data.hazardClass = cls;
    }

    // ---- ควบคุมอุณหภูมิ (MD-072 เทียบช่วงรถห้องเย็น) ----
    const temp = input.tempControlled ?? current?.tempControlled ?? false;
    let tmin = pick(input.tempMinC, num(current?.tempMinC ?? null));
    let tmax = pick(input.tempMaxC, num(current?.tempMaxC ?? null));
    if (!temp) {
      if (input.tempMinC != null || input.tempMaxC != null)
        throw field422(
          'tempMinC',
          'not_temp_controlled',
          'temperature applies to temperature-controlled products only',
        );
      tmin = null;
      tmax = null;
    } else {
      if (tmin === null) throw field422('tempMinC', 'required', 'tempControlled requires tempMinC');
      if (tmax === null) throw field422('tempMaxC', 'required', 'tempControlled requires tempMaxC');
      if (tmin >= tmax) throw field422('tempMaxC', 'temp_range', 'tempMinC must be < tempMaxC');
    }
    if (input.tempControlled !== undefined) data.tempControlled = temp;
    if (
      input.tempControlled !== undefined ||
      input.tempMinC !== undefined ||
      input.tempMaxC !== undefined ||
      !current
    ) {
      data.tempMinC = tmin;
      data.tempMaxC = tmax;
    }

    if (input.fragile !== undefined) data.fragile = input.fragile;
    if (input.stackable !== undefined) data.stackable = input.stackable;
    if (input.barcode !== undefined) data.barcode = input.barcode === '' ? null : input.barcode;

    // ---- หน่วยแปลง ----
    const baseId = (data.baseUnitId as string | undefined) ?? current!.baseUnitId;
    let alt: { unitId: string; factorToBase: number }[] | undefined;
    if (input.altUnits !== undefined) {
      alt = [];
      const currentAlt = new Set(current?.altUnits.map((a) => a.unitId) ?? []);
      for (const [i, a] of (input.altUnits as AltUnitInputDto[]).entries()) {
        const field = `altUnits.${i}.unitId`;
        const u = await this.findUnit(a.unitId, field);
        if (u.id === baseId)
          throw field422(field, 'same_as_base', 'alternative unit equals the base unit');
        if (alt.some((x) => x.unitId === u.id))
          throw field422(field, 'duplicate', 'duplicate alternative unit');
        if (!currentAlt.has(u.id)) lockUnits.push({ id: u.id, field });
        alt.push({ unitId: u.id, factorToBase: a.factorToBase });
      }
    } else if (current && current.altUnits.some((a) => a.unitId === baseId))
      throw field422(
        'unitId',
        'same_as_base',
        'base unit is already an alternative unit — update altUnits too',
      );
    return { data, alt, lockCustomer, lockUnits };
  }

  private async assertUniqueExternal(externalId: string, exceptId?: string) {
    const dup = await this.db.tx.product.findFirst({
      where: { externalId, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (dup)
      throw new ProblemException('duplicate', undefined, [
        { field: 'externalId', code: 'duplicate', message: 'externalId already used' },
      ]);
  }

  /** รหัสห้ามซ้ำ (ต้นแบบ cfProd "รหัสนี้มีแล้ว"; รวมที่ลบแล้ว — unique ครอบทุกแถว) */
  private async assertUniqueCode(code: string, exceptId?: string) {
    const taken = await this.db.tx.product.findFirst({
      where: { code: iEquals(code), ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true, code: true, nameTh: true, deletedAt: true },
    });
    if (taken)
      throw new ProblemException(
        'duplicate',
        undefined,
        [{ field: 'code', code: 'duplicate', message: 'code already exists' }],
        taken.deletedAt
          ? undefined
          : {
              existing: { id: encodeId('product', taken.id), code: taken.code, name: taken.nameTh },
            },
      );
  }

  private async writeAlt(productId: string, alt: { unitId: string; factorToBase: number }[]) {
    const tx = this.db.tx;
    await tx.productAltUnit.deleteMany({ where: { productId } });
    if (alt.length)
      await tx.productAltUnit.createMany({
        data: alt.map((a) => ({
          productId,
          unitId: a.unitId,
          factorToBase: new Prisma.Decimal(a.factorToBase),
        })) as Prisma.ProductAltUnitCreateManyInput[], // tenantId เติมโดย tenantExtension
      });
  }

  async create(input: CreateProductDto | (UpsertProductDto & { externalId: string })) {
    const tx = this.db.tx;
    const { data, alt, lockCustomer, lockUnits } = await this.build(input);
    if (input.externalId) {
      // POST ที่มี externalId ใช้ lock เดียวกับ PUT external (กันสร้างซ้ำพร้อมกัน)
      await lockKey(tx, `${ENTITY}.ext:${input.externalId}`);
      await this.assertUniqueExternal(input.externalId);
    }
    await this.lockRefs(lockCustomer, lockUnits);
    await lockKey(tx, `${ENTITY}.code`);
    let code = input.code;
    if (code) await this.assertUniqueCode(code);
    else code = await nextCode(tx, 'product', PRODUCT_CODE_PREFIX);
    const row = await tx.product.create({
      data: {
        ...(data as object),
        code,
        externalId: input.externalId ?? null,
      } as Prisma.ProductUncheckedCreateInput, // tenantId เติมโดย tenantExtension
    });
    if (alt?.length) await this.writeAlt(row.id, alt);
    const p = await this.get(row.id);
    await this.audit.record({
      action: `${ENTITY}.created`,
      entityType: ENTITY,
      entityId: p.id,
      after: productAuditView(p),
    });
    await emitMasterEvent(tx, `${ENTITY}.created`, ENTITY, p.id, toProductDto(p));
    return p;
  }

  async update(id: string, input: UpdateProductDto, expected?: number): Promise<ProductFull> {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    const { data, alt, lockCustomer, lockUnits } = await this.build(input, current);
    if (input.externalId !== undefined) {
      if (input.externalId) {
        await lockKey(tx, `${ENTITY}.ext:${input.externalId}`);
        await this.assertUniqueExternal(input.externalId, current.id);
      }
      data.externalId = input.externalId;
    }
    const altSame = alt === undefined || altKey(alt) === altKey(current.altUnits);
    if (isNoopUpdate(current, data as Record<string, unknown>, DECIMAL_FIELDS) && altSame)
      return current; // ส่งซ้ำค่าเดิมไม่เพิ่ม version
    await this.lockRefs(lockCustomer, lockUnits);
    if (data.code !== undefined && String(data.code) !== current.code) {
      await lockKey(tx, `${ENTITY}.code`);
      await this.assertUniqueCode(String(data.code), current.id);
    }
    await this.bumpVersion(current, data);
    if (!altSame) await this.writeAlt(current.id, alt!);
    const p = await this.get(current.id);
    const before = productAuditView(current);
    const after = productAuditView(p);
    await this.audit.changed(`${ENTITY}.updated`, ENTITY, p.id, before, after);
    const changed = Object.keys(after).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    // spec/02 §3.7: product.updated (webhook P2) — SO เดิมไม่เปลี่ยน (snapshot)
    if (changed.length)
      await emitMasterEvent(tx, `${ENTITY}.updated`, ENTITY, p.id, toProductDto(p), {
        changedFields: changed,
      });
    return p;
  }

  /** PUT /products/external/{externalId} — idempotent (ส่งซ้ำ = อัปเดตแถวเดิม) */
  async upsertExternal(externalId: string, input: UpsertProductDto, expected?: number) {
    const tx = this.db.tx;
    return upsertByExternalId(tx, ENTITY, externalId, {
      find: () =>
        tx.product.findFirst({
          where: { externalId, deletedAt: null },
          include: INCLUDE,
        }) as Promise<ProductFull | null>,
      create: () => this.create({ ...input, externalId }),
      update: (cur) => {
        const { code: _code, ...rest } = input;
        return this.update(cur.id, rest, expected);
      },
    });
  }

  async changeStatus(id: string, event: ProductEvent, reason?: string, expected?: number) {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    // เปิดใช้อีกครั้ง: หน่วยหลักต้องยังใช้งานอยู่ (สินค้าที่ใช้งานต้องเลือกใช้ใน SO ได้ทั้งชุด)
    if (event === 'activate')
      await this.lockRefs(undefined, [{ id: current.baseUnitId, field: 'unitId' }]);
    let updated!: ProductFull;
    await this.state.transition(tx, {
      docType: ENTITY,
      docId: id,
      table: PRODUCT_TRANSITIONS,
      from: current.status,
      event,
      note: reason ?? null,
      eventType: event === 'deactivate' ? `${ENTITY}.deactivated` : `${ENTITY}.reactivated`,
      apply: async (to) => {
        updated = await this.bumpVersion(current, { status: to });
        await this.audit.changed(
          event === 'deactivate' ? `${ENTITY}.deactivated` : `${ENTITY}.reactivated`,
          ENTITY,
          id,
          productAuditView(current),
          productAuditView(updated),
          reason,
        );
        return toProductDto(updated) as unknown as Record<string, unknown>;
      },
    });
    return updated;
  }

  /** "ลบ" (MD-004) → soft delete — ยังไม่มีเอกสารอ้าง product_id (SO/DO ST3 เก็บ snapshot) */
  async remove(id: string, reason: string, expected?: number): Promise<void> {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    await this.bumpVersion(current, {
      deletedAt: new Date(),
      externalId: null,
      deletedExternalId: current.externalId,
    });
    await this.audit.record({
      action: `${ENTITY}.deleted`,
      entityType: ENTITY,
      entityId: id,
      before: productAuditView(current),
      reason,
    });
    await emitMasterEvent(tx, `${ENTITY}.deleted`, ENTITY, id, toProductDto(current));
  }

  /** optimistic lock: update เฉพาะเมื่อ version ยังเท่าเดิม ไม่งั้น 412 */
  private async bumpVersion(
    current: Product,
    data: Prisma.ProductUncheckedUpdateInput,
  ): Promise<ProductFull> {
    const tx = this.db.tx;
    const r = await tx.product.updateMany({
      where: { id: current.id, version: current.version, deletedAt: null },
      data: { ...data, version: { increment: 1 } },
    });
    if (r.count !== 1) throw new ProblemException('precondition_failed');
    return (await tx.product.findUnique({
      where: { id: current.id },
      include: INCLUDE,
    })) as ProductFull;
  }
}
