import { Controller, Get, Query } from '@nestjs/common';
import { scopeAllows } from '@tms/domain';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireFeature, RequireScope } from '../../common/decorators';
import { ApiProblems } from '../../common/problem.dto';
import type { ExportSpec } from '../exports/export-spec';
import { T403, T422 } from '../trips/trip-problems';
import { AgingService } from '../payments/aging.service';
import { AgingQuery } from '../payments/payment.dto';
import {
  UnbilledReportDto,
  UnbilledReportQuery,
  type UnbilledDeliveryOrderDto,
} from './unbilled-report.dto';
import { UnbilledReportService } from './unbilled-report.service';
import { RevenueReportDto, RevenueReportQuery, type RevenueRowDto } from './revenue-report.dto';
import { RevenueReportService } from './revenue-report.service';
import {
  type AgingExportRow,
  agingExportColumns,
  agingPdfSubtitle,
  agingPdfTitle,
  unbilledExportColumns,
  unbilledPdfSubtitle,
  unbilledPdfTitle,
} from './receivable-export';
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
      '· D-71: `includeStaleDrafts=true` รวม DO ที่อยู่ในร่างใบแจ้งหนี้นานเกิน N วัน (วันนี้ − วันแรกที่ DO เข้าร่างใดก็ได้ > N — ย้ายร่าง/ถอดแล้วใส่ใหม่ไม่เริ่มนับใหม่) พร้อม `draftInvoice` (id ร่าง + อายุ) ' +
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

const canSell = (scopes: readonly string[]) => scopeAllows(scopes, 'prices.sell:read');

/**
 * ส่งออก "DO ยังไม่วางบิลเกิน N วัน" (ST9-T06 — งานเบื้องหลัง ST9-T10) — ตัวกรอง/การอ่านชุดเดียวกับรายงาน · มูลค่าเฉพาะผู้มี `prices.sell:read`
 * xlsx / csv / pdf (D-81 · D68-99 docs/04 H — PDF ทาง API เหมือนรายงานรายได้; ต้นแบบหน้ารายงานมีปุ่ม "ส่งออก Excel" ปุ่มเดียว)
 */
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
  pdf: { title: () => unbilledPdfTitle(), subtitle: (q) => unbilledPdfSubtitle(q.minDays) },
  columns: (scopes, q) => unbilledExportColumns(canSell(scopes), q.includeStaleDrafts === 'true'),
});

/**
 * ส่งออก "ลูกหนี้คงค้าง" ต่อลูกค้า × ช่วงอายุ (ST9-T06) — อ่านจาก `AgingService` ตัวเดียวกับ `GET /payments/aging` (ยอดตรงกับ ST5-T22)
 * xlsx / csv / pdf (D-81 · D68-99)
 */
export const agingExportSpec = (svc: AgingService): ExportSpec<AgingQuery, AgingExportRow> => ({
  resource: 'receivables-aging',
  label: 'ลูกหนี้คงค้าง',
  fileBase: 'receivables-aging',
  scope: 'invoices:read',
  idKind: 'customer',
  query: AgingQuery,
  fetch: async (q, page) =>
    (await svc.customerPage(q, page)).map((c) => ({ ...c, id: c.customer.id })),
  pdf: { title: () => agingPdfTitle(), subtitle: () => agingPdfSubtitle() },
  columns: (scopes) => agingExportColumns(canSell(scopes)),
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
