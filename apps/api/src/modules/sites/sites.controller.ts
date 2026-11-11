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
  ConfirmGeocodeDto,
  CreateSiteDto,
  GeocodeRequestDto,
  GeocodeResultDto,
  SiteDto,
  SiteExportQuery,
  SiteListQuery,
  SitePageDto,
  SiteSummaryDto,
  UpdateSiteDto,
  UpsertSiteDto,
} from './site.dto';
import { SitesService } from './sites.service';

const KIND_TH: Record<SiteDto['kind'], string> = {
  PICKUP: 'ต้นทาง',
  DROPOFF: 'ปลายทาง',
  WAREHOUSE: 'คลัง / ศูนย์กระจาย',
};
const CLASS_TH: Record<NonNullable<SiteDto['maxVehicleClass']>, string> = {
  '6W': '6 ล้อ',
  '10W': '10 ล้อ',
  TRAILER: 'พ่วง',
  SEMI_TRAILER: 'เทรลเลอร์',
};

/** สถานะพิกัดในไฟล์ส่งออก (ST2-T03) — ตรงกับป้ายในหน้ารายการ */
function geocodeLabel(r: SiteDto): string {
  if (r.geocodeStatus === 'OK') return 'ปักหมุดแล้ว';
  if (r.geocodeStatus === 'FAILED') return 'หาพิกัดไม่พบ';
  return r.geocodeProposal ? 'รอยืนยันพิกัด' : 'ยังไม่ปักหมุด';
}

/** คอลัมน์ไฟล์ส่งออก — หัวคอลัมน์ไทยตรงกับ template นำเข้า (ST2-T23) */
const EXPORT_COLUMNS: ExportColumn<SiteDto>[] = [
  { header: 'รหัส', value: (r) => r.code },
  { header: 'ชื่อสถานที่', value: (r) => r.name },
  { header: 'ประเภท', value: (r) => KIND_TH[r.kind] },
  { header: 'รหัสลูกค้า', value: (r) => r.customer?.code },
  { header: 'ลูกค้า', value: (r) => r.customer?.name },
  { header: 'ที่อยู่', value: (r) => r.address.line1 },
  { header: 'ละติจูด', value: (r) => r.lat },
  { header: 'ลองจิจูด', value: (r) => r.lng },
  { header: 'สถานะพิกัด', value: (r) => geocodeLabel(r) },
  { header: 'รัศมี geofence (เมตร)', value: (r) => r.geofenceRadiusM },
  { header: 'เวลาเปิด', value: (r) => r.openTime },
  { header: 'เวลาปิด', value: (r) => r.closeTime },
  {
    header: 'รถเข้าได้สูงสุด',
    value: (r) => (r.maxVehicleClass ? CLASS_TH[r.maxVehicleClass] : null),
  },
  { header: 'เวลาให้บริการ (นาที)', value: (r) => r.serviceTimeMin },
  { header: 'ผู้ติดต่อ', value: (r) => r.contact?.name },
  { header: 'เบอร์โทร', value: (r) => r.contact?.phone },
  { header: 'ชื่อเรียกอื่น', value: (r) => r.aliases.join(' | ') },
  { header: 'หมายเหตุ', value: (r) => r.notes },
  { header: 'รหัสในระบบต้นทาง', value: (r) => r.externalId },
  { header: 'สถานะ', value: (r) => (r.status === 'active' ? 'ใช้งาน' : 'ปิดใช้') },
];

/**
 * สถานที่ / จุดรับส่ง (ST2-T02; docs/01 §5.2 #6 `customer-sites`) — CRUD + `PUT /external/{id}` + export + ประวัติ
 * สิทธิ์: อ่าน `master:read` · แก้/ปิดใช้/ลบ `master:write` · ส่งออก `export:run` (docs/04 A3)
 */
@ApiTags('customer-sites')
@ApiBearerAuth()
@Controller('customer-sites')
export class SitesController {
  constructor(
    private readonly sites: SitesService,
    private readonly db: DbService,
  ) {}

  private async resolve(id: string) {
    if (id.startsWith('ext:')) return this.sites.getByExternalId(id.slice(4));
    return this.sites.get(decodeIdOr404('site', id));
  }

  @Get()
  @RequireScope('master:read')
  @ApiOkResponse({ type: SitePageDto })
  list(@Query() q: SiteListQuery) {
    return this.sites.list(q);
  }

  @Get('summary')
  @RequireScope('master:read')
  @ApiOkResponse({ type: SiteSummaryDto })
  summary(): Promise<SiteSummaryDto> {
    return this.sites.summary();
  }

  @Get('next-code')
  @RequireScope('master:write')
  @ApiOkResponse({ type: NextCodeDto, description: 'รหัสที่ระบบจะออกให้สถานที่ใหม่ (MD-002)' })
  async nextCode(): Promise<NextCodeDto> {
    return { code: await this.sites.nextCode() };
  }

  @Get('export')
  @RequireScope('export:run')
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv')
  @ApiOkResponse({
    description: 'ไฟล์ .xlsx หรือ .csv ตามตัวกรองเดียวกับรายการ (สูงสุด 10,000 แถว)',
  })
  async export(
    @Query() q: SiteExportQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const rows = await this.sites.exportRows(q);
    return sendExport(res, q.format ?? 'xlsx', 'customer-sites', EXPORT_COLUMNS, rows);
  }

  /**
   * ปุ่ม "ประมาณจากที่อยู่" (ST2-T03) — geocode ทันทีด้วยผู้ให้บริการที่ตั้งค่า (`GEO_PROVIDER`) ไม่บันทึกอะไร
   * ผู้ใช้ตรวจพิกัดแล้วบันทึกฟอร์ม = คนยืนยัน (geocodeStatus OK)
   */
  @Post('geocode')
  @HttpCode(200)
  @RequireScope('master:write')
  @ApiOkResponse({ type: GeocodeResultDto })
  geocode(@Body() body: GeocodeRequestDto): Promise<GeocodeResultDto> {
    return this.sites.estimate(body.address);
  }

  @Post()
  @RequireScope('master:write')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: SiteDto })
  async create(
    @Body() body: CreateSiteDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SiteDto> {
    const s = await this.sites.create(body);
    setEtag(res, s.version);
    return this.sites.dto(s);
  }

  @Put('external/:externalId')
  @RequireScope('master:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag — ใช้เมื่อแถวมีอยู่แล้ว' })
  @ApiOkResponse({ type: SiteDto, description: 'มีอยู่แล้ว → อัปเดต (ส่งซ้ำได้ ไม่เกิดแถวใหม่)' })
  @ApiCreatedResponse({ type: SiteDto, description: 'ยังไม่มี → สร้าง' })
  async upsertExternal(
    @Param('externalId') externalId: string,
    @Body() body: UpsertSiteDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SiteDto> {
    if (!/^[\x21-\x7e]{1,100}$/.test(externalId))
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'externalId',
          code: 'matches',
          message: 'externalId must be 1-100 printable ASCII',
        },
      ]);
    const { row, created } = await this.sites.upsertExternal(
      externalId,
      body,
      expectedVersion(req),
    );
    res.status(created ? 201 : 200);
    setEtag(res, row.version);
    return this.sites.dto(row);
  }

  @Get(':id')
  @TenantResource('site')
  @RequireScope('master:read')
  @ApiOkResponse({ type: SiteDto })
  async get(@Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<SiteDto> {
    const s = await this.resolve(id);
    setEtag(res, s.version);
    return this.sites.dto(s);
  }

  @Get(':id/history')
  @TenantResource('site')
  @RequireScope('master:read')
  @ApiOkResponse({ type: AuditPageDto, description: 'ประวัติการแก้จาก audit log ใหม่สุดก่อน' })
  async history(@Param('id') id: string, @Query() q: HistoryQuery): Promise<AuditPageDto> {
    const s = await this.resolve(id);
    return entityHistory(this.db.tx, 'customer_site', s.id, q);
  }

  @Patch(':id')
  @TenantResource('site')
  @RequireScope('master:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: SiteDto })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateSiteDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SiteDto> {
    const current = await this.resolve(id);
    const s = await this.sites.update(current.id, body, expectedVersion(req));
    setEtag(res, s.version);
    return this.sites.dto(s);
  }

  @Post(':id/deactivate')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(200)
  @TenantResource('site')
  @RequireScope('master:write')
  @ApiOkResponse({ type: SiteDto })
  async deactivate(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SiteDto> {
    const current = await this.resolve(id);
    const s = await this.sites.changeStatus(
      current.id,
      'deactivate',
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, s.version);
    return this.sites.dto(s);
  }

  @Post(':id/activate')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(200)
  @TenantResource('site')
  @RequireScope('master:write')
  @ApiOkResponse({ type: SiteDto })
  async activate(
    @Param('id') id: string,
    @Body() body: MasterOptionalReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SiteDto> {
    const current = await this.resolve(id);
    const s = await this.sites.changeStatus(
      current.id,
      'activate',
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, s.version);
    return this.sites.dto(s);
  }

  /** ยืนยันพิกัดที่ geocode อัตโนมัติเสนอ (ST2-T03) → lat/lng + OK · ไม่มีข้อเสนอ → 409 */
  @Post(':id/geocode/confirm')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(200)
  @TenantResource('site')
  @RequireScope('master:write')
  @ApiOkResponse({ type: SiteDto })
  async confirmGeocode(
    @Param('id') id: string,
    @Body() body: ConfirmGeocodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SiteDto> {
    const current = await this.resolve(id);
    const s = await this.sites.confirmGeocode(current.id, body.reason, expectedVersion(req));
    setEtag(res, s.version);
    return this.sites.dto(s);
  }

  /** ปฏิเสธพิกัดที่เสนอ (ผิดตำแหน่ง) → FAILED ให้ปักหมุดเอง — เหตุผล ≥ 10 ตัวอักษร */
  @Post(':id/geocode/reject')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(200)
  @TenantResource('site')
  @RequireScope('master:write')
  @ApiOkResponse({ type: SiteDto })
  async rejectGeocode(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SiteDto> {
    const current = await this.resolve(id);
    const s = await this.sites.rejectGeocode(current.id, body.reason, expectedVersion(req));
    setEtag(res, s.version);
    return this.sites.dto(s);
  }

  /** "ลบ" (MD-004) — เฉพาะจุดที่ไม่เคยถูกอ้างอิง → soft delete; ถูกอ้างอิง → 409 `in_use` */
  @Post(':id/delete')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(204)
  @TenantResource('site')
  @RequireScope('master:write')
  @ApiNoContentResponse()
  async remove(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
  ): Promise<void> {
    const current = await this.resolve(id);
    await this.sites.remove(current.id, body.reason, expectedVersion(req));
  }
}
