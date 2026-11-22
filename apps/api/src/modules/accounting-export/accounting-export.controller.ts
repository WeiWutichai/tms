import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireScope } from '../../common/decorators';
import { ApiProblems } from '../../common/problem.dto';
import { requestContext } from '../../common/request-context';
import { T403, T422 } from '../trips/trip-problems';
import { AccountingExportQuery, AccountingExportSummaryDto } from './accounting-export.dto';
import { AccountingExportService } from './accounting-export.service';
import { ACCOUNTING_EXPORT_RESOURCE } from './accounting-export.specs';
import { FileExportAdapterRegistry } from './file-export-adapter';

/**
 * ส่งออกให้นักบัญชี (ST7-T23; docs/04 G4 "CSV generic", docs/01 §6.1 `FileExportAdapter`, spec/07 §4)
 * ตัวไฟล์สร้างด้วยงานส่งออก (`POST /v1/exports` resource `accounting-*`) — ที่นี่ให้จำนวนเอกสาร/แถวก่อนสั่ง (dialog ต้นแบบ)
 */
@ApiTags('exports')
@ApiBearerAuth()
@Controller('accounting-exports')
export class AccountingExportController {
  constructor(
    private readonly svc: AccountingExportService,
    private readonly adapters: FileExportAdapterRegistry,
  ) {}

  @Get('summary')
  @RequireScope('export:run')
  @ApiOperation({
    summary: 'จำนวนเอกสาร/แถวของแต่ละชุดก่อนส่งออกให้นักบัญชี',
    description:
      'ชุดข้อมูล (บัญชีเบา D-54 — เอกสารที่ TMS มีในเฟส 0): **sales** ใบแจ้งหนี้ที่ออกแล้วและไม่ถูกยกเลิก ' +
      '(ISSUED / PARTIALLY_PAID / PAID / ADJUSTED — ชุดเดียวกับรายงานรายได้) ตามวันที่ออก · **receipts** การรับชำระที่ยังไม่กลับรายการ ' +
      'ตามวันที่รับ · **settlements** ใบสำคัญจ่ายรถร่วม PAID ตามวันที่จ่าย — แสดงเฉพาะชุดที่มีสิทธิ์อ่าน · ' +
      'ไฟล์: `POST /v1/exports` `{resource, format: csv|xlsx, filter: {dateFrom, dateTo, template?}}` → แถวเอกสาร 1 แถว + แถวรายการ ' +
      '(ยอดรวมอยู่เฉพาะแถวเอกสาร · CSV = UTF-8 BOM + CRLF เปิดใน Excel อ่านไทยได้)',
  })
  @ApiProblems(T403('export:run'), T422)
  @ApiOkResponse({ type: AccountingExportSummaryDto })
  async summary(@Query() q: AccountingExportQuery): Promise<AccountingExportSummaryDto> {
    const scopes = requestContext.require().scopes ?? [];
    const sets = await this.svc.summary(q, scopes);
    return {
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
      datasets: sets.map((s) => ({ ...s, resource: ACCOUNTING_EXPORT_RESOURCE[s.dataset] })),
      templates: this.adapters.list().map((a) => ({
        key: a.key,
        displayName: a.displayName,
        isDefault: !!a.isDefault,
        datasets: [...a.datasets],
      })),
    };
  }
}
