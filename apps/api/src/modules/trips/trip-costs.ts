import { Prisma, type TripCost } from '@prisma/client';
import { allocateTripCostLines, decimalFromSatang, satangFromDecimal } from '@tms/domain';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import type { Tx } from '../../db/db.service';
import { revenueTotalsByDeliveryOrder } from '../revenue-lines/revenue-rebuild';
import type { TripCostBlocker, TripCostLineDto } from './trip-costs.dto';

/**
 * ต้นทุนเที่ยว (ST6-T01; docs/04 F6 "Cost line ตั้งแต่สร้าง trip", docs/01 §3.3 trip_cost, §4.2 COMPLETED → COSTED)
 *
 * บรรทัดระบบในเฟส 0 มีชนิดเดียว = **ค่าจ้างรถร่วม** (CARRIER_FEE, `source_type` SUBCON_OFFER) เขียนตอนจ้าง (`/offer` —
 * ST3-T22) จากผลคิด rate card ขาซื้อ ณ เวลานั้น (snapshot — แก้ rate card ภายหลังไม่กระทบ) · รถร่วมเข้าเที่ยวได้ทาง `/offer`
 * เท่านั้น (`/assign` ตอบ 409 `offer_required`) → เที่ยวรถร่วมมีบรรทัดค่าจ้างตั้งแต่จ้างเสมอ
 * - วงจรชีวิต: เปลี่ยนรถร่วม/จ้างใหม่/ยกเลิกเที่ยว → บรรทัดเดิมถูก**กลับรายการ** (ยอดติดลบ `reversal_of_id` — `reverseCarrierFees`)
 *   ไม่ลบ/ไม่แก้ยอด · บรรทัดของการจ้างใหม่มาจาก snapshot ของรายใหม่
 * - "rebuild เฉพาะบรรทัดระบบ": ราคาที่ตกลงกับรถร่วมล็อก (review ST3-T22 M2) — ไม่คิดใหม่เมื่อ DO ในเที่ยวเปลี่ยน
 *   [OPEN — นักบัญชี/PO spec/12 §3 ST6-T01] · บรรทัดคนเพิ่มเอง (ค่าใช้จ่ายหน้างาน ST4-T13) ไม่ถูกแตะ
 * - ค่าเที่ยวคนขับ/ประมาณน้ำมันของรถบริษัท (spec PLN-009) = P1 (docs/04 "ต้นทุนต่อเที่ยว") — ยังไม่สร้าง
 */

/**
 * เปิดใช้การปิดต้นทุน (COMPLETED → COSTED) หรือยัง — **เปิดโดยค่าเริ่มต้น** (ST6-T01c: ปันลง DO ตามสัดส่วนรายได้ — PO ตัดสิน
 * 19 พ.ย. 2569) · env `TRIP_COSTING_ENABLED=0` (หรือ false/off) = kill switch ระดับระบบ (ไม่ใช่ค่าตั้ง tenant)
 * อ่านทุกครั้งที่เรียก (test สลับได้ระหว่างรัน)
 */
export const tripCostingEnabled = () =>
  !['0', 'false', 'off', 'no'].includes(
    (process.env.TRIP_COSTING_ENABLED ?? '').trim().toLowerCase(),
  );

/** ปิดต้นทุนแล้ว — ไม่คิดสิ่งที่ขวาง */
const COSTED_STATUSES = new Set(['COSTED', 'SETTLED']);

/** DO ที่รับต้นทุนเที่ยว (ไม่นับ DO ที่ยกเลิก) + รายได้ (สตางค์) ณ เวลาปิดต้นทุน */
export interface AllocationTarget {
  id: string;
  doNo: string | null;
  revenue: bigint;
  provisional: boolean;
}

export interface CostReadiness {
  blockers: TripCostBlocker[];
  pendingCount: number;
  buyTotal: Prisma.Decimal;
  carrierFee: Prisma.Decimal;
  /** DO ที่จะรับส่วนแบ่ง เรียงตามลำดับ "ตัวรับเศษ" ก่อน (รายได้สูงสุด → เลข DO น้อยสุด) */
  targets: AllocationTarget[];
}

/**
 * ลำดับรับเศษสตางค์ (PO ตัดสิน 19 พ.ย. 2569): รายได้สูงสุดก่อน · เท่ากัน → เลข DO น้อยสุด (ไม่มีเลข = ท้าย) → id
 */
const cmpDoNo = (a: string | null, b: string | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a.localeCompare(b, 'en', { numeric: true });
const byRemainderPriority = (a: AllocationTarget, b: AllocationTarget) =>
  a.revenue === b.revenue
    ? cmpDoNo(a.doNo, b.doNo) || a.id.localeCompare(b.id)
    : a.revenue > b.revenue
      ? -1
      : 1;

/** DO (ไม่ยกเลิก) ของเที่ยว + รายได้ต่อ DO (บรรทัดรายได้ ACTIVE — ST5-T01b) */
export async function allocationTargets(tx: Tx, tripId: string): Promise<AllocationTarget[]> {
  const dos = await tx.deliveryOrder.findMany({
    where: { tripId, status: { not: 'CANCELLED' } },
    select: { id: true, doNo: true },
  });
  const totals = await revenueTotalsByDeliveryOrder(
    tx,
    dos.map((d) => d.id),
  );
  return dos
    .map((d) => {
      const t = totals.get(d.id);
      return {
        id: d.id,
        doNo: d.doNo,
        revenue: t ? satangFromDecimal(t.amount) : 0n,
        provisional: t?.provisional ?? false,
      };
    })
    .sort(byRemainderPriority);
}

const sum = (rows: { amount: Prisma.Decimal }[]) =>
  rows.reduce((a, r) => a.add(r.amount), new Prisma.Decimal(0));

/**
 * ต้นทุนครบหรือยัง (DECISION ST6-T01 — spec/12 §3): เที่ยว COMPLETED · ไม่มีค่าใช้จ่ายหน้างานฝั่งซื้อรอยืนยัน ·
 * เที่ยวรถร่วมมีค่าจ้างสุทธิ > 0 ของการจ้างที่รถร่วมรับแล้ว (ACCEPTED) ของรายปัจจุบัน
 * — การปันลง DO (`allocated`) ยังไม่ทำ [OPEN — นักบัญชี/PO] · เลขไมล์/เงินเบิก (PLN-011) ยังไม่มีในเฟส 0
 */
export async function costReadiness(
  tx: Tx,
  trip: { id: string; status: string; carrierId: string | null },
): Promise<CostReadiness> {
  const rows = await tx.tripCost.findMany({
    where: { tripId: trip.id },
    select: { amount: true, status: true, costType: true, subconOfferId: true, carrierId: true },
  });
  const confirmed = rows.filter((r) => r.status === 'CONFIRMED');
  const pendingCount = rows.filter((r) => r.status === 'PENDING_CONFIRM').length;
  let carrierFee = new Prisma.Decimal(0);
  if (trip.carrierId) {
    const offer = await tx.subconOffer.findFirst({
      where: { tripId: trip.id, carrierId: trip.carrierId, status: 'ACCEPTED' },
      select: { id: true },
    });
    if (offer)
      carrierFee = sum(
        confirmed.filter(
          (r) =>
            r.costType === 'CARRIER_FEE' &&
            r.subconOfferId === offer.id &&
            r.carrierId === trip.carrierId,
        ),
      );
  }
  const blockers: TripCostBlocker[] = [];
  let targets: AllocationTarget[] = [];
  if (trip.status === 'CANCELLED') blockers.push('TRIP_NOT_COMPLETED');
  else if (!COSTED_STATUSES.has(trip.status)) {
    // kill switch ปิดอยู่ → ไม่ให้ผู้เรียกเห็นว่า "พร้อม" (POST ตอบ 409 trip_costing_unavailable)
    if (!tripCostingEnabled()) blockers.push('COSTING_DISABLED');
    if (trip.status !== 'COMPLETED') blockers.push('TRIP_NOT_COMPLETED');
    if (pendingCount) blockers.push('PENDING_FIELD_CHARGES');
    if (trip.carrierId && !carrierFee.gt(0)) blockers.push('CARRIER_FEE_MISSING');
    // ปันลง DO ตามสัดส่วนรายได้ (ST6-T01c) — น้ำหนักมีผลเฉพาะเมื่อมี DO > 1 ใบ และมีบรรทัดที่มียอด
    targets = await allocationTargets(tx, trip.id);
    // ค่าใช้จ่ายหน้างานฝั่งขาย (SELL/BOTH) รอยืนยัน — หลัง COSTED ยืนยันไม่ได้ (ST4-T13) → รายได้ค้างและไม่อยู่ในสัดส่วน
    // [DECISION — ตามคำแนะนำ ย้อนได้ ST6-T01c QA M1] ไม่ให้ปิดจนกว่าจะยืนยัน/ปฏิเสธ
    const pendingSell = await tx.doSurcharge.count({
      where: {
        status: 'PENDING_CONFIRM',
        OR: [{ tripId: trip.id }, { deliveryOrderId: { in: targets.map((t) => t.id) } }],
      },
    });
    if (pendingSell) blockers.push('PENDING_SELL_CHARGES');
    const needsWeights = targets.length > 1 && confirmed.some((r) => !r.amount.isZero());
    if (needsWeights) {
      const net = sum(confirmed);
      if (targets.some((t) => t.provisional)) blockers.push('REVENUE_PROVISIONAL');
      // รายได้รวมเป็น 0 แต่ต้นทุนสุทธิไม่เป็น 0 → ไม่มีสัดส่วนให้ปัน [OPEN — PO] (spec/12 §3 ST6-T01c)
      else if (targets.every((t) => t.revenue === 0n) && !net.isZero())
        blockers.push('REVENUE_MISSING');
    }
  }
  return { blockers, pendingCount, buyTotal: sum(confirmed), carrierFee, targets };
}

/**
 * ปันต้นทุนเที่ยวลง DO (ST6-T01c — PO ตัดสิน 19 พ.ย. 2569; docs/01 §3.3 `trip_cost.allocated` = `{do_id: amount}`, §4.2
 * COMPLETED → COSTED "ต้นทุนเที่ยวครบ + ปันลง DO") — เรียกใน transaction ของการปิดต้นทุน หลังล็อก SO → DO → เที่ยว → บรรทัดต้นทุน
 * - ปัน **ต้นทุนสุทธิของเที่ยว** (บรรทัด CONFIRMED รวมกลับรายการ) ครั้งเดียวตามสัดส่วนรายได้ DO เศษสตางค์ทั้งหมด → DO รายได้สูงสุด
 *   (เท่ากัน → เลข DO น้อยสุด) แล้วกระจายลงบรรทัดให้ลงตัวทั้งต่อ DO และต่อบรรทัด (domain `allocateTripCostLines`) ·
 *   บรรทัดเดิม/กลับรายการหักล้างกันพอดีต่อ DO
 * - DO เดียว = ทั้งยอด · ไม่มี DO = ไม่ปัน (`{}` — DECISION ย้อนได้) · รายได้รวม 0 (ต้นทุนสุทธิ 0) = ไปตัวรับเศษ (สุทธิ 0)
 *   · บรรทัดที่ไม่ CONFIRMED = `{}`
 * - snapshot ณ เวลาปิดต้นทุน: รายได้ที่เปลี่ยนภายหลังไม่ปันใหม่ (ไม่เขียน `delivery_order.allocated_cost_amount` — อ่านจาก
 *   `trip_cost.allocated` แหล่งเดียว เหมือน `revenue_amount` ของ ST5-T01b)
 * - ผลไม่ลงตัว (Σ ต่อ DO ≠ ต้นทุนสุทธิ / ติดลบ — ไม่ควรเกิด) → 500 `trip_cost_allocation_failed` (transaction ถูกยกเลิกทั้งหมด)
 * คืนยอดรวมต่อ DO (สตางค์)
 */
export async function allocateTripCost(
  tx: Tx,
  tripId: string,
  targets: AllocationTarget[],
): Promise<Map<string, bigint>> {
  const rows = await tx.tripCost.findMany({
    where: { tripId },
    select: { id: true, amount: true, status: true, reversalOfId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const confirmed = rows.filter((r) => r.status === 'CONFIRMED');
  const lines = confirmed.map((r) => ({
    id: r.id,
    amount: satangFromDecimal(r.amount.toFixed(2)),
    reversalOfId: r.reversalOfId,
  }));
  const net = lines.reduce((a, l) => a + l.amount, 0n);
  const perDo = new Map<string, bigint>();
  let perLine = new Map<string, bigint[]>();
  if (targets.length) {
    try {
      const r = allocateTripCostLines(
        lines,
        targets.map((t) => t.revenue),
        0,
      );
      perLine = r.perLine;
      targets.forEach((t, i) => perDo.set(t.id, r.targets[i]!));
    } catch (e) {
      if (e instanceof RangeError) throw new ProblemException('trip_cost_allocation_failed');
      throw e;
    }
    const total = [...perDo.values()].reduce((a, v) => a + v, 0n);
    if (total !== net || [...perDo.values()].some((v) => v < 0n))
      throw new ProblemException('trip_cost_allocation_failed');
  }
  for (const r of rows) {
    const parts = perLine.get(r.id);
    const allocated = parts
      ? Object.fromEntries(targets.map((t, i) => [t.id, decimalFromSatang(parts[i]!)]))
      : {};
    await tx.tripCost.update({ where: { id: r.id }, data: { allocated } });
  }
  return perDo;
}

/** ต้นทุนที่ปันลง DO ต่อใบ (สตางค์) ของเที่ยวที่ปิดต้นทุนแล้ว — อ่านจาก `trip_cost.allocated` */
export async function allocatedByDeliveryOrder(
  tx: Tx,
  tripId: string,
): Promise<Map<string, bigint>> {
  const rows = await tx.tripCost.findMany({
    where: { tripId, status: 'CONFIRMED' },
    select: { allocated: true },
  });
  const out = new Map<string, bigint>();
  for (const r of rows) {
    const a = (r.allocated ?? {}) as Record<string, string>;
    for (const [doId, amount] of Object.entries(a))
      out.set(doId, (out.get(doId) ?? 0n) + satangFromDecimal(amount));
  }
  return out;
}

/** สรุปการปันต่อ DO สำหรับ `GET /trips/{id}/costs` — ว่างจนกว่าจะปิดต้นทุน */
export async function costAllocations(
  tx: Tx,
  trip: { id: string; status: string },
): Promise<{ deliveryOrderId: string; doNo: string | null; buyAllocatedCost: string }[]> {
  if (!COSTED_STATUSES.has(trip.status)) return [];
  const per = await allocatedByDeliveryOrder(tx, trip.id);
  if (!per.size) return [];
  const dos = await tx.deliveryOrder.findMany({
    where: { id: { in: [...per.keys()] } },
    select: { id: true, doNo: true },
  });
  const no = new Map(dos.map((d) => [d.id, d.doNo]));
  return [...per.entries()]
    .map(([id, v]) => ({
      deliveryOrderId: encodeId('deliveryOrder', id),
      doNo: no.get(id) ?? null,
      buyAllocatedCost: decimalFromSatang(v),
    }))
    .sort((a, b) => cmpDoNo(a.doNo, b.doNo));
}

/** ต้นทุนที่ปันมาของ DO หนึ่งใบ (บาท) — null = เที่ยวยังไม่ปิดต้นทุน / DO ไม่อยู่ในเที่ยว */
export async function allocatedCostForDeliveryOrder(
  tx: Tx,
  deliveryOrderId: string,
): Promise<string | null> {
  const d = await tx.deliveryOrder.findUnique({
    where: { id: deliveryOrderId },
    select: { tripId: true, trip: { select: { status: true } } },
  });
  if (!d?.tripId || !d.trip || !COSTED_STATUSES.has(d.trip.status)) return null;
  const per = await allocatedByDeliveryOrder(tx, d.tripId);
  const v = per.get(deliveryOrderId);
  return v === undefined ? null : decimalFromSatang(v);
}

type LineRow = TripCost & { reversedBy: { id: string } | null };

const sourceRef = (r: TripCost): string | null => {
  if (!r.sourceId) return null;
  if (r.sourceType === 'SUBCON_OFFER') return encodeId('subconOffer', r.sourceId);
  if (r.sourceType === 'DO_SURCHARGE') return encodeId('doSurcharge', r.sourceId);
  return null;
};

export function costLineDto(r: LineRow): TripCostLineDto {
  return {
    id: encodeId('tripCost', r.id),
    costType: r.costType,
    source: r.source,
    sourceType: r.sourceType,
    sourceId: sourceRef(r),
    status: r.status,
    carrierId: r.carrierId ? encodeId('carrier', r.carrierId) : null,
    description: r.description,
    vatType: r.vatType,
    whtRate: r.whtRate?.toFixed(2) ?? null,
    buyAmount: r.amount.toFixed(2),
    buyVatAmount: r.vatAmount.toFixed(2),
    reversalOfId: r.reversalOfId ? encodeId('tripCost', r.reversalOfId) : null,
    reversedById: r.reversedBy ? encodeId('tripCost', r.reversedBy.id) : null,
    settled: r.settlementLineId !== null,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function costLines(tx: Tx, tripId: string): Promise<TripCostLineDto[]> {
  const rows = await tx.tripCost.findMany({
    where: { tripId },
    include: { reversedBy: { select: { id: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map(costLineDto);
}
