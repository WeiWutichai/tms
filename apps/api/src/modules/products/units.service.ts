import { Injectable } from '@nestjs/common';
import { Prisma, type ActiveStatus, type Unit } from '@prisma/client';
import type { TransitionTable } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { DbService, type Tx } from '../../db/db.service';
import { StateService } from '../../state/state.service';
import {
  assertNotReferenced,
  deletedFilter,
  emitMasterEvent,
  iEquals,
  isNoopUpdate,
  likeEscape,
  lockForRemoval,
  lockKey,
  masterKeyset,
  statusFilter,
} from '../master/master-kit';
import type { CreateUnitDto, UnitDto, UnitKind, UnitListQuery, UpdateUnitDto } from './unit.dto';

const ENTITY = 'unit';
const DECIMAL_FIELDS = ['toKg', 'toCbm'] as const;
type UnitEvent = 'activate' | 'deactivate';
export const UNIT_TRANSITIONS: TransitionTable<ActiveStatus, UnitEvent> = {
  ACTIVE: { deactivate: 'INACTIVE' },
  INACTIVE: { activate: 'ACTIVE' },
};

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);
const num = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));

export function toUnitDto(u: Unit, products = 0): UnitDto {
  return {
    id: encodeId('unit', u.id),
    code: u.code,
    name: u.nameTh,
    kind: u.kind as UnitKind,
    toKg: num(u.toKg),
    toCbm: num(u.toCbm),
    system: u.systemKey !== null,
    products,
    status: u.status.toLowerCase() as UnitDto['status'],
    ...(u.deletedAt ? { deletedAt: u.deletedAt.toISOString() } : {}),
    version: u.version,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}

/** snapshot สำหรับ audit — ไม่มี updatedAt/version/products */
export function unitAuditView(u: Unit): Record<string, unknown> {
  const { updatedAt: _u, version: _v, products: _p, ...rest } = toUnitDto(u);
  return rest;
}

/** จำนวนสินค้า (ไม่นับที่ลบ) ที่ใช้หน่วยเป็นหน่วยหลักหรือหน่วยแปลง */
export async function unitUsage(tx: Tx, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>(ids.map((id) => [id, 0]));
  if (!ids.length) return out;
  const [base, alt] = await Promise.all([
    tx.product.groupBy({
      by: ['baseUnitId'],
      where: { baseUnitId: { in: ids }, deletedAt: null },
      _count: { _all: true },
    }),
    tx.productAltUnit.groupBy({
      by: ['unitId'],
      where: { unitId: { in: ids }, product: { deletedAt: null } },
      _count: { _all: true },
    }),
  ]);
  for (const g of base) out.set(g.baseUnitId, (out.get(g.baseUnitId) ?? 0) + g._count._all);
  for (const g of alt) out.set(g.unitId, (out.get(g.unitId) ?? 0) + g._count._all);
  return out;
}

/**
 * หน่วยนับ (ST2-T10; spec/02 §3 Unit) — master ต่อ tenant ใช้เป็นหน่วยหลัก/หน่วยแปลงของสินค้า
 * - ชนิด COUNT/WEIGHT/VOLUME: WEIGHT ต้องมี `toKg`, VOLUME ต้องมี `toCbm`, COUNT ไม่มีตัวแปลง
 * - หน่วยมาตรฐานของระบบ (`system_key` — ชุดเริ่มต้นของ tenant) ลบไม่ได้ แก้ได้เฉพาะชื่อ ปิดใช้ได้ (spec/02 §3)
 * - หน่วยที่สินค้าใช้อยู่: เปลี่ยนรหัส/ชนิด/ตัวแปลงไม่ได้ (น้ำหนักที่คำนวณไว้จะผิด) · ลบไม่ได้ → ปิดใช้แทน (spec/02 §3 กรณีผิดปกติ)
 */
@Injectable()
export class UnitsService {
  constructor(
    private readonly db: DbService,
    private readonly state: StateService,
    private readonly audit: AuditService,
  ) {}

  private where(q: UnitListQuery): Prisma.UnitWhereInput {
    const and: Prisma.UnitWhereInput[] = [deletedFilter(q)];
    const status = statusFilter(q.status);
    if (status) and.push({ status });
    if (q.kind) and.push({ kind: q.kind });
    const like = (v: string) => ({ contains: likeEscape(v), mode: 'insensitive' as const });
    if (q.q) and.push({ OR: [{ code: like(q.q) }, { nameTh: like(q.q) }] });
    return { AND: and };
  }

  async list(q: UnitListQuery) {
    const k = masterKeyset(q);
    const rows = await this.db.tx.unit.findMany({
      where: { AND: [this.where(q), k.where] },
      orderBy: k.orderBy,
      take: k.take,
    });
    const u = await unitUsage(
      this.db.tx,
      rows.slice(0, q.limit ?? 50).map((r) => r.id),
    );
    return k.page(rows, (r) => toUnitDto(r, u.get(r.id)));
  }

  async get(id: string): Promise<Unit> {
    const u = await this.db.tx.unit.findFirst({ where: { id, deletedAt: null } });
    if (!u) throw new ProblemException('not_found');
    return u;
  }

  async dto(u: Unit): Promise<UnitDto> {
    return toUnitDto(u, (await unitUsage(this.db.tx, [u.id])).get(u.id));
  }

  /** ตรวจชนิด ↔ ตัวแปลง (spec/02 §3: weight → toKg บังคับ, volume → toCbm) */
  private factors(kind: string, toKg: number | null, toCbm: number | null) {
    if (kind === 'WEIGHT') {
      if (toKg === null) throw field422('toKg', 'required', 'WEIGHT unit requires toKg');
      if (toCbm !== null) throw field422('toCbm', 'not_volume', 'toCbm applies to VOLUME only');
    } else if (kind === 'VOLUME') {
      if (toCbm === null) throw field422('toCbm', 'required', 'VOLUME unit requires toCbm');
      if (toKg !== null) throw field422('toKg', 'not_weight', 'toKg applies to WEIGHT only');
    } else {
      if (toKg !== null) throw field422('toKg', 'not_weight', 'toKg applies to WEIGHT only');
      if (toCbm !== null) throw field422('toCbm', 'not_volume', 'toCbm applies to VOLUME only');
    }
    return { toKg, toCbm };
  }

  private async assertUniqueName(name: string, exceptId?: string) {
    await lockKey(this.db.tx, `unit.name:${name.toLowerCase()}`);
    const dup = await this.db.tx.unit.findFirst({
      where: {
        nameTh: iEquals(name),
        deletedAt: null,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true, code: true, nameTh: true },
    });
    if (dup)
      throw new ProblemException(
        'duplicate',
        undefined,
        [{ field: 'name', code: 'duplicate', message: `unit already exists: ${dup.code}` }],
        { existing: { id: encodeId('unit', dup.id), code: dup.code, name: dup.nameTh } },
      );
  }

  private async assertUniqueCode(code: string, exceptId?: string) {
    await lockKey(this.db.tx, 'unit.code');
    const taken = await this.db.tx.unit.findFirst({
      where: { code: iEquals(code), ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (taken)
      throw new ProblemException('duplicate', undefined, [
        { field: 'code', code: 'duplicate', message: 'code already exists' },
      ]);
  }

  async create(input: CreateUnitDto): Promise<Unit> {
    const tx = this.db.tx;
    const f = this.factors(input.kind, input.toKg ?? null, input.toCbm ?? null);
    await this.assertUniqueName(input.name);
    await this.assertUniqueCode(input.code);
    const u = await tx.unit.create({
      data: {
        code: input.code,
        nameTh: input.name,
        kind: input.kind,
        toKg: f.toKg,
        toCbm: f.toCbm,
      } as Prisma.UnitUncheckedCreateInput, // tenantId เติมโดย tenantExtension
    });
    await this.audit.record({
      action: `${ENTITY}.created`,
      entityType: ENTITY,
      entityId: u.id,
      after: unitAuditView(u),
    });
    await emitMasterEvent(tx, `${ENTITY}.created`, ENTITY, u.id, toUnitDto(u));
    return u;
  }

  async update(id: string, input: UpdateUnitDto, expected?: number): Promise<Unit> {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    const data: Prisma.UnitUncheckedUpdateInput = {};
    if (input.name !== undefined) data.nameTh = input.name;
    const kind = input.kind ?? current.kind;
    const touchesFactor =
      input.kind !== undefined || input.toKg !== undefined || input.toCbm !== undefined;
    if (touchesFactor) {
      const f = this.factors(
        kind,
        input.toKg !== undefined ? input.toKg : kind === current.kind ? num(current.toKg) : null,
        input.toCbm !== undefined ? input.toCbm : kind === current.kind ? num(current.toCbm) : null,
      );
      data.kind = kind;
      data.toKg = f.toKg;
      data.toCbm = f.toCbm;
    }
    if (input.code !== undefined) data.code = input.code;
    if (isNoopUpdate(current, data as Record<string, unknown>, DECIMAL_FIELDS)) return current;
    // ช่องนิยามที่เปลี่ยนจริง (เรียงตามลำดับฟอร์ม) — error ชี้ช่องแรกที่ต่าง (review ST2-T10 #5)
    const changedDef = (['code', 'kind', 'toKg', 'toCbm'] as const).filter(
      (k) => k in data && !isNoopUpdate(current, { [k]: data[k] }, DECIMAL_FIELDS),
    );
    if (changedDef.length) {
      // หน่วยมาตรฐานของระบบ: รหัส/ชนิด/ตัวแปลงคงที่ (spec/02 §3 ชุดเริ่มต้น)
      if (current.systemKey !== null)
        throw field422(changedDef[0]!, 'system_unit', 'system unit: only the name can be changed');
      // หน่วยที่สินค้าใช้อยู่: เปลี่ยนนิยามแล้วน้ำหนัก/ปริมาตรของสินค้าเดิมจะผิด → 422
      await lockForRemoval(tx, 'unit', current.id);
      const used = (await unitUsage(tx, [current.id])).get(current.id) ?? 0;
      if (used > 0)
        throw field422(changedDef[0]!, 'unit_in_use', `unit is used by ${used} product(s)`);
    }
    if (
      data.nameTh !== undefined &&
      String(data.nameTh).toLowerCase() !== current.nameTh.toLowerCase()
    )
      await this.assertUniqueName(String(data.nameTh), current.id);
    if (data.code !== undefined && data.code !== current.code)
      await this.assertUniqueCode(String(data.code), current.id);
    const u = await this.bumpVersion(current, data);
    const before = unitAuditView(current);
    const after = unitAuditView(u);
    await this.audit.changed(`${ENTITY}.updated`, ENTITY, u.id, before, after);
    const changed = Object.keys(after).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    if (changed.length)
      await emitMasterEvent(tx, `${ENTITY}.updated`, ENTITY, u.id, toUnitDto(u), {
        changedFields: changed,
      });
    return u;
  }

  async changeStatus(id: string, event: UnitEvent, reason?: string, expected?: number) {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    let updated!: Unit;
    await this.state.transition(tx, {
      docType: ENTITY,
      docId: id,
      table: UNIT_TRANSITIONS,
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
          unitAuditView(current),
          unitAuditView(updated),
          reason,
        );
        return toUnitDto(updated) as unknown as Record<string, unknown>;
      },
    });
    return updated;
  }

  /** ลบ: หน่วยของระบบ → 409 `conflict` (ปิดใช้แทน) · มีสินค้าใช้ → 409 `in_use` · ไม่งั้น soft delete */
  async remove(id: string, reason: string, expected?: number): Promise<void> {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    if (current.systemKey !== null)
      throw new ProblemException(
        'conflict',
        'system unit cannot be deleted — deactivate it instead',
        [{ field: 'id', code: 'system_unit', message: 'system unit cannot be deleted' }],
      );
    await lockForRemoval(tx, 'unit', id);
    await assertNotReferenced([
      {
        name: 'products',
        count: async () => (await unitUsage(tx, [id])).get(id) ?? 0,
      },
    ]);
    await this.bumpVersion(current, { deletedAt: new Date() });
    await this.audit.record({
      action: `${ENTITY}.deleted`,
      entityType: ENTITY,
      entityId: id,
      before: unitAuditView(current),
      reason,
    });
    await emitMasterEvent(tx, `${ENTITY}.deleted`, ENTITY, id, toUnitDto(current));
  }

  private async bumpVersion(current: Unit, data: Prisma.UnitUncheckedUpdateInput): Promise<Unit> {
    const tx = this.db.tx;
    const r = await tx.unit.updateMany({
      where: { id: current.id, version: current.version, deletedAt: null },
      data: { ...data, version: { increment: 1 } },
    });
    if (r.count !== 1) throw new ProblemException('precondition_failed');
    return (await tx.unit.findUnique({ where: { id: current.id } }))!;
  }
}
