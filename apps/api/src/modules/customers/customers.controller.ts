import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuditPageDto } from '../../audit/audit.controller';
import { RequireScope, TenantResource } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404 } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { sendExport, type ExportColumn } from '../master/export';
import { entityHistory, HistoryQuery } from '../master/history';
import { MasterOptionalReasonDto, MasterReasonDto } from '../master/master-kit';
import {
  CreateCustomerDto,
  CustomerDto,
  CustomerExportQuery,
  CustomerListQuery,
  CustomerPageDto,
  CustomerSummaryDto,
  NextCodeDto,
  UpdateCustomerDto,
  UpsertCustomerDto,
} from './customer.dto';
import { CustomersService } from './customers.service';
import { DbService } from '../../db/db.service';

const CYCLE_TH: Record<CustomerDto['billingCycle'], string> = {
  PER_DO: 'ต่อเที่ยว',
  WEEKLY: 'รายสัปดาห์',
  MONTHLY: 'รายเดือน',
  MANUAL: 'กำหนดเอง',
};

/** คอลัมน์ไฟล์ส่งออก — หัวคอลัมน์ไทยตรงกับ template นำเข้า (ST2-T23) */
const EXPORT_COLUMNS: ExportColumn<CustomerDto>[] = [
  { header: 'รหัส', value: (r) => r.code },
  { header: 'ชื่อ', value: (r) => r.legalName },
  { header: 'เลขผู้เสียภาษี', value: (r) => r.taxId },
  { header: 'รหัสสาขา', value: (r) => r.branchCode },
  { header: 'ที่อยู่ออกใบกำกับ', value: (r) => r.billingAddress?.line1 },
  { header: 'ผู้ติดต่อ', value: (r) => r.contacts[0]?.name },
  { header: 'เบอร์โทร', value: (r) => r.contacts[0]?.phone },
  { header: 'เครดิต (วัน)', value: (r) => r.creditTermDays },
  { header: 'รอบวางบิล', value: (r) => CYCLE_TH[r.billingCycle] },
  {
    header: 'การออกใบกำกับภาษี',
    value: (r) => (r.taxInvoiceMode === 'ON_ISSUE' ? 'ออกพร้อมใบแจ้งหนี้' : 'ออกเมื่อรับชำระ'),
  },
  { header: 'จด VAT', value: (r) => (r.vatRegistered ? 'ใช่' : 'ไม่') },
  { header: 'รับ e-Tax', value: (r) => (r.etaxCapable ? 'ใช่' : 'ไม่') },
  { header: 'free time ค่ารอ (นาที)', value: (r) => r.freeTimeMin },
  { header: 'รหัสในระบบต้นทาง', value: (r) => r.externalId },
  { header: 'สถานะ', value: (r) => (r.status === 'active' ? 'ใช้งาน' : 'ปิดใช้') },
];

/**
 * ลูกค้า (ST2-T01; docs/01 §5.2 #6) — CRUD + `PUT /external/{id}` + export + ประวัติ
 * สิทธิ์: อ่าน `master:read` · แก้/ปิดใช้/ลบ `master:write` · ส่งออก `export:run` (docs/04 A3)
 */
@ApiTags('customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly db: DbService,
  ) {}

  private async resolve(id: string) {
    if (id.startsWith('ext:')) return this.customers.getByExternalId(id.slice(4));
    return this.customers.get(decodeIdOr404('customer', id));
  }

  @Get()
  @RequireScope('master:read')
  @ApiOkResponse({ type: CustomerPageDto })
  list(@Query() q: CustomerListQuery) {
    return this.customers.list(q);
  }

  @Get('summary')
  @RequireScope('master:read')
  @ApiOkResponse({ type: CustomerSummaryDto })
  summary(): Promise<CustomerSummaryDto> {
    return this.customers.summary();
  }

  @Get('next-code')
  @RequireScope('master:write')
  @ApiOkResponse({
    type: NextCodeDto,
    description: 'รหัสที่ระบบจะออกให้ลูกค้าใหม่ (ค่าเสนอ — MD-002)',
  })
  async nextCode(): Promise<NextCodeDto> {
    return { code: await this.customers.nextCode() };
  }

  @Get('export')
  @RequireScope('export:run')
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv')
  @ApiOkResponse({
    description: 'ไฟล์ .xlsx หรือ .csv ตามตัวกรองเดียวกับรายการ (สูงสุด 10,000 แถว)',
  })
  async export(
    @Query() q: CustomerExportQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const rows = await this.customers.exportRows(q);
    return sendExport(res, q.format ?? 'xlsx', 'customers', EXPORT_COLUMNS, rows);
  }

  @Post()
  @RequireScope('master:write')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: CustomerDto })
  async create(
    @Body() body: CreateCustomerDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CustomerDto> {
    const c = await this.customers.create(body);
    setEtag(res, c.version);
    return this.customers.dto(c);
  }

  @Put('external/:externalId')
  @RequireScope('master:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag — ใช้เมื่อแถวมีอยู่แล้ว' })
  @ApiOkResponse({
    type: CustomerDto,
    description: 'มีอยู่แล้ว → อัปเดต (ส่งซ้ำได้ ไม่เกิดแถวใหม่)',
  })
  @ApiCreatedResponse({ type: CustomerDto, description: 'ยังไม่มี → สร้าง' })
  async upsertExternal(
    @Param('externalId') externalId: string,
    @Body() body: UpsertCustomerDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CustomerDto> {
    if (!/^[\x21-\x7e]{1,100}$/.test(externalId))
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'externalId',
          code: 'matches',
          message: 'externalId must be 1-100 printable ASCII',
        },
      ]);
    const { row, created } = await this.customers.upsertExternal(
      externalId,
      body,
      expectedVersion(req),
    );
    res.status(created ? 201 : 200);
    setEtag(res, row.version);
    return this.customers.dto(row);
  }

  @Get(':id')
  @TenantResource('customer')
  @RequireScope('master:read')
  @ApiOkResponse({ type: CustomerDto })
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CustomerDto> {
    const c = await this.resolve(id);
    setEtag(res, c.version);
    return this.customers.dto(c);
  }

  @Get(':id/history')
  @TenantResource('customer')
  @RequireScope('master:read')
  @ApiOkResponse({ type: AuditPageDto, description: 'ประวัติการแก้จาก audit log ใหม่สุดก่อน' })
  async history(@Param('id') id: string, @Query() q: HistoryQuery): Promise<AuditPageDto> {
    const c = await this.resolve(id);
    return entityHistory(this.db.tx, 'customer', c.id, q);
  }

  @Patch(':id')
  @TenantResource('customer')
  @RequireScope('master:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: CustomerDto })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateCustomerDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CustomerDto> {
    const current = await this.resolve(id);
    const c = await this.customers.update(current.id, body, expectedVersion(req));
    setEtag(res, c.version);
    return this.customers.dto(c);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @TenantResource('customer')
  @RequireScope('master:write')
  @ApiOkResponse({ type: CustomerDto })
  async deactivate(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
  ): Promise<CustomerDto> {
    const current = await this.resolve(id);
    return this.customers.dto(
      await this.customers.changeStatus(
        current.id,
        'deactivate',
        body.reason,
        expectedVersion(req),
      ),
    );
  }

  @Post(':id/activate')
  @HttpCode(200)
  @TenantResource('customer')
  @RequireScope('master:write')
  @ApiOkResponse({ type: CustomerDto })
  async activate(
    @Param('id') id: string,
    @Body() body: MasterOptionalReasonDto,
    @Req() req: Request,
  ): Promise<CustomerDto> {
    const current = await this.resolve(id);
    return this.customers.dto(
      await this.customers.changeStatus(current.id, 'activate', body.reason, expectedVersion(req)),
    );
  }

  /** "ลบ" (MD-004) — เฉพาะลูกค้าที่ไม่เคยถูกอ้างอิง → soft delete; ถูกอ้างอิง → 409 `in_use` */
  @Post(':id/delete')
  @HttpCode(204)
  @TenantResource('customer')
  @RequireScope('master:write')
  @ApiNoContentResponse()
  async remove(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
  ): Promise<void> {
    const current = await this.resolve(id);
    await this.customers.remove(current.id, body.reason, expectedVersion(req));
  }
}
