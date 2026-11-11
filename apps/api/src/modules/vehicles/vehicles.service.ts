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
import { PROVINCES } from './provinces';
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
/** รถปลดระวางแล้วอ่านอย่างเดียว (แก้/บันทึกเลขไมล์ → 409) */
const retired409 = () =>
  new ProblemException('conflict', 'vehicle is retired (read-only)', [
    { field: 'status', code: 'vehicle_retired', message: 'a retired vehicle cannot be changed' },
  ]);

const num = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));
const money = (d: Prisma.Decimal | null) => (d === null ? null : d.toFixed(2));
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

// ---------- ทะเบียน (normalize + ตรวจรูปแบบ) ----------

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
/** เลขไทย ๐-๙ → 0-9 */
export const arabicDigits = (s: string) =>
  s.replace(/[๐-๙]/g, (c) => String(THAI_DIGITS.indexOf(c)));
/** ทะเบียนอย่างเดียว normalize: เลขไทย → อารบิก, ตัดช่องว่าง/ขีด/จุด, ตัวใหญ่ (สูตรเดียวกับ migration 0043) */
export function plateNorm(plate: string): string {
  return arabicDigits(plate)
    .replace(/[\s\-.]/g, '')
    .toUpperCase();
}
export function plateKey(plate: string, province: string): string {
  return `${plateNorm(plate)}|${province}`;
}
/** เลขตัวถัง normalize: ตัดช่องว่าง/ขีด/จุด/ทับ ตัวใหญ่ (MNT-123ABC = MNT123ABC) */
export const chassisNorm = (v: string) => v.replace(/[\s\-./]/g, '').toUpperCase();

/** ชื่อ/อักษรย่อจังหวัด (ไม่มีจุด) — ตรวจว่าผู้ใช้พิมพ์จังหวัดมาในช่องทะเบียน */
const PROVINCE_WORDS = new Set(PROVINCES.flatMap((p) => [p[1], p[2].replace(/\./g, '')]));
/**
 * รูปแบบทะเบียนไทย (หลัง normalize):
 * - รถบรรทุก/รถสาธารณะ: เลขหมวด 2 หลัก + เลข 1–4 หลัก เช่น 70-1234, 72-11 (หาง/พ่วงใช้รูปแบบเดียวกัน)
 * - รถส่วนบุคคล/กระบะ: (เลข 1 หลัก) + อักษรไทย 1–3 ตัว + เลข 1–4 หลัก เช่น 1กข 1234, กข 1234
 * ไม่รับอักษรละติน, เลขล้วนเกิน 6 หลัก, จังหวัดต่อท้าย (ให้ใส่ในช่องจังหวัด)
 */
const PLATE_RE = /^(\d{2}\d{1,4}|\d?[ก-ฮ]{1,3}\d{1,4})$/;
export function assertPlate(plate: string) {
  const raw = arabicDigits(plate).trim();
  const tail = raw.match(/[ก-ฮ.]+$/)?.[0]?.replace(/\./g, '');
  const afterDigit = /\d[\s\-.]*[ก-ฮ.]+$/.test(raw);
  if ((tail && afterDigit) || PROVINCE_WORDS.has(raw.replace(/[\s.]/g, '')))
    throw field422(
      'plate',
      'plate_has_province',
      'put the province in plateProvince, not in plate (e.g. "70-1234" + TH-10)',
    );
  if (!PLATE_RE.test(plateNorm(plate)))
    throw field422(
      'plate',
      'plate_format',
      'plate must be a Thai plate such as 70-1234 or 1กข 1234',
    );
}

/** วันนี้ตามเวลาไทย (YYYY-MM-DD) */
const todayTh = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

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
 * - เลขไมล์: lock `vehicle.odometer:{id}` แล้วตรวจกับค่าก่อน/หลังตามเวลา (422 `odometer_backwards`) — แก้ค่าผิดผ่าน `correct` (FLT-285)
 * - สถานะผ่าน state machine (ST0-T10) + เหตุผลทุกครั้ง · ปลดระวาง = ปลดคู่หัวลาก-หางให้เอง + อ่านอย่างเดียว
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
    // ค้นทะเบียนใน plate_norm (ไม่มีรหัสจังหวัด) — "TH" / "10" ไม่ไปตรงกับจังหวัด
    if (q.plate) {
      const k = plateNorm(q.plate);
      if (k) and.push({ plateNorm: { contains: likeEscape(k) } });
    }
    if (q.q) {
      const k = plateNorm(q.q);
      and.push({
        OR: [
          ...(k ? [{ plateNorm: { contains: likeEscape(k) } }] : []),
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

  /** รถที่นับโควตาเกิน limit แล้วหรือยัง (soft limit — เพิ่มได้ แต่ส่งสัญญาณให้ผู้เรียก) */
  async quotaExceeded(): Promise<boolean> {
    const limit = await this.quotaLimit();
    if (limit === null) return false;
    const used = await this.db.tx.vehicle.count({
      where: { deletedAt: null, status: { not: 'RETIRED' } },
    });
    return used > limit;
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

  /**
   * แปลง DTO → คอลัมน์ + กฎที่ดูหลายช่องพร้อมกัน (ค่าที่ไม่ส่ง = ค่าเดิม)
   * `defaultPayload` = น้ำหนักบรรทุกของประเภทรถ (ตอนสร้างไม่ส่งน้ำหนัก) — ตรวจกับน้ำหนักรวม − เปล่าด้วยค่าหลังเติม
   */
  private toData(
    input: Input,
    current?: VehicleFull,
    defaultPayload: number | null = null,
  ): Prisma.VehicleUncheckedUpdateInput {
    const data: Prisma.VehicleUncheckedUpdateInput = {};
    const pick = <K extends keyof Input & keyof Vehicle>(k: K) => {
      if (input[k] !== undefined) (data as Record<string, unknown>)[k] = input[k];
    };
    if (input.plate !== undefined) {
      assertPlate(input.plate);
      data.plate = arabicDigits(input.plate);
      data.plateNorm = plateNorm(input.plate);
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
    if (input.chassisNo !== undefined) {
      data.chassisNo = input.chassisNo;
      data.chassisNorm = input.chassisNo === null ? null : chassisNorm(input.chassisNo);
    }
    pick('engineNo');
    pick('brand');
    pick('model');
    pick('year');
    pick('color');
    pick('fuelType');
    pick('tankCapacityL');
    if (input.purchaseCost !== undefined) data.purchaseCost = input.purchaseCost;
    if (input.purchasedOn !== undefined) {
      if (input.purchasedOn && input.purchasedOn > todayTh())
        throw field422('purchasedOn', 'future', 'purchasedOn must not be in the future');
      data.purchasedOn = input.purchasedOn ? new Date(`${input.purchasedOn}T00:00:00Z`) : null;
    }
    pick('depreciationMethod');
    pick('depreciationYears');
    if (input.salvageValue !== undefined) data.salvageValue = input.salvageValue;
    if (input.photoDocumentIds !== undefined)
      data.photoDocumentIds = input.photoDocumentIds.map((d) => tryDecodeId('document', d)!);

    // ---- กฎข้ามช่อง (ค่าหลังแก้ / หลังเติมค่าตั้งต้น) ----
    const eff = <T>(v: T | undefined, cur: T) => (v !== undefined ? v : cur);
    const year = eff(input.year, current?.year ?? null);
    if (year !== null && year > new Date().getUTCFullYear() + 1)
      throw field422('year', 'year_range', 'year must not be later than next year');
    const payload = eff<number | null>(
      input.payloadKg,
      current ? num(current.capacityKg) : defaultPayload,
    );
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

  private dupProblem(field: string, msg: string, dup: Vehicle) {
    return new ProblemException(
      'duplicate',
      undefined,
      [{ field, code: 'duplicate', message: msg }],
      {
        existing: {
          id: encodeId('vehicle', dup.id),
          plate: dup.plate,
          plateProvince: dup.plateProvince,
        },
      },
    );
  }

  private async assertUnique(data: Prisma.VehicleUncheckedUpdateInput, self?: VehicleFull) {
    const tx = this.db.tx;
    const not = self ? { id: { not: self.id } } : {};
    const key = data.plateKey as string | undefined;
    if (key !== undefined && (!self || key !== self.plateKey)) {
      await lockKey(tx, `vehicle.plate:${key}`);
      const dup = await tx.vehicle.findFirst({
        where: { plateKey: key, deletedAt: null, status: { not: 'RETIRED' }, ...not },
      });
      if (dup) throw this.dupProblem('plate', `plate already registered: ${dup.plate}`, dup);
    }
    const cn = data.chassisNorm as string | null | undefined;
    if (cn && cn !== self?.chassisNorm) {
      await lockKey(tx, `vehicle.chassis:${cn}`);
      const dup = await tx.vehicle.findFirst({
        where: { chassisNorm: cn, deletedAt: null, ...not },
      });
      if (dup) throw this.dupProblem('chassisNo', `chassis number used by ${dup.plate}`, dup);
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
      if (dup) throw this.dupProblem('gpsDeviceId', `GPS device used by ${dup.plate}`, dup);
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

  /** รูปรถต้องเป็นไฟล์ของ tenant นี้ (RLS) */
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
   * ตรวจคู่หัวลาก ↔ หาง ก่อนเขียน (ผู้เรียกถือ lock `vehicle.pair` แล้ว)
   * คืนคันคู่ — คันคู่ที่จับกับคันอื่นอยู่ → 409 `already_paired`
   */
  private async checkPair(partnerRef: string, role: string, selfId?: string): Promise<Vehicle> {
    const tx = this.db.tx;
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

  /**
   * อีกฝั่งของการจับคู่: ตั้ง/ล้าง `paired_vehicle_id` ของคันอื่น — เฉพาะเมื่อค่าปัจจุบันยังเป็น `expect`
   * (ล้างคู่ = ล้างเฉพาะแถวที่ชี้กลับมาที่คันนี้จริง) · เพิ่ม version + audit + event ของคันนั้น
   */
  private async setPartnerSide(
    vehicleId: string,
    pairedVehicleId: string | null,
    expect: string | null,
  ) {
    const tx = this.db.tx;
    const before = await tx.vehicle.findUnique({ where: { id: vehicleId }, include: INCLUDE });
    if (!before || before.pairedVehicleId !== expect || expect === pairedVehicleId) return;
    const r = await tx.vehicle.updateMany({
      where: { id: vehicleId, pairedVehicleId: expect },
      data: { pairedVehicleId, version: { increment: 1 } },
    });
    if (r.count !== 1) return;
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
    const data = this.toData(input, undefined, num(vt.capacityKg));
    data.plateKey = plateKey(input.plate, input.plateProvince);
    await this.assertPhotos(input.photoDocumentIds);
    await this.assertUnique(data);
    if (input.externalId) {
      await lockKey(tx, `vehicle.ext:${input.externalId}`);
      await this.assertUniqueExternal(input.externalId);
    }
    const role = input.unitRole ?? 'SINGLE';
    let partner: Vehicle | null = null;
    if (input.pairedVehicleId) {
      await lockKey(tx, 'vehicle.pair');
      partner = await this.checkPair(input.pairedVehicleId, role);
    }
    const now = new Date();
    const created = await tx.vehicle.create({
      data: {
        ...(data as object),
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
    if (partner) await this.setPartnerSide(partner.id, created.id, null);
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
    // เลขไมล์ผ่านทางเดียวกับ POST /odometer: lock ก่อนอ่านแถว (กันบันทึกพร้อมกัน)
    if (input.odometerKm !== undefined) await lockKey(tx, `vehicle.odometer:${id}`);
    const pairing = input.pairedVehicleId !== undefined || input.unitRole !== undefined;
    if (pairing) await lockKey(tx, 'vehicle.pair');
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    if (current.status === 'RETIRED') throw retired409();
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
      data.chassisNorm !== undefined ||
      data.gpsProvider !== undefined ||
      data.gpsDeviceId !== undefined
    )
      await this.assertUnique(data, current);
    if (input.externalId !== undefined) {
      if (input.externalId) await this.assertUniqueExternal(input.externalId, current.id);
      data.externalId = input.externalId;
    }

    // ---- เลขไมล์: ตรวจกับค่าก่อน/หลังตามเวลา (เหมือน POST /odometer) ----
    const now = new Date();
    let odo: number | undefined;
    if (input.odometerKm !== undefined && input.odometerKm !== num(current.odometerKm)) {
      await this.assertTimeline(id, input.odometerKm, now, 'odometerKm');
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
      partner = input.pairedVehicleId
        ? await this.checkPair(input.pairedVehicleId, role, current.id)
        : null;
    else if (input.unitRole !== undefined && input.unitRole !== current.unitRole && current.paired)
      // เปลี่ยนบทบาทขณะจับคู่อยู่ → ต้องปลดคู่ก่อน (หรือส่ง pairedVehicleId: null มาพร้อมกัน)
      throw field422(
        'unitRole',
        'paired',
        `unpair from ${current.paired.plate} before changing unitRole`,
      );
    if (partner !== undefined) data.pairedVehicleId = partner?.id ?? null;

    const changed = !isNoopUpdate(current, data as Record<string, unknown>, DECIMAL_FIELDS);
    if (!changed && odo === undefined) return current; // ส่งซ้ำค่าเดิมไม่เพิ่ม version
    if (odo !== undefined) {
      data.odometerKm = odo;
      data.odometerSource = 'MANUAL';
      data.odometerUpdatedAt = now;
    }
    // ปลดคู่เดิมก่อน (unique ของ paired_vehicle_id) — เฉพาะแถวที่ยังชี้มาที่คันนี้
    if (partner !== undefined && current.pairedVehicleId)
      await this.setPartnerSide(current.pairedVehicleId, null, current.id);
    const v = await this.bumpVersion(current, data);
    if (partner) await this.setPartnerSide(partner.id, v.id, null);
    if (odo !== undefined) await this.insertReading(v.id, odo, now, 'MANUAL');
    const after = partner !== undefined ? await this.get(v.id) : v;
    const b = auditView(current);
    const a = auditView(after);
    await this.audit.changed('vehicle.updated', 'vehicle', v.id, b, a);
    // แก้เฉพาะข้อมูลการเงิน → ไม่ออก event (ผู้รับ webhook ไม่เห็นข้อมูลการเงิน — review ST2-T06)
    const fields = Object.keys(a).filter(
      (k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]) && !FINANCE_AUDIT_KEYS.includes(k),
    );
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
    const retire = status === 'retired';
    if (retire) await lockKey(tx, 'vehicle.pair'); // ปลดคู่สองฝั่งโดยไม่ชนการจับคู่ที่ทำพร้อมกัน
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
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
        if (retire && current.pairedVehicleId)
          await this.setPartnerSide(current.pairedVehicleId, null, current.id);
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
    await lockKey(tx, 'vehicle.pair');
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
    if (current.pairedVehicleId)
      await this.setPartnerSide(current.pairedVehicleId, null, current.id);
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

  /**
   * ค่าใหม่ต้องไม่น้อยกว่าค่า ACCEPTED ก่อนหน้า และไม่มากกว่าค่าหลังจากนั้น (เทียบตามเวลา — FLT-O ข้อ 8)
   * `except` = แถวที่กำลังถูกแก้ (ไม่นับเป็นเพื่อนบ้าน) · คืนค่าก่อนหน้า (ใช้คำนวณ Δ)
   */
  private async assertTimeline(
    vehicleId: string,
    km: number,
    readAt: Date,
    field: string,
    except?: string,
  ): Promise<number | null> {
    const tx = this.db.tx;
    const base = {
      vehicleId,
      status: 'ACCEPTED',
      ...(except ? { id: { not: except } } : {}),
    };
    const [prev, next] = await Promise.all([
      tx.vehicleOdometerReading.findFirst({
        where: { ...base, readAt: { lte: readAt } },
        orderBy: [{ readAt: 'desc' }, { createdAt: 'desc' }],
      }),
      tx.vehicleOdometerReading.findFirst({
        where: { ...base, readAt: { gt: readAt } },
        orderBy: [{ readAt: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);
    const floor = prev ? Number(prev.readingKm) : null;
    if (floor !== null && km < floor)
      throw new ProblemException('validation_failed', undefined, [
        {
          field,
          code: 'odometer_backwards',
          message: `odometer cannot go backwards (previous ${floor} km) — use POST /vehicles/{id}/odometer/correct`,
        },
      ]);
    if (next && km > Number(next.readingKm))
      throw new ProblemException('validation_failed', undefined, [
        {
          field,
          code: 'odometer_after_later',
          message: `reading is higher than a later reading (${Number(next.readingKm)} km)`,
        },
      ]);
    return floor;
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
   * lock `vehicle.odometer:{id}` ก่อนแล้วอ่านแถวใหม่ — คำขอพร้อมกันเข้าคิว ไม่เกิด 412 ปลอม
   * 412 เฉพาะเมื่อส่ง If-Match มาแล้วไม่ตรง · รถปลดระวาง → 409
   */
  private async lockOdometer(id: string, expected?: number): Promise<VehicleFull> {
    await lockKey(this.db.tx, `vehicle.odometer:${id}`);
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    if (current.status === 'RETIRED') throw retired409();
    return current;
  }

  /** บันทึกเลขไมล์ (แหล่ง MANUAL) — ผิดลำดับเวลา → 422 `odometer_backwards` / `odometer_after_later` */
  async record(id: string, input: OdometerReadingInput, expected?: number) {
    const tx = this.db.tx;
    const current = await this.lockOdometer(id, expected);
    const readAt = input.readAt ? new Date(input.readAt) : new Date();
    if (readAt.getTime() > Date.now() + 5 * 60_000)
      throw field422('readAt', 'future', 'readAt must not be in the future');
    const floor = await this.assertTimeline(id, input.readingKm, readAt, 'readingKm');
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

  /**
   * แก้เลขไมล์ที่ผิด (FLT-285): ไม่ทับค่าเดิม — แถวใหม่ (source MANUAL + `originalReadingId`) + แถวเดิม SUPERSEDED
   * แก้แถวไหน = `readingId` (ไม่ส่ง = ล่าสุด) · ค่าใหม่ต้องอยู่ระหว่างค่าก่อน/หลังตามเวลา ยกเว้น METER_REPLACED
   */
  async correct(id: string, input: OdometerCorrectionInput, expected?: number) {
    const tx = this.db.tx;
    const current = await this.lockOdometer(id, expected);
    const rid = input.readingId ? tryDecodeId('odometerReading', input.readingId) : null;
    if (input.readingId && !rid) throw field422('readingId', 'not_found', 'reading not found');
    const target = await tx.vehicleOdometerReading.findFirst({
      where: { vehicleId: id, status: 'ACCEPTED', ...(rid ? { id: rid } : {}) },
      orderBy: [{ readAt: 'desc' }, { createdAt: 'desc' }],
    });
    if (rid && !target)
      throw field422('readingId', 'not_found', 'reading not found or already superseded');
    const readAt = target?.readAt ?? new Date();
    if (input.reasonType !== 'METER_REPLACED')
      await this.assertTimeline(id, input.readingKm, readAt, 'readingKm', target?.id);
    if (target)
      await tx.vehicleOdometerReading.update({
        where: { id: target.id },
        data: { status: 'SUPERSEDED' },
      });
    const r = await this.insertReading(id, input.readingKm, readAt, 'MANUAL', {
      reasonType: input.reasonType,
      note: input.note,
      originalReadingId: target?.id ?? null,
    });
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
      originalReadingId: target ? encodeId('odometerReading', target.id) : null,
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
