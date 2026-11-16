import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { checkAssignability, vehicleOverlaps, type TripStatus } from '@tms/domain';
import { assignabilityMessageTh } from '../assignability/assignability.service';
import { encodeId } from '../../common/ids';
import { DbService, type Tx } from '../../db/db.service';
import { NOT_READY_HOLDS, PLANNABLE_SO_STATUSES } from '../delivery-orders/delivery-order.service';
import { addDays, bangkokToday } from '../vehicle-documents/expiry';
import type {
  BoardPoolOrderDto,
  BoardTripDto,
  BoardVehicleDto,
  PlanningBoardDto,
} from './planning.dto';

/** SO รอจัดสูงสุดต่อครั้ง (นับเป็น SO — กระดานเฟส 0; PLN-051 virtualized = งานถัดไป) */
const POOL_LIMIT = 500;

const dec = (v: Prisma.Decimal | null | undefined) =>
  v === null || v === undefined ? null : v.toFixed(3).replace(/\.?0+$/, '') || '0';
const sum = (vs: (Prisma.Decimal | null)[]) =>
  dec(
    vs.reduce<Prisma.Decimal | null>((a, v) => (v === null ? a : a === null ? v : a.add(v)), null),
  ) ?? '0';
const province = (address: Prisma.JsonValue): string | null => {
  const p = (address as { province?: unknown } | null)?.province;
  return typeof p === 'string' && p.trim() ? p.trim() : null;
};
const place = (s: { name: string; address: Prisma.JsonValue }) => ({
  name: s.name,
  province: province(s.address),
});

/**
 * กระดานวางแผน (ST3-T12; docs/04 D2; spec/03 §5) — อ่านอย่างเดียว: แถวรถ + เที่ยวในช่วงวัน + SO รอจัด
 * ใช้ API ชุดเดียวกับลูกค้า (เขียนผ่าน /v1/trips เท่านั้น) · ซ้อนเวลาคำนวณ ณ ตอนอ่าน (`vehicleOverlaps`) เพราะ
 * `rule_warnings` ของเที่ยวเป็นภาพ ณ การกระทำล่าสุด (ST3-T11) · ไม่มีราคา
 */
@Injectable()
export class PlanningService {
  constructor(private readonly db: DbService) {}

  async board(q: { date?: string; days?: number }, tx: Tx = this.db.tx): Promise<PlanningBoardDto> {
    const today = bangkokToday();
    const from = q.date ?? today;
    const to = addDays(from, (q.days ?? 1) - 1);
    // ทีละคำสั่ง — transaction เดียวของ request (RLS) ไม่รันคู่ขนาน
    const days = Array.from({ length: q.days ?? 1 }, (_, i) => addDays(from, i));
    const vehicles = await this.vehicles(tx, days);
    const trips = await this.trips(tx, from, to);
    const pool = await this.pool(tx);
    // รถที่มีเที่ยวในช่วงแต่ไม่อยู่ในรายการ (ปลดระวาง/ลบภายหลัง) — ยังแสดงแถวให้เห็นเที่ยว
    const known = new Set(vehicles.map((v) => v.id));
    const missing = [
      ...new Set(
        trips.flatMap((t) => (t.vehicleId && !known.has(t.vehicleId) ? [t.vehicleId] : [])),
      ),
    ];
    const extra = missing.length ? await this.vehicles(tx, days, missing) : [];
    return {
      from,
      to,
      today,
      vehicles: [...vehicles, ...extra],
      trips,
      pool,
    };
  }

  /** แถวรถ: ไม่ลบ/ไม่ปลดระวาง ไม่ใช่หาง · รถบริษัท → รถร่วม แล้วประเภท → ทะเบียน (PLN-049/050) */
  private async vehicles(tx: Tx, days: string[], ids?: string[]): Promise<BoardVehicleDto[]> {
    const rows = await tx.vehicle.findMany({
      where: ids
        ? { id: { in: ids } }
        : { deletedAt: null, status: { not: 'RETIRED' }, unitRole: { not: 'TRAILER' } },
      include: {
        vehicleType: { select: { nameTh: true, capacityKg: true } },
        carrier: { select: { legalName: true } },
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
        defaultDrivers: {
          where: { deletedAt: null, status: { not: 'INACTIVE' } },
          select: { id: true, name: true, licenceClass: true },
          orderBy: { code: 'asc' },
          take: 1,
        },
      },
    });
    return rows
      .sort(
        (a, b) =>
          (a.ownership === 'OWN' ? 0 : 1) - (b.ownership === 'OWN' ? 0 : 1) ||
          a.vehicleType.nameTh.localeCompare(b.vehicleType.nameTh, 'th') ||
          a.plate.localeCompare(b.plate, 'th'),
      )
      .map((v) => {
        const d = v.defaultDrivers[0];
        const docs = v.documents.map((x) => ({
          ...x,
          startsOn: x.startsOn.toISOString().slice(0, 10),
          expiresOn: x.expiresOn.toISOString().slice(0, 10),
        }));
        // กฎห้ามจ่ายงานต่อวัน (ชุดเดียวกับ /assign — ST2-T20; รถบริษัท = คำเตือน จึงไม่ขึ้นที่นี่) · ใบขับขี่ = ตอนจัดคนขับ
        const blocks = days.flatMap((date) => {
          const r = checkAssignability({
            vehicle: { ownership: v.ownership },
            documents: docs,
            driver: null,
            date,
          });
          return r.blocks.length
            ? [
                {
                  date,
                  issues: r.blocks.map((i) => ({
                    code: i.code,
                    message: assignabilityMessageTh(i),
                  })),
                },
              ]
            : [];
        });
        return {
          id: encodeId('vehicle', v.id),
          plate: v.plate,
          plateProvince: v.plateProvince,
          vehicleTypeId: encodeId('vehicleType', v.vehicleTypeId),
          vehicleTypeName: v.vehicleType.nameTh,
          capacityKg: dec(v.capacityKg ?? v.vehicleType.capacityKg),
          ownership: v.ownership,
          carrierName: v.carrier?.legalName ?? null,
          status: v.status,
          driver: d
            ? { id: encodeId('driver', d.id), name: d.name, licenceClass: d.licenceClass }
            : null,
          blocks,
        };
      });
  }

  /** เที่ยวที่ไม่ยกเลิกในช่วง ± 1 วัน (เที่ยวข้ามคืนแสดงทั้งสองวัน — spec/03 §4 ข้อ 8) */
  private async trips(tx: Tx, from: string, to: string): Promise<BoardTripDto[]> {
    const rows = await tx.trip.findMany({
      where: {
        status: { not: 'CANCELLED' },
        tripDate: {
          gte: new Date(`${addDays(from, -1)}T00:00:00Z`),
          lte: new Date(`${addDays(to, 1)}T00:00:00Z`),
        },
      },
      include: {
        stops: {
          where: { removedAt: null },
          orderBy: { sequence: 'asc' },
          include: { site: { select: { name: true, address: true } } },
        },
        deliveryOrders: {
          where: { status: { not: 'CANCELLED' } },
          orderBy: { doNo: 'asc' },
          select: {
            doNo: true,
            weightKg: true,
            salesOrder: {
              select: { id: true, soNo: true, customer: { select: { legalName: true } } },
            },
          },
        },
      },
      orderBy: [{ plannedStartAt: 'asc' }, { tripNo: 'asc' }],
    });
    const overlaps = vehicleOverlaps(
      rows.map((t) => ({
        id: t.id,
        vehicleId: t.vehicleId,
        status: t.status as TripStatus,
        tripDate: t.tripDate.toISOString().slice(0, 10),
        start: t.plannedStartAt?.toISOString() ?? null,
        end: t.plannedEndAt?.toISOString() ?? null,
      })),
    );
    const no = new Map(rows.map((t) => [t.id, t.tripNo!]));
    return rows.map((t) => {
      const orders = new Map<
        string,
        { id: string; orderNo: string; customerName: string | null }
      >();
      for (const d of t.deliveryOrders)
        orders.set(d.salesOrder.id, {
          id: encodeId('salesOrder', d.salesOrder.id),
          orderNo: d.salesOrder.soNo ?? '',
          customerName: d.salesOrder.customer?.legalName ?? null,
        });
      const pick = t.stops.find((s) => s.type === 'PICKUP');
      const drop = [...t.stops].reverse().find((s) => s.type === 'DELIVERY');
      return {
        id: encodeId('trip', t.id),
        tripNo: t.tripNo!,
        tripDate: t.tripDate.toISOString().slice(0, 10),
        status: t.status as TripStatus,
        vehicleId: t.vehicleId ? encodeId('vehicle', t.vehicleId) : null,
        vehiclePlate: t.vehiclePlateSnapshot,
        plannedStartAt: t.plannedStartAt?.toISOString() ?? null,
        plannedEndAt: t.plannedEndAt?.toISOString() ?? null,
        driverName: t.driverNameSnapshot,
        carrierName: t.carrierNameSnapshot,
        orders: [...orders.values()],
        origin: pick ? place(pick.site) : null,
        dest: drop ? place(drop.site) : null,
        weightKg: sum(t.deliveryOrders.map((d) => d.weightKg)),
        doNos: t.deliveryOrders.map((d) => d.doNo!),
        plannedDistanceKm: dec(t.plannedDistanceKm),
        overlapsWith: (overlaps.get(t.id) ?? []).map((id) => no.get(id)!).sort(),
        warningCount: Array.isArray(t.ruleWarnings)
          ? (t.ruleWarnings as { code?: string }[]).filter((w) => w?.code !== 'vehicle_overlap')
              .length
          : 0,
        version: t.version,
      };
    });
  }

  /**
   * SO รอจัด = DO DRAFT ที่ไม่อยู่ในเที่ยว ของ SO ที่ลงเที่ยวได้ (`isOrderPlannable` ของ DeliveryOrderService)
   * จัดกลุ่มตาม SO (spec/03 §5 "การ์ด DO ที่ pending จัดกลุ่มตาม SO") · เรียงกำหนดส่ง → เลข SO
   */
  private async pool(tx: Tx): Promise<BoardPoolOrderDto[]> {
    // จำกัดจำนวน **ต่อ SO** (ไม่ตัด DO ของ SO เดียวกันออกจากกัน — review ST3-T12)
    const pending = { status: 'DRAFT' as const, tripId: null };
    const sos = await tx.salesOrder.findMany({
      where: {
        status: { in: [...PLANNABLE_SO_STATUSES] },
        OR: [
          { holdReasonCodeId: null },
          { holdReasonCode: { code: { notIn: [...NOT_READY_HOLDS] } } },
        ],
        deliveryOrders: { some: pending },
      },
      orderBy: [{ requestedDate: 'asc' }, { soNo: 'asc' }],
      take: POOL_LIMIT,
      select: { id: true },
    });
    const dos = await tx.deliveryOrder.findMany({
      where: { ...pending, salesOrderId: { in: sos.map((x) => x.id) } },
      orderBy: [{ salesOrder: { requestedDate: 'asc' } }, { doNo: 'asc' }],
      select: {
        id: true,
        doNo: true,
        weightKg: true,
        destStopSeq: true,
        originSite: { select: { name: true, address: true } },
        destSite: { select: { name: true, address: true } },
        salesOrder: {
          select: {
            id: true,
            soNo: true,
            status: true,
            requestedDate: true,
            customerId: true,
            customer: { select: { legalName: true } },
            vehicleTypeId: true,
            vehicleType: { select: { nameTh: true } },
            holdReasonCode: { select: { code: true } },
            sourceChangedAfterPlan: true,
            stops: { select: { sequence: true, windowStart: true, windowEnd: true } },
          },
        },
      },
    });
    const bySo = new Map<string, typeof dos>();
    for (const d of dos) bySo.set(d.salesOrder.id, [...(bySo.get(d.salesOrder.id) ?? []), d]);
    return [...bySo.values()]
      .map((group) => {
        const first = group[0]!;
        const so = first.salesOrder;
        const stop = so.stops.find((s) => s.sequence === first.destStopSeq);
        return {
          id: encodeId('salesOrder', so.id),
          orderNo: so.soNo ?? '',
          customerId: so.customerId ? encodeId('customer', so.customerId) : null,
          customerName: so.customer?.legalName ?? null,
          requestedDate: so.requestedDate.toISOString().slice(0, 10),
          status: so.status,
          holdReason: so.holdReasonCode?.code ?? null,
          sourceChangePending: so.sourceChangedAfterPlan,
          vehicleTypeId: so.vehicleTypeId ? encodeId('vehicleType', so.vehicleTypeId) : null,
          vehicleTypeName: so.vehicleType?.nameTh ?? null,
          origin: place(first.originSite),
          dest: place(group[group.length - 1]!.destSite),
          windowStart: stop?.windowStart?.toISOString() ?? null,
          windowEnd: stop?.windowEnd?.toISOString() ?? null,
          weightKg: sum(group.map((d) => d.weightKg)),
          deliveryOrders: group.map((d) => ({
            id: encodeId('deliveryOrder', d.id),
            doNo: d.doNo!,
            weightKg: dec(d.weightKg),
          })),
        };
      })
      .sort(
        (a, b) =>
          a.requestedDate.localeCompare(b.requestedDate) || a.orderNo.localeCompare(b.orderNo),
      );
  }
}
