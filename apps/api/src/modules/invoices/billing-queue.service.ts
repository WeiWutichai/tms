import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EXT_PREFIX, EXTERNAL_ID_RE } from '../../common/external-id';
import { encodeId, tryDecodeId } from '../../common/ids';
import { decodeCursor, toPage } from '../../common/pagination';
import { DbService, type Tx } from '../../db/db.service';
import { PodService } from '../pod/pod.service';
import { LINE_UNIT_EXPR, LINE_UNIT_JOINS } from './line-units';
import type {
  BillingQueueCustomerDto,
  BillingQueuePageDto,
  BillingQueueQuery,
  BillingQueueRowDto,
} from './billing-queue.dto';

const NONE = '00000000-0000-0000-0000-000000000000';

/** เหตุที่ DO ยังไม่พร้อมวางบิล (ตรงกับ `reasons[]` ของ 409 `not_ready_to_bill`) */
export type NotReadyReason =
  | 'NOT_DELIVERED'
  | 'BILLING_HOLD'
  | 'PRICING_UNAVAILABLE'
  | 'NO_REVENUE'
  | 'REVENUE_PROVISIONAL'
  | 'REVENUE_LOCKED'
  | 'SURCHARGE_PENDING'
  | 'STOP_TIMES_MISSING'
  | 'POD_INCOMPLETE'
  /** ST5-T05: อยู่ในใบแจ้งหนี้ที่ยัง active แล้ว (billingStatus IN_DRAFT / INVOICED) */
  | 'IN_INVOICE'
  /** ST5-T07: ยังไม่ส่งบัญชี (RELEASED — docs/04 F4 DELIVERED → RELEASED → IN_DRAFT) */
  | 'NOT_RELEASED';

/** ผลประเมินความพร้อมต่อ DO (แถวของ CTE `r`) */
export interface Readiness {
  id: string;
  customer_id: string;
  updated_at: Date;
  status: string;
  pod_ok: boolean;
  req_pod: boolean;
  held: boolean;
  priced: boolean;
  lines: number;
  total: Prisma.Decimal;
  prov: boolean;
  locked: boolean;
  sur_pending: boolean;
  stop_ok: boolean;
  /** ST5-T05 billingStatus IN_DRAFT / INVOICED (BIL-020 (จ) "ไม่อยู่ในบรรทัด INV ที่ active") */
  billed: boolean;
  released: boolean;
}

interface Filter {
  ids?: string[];
  customerId?: string;
  from?: string;
  to?: string;
  pod?: boolean;
  released?: boolean;
  /** incremental pull — ใช้ทั้งแถวและยอดรวมต่อลูกค้า (QA L) */
  updatedAfter?: Date;
}

interface PageRow {
  id: string;
  updated_at: Date;
  pod_ok: boolean;
  req_pod: boolean;
  stop_ok: boolean;
  lines: number;
  total: Prisma.Decimal;
  do_no: string;
  do_date: Date;
  status: string;
  pod_status: string;
  version: number;
  sales_order_id: string;
  so_no: string | null;
  customer_id: string;
  customer_code: string;
  customer_name: string;
  customer_ref: string | null;
  dest_site_name: string;
  origin_site_name: string;
  goods: string | null;
  goods_more: number;
  freight_qty: Prisma.Decimal | null;
  freight_unit: string | null;
  freight_price: Prisma.Decimal | null;
  freight_total: Prisma.Decimal;
  svc_total: Prisma.Decimal;
  exempt_base: Prisma.Decimal;
  vat_base: Prisma.Decimal;
  trip_no: string | null;
  vehicle_plate: string | null;
  carrier_name: string | null;
  released_at: Date | null;
  released_by_name: string | null;
}

/**
 * DO ที่ส่งถึงแล้ว (docs/01 §4.3: DELIVERED → POD_PENDING/UNBILLED) — BILLED/สถานะอื่นไม่เข้าคิว ·
 * FAILED ที่มีบรรทัดเรียกเก็บได้ (spec/05 BIL-020 (ก)) ยังไม่เข้า [OPEN — PO spec/12 §3]
 */
const DELIVERED_STATUSES = ['DELIVERED', 'POD_PENDING', 'UNBILLED'];

/** เงื่อนไขพร้อมวางบิลของคิว (ไม่รวมเวลาจุดส่ง — แสดงเป็นธง; ส่งบัญชีต้องครบ) */
const QUEUE_READY = Prisma.sql`
  (r.pod_ok OR NOT r.req_pod) AND NOT r.held AND r.priced AND r.lines > 0
  AND NOT r.prov AND NOT r.locked AND NOT r.sur_pending AND NOT r.billed`;

/**
 * คิว "พร้อมวางบิล" (ST5-T04; docs/04 F3 "คิวพร้อมวางบิล", spec/05 §2 BIL-020) — อ่านอย่างเดียว
 *
 * DO เข้าคิวเมื่อครบทุกข้อ (กฎเดียว — `readinessCte` ใช้ทั้งคิวและการส่งบัญชี):
 * - ส่งถึงแล้ว: DELIVERED / POD_PENDING / UNBILLED
 * - หลักฐานส่ง: ลูกค้าเปิด "ไม่มี POD ไม่วางบิล" (`customer.require_pod_to_bill`, ค่าเริ่มต้นเปิด) → DO ต้องผ่านเกณฑ์ POD ของลูกค้าแล้ว
 *   (UNBILLED — ST4-T07) **และ** ฉบับล่าสุดไม่ใช่ PARTIAL (แก้ภายหลังจนไม่ครบ DO ไม่ถอยสถานะ) · ปิด = ขึ้นคิวพร้อม `pod.complete = false`
 *   (ตอนส่งบัญชีตรวจซ้ำกับ checklist ปัจจุบัน — `BillingReleaseService`)
 * - ราคา: ใบสั่ง `pricing_status = AVAILABLE` หรือมีค่าขนส่งที่กำหนดเอง (ORD-043 — บรรทัด FREIGHT ที่มา MANUAL)
 *   (RATE_MISSING/CALCULATION_FAILURE ที่ไม่มีราคากำหนดเองไม่ขึ้น) และ DO มีบรรทัดรายได้ที่ยังใช้ ≥ 1 ·
 *   ไม่มีบรรทัด `provisional` (ยอดยังไม่ยืนยัน — ST5-T01b) · ไม่มีบรรทัดที่ล็อก (ออกใบแล้ว) · ไม่มีค่าใช้จ่ายหน้างานฝั่งขายที่รอยืนยัน
 * - ไม่มีป้ายระงับวางบิล (`billing_hold`)
 * - ยังไม่อยู่ในใบแจ้งหนี้ที่ active (`billing_status` UNBILLED / CREDITED — ST5-T05, spec/05 BIL-020 (จ))
 * หน้า = keyset (updated_at, id) + LIMIT ใน SQL · `customers[]` = aggregate SQL แยก
 */
@Injectable()
export class BillingQueueService {
  constructor(
    private readonly db: DbService,
    private readonly pod: PodService,
  ) {}

  private async customerFilter(tx: Tx, ref: string | undefined): Promise<string | undefined> {
    if (ref === undefined) return undefined;
    if (ref.startsWith(EXT_PREFIX)) {
      const ext = ref.slice(EXT_PREFIX.length);
      if (!EXTERNAL_ID_RE.test(ext)) return NONE;
      const c = await tx.customer.findFirst({
        where: { externalId: ext, deletedAt: null },
        select: { id: true },
      });
      return c?.id ?? NONE;
    }
    return tryDecodeId('customer', ref) ?? NONE;
  }

  /** CTE `r` = ผลประเมินความพร้อมของทุก DO ที่ส่งถึงแล้วและตรงตัวกรองพื้นฐาน */
  private readinessCte(f: Filter): Prisma.Sql {
    const conds: Prisma.Sql[] = [Prisma.sql`d.status::text = ANY(${DELIVERED_STATUSES}::text[])`];
    if (f.ids) conds.push(Prisma.sql`d.id = ANY(${f.ids}::uuid[])`);
    if (f.customerId) conds.push(Prisma.sql`d.customer_id = ${f.customerId}::uuid`);
    if (f.from) conds.push(Prisma.sql`d.do_date >= ${f.from}::date`);
    if (f.to) conds.push(Prisma.sql`d.do_date <= ${f.to}::date`);
    if (f.released === true) conds.push(Prisma.sql`d.released_at IS NOT NULL`);
    if (f.released === false) conds.push(Prisma.sql`d.released_at IS NULL`);
    if (f.updatedAfter) conds.push(Prisma.sql`d.updated_at > ${f.updatedAfter}::timestamptz`);
    return Prisma.sql`
      d0 AS NOT MATERIALIZED (
        SELECT d.id, d.customer_id, d.sales_order_id, d.trip_stop_id, d.updated_at, d.status::text AS status,
               d.pod_status, d.billing_hold, d.released_at, d.billing_status
          FROM delivery_order d WHERE ${Prisma.join(conds, ' AND ')}
      ),
      rl AS (
        SELECT l.delivery_order_id AS id, count(*)::int AS n, sum(l.amount) AS total,
               bool_or(l.provisional) AS prov, bool_or(l.locked_at IS NOT NULL) AS locked
          FROM revenue_line l JOIN d0 ON d0.id = l.delivery_order_id
         WHERE l.status = 'ACTIVE'
         GROUP BY l.delivery_order_id
      ),
      r AS (
        SELECT d0.id, d0.customer_id, d0.updated_at, d0.status,
               (d0.status = 'UNBILLED' AND d0.pod_status <> 'PARTIAL') AS pod_ok,
               c.require_pod_to_bill AS req_pod,
               d0.billing_hold AS held,
               -- มีราคา = หา rate card ได้ (AVAILABLE) **หรือ** มีค่าขนส่งที่กำหนดเอง (ORD-043 บรรทัด FREIGHT ที่มา MANUAL —
               -- pricing_status คงเป็นผลหา rate card เช่น RATE_MISSING) · กฎเดียวกับใบค้าง RATE_MISSING (evaluateIntakeHolds)
               (s.pricing_status = 'AVAILABLE' OR EXISTS (
                  SELECT 1 FROM sales_order_charge ch
                   WHERE ch.sales_order_id = s.id AND ch.origin = 'MANUAL' AND ch.kind = 'FREIGHT')) AS priced,
               coalesce(rl.n, 0)::int AS lines, coalesce(rl.total, 0) AS total,
               coalesce(rl.prov, false) AS prov, coalesce(rl.locked, false) AS locked,
               EXISTS (SELECT 1 FROM do_surcharge x
                        WHERE x.delivery_order_id = d0.id AND x.status = 'PENDING_CONFIRM') AS sur_pending,
               (st.arrived_at IS NOT NULL AND st.departed_at IS NOT NULL) AS stop_ok,
               (d0.released_at IS NOT NULL) AS released,
               (d0.billing_status NOT IN ('UNBILLED', 'CREDITED')) AS billed
          FROM d0
          JOIN customer c ON c.id = d0.customer_id
          JOIN sales_order s ON s.id = d0.sales_order_id
          LEFT JOIN trip_stop st ON st.id = d0.trip_stop_id
          LEFT JOIN rl ON rl.id = d0.id
      )`;
  }

  private queueCte(f: Filter): Prisma.Sql {
    const conds: Prisma.Sql[] = [QUEUE_READY];
    if (f.pod === true) conds.push(Prisma.sql`r.pod_ok`);
    if (f.pod === false) conds.push(Prisma.sql`NOT r.pod_ok`);
    return Prisma.sql`${this.readinessCte(f)},
      q AS (SELECT r.* FROM r WHERE ${Prisma.join(conds, ' AND ')})`;
  }

  /** ผลประเมินความพร้อมของ DO เดียว (null = ยังไม่ส่งถึง) — ใช้ตอนส่งบัญชี (ผู้เรียกถือล็อก DO แล้ว) */
  async readiness(tx: Tx, id: string): Promise<Readiness | null> {
    const rows = await tx.$queryRaw<Readiness[]>`
      WITH ${this.readinessCte({ ids: [id] })} SELECT r.* FROM r`;
    return rows[0] ?? null;
  }

  /** เหตุที่ยังไม่พร้อม (ไม่รวม POD — ผู้เรียกตรวจกับ checklist ปัจจุบัน) */
  static blockers(r: Readiness): NotReadyReason[] {
    const out: NotReadyReason[] = [];
    if (r.held) out.push('BILLING_HOLD');
    if (!r.priced) out.push('PRICING_UNAVAILABLE');
    if (r.lines === 0) out.push('NO_REVENUE');
    if (r.prov) out.push('REVENUE_PROVISIONAL');
    if (r.locked) out.push('REVENUE_LOCKED');
    if (r.sur_pending) out.push('SURCHARGE_PENDING');
    if (!r.stop_ok) out.push('STOP_TIMES_MISSING');
    if (r.billed) out.push('IN_INVOICE');
    return out;
  }

  async list(q: BillingQueueQuery, tx: Tx = this.db.tx): Promise<BillingQueuePageDto> {
    const f: Filter = {
      customerId: await this.customerFilter(tx, q.customerId),
      from: q.dateFrom,
      to: q.dateTo,
      pod: q.podComplete === undefined ? undefined : q.podComplete === 'true',
      released: q.released === undefined ? undefined : q.released === 'true',
      updatedAfter: q.updatedAfter ? new Date(q.updatedAfter) : undefined,
    };
    const limit = q.limit ?? 50;
    const desc = q.sort === '-updatedAt';
    const sort = desc ? '-updatedAt' : 'updatedAt';
    const keyset: Prisma.Sql[] = [Prisma.sql`true`];
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
      SELECT q.id, q.updated_at, q.pod_ok, q.req_pod, q.stop_ok, q.lines, q.total,
             d.do_no, d.do_date, d.status::text AS status, d.pod_status, d.version, d.sales_order_id,
             s.so_no, d.customer_id, c.code AS customer_code, c.legal_name AS customer_name,
             d.customer_ref, ds.name AS dest_site_name, os.name AS origin_site_name,
             g.goods, coalesce(g.more, 0)::int AS goods_more,
             m.freight_qty, m.freight_unit, m.freight_price, coalesce(m.freight_total, 0) AS freight_total,
             coalesce(m.svc_total, 0) AS svc_total, coalesce(m.exempt_base, 0) AS exempt_base,
             coalesce(m.vat_base, 0) AS vat_base,
             t.trip_no, t.vehicle_plate_snapshot AS vehicle_plate, t.carrier_name_snapshot AS carrier_name,
             d.released_at, u.name AS released_by_name
        FROM q
        JOIN delivery_order d ON d.id = q.id
        JOIN sales_order s ON s.id = d.sales_order_id
        JOIN customer c ON c.id = d.customer_id
        JOIN customer_site ds ON ds.id = d.dest_site_id
        JOIN customer_site os ON os.id = d.origin_site_id
        LEFT JOIN LATERAL (
          SELECT (array_agg(x.description ORDER BY x.line_no))[1] AS goods, count(*) - 1 AS more
            FROM delivery_order_line x WHERE x.delivery_order_id = d.id
        ) g ON true
        LEFT JOIN LATERAL (
          SELECT sum(l.qty) FILTER (WHERE l.kind = 'FREIGHT') AS freight_qty,
                 max(${LINE_UNIT_EXPR}) FILTER (WHERE l.kind = 'FREIGHT') AS freight_unit,
                 CASE WHEN count(DISTINCT l.unit_price) FILTER (WHERE l.kind = 'FREIGHT') = 1
                      THEN max(l.unit_price) FILTER (WHERE l.kind = 'FREIGHT') END AS freight_price,
                 sum(l.amount) FILTER (WHERE l.kind = 'FREIGHT') AS freight_total,
                 sum(l.amount) FILTER (WHERE l.kind <> 'FREIGHT') AS svc_total,
                 sum(l.amount) FILTER (WHERE l.vat_type = 'EXEMPT_TRANSPORT') AS exempt_base,
                 sum(l.amount) FILTER (WHERE l.vat_type = 'VAT_7') AS vat_base
            FROM revenue_line l ${LINE_UNIT_JOINS}
           WHERE l.delivery_order_id = d.id AND l.status = 'ACTIVE'
        ) m ON true
        LEFT JOIN trip t ON t.id = d.trip_id
        LEFT JOIN app_user u ON u.id::text = d.released_by
       WHERE ${Prisma.join(keyset, ' AND ')}
       ORDER BY ${order}
       LIMIT ${limit + 1}`;

    // ST5-T04 QA L1: หลักฐานของแถวในหน้า (≤ limit) ตรวจกับ checklist **ปัจจุบัน** ของลูกค้าแบบเดียวกับตอนส่งบัญชี —
    // checklist เข้มขึ้นหลัง DO ผ่าน = `pod.complete` false + `pod.checklistOk` false (ตัวกรอง podComplete / customers[] ใช้สถานะที่เก็บ)
    const current = new Map<string, boolean>();
    for (const r of rows.slice(0, limit))
      if (r.pod_ok)
        current.set(
          r.id,
          (await this.pod.checkCurrent(tx, { id: r.id, customerId: r.customer_id })).ok,
        );
    const page = toPage(
      rows.map((r) => ({ ...r, updatedAt: r.updated_at })),
      { limit, sort },
      (r): BillingQueueRowDto => ({
        id: encodeId('deliveryOrder', r.id),
        doNo: r.do_no,
        doDate: r.do_date.toISOString().slice(0, 10),
        status: r.status,
        orderId: encodeId('salesOrder', r.sales_order_id),
        soNo: r.so_no,
        customerId: encodeId('customer', r.customer_id),
        customerCode: r.customer_code,
        customerName: r.customer_name,
        customerRef: r.customer_ref,
        destSiteName: r.dest_site_name,
        originSiteName: r.origin_site_name,
        goods: r.goods ? (r.goods_more > 0 ? `${r.goods} +${r.goods_more}` : r.goods) : null,
        freightQty: r.freight_qty === null ? null : new Prisma.Decimal(r.freight_qty).toString(),
        freightUnit: r.freight_qty === null ? null : r.freight_unit,
        sellFreightUnitPrice:
          r.freight_price === null ? null : new Prisma.Decimal(r.freight_price).toFixed(2),
        sellFreightAmount: new Prisma.Decimal(r.freight_total).toFixed(2),
        sellServiceAmount: new Prisma.Decimal(r.svc_total).toFixed(2),
        sellExemptBase: new Prisma.Decimal(r.exempt_base).toFixed(2),
        sellVatableBase: new Prisma.Decimal(r.vat_base).toFixed(2),
        tripNo: r.trip_no,
        vehiclePlate: r.vehicle_plate,
        carrierName: r.carrier_name,
        requirePodToBill: r.req_pod,
        pod: {
          status: r.pod_status,
          complete: r.pod_ok && (current.get(r.id) ?? true),
          checklistOk: r.pod_ok ? (current.get(r.id) ?? true) : false,
        },
        stopTimesComplete: r.stop_ok,
        revenueLineCount: r.lines,
        sellTotal: new Prisma.Decimal(r.total).toFixed(2),
        releasedAt: r.released_at?.toISOString() ?? null,
        releasedByName: r.released_at ? (r.released_by_name ?? null) : null,
        version: r.version,
        updatedAt: r.updated_at.toISOString(),
      }),
      q.fields,
    );
    return {
      data: page.data as BillingQueueRowDto[],
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      customers: await this.totals(tx, cte),
    };
  }

  /** ยอดรวมต่อลูกค้าของทุกแถวที่ตรงตัวกรอง — aggregate ใน SQL (Decimal — ไม่ใช้ float) */
  private async totals(tx: Tx, cte: Prisma.Sql): Promise<BillingQueueCustomerDto[]> {
    const rows = await tx.$queryRaw<
      {
        customer_id: string;
        code: string;
        legal_name: string;
        require_pod_to_bill: boolean;
        n: number;
        released: number;
        total: Prisma.Decimal;
      }[]
    >`
      WITH ${cte}
      SELECT q.customer_id, c.code, c.legal_name, c.require_pod_to_bill,
             count(*)::int AS n, (count(*) FILTER (WHERE q.released))::int AS released,
             sum(q.total) AS total
        FROM q JOIN customer c ON c.id = q.customer_id
       GROUP BY q.customer_id, c.code, c.legal_name, c.require_pod_to_bill
       ORDER BY c.code, q.customer_id`;
    return rows.map((c) => ({
      customerId: encodeId('customer', c.customer_id),
      customerCode: c.code,
      customerName: c.legal_name,
      requirePodToBill: c.require_pod_to_bill,
      deliveryOrderCount: c.n,
      releasedCount: c.released,
      sellTotal: new Prisma.Decimal(c.total).toFixed(2),
    }));
  }
}
