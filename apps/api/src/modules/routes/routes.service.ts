import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type ActiveStatus, type CustomerSite, type Route } from '@prisma/client';
import type { TransitionTable } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { StateService } from '../../state/state.service';
import { GeoService } from '../geo/geo.service';
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
  statusFilter,
  upsertByExternalId,
} from '../master/master-kit';
import type {
  CreateRouteDto,
  RouteDto,
  RouteEstimateDto,
  RouteListQuery,
  RouteSiteRefDto,
  RouteSummaryDto,
  UpdateRouteDto,
  UpsertRouteDto,
} from './route.dto';

export const ROUTE_CODE_PREFIX = 'RT';
const ENTITY = 'route';
const DECIMAL_FIELDS = ['distanceKm', 'tollAmount'] as const;
type RouteEvent = 'activate' | 'deactivate';
export const ROUTE_TRANSITIONS: TransitionTable<ActiveStatus, RouteEvent> = {
  ACTIVE: { deactivate: 'INACTIVE' },
  INACTIVE: { activate: 'ACTIVE' },
};

type SiteRef = Pick<CustomerSite, 'id' | 'code' | 'name' | 'kind' | 'status'>;
export type RouteWithSites = Route & { origin: SiteRef; dest: SiteRef };
const SITE_SELECT = { id: true, code: true, name: true, kind: true, status: true } as const;
const INCLUDE = { origin: { select: SITE_SELECT }, dest: { select: SITE_SELECT } } as const;

/**
 * ระยะทางของคู่ต้นทาง–ปลายทาง สำหรับ pricing (ST2-T15 ราคาแบบต่อ กม.) และวางแผน
 * ค่าเงิน/ระยะเป็น Prisma.Decimal (ไม่แปลงเป็น float)
 */
export interface RouteDistance {
  routeId: string;
  code: string;
  distanceKm: Prisma.Decimal;
  standardMinutes: number | null;
  tollAmount: Prisma.Decimal | null;
}

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

const siteRef = (s: SiteRef): RouteSiteRefDto => ({
  id: encodeId('site', s.id),
  code: s.code,
  name: s.name,
  kind: s.kind,
  status: s.status.toLowerCase() as RouteSiteRefDto['status'],
});

export function toRouteDto(r: RouteWithSites): RouteDto {
  return {
    id: encodeId('route', r.id),
    code: r.code,
    externalId: r.externalId,
    origin: siteRef(r.origin),
    destination: siteRef(r.dest),
    distanceKm: Number(r.distanceKm),
    standardMinutes: r.standardMinutes,
    tollAmount: r.tollAmount === null ? null : r.tollAmount.toFixed(2),
    notes: r.notes,
    status: r.status.toLowerCase() as RouteDto['status'],
    ...(r.deletedAt ? { deletedAt: r.deletedAt.toISOString() } : {}),
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** snapshot สำหรับ audit — ต้นทาง/ปลายทางเป็น id (ชื่อสถานที่เปลี่ยนได้ ไม่นับเป็น diff ของเส้นทาง) */
function auditView(r: RouteWithSites): Record<string, unknown> {
  const { updatedAt: _u, version: _v, origin, destination, ...rest } = toRouteDto(r);
  return { ...rest, originId: origin.id, destinationId: destination.id };
}

/**
 * เส้นทาง (ST2-T09; docs/04 B "เส้นทาง (route / OD pair)") — ใช้ master kit ของ ST2-T01
 * - ต้นทาง/ปลายทาง = สถานที่ (`customer_site`) → key เดียวกับ rate card (`origin_site_id`, `dest_site_id` — docs/01 §3.2)
 * - คู่ต้นทาง→ปลายทางห้ามซ้ำใน tenant (ทิศทางมีผล: A→B กับ B→A เป็นคนละเส้นทาง เพราะค่าผ่านทาง/เวลาอาจต่างกัน)
 *   รายการที่ปิดใช้ยังนับว่าซ้ำ (ให้เปิดใช้ของเดิม) · ที่ลบแล้วไม่นับ
 * - ระยะทางกรอกเอง หรือกด "คำนวณจากพิกัด" (GeoService.distance) แล้วคนตรวจก่อนบันทึก — ระบบไม่เขียนทับเอง
 * - `getRouteDistance()` = จุดที่ pricing (ST2-T15) เรียก
 */
@Injectable()
export class RoutesService {
  private readonly log = new Logger(RoutesService.name);

  constructor(
    private readonly db: DbService,
    private readonly state: StateService,
    private readonly audit: AuditService,
    private readonly geo: GeoService,
  ) {}

  // ---------- read ----------

  private where(q: RouteListQuery): Prisma.RouteWhereInput {
    const and: Prisma.RouteWhereInput[] = [deletedFilter(q)];
    const status = statusFilter(q.status);
    if (status) and.push({ status });
    if (q.externalId) and.push({ externalId: q.externalId });
    // id ที่ส่งมาผ่าน regex แล้ว — decode ได้เสมอ
    if (q.originId) and.push({ originSiteId: tryDecodeId('site', q.originId)! });
    if (q.destinationId) and.push({ destSiteId: tryDecodeId('site', q.destinationId)! });
    if (q.siteId) {
      const id = tryDecodeId('site', q.siteId)!;
      and.push({ OR: [{ originSiteId: id }, { destSiteId: id }] });
    }
    const like = (v: string) => ({ contains: likeEscape(v), mode: 'insensitive' as const });
    const siteLike = (v: string): Prisma.RouteWhereInput[] => [
      { origin: { name: like(v) } },
      { origin: { code: like(v) } },
      { dest: { name: like(v) } },
      { dest: { code: like(v) } },
    ];
    if (q.route) and.push({ OR: siteLike(q.route) });
    if (q.q)
      and.push({
        OR: [{ code: like(q.q) }, { externalId: like(q.q) }, ...siteLike(q.q)],
      });
    return { AND: and };
  }

  async list(q: RouteListQuery) {
    const k = masterKeyset(q);
    const rows = await this.db.tx.route.findMany({
      where: { AND: [this.where(q), k.where] },
      orderBy: k.orderBy,
      take: k.take,
      include: INCLUDE,
    });
    return k.page(rows, toRouteDto);
  }

  /** แถวสำหรับส่งออก (ตามตัวกรองเดียวกับ list หรือ id ที่เลือก) — เกินเพดาน → 422 */
  async exportRows(q: RouteListQuery & { ids?: string }) {
    const ids = q.ids?.split(',').map((x) => tryDecodeId('route', x)!);
    const where = ids ? { AND: [this.where(q), { id: { in: ids } }] } : this.where(q);
    const rows = await this.db.tx.route.findMany({
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
    return rows.map(toRouteDto);
  }

  async summary(): Promise<RouteSummaryDto> {
    const tx = this.db.tx;
    const g = await tx.route.groupBy({
      by: ['status'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    const n = (s: ActiveStatus) => g.find((x) => x.status === s)?._count._all ?? 0;
    const [withToll, noStandardTime] = await Promise.all([
      tx.route.count({ where: { deletedAt: null, tollAmount: { gt: 0 } } }),
      tx.route.count({ where: { deletedAt: null, standardMinutes: null } }),
    ]);
    return {
      total: n('ACTIVE') + n('INACTIVE'),
      active: n('ACTIVE'),
      inactive: n('INACTIVE'),
      withToll,
      noStandardTime,
    };
  }

  async nextCode(): Promise<string> {
    return nextCode(this.db.tx, 'route', ROUTE_CODE_PREFIX);
  }

  async get(id: string): Promise<RouteWithSites> {
    const r = await this.db.tx.route.findFirst({
      where: { id, deletedAt: null },
      include: INCLUDE,
    });
    if (!r) throw new ProblemException('not_found');
    return r;
  }

  async getByExternalId(externalId: string): Promise<RouteWithSites> {
    const r = await this.db.tx.route.findFirst({
      where: { externalId, deletedAt: null },
      include: INCLUDE,
    });
    if (!r) throw new ProblemException('not_found');
    return r;
  }

  /**
   * ระยะทางของคู่ต้นทาง→ปลายทาง (uuid ของ customer_site) · ไม่มี = null
   * คืนเฉพาะเมื่อเส้นทางใช้งาน + ไม่ถูกลบ **และ** ต้นทาง/ปลายทางใช้งาน + ไม่ถูกลบ (review ST2-T09 — spec/12 §3)
   * ใช้โดย pricing (ST2-T15: PER_DISTANCE = rate × distanceKm)
   * **`tx` ต้องเป็น transaction ที่ตั้ง tenant แล้ว** (ค่าเริ่มต้น = transaction ของ request, นอก request ใช้
   * `DbService.withTenant()`) — ห้ามส่ง platform client (ข้าม RLS → เห็นเส้นทางของทุก tenant)
   */
  async getRouteDistance(
    originSiteId: string,
    destSiteId: string,
    tx: Tx = this.db.tx,
  ): Promise<RouteDistance | null> {
    const r = await tx.route.findFirst({
      where: {
        originSiteId,
        destSiteId,
        deletedAt: null,
        status: 'ACTIVE',
        origin: { status: 'ACTIVE', deletedAt: null },
        dest: { status: 'ACTIVE', deletedAt: null },
      },
      select: { id: true, code: true, distanceKm: true, standardMinutes: true, tollAmount: true },
    });
    if (!r) return null;
    return {
      routeId: r.id,
      code: r.code,
      distanceKm: r.distanceKm,
      standardMinutes: r.standardMinutes,
      tollAmount: r.tollAmount,
    };
  }

  /**
   * ปุ่ม "คำนวณจากพิกัด" — ระยะทาง/เวลาจากผู้ให้บริการแผนที่ (ไม่บันทึก; คนตรวจแล้วบันทึกฟอร์ม)
   * อ่านพิกัดใน transaction สั้น ๆ แล้วเรียกผู้ให้บริการนอก transaction (เส้นตาย GEO_TIMEOUT_MS)
   */
  async estimate(originId: string, destinationId: string): Promise<RouteEstimateDto> {
    const tenantId = requestContext.require().tenantId!;
    const o = tryDecodeId('site', originId)!;
    const d = tryDecodeId('site', destinationId)!;
    if (o === d) throw field422('destinationId', 'same_site', 'origin and destination must differ');
    const sites = await this.db.withTenant(tenantId, (tx) =>
      tx.customerSite.findMany({
        where: { id: { in: [o, d] }, deletedAt: null },
        select: { id: true, lat: true, lng: true, status: true },
      }),
    );
    const so = sites.find((s) => s.id === o);
    const sd = sites.find((s) => s.id === d);
    if (!so) throw field422('originId', 'reference_not_found', 'origin site not found');
    if (!sd) throw field422('destinationId', 'reference_not_found', 'destination site not found');
    // กฎเดียวกับการสร้างเส้นทาง: สถานที่ปิดใช้ → 422
    if (so.status !== 'ACTIVE') throw field422('originId', 'site_inactive', 'site is inactive');
    if (sd.status !== 'ACTIVE')
      throw field422('destinationId', 'site_inactive', 'site is inactive');
    const none = (result: RouteEstimateDto['result']): RouteEstimateDto => ({
      result,
      distanceKm: null,
      standardMinutes: null,
      provider: this.geo.name,
    });
    if (so.lat === null || so.lng === null || sd.lat === null || sd.lng === null)
      return none('no_coords');
    try {
      const r = await this.geo.distance(
        { lat: Number(so.lat), lng: Number(so.lng) },
        { lat: Number(sd.lat), lng: Number(sd.lng) },
      );
      if (!r || !(r.km > 0)) return none('unavailable');
      return {
        result: 'ok',
        distanceKm: Math.max(0.1, Math.round(r.km * 10) / 10),
        standardMinutes: r.minutes > 0 ? Math.round(r.minutes) : null,
        provider: this.geo.name,
      };
    } catch (e) {
      this.log.warn(`route estimate failed: ${(e as Error).message}`);
      return none('unavailable');
    }
  }

  // ---------- write ----------

  /** id สถานที่จาก API → uuid (ยังไม่อ่านฐาน) · รูปแบบผิด → 422 */
  private siteId(value: string, field: string): string {
    const id = tryDecodeId('site', value);
    if (!id) throw field422(field, 'reference_not_found', 'site not found');
    return id;
  }

  /**
   * ล็อกสถานที่ที่จะอ้าง (`FOR SHARE` — กันถูกลบระหว่างสร้าง/แก้เส้นทาง, review ST2-T09) แล้วตรวจ:
   * ไม่พบ/ข้าม tenant/ลบแล้ว → 422 `reference_not_found` · ปิดใช้ → 422 `site_inactive`
   * ลำดับล็อกทั้งระบบ: ext → od → แถวสถานที่ → code (ลด deadlock)
   */
  private async lockSites(checks: { id: string; field: string }[]): Promise<void> {
    if (!checks.length) return;
    const rows = await lockReferenced(
      this.db.tx,
      'customer_site',
      checks.map((c) => c.id),
    );
    for (const c of checks) {
      const s = rows.find((x) => x.id === c.id);
      if (!s) throw field422(c.field, 'reference_not_found', 'site not found');
      if (s.status !== 'ACTIVE') throw field422(c.field, 'site_inactive', 'site is inactive');
    }
  }

  /** เกณฑ์ตรวจรับ: คู่ต้นทาง→ปลายทางเดิมสร้างซ้ำไม่ได้ → 409 `duplicate` พร้อมเส้นทางเดิม */
  private async assertUniqueOD(origin: string, dest: string, exceptId?: string) {
    if (origin === dest)
      throw field422('destinationId', 'same_site', 'origin and destination must differ');
    await lockKey(this.db.tx, `route.od:${origin}:${dest}`);
    const dup = await this.db.tx.route.findFirst({
      where: {
        originSiteId: origin,
        destSiteId: dest,
        deletedAt: null,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true, code: true, status: true },
    });
    if (dup)
      throw new ProblemException(
        'duplicate',
        undefined,
        [
          {
            field: 'destinationId',
            code: 'duplicate_route',
            message: `route already exists: ${dup.code}`,
          },
        ],
        {
          existing: {
            id: encodeId('route', dup.id),
            code: dup.code,
            status: dup.status.toLowerCase(),
          },
        },
      );
  }

  private async assertUniqueExternal(externalId: string, exceptId?: string) {
    const dup = await this.db.tx.route.findFirst({
      where: { externalId, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (dup)
      throw new ProblemException('duplicate', undefined, [
        { field: 'externalId', code: 'duplicate', message: 'externalId already used' },
      ]);
  }

  /** ฟิลด์ไม่บังคับ → คอลัมน์ */
  private optionalData(input: UpdateRouteDto | CreateRouteDto): Prisma.RouteUncheckedUpdateInput {
    const data: Prisma.RouteUncheckedUpdateInput = {};
    if (input.distanceKm !== undefined) data.distanceKm = new Prisma.Decimal(input.distanceKm);
    if (input.standardMinutes !== undefined) data.standardMinutes = input.standardMinutes;
    if (input.tollAmount !== undefined)
      data.tollAmount = input.tollAmount === null ? null : new Prisma.Decimal(input.tollAmount);
    if (input.notes !== undefined) data.notes = input.notes === '' ? null : input.notes;
    return data;
  }

  async create(input: CreateRouteDto | (UpsertRouteDto & { externalId: string })) {
    const tx = this.db.tx;
    const origin = this.siteId(input.originId, 'originId');
    const dest = this.siteId(input.destinationId, 'destinationId');
    if (origin === dest)
      throw field422('destinationId', 'same_site', 'origin and destination must differ');
    // ลำดับล็อกเดียวกับ PUT external (upsertByExternalId ล็อก ext ก่อน): ext → od → สถานที่ → code (review ST2-T09: deadlock)
    if (input.externalId) {
      await lockKey(tx, `route.ext:${input.externalId}`);
      await this.assertUniqueExternal(input.externalId);
    }
    await this.assertUniqueOD(origin, dest);
    await this.lockSites([
      { id: origin, field: 'originId' },
      { id: dest, field: 'destinationId' },
    ]);
    await lockKey(tx, 'route.code');
    let code = input.code;
    if (code) {
      const taken = await tx.route.findFirst({
        where: { code: iEquals(code) },
        select: { id: true },
      });
      if (taken)
        throw new ProblemException('duplicate', undefined, [
          { field: 'code', code: 'duplicate', message: 'code already exists' },
        ]);
    } else code = await nextCode(tx, 'route', ROUTE_CODE_PREFIX);
    const r = await tx.route.create({
      data: {
        ...(this.optionalData(input) as object),
        code,
        originSiteId: origin,
        destSiteId: dest,
        externalId: input.externalId ?? null,
      } as Prisma.RouteUncheckedCreateInput, // tenantId เติมโดย tenantExtension
      include: INCLUDE,
    });
    await this.audit.record({
      action: `${ENTITY}.created`,
      entityType: ENTITY,
      entityId: r.id,
      after: auditView(r),
    });
    await emitMasterEvent(tx, `${ENTITY}.created`, ENTITY, r.id, toRouteDto(r));
    return r;
  }

  async update(id: string, input: UpdateRouteDto, expected?: number): Promise<RouteWithSites> {
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    const data = this.optionalData(input);
    // เปลี่ยนต้นทาง/ปลายทาง: จุดใหม่ต้องใช้งานอยู่ · ส่งจุดเดิม (แม้ปิดใช้แล้ว) = ไม่เปลี่ยน
    const sameOrigin =
      input.originId === undefined || tryDecodeId('site', input.originId) === current.originSiteId;
    const sameDest =
      input.destinationId === undefined ||
      tryDecodeId('site', input.destinationId) === current.destSiteId;
    const origin = sameOrigin ? current.originSiteId : this.siteId(input.originId!, 'originId');
    const dest = sameDest ? current.destSiteId : this.siteId(input.destinationId!, 'destinationId');
    // ลำดับล็อก ext → od → สถานที่ (เหมือน create / PUT external)
    if (input.externalId !== undefined) {
      if (input.externalId) {
        await lockKey(this.db.tx, `route.ext:${input.externalId}`);
        await this.assertUniqueExternal(input.externalId, current.id);
      }
      data.externalId = input.externalId;
    }
    if (!sameOrigin || !sameDest) {
      await this.assertUniqueOD(origin, dest, current.id);
      await this.lockSites([
        ...(sameOrigin ? [] : [{ id: origin, field: 'originId' }]),
        ...(sameDest ? [] : [{ id: dest, field: 'destinationId' }]),
      ]);
      data.originSiteId = origin;
      data.destSiteId = dest;
    }
    if (isNoopUpdate(current, data as Record<string, unknown>, DECIMAL_FIELDS)) return current; // ส่งซ้ำค่าเดิมไม่เพิ่ม version
    const r = await this.bumpVersion(current, data);
    const before = auditView(current);
    const after = auditView(r);
    await this.audit.changed(`${ENTITY}.updated`, ENTITY, r.id, before, after);
    const changed = Object.keys(after).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    if (changed.length)
      await emitMasterEvent(this.db.tx, `${ENTITY}.updated`, ENTITY, r.id, toRouteDto(r), {
        changedFields: changed,
      });
    return r;
  }

  /** PUT /routes/external/{externalId} — idempotent (ส่งซ้ำ = อัปเดตแถวเดิม) */
  async upsertExternal(externalId: string, input: UpsertRouteDto, expected?: number) {
    const tx = this.db.tx;
    return upsertByExternalId(tx, ENTITY, externalId, {
      find: () => tx.route.findFirst({ where: { externalId, deletedAt: null }, include: INCLUDE }),
      create: () => this.create({ ...input, externalId }),
      update: (cur) => {
        const { code: _code, ...rest } = input;
        return this.update(cur.id, rest, expected);
      },
    });
  }

  async changeStatus(id: string, event: RouteEvent, reason?: string, expected?: number) {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    // เปิดใช้ได้เมื่อต้นทาง/ปลายทางยังใช้งานอยู่ (review ST2-T09 — spec/12 §3) → ไม่งั้น 422 `site_inactive`
    if (event === 'activate')
      await this.lockSites([
        { id: current.originSiteId, field: 'originId' },
        { id: current.destSiteId, field: 'destinationId' },
      ]);
    let updated!: RouteWithSites;
    await this.state.transition(tx, {
      docType: ENTITY,
      docId: id,
      table: ROUTE_TRANSITIONS,
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
          auditView(current),
          auditView(updated),
          reason,
        );
        return toRouteDto(updated) as unknown as Record<string, unknown>;
      },
    });
    return updated;
  }

  /**
   * "ลบ" (MD-004) → soft delete — ยังไม่มีเอกสารอ้าง route_id (rate card/SO อ้างคู่สถานที่ ไม่ใช่เส้นทาง)
   * SO/DO ที่ snapshot ระยะทางไปแล้วไม่กระทบ (spec/02 MD-117)
   */
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
      before: auditView(current),
      reason,
    });
    await emitMasterEvent(tx, `${ENTITY}.deleted`, ENTITY, id, toRouteDto(current));
  }

  /** optimistic lock: update เฉพาะเมื่อ version ยังเท่าเดิม ไม่งั้น 412 */
  private async bumpVersion(
    current: Route,
    data: Prisma.RouteUncheckedUpdateInput,
  ): Promise<RouteWithSites> {
    const tx = this.db.tx;
    const r = await tx.route.updateMany({
      where: { id: current.id, version: current.version, deletedAt: null },
      data: { ...data, version: { increment: 1 } },
    });
    if (r.count !== 1) throw new ProblemException('precondition_failed');
    return (await tx.route.findUnique({ where: { id: current.id }, include: INCLUDE }))!;
  }
}
