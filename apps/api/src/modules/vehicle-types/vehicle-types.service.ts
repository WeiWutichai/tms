import { Injectable } from '@nestjs/common';
import { Prisma, type ActiveStatus, type VehicleType } from '@prisma/client';
import type { TransitionTable } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { StateService } from '../../state/state.service';
import { EXPORT_MAX_ROWS } from '../master/export';
import {
  assertNotReferenced,
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
import {
  VEHICLE_CLASS_RANK,
  type CreateVehicleTypeDto,
  type LicenceClass,
  type UpdateVehicleTypeDto,
  type UpsertVehicleTypeDto,
  type VehicleCapability,
  type VehicleClass,
  type VehicleTypeDto,
  type VehicleTypeListQuery,
} from './vehicle-type.dto';
import { iEquals } from '../../common/ilike';

export const VEHICLE_TYPE_CODE_PREFIX = 'VT';
const DECIMAL_FIELDS = ['capacityKg', 'capacityCbm', 'tempMinC', 'tempMaxC'] as const;
type VtEvent = 'activate' | 'deactivate';
export const VEHICLE_TYPE_TRANSITIONS: TransitionTable<ActiveStatus, VtEvent> = {
  ACTIVE: { deactivate: 'INACTIVE' },
  INACTIVE: { activate: 'ACTIVE' },
};

type Usage = { vehicles: number; rateCards: number };
const NO_USAGE: Usage = { vehicles: 0, rateCards: 0 };

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

const num = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));

export function toVehicleTypeDto(v: VehicleType, usage: Usage = NO_USAGE): VehicleTypeDto {
  return {
    id: encodeId('vehicleType', v.id),
    code: v.code,
    externalId: v.externalId,
    name: v.nameTh,
    vehicleClass: v.vehicleClass as VehicleClass,
    sizeRank: VEHICLE_CLASS_RANK[v.vehicleClass as VehicleClass] ?? 0,
    payloadKg: num(v.capacityKg),
    volumeCbm: num(v.capacityCbm),
    minLicenceClass: v.minLicenceClass as LicenceClass | null,
    capabilityTags: v.capabilityTags as VehicleCapability[],
    tempMinC: num(v.tempMinC),
    tempMaxC: num(v.tempMaxC),
    system: v.systemKey !== null,
    usage,
    status: v.status.toLowerCase() as VehicleTypeDto['status'],
    ...(v.deletedAt ? { deletedAt: v.deletedAt.toISOString() } : {}),
    version: v.version,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

/** snapshot สำหรับ audit — ไม่มี updatedAt/version/usage/sizeRank (diff ไม่นับ; sizeRank ตามชั้นรถ) */
function auditView(v: VehicleType): Record<string, unknown> {
  const { updatedAt: _u, version: _v, usage: _x, sizeRank: _r, ...rest } = toVehicleTypeDto(v);
  return rest;
}

/**
 * ประเภทรถ (ST2-T04; spec/02 §4, docs/04 B รถ) — ใช้ master kit ของ ST2-T01
 * ปิดใช้ไม่ได้ถ้ายังมีรถในทะเบียนที่ใช้ประเภทนี้ (MD-094) · ลบได้เฉพาะที่ไม่เคยถูกอ้างอิง (MD-004)
 * แถวค่าเริ่มต้นของระบบ (`system_key`) แก้/ปิดใช้/ลบได้เหมือนแถวอื่น — spec ไม่มีกฎ "รหัสระบบลบไม่ได้" แบบ reason_code
 */
@Injectable()
export class VehicleTypesService {
  constructor(
    private readonly db: DbService,
    private readonly state: StateService,
    private readonly audit: AuditService,
  ) {}

  // ---------- read ----------

  private where(q: VehicleTypeListQuery): Prisma.VehicleTypeWhereInput {
    const and: Prisma.VehicleTypeWhereInput[] = [deletedFilter(q)];
    const status = statusFilter(q.status);
    if (status) and.push({ status });
    if (q.externalId) and.push({ externalId: q.externalId });
    if (q.vehicleClass) and.push({ vehicleClass: q.vehicleClass });
    if (q.minLicenceClass) and.push({ minLicenceClass: q.minLicenceClass });
    if (q.capability) and.push({ capabilityTags: { has: q.capability } });
    const like = (v: string) => ({ contains: likeEscape(v), mode: 'insensitive' as const });
    if (q.name) and.push({ nameTh: like(q.name) });
    if (q.q)
      and.push({
        OR: [{ code: like(q.q) }, { nameTh: like(q.q) }, { externalId: like(q.q) }],
      });
    return { AND: and };
  }

  /** จำนวนรถ (ไม่นับปลดระวาง) และ rate card ที่อ้างแต่ละประเภท */
  private async usage(ids: string[]): Promise<Map<string, Usage>> {
    const out = new Map<string, Usage>();
    if (!ids.length) return out;
    const tx = this.db.tx;
    const [veh, rc] = await Promise.all([
      tx.vehicle.groupBy({
        by: ['vehicleTypeId'],
        where: { vehicleTypeId: { in: ids }, status: { not: 'RETIRED' } },
        _count: { _all: true },
      }),
      tx.rateCard.groupBy({
        by: ['vehicleTypeId'],
        where: { vehicleTypeId: { in: ids } },
        _count: { _all: true },
      }),
    ]);
    for (const id of ids) out.set(id, { vehicles: 0, rateCards: 0 });
    for (const g of veh) out.get(g.vehicleTypeId)!.vehicles = g._count._all;
    for (const g of rc) if (g.vehicleTypeId) out.get(g.vehicleTypeId)!.rateCards = g._count._all;
    return out;
  }

  private async withUsage(rows: VehicleType[]): Promise<VehicleTypeDto[]> {
    const u = await this.usage(rows.map((r) => r.id));
    return rows.map((r) => toVehicleTypeDto(r, u.get(r.id)));
  }

  async list(q: VehicleTypeListQuery) {
    const k = masterKeyset(q);
    const rows = await this.db.tx.vehicleType.findMany({
      where: { AND: [this.where(q), k.where] },
      orderBy: k.orderBy,
      take: k.take,
    });
    const u = await this.usage(rows.slice(0, q.limit ?? 50).map((r) => r.id));
    return k.page(rows, (r) => toVehicleTypeDto(r, u.get(r.id)));
  }

  /** แถวสำหรับส่งออก (ตามตัวกรองเดียวกับ list หรือ id ที่เลือก) — เกินเพดาน → 422 */
  async exportRows(q: VehicleTypeListQuery & { ids?: string }) {
    const ids = q.ids?.split(',').map((x) => tryDecodeId('vehicleType', x)!);
    const where = ids ? { AND: [this.where(q), { id: { in: ids } }] } : this.where(q);
    const rows = await this.db.tx.vehicleType.findMany({
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
    return this.withUsage(rows);
  }

  async summary() {
    const tx = this.db.tx;
    const g = await tx.vehicleType.groupBy({
      by: ['status'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    const n = (s: ActiveStatus) => g.find((x) => x.status === s)?._count._all ?? 0;
    const [vehicles, rateCards] = await Promise.all([
      tx.vehicle.count({ where: { status: { not: 'RETIRED' } } }),
      tx.rateCard.count({ where: { vehicleTypeId: { not: null } } }),
    ]);
    return {
      total: n('ACTIVE') + n('INACTIVE'),
      active: n('ACTIVE'),
      inactive: n('INACTIVE'),
      vehicles,
      rateCards,
    };
  }

  async nextCode(): Promise<string> {
    return nextCode(this.db.tx, 'vehicle_type', VEHICLE_TYPE_CODE_PREFIX);
  }

  async get(id: string): Promise<VehicleType> {
    const v = await this.db.tx.vehicleType.findFirst({ where: { id, deletedAt: null } });
    if (!v) throw new ProblemException('not_found');
    return v;
  }

  async getByExternalId(externalId: string): Promise<VehicleType> {
    const v = await this.db.tx.vehicleType.findFirst({ where: { externalId, deletedAt: null } });
    if (!v) throw new ProblemException('not_found');
    return v;
  }

  async dto(v: VehicleType): Promise<VehicleTypeDto> {
    return (await this.withUsage([v]))[0]!;
  }

  // ---------- write ----------

  /** แปลง DTO → คอลัมน์ + ตรวจอุณหภูมิห้องเย็น (spec/02 §4: บังคับเมื่อ refrigerated, min < max) */
  private toData(
    input: UpdateVehicleTypeDto | CreateVehicleTypeDto,
    current?: VehicleType,
  ): Prisma.VehicleTypeUncheckedUpdateInput {
    const data: Prisma.VehicleTypeUncheckedUpdateInput = {};
    if (input.name !== undefined) data.nameTh = input.name;
    if (input.vehicleClass !== undefined) data.vehicleClass = input.vehicleClass;
    if (input.payloadKg !== undefined) data.capacityKg = input.payloadKg;
    if (input.volumeCbm !== undefined) data.capacityCbm = input.volumeCbm;
    if (input.minLicenceClass !== undefined) data.minLicenceClass = input.minLicenceClass;
    const tags =
      input.capabilityTags !== undefined
        ? [...new Set(input.capabilityTags)]
        : ((current?.capabilityTags ?? []) as VehicleCapability[]);
    if (input.capabilityTags !== undefined) data.capabilityTags = tags;
    const cold = tags.includes('REFRIGERATED');
    let min = input.tempMinC !== undefined ? input.tempMinC : num(current?.tempMinC ?? null);
    let max = input.tempMaxC !== undefined ? input.tempMaxC : num(current?.tempMaxC ?? null);
    if (!cold) {
      // ไม่ใช่ห้องเย็น: ส่งอุณหภูมิมา = 422 · เอาป้ายห้องเย็นออก = ล้างอุณหภูมิเดิมให้เอง
      if (
        (input.tempMinC !== undefined && input.tempMinC !== null) ||
        (input.tempMaxC !== undefined && input.tempMaxC !== null)
      )
        throw field422('tempMinC', 'not_refrigerated', 'temperature applies to REFRIGERATED only');
      min = null;
      max = null;
    } else {
      if (min === null || max === null)
        throw field422(
          min === null ? 'tempMinC' : 'tempMaxC',
          'required',
          'REFRIGERATED requires tempMinC and tempMaxC',
        );
      if (min >= max) throw field422('tempMaxC', 'temp_range', 'tempMinC must be < tempMaxC');
    }
    if (
      input.capabilityTags !== undefined ||
      input.tempMinC !== undefined ||
      input.tempMaxC !== undefined ||
      !current
    ) {
      data.tempMinC = min;
      data.tempMaxC = max;
    }
    return data;
  }

  /** ชื่อห้ามซ้ำ (ต้นแบบ cfVt "มีประเภทนี้แล้ว"; unique index ไม่สนตัวพิมพ์) → 409 พร้อมรายการเดิม */
  private async assertUniqueName(name: string, exceptId?: string) {
    await lockKey(this.db.tx, `vehicle_type.name:${name.toLowerCase()}`);
    const dup = await this.db.tx.vehicleType.findFirst({
      where: {
        nameTh: iEquals(name),
        deletedAt: null,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
    });
    if (dup)
      throw new ProblemException(
        'duplicate',
        undefined,
        [{ field: 'name', code: 'duplicate', message: `vehicle type already exists: ${dup.code}` }],
        { existing: { id: encodeId('vehicleType', dup.id), code: dup.code, name: dup.nameTh } },
      );
  }

  private async assertUniqueExternal(externalId: string, exceptId?: string) {
    const dup = await this.db.tx.vehicleType.findFirst({
      where: { externalId, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (dup)
      throw new ProblemException('duplicate', undefined, [
        { field: 'externalId', code: 'duplicate', message: 'externalId already used' },
      ]);
  }

  async create(
    input: CreateVehicleTypeDto | (UpsertVehicleTypeDto & { externalId: string }),
  ): Promise<VehicleType> {
    const tx = this.db.tx;
    const data = this.toData(input);
    await this.assertUniqueName(input.name);
    if (input.externalId) {
      // POST ที่มี externalId ใช้ lock เดียวกับ PUT external (กันสร้างซ้ำพร้อมกัน)
      await lockKey(tx, `vehicle_type.ext:${input.externalId}`);
      await this.assertUniqueExternal(input.externalId);
    }
    await lockKey(tx, 'vehicle_type.code');
    let code = input.code;
    if (code) {
      const taken = await tx.vehicleType.findFirst({
        where: { code: iEquals(code) },
        select: { id: true },
      });
      if (taken)
        throw new ProblemException('duplicate', undefined, [
          { field: 'code', code: 'duplicate', message: 'code already exists' },
        ]);
    } else code = await nextCode(tx, 'vehicle_type', VEHICLE_TYPE_CODE_PREFIX);
    const v = await tx.vehicleType.create({
      data: {
        ...(data as object),
        code,
        externalId: input.externalId ?? null,
      } as Prisma.VehicleTypeUncheckedCreateInput, // tenantId เติมโดย tenantExtension
    });
    await this.audit.record({
      action: 'vehicle_type.created',
      entityType: 'vehicle_type',
      entityId: v.id,
      after: auditView(v),
    });
    await emitMasterEvent(tx, 'vehicle_type.created', 'vehicle_type', v.id, toVehicleTypeDto(v));
    return v;
  }

  async update(id: string, input: UpdateVehicleTypeDto, expected?: number): Promise<VehicleType> {
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    const data = this.toData(input, current);
    if (input.name !== undefined && input.name.toLowerCase() !== current.nameTh.toLowerCase())
      await this.assertUniqueName(input.name, current.id);
    if (input.externalId !== undefined) {
      if (input.externalId) await this.assertUniqueExternal(input.externalId, current.id);
      data.externalId = input.externalId;
    }
    if (isNoopUpdate(current, data as Record<string, unknown>, DECIMAL_FIELDS)) return current; // ส่งซ้ำค่าเดิมไม่เพิ่ม version
    const v = await this.bumpVersion(current, data);
    const before = auditView(current);
    const after = auditView(v);
    await this.audit.changed('vehicle_type.updated', 'vehicle_type', v.id, before, after);
    const changed = Object.keys(after).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    // spec/02 §4.7: vehicle_type.updated ทำให้ re-validate แผน (MD-092 — ผู้ฟังอยู่ใน ST3)
    if (changed.length)
      await emitMasterEvent(
        this.db.tx,
        'vehicle_type.updated',
        'vehicle_type',
        v.id,
        toVehicleTypeDto(v),
        { changedFields: changed },
      );
    return v;
  }

  /** PUT /vehicle-types/external/{externalId} — idempotent (ส่งซ้ำ = อัปเดตแถวเดิม) */
  async upsertExternal(externalId: string, input: UpsertVehicleTypeDto, expected?: number) {
    const tx = this.db.tx;
    return upsertByExternalId(tx, 'vehicle_type', externalId, {
      find: () => tx.vehicleType.findFirst({ where: { externalId, deletedAt: null } }),
      create: () => this.create({ ...input, externalId }),
      update: (cur) => {
        const { code: _code, ...rest } = input;
        return this.update(cur.id, rest, expected);
      },
    });
  }

  async changeStatus(id: string, event: VtEvent, reason?: string, expected?: number) {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    // MD-094: ปิดใช้ประเภทรถที่ยังมีรถ (ไม่ปลดระวาง) ในทะเบียนไม่ได้
    if (event === 'deactivate')
      await assertNotReferenced([
        {
          name: 'vehicles',
          count: () =>
            tx.vehicle.count({ where: { vehicleTypeId: id, status: { not: 'RETIRED' } } }),
        },
      ]);
    let updated!: VehicleType;
    await this.state.transition(tx, {
      docType: 'vehicle_type',
      docId: id,
      table: VEHICLE_TYPE_TRANSITIONS,
      from: current.status,
      event,
      note: reason ?? null,
      eventType: event === 'deactivate' ? 'vehicle_type.deactivated' : 'vehicle_type.reactivated',
      apply: async (to) => {
        updated = await this.bumpVersion(current, { status: to });
        await this.audit.changed(
          event === 'deactivate' ? 'vehicle_type.deactivated' : 'vehicle_type.reactivated',
          'vehicle_type',
          id,
          auditView(current),
          auditView(updated),
          reason,
        );
        return toVehicleTypeDto(updated) as unknown as Record<string, unknown>;
      },
    });
    return updated;
  }

  /** MD-004: ลบได้เฉพาะที่ไม่เคยถูกอ้างอิง → soft delete; ถูกอ้างอิง → 409 `in_use` (ให้ปิดใช้แทน) */
  async remove(id: string, reason: string, expected?: number): Promise<void> {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    await assertNotReferenced([
      { name: 'vehicles', count: () => tx.vehicle.count({ where: { vehicleTypeId: id } }) },
      { name: 'rateCards', count: () => tx.rateCard.count({ where: { vehicleTypeId: id } }) },
      {
        name: 'salesOrders',
        count: () => tx.salesOrder.count({ where: { vehicleTypeId: id } }),
      },
    ]);
    await this.bumpVersion(current, {
      deletedAt: new Date(),
      externalId: null,
      deletedExternalId: current.externalId,
    });
    await this.audit.record({
      action: 'vehicle_type.deleted',
      entityType: 'vehicle_type',
      entityId: id,
      before: auditView(current),
      reason,
    });
    await emitMasterEvent(
      tx,
      'vehicle_type.deleted',
      'vehicle_type',
      id,
      toVehicleTypeDto(current),
    );
  }

  /** optimistic lock: update เฉพาะเมื่อ version ยังเท่าเดิม ไม่งั้น 412 */
  private async bumpVersion(
    current: VehicleType,
    data: Prisma.VehicleTypeUncheckedUpdateInput,
  ): Promise<VehicleType> {
    const tx = this.db.tx;
    const r = await tx.vehicleType.updateMany({
      where: { id: current.id, version: current.version, deletedAt: null },
      data: { ...data, version: { increment: 1 } },
    });
    if (r.count !== 1) throw new ProblemException('precondition_failed');
    return (await tx.vehicleType.findUnique({ where: { id: current.id } }))!;
  }
}
