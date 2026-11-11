import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type Driver,
  type DriverStatus,
  type EmploymentType,
  type Vehicle,
  type VehicleType,
} from '@prisma/client';
import { scopeAllows, transition, type TransitionTable } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { BlindIndex } from '../../common/blind-index';
import { FieldCipher } from '../../common/crypto';
import { encodeId, tryDecodeId } from '../../common/ids';
import { iEquals } from '../../common/ilike';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { StateService } from '../../state/state.service';
import { EXPORT_MAX_ROWS } from '../master/export';
import {
  assertNotReferenced,
  emitMasterEvent,
  isNoopUpdate,
  likeEscape,
  lockKey,
  masterKeyset,
  nextCode,
  upsertByExternalId,
} from '../master/master-kit';
import {
  addDays,
  bangkokToday,
  daysBetween,
  EXPIRING_DAYS,
  isRealDate,
} from '../vehicle-documents/expiry';
import type {
  CreateDriverDto,
  DriverDto,
  DriverListQuery,
  DriverStatusKey,
  LicenceClass,
  LicenceStatusKey,
  UpdateDriverDto,
  UpsertDriverDto,
} from './driver.dto';

export const DRIVER_CODE_PREFIX = 'DRV';
/** ป้าย/การ์ด "ใบขับขี่ใกล้หมดอายุ 30 วัน" ของต้นแบบ (รวมที่หมดแล้ว) — สถานะ API `expiring` ยังเป็น ≤ 60 วัน */
export const LICENCE_ALERT_DAYS = 30;
/** ดูเลขบัตรประชาชนเต็ม: owner/admin (ผู้ดูแลข้อมูลบุคคล) — spec/06 `driver.sensitive.view` ยังไม่มีใน docs/04 A3 [OPEN spec/12 §3] */
export const REVEAL_SCOPE = 'users:write';
/** ค่าที่แสดงแทนเลขลับ (NFR-304: `•••• 1234`) */
export const mask = (last4: string | null | undefined) => (last4 ? `•••• ${last4}` : null);

type DriverFull = Driver & {
  carrier: { id: string; code: string; legalName: string } | null;
  defaultVehicle: (Vehicle & { vehicleType: Pick<VehicleType, 'nameTh'> }) | null;
};
const INCLUDE = {
  carrier: { select: { id: true, code: true, legalName: true } },
  defaultVehicle: { include: { vehicleType: { select: { nameTh: true } } } },
} as const;

const STATUS_DB: Record<DriverStatusKey, DriverStatus> = {
  active: 'ACTIVE',
  on_leave: 'ON_LEAVE',
  inactive: 'INACTIVE',
};
type DrvEvent = 'to_active' | 'to_leave' | 'deactivate';
const EVENT_FOR: Record<DriverStatusKey, DrvEvent> = {
  active: 'to_active',
  on_leave: 'to_leave',
  inactive: 'deactivate',
};
/** spec/06 FLT-P ข้อ 6: พร้อมใช้ ↔ ลาพัก, ใด ๆ → ปิดใช้งาน, ปิดใช้งาน → พร้อมใช้ (กลับมาทำงาน — ตรวจเบอร์/เลขบัตรซ้ำก่อน) */
export const DRIVER_TRANSITIONS: TransitionTable<DriverStatus, DrvEvent> = {
  ACTIVE: { to_leave: 'ON_LEAVE', deactivate: 'INACTIVE' },
  ON_LEAVE: { to_active: 'ACTIVE', deactivate: 'INACTIVE' },
  INACTIVE: { to_active: 'ACTIVE' },
};

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * เบอร์ไทย → 0XXXXXXXX(X): ตัดทุกอย่างที่ไม่ใช่ตัวเลข, +66 → 0 (+66 ตามด้วย 0 ซ้ำ เช่น "+66 02 …" → ตัด 0 ที่เกิน)
 * migration 0045 ใช้สูตรเดิม (ไม่มีแถวเดิม) — service เข้มกว่า (review ST2-T08)
 */
export function phoneNorm(phone: string): string {
  const d = phone.replace(/\D/g, '');
  if (!d.startsWith('66') || d.length < 10) return d;
  const rest = d.slice(2);
  return rest.startsWith('0') ? rest : `0${rest}`;
}

/** มือถือ 0[689] + 8 หลัก (10 หลัก) · บ้าน/สำนักงาน 0[2-7] + 7 หลัก (9 หลัก) */
export function isThaiPhone(norm: string): boolean {
  return /^0[689]\d{8}$/.test(norm) || /^0[2-7]\d{7}$/.test(norm);
}

/** สถานะใบขับขี่ตามวันหมด (ฟังก์ชันบริสุทธิ์ — test ส่งวันคงที่ได้) */
export function licenceStatus(
  expiresOn: string | null,
  today: string,
): { status: LicenceStatusKey; days: number | null } {
  if (!expiresOn) return { status: 'missing', days: null };
  const days = daysBetween(today, expiresOn);
  if (days < 0) return { status: 'expired', days };
  if (days <= EXPIRING_DAYS) return { status: 'expiring', days };
  return { status: 'valid', days };
}

export function toDriverDto(d: DriverFull, today = bangkokToday()): DriverDto {
  const expires = day(d.licenceExpiresAt);
  const lic = licenceStatus(expires, today);
  const v = d.defaultVehicle;
  return {
    id: encodeId('driver', d.id),
    code: d.code,
    externalId: d.externalId,
    name: d.name,
    phone: d.phone,
    nationalIdLast4: d.nationalIdLast4,
    licenceNo: d.licenceNo,
    licenceClass: d.licenceClass as LicenceClass | null,
    licenceExpiresOn: expires,
    licenceStatus: lic.status,
    licenceDaysToExpiry: lic.days,
    employmentType: d.employmentType,
    carrier: d.carrier
      ? {
          id: encodeId('carrier', d.carrier.id),
          code: d.carrier.code,
          legalName: d.carrier.legalName,
        }
      : null,
    defaultVehicle: v
      ? {
          id: encodeId('vehicle', v.id),
          plate: v.plate,
          plateProvince: v.plateProvince,
          vehicleTypeName: v.vehicleType.nameTh,
          status: v.status.toLowerCase(),
        }
      : null,
    status: d.status.toLowerCase() as DriverStatusKey,
    statusReason: d.statusReason,
    ...(d.deletedAt ? { deletedAt: d.deletedAt.toISOString() } : {}),
    version: d.version,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

/**
 * snapshot สำหรับ audit — ไม่มีเลขบัตรเต็ม (เป็น `•••• 1234`) ไม่มี updatedAt/version/สถานะใบขับขี่ (ค่าคำนวณตามวัน)
 * รถร่วม/รถประจำเก็บเป็นรหัส/ทะเบียน ให้ diff อ่านง่าย
 */
export function auditView(d: DriverFull): Record<string, unknown> {
  const {
    updatedAt: _u,
    version: _v,
    licenceStatus: _s,
    licenceDaysToExpiry: _d,
    nationalIdLast4: _n,
    carrier: _c,
    defaultVehicle: _dv,
    ...rest
  } = toDriverDto(d);
  return {
    ...rest,
    nationalId: mask(d.nationalIdLast4),
    carrierId: d.carrier ? d.carrier.code : null,
    defaultVehicleId: d.defaultVehicle
      ? `${d.defaultVehicle.plate} ${d.defaultVehicle.plateProvince}`
      : null,
  };
}

type Input = CreateDriverDto | UpdateDriverDto | UpsertDriverDto;

/**
 * คนขับ (ST2-T08; docs/04 B คนขับ, docs/01 §3.2, spec/06 FLT-P) — ใช้ master kit ของ ST2-T01
 * - เลขบัตรประชาชนเข้ารหัสด้วย FieldCipher + 4 หลักท้าย + blind index (กันซ้ำ) — response/audit/event/export ไม่มีเลขเต็ม
 *   ดูเลขเต็มได้ทาง `reveal` (สิทธิ์ users:write) และลง audit ทุกครั้ง (spec/11 NFR-153)
 * - คนขับรถร่วม (CARRIER_DRIVER) ต้องผูกผู้รับเหมา · คนขับบริษัทผูกไม่ได้ (CHECK ใน DB ด้วย)
 * - รถประจำ: ไม่ปลดระวาง ไม่ใช่หาง · คนขับรถร่วม = รถของผู้รับเหมาเดียวกัน · คนขับบริษัท = รถบริษัท
 * - สถานะใบขับขี่คำนวณจากวันหมด (valid/expiring ≤ 60/expired/missing) — job เตือน ST2-T18 / isAssignable ST2-T20 ใช้ต่อ
 * - คนขับไม่ใช่ผู้ใช้/seat (แอปคนขับ = เฟส 2 — login OTP ด้วยเบอร์ จึงห้ามเบอร์ซ้ำ)
 */
@Injectable()
export class DriversService {
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

  // ---------- read ----------

  /** ชื่อบริษัทของ tenant (สังกัดของคนขับบริษัท — ต้นแบบคอลัมน์ "สังกัด") */
  private async tenantName(): Promise<string> {
    const id = requestContext.require().tenantId!;
    const t = await this.db.tx.tenant.findUnique({ where: { id }, select: { name: true } });
    return t?.name ?? '';
  }

  private async where(q: DriverListQuery): Promise<Prisma.DriverWhereInput> {
    const and: Prisma.DriverWhereInput[] = [q.includeDeleted === 'true' ? {} : { deletedAt: null }];
    if (q.status)
      and.push({ status: { in: q.status.split(',').map((s) => STATUS_DB[s as DriverStatusKey]) } });
    if (q.externalId) and.push({ externalId: q.externalId });
    if (q.employmentType) and.push({ employmentType: q.employmentType });
    if (q.licenceClass) and.push({ licenceClass: q.licenceClass });
    if (q.carrierId) and.push({ carrierId: tryDecodeId('carrier', q.carrierId) ?? undefined });
    if (q.defaultVehicleId)
      and.push({ defaultVehicleId: tryDecodeId('vehicle', q.defaultVehicleId) ?? undefined });
    const like = (v: string) => ({ contains: likeEscape(v), mode: 'insensitive' as const });
    if (q.name) and.push({ name: like(q.name) });
    if (q.affiliation) {
      const own = (await this.tenantName())
        .toLocaleLowerCase('th')
        .includes(q.affiliation.toLocaleLowerCase('th'));
      and.push({
        OR: [
          { carrier: { legalName: like(q.affiliation) } },
          ...(own ? [{ employmentType: { not: 'CARRIER_DRIVER' as EmploymentType } }] : []),
        ],
      });
    }
    if (q.licenceAlert) {
      const alert: Prisma.DriverWhereInput = {
        status: { not: 'INACTIVE' },
        licenceExpiresAt: {
          lt: new Date(`${addDays(bangkokToday(), LICENCE_ALERT_DAYS)}T00:00:00Z`),
        },
      };
      // false: เขียนเป็น OR ชัด ๆ — NOT(...) กับวันหมด NULL ได้ NULL ใน SQL → คนขับไม่มีวันหมดหายจากทั้งสองฝั่ง (review)
      // คนขับไม่มีวันหมด (missing) ไม่นับเป็น "ใกล้หมด" — API บังคับวันหมดตอนสร้างอยู่แล้ว [DECISION spec/12 §3]
      and.push(
        q.licenceAlert === 'true'
          ? alert
          : {
              OR: [
                { status: 'INACTIVE' },
                { licenceExpiresAt: null },
                { licenceExpiresAt: { gte: (alert.licenceExpiresAt as { lt: Date }).lt } },
              ],
            },
      );
    }
    if (q.q) {
      const digits = q.q.replace(/[\s-]/g, '');
      and.push({
        OR: [
          { code: like(q.q) },
          { name: like(q.q) },
          { externalId: like(q.q) },
          { licenceNo: like(q.q) },
          ...(/^\+?\d{3,12}$/.test(digits) ? [{ phoneNorm: { contains: phoneNorm(digits) } }] : []),
          // เลขบัตรเต็มเข้ารหัส — ค้นได้เฉพาะ 4 หลักท้าย
          ...(/^\d{4}$/.test(digits) ? [{ nationalIdLast4: digits }] : []),
        ],
      });
    }
    return { AND: and };
  }

  async list(q: DriverListQuery) {
    const k = masterKeyset(q);
    const rows = await this.db.tx.driver.findMany({
      where: { AND: [await this.where(q), k.where] },
      orderBy: k.orderBy,
      take: k.take,
      include: INCLUDE,
    });
    const today = bangkokToday();
    return k.page(rows, (r) => toDriverDto(r, today));
  }

  /** แถวสำหรับส่งออก (ตามตัวกรองเดียวกับ list หรือ id ที่เลือก) — เกินเพดาน → 422 */
  async exportRows(q: DriverListQuery & { ids?: string }) {
    const ids = q.ids?.split(',').map((x) => tryDecodeId('driver', x)!);
    const base = await this.where(q);
    const rows = await this.db.tx.driver.findMany({
      where: ids ? { AND: [base, { id: { in: ids } }] } : base,
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
    const today = bangkokToday();
    return rows.map((r) => toDriverDto(r, today));
  }

  async summary() {
    const tx = this.db.tx;
    const soon = new Date(`${addDays(bangkokToday(), LICENCE_ALERT_DAYS)}T00:00:00Z`);
    const [g, alert] = await Promise.all([
      tx.driver.groupBy({
        by: ['status', 'employmentType'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
      tx.driver.count({
        where: { deletedAt: null, status: { not: 'INACTIVE' }, licenceExpiresAt: { lt: soon } },
      }),
    ]);
    const n = (f: (x: (typeof g)[number]) => boolean) =>
      g.filter(f).reduce((a, x) => a + x._count._all, 0);
    return {
      total: n(() => true),
      active: n((x) => x.status === 'ACTIVE'),
      onLeave: n((x) => x.status === 'ON_LEAVE'),
      inactive: n((x) => x.status === 'INACTIVE'),
      licenceAlert: alert,
      carrierDrivers: n((x) => x.status !== 'INACTIVE' && x.employmentType === 'CARRIER_DRIVER'),
    };
  }

  async nextCode(): Promise<string> {
    return nextCode(this.db.tx, 'driver', DRIVER_CODE_PREFIX);
  }

  async get(id: string): Promise<DriverFull> {
    const d = await this.db.tx.driver.findFirst({
      where: { id, deletedAt: null },
      include: INCLUDE,
    });
    if (!d) throw new ProblemException('not_found');
    return d;
  }

  async getByExternalId(externalId: string): Promise<DriverFull> {
    const d = await this.db.tx.driver.findFirst({
      where: { externalId, deletedAt: null },
      include: INCLUDE,
    });
    if (!d) throw new ProblemException('not_found');
    return d;
  }

  dto(d: DriverFull): DriverDto {
    return toDriverDto(d);
  }

  /** เลขบัตรประชาชนเต็ม (ถอดรหัส) — ลง audit `driver.pii_revealed` (spec/11 NFR-153) */
  async reveal(d: DriverFull, reason: string): Promise<string | null> {
    let value: string | null = null;
    if (d.nationalIdEnc)
      try {
        value = this.cipher.decrypt(d.nationalIdEnc);
      } catch {
        // กุญแจเดิมถูกถอดออกแล้ว → 409 (ไม่ใช่ 500)
        throw new ProblemException('secret_unreadable', 'nationalId cannot be decrypted', [
          {
            field: 'nationalId',
            code: 'secret_unreadable',
            message: 'stored value cannot be decrypted',
          },
        ]);
      }
    await this.audit.record({
      action: 'driver.pii_revealed',
      entityType: 'driver',
      entityId: d.id,
      after: { field: 'nationalId' },
      reason,
    });
    return value;
  }

  // ---------- write ----------

  /** ผู้รับเหมาต้นสังกัด: อยู่ใน tenant ไม่ถูกลบ และใช้งานอยู่ (ค่าเดิมที่ไม่เปลี่ยนไม่ตรวจซ้ำ) */
  private async resolveCarrier(ref: string): Promise<string> {
    const id = tryDecodeId('carrier', ref);
    const c = id
      ? await this.db.tx.carrier.findFirst({
          where: { id, deletedAt: null },
          select: { id: true, status: true },
        })
      : null;
    if (!c) throw field422('carrierId', 'not_found', 'carrier not found');
    if (c.status !== 'ACTIVE') throw field422('carrierId', 'inactive', 'carrier is suspended');
    return c.id;
  }

  /**
   * รถประจำ: อยู่ใน tenant ไม่ถูกลบ ไม่ปลดระวาง ไม่ใช่หาง (ไม่มีคนขับ) และเจ้าของตรงกับประเภทคนขับ
   * (คนขับรถร่วม = รถ SUBCONTRACT ของผู้รับเหมาเดียวกัน · คนขับบริษัท = รถ OWN)
   */
  private async checkVehicle(vehicleId: string, type: EmploymentType, carrierId: string | null) {
    const v = await this.db.tx.vehicle.findFirst({ where: { id: vehicleId, deletedAt: null } });
    if (!v) throw field422('defaultVehicleId', 'not_found', 'vehicle not found');
    if (v.status === 'RETIRED')
      throw field422('defaultVehicleId', 'vehicle_retired', 'vehicle is retired');
    if (v.unitRole === 'TRAILER')
      throw field422(
        'defaultVehicleId',
        'vehicle_trailer',
        'a trailer cannot be a default vehicle',
      );
    if (type === 'CARRIER_DRIVER') {
      if (v.ownership !== 'SUBCONTRACT' || v.carrierId !== carrierId)
        throw field422(
          'defaultVehicleId',
          'vehicle_other_carrier',
          "a carrier driver's default vehicle must belong to the same carrier",
        );
    } else if (v.ownership !== 'OWN')
      throw field422(
        'defaultVehicleId',
        'vehicle_not_own',
        "a company driver's default vehicle must be a company vehicle",
      );
  }

  /**
   * แปลง DTO → คอลัมน์ (รวมการเข้ารหัส) — `current` = แถวเดิม (ตอนแก้)
   * เลขบัตรที่ส่งมาเท่าเดิม (blind index เท่ากัน) ไม่เขียนใหม่ → ส่งซ้ำไม่เพิ่ม version
   * คืน `secret` = เลขบัตรเปลี่ยนจริง (ใช้ทำ audit)
   */
  private async toData(
    input: Input,
    current?: DriverFull,
  ): Promise<{
    data: Prisma.DriverUncheckedUpdateInput;
    secret: boolean;
    /** เลขเดิมต้องเข้ารหัสใหม่ด้วย key ปัจจุบัน (หมุน key) — เขียนแยก ไม่นับเป็นการแก้ ไม่เพิ่ม version */
    rotate?: string;
  }> {
    const data: Prisma.DriverUncheckedUpdateInput = {};
    let secret = false;
    let rotate: string | undefined;
    if (input.name !== undefined) data.name = input.name;
    if (input.phone !== undefined) {
      const norm = phoneNorm(input.phone);
      if (!isThaiPhone(norm))
        throw field422('phone', 'matches', 'phone must be a Thai phone number');
      data.phone = input.phone;
      data.phoneNorm = norm;
    }
    if (input.nationalId !== undefined) {
      if (input.nationalId === null) {
        data.nationalIdEnc = null;
        data.nationalIdLast4 = null;
        data.nationalIdHash = null;
        secret = !!current?.nationalIdEnc;
      } else {
        const hash = this.blind.of(input.nationalId);
        const same = !!current?.nationalIdEnc && current.nationalIdHash === hash;
        if (same && this.cipher.needsRotation(current.nationalIdEnc!))
          rotate = this.cipher.encrypt(input.nationalId);
        if (!same) {
          data.nationalIdEnc = this.cipher.encrypt(input.nationalId);
          data.nationalIdLast4 = input.nationalId.slice(-4);
          data.nationalIdHash = hash;
          secret = !!current && current.nationalIdHash !== hash;
        }
      }
    }
    if (input.licenceNo !== undefined) data.licenceNo = input.licenceNo;
    if (input.licenceClass !== undefined) data.licenceClass = input.licenceClass;
    if (input.licenceExpiresOn !== undefined) {
      const d = input.licenceExpiresOn;
      if (!isRealDate(d) || d < '2000-01-01' || d > '2100-12-31')
        throw field422(
          'licenceExpiresOn',
          'invalid_date',
          'licenceExpiresOn must be a real date 2000–2100',
        );
      data.licenceExpiresAt = new Date(`${d}T00:00:00Z`);
    }

    // ---- ประเภท + ผู้รับเหมา (docs/01 §3.2: carrier_id บังคับเมื่อ CARRIER_DRIVER) ----
    const type = (input.employmentType ?? current?.employmentType) as EmploymentType;
    if (input.employmentType !== undefined) data.employmentType = input.employmentType;
    let carrierId: string | null = current?.carrierId ?? null;
    if (input.carrierId !== undefined) {
      if (input.carrierId === null) carrierId = null;
      else {
        const same =
          !!current?.carrierId && tryDecodeId('carrier', input.carrierId) === current.carrierId;
        carrierId = same ? current!.carrierId : await this.resolveCarrier(input.carrierId);
      }
    }
    if (type === 'CARRIER_DRIVER' && !carrierId)
      throw field422('carrierId', 'carrier_required', 'carrierId is required for CARRIER_DRIVER');
    if (type !== 'CARRIER_DRIVER' && carrierId) {
      // เปลี่ยนจากคนขับรถร่วมเป็นคนขับบริษัทโดยไม่ส่ง carrierId → ล้างให้ (ส่ง carrierId มาเอง = ผิด)
      if (input.carrierId !== undefined && input.carrierId !== null)
        throw field422(
          'carrierId',
          'carrier_not_allowed',
          'only CARRIER_DRIVER can have carrierId',
        );
      carrierId = null;
    }
    if (!current || carrierId !== current.carrierId) data.carrierId = carrierId;

    // ---- รถประจำ: ตรวจเมื่อเปลี่ยนรถ หรือเปลี่ยนประเภท/ผู้รับเหมาแล้วรถเดิมไม่ตรง ----
    let vehicleId: string | null = current?.defaultVehicleId ?? null;
    if (input.defaultVehicleId !== undefined) {
      vehicleId =
        input.defaultVehicleId === null ? null : tryDecodeId('vehicle', input.defaultVehicleId);
      if (input.defaultVehicleId !== null && !vehicleId)
        throw field422('defaultVehicleId', 'not_found', 'vehicle not found');
    }
    const ownerChanged =
      !!current && (type !== current.employmentType || carrierId !== current.carrierId);
    if (vehicleId && (vehicleId !== current?.defaultVehicleId || ownerChanged))
      await this.checkVehicle(vehicleId, type, carrierId);
    if (!current || vehicleId !== current.defaultVehicleId) data.defaultVehicleId = vehicleId;
    return { data, secret, ...(rotate ? { rotate } : {}) };
  }

  /**
   * 409 ซ้ำ: เบอร์ซ้ำ → บอกคนขับเดิม · เลขบัตรซ้ำ → บอกคนขับเดิมเฉพาะผู้มีสิทธิ์ดูเลขบัตร (users:write)
   * และบันทึก audit `driver.national_id_duplicate` แยก transaction (กันใช้การสร้างคนขับเดาเลขบัตรของคนอื่น — review ST2-T08)
   */
  private async dupProblem(field: 'phone' | 'nationalId', dup: Driver) {
    const showWho =
      field === 'phone' || scopeAllows(requestContext.require().scopes ?? [], REVEAL_SCOPE);
    if (field === 'nationalId')
      await this.audit.recordDetached({
        action: 'driver.national_id_duplicate',
        entityType: 'driver',
        entityId: dup.id,
        after: { field: 'nationalId' },
      });
    return new ProblemException(
      'duplicate',
      undefined,
      [
        {
          field,
          code: 'duplicate',
          message: showWho ? `driver already exists: ${dup.code}` : 'already exists',
        },
      ],
      showWho
        ? { existing: { id: encodeId('driver', dup.id), code: dup.code, name: dup.name } }
        : undefined,
    );
  }

  /**
   * เบอร์/เลขบัตรห้ามซ้ำกับคนขับที่ยังไม่ปิดใช้งาน (unique index บางส่วน — ตรวจก่อนให้ได้ 409 พร้อมรายการเดิม)
   * `force` = ตรวจค่าปัจจุบันแม้ไม่ได้ส่งมา (เปิดใช้คนขับที่ปิดไว้กลับมา)
   */
  private async assertUnique(
    data: Prisma.DriverUncheckedUpdateInput,
    current?: Driver,
    force = false,
  ) {
    const tx = this.db.tx;
    const phone = (data.phoneNorm ?? (force ? current?.phoneNorm : undefined)) as
      string | undefined;
    const hash = (data.nationalIdHash ?? (force ? current?.nationalIdHash : undefined)) as
      string | null | undefined;
    const others = {
      deletedAt: null,
      status: { not: 'INACTIVE' as DriverStatus },
      ...(current ? { id: { not: current.id } } : {}),
    };
    if (phone && (force || phone !== current?.phoneNorm)) {
      await lockKey(tx, `driver.phone:${phone}`);
      const dup = await tx.driver.findFirst({ where: { ...others, phoneNorm: phone } });
      if (dup) throw await this.dupProblem('phone', dup);
    }
    if (hash && (force || hash !== current?.nationalIdHash)) {
      await lockKey(tx, `driver.nid:${hash}`);
      const dup = await tx.driver.findFirst({ where: { ...others, nationalIdHash: hash } });
      if (dup) throw await this.dupProblem('nationalId', dup);
    }
  }

  private async assertUniqueExternal(externalId: string, exceptId?: string) {
    const dup = await this.db.tx.driver.findFirst({
      where: { externalId, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (dup)
      throw new ProblemException('duplicate', undefined, [
        { field: 'externalId', code: 'duplicate', message: 'externalId already used' },
      ]);
  }

  async create(input: CreateDriverDto | (UpsertDriverDto & { externalId: string })) {
    const tx = this.db.tx;
    const { data } = await this.toData(input);
    await this.assertUnique(data);
    if (input.externalId) {
      await lockKey(tx, `driver.ext:${input.externalId}`);
      await this.assertUniqueExternal(input.externalId);
    }
    await lockKey(tx, 'driver.code');
    let code = input.code;
    if (code) {
      const taken = await tx.driver.findFirst({
        where: { code: iEquals(code) },
        select: { id: true },
      });
      if (taken)
        throw new ProblemException('duplicate', undefined, [
          { field: 'code', code: 'duplicate', message: 'code already exists' },
        ]);
    } else code = await nextCode(tx, 'driver', DRIVER_CODE_PREFIX);
    const created = await tx.driver.create({
      data: {
        ...(data as object),
        code,
        externalId: input.externalId ?? null,
      } as Prisma.DriverUncheckedCreateInput, // tenantId เติมโดย tenantExtension
    });
    const d = await this.get(created.id);
    await this.audit.record({
      action: 'driver.created',
      entityType: 'driver',
      entityId: d.id,
      after: auditView(d),
    });
    await emitMasterEvent(tx, 'driver.created', 'driver', d.id, toDriverDto(d));
    return d;
  }

  async update(id: string, input: UpdateDriverDto, expected?: number): Promise<DriverFull> {
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    const inactive409 = () =>
      new ProblemException('conflict', 'driver is inactive (read-only)', [
        {
          field: 'status',
          code: 'driver_inactive',
          message: 'reactivate the driver before editing',
        },
      ]);
    // คนขับปิดใช้งาน = อ่านอย่างเดียว แต่ส่งซ้ำค่าเดิม (PUT external จาก HR/ERP) → 200 คืนค่าเดิม (review ST2-T08)
    let built: Awaited<ReturnType<DriversService['toData']>>;
    try {
      built = await this.toData(input, current);
    } catch (e) {
      if (current.status === 'INACTIVE') throw inactive409();
      throw e;
    }
    const { data, secret, rotate } = built;
    if (input.externalId !== undefined) data.externalId = input.externalId;
    const noop = isNoopUpdate(current, data as Record<string, unknown>);
    if (current.status === 'INACTIVE' && !noop) throw inactive409();
    if (noop) {
      if (rotate) await this.rotateSecret(current, rotate);
      return current; // ส่งซ้ำค่าเดิมไม่เพิ่ม version
    }
    await this.assertUnique(data, current);
    if (input.externalId) await this.assertUniqueExternal(input.externalId, current.id);
    if (rotate) data.nationalIdEnc = rotate;
    const d = await this.bumpVersion(current, data);
    const before = auditView(current);
    const after = auditView(d);
    // เลขบัตรเปลี่ยนแต่ 4 หลักท้ายเท่าเดิม → ค่าก่อนเป็น •••• (ประวัติเห็นว่าเปลี่ยน โดยไม่มีเลขเต็ม)
    if (secret && before.nationalId === after.nationalId) before.nationalId = '••••';
    await this.audit.changed('driver.updated', 'driver', d.id, before, after);
    const changed = Object.keys(after).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    if (changed.length)
      await emitMasterEvent(this.db.tx, 'driver.updated', 'driver', d.id, toDriverDto(d), {
        changedFields: changed,
      });
    return d;
  }

  /** PUT /drivers/external/{externalId} — idempotent (ส่งซ้ำ = อัปเดตแถวเดิม) */
  async upsertExternal(externalId: string, input: UpsertDriverDto, expected?: number) {
    const tx = this.db.tx;
    return upsertByExternalId(tx, 'driver', externalId, {
      find: () => tx.driver.findFirst({ where: { externalId, deletedAt: null }, include: INCLUDE }),
      create: () => this.create({ ...input, externalId }),
      update: (cur) => {
        const { code: _code, ...rest } = input;
        return this.update(cur.id, rest, expected);
      },
    });
  }

  /** เปลี่ยนสถานะ (เหตุผล ≥ 10 ทุกครั้ง) — เปิดใช้คนขับที่ปิดไว้กลับมา: ตรวจเบอร์/เลขบัตรซ้ำกับคนขับที่ใช้งานอยู่ก่อน */
  async changeStatus(id: string, status: DriverStatusKey, reason: string, expected?: number) {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    // ตรวจ transition ก่อน (inactive → on_leave = 409) แล้วค่อยตรวจข้อมูลอ้างอิงและการซ้ำ (review ST2-T08)
    transition('driver', DRIVER_TRANSITIONS, current.status, EVENT_FOR[status]);
    if (current.status === 'INACTIVE' && status !== 'inactive') {
      // ระหว่างปิดใช้งาน ผู้รับเหมาอาจถูกระงับ/ลบ → ต้องผูกใหม่ก่อนเปิดใช้ (422 จาก resolveCarrier)
      if (current.carrierId) await this.resolveCarrier(encodeId('carrier', current.carrierId));
      if (current.defaultVehicleId)
        await this.checkVehicle(
          current.defaultVehicleId,
          current.employmentType,
          current.carrierId,
        );
      await this.assertUnique({}, current, true);
    }
    const event =
      status === 'inactive'
        ? 'driver.deactivated'
        : current.status === 'INACTIVE'
          ? 'driver.reactivated'
          : 'driver.status_changed';
    let updated!: DriverFull;
    await this.state.transition(tx, {
      docType: 'driver',
      docId: id,
      table: DRIVER_TRANSITIONS,
      from: current.status,
      event: EVENT_FOR[status],
      note: reason,
      eventType: event,
      apply: async (to) => {
        // ปิดใช้งาน = ล้างรถประจำ (รถไม่ติดคนขับที่พ้นสภาพ — ลบ/ปลดระวางรถได้) · ลง audit ในรายการเดียวกัน
        updated = await this.bumpVersion(current, {
          status: to,
          statusReason: reason,
          ...(to === 'INACTIVE' ? { defaultVehicleId: null } : {}),
        });
        await this.audit.changed(
          event,
          'driver',
          id,
          auditView(current),
          auditView(updated),
          reason,
        );
        return toDriverDto(updated) as unknown as Record<string, unknown>;
      },
    });
    return updated;
  }

  /** MD-004: ลบได้เฉพาะที่ไม่เคยถูกอ้างอิง (เที่ยว) → soft delete; ถูกอ้างอิง → 409 `in_use` (ให้ปิดใช้งานแทน) */
  async remove(id: string, reason: string, expected?: number): Promise<void> {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    await assertNotReferenced(
      [{ name: 'trips', count: () => tx.trip.count({ where: { driverId: id } }) }],
      { action: 'deactivate', th: 'ปิดใช้', en: 'deactivate' },
    );
    await this.bumpVersion(current, {
      defaultVehicleId: null, // ไม่ให้คนขับที่ลบแล้วกันการลบ/ปลดระวางรถ
      deletedAt: new Date(),
      externalId: null,
      deletedExternalId: current.externalId,
    });
    await this.audit.record({
      action: 'driver.deleted',
      entityType: 'driver',
      entityId: id,
      before: auditView(current),
      reason,
    });
    await emitMasterEvent(tx, 'driver.deleted', 'driver', id, toDriverDto(current));
  }

  /** หมุน key: เข้ารหัสเลขเดิมใหม่โดยไม่เพิ่ม version/updatedAt (ไม่ใช่การแก้ข้อมูล — ไม่ลง audit/event) */
  private async rotateSecret(current: Driver, enc: string) {
    await this.db.tx.driver.updateMany({
      where: { id: current.id, version: current.version },
      data: { nationalIdEnc: enc, updatedAt: current.updatedAt },
    });
  }

  /** optimistic lock: update เฉพาะเมื่อ version ยังเท่าเดิม ไม่งั้น 412 */
  private async bumpVersion(
    current: Driver,
    data: Prisma.DriverUncheckedUpdateInput,
  ): Promise<DriverFull> {
    const r = await this.db.tx.driver.updateMany({
      where: { id: current.id, version: current.version, deletedAt: null },
      data: { ...data, version: { increment: 1 } },
    });
    if (r.count !== 1) throw new ProblemException('precondition_failed');
    return (await this.db.tx.driver.findUnique({ where: { id: current.id }, include: INCLUDE }))!;
  }
}
