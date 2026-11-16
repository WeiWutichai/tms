import type { Prisma, PrismaClient } from '@prisma/client';
import { estimateLeg, routeTotals, type Leg } from '@tms/domain';
import { findRouteDistance } from '../routes/routes.service';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * ระยะ/เวลาช่วงวิ่งของทุกจุด (ST3-T16) — จุดก่อนหน้า → จุดนี้ (จุดแรกไม่มีช่วง): route master ที่ใช้งาน (ทิศทางมีผล —
 * `findRouteDistance` กติกาเดียวกับ `RoutesService.getRouteDistance`) ก่อน · ไม่มี → ค่าประมาณจากพิกัดที่ยืนยันแล้ว
 * (`estimateLeg`) · ไม่มีทั้งคู่ = ไม่ทราบ · ยอดรวมเขียนที่ `trip.planned_distance_km` / `planned_duration_min` (จุด < 2 = null)
 * ไม่ขยับ version (ผู้เรียกขยับเอง) · ข้อมูลหลักเปลี่ยนภายหลังไม่ย้อนมาอัปเดตจนกว่าจุดจะเปลี่ยนอีกครั้ง
 */
export async function refreshTripLegs(tx: Db, tripId: string): Promise<void> {
  const stops = await tx.tripStop.findMany({
    where: { tripId, removedAt: null },
    orderBy: { sequence: 'asc' },
    select: { id: true, siteId: true, legDistanceKm: true, legMinutes: true, legSource: true },
  });
  const sites = await tx.customerSite.findMany({
    where: { id: { in: [...new Set(stops.map((st) => st.siteId))] } },
    select: { id: true, lat: true, lng: true },
  });
  const pt = (id: string) => {
    const x = sites.find((y) => y.id === id);
    return x && x.lat !== null && x.lng !== null
      ? { lat: Number(x.lat), lng: Number(x.lng) }
      : null;
  };
  const legs: Leg[] = [];
  for (const [i, st] of stops.entries()) {
    let leg: Leg = { km: null, minutes: null, source: null };
    if (i > 0) {
      const from = stops[i - 1]!.siteId;
      const r = from === st.siteId ? null : await findRouteDistance(tx, from, st.siteId);
      leg = estimateLeg({
        fromSiteId: from,
        toSiteId: st.siteId,
        route: r ? { distanceKm: Number(r.distanceKm), standardMinutes: r.standardMinutes } : null,
        from: pt(from),
        to: pt(st.siteId),
      });
      legs.push(leg);
    }
    const km = leg.km === null ? null : leg.km.toFixed(1);
    if (
      (st.legDistanceKm?.toFixed(1) ?? null) !== km ||
      st.legMinutes !== leg.minutes ||
      st.legSource !== leg.source
    )
      await tx.tripStop.update({
        where: { id: st.id },
        data: { legDistanceKm: km, legMinutes: leg.minutes, legSource: leg.source },
      });
  }
  const tot = stops.length < 2 ? null : routeTotals(legs);
  await tx.trip.update({
    where: { id: tripId },
    data: {
      plannedDistanceKm: tot?.distanceKm == null ? null : tot.distanceKm.toFixed(1),
      plannedDurationMin: tot?.minutes ?? null,
    },
  });
}

/**
 * backfill ตอน bootstrap (หลัง migrate 0072 — review ST3-T16): เที่ยวที่ยังแก้จุดได้ (PLANNING/ASSIGNED) ที่มีจุด ≥ 2
 * แต่ยังไม่เคยคำนวณช่วงวิ่ง (จุดที่ 2 ขึ้นไปไม่มี `leg_source` สักจุด และ `planned_duration_min` ว่าง) → `refreshTripLegs`
 * รันซ้ำได้: เที่ยวที่คำนวณแล้วไม่ถูกแตะ · ผลเหมือนการเรียงจุดใหม่ (ไม่ขยับ version — เป็นข้อมูลที่ derive)
 * client ของ bootstrap ข้าม RLS → กรอง `tenantId` เอง
 */
export async function backfillTripLegs(db: Db, tenantId: string): Promise<number> {
  const trips = await db.trip.findMany({
    where: {
      tenantId,
      status: { in: ['PLANNING', 'ASSIGNED'] },
      plannedDurationMin: null,
      stops: { none: { removedAt: null, legSource: { not: null } } },
    },
    select: { id: true, _count: { select: { stops: { where: { removedAt: null } } } } },
  });
  let n = 0;
  for (const t of trips) {
    if (t._count.stops < 2) continue;
    await refreshTripLegs(db, t.id);
    n++;
  }
  return n;
}
