import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EXT_PREFIX, EXTERNAL_ID_RE } from '../../common/external-id';
import { encodeId, tryDecodeId } from '../../common/ids';
import { decodeCursor, toPage } from '../../common/pagination';
import { DbService, type Tx } from '../../db/db.service';
import { costLineDto } from '../trips/trip-costs';
import type {
  SettlementQueueCarrierDto,
  SettlementQueuePageDto,
  SettlementQueueQuery,
  SettlementQueueTripDto,
} from './settlement-queue.dto';

interface Filter {
  carrierId?: string;
  from?: string;
  to?: string;
  pod?: boolean;
  /** เฉพาะเที่ยวเหล่านี้ (ST6-T03 ตรวจบรรทัดที่จะใส่ใบสำคัญจ่าย) */
  tripIds?: string[];
}

/** แถวของหน้า (ข้อมูลเที่ยว + ยอดรอจ่าย + จำนวน DO / DO ที่หลักฐานครบ) */
interface PageRow {
  id: string;
  carrier_id: string;
  updated_at: Date;
  trip_no: string | null;
  trip_date: Date;
  completed_at: Date | null;
  costed_at: Date | null;
  carrier_name: string;
  require_pod_to_pay: boolean;
  total: Prisma.Decimal;
  n: number;
  ok: number;
}

const NONE = '00000000-0000-0000-0000-000000000000';

/**
 * บรรทัดรอจ่าย (แหล่งเดียวของกฎ — ใช้ทั้งยอดรวม ยอดต่อเที่ยว และบรรทัดที่แสดง):
 * `trip_cost` CONFIRMED · ของรถร่วมรายปัจจุบันของเที่ยว · `settlement_line_id` ว่าง ·
 * ไม่ใช่คู่บรรทัด/กลับรายการที่ยังไม่จ่ายทั้งคู่ (หักล้างกันแล้ว)
 * `trips` = CTE ที่มีคอลัมน์ `id`, `carrier_id`
 */
export const payableLines = (trips: Prisma.Sql) => Prisma.sql`
  SELECT tc.id, tc.trip_id, tc.amount
    FROM trip_cost tc
    JOIN ${trips} tt ON tt.id = tc.trip_id AND tc.carrier_id = tt.carrier_id
   WHERE tc.status = 'CONFIRMED'
     AND tc.settlement_line_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM trip_cost o
                      WHERE o.id = tc.reversal_of_id AND o.settlement_line_id IS NULL)
     AND NOT EXISTS (SELECT 1 FROM trip_cost r
                      WHERE r.reversal_of_id = tc.id AND r.settlement_line_id IS NULL)`;

const POD_OK = Prisma.sql`(coalesce(p.n, 0) > 0 AND p.n = p.ok)`;

/**
 * คิวจ่ายรถร่วม (ST6-T02; docs/04 F6 "คิวจ่ายรถร่วม", docs/01 §4.5 "เลือก trip_cost (CARRIER_FEE) ที่ COSTED และ pod_verified")
 *
 * - เที่ยวเข้าคิว = สถานะ **COSTED** (DECISION PO 19 พ.ย. 2569 — ไม่ใช่ COMPLETED) ของรถร่วม ที่ยังมีบรรทัดรอจ่าย (`payableLines`)
 *   (บรรทัดที่อยู่ในใบสำคัญจ่ายแล้วไม่ขึ้น — ST6-T03 เขียน `settlement_line_id`)
 * - "ไม่มี POD ไม่จ่าย" (`carrier.require_pod_to_pay`, ค่าเริ่มต้นเปิด) → เที่ยวที่หลักฐานส่งไม่ครบไม่ขึ้นคิว
 *   หลักฐานครบต่อ DO: ส่งสำเร็จ = DO ผ่านเกณฑ์ POD ของลูกค้าแล้ว (UNBILLED/BILLED — ST4-T07) และฉบับล่าสุดไม่ใช่ PARTIAL ·
 *   ส่งไม่สำเร็จ/ตีกลับ/ยกเลิกเพื่อส่งใหม่ = หลักฐานชุดไม่สำเร็จครบ (`pod_status` COMPLETE) · DO ยกเลิกที่ไม่ได้ออกส่งไม่นับ ·
 *   เที่ยวไม่มี DO ที่นับ = ไม่ครบ [OPEN — PO spec/12 §3]
 * - `t0` NOT MATERIALIZED: ให้ planner ใช้ index ของ trip/trip_cost (CTE ที่ materialize ทำ nested loop ทั้งชุด)
 * - หน้า = keyset (updated_at, id) + LIMIT ใน SQL · ยอดรวมต่อรถร่วม = aggregate SQL แยก (ไม่มีรายการ id ยาว)
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

  /**
   * CTE ของคิว: `q` = เที่ยวที่ตรงตัวกรองทั้งหมด (id, carrier_id, updated_at, total, n, ok) — ใช้ซ้ำทั้งหน้าและยอดรวม
   */
  private queueCte(f: Filter): Prisma.Sql {
    const conds: Prisma.Sql[] = [
      Prisma.sql`t.status = 'COSTED'`,
      Prisma.sql`t.carrier_id IS NOT NULL`,
    ];
    if (f.carrierId) conds.push(Prisma.sql`t.carrier_id = ${f.carrierId}::uuid`);
    if (f.tripIds) conds.push(Prisma.sql`t.id = ANY(${f.tripIds}::uuid[])`);
    if (f.from)
      conds.push(
        Prisma.sql`t.completed_at >= ((${f.from}::date)::timestamp AT TIME ZONE 'Asia/Bangkok')`,
      );
    if (f.to)
      conds.push(
        Prisma.sql`t.completed_at < ((${f.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Bangkok')`,
      );
    const having: Prisma.Sql[] = [Prisma.sql`(NOT c.require_pod_to_pay OR ${POD_OK})`];
    if (f.pod === true) having.push(POD_OK);
    if (f.pod === false) having.push(Prisma.sql`NOT ${POD_OK}`);
    return Prisma.sql`
      t0 AS NOT MATERIALIZED (
        SELECT t.id, t.carrier_id, t.updated_at FROM trip t WHERE ${Prisma.join(conds, ' AND ')}
      ),
      pay AS (${payableLines(Prisma.sql`t0`)}),
      d AS (
        SELECT d.trip_id,
               CASE
                 WHEN d.status IN ('UNBILLED', 'BILLED') THEN d.pod_status <> 'PARTIAL'
                 WHEN d.status IN ('FAILED', 'RETURNED', 'CANCELLED') THEN d.pod_status = 'COMPLETE'
                 ELSE false
               END AS passed
          FROM delivery_order d
          JOIN t0 ON t0.id = d.trip_id
         WHERE d.status <> 'CANCELLED'
            OR EXISTS (SELECT 1 FROM delivery_order r WHERE r.redelivery_of_id = d.id)
      ),
      p AS (
        SELECT trip_id, count(*)::int AS n, (count(*) FILTER (WHERE passed))::int AS ok
          FROM d GROUP BY trip_id
      ),
      q AS (
        SELECT t0.id, t0.carrier_id, t0.updated_at, sum(pay.amount) AS total,
               coalesce(p.n, 0)::int AS n, coalesce(p.ok, 0)::int AS ok
          FROM t0
          JOIN pay ON pay.trip_id = t0.id
          JOIN carrier c ON c.id = t0.carrier_id
          LEFT JOIN p ON p.trip_id = t0.id
         GROUP BY t0.id, t0.carrier_id, t0.updated_at, c.require_pod_to_pay, p.n, p.ok
        HAVING ${Prisma.join(having, ' AND ')}
      )`;
  }

  async list(q: SettlementQueueQuery, tx: Tx = this.db.tx): Promise<SettlementQueuePageDto> {
    const f: Filter = {
      carrierId: await this.carrierFilter(tx, q.carrierId),
      from: q.dateFrom,
      to: q.dateTo,
      pod: q.podComplete === undefined ? undefined : q.podComplete === 'true',
    };
    const limit = q.limit ?? 50;
    const desc = q.sort === '-updatedAt';
    const sort = desc ? '-updatedAt' : 'updatedAt';
    const keyset: Prisma.Sql[] = [Prisma.sql`true`];
    if (q.updatedAfter)
      keyset.push(Prisma.sql`q.updated_at > ${new Date(q.updatedAfter)}::timestamptz`);
    if (q.cursor) {
      const c = decodeCursor(q.cursor, sort);
      keyset.push(
        desc
          ? Prisma.sql`(q.updated_at, q.id) < (${c.u}::timestamptz, ${c.i}::uuid)`
          : Prisma.sql`(q.updated_at, q.id) > (${c.u}::timestamptz, ${c.i}::uuid)`,
      );
    }
    const order = desc
      ? Prisma.sql`q.updated_at DESC, q.id DESC`
      : Prisma.sql`q.updated_at ASC, q.id ASC`;
    const cte = this.queueCte(f);
    const rows = await tx.$queryRaw<PageRow[]>`
      WITH ${cte}
      SELECT q.id, q.carrier_id, q.updated_at, q.total, q.n, q.ok,
             t.trip_no, t.trip_date, t.completed_at, t.costed_at,
             coalesce(t.carrier_name_snapshot, c.legal_name) AS carrier_name, c.require_pod_to_pay
        FROM q
        JOIN trip t ON t.id = q.id
        JOIN carrier c ON c.id = q.carrier_id
       WHERE ${Prisma.join(keyset, ' AND ')}
       ORDER BY ${order}
       LIMIT ${limit + 1}`;
    const pageIds = rows.slice(0, limit).map((r) => r.id);
    // บรรทัดของหน้า — กฎเดียวกับยอด (payableLines) · รายการ id ≤ limit
    const lineIds = pageIds.length
      ? (
          await tx.$queryRaw<{ id: string }[]>`
            WITH tp AS NOT MATERIALIZED (SELECT t.id, t.carrier_id FROM trip t WHERE t.id = ANY(${pageIds}::uuid[]))
            SELECT x.id FROM (${payableLines(Prisma.sql`tp`)}) x`
        ).map((r) => r.id)
      : [];
    const lines = lineIds.length
      ? await tx.tripCost.findMany({
          where: { id: { in: lineIds } },
          include: { reversedBy: { select: { id: true } } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      : [];

    const page = toPage(
      rows.map((r) => ({ ...r, updatedAt: r.updated_at })),
      { limit, sort },
      (r): SettlementQueueTripDto => ({
        id: encodeId('trip', r.id),
        tripNo: r.trip_no,
        tripDate: r.trip_date.toISOString().slice(0, 10),
        completedAt: r.completed_at?.toISOString() ?? null,
        costedAt: r.costed_at?.toISOString() ?? null,
        carrierId: encodeId('carrier', r.carrier_id),
        carrierName: r.carrier_name,
        requirePodToPay: r.require_pod_to_pay,
        pod: { complete: r.n > 0 && r.n === r.ok, deliveryOrders: r.n, completeCount: r.ok },
        lines: lines.filter((l) => l.tripId === r.id).map(costLineDto),
        buyTotal: new Prisma.Decimal(r.total).toFixed(2),
        updatedAt: r.updated_at.toISOString(),
      }),
      q.fields,
    );
    return {
      data: page.data as SettlementQueueTripDto[],
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      carriers: await this.totals(tx, cte),
    };
  }

  /**
   * ST6-T03: บรรทัดที่รอจ่ายของเที่ยวที่ขึ้นคิว (กฎเดียวกับคิว — สถานะ COSTED, รถร่วมรายปัจจุบัน, "ไม่มี POD ไม่จ่าย", คู่กลับรายการ)
   * ของรถร่วม `carrierId` เฉพาะเที่ยว `tripIds` — ผู้เรียกต้องล็อกบรรทัด (FOR UPDATE) ก่อน
   */
  async payableCostLines(tx: Tx, carrierId: string, tripIds: string[]) {
    if (!tripIds.length) return [];
    const cte = this.queueCte({ carrierId, tripIds });
    return tx.$queryRaw<{ id: string; trip_id: string }[]>`
      WITH ${cte}
      SELECT pay.id, pay.trip_id FROM pay JOIN q ON q.id = pay.trip_id`;
  }

  /** ยอดรวมต่อรถร่วมของทุกเที่ยวที่ตรงตัวกรอง — aggregate ใน SQL (Decimal — ไม่ใช้ float) */
  private async totals(tx: Tx, cte: Prisma.Sql): Promise<SettlementQueueCarrierDto[]> {
    const rows = await tx.$queryRaw<
      {
        carrier_id: string;
        code: string;
        legal_name: string;
        require_pod_to_pay: boolean;
        n: number;
        total: Prisma.Decimal;
      }[]
    >`
      WITH ${cte}
      SELECT q.carrier_id, c.code, c.legal_name, c.require_pod_to_pay,
             count(*)::int AS n, sum(q.total) AS total
        FROM q JOIN carrier c ON c.id = q.carrier_id
       GROUP BY q.carrier_id, c.code, c.legal_name, c.require_pod_to_pay
       ORDER BY c.code, q.carrier_id`;
    return rows.map((c) => ({
      carrierId: encodeId('carrier', c.carrier_id),
      carrierCode: c.code,
      carrierName: c.legal_name,
      requirePodToPay: c.require_pod_to_pay,
      tripCount: c.n,
      buyTotal: new Prisma.Decimal(c.total).toFixed(2),
    }));
  }
}
