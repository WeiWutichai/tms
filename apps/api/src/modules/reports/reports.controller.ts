import { Controller, Get, Query } from '@nestjs/common';
import { AGING_BUCKETS, scopeAllows } from '@tms/domain';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireFeature, RequireScope } from '../../common/decorators';
import { ApiProblems } from '../../common/problem.dto';
import type { ExportColumn } from '../master/export';
import type { ExportSpec } from '../exports/export-spec';
import { T403, T422 } from '../trips/trip-problems';
import { AgingService } from '../payments/aging.service';
import { AgingQuery, type AgingCustomerDto } from '../payments/payment.dto';
import {
  UnbilledReportDto,
  UnbilledReportQuery,
  type UnbilledDeliveryOrderDto,
} from './unbilled-report.dto';
import { UnbilledReportService } from './unbilled-report.service';
import { RevenueReportDto, RevenueReportQuery, type RevenueRowDto } from './revenue-report.dto';
import { RevenueReportService } from './revenue-report.service';
import {
  revenueExportColumns,
  revenuePdfSubtitle,
  revenuePdfTitle,
  revenuePeriodText,
} from './revenue-export';

/**
 * รายงาน (ST9-T06; docs/04 H "DO ยังไม่วางบิลเกิน N วัน", "ค้างชำระ / aging ต่อลูกค้า")
 * อายุลูกหนี้ต่อลูกค้าใช้ `GET /v1/payments/aging` (ST5-T22) ตัวเดียวกับหน้ารับชำระ — ไม่มี endpoint ซ้ำ
 */
@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly unbilled: UnbilledReportService,
    private readonly revenue: RevenueReportService,
  ) {}

  @Get('revenue')
  @RequireFeature('report')
  @RequireScope('reports.finance:read')
  @ApiOperation({
    summary: 'รายงานรายได้ (ST9-T05)',
    description:
      'รายได้จาก**บรรทัดใบแจ้งหนี้ที่ออกเลขแล้ว** (ISSUED / PARTIALLY_PAID / PAID / ADJUSTED — ไม่รวมร่างและใบที่ยกเลิก/void) ' +
      'ตามวันที่ออกใบ (เวลาไทย) ในช่วง `fromMonth`–`toMonth` จัดกลุ่มตาม `groupBy` (ลูกค้า / เส้นทาง / รถ / ประเภทรถ / นิติบุคคล / เดือน) · ' +
      'รายได้ = Σ ยอดบรรทัดหลังส่วนลด **ก่อน VAT** (ไม่มีส่วนเอกสารภาษี — D-54) · Σ แถว = `sellAmount` รวม ทุกมิติ · ' +
      'บรรทัดที่ไม่ผูก DO / DO ที่ไม่มีเที่ยวหรือรถ อยู่แถว "ไม่ระบุ" (`id: none`) · `sell*` เห็นเมื่อมี `prices.sell:read` (ไม่มี = เห็นจำนวน) · ' +
      'ส่งออก: `POST /v1/exports` resource `revenue` (xlsx / csv / pdf) · แพ็กเกจต้องมีโมดูลรายงาน (`report`)',
  })
  @ApiProblems(T403('reports.finance:read'), T422)
  @ApiOkResponse({ type: RevenueReportDto })
  revenueReport(@Query() q: RevenueReportQuery): Promise<RevenueReportDto> {
    return this.revenue.report(q);
  }

  @Get('unbilled-delivery-orders')
  @RequireScope('reports.finance:read')
  @ApiOperation({
    summary: 'DO ยังไม่วางบิลเกิน N วัน (ST9-T06)',
    description:
      'DO ที่ส่งถึงแล้ว (DELIVERED / POD_PENDING / UNBILLED) และ**ยังไม่อยู่ในใบแจ้งหนี้ใด** (`billingStatus` UNBILLED / CREDITED — ' +
      'นิยามเดียวกับคิวพร้อมวางบิลและการกันวางบิลซ้ำ ST5-T05; ใบที่ยกเลิกคืน DO กลับมาในรายงาน; DO ในร่างใบแจ้งหนี้ไม่ขึ้น) ' +
      '· D-71: `includeStaleDrafts=true` รวม DO ที่อยู่ในร่างใบแจ้งหนี้นานเกิน N วัน (วันนี้ − วันที่เข้าร่าง > N) พร้อม `draftInvoice` (id ร่าง + อายุ) ' +
      'ที่ **วันนี้ − วันที่ส่งถึง > N** (เวลาไทย) · วันที่ส่งถึง = เวลาบันทึกสถานะส่งถึงครั้งล่าสุด (ไม่มีประวัติ = วันที่ DO) · ' +
      'N = `minDays` หรือค่าตั้งองค์กร `billing.unbilledAlertDays` (ค่าเริ่ม 7) · เรียงส่งถึงเก่าสุดก่อน cursor (วันที่ส่งถึง, id) · ' +
      'มูลค่า = Σ บรรทัดรายได้ที่ยังใช้ (ก่อน VAT) — `sell*` เห็นเมื่อมี `prices.sell:read` · ส่งออก: `POST /v1/exports` resource `unbilled-delivery-orders`',
  })
  @ApiProblems(T403('reports.finance:read'), T422)
  @ApiOkResponse({ type: UnbilledReportDto })
  unbilledDeliveryOrders(@Query() q: UnbilledReportQuery): Promise<UnbilledReportDto> {
    return this.unbilled.report(q);
  }
}

const money = (s: string | undefined) => (s === undefined ? null : Number(s));
const canSell = (scopes: readonly string[]) => scopeAllows(scopes, 'prices.sell:read');

/** ชื่อช่วงอายุ (ตรงกับหน้ารับชำระ/ต้นแบบ agingB) */
const BUCKET_TH: Record<(typeof AGING_BUCKETS)[number], string> = {
  NOT_DUE: 'ยังไม่ครบกำหนด',
  DAYS_1_30: '1–30 วัน',
  DAYS_31_60: '31–60 วัน',
  DAYS_61_90: '61–90 วัน',
  DAYS_OVER_90: 'เกิน 90 วัน',
};
const DO_STATUS_TH: Record<string, string> = {
  DELIVERED: 'ส่งสำเร็จ',
  POD_PENDING: 'รอ POD',
  UNBILLED: 'รอวางบิล',
};

/** ส่งออก "DO ยังไม่วางบิลเกิน N วัน" (ST9-T06 — งานเบื้องหลัง ST9-T10) — ตัวกรอง/การอ่านชุดเดียวกับรายงาน · มูลค่าเฉพาะผู้มี `prices.sell:read` */
export const unbilledExportSpec = (
  svc: UnbilledReportService,
): ExportSpec<UnbilledReportQuery, UnbilledDeliveryOrderDto> => ({
  resource: 'unbilled-delivery-orders',
  label: 'DO ยังไม่วางบิล',
  fileBase: 'unbilled-delivery-orders',
  scope: 'reports.finance:read',
  idKind: 'deliveryOrder',
  query: UnbilledReportQuery,
  fetch: (q, page) => svc.exportRows(q, page),
  columns: (scopes) => {
    const cols: ExportColumn<UnbilledDeliveryOrderDto>[] = [
      { header: 'เลขที่ DO', value: (r) => r.doNo },
      { header: 'วันที่ DO', value: (r) => r.doDate },
      { header: 'รหัสลูกค้า', value: (r) => r.customer.code },
      { header: 'ลูกค้า', value: (r) => r.customer.legalName },
      { header: 'เลขที่ใบสั่ง', value: (r) => r.salesOrder.soNo },
      { header: 'สถานะ', value: (r) => DO_STATUS_TH[r.status] ?? r.status },
      { header: 'ส่งถึง', value: (r) => r.deliveredOn },
      { header: 'ค้างวางบิล (วัน)', value: (r) => r.daysSinceDelivery },
      // D-71 ธง "ร่างค้างเกิน N วัน" (มีค่าเมื่อสั่งด้วย includeStaleDrafts=true) — ร่างยังไม่มีเลขที่ จึงใช้ id ใบแจ้งหนี้
      { header: 'ใบแจ้งหนี้ร่าง', value: (r) => r.draftInvoice?.id ?? null },
      { header: 'อยู่ในร่าง (วัน)', value: (r) => r.draftInvoice?.ageDays ?? null },
    ];
    if (canSell(scopes))
      cols.push({ header: 'มูลค่า (ก่อน VAT)', value: (r) => money(r.sellAmount) });
    return cols;
  },
});

type AgingExportRow = AgingCustomerDto & { id: string };

/** ส่งออก "ลูกหนี้คงค้าง" ต่อลูกค้า × ช่วงอายุ (ST9-T06) — อ่านจาก `AgingService` ตัวเดียวกับ `GET /payments/aging` (ยอดตรงกับ ST5-T22) */
export const agingExportSpec = (svc: AgingService): ExportSpec<AgingQuery, AgingExportRow> => ({
  resource: 'receivables-aging',
  label: 'ลูกหนี้คงค้าง',
  fileBase: 'receivables-aging',
  scope: 'invoices:read',
  idKind: 'customer',
  query: AgingQuery,
  fetch: async (q, page) =>
    (await svc.customerPage(q, page)).map((c) => ({ ...c, id: c.customer.id })),
  columns: (scopes) => {
    const sell = canSell(scopes);
    const cols: ExportColumn<AgingExportRow>[] = [
      { header: 'รหัสลูกค้า', value: (r) => r.customer.code },
      { header: 'ลูกค้า', value: (r) => r.customer.legalName },
      { header: 'ใบค้างรับ', value: (r) => r.count },
    ];
    AGING_BUCKETS.forEach((b, i) =>
      cols.push(
        sell
          ? { header: BUCKET_TH[b], value: (r) => money(r.buckets[i]?.sellOutstanding) }
          : { header: `${BUCKET_TH[b]} (ใบ)`, value: (r) => r.buckets[i]?.count ?? 0 },
      ),
    );
    if (sell) cols.push({ header: 'รวม', value: (r) => money(r.sellOutstanding) });
    return cols;
  },
});

/** ช่วงเดือนที่ใช้จริง (ค่าเริ่ม = เดือนปัจจุบัน — ตรงกับ service) */
const revenuePeriod = (svc: RevenueReportService, q: RevenueReportQuery) => {
  const f = svc.filter(q);
  return revenuePeriodText(f.fromMonth, f.toMonth);
};

/**
 * ส่งออก "รายงานรายได้" (ST9-T05) — xlsx / csv / pdf · อ่านจาก `RevenueReportService` ตัวเดียวกับ `GET /v1/reports/revenue`
 * (แถวสรุป อ่านครั้งเดียว + แถวท้าย "รวม") · คอลัมน์รายได้เฉพาะผู้มี `prices.sell:read`
 */
export const revenueExportSpec = (
  svc: RevenueReportService,
): ExportSpec<RevenueReportQuery, RevenueRowDto> => ({
  resource: 'revenue',
  label: 'รายงานรายได้',
  fileBase: 'revenue',
  scope: 'reports.finance:read',
  feature: 'report',
  idKind: 'customer',
  single: true,
  query: RevenueReportQuery,
  fetch: (q) => svc.exportRows(q),
  pdf: {
    title: (q) => revenuePdfTitle(q.groupBy ?? 'customer'),
    subtitle: (q) => revenuePdfSubtitle(revenuePeriod(svc, q)),
  },
  columns: (scopes, q) => revenueExportColumns(q.groupBy ?? 'customer', canSell(scopes)),
});
