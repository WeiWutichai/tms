import { Prisma, type TripCost } from '@prisma/client';
import { encodeId } from '../../common/ids';
import type { Tx } from '../../db/db.service';
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
 * เปิดใช้การปิดต้นทุน (COMPLETED → COSTED) หรือยัง — env `TRIP_COSTING_ENABLED=1` (ค่าเริ่มต้นปิด)
 * docs/01 §4.2 กำหนด COSTED = "ต้นทุนเที่ยวครบ + ปันลง DO" แต่วิธีปันลง DO ยัง [OPEN — นักบัญชี/PO] (spec/12 §3 ST6-T01 (ก))
 * → ไม่ข้าม guard ของ state machine: ปิดไว้จนกว่าจะตัดสิน (ตั้งที่ระดับระบบ ไม่ใช่ค่าตั้ง tenant — tenant เปิดเองไม่ได้)
 * อ่านทุกครั้งที่เรียก (test เปิดได้ระหว่างรัน)
 */
export const tripCostingEnabled = () => process.env.TRIP_COSTING_ENABLED === '1';

/** ปิดต้นทุนแล้ว — ไม่คิดสิ่งที่ขวาง */
const COSTED_STATUSES = new Set(['COSTED', 'SETTLED']);

export interface CostReadiness {
  blockers: TripCostBlocker[];
  pendingCount: number;
  buyTotal: Prisma.Decimal;
  carrierFee: Prisma.Decimal;
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
  if (trip.status === 'CANCELLED') blockers.push('TRIP_NOT_COMPLETED');
  else if (!COSTED_STATUSES.has(trip.status)) {
    if (trip.status !== 'COMPLETED') blockers.push('TRIP_NOT_COMPLETED');
    if (pendingCount) blockers.push('PENDING_FIELD_CHARGES');
    if (trip.carrierId && !carrierFee.gt(0)) blockers.push('CARRIER_FEE_MISSING');
  }
  return { blockers, pendingCount, buyTotal: sum(confirmed), carrierFee };
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
