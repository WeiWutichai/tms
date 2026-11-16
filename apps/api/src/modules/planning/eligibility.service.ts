import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { checkAssignability, checkLoad, TRIP_OPEN_STATUSES } from '@tms/domain';
import { decodeIdOr404, encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { DbService, type Tx } from '../../db/db.service';
import { assignabilityMessageTh } from '../assignability/assignability.service';
import {
  compatibilityViews,
  type CompatProductRow,
  type CompatSiteRow,
} from '../compatibility/compatibility.service';
import {
  driverOnLeaveMessageTh,
  loadMessageTh,
  vehicleNotReadyMessageTh,
  vehicleOverlapMessageTh,
} from '../trips/rule-messages';
import { addDays, bangkokToday } from '../vehicle-documents/expiry';
import type {
  EligibilityIssueDto,
  EligibilityItemDto,
  PlanningEligibilityDto,
} from './planning.dto';
import { PlanningService, POOL_DO } from './planning.service';

export type EligibilityLevel = 'OK' | 'WARNING' | 'BLOCK';

/** ระดับรวมของรายการกฎ — บล็อก > คำเตือน > ผ่าน (`info` ไม่นับ — MD-093 "ใช้รถใหญ่กว่า" เป็นป้ายแจ้งเฉย ๆ) */
export function eligibilityLevel(issues: readonly { severity: string }[]): EligibilityLevel {
  if (issues.some((i) => i.severity === 'block')) return 'BLOCK';
  if (issues.some((i) => i.severity === 'warning')) return 'WARNING';
  return 'OK';
}

/** งานที่จะประเมิน: SO รอจัด (DO รอจัดของ SO) หรือเที่ยว (DO ทั้งหมดของเที่ยว) */
interface Job {
  orderId: string | null;
  tripId: string | null;
  weightKg: Prisma.Decimal | null;
  cbm: Prisma.Decimal | null;
  hazmat: boolean;
  /** กลุ่มต่อ SO (ความเข้ากันได้ตรวจต่อ SO เหมือน `TripService.compatWarnings`) */
  groups: { productIds: string[]; siteIds: string[]; requestedTypeId: string | null }[];
}

const DO_SELECT = {
  salesOrderId: true,
  tripId: true,
  weightKg: true,
  cbm: true,
  originSiteId: true,
  destSiteId: true,
  salesOrder: { select: { vehicleTypeId: true } },
  lines: { select: { salesOrderLine: { select: { productId: true, isDangerous: true } } } },
} as const;
type DoRow = Prisma.DeliveryOrderGetPayload<{ select: typeof DO_SELECT }>;

const VEHICLE_INCLUDE = {
  vehicleType: {
    select: {
      vehicleClass: true,
      capabilityTags: true,
      tempMinC: true,
      tempMaxC: true,
      capacityKg: true,
      capacityCbm: true,
      minLicenceClass: true,
    },
  },
  carrier: { select: { status: true, deletedAt: true } },
  documents: {
    select: {
      id: true,
      docType: true,
      status: true,
      startsOn: true,
      expiresOn: true,
      isRequiredForDispatch: true,
      renewsId: true,
      title: true,
    },
  },
  // คนขับประจำ = คนขับที่จะติดรถตอนจัด (ชุดเดียวกับแถวรถบนกระดาน)
  defaultDrivers: {
    where: { deletedAt: null, status: { not: 'INACTIVE' as const } },
    select: { name: true, status: true, licenceClass: true, licenceExpiresAt: true },
    orderBy: { code: 'asc' as const },
    take: 1,
  },
} as const;
type VehicleRow = Prisma.VehicleGetPayload<{ include: typeof VEHICLE_INCLUDE }>;

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDec = (a: Prisma.Decimal | null, v: Prisma.Decimal | null) =>
  v === null ? a : a === null ? v : a.add(v);

/**
 * Filter รถที่รับได้สองทาง (ST3-T15; docs/04 D2 "Filter รถที่รับได้สองทาง"; spec/03 §5 "คลิกการ์ดใน SO รอจัด → ไฮไลต์รถที่รับได้")
 * ประเมินกฎตอนจัดของ ST3-T14 **ชุดเดียวกัน** (ตัวตรวจใน @tms/domain + ข้อความเดียวกับผลตรวจของเที่ยว) แบบรวมคำขอเดียว:
 * - งาน × รถทุกคัน (คลิก SO / "ย้ายไปรถอื่น" ของเที่ยว) หรือ รถ × SO รอจัดทุกใบ (คลิกรถ) — อ่านฐานจำนวนคงที่ ไม่ N+1
 * - กฎ: สถานะรถ · รถร่วมถูกระงับ · ความเข้ากันได้ (ห้องเย็น/ขนาด/สินค้าอันตราย/จุดจำกัดรถ) · น้ำหนัก/ปริมาตรต่อความจุ ·
 *   เอกสารรถ + ใบขับขี่คนขับประจำ (หมด/ชั้น/ท.4 สินค้าอันตราย) ต่อวัน · คนขับประจำลา · (เที่ยว) รถมีเที่ยวอื่นซ้อนเวลา
 * - ไม่ประเมินกฎที่ขึ้นกับเวลาที่ยังไม่เลือก (ซ้อนเวลา/ชั่วโมงขับของ SO ที่ยังไม่ลงเวลา) — server ตรวจซ้ำตอนวางเสมอ (PLN-042)
 * อ่านอย่างเดียว ไม่เขียน ไม่บล็อก — การบังคับ + ยกเว้นยังอยู่ที่ `/v1/trips` (`enforceRules`)
 */
@Injectable()
export class EligibilityService {
  constructor(
    private readonly db: DbService,
    private readonly planning: PlanningService,
  ) {}

  async eligibility(
    q: { orderId?: string; vehicleId?: string; tripId?: string; date?: string; days?: number },
    tx: Tx = this.db.tx,
  ): Promise<PlanningEligibilityDto> {
    const given = (['orderId', 'vehicleId', 'tripId'] as const).filter((k) => q[k] !== undefined);
    if (given.length !== 1)
      throw new ProblemException('validation_failed', undefined, [
        {
          field: given[1] ?? 'orderId',
          code: 'exactly_one',
          message: 'send exactly one of orderId, vehicleId, tripId',
        },
      ]);
    const from = q.date ?? bangkokToday();
    const dates = Array.from({ length: q.days ?? 1 }, (_, i) => addDays(from, i));
    const to = dates[dates.length - 1]!;

    if (q.tripId !== undefined) {
      const id = decodeIdOr404('trip', q.tripId);
      const trip = await tx.trip.findUnique({ where: { id } });
      if (!trip) throw new ProblemException('not_found');
      const dos = await tx.deliveryOrder.findMany({
        where: { tripId: id, status: { not: 'CANCELLED' } },
        select: DO_SELECT,
      });
      const [job] = this.jobs(dos, (d) => d.tripId!);
      const vehicles = await this.vehicles(tx);
      // ช่วงตรวจเอกสาร = ครอบวันเที่ยวและช่วงวิ่ง (ชุดเดียวกับ `refreshWarnings`)
      const points = [trip.tripDate, trip.plannedStartAt, trip.plannedEndAt].filter(
        (d): d is Date => d !== null,
      );
      const window = {
        from: bangkokToday(new Date(Math.min(...points.map((d) => d.getTime())))),
        to: bangkokToday(new Date(Math.max(...points.map((d) => d.getTime())))),
      };
      const overlaps = await this.overlaps(tx, trip, vehicles);
      const ref = await this.refs(tx, job ? [job] : []);
      const subject: Job = job ?? {
        orderId: null,
        tripId: null,
        weightKg: null,
        cbm: null,
        hazmat: false,
        groups: [],
      };
      subject.tripId = encodeId('trip', id);
      return {
        from: window.from,
        to: window.to,
        subject: 'TRIP',
        items: vehicles.map((v) => {
          const issues = this.evaluate(v, subject, ref, { window });
          const o = overlaps.get(v.id);
          if (o?.length)
            issues.push({
              code: 'vehicle_overlap',
              severity: 'warning',
              message: vehicleOverlapMessageTh(v.plate, o),
              date: null,
            });
          return this.item(v, subject, issues);
        }),
      };
    }

    if (q.orderId !== undefined) {
      const id = decodeIdOr404('salesOrder', q.orderId);
      const so = await tx.salesOrder.findUnique({ where: { id }, select: { id: true } });
      if (!so) throw new ProblemException('not_found');
      // DO รอจัดของ SO · ไม่มี (ลงเที่ยวครบแล้ว) → ประเมินจาก DO ที่ยังไม่ยกเลิกทั้งหมด
      let dos = await tx.deliveryOrder.findMany({
        where: { salesOrderId: id, ...POOL_DO },
        select: DO_SELECT,
      });
      if (!dos.length)
        dos = await tx.deliveryOrder.findMany({
          where: { salesOrderId: id, status: { not: 'CANCELLED' } },
          select: DO_SELECT,
        });
      const jobs = this.jobs(dos, (d) => d.salesOrderId);
      const job: Job = jobs[0] ?? {
        orderId: null,
        tripId: null,
        weightKg: null,
        cbm: null,
        hazmat: false,
        groups: [],
      };
      job.orderId = encodeId('salesOrder', id);
      const [vehicles, ref] = [await this.vehicles(tx), await this.refs(tx, [job])];
      return {
        from,
        to,
        subject: 'ORDER',
        items: vehicles.map((v) => this.item(v, job, this.evaluate(v, job, ref, { dates }))),
      };
    }

    const vid = decodeIdOr404('vehicle', q.vehicleId!);
    const [vehicle] = await this.vehicles(tx, vid);
    if (!vehicle) throw new ProblemException('not_found');
    const ids = await this.planning.poolOrderIds(tx);
    const dos = ids.length
      ? await tx.deliveryOrder.findMany({
          where: { ...POOL_DO, salesOrderId: { in: ids } },
          select: DO_SELECT,
        })
      : [];
    const jobs = this.jobs(dos, (d) => d.salesOrderId);
    const ref = await this.refs(tx, jobs);
    return {
      from,
      to,
      subject: 'VEHICLE',
      items: jobs.map((j) => this.item(vehicle, j, this.evaluate(vehicle, j, ref, { dates }))),
    };
  }

  /** รถที่จัดได้บนกระดาน (ไม่ลบ/ไม่ปลดระวาง/ไม่ใช่หาง — ชุดเดียวกับแถวรถ) หรือคันเดียว */
  private vehicles(tx: Tx, id?: string): Promise<VehicleRow[]> {
    return tx.vehicle.findMany({
      where: {
        deletedAt: null,
        status: { not: 'RETIRED' },
        unitRole: { not: 'TRAILER' },
        ...(id ? { id } : {}),
      },
      include: VEHICLE_INCLUDE,
      orderBy: { plate: 'asc' },
    });
  }

  /** DO → งาน (จัดกลุ่มด้วย `keyOf` — SO หรือเที่ยว) · คงลำดับที่พบครั้งแรก */
  private jobs(dos: DoRow[], keyOf: (d: DoRow) => string): Job[] {
    const by = new Map<string, DoRow[]>();
    for (const d of dos) by.set(keyOf(d), [...(by.get(keyOf(d)) ?? []), d]);
    return [...by.entries()].map(([key, group]) => {
      const bySo = new Map<string, DoRow[]>();
      for (const d of group) bySo.set(d.salesOrderId, [...(bySo.get(d.salesOrderId) ?? []), d]);
      return {
        orderId: encodeId('salesOrder', group[0]!.salesOrderId),
        tripId: group[0]!.tripId && key === group[0]!.tripId ? encodeId('trip', key) : null,
        weightKg: group.reduce<Prisma.Decimal | null>((a, d) => addDec(a, d.weightKg), null),
        cbm: group.reduce<Prisma.Decimal | null>((a, d) => addDec(a, d.cbm), null),
        hazmat: group.some((d) => d.lines.some((l) => l.salesOrderLine?.isDangerous)),
        groups: [...bySo.values()].map((g) => ({
          productIds: g.flatMap((d) =>
            d.lines.flatMap((l) =>
              l.salesOrderLine?.productId ? [l.salesOrderLine.productId] : [],
            ),
          ),
          siteIds: g.flatMap((d) => [d.originSiteId, d.destSiteId]),
          requestedTypeId: g[0]!.salesOrder.vehicleTypeId,
        })),
      };
    });
  }

  /** สินค้า/จุด/ประเภทรถที่ SO ขอ ของทุกงาน — อ่านครั้งเดียว */
  private async refs(tx: Tx, jobs: Job[]) {
    const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];
    const productIds = uniq(jobs.flatMap((j) => j.groups.flatMap((g) => g.productIds)));
    const siteIds = uniq(jobs.flatMap((j) => j.groups.flatMap((g) => g.siteIds)));
    const typeIds = uniq(jobs.flatMap((j) => j.groups.map((g) => g.requestedTypeId)));
    const products = productIds.length
      ? await tx.product.findMany({
          where: { id: { in: productIds } },
          select: {
            id: true,
            code: true,
            nameTh: true,
            tempControlled: true,
            tempMinC: true,
            tempMaxC: true,
            hazardous: true,
          },
        })
      : [];
    const sites = siteIds.length
      ? await tx.customerSite.findMany({
          where: { id: { in: siteIds } },
          select: { id: true, code: true, name: true, maxVehicleClass: true },
        })
      : [];
    const types = typeIds.length
      ? await tx.vehicleType.findMany({
          where: { id: { in: typeIds } },
          select: { id: true, vehicleClass: true, capabilityTags: true },
        })
      : [];
    return {
      products: new Map<string, CompatProductRow>(products.map((p) => [p.id, p])),
      sites: new Map<string, CompatSiteRow>(sites.map((s) => [s.id, s])),
      types: new Map(types.map((t) => [t.id, t])),
    };
  }

  /** เที่ยวอื่นที่ยังไม่จบของรถแต่ละคันที่ซ้อนกับเที่ยวนี้ (กฎเดียวกับ `overlapWarnings`) — คำขอเดียวสำหรับทุกคัน */
  private async overlaps(
    tx: Tx,
    trip: { id: string; tripDate: Date; plannedStartAt: Date | null; plannedEndAt: Date | null },
    vehicles: VehicleRow[],
  ): Promise<Map<string, string[]>> {
    const others = await tx.trip.findMany({
      where: {
        id: { not: trip.id },
        status: { in: [...TRIP_OPEN_STATUSES] },
        vehicleId: { in: vehicles.map((v) => v.id) },
        OR: [
          { tripDate: trip.tripDate },
          ...(trip.plannedStartAt && trip.plannedEndAt
            ? [
                {
                  plannedStartAt: { lt: trip.plannedEndAt },
                  plannedEndAt: { gt: trip.plannedStartAt },
                },
              ]
            : []),
        ],
      },
      select: {
        vehicleId: true,
        tripNo: true,
        tripDate: true,
        plannedStartAt: true,
        plannedEndAt: true,
      },
      orderBy: { tripNo: 'asc' },
    });
    const out = new Map<string, string[]>();
    for (const o of others) {
      const hit =
        !trip.plannedStartAt || !trip.plannedEndAt || !o.plannedStartAt || !o.plannedEndAt
          ? o.tripDate.getTime() === trip.tripDate.getTime()
          : o.plannedStartAt < trip.plannedEndAt && trip.plannedStartAt < o.plannedEndAt;
      if (hit) out.set(o.vehicleId!, [...(out.get(o.vehicleId!) ?? []), o.tripNo!]);
    }
    return out;
  }

  /** กฎของ ST3-T14 กับรถ 1 คัน × งาน 1 งาน (ฟังก์ชันล้วนจาก @tms/domain — ไม่มี I/O) */
  private evaluate(
    v: VehicleRow,
    job: Job,
    ref: Awaited<ReturnType<EligibilityService['refs']>>,
    when: { dates: string[] } | { window: { from: string; to: string } },
  ): EligibilityIssueDto[] {
    const out: EligibilityIssueDto[] = [];
    const add = (code: string, severity: string, message: string, date: string | null = null) =>
      out.push({ code, severity: severity as EligibilityIssueDto['severity'], message, date });
    if (v.status !== 'READY')
      add('vehicle_not_ready', 'warning', vehicleNotReadyMessageTh(v.plate, v.status));
    // รถร่วมถูกระงับ/ลบ = วางลงรถคันนี้ไม่ได้ (POST /v1/trips ตอบ 422 `carrier_inactive`)
    if (
      v.ownership === 'SUBCONTRACT' &&
      (!v.carrier || v.carrier.deletedAt || v.carrier.status !== 'ACTIVE')
    )
      add('carrier_inactive', 'block', 'รถร่วมของรถคันนี้ถูกระงับ — จัดงานให้ไม่ได้');
    // ความเข้ากันได้ต่อ SO (ตัดซ้ำ — เหมือน `compatWarnings`)
    const seen = new Set<string>();
    for (const g of job.groups) {
      const req = g.requestedTypeId ? ref.types.get(g.requestedTypeId) : undefined;
      const ws = compatibilityViews({
        vehicleType: v.vehicleType,
        products: [...new Set(g.productIds)].flatMap((id) =>
          ref.products.has(id) ? [ref.products.get(id)!] : [],
        ),
        sites: [...new Set(g.siteIds)].flatMap((id) =>
          ref.sites.has(id) ? [ref.sites.get(id)!] : [],
        ),
        requested: req ?? null,
        job: {},
      });
      for (const w of ws) {
        const k = `${w.code}|${JSON.stringify(w.params)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        add(w.code, w.severity, w.message);
      }
    }
    for (const i of checkLoad({
      weightKg: job.weightKg?.toString() ?? null,
      cbm: job.cbm?.toString() ?? null,
      capacityKg: (v.capacityKg ?? v.vehicleType.capacityKg)?.toString() ?? null,
      capacityCbm: (v.capacityCbm ?? v.vehicleType.capacityCbm)?.toString() ?? null,
    }))
      add(i.code, i.severity, loadMessageTh(i));
    const hazmat =
      job.hazmat ||
      job.groups.some((g) => g.productIds.some((id) => ref.products.get(id)?.hazardous));
    const d = v.defaultDrivers[0];
    const input = {
      vehicle: { ownership: v.ownership, minLicenceClass: v.vehicleType.minLicenceClass },
      hazmat,
      documents: v.documents.map((x) => ({
        ...x,
        startsOn: ymd(x.startsOn),
        expiresOn: ymd(x.expiresOn),
      })),
      driver: d
        ? {
            licenceExpiresOn: d.licenceExpiresAt ? ymd(d.licenceExpiresAt) : null,
            licenceClass: d.licenceClass,
          }
        : null,
    };
    // เอกสารรถ/ใบขับขี่: ช่วงวิ่งของเที่ยว หรือรายวัน (ติดทุกวัน = date null · ติดบางวัน = รายวัน)
    const ranges =
      'window' in when
        ? [{ date: null, window: when.window }]
        : when.dates.map((x) => ({ date: x, window: { from: x, to: x } }));
    const per = ranges.map((r) => {
      const a = checkAssignability({ ...input, window: r.window });
      return { date: r.date, issues: [...a.blocks, ...a.warnings] };
    });
    const keyOf = (i: { code: string; params: object; docType?: string }) =>
      `${i.code}|${i.docType ?? ''}|${JSON.stringify(i.params)}`;
    const all = per.length
      ? per
          .map((p) => new Set(p.issues.map(keyOf)))
          .reduce((a, b) => new Set([...a].filter((k) => b.has(k))))
      : new Set<string>();
    const done = new Set<string>();
    for (const p of per)
      for (const i of p.issues) {
        const k = keyOf(i);
        if (all.has(k)) {
          if (done.has(k)) continue;
          done.add(k);
          add(i.code, i.severity, assignabilityMessageTh(i));
        } else add(i.code, i.severity, assignabilityMessageTh(i), p.date);
      }
    if (d?.status === 'ON_LEAVE')
      add('driver_on_leave', 'warning', driverOnLeaveMessageTh('driver', d.name));
    return out;
  }

  private item(v: VehicleRow, job: Job, issues: EligibilityIssueDto[]): EligibilityItemDto {
    return {
      vehicleId: encodeId('vehicle', v.id),
      orderId: job.tripId ? null : job.orderId,
      tripId: job.tripId,
      level: eligibilityLevel(issues),
      issues,
    };
  }
}
