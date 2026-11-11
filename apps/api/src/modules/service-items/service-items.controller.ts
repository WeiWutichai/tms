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
import { DbService } from '../../db/db.service';
import { NextCodeDto } from '../customers/customer.dto';
import { sendExport, type ExportColumn } from '../master/export';
import { entityHistory, HistoryQuery } from '../master/history';
import { MasterOptionalReasonDto, MasterReasonDto } from '../master/master-kit';
import {
  CreateServiceItemDto,
  ServiceItemDto,
  ServiceItemExportQuery,
  ServiceItemListQuery,
  ServiceItemPageDto,
  ServiceItemSummaryDto,
  UpdateServiceItemDto,
  UpsertServiceItemDto,
  type CalcUnit,
  type ServiceItemSide,
  type ServiceItemVatType,
  type ServiceItemWhtRate,
} from './service-item.dto';
import { ServiceItemsService } from './service-items.service';

const UNIT_TH: Record<CalcUnit, string> = {
  PER_TRIP: 'ต่อเที่ยว',
  PER_HOUR: 'ต่อชั่วโมง',
  PER_NIGHT: 'ต่อคืน',
  PER_STOP: 'ต่อจุด',
  PERCENT_OF_FREIGHT: '% ของค่าขนส่ง',
  ACTUAL: 'ตามจริง',
};
const VAT_TH: Record<ServiceItemVatType, string> = {
  VAT_7: 'VAT 7%',
  EXEMPT_TRANSPORT: 'ยกเว้น VAT',
  ZERO_RATED: 'VAT 0%',
};
const WHT_TH: Record<ServiceItemWhtRate, string> = { '0.00': 'ไม่หัก', '1.00': '1%', '3.00': '3%' };
const SIDE_TH: Record<ServiceItemSide, string> = {
  SELL: 'ฝั่งขาย',
  BUY: 'ฝั่งซื้อ',
  BOTH: 'ทั้งสองฝั่ง',
};

/** คอลัมน์ไฟล์ส่งออก — หัวคอลัมน์ไทยตรงกับ template นำเข้า (ST2-T23) */
const EXPORT_COLUMNS: ExportColumn<ServiceItemDto>[] = [
  { header: 'รหัส', value: (r) => r.code },
  { header: 'รายการ', value: (r) => r.name },
  { header: 'เงื่อนไข', value: (r) => r.condition },
  { header: 'หน่วยคิด', value: (r) => UNIT_TH[r.calcUnit] },
  { header: 'ราคา', value: (r) => r.defaultPrice },
  { header: 'ราคาน้ำมันอ้างอิง (฿/ลิตร)', value: (r) => r.fuelRefPrice },
  { header: 'VAT', value: (r) => VAT_TH[r.vatType] },
  { header: 'หัก ณ ที่จ่าย', value: (r) => WHT_TH[r.whtRate] },
  { header: 'ใช้กับ', value: (r) => SIDE_TH[r.side] },
  { header: 'รหัสบัญชี', value: (r) => r.defaultAccountCode },
  { header: 'รหัสในระบบต้นทาง', value: (r) => r.externalId },
  { header: 'สถานะ', value: (r) => (r.status === 'active' ? 'ใช้งาน' : 'ปิดใช้') },
];

/**
 * ค่าบริการเสริม (ST2-T11; docs/04 B Accessorial catalog, spec/02 §6) — CRUD + `PUT /external/{id}` + export + ประวัติ
 * สิทธิ์: อ่าน `master:read` · แก้/ปิดใช้/ลบ `master:write` · ส่งออก `export:run`
 * tenant ใหม่ได้ชุดภาษาไทยจาก bootstrap (ขั้น `service-items`) · เอกสารคัดลอกค่าด้วย ServiceItemsService.snapshotFor()
 */
@ApiTags('service-items')
@ApiBearerAuth()
@Controller('service-items')
export class ServiceItemsController {
  constructor(
    private readonly items: ServiceItemsService,
    private readonly db: DbService,
  ) {}

  private async resolve(id: string) {
    if (id.startsWith('ext:')) return this.items.getByExternalId(id.slice(4));
    return this.items.get(decodeIdOr404('serviceItem', id));
  }

  @Get()
  @RequireScope('master:read')
  @ApiOkResponse({ type: ServiceItemPageDto })
  list(@Query() q: ServiceItemListQuery) {
    return this.items.list(q);
  }

  @Get('summary')
  @RequireScope('master:read')
  @ApiOkResponse({ type: ServiceItemSummaryDto })
  summary(): Promise<ServiceItemSummaryDto> {
    return this.items.summary();
  }

  @Get('next-code')
  @RequireScope('master:write')
  @ApiOkResponse({ type: NextCodeDto, description: 'รหัสที่ระบบจะออกให้รายการใหม่ (`AX-0001`)' })
  async nextCode(): Promise<NextCodeDto> {
    return { code: await this.items.nextCode() };
  }

  @Get('export')
  @RequireScope('export:run')
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv')
  @ApiOkResponse({
    description: 'ไฟล์ .xlsx หรือ .csv ตามตัวกรองเดียวกับรายการ (สูงสุด 10,000 แถว)',
  })
  async export(
    @Query() q: ServiceItemExportQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const rows = await this.items.exportRows(q);
    return sendExport(res, q.format ?? 'xlsx', 'service-items', EXPORT_COLUMNS, rows);
  }

  @Post()
  @RequireScope('master:write')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: ServiceItemDto })
  async create(
    @Body() body: CreateServiceItemDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ServiceItemDto> {
    const v = await this.items.create(body);
    setEtag(res, v.version);
    return this.items.dto(v);
  }

  @Put('external/:externalId')
  @RequireScope('master:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag — ใช้เมื่อแถวมีอยู่แล้ว' })
  @ApiOkResponse({
    type: ServiceItemDto,
    description: 'มีอยู่แล้ว → อัปเดต (ส่งซ้ำได้ ไม่เกิดแถวใหม่)',
  })
  @ApiCreatedResponse({ type: ServiceItemDto, description: 'ยังไม่มี → สร้าง' })
  async upsertExternal(
    @Param('externalId') externalId: string,
    @Body() body: UpsertServiceItemDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ServiceItemDto> {
    if (!/^[\x21-\x7e]{1,100}$/.test(externalId))
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'externalId',
          code: 'matches',
          message: 'externalId must be 1-100 printable ASCII',
        },
      ]);
    const { row, created } = await this.items.upsertExternal(
      externalId,
      body,
      expectedVersion(req),
    );
    res.status(created ? 201 : 200);
    setEtag(res, row.version);
    return this.items.dto(row);
  }

  @Get(':id')
  @TenantResource('serviceItem')
  @RequireScope('master:read')
  @ApiOkResponse({ type: ServiceItemDto })
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ServiceItemDto> {
    const v = await this.resolve(id);
    setEtag(res, v.version);
    return this.items.dto(v);
  }

  @Get(':id/history')
  @TenantResource('serviceItem')
  @RequireScope('master:read')
  @ApiOkResponse({ type: AuditPageDto, description: 'ประวัติการแก้จาก audit log ใหม่สุดก่อน' })
  async history(@Param('id') id: string, @Query() q: HistoryQuery): Promise<AuditPageDto> {
    const v = await this.resolve(id);
    return entityHistory(this.db.tx, 'service_item', v.id, q);
  }

  @Patch(':id')
  @TenantResource('serviceItem')
  @RequireScope('master:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: ServiceItemDto })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateServiceItemDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ServiceItemDto> {
    const current = await this.resolve(id);
    const v = await this.items.update(current.id, body, expectedVersion(req));
    setEtag(res, v.version);
    return this.items.dto(v);
  }

  /** ปิดใช้ (เหตุผล ≥ 10) — เอกสารเดิมไม่กระทบ (snapshot) · รหัสสงวน → 409 `conflict` (MD-158) */
  @Post(':id/deactivate')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(200)
  @TenantResource('serviceItem')
  @RequireScope('master:write')
  @ApiOkResponse({ type: ServiceItemDto })
  async deactivate(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ServiceItemDto> {
    const current = await this.resolve(id);
    const v = await this.items.changeStatus(
      current.id,
      'deactivate',
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, v.version);
    return this.items.dto(v);
  }

  @Post(':id/activate')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(200)
  @TenantResource('serviceItem')
  @RequireScope('master:write')
  @ApiOkResponse({ type: ServiceItemDto })
  async activate(
    @Param('id') id: string,
    @Body() body: MasterOptionalReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ServiceItemDto> {
    const current = await this.resolve(id);
    const v = await this.items.changeStatus(
      current.id,
      'activate',
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, v.version);
    return this.items.dto(v);
  }

  /** "ลบ" (MD-004) — เฉพาะที่ไม่เคยถูกอ้างอิง (rate card/ค่าใช้จ่ายหน้างาน) → soft delete; ถูกอ้างอิง → 409 `in_use` · รหัสสงวน → 409 */
  @Post(':id/delete')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(204)
  @TenantResource('serviceItem')
  @RequireScope('master:write')
  @ApiNoContentResponse()
  async remove(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
  ): Promise<void> {
    const current = await this.resolve(id);
    await this.items.remove(current.id, body.reason, expectedVersion(req));
  }
}
