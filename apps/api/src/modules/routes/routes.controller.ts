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
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuditPageDto } from '../../audit/audit.controller';
import { NoTransaction, RequireScope, TenantResource } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404 } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { NextCodeDto } from '../customers/customer.dto';
import { TenantRateLimiter } from '../geo/rate-limit';
import { sendExport, type ExportColumn } from '../master/export';
import { entityHistory, HistoryQuery } from '../master/history';
import { MasterOptionalReasonDto, MasterReasonDto } from '../master/master-kit';
import {
  CreateRouteDto,
  RouteDto,
  RouteEstimateDto,
  RouteEstimateRequestDto,
  RouteExportQuery,
  RouteListQuery,
  RoutePageDto,
  RouteSummaryDto,
  UpdateRouteDto,
  UpsertRouteDto,
} from './route.dto';
import { RoutesService, toRouteDto } from './routes.service';

/** เพดานปุ่ม "คำนวณจากพิกัด" ต่อ tenant ต่อนาที (`ROUTE_ESTIMATE_RATE_PER_MIN`, ค่าเริ่มต้น 60) */
const ESTIMATE_RATE_PER_MIN = Number(process.env.ROUTE_ESTIMATE_RATE_PER_MIN) || 60;

/** คอลัมน์ไฟล์ส่งออก — หัวคอลัมน์ไทยตรงกับ template นำเข้า (ST2-T23) */
const EXPORT_COLUMNS: ExportColumn<RouteDto>[] = [
  { header: 'รหัส', value: (r) => r.code },
  { header: 'รหัสต้นทาง', value: (r) => r.origin.code },
  { header: 'ต้นทาง', value: (r) => r.origin.name },
  { header: 'รหัสปลายทาง', value: (r) => r.destination.code },
  { header: 'ปลายทาง', value: (r) => r.destination.name },
  { header: 'ระยะทาง (กม.)', value: (r) => r.distanceKm },
  { header: 'เวลามาตรฐาน (นาที)', value: (r) => r.standardMinutes },
  { header: 'ค่าผ่านทาง (บาท)', value: (r) => r.tollAmount },
  { header: 'หมายเหตุ', value: (r) => r.notes },
  { header: 'รหัสในระบบต้นทาง', value: (r) => r.externalId },
  { header: 'สถานะ', value: (r) => (r.status === 'active' ? 'ใช้งาน' : 'ปิดใช้') },
];

/**
 * เส้นทาง / OD pair (ST2-T09; docs/04 B เส้นทาง) — CRUD + `PUT /external/{id}` + export + ประวัติ (กฎร่วมทุก master)
 * สิทธิ์: อ่าน `master:read` · แก้/ปิดใช้/ลบ `master:write` · ส่งออก `export:run`
 * ค่าผ่านทางเป็นต้นทุน (ไม่ใช่ราคาขาย/ซื้อ) จึงไม่ใช่ field ราคา (`@PriceField`)
 */
@ApiTags('routes')
@ApiBearerAuth()
@Controller('routes')
export class RoutesController {
  /** จำกัด `POST /routes/estimate` ต่อ tenant (ในหน่วยความจำ — ทบทวนเมื่อมีผู้ให้บริการจริง) */
  estimateLimiter = new TenantRateLimiter(ESTIMATE_RATE_PER_MIN);

  constructor(
    private readonly routes: RoutesService,
    private readonly db: DbService,
  ) {}

  private async resolve(id: string) {
    if (id.startsWith('ext:')) return this.routes.getByExternalId(id.slice(4));
    return this.routes.get(decodeIdOr404('route', id));
  }

  @Get()
  @RequireScope('master:read')
  @ApiOkResponse({ type: RoutePageDto })
  list(@Query() q: RouteListQuery) {
    return this.routes.list(q);
  }

  @Get('summary')
  @RequireScope('master:read')
  @ApiOkResponse({ type: RouteSummaryDto })
  summary(): Promise<RouteSummaryDto> {
    return this.routes.summary();
  }

  @Get('next-code')
  @RequireScope('master:write')
  @ApiOkResponse({ type: NextCodeDto, description: 'รหัสที่ระบบจะออกให้เส้นทางใหม่ (`RT-0001`)' })
  async nextCode(): Promise<NextCodeDto> {
    return { code: await this.routes.nextCode() };
  }

  @Get('export')
  @RequireScope('export:run')
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv')
  @ApiOkResponse({
    description: 'ไฟล์ .xlsx หรือ .csv ตามตัวกรองเดียวกับรายการ (สูงสุด 10,000 แถว)',
  })
  async export(
    @Query() q: RouteExportQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const rows = await this.routes.exportRows(q);
    return sendExport(res, q.format ?? 'xlsx', 'routes', EXPORT_COLUMNS, rows);
  }

  /**
   * ปุ่ม "คำนวณจากพิกัด" — ระยะทาง/เวลาโดยประมาณจากพิกัดของสถานที่ทั้งสอง (ผู้ให้บริการตาม `GEO_PROVIDER`)
   * ไม่บันทึกอะไร: ผู้ใช้ตรวจแล้วบันทึกฟอร์มเอง · ไม่มีพิกัด/ผู้ให้บริการไม่รองรับ = กรอกระยะทางเอง
   */
  @Post('estimate')
  @HttpCode(200)
  @NoTransaction() // ไม่ถือ transaction ระหว่างรอผู้ให้บริการ (เส้นตาย GEO_TIMEOUT_MS)
  @RequireScope('master:write')
  @ApiOkResponse({ type: RouteEstimateDto })
  @ApiTooManyRequestsResponse({
    description: 'rate_limited — เกินเพดานต่อบริษัท มี header Retry-After',
  })
  estimate(@Body() body: RouteEstimateRequestDto): Promise<RouteEstimateDto> {
    const wait = this.estimateLimiter.take(requestContext.require().tenantId!);
    if (wait)
      throw new ProblemException('rate_limited', 'route estimate rate limit', undefined, {
        retryAfter: wait,
      });
    return this.routes.estimate(body.originId, body.destinationId);
  }

  /** สร้าง — คู่ต้นทาง→ปลายทางที่มีอยู่แล้ว (รวมที่ปิดใช้) → 409 `duplicate` + `existing` */
  @Post()
  @RequireScope('master:write')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: RouteDto })
  async create(
    @Body() body: CreateRouteDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RouteDto> {
    const r = await this.routes.create(body);
    setEtag(res, r.version);
    return toRouteDto(r);
  }

  @Put('external/:externalId')
  @RequireScope('master:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag — ใช้เมื่อแถวมีอยู่แล้ว' })
  @ApiOkResponse({ type: RouteDto, description: 'มีอยู่แล้ว → อัปเดต (ส่งซ้ำได้ ไม่เกิดแถวใหม่)' })
  @ApiCreatedResponse({ type: RouteDto, description: 'ยังไม่มี → สร้าง' })
  async upsertExternal(
    @Param('externalId') externalId: string,
    @Body() body: UpsertRouteDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RouteDto> {
    if (!/^[\x21-\x7e]{1,100}$/.test(externalId))
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'externalId',
          code: 'matches',
          message: 'externalId must be 1-100 printable ASCII',
        },
      ]);
    const { row, created } = await this.routes.upsertExternal(
      externalId,
      body,
      expectedVersion(req),
    );
    res.status(created ? 201 : 200);
    setEtag(res, row.version);
    return toRouteDto(row);
  }

  @Get(':id')
  @TenantResource('route')
  @RequireScope('master:read')
  @ApiOkResponse({ type: RouteDto })
  async get(@Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<RouteDto> {
    const r = await this.resolve(id);
    setEtag(res, r.version);
    return toRouteDto(r);
  }

  @Get(':id/history')
  @TenantResource('route')
  @RequireScope('master:read')
  @ApiOkResponse({ type: AuditPageDto, description: 'ประวัติการแก้จาก audit log ใหม่สุดก่อน' })
  async history(@Param('id') id: string, @Query() q: HistoryQuery): Promise<AuditPageDto> {
    const r = await this.resolve(id);
    return entityHistory(this.db.tx, 'route', r.id, q);
  }

  @Patch(':id')
  @TenantResource('route')
  @RequireScope('master:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: RouteDto })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateRouteDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RouteDto> {
    const current = await this.resolve(id);
    const r = await this.routes.update(current.id, body, expectedVersion(req));
    setEtag(res, r.version);
    return toRouteDto(r);
  }

  @Post(':id/deactivate')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(200)
  @TenantResource('route')
  @RequireScope('master:write')
  @ApiOkResponse({ type: RouteDto })
  async deactivate(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RouteDto> {
    const current = await this.resolve(id);
    const r = await this.routes.changeStatus(
      current.id,
      'deactivate',
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, r.version);
    return toRouteDto(r);
  }

  @Post(':id/activate')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(200)
  @TenantResource('route')
  @RequireScope('master:write')
  @ApiOkResponse({ type: RouteDto })
  async activate(
    @Param('id') id: string,
    @Body() body: MasterOptionalReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RouteDto> {
    const current = await this.resolve(id);
    const r = await this.routes.changeStatus(
      current.id,
      'activate',
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, r.version);
    return toRouteDto(r);
  }

  /** "ลบ" (MD-004) → soft delete + เหตุผล ≥ 10 */
  @Post(':id/delete')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(204)
  @TenantResource('route')
  @RequireScope('master:write')
  @ApiNoContentResponse()
  async remove(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
  ): Promise<void> {
    const current = await this.resolve(id);
    await this.routes.remove(current.id, body.reason, expectedVersion(req));
  }
}
