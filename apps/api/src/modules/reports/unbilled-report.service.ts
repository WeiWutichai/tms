import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Clock } from '../../common/clock';
import { EXT_PREFIX, EXTERNAL_ID_RE } from '../../common/external-id';
import { encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import {
  DELIVERED_STATUSES,
  NOT_INVOICED_BILLING_STATUSES,
} from '../invoices/billing-queue.service';
import type { ExportPage } from '../master/export';
import { UNBILLED_ALERT_DAYS_DEFAULT } from '../settings/registry';
import { readSettings } from '../settings/settings.service';
import { addDays, bangkokToday, daysBetween } from '../vehicle-documents/expiry';
import type {
  UnbilledDeliveryOrderDto,
  UnbilledReportDto,
  UnbilledReportQuery,
} from './unbilled-report.dto';

const NONE = '00000000-0000-0000-0000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_KIND = 'unbilled';
const money = (d: Prisma.Decimal | string | number | null) => new Prisma.Decimal(d ?? 0).toFixed(2);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export interface UnbilledRow {
  id: string;
  do_no: string | null;
  do_date: Date;
  status: string;
  pod_status: string;
  billing_status: string;
  customer_id: string;
  customer_code: string;
  customer_name: string;
  sales_order_id: string;
  so_no: string | null;
  released_at: Date | null;
  /** เวลาบันทึกส่งถึงครั้งล่าสุด (null = ไม่มีประวัติ) */
  delivered_at: Date | null;
  /** เวลาที่ใช้เรียง/นับ = delivered_at หรือเที่ยงคืนวันที่ DO (เวลาไทย) */
  eff: Date;
  /** วันที่ส่งถึง (เวลาไทย) YYYY-MM-DD */
  delivered_on: string;
  amount: Prisma.Decimal | null;
}

interface Filter {
  asOf: string;
  minDays: number;
  customerId?: string;
}

/**
 * DO ที่ "ส่งถึงแล้ว" และ "ยังไม่อยู่ในใบแจ้งหนี้ใด" — **นิยามเดียวกับคิวพร้อมวางบิล/BillingGuard** (ST5-T04/T05):
 * สถานะ DELIVERED / POD_PENDING / UNBILLED + `billing_status` UNBILLED / CREDITED (ใบที่ยกเลิก — ร่างหรือออกแล้ว ST5-T10 — คืน DO เป็น UNBILLED
 * จึงกลับมาขึ้นรายงาน; DO ในร่าง (IN_DRAFT) ถือว่าอยู่ในใบแล้ว) · ไม่ขึ้นกับความพร้อมวางบิลอื่น (POD/ราคา/ระงับ) — นั่นคือเหตุที่ค้าง
 * วันที่ส่งถึง = เวลาบันทึก event `deliver` ล่าสุดในประวัติสถานะ (ตัวเดียวกับ `DeliveryOrderService.deliveredAt`) → วันที่เวลาไทย ·
 * ไม่มีประวัติ (ข้อมูลเก่า/นำเข้า) = วันที่ DO [DECISION spec/12 §3]
 */
function baseCte(f: Filter): Prisma.Sql {
  const cutoff = addDays(f.asOf, -(f.minDays + 1));
  const conds: Prisma.Sql[] = [
    Prisma.sql`d.status::text = ANY(${DELIVERED_STATUSES}::text[])`,
    Prisma.sql`d.billing_status::text = ANY(${NOT_INVOICED_BILLING_STATUSES}::text[])`,
  ];
  if (f.customerId) conds.push(Prisma.sql`d.customer_id = ${f.customerId}::uuid`);
  return Prisma.sql`
    x0 AS (
      SELECT d.id, d.do_no, d.do_date, d.status::text AS status, d.pod_status, d.billing_status::text AS billing_status,
             d.customer_id, d.sales_order_id, d.released_at, h.at AS delivered_at,
             COALESCE(h.at, d.do_date::timestamp AT TIME ZONE 'Asia/Bangkok') AS eff
        FROM delivery_order d
        LEFT JOIN LATERAL (
          SELECT max(sh.at) AS at FROM doc_status_history sh
           WHERE sh.doc_type = 'delivery_order' AND sh.doc_id = d.id AND sh.event = 'deliver'
        ) h ON true
       WHERE ${Prisma.join(conds, ' AND ')}
    ),
    x AS (
      SELECT x0.*, to_char(x0.eff AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS delivered_on
        FROM x0
       WHERE (x0.eff AT TIME ZONE 'Asia/Bangkok')::date <= ${cutoff}::date
    )`;
}

/**
 * cursor = id ของ DO แถวสุดท้ายเท่านั้น (review L3) — เวลาส่งถึงคำนวณใหม่ในฐานด้วยกฎเดียวกัน (ความละเอียดไมโครวินาทีของ timestamptz
 * ไม่หายไปกับ Date ของ JS ที่ละเอียดแค่มิลลิวินาที → ไม่มีแถวซ้ำ/ตกหล่นข้ามหน้า)
 */
function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ i: id, s: CURSOR_KIND })).toString('base64url');
}

function decodeCursor(raw: string): string {
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (v.s !== CURSOR_KIND || typeof v.i !== 'string' || !UUID.test(v.i)) throw new Error();
    return v.i;
  } catch {
    throw new ProblemException('validation_failed', undefined, [
      { field: 'cursor', code: 'invalid_cursor', message: 'cursor is invalid' },
    ]);
  }
}

/**
 * รายงาน "DO ยังไม่วางบิลเกิน N วัน" (ST9-T06; docs/04 F3 "Flag กันวางบิลซ้ำ … รายงาน 'ยังไม่วางบิลเกิน N วัน'", H "กันรายได้ตกหล่น")
 * — อ่านอย่างเดียว · RLS ของ tenant · เรียงวันที่ส่งถึงเก่าสุดก่อน (keyset (วันที่ส่งถึง, id)) · มูลค่า = Σ บรรทัดรายได้ ACTIVE (ก่อน VAT)
 * ใช้ร่วม: `GET /v1/reports/unbilled-delivery-orders`, ส่งออก (`POST /v1/exports` resource `unbilled-delivery-orders`),
 * แจ้งเตือนผู้วางบิลรายวัน (`UnbilledReminderService`)
 */
@Injectable()
export class UnbilledReportService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
  ) {}

  /** เกณฑ์วันของ tenant (ค่าตั้ง `billing.unbilledAlertDays`) */
  async thresholdDays(tx: Tx, tenantId: string): Promise<number> {
    const v = (await readSettings(tx, tenantId, ['billing.unbilledAlertDays']))[
      'billing.unbilledAlertDays'
    ];
    return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : UNBILLED_ALERT_DAYS_DEFAULT;
  }

  /** แถวตามเงื่อนไข (เรียง eff, id) — `after` = id (uuid) ของแถวสุดท้ายหน้าก่อน (cursor ของ API / งานส่งออก / job แจ้งเตือน) */
  async rows(
    tx: Tx,
    f: Filter,
    page: { take: number; after?: { id: string } | null },
  ): Promise<UnbilledRow[]> {
    let keyset = Prisma.sql`TRUE`;
    const a = page.after;
    if (a)
      // ต่อจาก id — คำนวณเวลาของแถวนั้นด้วยกฎเดียวกันในฐาน (แถวหลุดเงื่อนไขระหว่างทางก็ยังเดินต่อได้)
      keyset = Prisma.sql`(x.eff, x.id) > ((
          SELECT COALESCE(
                   (SELECT max(sh.at) FROM doc_status_history sh
                     WHERE sh.doc_type = 'delivery_order' AND sh.doc_id = dd.id AND sh.event = 'deliver'),
                   dd.do_date::timestamp AT TIME ZONE 'Asia/Bangkok')
            FROM delivery_order dd WHERE dd.id = ${a.id}::uuid), ${a.id}::uuid)`;
    return tx.$queryRaw<UnbilledRow[]>`
      WITH ${baseCte(f)}
      SELECT x.*, c.code AS customer_code, c.legal_name AS customer_name, s.so_no, m.amount
        FROM x
        JOIN customer c ON c.id = x.customer_id
        JOIN sales_order s ON s.id = x.sales_order_id
        LEFT JOIN LATERAL (
          SELECT sum(l.amount) AS amount FROM revenue_line l
           WHERE l.delivery_order_id = x.id AND l.status = 'ACTIVE'
        ) m ON true
       WHERE ${keyset}
       ORDER BY x.eff, x.id
       LIMIT ${page.take}`;
  }

  async totals(tx: Tx, f: Filter): Promise<{ n: number; amount: Prisma.Decimal }> {
    const r = await tx.$queryRaw<{ n: bigint; amount: Prisma.Decimal | null }[]>`
      WITH ${baseCte(f)}
      SELECT count(*) AS n, (
               SELECT sum(l.amount) FROM revenue_line l
                WHERE l.delivery_order_id IN (SELECT id FROM x) AND l.status = 'ACTIVE'
             ) AS amount
        FROM x`;
    return { n: Number(r[0]?.n ?? 0), amount: new Prisma.Decimal(r[0]?.amount ?? 0) };
  }

  private async filter(tx: Tx, q: UnbilledReportQuery): Promise<Filter> {
    const tenantId = requestContext.require().tenantId!;
    const minDays = q.minDays ? Number(q.minDays) : await this.thresholdDays(tx, tenantId);
    const customerId =
      q.customerId !== undefined ? ((await this.customerRef(tx, q.customerId)) ?? NONE) : undefined;
    return { asOf: bangkokToday(this.clock.now()), minDays, customerId };
  }

  async report(q: UnbilledReportQuery): Promise<UnbilledReportDto> {
    const tx = this.db.tx;
    const f = await this.filter(tx, q);
    const limit = q.limit ?? 50;
    const after = q.cursor ? { id: decodeCursor(q.cursor) } : null;
    const rows = await this.rows(tx, f, { take: limit + 1, after });
    // review L4: ยอดรวมเฉพาะหน้าแรก (ไม่มี cursor) — หน้าถัดไปไม่นับซ้ำ
    const tot = after ? null : await this.totals(tx, f);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      asOf: f.asOf,
      minDays: f.minDays,
      deliveredOnOrBefore: addDays(f.asOf, -(f.minDays + 1)),
      count: tot ? tot.n : null,
      ...(tot ? { sellAmount: money(tot.amount) } : {}),
      data: page.map((r) => this.toDto(r, f.asOf)),
      nextCursor: hasMore && last ? encodeCursor(last.id) : null,
      hasMore,
    };
  }

  /** งานส่งออก (ST9-T10 ExportSpec) — ตัวกรอง/การอ่านชุดเดียวกับรายงาน */
  async exportRows(q: UnbilledReportQuery, page: ExportPage): Promise<UnbilledDeliveryOrderDto[]> {
    const tx = this.db.tx;
    const f = await this.filter(tx, q);
    const rows = await this.rows(tx, f, {
      take: page.take,
      after: page.after ? { id: page.after } : null,
    });
    return rows.map((r) => this.toDto(r, f.asOf));
  }

  toDto(r: UnbilledRow, asOf: string): UnbilledDeliveryOrderDto {
    return {
      id: encodeId('deliveryOrder', r.id),
      doNo: r.do_no,
      doDate: ymd(r.do_date),
      status: r.status,
      podStatus: r.pod_status,
      billingStatus: r.billing_status,
      customer: {
        id: encodeId('customer', r.customer_id),
        code: r.customer_code,
        legalName: r.customer_name,
      },
      salesOrder: { id: encodeId('salesOrder', r.sales_order_id), soNo: r.so_no },
      deliveredAt: r.delivered_at?.toISOString() ?? null,
      deliveredOn: r.delivered_on,
      daysSinceDelivery: daysBetween(r.delivered_on, asOf),
      releasedAt: r.released_at?.toISOString() ?? null,
      sellAmount: money(r.amount),
    };
  }

  private async customerRef(tx: Tx, ref: string): Promise<string | null> {
    if (ref.startsWith(EXT_PREFIX)) {
      const ext = ref.slice(EXT_PREFIX.length);
      if (!EXTERNAL_ID_RE.test(ext)) return null;
      return (
        (await tx.customer.findFirst({ where: { externalId: ext }, select: { id: true } }))?.id ??
        null
      );
    }
    return tryDecodeId('customer', ref);
  }
}
