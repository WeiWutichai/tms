import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EXT_PREFIX, EXTERNAL_ID_RE } from '../../common/external-id';
import { encodeId, tryDecodeId } from '../../common/ids';
import { keysetArgs, toPage } from '../../common/pagination';
import { DbService, type Tx } from '../../db/db.service';
import { costLineDto } from '../trips/trip-costs';
import type {
  SettlementQueueCarrierDto,
  SettlementQueuePageDto,
  SettlementQueueQuery,
  SettlementQueueTripDto,
} from './settlement-queue.dto';

/** แถวผลของ query หาเที่ยวที่เข้าคิว (ทั้งชุดตามตัวกรอง — ใช้ทั้งเลือกหน้าและยอดรวมต่อรถร่วม) */
interface Candidate {
  id: string;
  carrier_id: string;
  total: Prisma.Decimal;
  n: number;
  ok: number;
}

const NONE = '00000000-0000-0000-0000-000000000000';

/**
 * คิวจ่ายรถร่วม (ST6-T02; docs/04 F6 "คิวจ่ายรถร่วม", docs/01 §4.5 "เลือก trip_cost (CARRIER_FEE) ที่ COSTED และ pod_verified")
 *
 * - เที่ยวเข้าคิว = สถานะ **COSTED** (DECISION PO 19 พ.ย. 2569 — ไม่ใช่ COMPLETED) ของรถร่วม และยังมีบรรทัด `trip_cost`
 *   ที่รอจ่าย: CONFIRMED · ของรถร่วมรายปัจจุบันของเที่ยว · `settlement_line_id` ว่าง · ไม่ใช่คู่บรรทัด/กลับรายการที่ยังไม่จ่ายทั้งคู่
 *   (บรรทัดที่อยู่ในใบสำคัญจ่ายแล้วไม่ขึ้น — ST6-T03 เขียน `settlement_line_id`)
 * - "ไม่มี POD ไม่จ่าย" (`carrier.require_pod_to_pay`, ค่าเริ่มต้นเปิด) → เที่ยวที่หลักฐานส่งไม่ครบไม่ขึ้นคิว
 *   หลักฐานครบต่อ DO: ส่งสำเร็จ = DO ผ่านเกณฑ์ POD ของลูกค้าแล้ว (UNBILLED/BILLED — ST4-T07) และฉบับล่าสุดไม่ใช่ PARTIAL ·
 *   ส่งไม่สำเร็จ/ตีกลับ/ยกเลิกเพื่อส่งใหม่ = หลักฐานชุดไม่สำเร็จครบ (`pod_status` COMPLETE) · DO ยกเลิกที่ไม่ได้ออกส่งไม่นับ ·
 *   เที่ยวไม่มี DO ที่นับ = ไม่ครบ
 * - อ่านอย่างเดียว ไม่จองบรรทัด — การกันจ่ายซ้ำอยู่ที่ unique `trip_cost.settlement_line_id` ตอนสร้างใบ (ST6-T03)
 */
@Injectable()
export class SettlementQueueService {
  constructor(private readonly db: DbService) {}

  private async carrierFilter(tx: Tx, ref: string | undefined): Promise<string | undefined> {
    if (ref === undefined) return undefined;
    if (ref.startsWith(EXT_PREFIX)) {
      const ext = ref.slice(EXT_PREFIX.length);
      if (!EXTERNAL_ID_RE.test(ext)) return NONE;
      const c = await tx.carrier.findFirst({
        where: { externalId: ext, deletedAt: null },
        select: { id: true },
      });
      return c?.id ?? NONE;
    }
    return tryDecodeId('carrier', ref) ?? NONE;
  }

  /** เที่ยวทั้งหมดที่ตรงตัวกรอง + ยอดรอจ่าย + จำนวน DO / DO ที่หลักฐานครบ */
  private candidates(tx: Tx, f: { carrierId?: string; from?: string; to?: string; pod?: boolean }) {
    const conds: Prisma.Sql[] = [
      Prisma.sql`t.status = 'COSTED'`,
      Prisma.sql`t.carrier_id IS NOT NULL`,
    ];
    if (f.carrierId) conds.push(Prisma.sql`t.carrier_id = ${f.carrierId}::uuid`);
    if (f.from)
      conds.push(
        Prisma.sql`t.completed_at >= (${f.from}::date)::timestamp AT TIME ZONE 'Asia/Bangkok'`,
      );
    if (f.to)
      conds.push(
        Prisma.sql`t.completed_at < ((${f.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Bangkok')`,
      );
    const having: Prisma.Sql[] = [
      Prisma.sql`(NOT c.require_pod_to_pay OR (coalesce(p.n, 0) > 0 AND p.n = p.ok))`,
    ];
    if (f.pod === true) having.push(Prisma.sql`(coalesce(p.n, 0) > 0 AND p.n = p.ok)`);
    if (f.pod === false) having.push(Prisma.sql`NOT (coalesce(p.n, 0) > 0 AND p.n = p.ok)`);
    return tx.$queryRaw<Candidate[]>`
      WITH t AS (
        SELECT t.id, t.carrier_id FROM trip t WHERE ${Prisma.join(conds, ' AND ')}
      ),
      pay AS (
        SELECT tc.trip_id, tc.amount
          FROM trip_cost tc
          JOIN t ON t.id = tc.trip_id AND tc.carrier_id = t.carrier_id
         WHERE tc.status = 'CONFIRMED'
           AND tc.settlement_line_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM trip_cost o
                            WHERE o.id = tc.reversal_of_id AND o.settlement_line_id IS NULL)
           AND NOT EXISTS (SELECT 1 FROM trip_cost r
                            WHERE r.reversal_of_id = tc.id AND r.settlement_line_id IS NULL)
      ),
      d AS (
        SELECT d.trip_id,
               CASE
                 WHEN d.status IN ('UNBILLED', 'BILLED') THEN d.pod_status <> 'PARTIAL'
                 WHEN d.status IN ('FAILED', 'RETURNED', 'CANCELLED') THEN d.pod_status = 'COMPLETE'
                 ELSE false
               END AS passed
          FROM delivery_order d
          JOIN t ON t.id = d.trip_id
         WHERE d.status <> 'CANCELLED'
            OR EXISTS (SELECT 1 FROM delivery_order r WHERE r.redelivery_of_id = d.id)
      ),
      p AS (
        SELECT trip_id, count(*)::int AS n, (count(*) FILTER (WHERE passed))::int AS ok
          FROM d GROUP BY trip_id
      )
      SELECT t.id, t.carrier_id, sum(pay.amount) AS total,
             coalesce(p.n, 0)::int AS n, coalesce(p.ok, 0)::int AS ok
        FROM t
        JOIN pay ON pay.trip_id = t.id
        JOIN carrier c ON c.id = t.carrier_id
        LEFT JOIN p ON p.trip_id = t.id
       GROUP BY t.id, t.carrier_id, c.require_pod_to_pay, p.n, p.ok
      HAVING ${Prisma.join(having, ' AND ')}`;
  }

  async list(q: SettlementQueueQuery, tx: Tx = this.db.tx): Promise<SettlementQueuePageDto> {
    const carrierId = await this.carrierFilter(tx, q.carrierId);
    const all = await this.candidates(tx, {
      carrierId,
      from: q.dateFrom,
      to: q.dateTo,
      pod: q.podComplete === undefined ? undefined : q.podComplete === 'true',
    });
    const k = keysetArgs(q);
    const byId = new Map(all.map((c) => [c.id, c]));
    const rows = all.length
      ? await tx.trip.findMany({
          where: { AND: [k.where as Prisma.TripWhereInput, { id: { in: [...byId.keys()] } }] },
          select: {
            id: true,
            tripNo: true,
            tripDate: true,
            completedAt: true,
            costedAt: true,
            carrierId: true,
            carrierNameSnapshot: true,
            updatedAt: true,
            carrier: { select: { requirePodToPay: true, legalName: true } },
          },
          orderBy: [...k.orderBy],
          take: k.take,
        })
      : [];
    const pageIds = rows.slice(0, k.limit).map((r) => r.id);
    const lines = pageIds.length
      ? await tx.tripCost.findMany({
          where: { tripId: { in: pageIds }, status: 'CONFIRMED', settlementLineId: null },
          include: {
            reversedBy: { select: { id: true, settlementLineId: true } },
            reversalOf: { select: { settlementLineId: true } },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      : [];
    const tripCarrier = new Map(rows.map((r) => [r.id, r.carrierId]));
    const payable = lines.filter(
      (l) =>
        l.carrierId !== null &&
        l.carrierId === tripCarrier.get(l.tripId) &&
        !(l.reversalOf && l.reversalOf.settlementLineId === null) &&
        !(l.reversedBy && l.reversedBy.settlementLineId === null),
    );

    const page = toPage(
      rows,
      k,
      (r): SettlementQueueTripDto => {
        const c = byId.get(r.id)!;
        return {
          id: encodeId('trip', r.id),
          tripNo: r.tripNo,
          tripDate: r.tripDate.toISOString().slice(0, 10),
          completedAt: r.completedAt?.toISOString() ?? null,
          costedAt: r.costedAt?.toISOString() ?? null,
          carrierId: encodeId('carrier', r.carrierId!),
          carrierName: r.carrierNameSnapshot ?? r.carrier?.legalName ?? '',
          requirePodToPay: r.carrier?.requirePodToPay ?? true,
          pod: { complete: c.n > 0 && c.n === c.ok, deliveryOrders: c.n, completeCount: c.ok },
          lines: payable.filter((l) => l.tripId === r.id).map(costLineDto),
          buyTotal: new Prisma.Decimal(c.total).toFixed(2),
          updatedAt: r.updatedAt.toISOString(),
        };
      },
      q.fields,
    );
    return {
      data: page.data as SettlementQueueTripDto[],
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      carriers: await this.totals(tx, all),
    };
  }

  /** ยอดรวมต่อรถร่วมของทุกเที่ยวที่ตรงตัวกรอง (Decimal — ไม่ใช้ float) */
  private async totals(tx: Tx, all: Candidate[]): Promise<SettlementQueueCarrierDto[]> {
    const acc = new Map<string, { n: number; total: Prisma.Decimal }>();
    for (const c of all) {
      const a = acc.get(c.carrier_id) ?? { n: 0, total: new Prisma.Decimal(0) };
      a.n += 1;
      a.total = a.total.add(new Prisma.Decimal(c.total));
      acc.set(c.carrier_id, a);
    }
    if (!acc.size) return [];
    const carriers = await tx.carrier.findMany({
      where: { id: { in: [...acc.keys()] } },
      select: { id: true, code: true, legalName: true, requirePodToPay: true },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
    });
    return carriers.map((c) => ({
      carrierId: encodeId('carrier', c.id),
      carrierCode: c.code,
      carrierName: c.legalName,
      requirePodToPay: c.requirePodToPay,
      tripCount: acc.get(c.id)!.n,
      buyTotal: acc.get(c.id)!.total.toFixed(2),
    }));
  }
}
