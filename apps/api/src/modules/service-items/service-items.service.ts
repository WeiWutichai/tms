import { Injectable } from '@nestjs/common';
import { Prisma, type ActiveStatus, type ServiceItem } from '@prisma/client';
import { serviceItemTaxNote, type TransitionTable } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { encodeId, tryDecodeId } from '../../common/ids';
import { iEquals } from '../../common/ilike';
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
  lockForRemoval,
  lockKey,
  lockReferenced,
  masterKeyset,
  nextCode,
  statusFilter,
  upsertByExternalId,
} from '../master/master-kit';
import {
  CALC_UNIT_LABEL,
  type CalcUnit,
  type CreateServiceItemDto,
  type ServiceItemDto,
  type ServiceItemListQuery,
  type ServiceItemSide,
  type ServiceItemVatType,
  type ServiceItemWhtRate,
  type UpdateServiceItemDto,
  type UpsertServiceItemDto,
} from './service-item.dto';
import { sideAllows, snapshotServiceItem, type ServiceItemSnapshot } from './snapshot';

export const SERVICE_ITEM_CODE_PREFIX = 'AX';
/**
 * รหัสสงวนของระบบ (spec/02 MD-158) — ใช้โดยงานอัตโนมัติ/rate card: ลบ/ปิดใช้/เปลี่ยนรหัสไม่ได้ แก้ชื่อและธงภาษีได้
 * (`DISCOUNT` ของ spec ยังไม่ใส่ — ภาษีตามบรรทัดที่ลด เป็นงาน ST5)
 */
export const RESERVED_SYSTEM_KEYS = ['FREIGHT', 'EXTRA_STOP', 'FSC'] as const;
/** รหัสที่ผู้ใช้ตั้งเองไม่ได้ (สร้าง/เปลี่ยนรหัสเป็นค่านี้ → 422 `reserved_code`) — รวม DISCOUNT ที่จะมากับ ST5 */
export const RESERVED_CODES = ['FREIGHT', 'EXTRA_STOP', 'FSC', 'DISCOUNT'] as const;
/** ฟิลด์ของรายการสงวนที่ผูกกับงานอัตโนมัติ/rate card — แก้ไม่ได้ (422 `reserved_field`) */
const RESERVED_LOCKED = ['calcUnit', 'side', 'isSurcharge'] as const;
const DECIMAL_FIELDS = ['defaultPrice', 'fuelRefPrice', 'whtRate'] as const;
type SiEvent = 'activate' | 'deactivate';
export const SERVICE_ITEM_TRANSITIONS: TransitionTable<ActiveStatus, SiEvent> = {
  ACTIVE: { deactivate: 'INACTIVE' },
  INACTIVE: { activate: 'ACTIVE' },
};

type Usage = { rateCards: number; doSurcharges: number };
const NO_USAGE: Usage = { rateCards: 0, doSurcharges: 0 };

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

const money = (d: Prisma.Decimal | null) => (d === null ? null : d.toFixed(2));
const isReserved = (s: ServiceItem) =>
  s.systemKey !== null && (RESERVED_SYSTEM_KEYS as readonly string[]).includes(s.systemKey);

export function toServiceItemDto(s: ServiceItem, usage: Usage = NO_USAGE): ServiceItemDto {
  return {
    id: encodeId('serviceItem', s.id),
    code: s.code,
    externalId: s.externalId,
    name: s.nameTh,
    nameEn: s.nameEn,
    calcUnit: s.calcUnit as CalcUnit,
    unitLabel: s.unitLabel,
    defaultPrice: money(s.defaultPrice),
    fuelRefPrice: money(s.fuelRefPrice),
    condition: s.conditionText,
    vatType: s.vatType as ServiceItemVatType,
    whtRate: s.whtRate.toFixed(2) as ServiceItemWhtRate,
    side: s.side as ServiceItemSide,
    isSurcharge: s.isSurcharge,
    defaultAccountCode: s.defaultAccountCode,
    system: s.systemKey !== null,
    reserved: isReserved(s),
    usage,
    status: s.status.toLowerCase() as ServiceItemDto['status'],
    ...(s.deletedAt ? { deletedAt: s.deletedAt.toISOString() } : {}),
    version: s.version,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/** snapshot สำหรับ audit — ไม่มี updatedAt/version/usage/unitLabel (ตาม calcUnit) */
export function auditView(s: ServiceItem): Record<string, unknown> {
  const { updatedAt: _u, version: _v, usage: _x, unitLabel: _l, ...rest } = toServiceItemDto(s);
  return rest;
}

/**
 * ค่าบริการเสริม (ST2-T11; docs/04 B Accessorial catalog, docs/01 §3.2, spec/02 §6) — master kit ของ ST2-T01
 * - vat_type/wht_rate เป็นค่าตั้งต้นของบรรทัด: เอกสารคัดลอกด้วย `snapshotFor()` (snapshot.ts) แก้ catalog ภายหลังไม่กระทบ
 * - คู่ VAT × WHT ที่ไม่ปกติ = คำเตือน `warnings` (ไม่บล็อก) จาก `serviceItemTaxNote` (@tms/domain) ที่เดียว
 * - ปิดใช้ได้แม้มีเอกสารอ้างอิง (เอกสารเก็บ snapshot) · ลบได้เฉพาะที่ไม่เคยถูกอ้างอิง (MD-004)
 * - รหัสสงวน FREIGHT/EXTRA_STOP/FSC ปิดใช้/ลบ/เปลี่ยนรหัสไม่ได้ (MD-158) · แถวระบบอื่นเหมือนแถวทั่วไป
 */
@Injectable()
export class ServiceItemsService {
  constructor(
    private readonly db: DbService,
    private readonly state: StateService,
    private readonly audit: AuditService,
  ) {}

  // ---------- read ----------

  private where(q: ServiceItemListQuery): Prisma.ServiceItemWhereInput {
    const and: Prisma.ServiceItemWhereInput[] = [deletedFilter(q)];
    const status = statusFilter(q.status);
    if (status) and.push({ status });
    if (q.externalId) and.push({ externalId: q.externalId });
    if (q.calcUnit) and.push({ calcUnit: q.calcUnit });
    if (q.vatType) and.push({ vatType: q.vatType });
    if (q.side) and.push({ side: q.side === 'BOTH' ? 'BOTH' : { in: [q.side, 'BOTH'] } });
    const like = (v: string) => ({ contains: likeEscape(v), mode: 'insensitive' as const });
    if (q.name) and.push({ OR: [{ nameTh: like(q.name) }, { conditionText: like(q.name) }] });
    if (q.q)
      and.push({
        OR: [{ code: like(q.q) }, { nameTh: like(q.q) }, { externalId: like(q.q) }],
      });
    return { AND: and };
  }

  private async usage(ids: string[]): Promise<Map<string, Usage>> {
    const out = new Map<string, Usage>();
    if (!ids.length) return out;
    const tx = this.db.tx;
    const [rc, ds] = await Promise.all([
      tx.rateCard.groupBy({
        by: ['serviceItemId'],
        where: { serviceItemId: { in: ids } },
        _count: { _all: true },
      }),
      tx.doSurcharge.groupBy({
        by: ['serviceItemId'],
        where: { serviceItemId: { in: ids } },
        _count: { _all: true },
      }),
    ]);
    for (const id of ids) out.set(id, { ...NO_USAGE });
    for (const g of rc) out.get(g.serviceItemId)!.rateCards = g._count._all;
    for (const g of ds) out.get(g.serviceItemId)!.doSurcharges = g._count._all;
    return out;
  }

  private async withUsage(rows: ServiceItem[]): Promise<ServiceItemDto[]> {
    const u = await this.usage(rows.map((r) => r.id));
    return rows.map((r) => toServiceItemDto(r, u.get(r.id)));
  }

  async list(q: ServiceItemListQuery) {
    const k = masterKeyset(q);
    const rows = await this.db.tx.serviceItem.findMany({
      where: { AND: [this.where(q), k.where] },
      orderBy: k.orderBy,
      take: k.take,
    });
    const u = await this.usage(rows.slice(0, q.limit ?? 50).map((r) => r.id));
    return k.page(rows, (r) => toServiceItemDto(r, u.get(r.id)));
  }

  async exportRows(q: ServiceItemListQuery & { ids?: string }) {
    const ids = q.ids?.split(',').map((x) => tryDecodeId('serviceItem', x)!);
    const where = ids ? { AND: [this.where(q), { id: { in: ids } }] } : this.where(q);
    const rows = await this.db.tx.serviceItem.findMany({
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
    const [byStatus, byVat] = await Promise.all([
      tx.serviceItem.groupBy({
        by: ['status'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
      tx.serviceItem.groupBy({
        by: ['vatType'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
    ]);
    const s = (x: ActiveStatus) => byStatus.find((g) => g.status === x)?._count._all ?? 0;
    const v = (x: ServiceItemVatType) => byVat.find((g) => g.vatType === x)?._count._all ?? 0;
    return {
      total: s('ACTIVE') + s('INACTIVE'),
      active: s('ACTIVE'),
      inactive: s('INACTIVE'),
      vat7: v('VAT_7'),
      exempt: v('EXEMPT_TRANSPORT'),
      zeroRated: v('ZERO_RATED'),
    };
  }

  async nextCode(): Promise<string> {
    return nextCode(this.db.tx, 'service_item', SERVICE_ITEM_CODE_PREFIX);
  }

  async get(id: string): Promise<ServiceItem> {
    const s = await this.db.tx.serviceItem.findFirst({ where: { id, deletedAt: null } });
    if (!s) throw new ProblemException('not_found');
    return s;
  }

  async getByExternalId(externalId: string): Promise<ServiceItem> {
    const s = await this.db.tx.serviceItem.findFirst({ where: { externalId, deletedAt: null } });
    if (!s) throw new ProblemException('not_found');
    return s;
  }

  async dto(s: ServiceItem): Promise<ServiceItemDto> {
    return (await this.withUsage([s]))[0]!;
  }

  /**
   * ตัวช่วยของโมดูลเอกสาร (ST3/ST4/ST5/ST6): ล็อกแถว (FOR SHARE — กันถูกลบระหว่างสร้างบรรทัด) ตรวจว่าใช้งานอยู่
   * และใช้กับฝั่งของเอกสารได้ แล้วคืน snapshot ที่ต้องคัดลอกลงบรรทัด (ดู snapshot.ts)
   * - ไม่พบ/ลบแล้ว → 422 `service_item_not_found` · ปิดใช้ → 422 `service_item_inactive`
   * - ฝั่งไม่ตรง (เช่น BUY ใช้กับใบแจ้งหนี้ลูกค้า) → 422 `service_item_side`
   */
  async snapshotFor(
    id: string,
    docSide: 'SELL' | 'BUY',
    field = 'serviceItemId',
  ): Promise<Readonly<ServiceItemSnapshot>> {
    const tx = this.db.tx;
    const [locked] = await lockReferenced(tx, 'service_item', [id]);
    if (!locked) throw field422(field, 'service_item_not_found', 'service item not found');
    const s = await tx.serviceItem.findUniqueOrThrow({ where: { id } });
    if (s.status !== 'ACTIVE')
      throw field422(field, 'service_item_inactive', `service item ${s.code} is inactive`);
    if (!sideAllows(s.side as ServiceItemSide, docSide))
      throw field422(
        field,
        'service_item_side',
        `service item ${s.code} is for ${s.side} documents only`,
      );
    return snapshotServiceItem(s);
  }

  // ---------- write ----------

  /**
   * แปลง DTO → คอลัมน์ + ตรวจข้ามช่อง (ผลรวมของค่าเดิม + ค่าที่ส่งมา):
   * ตามจริง = ไม่มีราคา · % ของค่าขนส่ง ≤ 100 · ราคาน้ำมันอ้างอิงเฉพาะ % ของค่าขนส่ง (เปลี่ยนหน่วยแล้วล้างให้เอง)
   * · รายการสงวน: หน่วยคิด/ฝั่ง/ชนิดแก้ไม่ได้, FREIGHT ห้าม VAT_7
   */
  private toData(
    input: UpdateServiceItemDto | CreateServiceItemDto,
    current?: ServiceItem,
  ): Prisma.ServiceItemUncheckedUpdateInput {
    const data: Prisma.ServiceItemUncheckedUpdateInput = {};
    if (input.name !== undefined) data.nameTh = input.name;
    if (input.nameEn !== undefined) data.nameEn = input.nameEn || null;
    if (input.condition !== undefined) data.conditionText = input.condition || null;
    if (input.side !== undefined) data.side = input.side;
    if (input.isSurcharge !== undefined) data.isSurcharge = input.isSurcharge;
    else if (!current) data.isSurcharge = true;
    if (input.defaultAccountCode !== undefined)
      data.defaultAccountCode = input.defaultAccountCode || null;

    const unit = (input.calcUnit ?? current?.calcUnit) as CalcUnit;
    if (input.calcUnit !== undefined) {
      data.calcUnit = input.calcUnit;
      data.unitLabel = CALC_UNIT_LABEL[input.calcUnit];
    }
    let price =
      input.defaultPrice !== undefined ? input.defaultPrice : money(current?.defaultPrice ?? null);
    let fuel =
      input.fuelRefPrice !== undefined ? input.fuelRefPrice : money(current?.fuelRefPrice ?? null);
    if (unit === 'ACTUAL') {
      if (input.defaultPrice !== undefined && input.defaultPrice !== null)
        throw field422('defaultPrice', 'actual_no_price', 'ACTUAL items are billed per receipt');
      price = null;
    }
    if (unit === 'PERCENT_OF_FREIGHT' && price !== null && Number(price) > 100)
      throw field422('defaultPrice', 'percent_max', 'percent of freight must be ≤ 100');
    if (unit !== 'PERCENT_OF_FREIGHT') {
      if (input.fuelRefPrice !== undefined && input.fuelRefPrice !== null)
        throw field422(
          'fuelRefPrice',
          'not_percent',
          'fuelRefPrice applies to PERCENT_OF_FREIGHT only',
        );
      fuel = null;
    } else if (fuel !== null && !(Number(fuel) > 0))
      throw field422('fuelRefPrice', 'min', 'fuelRefPrice must be > 0');
    if (input.defaultPrice !== undefined || input.calcUnit !== undefined || !current)
      data.defaultPrice = price;
    if (input.fuelRefPrice !== undefined || input.calcUnit !== undefined || !current)
      data.fuelRefPrice = fuel;

    const vat = (input.vatType ?? current?.vatType) as ServiceItemVatType;
    if (input.vatType !== undefined) data.vatType = input.vatType;
    if (input.whtRate !== undefined) data.whtRate = input.whtRate;
    if (current && isReserved(current)) {
      // MD-158: รายการสงวนแก้ชื่อ/ราคา/เงื่อนไข/ธงภาษีได้ แต่หน่วยคิด/ฝั่ง/ชนิดค่าใช้จ่ายผูกกับงานอัตโนมัติ
      const now = {
        calcUnit: current.calcUnit,
        side: current.side,
        isSurcharge: current.isSurcharge,
      };
      for (const k of RESERVED_LOCKED)
        if (input[k] !== undefined && input[k] !== now[k])
          throw field422(k, 'reserved_field', `${k} of a reserved system item cannot be changed`);
      // [OPEN — รอนักบัญชี ACC-2] ค่าขนส่งยกเว้น VAT (ม.81(1)(ณ)); ยังไม่เปิดให้คิด VAT บนค่าขนส่ง (plan/06 ACC-2 fallback)
      if (current.systemKey === 'FREIGHT' && vat === 'VAT_7')
        throw field422(
          'vatType',
          'reserved_tax',
          'FREIGHT must stay VAT-exempt until ACC-2 is answered',
        );
    }
    return data;
  }

  /**
   * คำเตือนคู่ VAT × หัก ณ ที่จ่ายที่ไม่ปกติ (ไม่บล็อก) — ตรวจเฉพาะเมื่อคำขอส่ง vatType/whtRate มา
   * (แก้ชื่อเฉย ๆ ไม่เตือนซ้ำ) · ห้ามใช้ตรวจบรรทัดเอกสาร (ดู serviceItemTaxNote)
   */
  taxWarnings(
    input: { vatType?: unknown; whtRate?: unknown },
    s: ServiceItem,
  ): { code: 'vat_wht_unusual'; reason: 'transport_wht_3' | 'service_wht_1'; message: string }[] {
    if (input.vatType === undefined && input.whtRate === undefined) return [];
    const note = serviceItemTaxNote(
      s.vatType as ServiceItemVatType,
      s.whtRate.toFixed(2) as ServiceItemWhtRate,
    );
    if (!note) return [];
    return [
      {
        code: 'vat_wht_unusual',
        reason: note,
        message:
          note === 'transport_wht_3'
            ? 'VAT-exempt transport is usually withheld at 1% — check with your accountant'
            : 'VAT 7% services are usually withheld at 3% (1% only when paid via e-Withholding Tax)',
      },
    ];
  }

  private assertCodeAllowed(code: string) {
    if ((RESERVED_CODES as readonly string[]).includes(code.toUpperCase()))
      throw field422('code', 'reserved_code', `${code} is reserved by the system`);
  }

  /** ชื่อห้ามซ้ำ (ต้นแบบ cfAx "มีรายการนี้แล้ว"; unique index ไม่สนตัวพิมพ์) → 409 พร้อมรายการเดิม */
  private async assertUniqueName(name: string, exceptId?: string) {
    await lockKey(this.db.tx, `service_item.name:${name.toLowerCase()}`);
    const dup = await this.db.tx.serviceItem.findFirst({
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
        [{ field: 'name', code: 'duplicate', message: `service item already exists: ${dup.code}` }],
        { existing: { id: encodeId('serviceItem', dup.id), code: dup.code, name: dup.nameTh } },
      );
  }

  private async assertUniqueExternal(externalId: string, exceptId?: string) {
    const dup = await this.db.tx.serviceItem.findFirst({
      where: { externalId, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (dup)
      throw new ProblemException('duplicate', undefined, [
        { field: 'externalId', code: 'duplicate', message: 'externalId already used' },
      ]);
  }

  private async assertCodeFree(code: string, exceptId?: string) {
    const taken = await this.db.tx.serviceItem.findFirst({
      where: { code: iEquals(code), ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (taken)
      throw new ProblemException('duplicate', undefined, [
        { field: 'code', code: 'duplicate', message: 'code already exists' },
      ]);
  }

  async create(
    input: CreateServiceItemDto | (UpsertServiceItemDto & { externalId: string }),
  ): Promise<ServiceItem> {
    const tx = this.db.tx;
    const data = this.toData(input);
    if (input.externalId) {
      // POST ที่มี externalId ใช้ lock เดียวกับ PUT external (กันสร้างซ้ำพร้อมกัน)
      await lockKey(tx, `service_item.ext:${input.externalId}`);
      await this.assertUniqueExternal(input.externalId);
    }
    await this.assertUniqueName(input.name);
    await lockKey(tx, 'service_item.code');
    let code = input.code;
    if (code) {
      this.assertCodeAllowed(code);
      await this.assertCodeFree(code);
    } else code = await nextCode(tx, 'service_item', SERVICE_ITEM_CODE_PREFIX);
    const s = await tx.serviceItem.create({
      data: {
        ...(data as object),
        code,
        externalId: input.externalId ?? null,
      } as Prisma.ServiceItemUncheckedCreateInput, // tenantId เติมโดย tenantExtension
    });
    await this.audit.record({
      action: 'service_item.created',
      entityType: 'service_item',
      entityId: s.id,
      after: auditView(s),
    });
    await emitMasterEvent(tx, 'service_item.created', 'service_item', s.id, toServiceItemDto(s));
    return s;
  }

  async update(id: string, input: UpdateServiceItemDto, expected?: number): Promise<ServiceItem> {
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    const data = this.toData(input, current);
    if (input.code !== undefined && input.code !== current.code) {
      if (isReserved(current))
        throw field422('code', 'reserved_code', 'reserved system code cannot be changed');
      this.assertCodeAllowed(input.code);
      await lockKey(this.db.tx, 'service_item.code');
      await this.assertCodeFree(input.code, current.id);
      data.code = input.code;
    }
    if (input.name !== undefined && input.name.toLowerCase() !== current.nameTh.toLowerCase())
      await this.assertUniqueName(input.name, current.id);
    if (input.externalId !== undefined) {
      if (input.externalId) await this.assertUniqueExternal(input.externalId, current.id);
      data.externalId = input.externalId;
    }
    if (isNoopUpdate(current, data as Record<string, unknown>, DECIMAL_FIELDS)) return current;
    const s = await this.bumpVersion(current, data);
    const before = auditView(current);
    const after = auditView(s);
    await this.audit.changed('service_item.updated', 'service_item', s.id, before, after);
    const changed = Object.keys(after).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    // spec/02 §6.7 `accessorial.updated` — เอกสารเดิมไม่เปลี่ยน (snapshot); ผู้ฟัง (คำนวณ SO ร่างใหม่ MD-157) อยู่ใน ST3
    if (changed.length)
      await emitMasterEvent(
        this.db.tx,
        'service_item.updated',
        'service_item',
        s.id,
        toServiceItemDto(s),
        { changedFields: changed },
      );
    return s;
  }

  /** PUT /service-items/external/{externalId} — idempotent (ส่งซ้ำ = อัปเดตแถวเดิม) */
  async upsertExternal(externalId: string, input: UpsertServiceItemDto, expected?: number) {
    const tx = this.db.tx;
    return upsertByExternalId(tx, 'service_item', externalId, {
      find: () => tx.serviceItem.findFirst({ where: { externalId, deletedAt: null } }),
      create: () => this.create({ ...input, externalId }),
      update: (cur) => {
        const { code: _code, ...rest } = input;
        return this.update(cur.id, rest, expected);
      },
    });
  }

  private reservedConflict(action: string) {
    return new ProblemException('conflict', `reserved system item cannot be ${action} (MD-158)`, [
      { field: 'id', code: 'reserved_item', message: `reserved system item cannot be ${action}` },
    ]);
  }

  async changeStatus(id: string, event: SiEvent, reason?: string, expected?: number) {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    if (event === 'deactivate' && isReserved(current)) throw this.reservedConflict('deactivated');
    let updated!: ServiceItem;
    await this.state.transition(tx, {
      docType: 'service_item',
      docId: id,
      table: SERVICE_ITEM_TRANSITIONS,
      from: current.status,
      event,
      note: reason ?? null,
      eventType: event === 'deactivate' ? 'service_item.deactivated' : 'service_item.reactivated',
      apply: async (to) => {
        updated = await this.bumpVersion(current, { status: to });
        await this.audit.changed(
          event === 'deactivate' ? 'service_item.deactivated' : 'service_item.reactivated',
          'service_item',
          id,
          auditView(current),
          auditView(updated),
          reason,
        );
        return toServiceItemDto(updated) as unknown as Record<string, unknown>;
      },
    });
    return updated;
  }

  /** MD-004: ลบได้เฉพาะที่ไม่เคยถูกอ้างอิง → soft delete; ถูกอ้างอิง → 409 `in_use` · รหัสสงวน → 409 `conflict` */
  async remove(id: string, reason: string, expected?: number): Promise<void> {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    if (isReserved(current)) throw this.reservedConflict('deleted');
    await lockForRemoval(tx, 'service_item', id);
    await assertNotReferenced([
      { name: 'rateCards', count: () => tx.rateCard.count({ where: { serviceItemId: id } }) },
      {
        name: 'doSurcharges',
        count: () => tx.doSurcharge.count({ where: { serviceItemId: id } }),
      },
    ]);
    await this.bumpVersion(current, {
      deletedAt: new Date(),
      externalId: null,
      deletedExternalId: current.externalId,
    });
    await this.audit.record({
      action: 'service_item.deleted',
      entityType: 'service_item',
      entityId: id,
      before: auditView(current),
      reason,
    });
    await emitMasterEvent(
      tx,
      'service_item.deleted',
      'service_item',
      id,
      toServiceItemDto(current),
    );
  }

  /** optimistic lock: update เฉพาะเมื่อ version ยังเท่าเดิม ไม่งั้น 412 */
  private async bumpVersion(
    current: ServiceItem,
    data: Prisma.ServiceItemUncheckedUpdateInput,
  ): Promise<ServiceItem> {
    const tx = this.db.tx;
    const r = await tx.serviceItem.updateMany({
      where: { id: current.id, version: current.version, deletedAt: null },
      data: { ...data, version: { increment: 1 } },
    });
    if (r.count !== 1) throw new ProblemException('precondition_failed');
    return (await tx.serviceItem.findUnique({ where: { id: current.id } }))!;
  }
}
