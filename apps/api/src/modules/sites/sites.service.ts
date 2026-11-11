import { Injectable } from '@nestjs/common';
import { Prisma, type ActiveStatus, type CustomerSite } from '@prisma/client';
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
import type {
  CreateSiteDto,
  SiteAddressDto,
  SiteContactDto,
  SiteDto,
  SiteFieldsDto,
  SiteListQuery,
  SiteSummaryDto,
  UpdateSiteDto,
  UpsertSiteDto,
} from './site.dto';

export const SITE_CODE_PREFIX = 'LOC';
const SITE_CODE_WIDTH = 5; // spec/02 §2 `LOC-00001`
const DECIMAL_FIELDS = ['lat', 'lng'] as const;
type SiteEvent = 'activate' | 'deactivate';
export const SITE_TRANSITIONS: TransitionTable<ActiveStatus, SiteEvent> = {
  ACTIVE: { deactivate: 'INACTIVE' },
  INACTIVE: { activate: 'ACTIVE' },
};
/** ชื่อ event ตาม spec/02 §2.7 (`location.*`) — audit/history ใช้ entityType `customer_site` */
const EVENT = 'location';
const ENTITY = 'customer_site';

type CustomerRef = { id: string; code: string; legalName: string };

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

/** ค่าค้นหา alias: ตัวเล็ก คั่น/ครอบด้วย \n → contains `\nค่า\n` = ตรงตัว, contains `ค่า` = บางส่วน */
export function aliasSearchText(aliases: string[]): string {
  return aliases.length ? `\n${aliases.map((a) => a.toLowerCase()).join('\n')}\n` : '';
}

export function toSiteDto(s: CustomerSite, customer?: CustomerRef | null): SiteDto {
  return {
    id: encodeId('site', s.id),
    code: s.code,
    externalId: s.externalId,
    kind: s.kind,
    name: s.name,
    address: s.address as unknown as SiteAddressDto,
    customer: customer
      ? { id: encodeId('customer', customer.id), code: customer.code, name: customer.legalName }
      : null,
    lat: s.lat === null ? null : Number(s.lat),
    lng: s.lng === null ? null : Number(s.lng),
    geocodeStatus: s.geocodeStatus,
    geofenceRadiusM: s.geofenceRadiusM,
    aliases: s.aliases,
    openTime: s.openTime,
    closeTime: s.closeTime,
    maxVehicleClass: s.maxVehicleClass as SiteDto['maxVehicleClass'],
    serviceTimeMin: s.avgDwellMin,
    freeTimeMin: s.freeTimeMin,
    contact: (s.contact as unknown as SiteContactDto | null) ?? null,
    notes: s.notes,
    status: s.status.toLowerCase() as SiteDto['status'],
    ...(s.deletedAt ? { deletedAt: s.deletedAt.toISOString() } : {}),
    version: s.version,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/** snapshot สำหรับ audit/event — ไม่มี updatedAt/version; ลูกค้าเป็น id (ชื่อเปลี่ยนได้ ไม่นับเป็น diff) */
function auditView(s: CustomerSite): Record<string, unknown> {
  const { updatedAt: _u, version: _v, customer: _c, ...rest } = toSiteDto(s);
  return { ...rest, customerId: s.customerId ? encodeId('customer', s.customerId) : null };
}

/**
 * สถานที่ / จุดรับส่ง (ST2-T02; docs/01 §3.2 customer_site, docs/04 B จุดส่ง, spec/02 §2)
 * ใช้ชุดเครื่องมือ master (ST2-T01) — ไม่มีลบจริง: "ลบ" = soft delete เฉพาะจุดที่ไม่เคยถูกอ้างอิง (MD-004)
 * geocode: มีพิกัด → `OK` (คนกรอก/ปักเอง), ไม่มี → `PENDING` · geocode อัตโนมัติ + `FAILED` = ST2-T03
 * (T03 เสียบที่ `applyCoords()` — ตั้ง lat/lng + สถานะจากผู้ให้บริการ)
 */
@Injectable()
export class SitesService {
  constructor(
    private readonly db: DbService,
    private readonly state: StateService,
    private readonly audit: AuditService,
  ) {}

  // ---------- read ----------

  private async where(q: SiteListQuery): Promise<Prisma.CustomerSiteWhereInput> {
    const and: Prisma.CustomerSiteWhereInput[] = [deletedFilter(q)];
    const status = statusFilter(q.status);
    if (status) and.push({ status });
    if (q.kind) and.push({ kind: q.kind });
    if (q.externalId) and.push({ externalId: q.externalId });
    if (q.maxVehicleClass) and.push({ maxVehicleClass: q.maxVehicleClass });
    if (q.pinned === 'true') and.push({ lat: { not: null } });
    if (q.pinned === 'false') and.push({ lat: null });
    if (q.customerId === 'none') and.push({ customerId: null });
    else if (q.customerId) and.push({ customerId: tryDecodeId('customer', q.customerId) });
    const like = (v: string) => ({ contains: likeEscape(v), mode: 'insensitive' as const });
    if (q.customerName) {
      const ids = await this.db.tx.customer.findMany({
        where: { legalName: like(q.customerName) },
        select: { id: true },
        take: 1000,
      });
      and.push({ customerId: { in: ids.map((c) => c.id) } });
    }
    if (q.alias)
      and.push({ aliasSearch: { contains: `\n${likeEscape(q.alias.toLowerCase())}\n` } });
    if (q.q)
      and.push({
        OR: [
          { code: like(q.q) },
          { name: like(q.q) },
          { externalId: like(q.q) },
          { aliasSearch: { contains: likeEscape(q.q.toLowerCase()) } },
          { address: { path: ['line1'], string_contains: likeEscape(q.q) } },
        ],
      });
    return { AND: and };
  }

  private async customers(rows: CustomerSite[]): Promise<Map<string, CustomerRef>> {
    const ids = [...new Set(rows.map((r) => r.customerId).filter((x): x is string => !!x))];
    if (!ids.length) return new Map();
    const cs = await this.db.tx.customer.findMany({
      where: { id: { in: ids } },
      select: { id: true, code: true, legalName: true },
    });
    return new Map(cs.map((c) => [c.id, c]));
  }

  async list(q: SiteListQuery) {
    const k = masterKeyset(q);
    const rows = await this.db.tx.customerSite.findMany({
      where: { AND: [await this.where(q), k.where] },
      orderBy: k.orderBy,
      take: k.take,
    });
    const cs = await this.customers(rows);
    return k.page(rows, (r) => toSiteDto(r, cs.get(r.customerId ?? '')));
  }

  /** แถวสำหรับส่งออก (ตัวกรองเดียวกับ list หรือ id ที่เลือก) — เกินเพดาน → 422 */
  async exportRows(q: SiteListQuery & { ids?: string }): Promise<SiteDto[]> {
    const ids = q.ids?.split(',').map((x) => tryDecodeId('site', x)!);
    const base = await this.where(q);
    const rows = await this.db.tx.customerSite.findMany({
      where: ids ? { AND: [base, { id: { in: ids } }] } : base,
      orderBy: [{ code: 'asc' }],
      take: EXPORT_MAX_ROWS + 1,
    });
    if (rows.length > EXPORT_MAX_ROWS)
      throw field422(
        'query',
        'too_many_rows',
        `export is limited to ${EXPORT_MAX_ROWS} rows — narrow the filter`,
      );
    const cs = await this.customers(rows);
    return rows.map((r) => toSiteDto(r, cs.get(r.customerId ?? '')));
  }

  async summary(): Promise<SiteSummaryDto> {
    const tx = this.db.tx;
    const live = { deletedAt: null };
    const [byStatus, byKind, pinned, restricted] = await Promise.all([
      tx.customerSite.groupBy({ by: ['status'], where: live, _count: { _all: true } }),
      tx.customerSite.groupBy({ by: ['kind'], where: live, _count: { _all: true } }),
      tx.customerSite.count({ where: { ...live, lat: { not: null } } }),
      tx.customerSite.count({ where: { ...live, maxVehicleClass: { in: ['6W', '10W'] } } }),
    ]);
    const st = (s: ActiveStatus) => byStatus.find((x) => x.status === s)?._count._all ?? 0;
    const kd = (k: string) => byKind.find((x) => x.kind === k)?._count._all ?? 0;
    const total = st('ACTIVE') + st('INACTIVE');
    return {
      total,
      pinned,
      unpinned: total - pinned,
      restricted,
      byKind: { PICKUP: kd('PICKUP'), DROPOFF: kd('DROPOFF'), WAREHOUSE: kd('WAREHOUSE') },
      active: st('ACTIVE'),
      inactive: st('INACTIVE'),
    };
  }

  async nextCode(): Promise<string> {
    return nextCode(this.db.tx, 'customer_site', SITE_CODE_PREFIX, SITE_CODE_WIDTH);
  }

  async get(id: string): Promise<CustomerSite> {
    const s = await this.db.tx.customerSite.findFirst({ where: { id, deletedAt: null } });
    if (!s) throw new ProblemException('not_found');
    return s;
  }

  async getByExternalId(externalId: string): Promise<CustomerSite> {
    const s = await this.db.tx.customerSite.findFirst({ where: { externalId, deletedAt: null } });
    if (!s) throw new ProblemException('not_found');
    return s;
  }

  async dto(s: CustomerSite): Promise<SiteDto> {
    const cs = await this.customers([s]);
    return toSiteDto(s, cs.get(s.customerId ?? ''));
  }

  // ---------- write ----------

  /**
   * พิกัด → คอลัมน์ + geocodeStatus (จุดเสียบของ ST2-T03)
   * ส่งคู่ lat/lng เสมอ (ส่งข้างเดียว → 422) · มีค่า = OK (คนกรอก), null = PENDING (รอปักหมุด/geocode)
   */
  private applyCoords(
    input: { lat?: number | null; lng?: number | null },
    data: Prisma.CustomerSiteUncheckedUpdateInput,
  ) {
    if (input.lat === undefined && input.lng === undefined) return;
    const lat = input.lat ?? null;
    const lng = input.lng ?? null;
    if ((lat === null) !== (lng === null))
      throw field422(
        lat === null ? 'lat' : 'lng',
        'pair_required',
        'lat and lng must be sent together',
      );
    data.lat = lat === null ? null : new Prisma.Decimal(lat.toFixed(6));
    data.lng = lng === null ? null : new Prisma.Decimal(lng.toFixed(6));
    data.geocodeStatus = lat === null ? 'PENDING' : 'OK';
  }

  /** แปลง DTO → คอลัมน์ + ตรวจลูกค้าที่อ้างถึง (ต้องมีใน tenant และใช้งานอยู่) */
  private async toData(input: SiteFieldsDto & { name?: string; address?: SiteAddressDto }) {
    const data: Prisma.CustomerSiteUncheckedUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.address !== undefined) data.address = { ...input.address } as object;
    if (input.kind !== undefined) data.kind = input.kind;
    this.applyCoords(input, data);
    if (input.geofenceRadiusM !== undefined) data.geofenceRadiusM = input.geofenceRadiusM;
    if (input.aliases !== undefined) {
      data.aliases = input.aliases;
      data.aliasSearch = aliasSearchText(input.aliases);
    }
    if (input.openTime !== undefined) data.openTime = input.openTime;
    if (input.closeTime !== undefined) data.closeTime = input.closeTime;
    if (input.maxVehicleClass !== undefined) data.maxVehicleClass = input.maxVehicleClass;
    if (input.serviceTimeMin !== undefined) data.avgDwellMin = input.serviceTimeMin;
    if (input.freeTimeMin !== undefined) data.freeTimeMin = input.freeTimeMin;
    if (input.contact !== undefined)
      data.contact = input.contact === null ? Prisma.DbNull : ({ ...input.contact } as object);
    if (input.notes !== undefined) data.notes = input.notes === '' ? null : input.notes;
    if (input.customerId !== undefined) {
      if (input.customerId === null) data.customerId = null;
      else {
        const id = tryDecodeId('customer', input.customerId);
        const c = id
          ? await this.db.tx.customer.findFirst({
              where: { id, deletedAt: null },
              select: { id: true, status: true },
            })
          : null;
        if (!c || c.status !== 'ACTIVE')
          throw field422('customerId', 'not_found', 'customer not found or inactive');
        data.customerId = c.id;
      }
    }
    return data;
  }

  /** เวลาเปิด-ปิดต้องมาคู่กัน (ว่างทั้งคู่ = 24 ชม.) */
  private assertHours(openTime: string | null, closeTime: string | null) {
    if ((openTime === null) !== (closeTime === null))
      throw field422(
        openTime === null ? 'openTime' : 'closeTime',
        'pair_required',
        'openTime and closeTime must be set together',
      );
  }

  private async assertUniqueExternal(externalId: string, exceptId?: string) {
    const dup = await this.db.tx.customerSite.findFirst({
      where: { externalId, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (dup)
      throw new ProblemException('duplicate', undefined, [
        { field: 'externalId', code: 'duplicate', message: 'externalId already used' },
      ]);
  }

  async create(
    input: CreateSiteDto | (UpsertSiteDto & { externalId: string }),
  ): Promise<CustomerSite> {
    const tx = this.db.tx;
    const data = await this.toData(input);
    this.assertHours(input.openTime ?? null, input.closeTime ?? null);
    if (input.externalId) await this.assertUniqueExternal(input.externalId);
    await lockKey(tx, 'customer_site.code');
    let code = input.code;
    if (code) {
      const taken = await tx.customerSite.findFirst({
        where: { code: { equals: code, mode: 'insensitive' } },
        select: { id: true },
      });
      if (taken)
        throw new ProblemException('duplicate', undefined, [
          { field: 'code', code: 'duplicate', message: 'code already exists' },
        ]);
    } else code = await nextCode(tx, 'customer_site', SITE_CODE_PREFIX, SITE_CODE_WIDTH);
    const s = await tx.customerSite.create({
      data: {
        ...(data as object),
        name: input.name,
        address: { ...input.address } as object,
        code,
        externalId: input.externalId ?? null,
      } as Prisma.CustomerSiteUncheckedCreateInput, // tenantId เติมโดย tenantExtension
    });
    await this.audit.record({
      action: `${EVENT}.created`,
      entityType: ENTITY,
      entityId: s.id,
      after: auditView(s),
    });
    await emitMasterEvent(tx, `${EVENT}.created`, ENTITY, s.id, await this.dto(s));
    return s;
  }

  async update(id: string, input: UpdateSiteDto, expected?: number): Promise<CustomerSite> {
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    const data = await this.toData(input);
    if (input.openTime !== undefined || input.closeTime !== undefined)
      this.assertHours(
        input.openTime !== undefined ? input.openTime : current.openTime,
        input.closeTime !== undefined ? input.closeTime : current.closeTime,
      );
    if (input.externalId !== undefined) {
      if (input.externalId) await this.assertUniqueExternal(input.externalId, current.id);
      data.externalId = input.externalId;
    }
    if (isNoopUpdate(current, data as Record<string, unknown>, DECIMAL_FIELDS)) return current;
    const s = await this.bumpVersion(current, data);
    const before = auditView(current);
    const after = auditView(s);
    await this.audit.changed(`${EVENT}.updated`, ENTITY, s.id, before, after);
    const changed = Object.keys(after).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    if (changed.length)
      await emitMasterEvent(this.db.tx, `${EVENT}.updated`, ENTITY, s.id, await this.dto(s), {
        changedFields: changed,
      });
    return s;
  }

  /** PUT /customer-sites/external/{externalId} — idempotent (ส่งซ้ำ = อัปเดตแถวเดิม) */
  async upsertExternal(externalId: string, input: UpsertSiteDto, expected?: number) {
    const tx = this.db.tx;
    return upsertByExternalId(tx, ENTITY, externalId, {
      // รายการที่ลบแล้วย้าย externalId ไป deleted_external_id → ระบบต้นทางส่งซ้ำได้ (สร้างใหม่)
      find: () => tx.customerSite.findFirst({ where: { externalId, deletedAt: null } }),
      create: () => this.create({ ...input, externalId }),
      update: (cur) => {
        const { code: _code, ...rest } = input;
        return this.update(cur.id, rest, expected);
      },
    });
  }

  async changeStatus(id: string, event: SiteEvent, reason?: string, expected?: number) {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    const action = event === 'deactivate' ? `${EVENT}.deactivated` : `${EVENT}.reactivated`;
    let updated!: CustomerSite;
    await this.state.transition(tx, {
      docType: ENTITY,
      docId: id,
      table: SITE_TRANSITIONS,
      from: current.status,
      event,
      note: reason ?? null,
      eventType: action,
      apply: async (to) => {
        updated = await this.bumpVersion(current, { status: to });
        await this.audit.changed(
          action,
          ENTITY,
          id,
          auditView(current),
          auditView(updated),
          reason,
        );
        return (await this.dto(updated)) as unknown as Record<string, unknown>;
      },
    });
    return updated;
  }

  /** MD-004: ลบได้เฉพาะจุดที่ไม่เคยถูกอ้างอิง → soft delete; ถูกอ้างอิง (SO/DO/เที่ยว/rate card) → 409 `in_use` */
  async remove(id: string, reason: string, expected?: number): Promise<void> {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    await assertNotReferenced([
      { name: 'salesOrders', count: () => tx.salesOrderStop.count({ where: { siteId: id } }) },
      {
        name: 'deliveryOrders',
        count: () =>
          tx.deliveryOrder.count({ where: { OR: [{ originSiteId: id }, { destSiteId: id }] } }),
      },
      { name: 'trips', count: () => tx.tripStop.count({ where: { siteId: id } }) },
      {
        name: 'rateCards',
        count: () =>
          tx.rateCard.count({ where: { OR: [{ originSiteId: id }, { destSiteId: id }] } }),
      },
    ]);
    await this.bumpVersion(current, {
      deletedAt: new Date(),
      externalId: null,
      deletedExternalId: current.externalId,
    });
    await this.audit.record({
      action: `${EVENT}.deleted`,
      entityType: ENTITY,
      entityId: id,
      before: auditView(current),
      reason,
    });
    await emitMasterEvent(tx, `${EVENT}.deleted`, ENTITY, id, await this.dto(current));
  }

  /** optimistic lock: update เฉพาะเมื่อ version ยังเท่าเดิม ไม่งั้น 412 */
  private async bumpVersion(
    current: CustomerSite,
    data: Prisma.CustomerSiteUncheckedUpdateInput,
  ): Promise<CustomerSite> {
    const tx = this.db.tx;
    const r = await tx.customerSite.updateMany({
      where: { id: current.id, version: current.version, deletedAt: null },
      data: { ...data, version: { increment: 1 } },
    });
    if (r.count !== 1) throw new ProblemException('precondition_failed');
    return (await tx.customerSite.findUnique({ where: { id: current.id } }))!;
  }
}
