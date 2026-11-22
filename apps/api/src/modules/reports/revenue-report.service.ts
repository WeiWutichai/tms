import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ISSUED_INVOICE_STATUSES, monthRange, monthSpan, scopeAllows } from '@tms/domain';
import { Clock } from '../../common/clock';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { bangkokToday } from '../vehicle-documents/expiry';
import {
  REVENUE_MAX_MONTHS,
  type RevenueGroupBy,
  type RevenueReportDto,
  type RevenueReportQuery,
  type RevenueRowDto,
} from './revenue-report.dto';

const money = (d: Prisma.Decimal | string | number | null) => new Prisma.Decimal(d ?? 0).toFixed(2);

interface Filter {
  groupBy: RevenueGroupBy;
  fromMonth: string;
  toMonth: string;
  from: string;
  to: string;
  asOf: string;
}

interface GroupRow {
  k: string | null;
  label: string | null;
  detail: string | null;
  invoices: bigint;
  dos: bigint;
  lines: bigint;
  amount: Prisma.Decimal | null;
  /** เฉพาะ route */
  o_name?: string | null;
  d_name?: string | null;
}

/**
 * บรรทัดรายได้ของรายงาน — **บรรทัดใบแจ้งหนี้ที่ออกเลขแล้วและไม่ถูกยกเลิก** (docs/04 H "จาก invoice line finalized", K3 "อ่านจาก invoice line เดียวกัน")
 * - ใบ: สถานะ `ISSUED_INVOICE_STATUSES` (ISSUED / PARTIALLY_PAID / PAID / ADJUSTED — ชุดเดียวกับ "ออกใบแจ้งหนี้เดือนนี้" ของ Dashboard บิล)
 *   ไม่รวมร่าง และใบที่ยกเลิก/void (สถานะปัจจุบัน — ใบที่ยกเลิกภายหลังหลุดออกจากเดือนที่ออก)
 * - เดือน = `invoice.issue_date` (วันที่ออก เวลาไทย — เขียนตอน finalize)
 * - บรรทัด: `active` (บรรทัดบนเอกสาร — บรรทัดที่ถอดออกตอนเป็นร่างไม่นับ) · รายได้ = `amount` (หลังส่วนลด ก่อน VAT)
 *   → Σ ทุกบรรทัด = Σ (subtotal_vatable + subtotal_exempt + subtotal_zero_rated) ของใบ
 */
function linesCte(f: Filter): Prisma.Sql {
  return Prisma.sql`
    l AS (
      SELECT il.id, il.amount, il.invoice_id, il.delivery_order_id,
             i.customer_id, i.issuing_company_id, i.issue_date, i.issued_at,
             i.customer_snapshot, i.issuer_snapshot
        FROM invoice_line il
        JOIN invoice i ON i.id = il.invoice_id
       WHERE il.active
         AND i.status::text = ANY(${[...ISSUED_INVOICE_STATUSES]}::text[])
         AND i.issue_date BETWEEN ${f.from}::date AND ${f.to}::date
    )`;
}

const AGG = Prisma.sql`count(DISTINCT l.invoice_id) AS invoices, count(DISTINCT l.delivery_order_id) AS dos,
                       count(*) AS lines, sum(l.amount) AS amount`;

/**
 * แหล่งของแต่ละมิติ [DECISION spec/12 §3 แถว ST9-T05]:
 * - ลูกค้า: `invoice.customer_id` · ชื่อ/รหัส = snapshot ณ วันออกของใบล่าสุดในช่วง
 * - นิติบุคคล: `invoice.issuing_company_id` (ผู้ออกใบ) · ชื่อ/เลขผู้เสียภาษี = `issuer_snapshot` ของใบล่าสุดในช่วง
 * - เดือน: `invoice.issue_date`
 * - เส้นทาง: DO ของบรรทัด (`origin_site_id` → `dest_site_id`) — ชื่อจุดปัจจุบันจากข้อมูลหลัก
 * - รถ / ประเภทรถ: เที่ยวของ DO (`trip.vehicle_id` + ทะเบียน/ประเภท snapshot ณ วันจ่ายงาน; รถร่วมที่ไม่มีในทะเบียน = ทะเบียน snapshot)
 * - บรรทัดที่ไม่ผูก DO (เพิ่มเองในร่าง) หรือ DO ที่ไม่มีเที่ยว/รถ → แถว "ไม่ระบุ" (id `none`) — ยอดรวมทุกมิติเท่ากันเสมอ
 */
function groupSql(g: RevenueGroupBy): Prisma.Sql {
  switch (g) {
    case 'customer':
      return Prisma.sql`
        SELECT l.customer_id::text AS k,
               (array_agg(l.customer_snapshot->>'name' ORDER BY l.issued_at DESC, l.invoice_id))[1] AS label,
               COALESCE((array_agg(l.customer_snapshot->>'code' ORDER BY l.issued_at DESC, l.invoice_id))[1], max(c.code)) AS detail,
               ${AGG}
          FROM l JOIN customer c ON c.id = l.customer_id
         GROUP BY l.customer_id`;
    case 'legalEntity':
      return Prisma.sql`
        SELECT l.issuing_company_id::text AS k,
               COALESCE((array_agg(l.issuer_snapshot->>'name' ORDER BY l.issued_at DESC, l.invoice_id))[1], max(co.legal_name)) AS label,
               COALESCE((array_agg(l.issuer_snapshot->>'taxId' ORDER BY l.issued_at DESC, l.invoice_id))[1], max(co.tax_id)) AS detail,
               ${AGG}
          FROM l JOIN company co ON co.id = l.issuing_company_id
         GROUP BY l.issuing_company_id`;
    case 'month':
      return Prisma.sql`
        SELECT to_char(l.issue_date, 'YYYY-MM') AS k, to_char(l.issue_date, 'YYYY-MM') AS label, NULL::text AS detail, ${AGG}
          FROM l GROUP BY 1`;
    case 'route':
      return Prisma.sql`
        SELECT CASE WHEN d.id IS NULL THEN NULL ELSE d.origin_site_id::text || '>' || d.dest_site_id::text END AS k,
               max(o.name) || ' – ' || max(ds.name) AS label, NULL::text AS detail,
               max(o.name) AS o_name, max(ds.name) AS d_name, ${AGG}
          FROM l
          LEFT JOIN delivery_order d ON d.id = l.delivery_order_id
          LEFT JOIN customer_site o ON o.id = d.origin_site_id
          LEFT JOIN customer_site ds ON ds.id = d.dest_site_id
         GROUP BY 1`;
    case 'vehicle':
      return Prisma.sql`
        SELECT x.k, COALESCE(max(x.plate), max(v.plate)) AS label,
               COALESCE(max(x.vtype), max(vt.name_th)) AS detail,
               count(DISTINCT x.invoice_id) AS invoices, count(DISTINCT x.delivery_order_id) AS dos,
               count(*) AS lines, sum(x.amount) AS amount
          FROM (
            SELECT l.*, t.vehicle_id, t.vehicle_plate_snapshot AS plate, t.vehicle_type_snapshot AS vtype,
                   CASE WHEN t.vehicle_id IS NOT NULL THEN t.vehicle_id::text
                        WHEN NULLIF(t.vehicle_plate_snapshot, '') IS NOT NULL THEN 'plate:' || t.vehicle_plate_snapshot
                   END AS k
              FROM l
              LEFT JOIN delivery_order d ON d.id = l.delivery_order_id
              LEFT JOIN trip t ON t.id = d.trip_id
          ) x
          LEFT JOIN vehicle v ON v.id = x.vehicle_id
          LEFT JOIN vehicle_type vt ON vt.id = v.vehicle_type_id
         GROUP BY x.k`;
    case 'vehicleType':
      return Prisma.sql`
        SELECT x.k, COALESCE(max(x.vtype), max(vt.name_th)) AS label, max(vt.code) AS detail,
               count(DISTINCT x.invoice_id) AS invoices, count(DISTINCT x.delivery_order_id) AS dos,
               count(*) AS lines, sum(x.amount) AS amount
          FROM (
            SELECT l.*, t.vehicle_type_id, t.vehicle_type_snapshot AS vtype,
                   CASE WHEN t.vehicle_type_id IS NOT NULL THEN t.vehicle_type_id::text
                        WHEN NULLIF(t.vehicle_type_snapshot, '') IS NOT NULL THEN 'name:' || t.vehicle_type_snapshot
                   END AS k
              FROM l
              LEFT JOIN delivery_order d ON d.id = l.delivery_order_id
              LEFT JOIN trip t ON t.id = d.trip_id
          ) x
          LEFT JOIN vehicle_type vt ON vt.id = x.vehicle_type_id
         GROUP BY x.k`;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** คีย์ภายใน (uuid/ข้อความ) → id ที่ API แสดง */
function rowId(g: RevenueGroupBy, k: string | null): string {
  if (k === null) return 'none';
  const enc = (kind: Parameters<typeof encodeId>[0], v: string) =>
    UUID.test(v) ? encodeId(kind, v) : v;
  switch (g) {
    case 'customer':
      return enc('customer', k);
    case 'legalEntity':
      return enc('company', k);
    case 'vehicle':
      return enc('vehicle', k);
    case 'vehicleType':
      return enc('vehicleType', k);
    case 'route': {
      const [o, d] = k.split('>');
      return `${enc('site', o!)}>${enc('site', d!)}`;
    }
    default:
      return k;
  }
}

/**
 * รายงานรายได้ (ST9-T05; docs/04 H "รายได้ — ต่อลูกค้า / เส้นทาง / รถ / ประเภทรถ / นิติบุคคล / เดือน — จาก invoice line finalized"; ย่อ D-54:
 * ไม่มีส่วนเอกสารภาษี) — อ่านอย่างเดียว · RLS ของ tenant (sandbox เห็นเฉพาะข้อมูลของตน) · เงินเป็น Decimal จากฐาน (ไม่ใช้ float)
 * ใช้ร่วม: `GET /v1/reports/revenue`, งานส่งออก (`POST /v1/exports` resource `revenue` — xlsx/csv/pdf)
 */
@Injectable()
export class RevenueReportService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
  ) {}

  filter(q: RevenueReportQuery): Filter {
    const asOf = bangkokToday(this.clock.now());
    const toMonth = q.toMonth ?? asOf.slice(0, 7);
    const fromMonth = q.fromMonth ?? toMonth;
    const span = monthSpan(fromMonth, toMonth);
    if (span < 1 || span > REVENUE_MAX_MONTHS)
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'fromMonth',
          code: 'invalid_range',
          message: `fromMonth must be on or before toMonth and the range at most ${REVENUE_MAX_MONTHS} months`,
        },
      ]);
    return {
      groupBy: q.groupBy ?? 'customer',
      fromMonth,
      toMonth,
      from: monthRange(fromMonth).from,
      to: monthRange(toMonth).to,
      asOf,
    };
  }

  /** แถวต่อมิติ — ผู้มีสิทธิ์ราคาขายเรียงรายได้มากไปน้อย · ไม่มีสิทธิ์เรียงจำนวนบรรทัด (ไม่เผยลำดับยอดเงิน) · เดือน = เรียงตามเวลา */
  async rows(tx: Tx, f: Filter, sell: boolean): Promise<RevenueRowDto[]> {
    const order =
      f.groupBy === 'month'
        ? Prisma.sql`g.k`
        : sell
          ? Prisma.sql`g.amount DESC NULLS LAST, g.k IS NULL, g.label, g.k`
          : Prisma.sql`g.lines DESC, g.k IS NULL, g.label, g.k`;
    const rs = await tx.$queryRaw<GroupRow[]>`
      WITH ${linesCte(f)}, g AS (${groupSql(f.groupBy)})
      SELECT * FROM g ORDER BY ${order}`;
    return rs.map((r) => ({
      id: rowId(f.groupBy, r.k),
      label: r.k === null ? null : r.label,
      detail: r.k === null ? null : r.detail,
      ...(f.groupBy === 'route'
        ? {
            originName: r.k === null ? null : (r.o_name ?? null),
            destinationName: r.k === null ? null : (r.d_name ?? null),
          }
        : {}),
      invoiceCount: Number(r.invoices),
      deliveryOrderCount: Number(r.dos),
      lineCount: Number(r.lines),
      sellAmount: money(r.amount),
    }));
  }

  async totals(tx: Tx, f: Filter) {
    const [r] = await tx.$queryRaw<
      { invoices: bigint; dos: bigint; lines: bigint; amount: Prisma.Decimal | null }[]
    >`WITH ${linesCte(f)} SELECT ${AGG} FROM l`;
    return {
      invoiceCount: Number(r?.invoices ?? 0),
      deliveryOrderCount: Number(r?.dos ?? 0),
      lineCount: Number(r?.lines ?? 0),
      sellAmount: money(r?.amount ?? 0),
    };
  }

  private canSell(): boolean {
    return scopeAllows(requestContext.require().scopes ?? [], 'prices.sell:read');
  }

  async report(q: RevenueReportQuery): Promise<RevenueReportDto> {
    const tx = this.db.tx;
    const f = this.filter(q);
    const data = await this.rows(tx, f, this.canSell());
    const tot = await this.totals(tx, f);
    return {
      groupBy: f.groupBy,
      fromMonth: f.fromMonth,
      toMonth: f.toMonth,
      from: f.from,
      to: f.to,
      asOf: f.asOf,
      ...tot,
      data,
    };
  }

  /**
   * งานส่งออก — รายงานเป็นแถวสรุป (จำนวนแถว = จำนวนกลุ่ม) อ่านครั้งเดียว (`ExportSpec.single`)
   * แถวท้าย "รวม" (id `total`) = ยอดรวมทั้งช่วง
   */
  async exportRows(q: RevenueReportQuery): Promise<RevenueRowDto[]> {
    const tx = this.db.tx;
    const f = this.filter(q);
    const rows = await this.rows(tx, f, this.canSell());
    const tot = await this.totals(tx, f);
    return [
      ...rows,
      {
        id: 'total',
        label: null,
        detail: null,
        ...tot,
      },
    ];
  }
}
