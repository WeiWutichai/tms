import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type Carrier,
  type Vehicle,
  type VehicleOdometerReading,
  type VehicleStatus,
  type VehicleType,
} from '@prisma/client';
import { scopeAllows, type TransitionTable } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { encodeId, tryDecodeId } from '../../common/ids';
import { iEquals } from '../../common/ilike';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { StateService } from '../../state/state.service';
import { EXPORT_MAX_ROWS } from '../master/export';
import {
  assertNotActivelyUsed,
  assertNotReferenced,
  emitMasterEvent,
  isNoopUpdate,
  likeEscape,
  lockKey,
  masterKeyset,
  upsertByExternalId,
} from '../master/master-kit';
import type {
  CreateVehicleDto,
  FuelType,
  OdometerCorrectionInput,
  OdometerReadingDto,
  OdometerReadingInput,
  OwnershipKind,
  UnitRole,
  UpdateVehicleDto,
  UpsertVehicleDto,
  VehicleDto,
  VehicleListQuery,
  VehicleStatusKey,
} from './vehicle.dto';

export type VehicleFull = Vehicle & {
  vehicleType: VehicleType;
  carrier: Carrier | null;
  paired: Vehicle | null;
};
const INCLUDE = { vehicleType: true, carrier: true, paired: true } as const;

const DECIMAL_FIELDS = [
  'capacityKg',
  'capacityCbm',
  'tareWeightKg',
  'grossWeightKg',
  'odometerKm',
  'purchaseCost',
  'salvageValue',
] as const;
/** ข้อมูลการเงินรถ (spec/06 FLT-A `vehicle.finance.view`) — ใช้สิทธิ์ reports.finance:read แทนจนกว่าจะมีสิทธิ์ระดับฟิลด์ (P3) */
const FINANCE_FIELDS = [
  'purchaseCost',
  'purchasedOn',
  'depreciationMethod',
  'depreciationYears',
  'salvageValue',
] as const;
export const FINANCE_SCOPE = 'reports.finance:read';

const STATUS_DB: Record<VehicleStatusKey, VehicleStatus> = {
  ready: 'READY',
  maintenance: 'MAINTENANCE',
  parked: 'PARKED',
  retired: 'RETIRED',
};
type VehEvent = 'to_ready' | 'to_maintenance' | 'to_parked' | 'retire';
const EVENT_FOR: Record<VehicleStatusKey, VehEvent> = {
  ready: 'to_ready',
  maintenance: 'to_maintenance',
  parked: 'to_parked',
  retired: 'retire',
};
/**
 * spec/06 FLT-A ข้อ 6: พร้อม ↔ ซ่อม, พร้อม ↔ จอด, ใด ๆ → ปลดระวาง (ย้อนกลับไม่ได้ — ใช้ทะเบียนเดิมสร้างคันใหม่ได้)
 * ซ่อม → จอด ไม่มีใน spec (ต้องกลับ "พร้อม" ก่อน)
 */
export const VEHICLE_TRANSITIONS: TransitionTable<VehicleStatus, VehEvent> = {
  READY: { to_maintenance: 'MAINTENANCE', to_parked: 'PARKED', retire: 'RETIRED' },
  MAINTENANCE: { to_ready: 'READY', retire: 'RETIRED' },
  PARKED: { to_ready: 'READY', retire: 'RETIRED' },
};
/** เที่ยวที่ยังไม่จบ — ปลดระวางไม่ได้ (FLT-A "ไม่มีเที่ยวค้าง") */
const OPEN_TRIP = ['PLANNING', 'OFFERED', 'ASSIGNED', 'DISPATCHED', 'IN_PROGRESS'] as const;
/** เปลี่ยนประเภทรถไม่ได้ระหว่างเที่ยววิ่ง (FLT-002) */
const RUNNING_TRIP = ['DISPATCHED', 'IN_PROGRESS'] as const;

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

const num = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));
const money = (d: Prisma.Decimal | null) => (d === null ? null : d.toFixed(2));
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** ทะเบียน normalize: ตัดช่องว่าง/ขีด/จุด + ตัวใหญ่ + จังหวัด (สูตรเดียวกับ migration 0042) */
export function plateKey(plate: string, province: string): string {
  return `${plate.replace(/[\s\-.]/g, '').toUpperCase()}|${province}`;
}
/** ทะเบียนไทย: เลขหมวด/อักษร/เลข 2–10 ตัวหลังตัดช่องว่าง/ขีด ต้องมีตัวเลข (เช่น 70-1234, 1กข 1234, 72-11) */
function assertPlate(plate: string) {
  const k = plate.replace(/[\s\-.]/g, '').toUpperCase();
  if (!/^[0-9A-Zก-ฮ]{2,10}$/.test(k) || !/\d/.test(k))
    throw field422(
      'plate',
      'plate_format',
      'plate must be a Thai plate such as 70-1234 or 1กข 1234',
    );
}

export function canSeeFinance(): boolean {
  return scopeAllows(requestContext.get()?.scopes ?? [], FINANCE_SCOPE);
}

export function toVehicleDto(v: VehicleFull, finance = canSeeFinance()): VehicleDto {
  return {
    id: encodeId('vehicle', v.id),
    plate: v.plate,
    plateProvince: v.plateProvince,
    externalId: v.externalId,
    vehicleType: {
      id: encodeId('vehicleType', v.vehicleType.id),
      code: v.vehicleType.code,
      name: v.vehicleType.nameTh,
      vehicleClass: v.vehicleType.vehicleClass,
    },
    unitRole: v.unitRole as UnitRole,
    ownership: v.ownership as OwnershipKind,
    carrier: v.carrier
      ? { id: encodeId('carrier', v.carrier.id), code: v.carrier.code, name: v.carrier.legalName }
      : null,
    payloadKg: num(v.capacityKg),
    volumeCbm: num(v.capacityCbm),
    tareWeightKg: num(v.tareWeightKg),
    grossWeightKg: num(v.grossWeightKg),
    gpsProvider: v.gpsProvider,
    gpsDeviceId: v.gpsDeviceId,
    chassisNo: v.chassisNo,
    engineNo: v.engineNo,
    brand: v.brand,
    model: v.model,
    year: v.year,
    color: v.color,
    fuelType: v.fuelType as FuelType | null,
    tankCapacityL: v.tankCapacityL,
    odometerKm: num(v.odometerKm),
    odometerSource: v.odometerSource,
    odometerUpdatedAt: v.odometerUpdatedAt?.toISOString() ?? null,
    paired: v.paired
      ? {
          id: encodeId('vehicle', v.paired.id),
          plate: v.paired.plate,
          plateProvince: v.paired.plateProvince,
          unitRole: v.paired.unitRole as UnitRole,
        }
      : null,
    ...(finance
      ? {
          purchaseCost: money(v.purchaseCost),
          purchasedOn: day(v.purchasedOn),
          depreciationMethod: v.depreciationMethod as 'STRAIGHT_LINE' | null,
          depreciationYears: v.depreciationYears,
          salvageValue: money(v.salvageValue),
        }
      : {}),
    photoDocumentIds: v.photoDocumentIds.map((d) => encodeId('document', d)),
    status: v.status.toLowerCase() as VehicleStatusKey,
    statusReason: v.statusReason,
    retiredAt: v.retiredAt?.toISOString() ?? null,
    ...(v.deletedAt ? { deletedAt: v.deletedAt.toISOString() } : {}),
    version: v.version,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

/** snapshot สำหรับ audit — มีข้อมูลการเงินเสมอ (ประวัติตัดออกให้ผู้ไม่มีสิทธิ์ที่ controller) */
export function auditView(v: VehicleFull): Record<string, unknown> {
  const {
    updatedAt: _u,
    version: _v,
    vehicleType,
    carrier,
    paired,
    odometerUpdatedAt: _o,
    ...rest
  } = toVehicleDto(v, true);
  return {
    ...rest,
    vehicleTypeId: vehicleType.id,
    carrierId: carrier?.id ?? null,
    pairedVehicleId: paired?.id ?? null,
  };
}
export const FINANCE_AUDIT_KEYS: readonly string[] = FINANCE_FIELDS;

type Input = CreateVehicleDto | UpdateVehicleDto | UpsertVehicleDto;

/**
 * รถ (ST2-T06; docs/04 B รถ + B2.1 ส่วน 1, docs/01 §3.2/§3.8, spec/06 FLT-A/FLT-O) — ใช้ master kit ของ ST2-T01
 * - รถร่วม (SUBCONTRACT) ต้องมี carrier ที่ใช้งานอยู่ → ไม่ส่ง 422 · รถบริษัทห้ามมี carrier
 * - ทะเบียน + จังหวัด normalize ห้ามซ้ำกับคันที่ยังไม่ปลดระวาง (FLT-001)
 * - หัวลาก ↔ หาง เขียนทั้งสองฝั่งใน transaction เดียว (lock `vehicle.pair`) — หางที่พ่วงหัวอื่นอยู่ → 409
 * - เลขไมล์: ค่าใหม่ต้องไม่น้อยกว่าเดิม (422 `odometer_backwards`) — แก้ค่าผิดผ่าน `correct` พร้อมเหตุผล (FLT-285)
 * - สถานะผ่าน state machine (ST0-T10) + เหตุผลทุกครั้ง · ปลดระวาง = ปลดคู่หัวลาก-หางให้เอง
 * - ข้อมูลการเงิน (ราคาซื้อ/ค่าเสื่อม) อ่าน/แก้ได้เฉพาะ reports.finance:read
 */
@Injectable()
export class VehiclesService {
  constructor(
    private readonly db: DbService,
    private readonly state: StateService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementService,
  ) {}

  // ---------- read ----------

  private where(q: VehicleListQuery): Prisma.VehicleWhereInput {
    const and: Prisma.VehicleWhereInput[] = [
      q.includeDeleted === 'true' ? {} : { deletedAt: null },
    ];
    if (q.status)
      and.push({
        status: { in: q.status.split(',').map((s) => STATUS_DB[s as VehicleStatusKey]) },
      });
    if (q.externalId) and.push({ externalId: q.externalId });
    if (q.ownership) and.push({ ownership: q.ownership });
    if (q.unitRole) and.push({ unitRole: q.unitRole });
    if (q.unpaired === 'true') and.push({ pairedVehicleId: null });
    if (q.vehicleTypeId)
      and.push({ vehicleTypeId: tryDecodeId('vehicleType', q.vehicleTypeId) ?? undefined });
    if (q.carrierId) and.push({ carrierId: tryDecodeId('carrier', q.carrierId) ?? undefined });
    const like = (v: string) => ({ contains: likeEscape(v), mode: 'insensitive' as const });
    if (q.plate) {
      const k = q.plate.replace(/[\s\-.]/g, '').toUpperCase();
      if (k) and.push({ plateKey: { contains: likeEscape(k) } });
    }
    if (q.q) {
      const k = q.q.replace(/[\s\-.]/g, '').toUpperCase();
      and.push({
        OR: [
          ...(k ? [{ plateKey: { contains: likeEscape(k) } }] : []),
          { brand: like(q.q) },
          { model: like(q.q) },
          { chassisNo: like(q.q) },
          { externalId: like(q.q) },
        ],
      });
    }
    return { AND: and };
  }

  async list(q: VehicleListQuery) {
    const k = masterKeyset(
      { ...q, sort: !q.sort || q.sort === 'plate' ? 'code' : q.sort },
      'plateKey',
    );
    const rows = await this.db.tx.vehicle.findMany({
      where: { AND: [this.where(q), k.where] },
      orderBy: k.orderBy,
      take: k.take,
      include: INCLUDE,
    });
    const finance = canSeeFinance();
    return k.page(rows, (r) => toVehicleDto(r, finance));
  }

  async exportRows(q: VehicleListQuery & { ids?: string }) {
    const ids = q.ids?.split(',').map((x) => tryDecodeId('vehicle', x)!);
    const where = ids ? { AND: [this.where(q), { id: { in: ids } }] } : this.where(q);
    const rows = await this.db.tx.vehicle.findMany({
      where,
      orderBy: [{ plateKey: 'asc' }, { id: 'asc' }],
      take: EXPORT_MAX_ROWS + 1,
      include: INCLUDE,
    });
    if (rows.length > EXPORT_MAX_ROWS)
      throw field422(
        'query',
        'too_many_rows',
        `export is limited to ${EXPORT_MAX_ROWS} rows — narrow the filter`,
      );
    const finance = canSeeFinance();
    return rows.map((r) => toVehicleDto(r, finance));
  }

  /** แถบสรุป + โควตารถ (soft limit — PLT-080 [OPEN O-PLT-4]; นับคันที่ยังไม่ปลดระวางจนกว่าจะมี metering รายเดือน) */
  async summary() {
    const tx = this.db.tx;
    const g = await tx.vehicle.groupBy({
      by: ['status'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    const n = (s: VehicleStatus) => g.find((x) => x.status === s)?._count._all ?? 0;
    const subcontract = await tx.vehicle.count({
      where: { deletedAt: null, ownership: 'SUBCONTRACT', status: { not: 'RETIRED' } },
    });
    const used = n('READY') + n('MAINTENANCE') + n('PARKED');
    return {
      total: used + n('RETIRED'),
      ready: n('READY'),
      maintenance: n('MAINTENANCE'),
      parked: n('PARKED'),
      retired: n('RETIRED'),
      subcontract,
      quota: { limit: await this.quotaLimit(), used },
    };
  }

  /** โควตารถ: ค่าในสัญญา (`tenant.vehicle_quota` จาก Console ST1-T24) → limit ของ entitlement `veh` ตามแพ็กเกจ */
  private async quotaLimit(): Promise<number | null> {
    const tenantId = requestContext.require().tenantId!;
    const t = await this.db.tx.tenant.findUnique({
      where: { id: tenantId },
      select: { vehicleQuota: true },
    });
    if (t?.vehicleQuota !== null && t?.vehicleQuota !== undefined) return t.vehicleQuota;
    return (await this.entitlements.resolve(tenantId)).veh?.limit ?? null;
  }

  async get(id: string): Promise<VehicleFull> {
    const v = await this.db.tx.vehicle.findFirst({
      where: { id, deletedAt: null },
      include: INCLUDE,
    });
    if (!v) throw new ProblemException('not_found');
    return v;
  }

  async getByExternalId(externalId: string): Promise<VehicleFull> {
    const v = await this.db.tx.vehicle.findFirst({
      where: { externalId, deletedAt: null },
      include: INCLUDE,
    });
    if (!v) throw new ProblemException('not_found');
    return v;
  }

  // ---------- write ----------

  /** ประเภทรถที่อ้าง: ต้องมีอยู่และใช้งาน (ค่าเดิมที่ถูกปิดใช้ภายหลังยังคงไว้ได้) */
  private async resolveType(ref: string, currentId?: string): Promise<VehicleType> {
    const id = tryDecodeId('vehicleType', ref);
    const vt = id
      ? await this.db.tx.vehicleType.findFirst({ where: { id, deletedAt: null } })
      : null;
    if (!vt) throw field422('vehicleTypeId', 'not_found', 'vehicle type not found');
    if (vt.status !== 'ACTIVE' && vt.id !== currentId)
      throw field422('vehicleTypeId', 'inactive', 'vehicle type is inactive');
    return vt;
  }

  /** ผู้รับเหมา: ต้องมีอยู่และไม่ถูกระงับ (ค่าเดิมคงไว้ได้แม้ถูกระงับภายหลัง) */
  private async resolveCarrier(ref: string, currentId?: string | null): Promise<Carrier> {
    const id = tryDecodeId('carrier', ref);
    const c = id ? await this.db.tx.carrier.findFirst({ where: { id, deletedAt: null } }) : null;
    if (!c) throw field422('carrierId', 'not_found', 'carrier not found');
    if (c.status !== 'ACTIVE' && c.id !== currentId)
      throw field422('carrierId', 'inactive', 'carrier is suspended');
    return c;
  }

  private assertFinanceAllowed(input: Input) {
    const sent = FINANCE_FIELDS.filter((k) => input[k] !== undefined);
    if (sent.length && !canSeeFinance())
      throw new ProblemException(
        'forbidden',
        `changing ${sent.join(', ')} requires ${FINANCE_SCOPE}`,
      );
  }

  /** แปลง DTO → คอลัมน์ + กฎที่ดูหลายช่องพร้อมกัน (ค่าที่ไม่ส่ง = ค่าเดิม) */
  private toData(input: Input, current?: VehicleFull): Prisma.VehicleUncheckedUpdateInput {
    const data: Prisma.VehicleUncheckedUpdateInput = {};
    const pick = <K extends keyof Input & keyof Vehicle>(k: K, col: keyof Vehicle = k) => {
      if (input[k] !== undefined) (data as Record<string, unknown>)[col] = input[k];
    };
    if (input.plate !== undefined) {
      assertPlate(input.plate);
      data.plate = input.plate;
    }
    pick('plateProvince');
    pick('unitRole');
    pick('ownership');
    if (input.payloadKg !== undefined) data.capacityKg = input.payloadKg;
    if (input.volumeCbm !== undefined) data.capacityCbm = input.volumeCbm;
    pick('tareWeightKg');
    pick('grossWeightKg');
    pick('gpsProvider');
    pick('gpsDeviceId');
    pick('chassisNo');
    pick('engineNo');
    pick('brand');
    pick('model');
    pick('year');
    pick('color');
    pick('fuelType');
    pick('tankCapacityL');
    if (input.purchaseCost !== undefined) data.purchaseCost = input.purchaseCost;
    if (input.purchasedOn !== undefined)
      data.purchasedOn = input.purchasedOn ? new Date(`${input.purchasedOn}T00:00:00Z`) : null;
    pick('depreciationMethod');
    pick('depreciationYears');
    if (input.salvageValue !== undefined) data.salvageValue = input.salvageValue;
    if (input.photoDocumentIds !== undefined)
      data.photoDocumentIds = input.photoDocumentIds.map((d) => tryDecodeId('document', d)!);

    // ---- กฎข้ามช่อง (ค่าหลังแก้) ----
    const eff = <T>(v: T | undefined, cur: T) => (v !== undefined ? v : cur);
    const year = eff(input.year, current?.year ?? null);
    if (year !== null && year > new Date().getUTCFullYear() + 1)
      throw field422('year', 'year_range', 'year must not be later than next year');
    const payload = eff<number | null>(input.payloadKg, num(current?.capacityKg ?? null));
    const tare = eff(input.tareWeightKg, num(current?.tareWeightKg ?? null));
    const gross = eff(input.grossWeightKg, num(current?.grossWeightKg ?? null));
    if (tare !== null && gross !== null) {
      if (tare >= gross)
        throw field422('tareWeightKg', 'tare_over_gross', 'tareWeightKg must be < grossWeightKg');
      if (payload !== null && payload > gross - tare)
        throw field422(
          'payloadKg',
          'payload_over_gvw',
          'payloadKg must be ≤ grossWeightKg − tareWeightKg',
        );
    }
    const gpsP = eff(input.gpsProvider, current?.gpsProvider ?? null);
    const gpsD = eff(input.gpsDeviceId, current?.gpsDeviceId ?? null);
    if (gpsD && !gpsP)
      throw field422('gpsProvider', 'required', 'gpsProvider is required with gpsDeviceId');
    const method = eff(input.depreciationMethod, current?.depreciationMethod ?? null);
    const years = eff(input.depreciationYears, current?.depreciationYears ?? null);
    const cost = eff(input.purchaseCost, money(current?.purchaseCost ?? null));
    const salvage = eff(input.salvageValue, money(current?.salvageValue ?? null));
    if (method) {
      if (years === null)
        throw field422('depreciationYears', 'required', 'STRAIGHT_LINE requires depreciationYears');
      if (cost === null)
        throw field422('purchaseCost', 'required', 'STRAIGHT_LINE requires purchaseCost');
      if (salvage !== null && new Prisma.Decimal(salvage).gt(cost))
        throw field422('salvageValue', 'salvage_over_cost', 'salvageValue must be ≤ purchaseCost');
    } else if (years !== null || salvage !== null)
      throw field422(
        'depreciationMethod',
        'required',
        'depreciationYears/salvageValue need depreciationMethod',
      );
    return data;
  }

  private async assertUnique(data: Prisma.VehicleUncheckedUpdateInput, self?: VehicleFull) {
    const tx = this.db.tx;
    const not = self ? { id: { not: self.id } } : {};
    const plate = (data.plate as string | undefined) ?? self?.plate;
    const prov = (data.plateProvince as string | undefined) ?? self?.plateProvince;
    const key = plateKey(plate!, prov!);
    if (!self || key !== self.plateKey || self.status === 'RETIRED') {
      await lockKey(tx, `vehicle.plate:${key}`);
      const dup = await tx.vehicle.findFirst({
        where: { plateKey: key, deletedAt: null, status: { not: 'RETIRED' }, ...not },
      });
      if (dup && !(self?.status === 'RETIRED' && key === self.plateKey))
        throw new ProblemException(
          'duplicate',
          undefined,
          [
            {
              field: 'plate',
              code: 'duplicate',
              message: `plate already registered: ${dup.plate}`,
            },
          ],
          {
            existing: {
              id: encodeId('vehicle', dup.id),
              plate: dup.plate,
              plateProvince: dup.plateProvince,
            },
          },
        );
    }
    if (
      typeof data.chassisNo === 'string' &&
      data.chassisNo.toUpperCase() !== self?.chassisNo?.toUpperCase()
    ) {
      await lockKey(tx, `vehicle.chassis:${data.chassisNo.toUpperCase()}`);
      const dup = await tx.vehicle.findFirst({
        where: { chassisNo: iEquals(data.chassisNo), deletedAt: null, ...not },
      });
      if (dup)
        throw new ProblemException(
          'duplicate',
          undefined,
          [
            {
              field: 'chassisNo',
              code: 'duplicate',
              message: `chassis number used by ${dup.plate}`,
            },
          ],
          {
            existing: {
              id: encodeId('vehicle', dup.id),
              plate: dup.plate,
              plateProvince: dup.plateProvince,
            },
          },
        );
    }
    const gpsP = (data.gpsProvider as string | null | undefined) ?? self?.gpsProvider ?? null;
    const gpsD = (data.gpsDeviceId as string | null | undefined) ?? self?.gpsDeviceId ?? null;
    if (gpsP && gpsD && (data.gpsProvider !== undefined || data.gpsDeviceId !== undefined)) {
      await lockKey(tx, `vehicle.gps:${gpsP.toLowerCase()}:${gpsD}`);
      const dup = await tx.vehicle.findFirst({
        where: {
          gpsProvider: iEquals(gpsP),
          gpsDeviceId: gpsD,
          deletedAt: null,
          status: { not: 'RETIRED' },
          ...not,
        },
      });
      if (dup)
        throw new ProblemException('duplicate', undefined, [
          { field: 'gpsDeviceId', code: 'duplicate', message: `GPS device used by ${dup.plate}` },
        ]);
    }
  }

  private async assertUniqueExternal(externalId: string, exceptId?: string) {
    const dup = await this.db.tx.vehicle.findFirst({
      where: { externalId, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (dup)
      throw new ProblemException('duplicate', undefined, [
        { field: 'externalId', code: 'duplicate', message: 'externalId already used' },
      ]);
  }

  /** รูปรถต้องเป็นไฟล์ของ tenant นี้ (RLS) ที่ยังไม่ถูกลบ */
  private async assertPhotos(ids: string[] | undefined) {
    if (!ids?.length) return;
    const uuids = ids.map((d) => tryDecodeId('document', d));
    if (uuids.some((u) => !u))
      throw field422('photoDocumentIds', 'not_found', 'document not found');
    const n = await this.db.tx.storedDocument.count({ where: { id: { in: uuids as string[] } } });
    if (n !== new Set(uuids).size)
      throw field422('photoDocumentIds', 'not_found', 'document not found');
  }

  /**
   * ตรวจคู่หัวลาก ↔ หาง ก่อนเขียน (ถือ lock `vehicle.pair` ทั้ง tenant จนจบ transaction)
   * คืนคันคู่ (หรือ null = ปลดคู่) — คันคู่ที่จับกับคันอื่นอยู่ → 409 `already_paired`
   */
  private async checkPair(
    partnerRef: string | null,
    role: string,
    selfId?: string,
  ): Promise<Vehicle | null> {
    const tx = this.db.tx;
    await lockKey(tx, 'vehicle.pair');
    if (partnerRef === null) return null;
    const pid = tryDecodeId('vehicle', partnerRef);
    if (pid && pid === selfId)
      throw field422('pairedVehicleId', 'pair_self', 'a vehicle cannot pair with itself');
    const p = pid ? await tx.vehicle.findFirst({ where: { id: pid, deletedAt: null } }) : null;
    if (!p) throw field422('pairedVehicleId', 'not_found', 'vehicle not found');
    if (p.status === 'RETIRED')
      throw field422('pairedVehicleId', 'retired', 'cannot pair with a retired vehicle');
    const ok =
      (role === 'TRACTOR' && p.unitRole === 'TRAILER') ||
      (role === 'TRAILER' && p.unitRole === 'TRACTOR');
    if (!ok)
      throw field422(
        'pairedVehicleId',
        'pair_role',
        'pairing needs one TRACTOR and one TRAILER (set unitRole)',
      );
    if (p.pairedVehicleId && p.pairedVehicleId !== selfId) {
      const other = await tx.vehicle.findUnique({ where: { id: p.pairedVehicleId } });
      throw new ProblemException(
        'conflict',
        undefined,
        [
          {
            field: 'pairedVehicleId',
            code: 'already_paired',
            message: `${p.plate} is paired with ${other?.plate ?? '?'} — unpair it first`,
          },
        ],
        {
          pairedWith: other
            ? {
                id: encodeId('vehicle', other.id),
                plate: other.plate,
                plateProvince: other.plateProvince,
              }
            : null,
        },
      );
    }
    return p;
  }

  /** ตั้ง/ล้างคู่ของคันอื่น (อีกฝั่งของการจับคู่) — เพิ่ม version + audit ของคันนั้นด้วย */
  private async setPartnerSide(vehicleId: string, pairedVehicleId: string | null) {
    const tx = this.db.tx;
    const before = await tx.vehicle.findUnique({ where: { id: vehicleId }, include: INCLUDE });
    if (!before || before.pairedVehicleId === pairedVehicleId) return;
    await tx.vehicle.update({
      where: { id: vehicleId },
      data: { pairedVehicleId, version: { increment: 1 } },
    });
    const after = (await tx.vehicle.findUnique({ where: { id: vehicleId }, include: INCLUDE }))!;
    await this.audit.changed(
      'vehicle.updated',
      'vehicle',
      vehicleId,
      auditView(before),
      auditView(after),
    );
    await emitMasterEvent(tx, 'vehicle.updated', 'vehicle', vehicleId, toVehicleDto(after, false), {
      changedFields: ['pairedVehicleId'],
    });
  }

  async create(input: CreateVehicleDto | (UpsertVehicleDto & { externalId: string })) {
    const tx = this.db.tx;
    this.assertFinanceAllowed(input);
    const vt = await this.resolveType(input.vehicleTypeId);
    let carrierId: string | null = null;
    if (input.ownership === 'SUBCONTRACT') {
      if (!input.carrierId)
        throw field422('carrierId', 'required', 'carrierId is required for SUBCONTRACT vehicles');
      carrierId = (await this.resolveCarrier(input.carrierId)).id;
    } else if (input.carrierId)
      throw field422('carrierId', 'not_allowed', 'OWN vehicles have no carrier');
    const data = this.toData(input);
    await this.assertPhotos(input.photoDocumentIds);
    await this.assertUnique(data);
    if (input.externalId) {
      await lockKey(tx, `vehicle.ext:${input.externalId}`);
      await this.assertUniqueExternal(input.externalId);
    }
    const role = input.unitRole ?? 'SINGLE';
    const partner =
      input.pairedVehicleId !== undefined && input.pairedVehicleId !== null
        ? await this.checkPair(input.pairedVehicleId, role)
        : null;
    const now = new Date();
    const created = await tx.vehicle.create({
      data: {
        ...(data as object),
        plateKey: plateKey(input.plate, input.plateProvince),
        vehicleTypeId: vt.id,
        carrierId,
        // ไม่ส่งน้ำหนัก/ปริมาตร = ค่าของประเภทรถ (spec/06 FLT-A "ค่าตั้งต้นจากประเภทรถ แก้ต่อคันได้")
        capacityKg: input.payloadKg ?? vt.capacityKg,
        capacityCbm: input.volumeCbm !== undefined ? input.volumeCbm : vt.capacityCbm,
        externalId: input.externalId ?? null,
        ...(input.odometerKm !== undefined
          ? { odometerKm: input.odometerKm, odometerSource: 'MANUAL', odometerUpdatedAt: now }
          : {}),
        ...(partner ? { pairedVehicleId: partner.id } : {}),
      } as Prisma.VehicleUncheckedCreateInput, // tenantId เติมโดย tenantExtension
    });
    if (input.odometerKm !== undefined)
      await this.insertReading(created.id, input.odometerKm, now, 'MANUAL');
    if (partner) await this.setPartnerSide(partner.id, created.id);
    const v = await this.get(created.id);
    await this.audit.record({
      action: 'vehicle.created',
      entityType: 'vehicle',
      entityId: v.id,
      after: auditView(v),
    });
    await emitMasterEvent(tx, 'vehicle.created', 'vehicle', v.id, toVehicleDto(v, false));
    return v;
  }

  async update(id: string, input: UpdateVehicleDto, expected?: number): Promise<VehicleFull> {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    this.assertFinanceAllowed(input);
    const data = this.toData(input, current);

    if (input.vehicleTypeId !== undefined) {
      const vt = await this.resolveType(input.vehicleTypeId, current.vehicleTypeId);
      if (vt.id !== current.vehicleTypeId) {
        // FLT-002: เปลี่ยนประเภทรถระหว่างเที่ยววิ่งไม่ได้
        const running = await tx.trip.count({
          where: { vehicleId: id, status: { in: [...RUNNING_TRIP] } },
        });
        if (running)
          throw new ProblemException(
            'conflict',
            'vehicle type cannot change during a running trip',
            [
              {
                field: 'vehicleTypeId',
                code: 'trip_running',
                message: 'vehicle is on a running trip',
              },
            ],
          );
      }
      data.vehicleTypeId = vt.id;
    }
    const ownership = input.ownership ?? current.ownership;
    let carrierId = current.carrierId;
    if (input.carrierId !== undefined)
      carrierId = input.carrierId
        ? (await this.resolveCarrier(input.carrierId, current.carrierId)).id
        : null;
    else if (ownership === 'OWN') carrierId = null;
    if (ownership === 'SUBCONTRACT' && !carrierId)
      throw field422('carrierId', 'required', 'carrierId is required for SUBCONTRACT vehicles');
    if (ownership === 'OWN' && carrierId)
      throw field422('carrierId', 'not_allowed', 'OWN vehicles have no carrier');
    if (carrierId !== current.carrierId) data.carrierId = carrierId;

    await this.assertPhotos(input.photoDocumentIds);
    if (input.plate !== undefined || input.plateProvince !== undefined)
      data.plateKey = plateKey(
        input.plate ?? current.plate,
        input.plateProvince ?? current.plateProvince,
      );
    if (
      data.plateKey !== undefined ||
      data.chassisNo !== undefined ||
      data.gpsProvider !== undefined ||
      data.gpsDeviceId !== undefined
    )
      await this.assertUnique(data, current);
    if (input.externalId !== undefined) {
      if (input.externalId) await this.assertUniqueExternal(input.externalId, current.id);
      data.externalId = input.externalId;
    }

    // ---- เลขไมล์: ห้ามถอยหลัง (acceptance ST2-T06) ----
    let odo: number | undefined;
    if (input.odometerKm !== undefined && input.odometerKm !== num(current.odometerKm)) {
      const cur = num(current.odometerKm);
      if (cur !== null && input.odometerKm < cur)
        throw new ProblemException('validation_failed', undefined, [
          {
            field: 'odometerKm',
            code: 'odometer_backwards',
            message: `odometer cannot go backwards (current ${cur} km) — use POST /vehicles/{id}/odometer/correct`,
          },
        ]);
      odo = input.odometerKm;
    }

    // ---- หัวลาก ↔ หาง ----
    const role = input.unitRole ?? current.unitRole;
    const wantPair =
      input.pairedVehicleId !== undefined
        ? input.pairedVehicleId
          ? (tryDecodeId('vehicle', input.pairedVehicleId) ?? input.pairedVehicleId)
          : null
        : current.pairedVehicleId;
    let partner: Vehicle | null | undefined; // undefined = ไม่เปลี่ยนคู่
    if (input.pairedVehicleId !== undefined && wantPair !== current.pairedVehicleId)
      partner = await this.checkPair(input.pairedVehicleId, role, current.id);
    else if (
      input.unitRole !== undefined &&
      input.unitRole !== current.unitRole &&
      current.paired
    ) {
      // เปลี่ยนบทบาทขณะจับคู่อยู่ → ต้องปลดคู่ก่อน (หรือส่ง pairedVehicleId: null มาพร้อมกัน)
      throw field422(
        'unitRole',
        'paired',
        `unpair from ${current.paired.plate} before changing unitRole`,
      );
    }
    if (partner !== undefined) data.pairedVehicleId = partner?.id ?? null;
    if (current.status === 'RETIRED' && partner)
      throw field422('pairedVehicleId', 'retired', 'a retired vehicle cannot be paired');

    const changed = !isNoopUpdate(current, data as Record<string, unknown>, DECIMAL_FIELDS);
    if (!changed && odo === undefined) return current; // ส่งซ้ำค่าเดิมไม่เพิ่ม version
    const now = new Date();
    if (odo !== undefined) {
      data.odometerKm = odo;
      data.odometerSource = 'MANUAL';
      data.odometerUpdatedAt = now;
    }
    // ปลดคู่เดิมก่อน (unique ของ paired_vehicle_id)
    if (partner !== undefined && current.pairedVehicleId)
      await this.setPartnerSide(current.pairedVehicleId, null);
    const v = await this.bumpVersion(current, data);
    if (partner) await this.setPartnerSide(partner.id, v.id);
    if (odo !== undefined) await this.insertReading(v.id, odo, now, 'MANUAL');
    const after = partner !== undefined ? await this.get(v.id) : v;
    const b = auditView(current);
    const a = auditView(after);
    await this.audit.changed('vehicle.updated', 'vehicle', v.id, b, a);
    const fields = Object.keys(a).filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]));
    if (fields.length)
      await emitMasterEvent(tx, 'vehicle.updated', 'vehicle', v.id, toVehicleDto(after, false), {
        changedFields: fields,
      });
    return after;
  }

  /** PUT /vehicles/external/{externalId} — idempotent (ส่งซ้ำ = อัปเดตแถวเดิม) */
  async upsertExternal(externalId: string, input: UpsertVehicleDto, expected?: number) {
    const tx = this.db.tx;
    return upsertByExternalId(tx, 'vehicle', externalId, {
      find: () =>
        tx.vehicle.findFirst({ where: { externalId, deletedAt: null }, include: INCLUDE }),
      create: () => this.create({ ...input, externalId }),
      update: (cur) => this.update(cur.id, input, expected),
    });
  }

  /** เปลี่ยนสถานะ (state machine ST0-T10 + doc_status_history) — เหตุผลบังคับ */
  async changeStatus(id: string, status: VehicleStatusKey, reason: string, expected?: number) {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    const retire = status === 'retired';
    if (retire)
      await assertNotActivelyUsed([
        {
          name: 'trips',
          count: () => tx.trip.count({ where: { vehicleId: id, status: { in: [...OPEN_TRIP] } } }),
        },
      ]);
    let updated!: VehicleFull;
    await this.state.transition(tx, {
      docType: 'vehicle',
      docId: id,
      table: VEHICLE_TRANSITIONS,
      from: current.status,
      event: EVENT_FOR[status],
      note: reason,
      eventType: retire ? 'vehicle.retired' : 'vehicle.status_changed',
      apply: async (to) => {
        // ปลดระวาง = ปลดคู่หัวลาก-หาง (ทั้งสองฝั่ง)
        if (retire && current.pairedVehicleId)
          await this.setPartnerSide(current.pairedVehicleId, null);
        const v = await this.bumpVersion(current, {
          status: to,
          statusReason: reason,
          retiredAt: retire ? new Date() : null,
          ...(retire ? { pairedVehicleId: null } : {}),
        });
        updated = retire ? await this.get(v.id) : v;
        await this.audit.changed(
          retire ? 'vehicle.retired' : 'vehicle.status_changed',
          'vehicle',
          id,
          auditView(current),
          auditView(updated),
          reason,
        );
        return toVehicleDto(updated, false) as unknown as Record<string, unknown>;
      },
    });
    return updated;
  }

  /** FLT-008: ลบได้เฉพาะรถที่ไม่เคยมีเที่ยว/เอกสาร/ค่าใช้จ่าย → soft delete; ไม่งั้น 409 `in_use` (ให้ปลดระวางแทน) */
  async remove(id: string, reason: string, expected?: number): Promise<void> {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    await assertNotReferenced(
      [
        { name: 'trips', count: () => tx.trip.count({ where: { vehicleId: id } }) },
        {
          name: 'vehicleDocuments',
          count: () => tx.vehicleDocument.count({ where: { vehicleId: id } }),
        },
        { name: 'vehicleCosts', count: () => tx.vehicleCost.count({ where: { vehicleId: id } }) },
        {
          name: 'positions',
          count: () => tx.vehiclePosition.count({ where: { vehicleId: id } }),
        },
        { name: 'drivers', count: () => tx.driver.count({ where: { defaultVehicleId: id } }) },
      ],
      { action: 'retire', th: 'ปลดระวาง', en: 'retire' },
    );
    if (current.pairedVehicleId) {
      await lockKey(tx, 'vehicle.pair');
      await this.setPartnerSide(current.pairedVehicleId, null);
    }
    await this.bumpVersion(current, {
      deletedAt: new Date(),
      externalId: null,
      deletedExternalId: current.externalId,
      pairedVehicleId: null,
    });
    await this.audit.record({
      action: 'vehicle.deleted',
      entityType: 'vehicle',
      entityId: id,
      before: auditView(current),
      reason,
    });
    await emitMasterEvent(tx, 'vehicle.deleted', 'vehicle', id, toVehicleDto(current, false));
  }

  // ---------- เลขไมล์ (spec/06 FLT-O) ----------

  private async insertReading(
    vehicleId: string,
    km: number,
    readAt: Date,
    source: string,
    extra: Partial<Prisma.VehicleOdometerReadingUncheckedCreateInput> = {},
  ) {
    return this.db.tx.vehicleOdometerReading.create({
      data: {
        vehicleId,
        readingKm: km,
        readAt,
        source,
        createdBy: requestContext.get()?.actorId ?? null,
        ...extra,
      } as Prisma.VehicleOdometerReadingUncheckedCreateInput,
    });
  }

  /** เลขไมล์ปัจจุบัน = reading ACCEPTED ล่าสุดตาม readAt (FLT-280) → เขียนกลับที่รถ */
  private async syncOdometer(current: VehicleFull, source: string): Promise<VehicleFull> {
    const last = await this.db.tx.vehicleOdometerReading.findFirst({
      where: { vehicleId: current.id, status: 'ACCEPTED' },
      orderBy: [{ readAt: 'desc' }, { createdAt: 'desc' }],
    });
    await this.bumpVersion(current, {
      odometerKm: last?.readingKm ?? null,
      odometerSource: last ? source : null,
      odometerUpdatedAt: new Date(),
    });
    return this.get(current.id);
  }

  async readings(id: string, limit = 50): Promise<OdometerReadingDto[]> {
    const rows = await this.db.tx.vehicleOdometerReading.findMany({
      where: { vehicleId: id },
      orderBy: [{ readAt: 'desc' }, { createdAt: 'desc' }],
      take: limit + 1,
    });
    return rows.slice(0, limit).map((r, i) => {
      const prev = rows.slice(i + 1).find((x) => x.status === 'ACCEPTED');
      return toReadingDto(
        r,
        prev && r.status === 'ACCEPTED' ? Number(r.readingKm) - Number(prev.readingKm) : null,
      );
    });
  }

  /**
   * บันทึกเลขไมล์ (แหล่ง MANUAL) — ต้องไม่น้อยกว่าค่าก่อนหน้าตามเวลา และไม่มากกว่าค่าหลังจากนั้น
   * (reading ย้อนหลังเทียบตามเวลา ไม่ใช่ค่าล่าสุดเสมอ — FLT-O ข้อ 8) ไม่ผ่าน → 422 `odometer_backwards`
   */
  async record(id: string, input: OdometerReadingInput, expected?: number) {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    await lockKey(tx, `vehicle.odometer:${id}`);
    const readAt = input.readAt ? new Date(input.readAt) : new Date();
    if (readAt.getTime() > Date.now() + 5 * 60_000)
      throw field422('readAt', 'future', 'readAt must not be in the future');
    const [prev, next] = await Promise.all([
      tx.vehicleOdometerReading.findFirst({
        where: { vehicleId: id, status: 'ACCEPTED', readAt: { lte: readAt } },
        orderBy: [{ readAt: 'desc' }, { createdAt: 'desc' }],
      }),
      tx.vehicleOdometerReading.findFirst({
        where: { vehicleId: id, status: 'ACCEPTED', readAt: { gt: readAt } },
        orderBy: [{ readAt: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);
    const floor = prev ? Number(prev.readingKm) : null;
    if (floor !== null && input.readingKm < floor)
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'readingKm',
          code: 'odometer_backwards',
          message: `odometer cannot go backwards (previous ${floor} km)`,
        },
      ]);
    if (next && input.readingKm > Number(next.readingKm))
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'readingKm',
          code: 'odometer_after_later',
          message: `reading is higher than a later reading (${Number(next.readingKm)} km)`,
        },
      ]);
    const r = await this.insertReading(id, input.readingKm, readAt, 'MANUAL');
    const v = await this.syncOdometer(current, 'MANUAL');
    await this.audit.changed(
      'vehicle.odometer_recorded',
      'vehicle',
      id,
      { odometerKm: num(current.odometerKm) },
      { odometerKm: num(v.odometerKm) },
    );
    await emitMasterEvent(tx, 'odometer.recorded', 'vehicle', id, toReadingDto(r, null));
    return {
      reading: toReadingDto(r, floor === null ? null : input.readingKm - floor),
      vehicle: v,
    };
  }

  /** แก้เลขไมล์ที่ผิด (FLT-285): ไม่ทับค่าเดิม — แถวใหม่อ้างแถวเดิม + แถวเดิม SUPERSEDED · เหตุผลบังคับ + audit */
  async correct(id: string, input: OdometerCorrectionInput, expected?: number) {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    await lockKey(tx, `vehicle.odometer:${id}`);
    const last = await tx.vehicleOdometerReading.findFirst({
      where: { vehicleId: id, status: 'ACCEPTED' },
      orderBy: [{ readAt: 'desc' }, { createdAt: 'desc' }],
    });
    if (last)
      await tx.vehicleOdometerReading.update({
        where: { id: last.id },
        data: { status: 'SUPERSEDED' },
      });
    const r = await this.insertReading(
      id,
      input.readingKm,
      last?.readAt ?? new Date(),
      'CORRECTION',
      {
        reasonType: input.reasonType,
        note: input.note,
        originalReadingId: last?.id ?? null,
      },
    );
    const v = await this.syncOdometer(current, 'MANUAL');
    await this.audit.changed(
      'vehicle.odometer_corrected',
      'vehicle',
      id,
      { odometerKm: num(current.odometerKm) },
      { odometerKm: num(v.odometerKm), odometerReason: input.reasonType },
      input.note,
    );
    await emitMasterEvent(tx, 'odometer.corrected', 'vehicle', id, toReadingDto(r, null), {
      originalReadingId: last ? encodeId('odometerReading', last.id) : null,
    });
    return { reading: toReadingDto(r, null), vehicle: v };
  }

  /** optimistic lock: update เฉพาะเมื่อ version ยังเท่าเดิม ไม่งั้น 412 */
  private async bumpVersion(
    current: Vehicle,
    data: Prisma.VehicleUncheckedUpdateInput,
  ): Promise<VehicleFull> {
    const tx: Tx = this.db.tx;
    const r = await tx.vehicle.updateMany({
      where: { id: current.id, version: current.version, deletedAt: null },
      data: { ...data, version: { increment: 1 } },
    });
    if (r.count !== 1) throw new ProblemException('precondition_failed');
    return (await tx.vehicle.findUnique({ where: { id: current.id }, include: INCLUDE }))!;
  }
}

function toReadingDto(r: VehicleOdometerReading, deltaKm: number | null): OdometerReadingDto {
  return {
    id: encodeId('odometerReading', r.id),
    readingKm: Number(r.readingKm),
    readAt: r.readAt.toISOString(),
    source: r.source,
    status: r.status,
    reasonType: r.reasonType as OdometerReadingDto['reasonType'],
    note: r.note,
    deltaKm: deltaKm === null ? null : Math.round(deltaKm * 10) / 10,
    originalReadingId: r.originalReadingId
      ? encodeId('odometerReading', r.originalReadingId)
      : null,
    createdAt: r.createdAt.toISOString(),
  };
}
