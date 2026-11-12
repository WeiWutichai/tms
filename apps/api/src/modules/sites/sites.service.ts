import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Prisma, type ActiveStatus, type CustomerSite } from '@prisma/client';
import { matchKey, type TransitionTable } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { JobQueue, type JobContext } from '../../jobs/job-queue.service';
import { addressText, GeoService } from '../geo/geo.service';
import { StateService } from '../../state/state.service';
import { EXPORT_MAX_ROWS } from '../master/export';
import {
  assertNotReferenced,
  cleanLine,
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
  CreateSiteDto,
  GeocodeResultDto,
  SiteAddressDto,
  SiteContactDto,
  SiteDto,
  SiteFieldsDto,
  SiteListQuery,
  SiteSummaryDto,
  UpdateSiteDto,
  UpsertSiteDto,
} from './site.dto';
import { iEquals } from '../../common/ilike';

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

/** งาน geocode อัตโนมัติ (ST2-T03) — payload เก็บข้อความที่อยู่ตอนสั่ง: ที่อยู่เปลี่ยนก่อนงานรัน = ข้าม (มีงานใหม่แล้ว) */
export const GEOCODE_JOB = 'site.geocode';
interface GeocodeJobPayload {
  siteId: string;
  address: string;
  /** `customer_site.geocode_seq` ตอนสั่ง — ไม่ตรงแล้ว = job เก่า เขียนผลไม่ได้ */
  seq: number;
}
/** ล้างพิกัดที่เสนอ (ยืนยัน/ปักเอง/ที่อยู่เปลี่ยน) — เก็บ provider/geocodedAt ไว้เป็นประวัติ */
const NO_PROPOSAL = { geocodeLat: null, geocodeLng: null, geocodeConfidence: null } as const;

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

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
    geocodeProposal:
      s.geocodeLat !== null && s.geocodeLng !== null
        ? {
            lat: Number(s.geocodeLat),
            lng: Number(s.geocodeLng),
            confidence: s.geocodeConfidence === null ? 0 : Number(s.geocodeConfidence),
            provider: s.geocodeProvider ?? '',
            at: (s.geocodedAt ?? s.updatedAt).toISOString(),
          }
        : null,
    geofenceRadiusM: s.geofenceRadiusM,
    aliases: s.aliases,
    openTime: s.openTime,
    closeTime: s.closeTime,
    maxVehicleClass: s.maxVehicleClass as SiteDto['maxVehicleClass'],
    serviceTimeMin: s.avgDwellMin,
    freeTimeMin: s.freeTimeMin,
    dockCount: s.dockCount,
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
export class SitesService implements OnModuleInit {
  private readonly logger = new Logger('SitesService');
  constructor(
    private readonly db: DbService,
    private readonly state: StateService,
    private readonly audit: AuditService,
    private readonly queue: JobQueue,
    private readonly geo: GeoService,
  ) {}

  onModuleInit() {
    // เรียกผู้ให้บริการนอก transaction · ล่ม/เกินเวลา → ลองใหม่ (3 ครั้ง) · ล้มครั้งสุดท้าย = FAILED
    // (เฉพาะเมื่อยังเป็นคำขอล่าสุด — job เก่าล้มไม่ทับผล/การตัดสินของคน)
    this.queue.register(GEOCODE_JOB, (ctx) => this.runGeocodeJob(ctx), {
      outsideTransaction: true,
      onFinalFailure: async ({ tx, tenantId, job }) => {
        if (!this.geo.enabled) return;
        const p = job.payload as unknown as GeocodeJobPayload;
        await this.inJobContext(tx, tenantId, job.id, () => this.saveGeocodeResult(p, null));
      },
    });
  }

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
    if (q.geocode === 'OK') and.push({ geocodeStatus: 'OK' });
    if (q.geocode === 'FAILED') and.push({ geocodeStatus: 'FAILED' });
    if (q.geocode === 'REVIEW') and.push({ geocodeStatus: 'PENDING', geocodeLat: { not: null } });
    if (q.geocode === 'PENDING') and.push({ geocodeStatus: 'PENDING', geocodeLat: null });
    if (q.customerId === 'none') and.push({ customerId: null });
    else if (q.customerId) and.push({ customerId: tryDecodeId('customer', q.customerId) });
    const like = (v: string) => ({ contains: likeEscape(v), mode: 'insensitive' as const });
    if (q.customerName) {
      // ตามต้นแบบ: จุดของบริษัทเอง (ไม่มีลูกค้า) แสดงชื่อบริษัท — ค้นชื่อบริษัทแล้วเจอจุดเหล่านั้นด้วย
      const tenantId = requestContext.require().tenantId!;
      const own = await this.db.tx.tenant.findFirst({
        where: { id: tenantId, name: like(q.customerName) },
        select: { id: true },
      });
      and.push({
        OR: [
          { customer: { legalName: like(q.customerName) } },
          ...(own ? [{ customerId: null }] : []),
        ],
      });
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
          { addressSearch: { contains: likeEscape(q.q.toLowerCase()) } },
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
    const [byStatus, byKind, pinned, restricted, geocodeReview, geocodeFailed] = await Promise.all([
      tx.customerSite.groupBy({ by: ['status'], where: live, _count: { _all: true } }),
      tx.customerSite.groupBy({ by: ['kind'], where: live, _count: { _all: true } }),
      tx.customerSite.count({ where: { ...live, lat: { not: null } } }),
      tx.customerSite.count({ where: { ...live, maxVehicleClass: { in: ['6W', '10W'] } } }),
      tx.customerSite.count({
        where: { ...live, geocodeStatus: 'PENDING', geocodeLat: { not: null } },
      }),
      tx.customerSite.count({ where: { ...live, geocodeStatus: 'FAILED' } }),
    ]);
    const st = (s: ActiveStatus) => byStatus.find((x) => x.status === s)?._count._all ?? 0;
    const kd = (k: string) => byKind.find((x) => x.kind === k)?._count._all ?? 0;
    const total = st('ACTIVE') + st('INACTIVE');
    return {
      total,
      pinned,
      unpinned: total - pinned,
      restricted,
      geocodeReview,
      geocodeFailed,
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
   * เรียนรู้ alias (ST3-T06 docs/04 C "เรียนรู้ alias") — คนจับคู่ข้อความสถานที่ของ order กับสถานที่นี้ครั้งแรก
   * → เพิ่มข้อความลง `aliases` ให้ order ถัดไปที่ข้อความเดิมจับคู่เอง · ล็อกแถว (`FOR UPDATE`) ก่อนอ่าน กันสองคนเพิ่มพร้อมกันแล้วหาย
   * ไม่เพิ่มเมื่อ: คีย์ (`matchKey`) ซ้ำ alias เดิม (`exists`) · ตรงชื่อสถานที่อยู่แล้ว (`name` — เว้น `disambiguate` = มีสถานที่ชื่อซ้ำ
   * ในขอบเขต จึงต้องมี alias ชี้ขาด) · ครบ 50 (`full`, กติกาเดียวกับฟอร์ม T02) · ยาวเกิน 150 (`too_long`) · ไม่มีสาระ (`empty`)
   * เพิ่มแล้ว: version +1, audit `location.alias_learned`, event `location.updated` (changedFields aliases)
   */
  async learnAlias(
    tx: Tx,
    siteId: string,
    text: string,
    opts: { disambiguate?: boolean } = {},
  ): Promise<'learned' | 'exists' | 'name' | 'full' | 'too_long' | 'empty'> {
    const value = cleanLine(text);
    const key = matchKey(value);
    if (!key) return 'empty';
    if (value.length > 150) return 'too_long';
    await tx.$queryRaw`SELECT 1 FROM customer_site WHERE id = ${siteId}::uuid FOR UPDATE`;
    const current = await tx.customerSite.findUniqueOrThrow({ where: { id: siteId } });
    if (current.aliases.some((a) => matchKey(a) === key)) return 'exists';
    if (!opts.disambiguate && matchKey(current.name) === key) return 'name';
    if (current.aliases.length >= 50) return 'full';
    const s = await tx.customerSite.update({
      where: { id: siteId },
      data: { aliases: [...current.aliases, value], version: { increment: 1 } },
    });
    await this.audit.changed(
      `${EVENT}.alias_learned`,
      ENTITY,
      s.id,
      auditView(current),
      auditView(s),
    );
    await emitMasterEvent(tx, `${EVENT}.updated`, ENTITY, s.id, await this.dto(s), {
      changedFields: ['aliases'],
    });
    return 'learned';
  }

  /**
   * พิกัด → คอลัมน์ + geocodeStatus (ST2-T03)
   * ส่งคู่ lat/lng เสมอ (ส่งข้างเดียว → 422) · มีค่า = OK (คนกรอก/ปักเอง = คนยืนยันแล้ว) + ล้างพิกัดที่เสนอ
   * null = PENDING — ล้างพิกัดที่เคยมี → geocode อัตโนมัติใหม่ (`geocodeNeeded`); ส่ง null ซ้ำตอนยังไม่มีพิกัด = ไม่เปลี่ยน
   */
  private applyCoords(
    input: { lat?: number | null; lng?: number | null },
    data: Prisma.CustomerSiteUncheckedUpdateInput,
    current?: CustomerSite,
  ) {
    if (input.lat === undefined && input.lng === undefined) return;
    const lat = input.lat ?? null;
    const lng = input.lng ?? null;
    // ส่งมาช่องเดียว (แม้เป็น null) หรือค่าหนึ่งว่างอีกค่ามี → 422 (กันล้าง/แก้พิกัดครึ่งเดียว)
    if (input.lat === undefined || input.lng === undefined || (lat === null) !== (lng === null))
      throw field422(
        input.lat === undefined || (lat === null && input.lng !== undefined) ? 'lat' : 'lng',
        'pair_required',
        'lat and lng must be sent together',
      );
    if (lat === null || lng === null) {
      if (current && current.lat === null) return; // ยังไม่มีพิกัดอยู่แล้ว — คงสถานะ/ข้อเสนอเดิม
      data.lat = null;
      data.lng = null;
      data.geocodeStatus = 'PENDING';
      Object.assign(data, NO_PROPOSAL);
      return;
    }
    data.lat = new Prisma.Decimal(lat.toFixed(6));
    data.lng = new Prisma.Decimal(lng.toFixed(6));
    data.geocodeStatus = 'OK';
    Object.assign(data, NO_PROPOSAL);
  }

  /** แปลง DTO → คอลัมน์ + ตรวจลูกค้าที่อ้างถึง (ต้องมีใน tenant และใช้งานอยู่) */
  private async toData(
    input: SiteFieldsDto & { name?: string; address?: SiteAddressDto },
    current?: CustomerSite,
  ) {
    const data: Prisma.CustomerSiteUncheckedUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.address !== undefined) data.address = { ...input.address } as object;
    if (input.kind !== undefined) data.kind = input.kind;
    this.applyCoords(input, data, current);
    if (input.geofenceRadiusM !== undefined) data.geofenceRadiusM = input.geofenceRadiusM;
    if (input.aliases !== undefined) data.aliases = input.aliases; // alias_search/address_search = trigger (0036)
    if (input.openTime !== undefined) data.openTime = input.openTime;
    if (input.closeTime !== undefined) data.closeTime = input.closeTime;
    if (input.maxVehicleClass !== undefined) data.maxVehicleClass = input.maxVehicleClass;
    if (input.serviceTimeMin !== undefined) data.avgDwellMin = input.serviceTimeMin;
    if (input.freeTimeMin !== undefined) data.freeTimeMin = input.freeTimeMin;
    if (input.dockCount !== undefined) data.dockCount = input.dockCount;
    // ช่องโหลดมีเฉพาะคลัง (review ST2-T09): ชนิดอื่นส่งค่ามา = 422 · เปลี่ยนชนิดออกจากคลัง = ล้างค่าเดิมให้เอง
    if ((input.kind ?? current?.kind ?? 'DROPOFF') !== 'WAREHOUSE') {
      if (input.dockCount !== undefined && input.dockCount !== null)
        throw field422('dockCount', 'warehouse_only', 'dockCount applies to WAREHOUSE only');
      if (current?.dockCount !== null && current?.dockCount !== undefined) data.dockCount = null;
    }
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
        // ต้องมีใน tenant และยังไม่ลบเสมอ; ต้อง "ใช้งาน" เฉพาะเมื่อเปลี่ยนไปผูกลูกค้าใหม่
        // (ส่งซ้ำลูกค้าเดิมที่ปิดใช้ไปแล้ว เช่น PUT external ทั้งก้อน = ไม่เปลี่ยน → ผ่าน)
        if (!c || (c.status !== 'ACTIVE' && c.id !== current?.customerId))
          throw field422('customerId', 'not_found', 'customer not found or inactive');
        data.customerId = c.id;
      }
    }
    return data;
  }

  /** เวลาเปิด-ปิดต้องมาคู่กัน (ว่างทั้งคู่ = 24 ชม.) และไม่เท่ากัน (ปิด < เปิด = ข้ามเที่ยงคืน) */
  private assertHours(openTime: string | null, closeTime: string | null) {
    if ((openTime === null) !== (closeTime === null))
      throw field422(
        openTime === null ? 'openTime' : 'closeTime',
        'pair_required',
        'openTime and closeTime must be set together',
      );
    if (openTime !== null && openTime === closeTime)
      throw field422('closeTime', 'same_time', 'closeTime must differ from openTime');
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
    if (input.externalId) {
      // lock เดียวกับ PUT external — POST พร้อม PUT ด้วย externalId เดียวกันไม่สร้างซ้ำ
      await lockKey(tx, `${ENTITY}.ext:${input.externalId}`);
      await this.assertUniqueExternal(input.externalId);
    }
    await lockKey(tx, 'customer_site.code');
    let code = input.code;
    if (code) {
      const taken = await tx.customerSite.findFirst({
        where: { code: iEquals(code) },
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
    await this.enqueueGeocode(s);
    return s;
  }

  async update(id: string, input: UpdateSiteDto, expected?: number): Promise<CustomerSite> {
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    const data = await this.toData(input, current);
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
    // ที่อยู่เปลี่ยนตอนยังไม่มีพิกัด → ข้อเสนอเดิม/ผล FAILED ใช้ไม่ได้แล้ว → PENDING แล้ว geocode ใหม่
    const addressChanged =
      input.address !== undefined && addressText(input.address) !== addressText(current.address);
    const willHaveCoords = data.lat !== undefined ? data.lat !== null : current.lat !== null;
    if (addressChanged && !willHaveCoords) {
      data.geocodeStatus = 'PENDING';
      Object.assign(data, NO_PROPOSAL);
    }
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
    // geocode ใหม่เมื่อ: ที่อยู่เปลี่ยนตอนไม่มีพิกัด หรือคนล้างพิกัดที่มีอยู่
    if (s.lat === null && (addressChanged || current.lat !== null)) await this.enqueueGeocode(s);
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
    // ล็อกแถวก่อนนับการอ้างอิง — เส้นทางที่กำลังสร้างพร้อมกัน (lockReferenced FOR SHARE) รอจนลบเสร็จ (review ST2-T09)
    await lockForRemoval(tx, 'customer_site', id);
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
      {
        // ST2-T09: เส้นทางที่ยังไม่ลบอ้างจุดนี้เป็นต้นทาง/ปลายทาง (FK RESTRICT ด้วย)
        name: 'routes',
        count: () =>
          tx.route.count({
            where: { deletedAt: null, OR: [{ originSiteId: id }, { destSiteId: id }] },
          }),
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

  // ---------- geocode (ST2-T03) ----------

  /**
   * สั่ง geocode อัตโนมัติ (job ใน transaction เดียวกับการบันทึก) — ไม่มีผู้ให้บริการ/ที่อยู่ว่าง/มีพิกัดแล้ว = ไม่สั่ง
   * เพิ่ม `geocode_seq` ทุกครั้ง: job ที่สั่งก่อนหน้า (ที่อยู่ A→B→A, ปัก→ล้าง) เขียนผลไม่ได้อีก
   */
  private async enqueueGeocode(s: CustomerSite): Promise<void> {
    const address = addressText(s.address);
    if (!this.geo.enabled || s.lat !== null || !address) return;
    const tx = this.db.tx;
    const { geocodeSeq: seq } = await tx.customerSite.update({
      where: { id: s.id },
      data: { geocodeSeq: { increment: 1 } },
      select: { geocodeSeq: true },
    });
    const payload: GeocodeJobPayload = { siteId: s.id, address, seq };
    await this.queue.enqueue(tx, { tenantId: s.tenantId, type: GEOCODE_JOB, payload });
  }

  /** job ยังเป็นคำขอล่าสุดของสถานที่นี้ และสถานที่ยังรอผล (ไม่มีพิกัด/ข้อเสนอ, ไม่ถูกคนตัดสินไปแล้ว) */
  private isCurrentRequest(s: CustomerSite | null, p: GeocodeJobPayload): s is CustomerSite {
    return (
      !!s &&
      s.deletedAt === null &&
      s.geocodeSeq === p.seq &&
      s.lat === null &&
      s.geocodeStatus === 'PENDING' &&
      s.geocodeLat === null &&
      addressText(s.address) === p.address
    );
  }

  /** job ไม่มี request context — ตั้งให้ audit/event/db.tx ทำงาน (ผู้กระทำ = ระบบ, requestId = job) */
  private inJobContext<T>(tx: Tx, tenantId: string, jobId: string, fn: () => Promise<T>) {
    return requestContext.run({ requestId: `job:${jobId}`, tenantId, locale: 'th', tx }, fn);
  }

  /**
   * งาน geocode (outsideTransaction): อ่านใน transaction สั้น → เรียกผู้ให้บริการนอก transaction (มีเส้นตาย)
   * → transaction สั้นเขียนผลแบบมีเงื่อนไข · ปิดผู้ให้บริการแล้ว = ข้าม (คงสถานะเดิม ไม่ตั้ง FAILED)
   */
  private async runGeocodeJob(ctx: JobContext) {
    const p = ctx.job.payload as unknown as GeocodeJobPayload;
    if (!this.geo.enabled) return { skipped: true, reason: 'provider_disabled' };
    const s = await ctx.withTx((tx) =>
      tx.customerSite.findFirst({ where: { id: p.siteId, deletedAt: null } }),
    );
    if (!this.isCurrentRequest(s, p)) return { skipped: true };
    // ผู้ให้บริการล่ม/เกินเวลา = throw → JobQueue ลองใหม่ (ไม่ใช่ "หาไม่พบ")
    const [best] = await this.geo.geocode(p.address);
    const r = await ctx.withTx((tx) =>
      this.inJobContext(tx, ctx.tenantId, ctx.job.id, () =>
        this.saveGeocodeResult(p, best ?? null),
      ),
    );
    return { siteId: encodeId('site', p.siteId), result: r };
  }

  /**
   * บันทึกผล geocode ลงสถานที่ — เพิ่ม version (DM-013: ETag/ลำดับ event ตาม version)
   * เขียนเฉพาะเมื่อยังเป็นคำขอล่าสุด (`isCurrentRequest`): พบ = เสนอพิกัด (PENDING รอคนยืนยัน), ไม่พบ = FAILED
   */
  private async saveGeocodeResult(
    p: GeocodeJobPayload,
    best: { lat: number; lng: number; confidence: number } | null,
  ): Promise<'proposed' | 'failed' | 'skipped'> {
    const tx = this.db.tx;
    const s = await tx.customerSite.findFirst({ where: { id: p.siteId, deletedAt: null } });
    if (!this.isCurrentRequest(s, p)) return 'skipped';
    const data: Prisma.CustomerSiteUncheckedUpdateInput = best
      ? {
          geocodeLat: new Prisma.Decimal(best.lat.toFixed(6)),
          geocodeLng: new Prisma.Decimal(best.lng.toFixed(6)),
          geocodeConfidence: new Prisma.Decimal(best.confidence.toFixed(2)),
          geocodeProvider: this.geo.name,
          geocodedAt: new Date(),
        }
      : { geocodeStatus: 'FAILED', geocodeProvider: this.geo.name, geocodedAt: new Date() };
    const r = await tx.customerSite.updateMany({
      where: { id: s.id, version: s.version, geocodeSeq: p.seq, lat: null, deletedAt: null },
      data: { ...data, version: { increment: 1 } },
    });
    if (r.count !== 1) return 'skipped';
    const after = (await tx.customerSite.findUnique({ where: { id: s.id } }))!;
    await this.audit.changed(`${EVENT}.geocoded`, ENTITY, s.id, auditView(s), auditView(after));
    // ใบค้าง (ST3-T07): SO ที่ใช้จุด FAILED → ON_HOLD `GEOCODE_FAILED` (docs/01 §4.1) — ตอนนี้ส่ง event ให้ผู้ฟัง
    await emitMasterEvent(tx, `${EVENT}.updated`, ENTITY, s.id, await this.dto(after), {
      changedFields: best ? ['geocodeProposal'] : ['geocodeStatus'],
    });
    if (!best) this.logger.log(`site ${s.id} geocode failed`);
    return best ? 'proposed' : 'failed';
  }

  /**
   * ปุ่ม "ประมาณจากที่อยู่" — geocode ทันที ไม่บันทึกอะไร (ผู้ใช้ตรวจแล้วกดบันทึกฟอร์ม = ยืนยัน)
   * route นี้ไม่เปิด transaction (`@NoTransaction`) — ห้ามแตะ `db.tx`
   */
  async estimate(address: string): Promise<GeocodeResultDto> {
    return { provider: this.geo.name, candidates: await this.geo.geocode(address) };
  }

  /**
   * ลองหาพิกัดอีกครั้ง (FAILED หรือ PENDING ที่ยังไม่มีข้อเสนอ) → PENDING + สั่ง job ใหม่
   * มีงานของคำขอปัจจุบันรออยู่แล้ว = ไม่สั่งซ้ำ · มีพิกัด/มีข้อเสนอรอยืนยัน → 409 · ไม่มีผู้ให้บริการ → 409
   */
  async retryGeocode(id: string, expected?: number): Promise<CustomerSite> {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    if (current.lat !== null || current.geocodeLat !== null)
      throw new ProblemException(
        'invalid_state_transition',
        'site already has coordinates or a proposal waiting for confirmation',
      );
    if (!this.geo.enabled || !addressText(current.address))
      throw new ProblemException('conflict', 'no geocode provider configured or address empty');
    if (current.geocodeStatus === 'PENDING') {
      const queued = await tx.job.findFirst({
        where: {
          type: GEOCODE_JOB,
          status: { in: ['PENDING', 'RUNNING'] },
          AND: [
            { payload: { path: ['siteId'], equals: current.id } },
            { payload: { path: ['seq'], equals: current.geocodeSeq } },
          ],
        },
        select: { id: true },
      });
      if (queued) return current;
    }
    const s = await this.bumpVersion(current, { geocodeStatus: 'PENDING', ...NO_PROPOSAL });
    await this.audit.changed(
      `${EVENT}.geocode_retried`,
      ENTITY,
      s.id,
      auditView(current),
      auditView(s),
    );
    if (current.geocodeStatus !== 'PENDING')
      await emitMasterEvent(tx, `${EVENT}.updated`, ENTITY, s.id, await this.dto(s), {
        changedFields: ['geocodeStatus'],
      });
    await this.enqueueGeocode(s);
    return s;
  }

  /** คนยืนยันพิกัดที่ geocode เสนอ → lat/lng + OK (audit + event) · ไม่มีข้อเสนอ → 409 `invalid_state_transition` */
  async confirmGeocode(id: string, reason?: string, expected?: number): Promise<CustomerSite> {
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    if (current.geocodeLat === null || current.geocodeLng === null || current.lat !== null)
      throw new ProblemException('invalid_state_transition', 'no geocode proposal to confirm');
    const s = await this.bumpVersion(current, {
      lat: current.geocodeLat,
      lng: current.geocodeLng,
      geocodeStatus: 'OK',
      ...NO_PROPOSAL,
    });
    await this.audit.changed(
      `${EVENT}.geocode_confirmed`,
      ENTITY,
      s.id,
      auditView(current),
      auditView(s),
      reason,
    );
    await emitMasterEvent(this.db.tx, `${EVENT}.updated`, ENTITY, s.id, await this.dto(s), {
      changedFields: ['lat', 'lng', 'geocodeStatus', 'geocodeProposal'],
    });
    return s;
  }

  /** คนปฏิเสธพิกัดที่เสนอ (ผิดตำแหน่ง) → FAILED ให้ปักหมุดเอง — ต้องมีเหตุผล (audit) */
  async rejectGeocode(id: string, reason: string, expected?: number): Promise<CustomerSite> {
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    if (current.geocodeLat === null || current.lat !== null)
      throw new ProblemException('invalid_state_transition', 'no geocode proposal to reject');
    const s = await this.bumpVersion(current, { geocodeStatus: 'FAILED', ...NO_PROPOSAL });
    await this.audit.changed(
      `${EVENT}.geocode_rejected`,
      ENTITY,
      s.id,
      auditView(current),
      auditView(s),
      reason,
    );
    await emitMasterEvent(this.db.tx, `${EVENT}.updated`, ENTITY, s.id, await this.dto(s), {
      changedFields: ['geocodeStatus', 'geocodeProposal'],
    });
    return s;
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
