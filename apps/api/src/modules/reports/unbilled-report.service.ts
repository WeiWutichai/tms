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
  /** D-71 ร่างใบแจ้งหนี้ที่ DO อยู่ (เฉพาะแถว "ร่างค้างเกิน N วัน") */
  draft_invoice_id: string | null;
  /** เวลาที่ DO เข้าร่าง**ครั้งแรก** = `delivery_order.first_drafted_at` (PO 24 พ.ย. 2569 — ข้อ #82; ว่าง = `invoice_line.created_at` ของบรรทัดหลักที่ active) */
  draft_added_at: Date | null;
  /** วันที่เข้าร่าง (เวลาไทย) YYYY-MM-DD */
  draft_added_on: string | null;
  /** วันที่สร้างร่างใบแจ้งหนี้ (เวลาไทย) YYYY-MM-DD */
  draft_created_on: string | null;
}

/**
 * ชุดที่อ่าน (D-71): `unbilled` = ยังไม่อยู่ในใบใด (ST9-T06 เดิม) · `drafts` = อยู่ในร่างใบแจ้งหนี้เกิน N วัน ·
 * `all` = ทั้งสองชุด (รายงานบนจอ/ส่งออกเมื่อ `includeStaleDrafts=true`)
 */
export type UnbilledScope = 'unbilled' | 'drafts' | 'all';

export interface UnbilledFilter {
  asOf: string;
  minDays: number;
  customerId?: string;
  /** ค่าเริ่ม `unbilled` */
  scope?: UnbilledScope;
  /** เฉพาะชุด unbilled: วันที่ส่งถึง ≥ ค่านี้ (job แจ้งเตือนใช้นับ "เพิ่งเกินวันนี้" = ส่งถึงวันที่ asOf − N − 1 พอดี) */
  deliveredOnFrom?: string;
}
type Filter = UnbilledFilter;

/**
 * DO ที่ "ส่งถึงแล้ว" และ "ยังไม่อยู่ในใบแจ้งหนี้ใด" — **นิยามเดียวกับคิวพร้อมวางบิล/BillingGuard** (ST5-T04/T05):
 * สถานะ DELIVERED / POD_PENDING / UNBILLED + `billing_status` UNBILLED / CREDITED (ใบที่ยกเลิก — ร่างหรือออกแล้ว ST5-T10 — คืน DO เป็น UNBILLED
 * จึงกลับมาขึ้นรายงาน; DO ในร่าง (IN_DRAFT) ถือว่าอยู่ในใบแล้ว) · ไม่ขึ้นกับความพร้อมวางบิลอื่น (POD/ราคา/ระงับ) — นั่นคือเหตุที่ค้าง
 * วันที่ส่งถึง = เวลาบันทึก event `deliver` ล่าสุดในประวัติสถานะ (ตัวเดียวกับ `DeliveryOrderService.deliveredAt`) → วันที่เวลาไทย ·
 * ไม่มีประวัติ (ข้อมูลเก่า/นำเข้า) = วันที่ DO [DECISION spec/12 §3]
 * D-71 (PO 22 พ.ย. 2569) ธง "ร่างค้างเกิน N วัน": scope `drafts`/`all` เพิ่ม DO ที่ `billing_status` IN_DRAFT และ **วันนี้ − วันที่เข้าร่าง > N**
 * (วันที่เข้าร่าง = **วันแรกที่ DO เข้าร่างใดก็ได้** `delivery_order.first_drafted_at` — PO 24 พ.ย. 2569 ข้อ #82: ย้ายไปร่างอื่น/ถอดแล้วใส่ใหม่
 * ไม่เริ่มนับใหม่ · ค่าว่าง (ข้อมูลที่ไม่ผ่าน billing guard) ใช้ `invoice_line.created_at` ของบรรทัดหลักที่ active · DO ต้องยังอยู่ในร่างสถานะ DRAFT —
 * ถอดออก/ยกเลิกร่าง = บรรทัดไม่ active → หลุดจากชุดนี้ (กลับไปชุด unbilled) ·
 * N = `billing.unbilledAlertDays` ตัวเดียวกัน (ไม่เพิ่มค่าตั้ง)
 */
function baseCte(f: Filter): Prisma.Sql {
  const cutoff = addDays(f.asOf, -(f.minDays + 1));
  const scope = f.scope ?? 'unbilled';
  const notInvoiced = Prisma.sql`d.billing_status::text = ANY(${NOT_INVOICED_BILLING_STATUSES}::text[])`;
  const inDraft = Prisma.sql`d.billing_status::text = 'IN_DRAFT'`;
  const conds: Prisma.Sql[] = [
    Prisma.sql`d.status::text = ANY(${DELIVERED_STATUSES}::text[])`,
    scope === 'unbilled'
      ? notInvoiced
      : scope === 'drafts'
        ? inDraft
        : Prisma.sql`(${notInvoiced} OR ${inDraft})`,
  ];
  if (f.customerId) conds.push(Prisma.sql`d.customer_id = ${f.customerId}::uuid`);
  // D-71 ร่างที่ DO อยู่: บรรทัดหลักของ DO (do_anchor — unique ต่อ DO ที่ active) ในใบสถานะ DRAFT · อายุนับจาก first_drafted_at (#82)
  const draftJoin =
    scope === 'unbilled'
      ? Prisma.sql`LEFT JOIN LATERAL (SELECT NULL::uuid AS invoice_id, NULL::timestamptz AS created_at, NULL::timestamptz AS invoice_created_at) dl ON true`
      : Prisma.sql`LEFT JOIN LATERAL (
          SELECT l.invoice_id, l.created_at, i.created_at AS invoice_created_at FROM invoice_line l
            JOIN invoice i ON i.id = l.invoice_id AND i.status::text = 'DRAFT'
           WHERE l.delivery_order_id = d.id AND l.active AND l.do_anchor
           ORDER BY l.created_at LIMIT 1
        ) dl ON true`;
  const unbilledDay = f.deliveredOnFrom
    ? Prisma.sql`AND (x0.eff AT TIME ZONE 'Asia/Bangkok')::date >= ${f.deliveredOnFrom}::date`
    : Prisma.empty;
  const branches: Prisma.Sql[] = [];
  if (scope !== 'drafts')
    branches.push(Prisma.sql`(x0.billing_status = ANY(${NOT_INVOICED_BILLING_STATUSES}::text[])
          AND (x0.eff AT TIME ZONE 'Asia/Bangkok')::date <= ${cutoff}::date ${unbilledDay})`);
  if (scope !== 'unbilled')
    branches.push(Prisma.sql`(x0.billing_status = 'IN_DRAFT' AND x0.draft_invoice_id IS NOT NULL
          AND (x0.draft_added_at AT TIME ZONE 'Asia/Bangkok')::date <= ${cutoff}::date)`);
  return Prisma.sql`
    x0 AS (
      SELECT d.id, d.do_no, d.do_date, d.status::text AS status, d.pod_status, d.billing_status::text AS billing_status,
             d.customer_id, d.sales_order_id, d.released_at, h.at AS delivered_at,
             COALESCE(h.at, d.do_date::timestamp AT TIME ZONE 'Asia/Bangkok') AS eff,
             dl.invoice_id AS draft_invoice_id,
             CASE WHEN dl.invoice_id IS NULL THEN NULL ELSE COALESCE(d.first_drafted_at, dl.created_at) END AS draft_added_at,
             dl.invoice_created_at AS draft_created_at
        FROM delivery_order d
        LEFT JOIN LATERAL (
          SELECT max(sh.at) AS at FROM doc_status_history sh
           WHERE sh.doc_type = 'delivery_order' AND sh.doc_id = d.id AND sh.event = 'deliver'
        ) h ON true
        ${draftJoin}
       WHERE ${Prisma.join(conds, ' AND ')}
    ),
    x AS (
      SELECT x0.*, to_char(x0.eff AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS delivered_on,
             to_char(x0.draft_added_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS draft_added_on,
             to_char(x0.draft_created_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS draft_created_on
        FROM x0
       WHERE ${Prisma.join(branches, ' OR ')}
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

  /** จำนวน (ทั้งหมด + เฉพาะร่างค้าง) และมูลค่ารวมของชุดตามตัวกรอง */
  async totals(tx: Tx, f: Filter): Promise<{ n: number; drafts: number; amount: Prisma.Decimal }> {
    const r = await tx.$queryRaw<{ n: bigint; drafts: bigint; amount: Prisma.Decimal | null }[]>`
      WITH ${baseCte(f)}
      SELECT count(*) AS n, count(*) FILTER (WHERE x.draft_invoice_id IS NOT NULL) AS drafts, (
               SELECT sum(l.amount) FROM revenue_line l
                WHERE l.delivery_order_id IN (SELECT id FROM x) AND l.status = 'ACTIVE'
             ) AS amount
        FROM x`;
    return {
      n: Number(r[0]?.n ?? 0),
      drafts: Number(r[0]?.drafts ?? 0),
      amount: new Prisma.Decimal(r[0]?.amount ?? 0),
    };
  }

  private async filter(tx: Tx, q: UnbilledReportQuery): Promise<Filter> {
    const tenantId = requestContext.require().tenantId!;
    const minDays = q.minDays ? Number(q.minDays) : await this.thresholdDays(tx, tenantId);
    const customerId =
      q.customerId !== undefined ? ((await this.customerRef(tx, q.customerId)) ?? NONE) : undefined;
    return {
      asOf: bangkokToday(this.clock.now()),
      minDays,
      customerId,
      scope: q.includeStaleDrafts === 'true' ? 'all' : 'unbilled',
    };
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
      includeStaleDrafts: f.scope === 'all',
      staleDraftCount: tot && f.scope === 'all' ? tot.drafts : null,
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
      draftInvoice:
        r.draft_invoice_id && r.draft_added_at && r.draft_added_on
          ? {
              id: encodeId('invoice', r.draft_invoice_id),
              addedAt: r.draft_added_at.toISOString(),
              addedOn: r.draft_added_on,
              createdOn: r.draft_created_on ?? r.draft_added_on,
              ageDays: daysBetween(r.draft_added_on, asOf),
            }
          : null,
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
