import { Prisma } from '@prisma/client';
import { pendingRules, ruleKey, type RuleOverride, type TripStatus } from '@tms/domain';
import { encodeId } from '../../common/ids';
import type { TripDto } from './trip.dto';
import type { TripRecord, TripRescheduled, TripWarning } from './trip.service';

/**
 * DTO ของเที่ยว (ย้ายจาก trips.controller — ST7-T06): ใช้ทั้ง `GET /v1/trips/{id}` และ `data.object` ของ webhook `trip.*`/`stop.*`
 * ไฟล์นี้ไม่ import service (กัน import วนจาก TripService)
 */

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const kg = (vs: (Prisma.Decimal | null)[]) =>
  vs
    .reduce<Prisma.Decimal>((a, v) => (v === null ? a : a.add(v)), new Prisma.Decimal(0))
    .toFixed(3)
    .replace(/\.?0+$/, '') || '0';

/** ผลตรวจล่าสุด + สถานะยืนยัน/ยกเว้น (ชุดเดียวกับ `enforceRules`) */
export function tripRules(t: TripRecord) {
  const ctx = { vehicleId: t.vehicleId, driverId: t.driverId, reliefDriverId: t.reliefDriverId };
  const results = (t.ruleWarnings as unknown as TripWarning[]) ?? [];
  const overrides = (t.ruleOverrides as unknown as RuleOverride[]) ?? [];
  const p = pendingRules(results, overrides, ctx);
  const covered = new Set(p.covered);
  const activeKeys = new Set(p.covered.map((w) => ruleKey(w, ctx)));
  return { results, overrides, pending: p, covered, activeKeys, ctx };
}

/** การจ้างรถร่วมที่ใช้งานอยู่ (ST3-T22) — ราคาซื้อถูกตัดที่ serializer เมื่อไม่มี `prices.buy:read` */
function hireDto(t: TripRecord): TripDto['hire'] {
  const o = t.subconOffers?.[0];
  if (!o) return null;
  const q = (o.rateQuote ?? {}) as { rateCardCode?: string | null };
  return {
    id: encodeId('subconOffer', o.id),
    carrierId: encodeId('carrier', o.carrierId),
    status: o.status,
    buyAmount: o.buyAmount.toFixed(2),
    buyPriceSource: o.priceSource,
    rateCardCode: q.rateCardCode ?? null,
    buySelectionKind: o.selectionKind,
    selectionReason: o.selectionReason,
    offeredBy: o.offeredBy,
    offeredAt: o.offeredAt.toISOString(),
    responseDueAt: o.responseDueAt ? o.responseDueAt.toISOString() : null,
  };
}

export function toTripDto(
  t: TripRecord,
  rescheduled: TripRescheduled[] = [],
  /** ST4-T11 ใบส่งแล้วที่ของปฏิเสธรับถูกส่งซ้ำ (ไม่อยู่ใน rescheduledDeliveryOrders — ใบเดิมยังอยู่ในเที่ยว) */
  rejected: TripRescheduled[] = [],
): TripDto {
  return {
    id: encodeId('trip', t.id),
    tripNo: t.tripNo!,
    tripDate: t.tripDate.toISOString().slice(0, 10),
    status: t.status as TripStatus,
    plannedStartAt: iso(t.plannedStartAt),
    plannedEndAt: iso(t.plannedEndAt),
    vehicle: t.vehicleId
      ? {
          id: encodeId('vehicle', t.vehicleId),
          plate: t.vehiclePlateSnapshot!,
          vehicleTypeId: encodeId('vehicleType', t.vehicleTypeId!),
          vehicleTypeName: t.vehicleTypeSnapshot,
        }
      : null,
    trailer: t.trailerId
      ? { id: encodeId('vehicle', t.trailerId), plate: t.trailerPlateSnapshot! }
      : null,
    driver: t.driverId
      ? {
          id: encodeId('driver', t.driverId),
          name: t.driverNameSnapshot!,
          phone: t.driverPhoneSnapshot,
        }
      : null,
    reliefDriver: t.reliefDriverId
      ? {
          id: encodeId('driver', t.reliefDriverId),
          name: t.reliefDriverNameSnapshot!,
          phone: t.reliefDriverPhoneSnapshot,
        }
      : null,
    carrier: t.carrierId
      ? { id: encodeId('carrier', t.carrierId), name: t.carrierNameSnapshot! }
      : null,
    assignmentStatus: t.assignmentStatus,
    offeredAt: iso(t.offeredAt),
    offerExpiresAt: iso(t.assignmentExpiresAt),
    hire: hireDto(t),
    assignedAt: iso(t.assignedAt),
    dispatchedAt: iso(t.dispatchedAt),
    completedAt: iso(t.completedAt),
    cancelledAt: iso(t.cancelledAt),
    cancelReason: t.cancelReason,
    stops: t.stops.map((s) => ({
      id: encodeId('tripStop', s.id),
      sequence: s.sequence,
      type: s.type,
      siteId: encodeId('site', s.siteId),
      status: s.status,
      windowStart: iso(s.windowStart),
      windowEnd: iso(s.windowEnd),
      plannedArrival: iso(s.plannedArrival),
      plannedDeparture: iso(s.plannedDeparture),
      deliveryOrderIds: t.deliveryOrders
        .filter((d) => (s.type === 'PICKUP' ? d.pickupTripStopId : d.tripStopId) === s.id)
        .map((d) => encodeId('deliveryOrder', d.id)),
      siteName: s.site.name,
      legDistanceKm: s.legDistanceKm?.toFixed(1) ?? null,
      legMinutes: s.legMinutes,
      legSource: s.legSource,
      arrivedAt: iso(s.arrivedAt),
      departedAt: iso(s.departedAt),
      outcome: s.outcome,
      lastEventId: s.lastEventId ? encodeId('event', s.lastEventId) : null,
      // ST4-T12 DO ที่ส่งไม่สำเร็จที่จุดนี้ → ใบนัดส่งใหม่ (แสดงทุกสถานะจุด — review H1c) · รับของไม่ได้ = ที่จุดรับ
      reschedules: [...rescheduled, ...rejected]
        .filter((d) =>
          d.pickupTripStop?.status === 'FAILED'
            ? d.pickupTripStopId === s.id
            : d.tripStopId === s.id,
        )
        .flatMap((d) =>
          d.redeliveries.map((n) => ({
            fromDeliveryOrderId: encodeId('deliveryOrder', d.id),
            fromDoNo: d.doNo!,
            deliveryOrderId: encodeId('deliveryOrder', n.id),
            doNo: n.doNo!,
            doDate: n.doDate.toISOString().slice(0, 10),
            status: n.status,
            attempt: n.rescheduleCount,
            exhausted: n.rescheduleExhausted,
            manual: n.redeliveryManual,
          })),
        ),
    })),
    rescheduledDeliveryOrders: rescheduled.map((d) => ({
      id: encodeId('deliveryOrder', d.id),
      doNo: d.doNo!,
      pickupStopId: d.pickupTripStopId ? encodeId('tripStop', d.pickupTripStopId) : null,
      dropStopId: d.tripStopId ? encodeId('tripStop', d.tripStopId) : null,
    })),
    deliveryOrders: t.deliveryOrders.map((d) => ({
      id: encodeId('deliveryOrder', d.id),
      doNo: d.doNo!,
      status: d.status,
      orderId: encodeId('salesOrder', d.salesOrderId),
      customerId: encodeId('customer', d.customerId),
      pickupStopId: d.pickupTripStopId ? encodeId('tripStop', d.pickupTripStopId) : null,
      dropStopId: d.tripStopId ? encodeId('tripStop', d.tripStopId) : null,
    })),
    weightKg: kg(t.deliveryOrders.map((d) => d.weightKg)),
    route: {
      distanceKm: t.plannedDistanceKm?.toFixed(1) ?? null,
      minutes: t.plannedDurationMin,
      missingLegs: t.stops.slice(1).filter((s) => s.legSource === null).length,
      estimated: t.stops.some((s) => s.legSource === 'ESTIMATE'),
    },
    ...(() => {
      const r = tripRules(t);
      return {
        warnings: r.results.map((w) => ({
          ...w,
          key: ruleKey(w, r.ctx),
          confirmed: w.severity === 'info' || r.covered.has(w),
        })),
        ruleOverrides: r.overrides.map((o) => ({
          code: o.code,
          severity: o.severity,
          kind: o.kind,
          reason: o.reason,
          actorId: o.actorId,
          at: o.at,
          message: o.message,
          active: !o.supersededAt && r.activeKeys.has(o.key),
          supersededAt: o.supersededAt ?? null,
          supersededReason: o.supersededReason ?? null,
        })),
      };
    })(),
    version: t.version,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}
