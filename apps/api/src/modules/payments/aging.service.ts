import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AGING_BUCKETS, type AgingBucket } from '@tms/domain';
import { Clock } from '../../common/clock';
import { EXT_PREFIX, EXTERNAL_ID_RE } from '../../common/external-id';
import { encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { DbService, type Tx } from '../../db/db.service';
import { bangkokToday } from '../vehicle-documents/expiry';
import type { ExportPage } from '../master/export';
import type { AgingBucketDto, AgingCustomerDto, AgingQuery, AgingReportDto } from './payment.dto';

const NONE = '00000000-0000-0000-0000-000000000000';
const money = (d: Prisma.Decimal | string | number) => new Prisma.Decimal(d).toFixed(2);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_KIND = 'aging';

/** คอลัมน์ต่อช่วง: c_<i> = จำนวนใบ, a_<i> = ยอดค้าง (ลำดับตาม AGING_BUCKETS) */
type AggRow = Record<string, bigint | Prisma.Decimal | string | null>;

/**
 * daysPastDue (asOf − due_date) ของใบในช่วงอายุ — ตรงกับ `agingBucketOf` (@tms/domain) · ไม่มีวันครบกำหนด = ยังไม่ครบกำหนด
 * ใช้ร่วมกับตัวกรอง `aging` ของ `GET /invoices` (ST5-T22) — ยอดในการ์ดกับตารางที่กรองตรงกัน
 */
export function agingSqlCondition(bucket: AgingBucket, asOf: string): Prisma.Sql {
  const d = Prisma.sql`(${asOf}::date - due_date)`;
  switch (bucket) {
    case 'NOT_DUE':
      return Prisma.sql`(due_date IS NULL OR ${d} <= 0)`;
    case 'DAYS_1_30':
      return Prisma.sql`(${d} BETWEEN 1 AND 30)`;
    case 'DAYS_31_60':
      return Prisma.sql`(${d} BETWEEN 31 AND 60)`;
    case 'DAYS_61_90':
      return Prisma.sql`(${d} BETWEEN 61 AND 90)`;
    case 'DAYS_OVER_90':
      return Prisma.sql`(${d} > 90)`;
  }
}

/** ใบที่นับในอายุลูกหนี้ = ค้างรับ (ISSUED / PARTIALLY_PAID) ที่ยังมียอดค้าง — ชุดเดียวกับ "ยอดค้างรับ" ของ `GET /payments/summary` */
const OPEN = Prisma.sql`status IN ('ISSUED', 'PARTIALLY_PAID') AND paid_amount < total_amount`;

function aggColumns(asOf: string): Prisma.Sql {
  return Prisma.join(
    AGING_BUCKETS.flatMap((b, i) => {
      const cond = agingSqlCondition(b, asOf);
      return [
        Prisma.sql`COUNT(*) FILTER (WHERE ${cond}) AS ${Prisma.raw(`c_${i}`)}`,
        Prisma.sql`COALESCE(SUM(total_amount - paid_amount) FILTER (WHERE ${cond}), 0) AS ${Prisma.raw(`a_${i}`)}`,
      ];
    }),
    ', ',
  );
}

function buckets(r: AggRow): AgingBucketDto[] {
  return AGING_BUCKETS.map((bucket, i) => ({
    bucket,
    count: Number(r[`c_${i}`] ?? 0),
    sellOutstanding: money((r[`a_${i}`] as Prisma.Decimal | null) ?? 0),
  }));
}

/**
 * cursor = id ลูกค้าแถวสุดท้ายเท่านั้น (สั้นคงที่ — ไม่ใส่ชื่อ: ชื่อไทยยาวทำให้เกิน MaxLength) · ชื่อสำหรับเรียง (legal_name, id) อ่านจากฐานตอนเดินหน้าถัดไป
 * (review M1) — เปลี่ยนชื่อลูกค้าระหว่างเดิน = ลำดับตามชื่อใหม่ (เหมือน cursor ทั่วไปเมื่อแถวถูกแก้)
 */
function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ i: id, s: CURSOR_KIND })).toString('base64url');
}

function decodeCursor(raw: string): string {
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      i?: unknown;
      s?: unknown;
    };
    if (v.s !== CURSOR_KIND || typeof v.i !== 'string' || !UUID.test(v.i)) throw new Error();
    return v.i;
  } catch {
    throw new ProblemException('validation_failed', undefined, [
      { field: 'cursor', code: 'invalid_cursor', message: 'cursor is invalid' },
    ]);
  }
}

/**
 * อายุลูกหนี้แบบง่าย (ST5-T22 — D-54; docs/04 F5 "Aging 0–30 / 31–60 / 61–90 / > 90 ต่อลูกค้า"; spec/05 §10 BIL-120; spec/09 §3 RPT-032)
 *
 * - ใบค้างรับ (ISSUED / PARTIALLY_PAID ที่ยอดตัด < ยอดรวม) · ยอดค้าง = `total_amount − paid_amount` (ตัวเดียวกับ `applyInvoicePayments`)
 * - ช่วงอายุจาก `daysPastDue = asOf − dueDate` (เวลาไทย) — ยังไม่ครบกำหนด · 1–30 · 31–60 · 61–90 · เกิน 90 (ต้นแบบ agingB)
 * - ผลรวมทุกช่วง = ยอดค้างรับรวม (`GET /payments/summary` `sellOutstanding`) — test เทียบ (เกณฑ์ตรวจรับ)
 * - asOf = วันนี้เท่านั้น · ย้อนหลัง (RPT-030) / snapshot สิ้นเดือน (RPT-031) / นับจากวันที่เอกสาร = ST9-T06 [DECISION spec/12 §3]
 * - ไม่มีใบลดหนี้/เพิ่มหนี้/เงินรับล่วงหน้าใน TMS (D-54) — BIL-120 เหลือ ยอดใบ − ยอดตัด
 */
@Injectable()
export class AgingService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
  ) {}

  async report(q: AgingQuery): Promise<AgingReportDto> {
    const tx = this.db.tx;
    const asOf = bangkokToday(this.clock.now());
    const limit = q.limit ?? 50;
    const cust =
      q.customerId !== undefined
        ? Prisma.sql`AND customer_id = ${(await this.customerRef(tx, q.customerId)) ?? NONE}::uuid`
        : Prisma.empty;
    const cols = aggColumns(asOf);

    const tot = await tx.$queryRaw<AggRow[]>`
      SELECT COUNT(*) AS n, COALESCE(SUM(total_amount - paid_amount), 0) AS amt, ${cols}
        FROM invoice WHERE ${OPEN} ${cust}`;
    const t = tot[0]!;

    const after = q.cursor
      ? (() => {
          const id = decodeCursor(q.cursor);
          return Prisma.sql`AND (c.legal_name, c.id) > ((SELECT legal_name FROM customer WHERE id = ${id}::uuid), ${id}::uuid)`;
        })()
      : Prisma.empty;
    const rows = await tx.$queryRaw<
      (AggRow & {
        customer_id: string;
        code: string;
        legal_name: string;
        tax_id: string | null;
        branch_code: string | null;
        n: bigint;
        amt: Prisma.Decimal;
      })[]
    >`
      WITH agg AS (
        SELECT customer_id, COUNT(*) AS n, SUM(total_amount - paid_amount) AS amt, ${cols}
          FROM invoice WHERE ${OPEN} ${cust}
         GROUP BY customer_id
      )
      SELECT agg.*, c.code, c.legal_name, c.tax_id, c.branch_code
        FROM agg JOIN customer c ON c.id = agg.customer_id
       WHERE TRUE ${after}
       ORDER BY c.legal_name, c.id
       LIMIT ${limit + 1}`;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      asOf,
      basis: 'DUE_DATE',
      count: Number(t.n),
      sellOutstanding: money(t.amt as Prisma.Decimal),
      buckets: buckets(t),
      data: page.map((r) => ({
        customer: {
          id: encodeId('customer', r.customer_id),
          code: r.code,
          legalName: r.legal_name,
          taxId: r.tax_id,
          branchCode: r.branch_code,
        },
        count: Number(r.n),
        sellOutstanding: money(r.amt),
        buckets: buckets(r),
      })),
      nextCursor: hasMore && last ? encodeCursor(last.customer_id) : null,
      hasMore,
    };
  }

  /** งานส่งออก "ลูกหนี้คงค้าง" (ST9-T06) — หน้าถัดไปต่อจาก id ลูกค้า (uuid) ด้วย cursor ตัวเดียวกับ API */
  async customerPage(q: AgingQuery, page: ExportPage): Promise<AgingCustomerDto[]> {
    const r = await this.report({
      ...(q.customerId !== undefined ? { customerId: q.customerId } : {}),
      limit: page.take,
      ...(page.after ? { cursor: encodeCursor(page.after) } : {}),
    });
    return r.data;
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
