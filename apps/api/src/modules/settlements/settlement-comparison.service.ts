import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { DbService } from '../../db/db.service';
import type {
  ComparisonLineDto,
  ComparisonPodDto,
  ComparisonTripDto,
  SettlementComparisonDto,
} from './settlement-comparison.dto';
import { disputedLines, latestBy, lineStatus } from './settlement-dispute';
import type { SettlementStatus } from './settlement.dto';

/** DO ที่ผ่านเกณฑ์จ่ายรถร่วม — กฎเดียวกับคิวจ่าย (settlement-queue.service `POD_OK`) */
function podPassed(status: string, podStatus: string): boolean {
  if (status === 'UNBILLED' || status === 'BILLED') return podStatus !== 'PARTIAL';
  if (status === 'FAILED' || status === 'RETURNED' || status === 'CANCELLED')
    return podStatus === 'COMPLETE';
  return false;
}

type PodLine = { qtyPlanned?: unknown; qtyActual?: unknown; rejectQty?: unknown };
const dec = (v: unknown): Prisma.Decimal | null => {
  if (v === null || v === undefined || v === '') return null;
  try {
    return new Prisma.Decimal(String(v));
  } catch {
    return null;
  }
};
/** ผลรวมปริมาณของ POD ล่าสุด (ยังไม่บันทึกยอดส่งจริง = null — ถือว่าตามแผน) */
function qtySum(lines: unknown, key: keyof PodLine): string | null {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  let total = new Prisma.Decimal(0);
  for (const l of lines as PodLine[]) total = total.plus(dec(l[key]) ?? 0);
  return total.toString();
}

/**
 * หน้าเทียบ planned vs executed vs claimed + POD ของใบสำคัญจ่าย (ST6-T06; docs/04 F6 "Dispute — หน้าเอกสารคู่ยอด")
 * อ่านอย่างเดียว · ยอดทุกช่องเป็นราคาซื้อ (`buy*` — ตัดเมื่อไม่มี `prices.buy:read`)
 */
@Injectable()
export class SettlementComparisonService {
  constructor(private readonly db: DbService) {}

  async compare(id: string): Promise<SettlementComparisonDto> {
    const tx = this.db.tx;
    const s = await tx.carrierSettlement.findUnique({
      where: { id },
      include: {
        lines: {
          where: { voidedAt: null },
          orderBy: { lineNo: 'asc' },
          include: {
            tripCost: {
              select: {
                costType: true,
                subconOffer: { select: { buyAmount: true, rateQuote: true } },
              },
            },
            trip: { select: { tripNo: true } },
          },
        },
      },
    });
    if (!s) throw new ProblemException('not_found');
    const round = s.reviewRound;
    const [reviews, actions, disputed] = await Promise.all([
      round > 0
        ? tx.settlementLineReview.findMany({ where: { settlementId: id, round } })
        : Promise.resolve([]),
      round > 0
        ? tx.settlementLineDispute.findMany({ where: { settlementId: id, round } })
        : Promise.resolve([]),
      disputedLines(tx, id, round),
    ]);
    const carrier = latestBy(reviews, round);
    const company = latestBy(actions, round);
    const resolved = latestBy(actions, round, (a) => a.action === 'RESOLVED');

    const lines: ComparisonLineDto[] = s.lines.map((l) => {
      const c = carrier.get(l.id);
      const offer = l.lineType === 'FREIGHT' ? (l.tripCost?.subconOffer ?? null) : null;
      const quote = (offer?.rateQuote ?? null) as { rateCardCode?: string | null } | null;
      const claimed =
        c?.response === 'ACCEPTED' ? l.amount : c?.response === 'DISPUTED' ? c.claimedAmount : null;
      const co = company.get(l.id);
      return {
        id: encodeId('settlementLine', l.id),
        lineNo: l.lineNo,
        lineType: l.lineType,
        tripId: l.tripId ? encodeId('trip', l.tripId) : null,
        tripNo: l.trip?.tripNo ?? null,
        costType: l.tripCost?.costType ?? null,
        deductionType: l.deductionType,
        description: l.description,
        reference: l.reference,
        status: lineStatus(disputed.has(l.id), c?.response, resolved.has(l.id)),
        plannedSource: offer ? 'SUBCON_OFFER' : null,
        plannedRateCardCode: quote?.rateCardCode ?? null,
        buyPlannedAmount: offer ? offer.buyAmount.toFixed(2) : null,
        buyExecutedAmount: l.amount.toFixed(2),
        buyClaimedAmount: claimed ? claimed.toFixed(2) : null,
        buyClaimedDifference: claimed ? claimed.minus(l.amount).toFixed(2) : null,
        claim: c
          ? {
              response: c.response,
              reason: c.reason,
              photoIds: c.photoIds.map((p) => encodeId('document', p)),
              respondedAt: c.createdAt.toISOString(),
            }
          : null,
        companyReview: co
          ? {
              action: co.action as 'DISPUTED' | 'RESOLVED',
              reason: co.reason,
              round: co.round,
              by: co.createdBy,
              at: co.createdAt.toISOString(),
            }
          : null,
      };
    });

    const tripIds = [...new Set(s.lines.map((l) => l.tripId).filter((t): t is string => !!t))];
    const trips = tripIds.length
      ? await tx.trip.findMany({
          where: { id: { in: tripIds } },
          select: {
            id: true,
            tripNo: true,
            tripDate: true,
            completedAt: true,
            deliveryOrders: {
              orderBy: { doNo: 'asc' },
              select: {
                id: true,
                doNo: true,
                status: true,
                podStatus: true,
                _count: { select: { redeliveries: true } },
                pods: {
                  orderBy: { version: 'desc' },
                  take: 1,
                  select: {
                    version: true,
                    outcome: true,
                    receiverName: true,
                    createdAt: true,
                    lines: true,
                    signatureDocumentId: true,
                    photoDocumentIds: true,
                    fileDocumentIds: true,
                  },
                },
              },
            },
          },
        })
      : [];
    const order = new Map(tripIds.map((t, i) => [t, i]));
    trips.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    const tripDtos: ComparisonTripDto[] = trips.map((t) => {
      // DO ยกเลิกที่ไม่ได้ออกส่ง (ไม่มีใบส่งใหม่) ไม่นับ — กฎเดียวกับคิวจ่าย
      const dos = t.deliveryOrders.filter(
        (d) => d.status !== 'CANCELLED' || d._count.redeliveries > 0,
      );
      const pods: ComparisonPodDto[] = dos.map((d) => {
        const p = d.pods[0];
        return {
          deliveryOrderId: encodeId('deliveryOrder', d.id),
          doNo: d.doNo,
          status: d.status,
          podStatus: d.podStatus,
          passed: podPassed(d.status, d.podStatus),
          podVersion: p?.version ?? null,
          outcome: p?.outcome ?? null,
          receiverName: p?.receiverName ?? null,
          recordedAt: p?.createdAt.toISOString() ?? null,
          qtyPlanned: p ? qtySum(p.lines, 'qtyPlanned') : null,
          qtyActual: p ? qtySum(p.lines, 'qtyActual') : null,
          rejectQty: p ? qtySum(p.lines, 'rejectQty') : null,
          documentIds: p
            ? [
                ...(p.signatureDocumentId ? [p.signatureDocumentId] : []),
                ...p.photoDocumentIds,
                ...p.fileDocumentIds,
              ].map((x) => encodeId('document', x))
            : [],
        };
      });
      return {
        id: encodeId('trip', t.id),
        tripNo: t.tripNo ?? '',
        tripDate: t.tripDate.toISOString().slice(0, 10),
        completedAt: t.completedAt?.toISOString() ?? null,
        podComplete: pods.length > 0 && pods.every((p) => p.passed),
        deliveryOrders: pods,
      };
    });

    return {
      id: encodeId('settlement', s.id),
      status: s.status as SettlementStatus,
      round,
      carrierInvoiceNo: s.carrierInvoiceNo,
      dispute: {
        disputed: lines.filter((l) => l.status === 'DISPUTED').length,
        approved: lines.filter((l) => l.status === 'APPROVED').length,
        open: lines.filter((l) => l.status === 'OPEN').length,
      },
      lines,
      trips: tripDtos,
    };
  }
}
