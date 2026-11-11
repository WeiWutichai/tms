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
import { RequireScope, TenantResource } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404 } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { NextCodeDto } from '../customers/customer.dto';
import { TenantRateLimiter } from '../geo/rate-limit';
import { sendExport, type ExportColumn } from '../master/export';
import { entityHistory, HistoryQuery } from '../master/history';
import { MasterReasonDto } from '../master/master-kit';
import { PROVINCES } from '../vehicles/provinces';
import {
  CreateDriverDto,
  DriverDto,
  DriverExportQuery,
  DriverListQuery,
  DriverPageDto,
  DriverStatusDto,
  DriverSummaryDto,
  RevealDriverDto,
  RevealDriverResultDto,
  UpdateDriverDto,
  UpsertDriverDto,
} from './driver.dto';
import { DriversService, mask, REVEAL_SCOPE } from './drivers.service';

export const DRIVER_REVEAL_PER_MIN = 20;

const TYPE_TH = {
  EMPLOYEE_SALARIED: 'พขร.มีเงินเดือน',
  EMPLOYEE_PER_TRIP: 'พขร.ไม่มีเงินเดือน',
  CARRIER_DRIVER: 'รถร่วม',
} as const;
const LIC_TH = { PERSONAL: 'ส่วนบุคคล', T1: 'ท.1', T2: 'ท.2', T3: 'ท.3', T4: 'ท.4' } as const;
const STATUS_TH = { active: 'พร้อมใช้', on_leave: 'ลาพัก', inactive: 'ปิดใช้' } as const;
const PROV_ABBR = new Map<string, string>(PROVINCES.map((p) => [p[0], p[2]]));

/**
 * คอลัมน์ไฟล์ส่งออก — หัวคอลัมน์ไทยตรงกับ template นำเข้า (ST2-T23)
 * เลขบัตรประชาชนเป็นแบบปิดบัง (`•••• 1234`) เสมอ — ไฟล์ส่งออกไม่มีค่าเต็ม
 */
const EXPORT_COLUMNS: ExportColumn<DriverDto>[] = [
  { header: 'รหัส', value: (r) => r.code },
  { header: 'ชื่อ-นามสกุล', value: (r) => r.name },
  { header: 'เบอร์โทร', value: (r) => r.phone },
  { header: 'ประเภท', value: (r) => TYPE_TH[r.employmentType] },
  { header: 'สังกัด (ผู้รับเหมา)', value: (r) => r.carrier?.code ?? null },
  { header: 'เลขบัตรประชาชน', value: (r) => mask(r.nationalIdLast4) },
  { header: 'เลขที่ใบขับขี่', value: (r) => r.licenceNo },
  { header: 'ประเภทใบขับขี่', value: (r) => (r.licenceClass ? LIC_TH[r.licenceClass] : null) },
  { header: 'ใบขับขี่หมดอายุ', value: (r) => r.licenceExpiresOn },
  {
    header: 'รถประจำ',
    value: (r) =>
      r.defaultVehicle
        ? `${r.defaultVehicle.plate} ${PROV_ABBR.get(r.defaultVehicle.plateProvince) ?? ''}`.trim()
        : null,
  },
  { header: 'รหัสในระบบต้นทาง', value: (r) => r.externalId },
  { header: 'สถานะ', value: (r) => STATUS_TH[r.status] },
];

/**
 * คนขับ (ST2-T08; docs/04 B คนขับ, docs/01 §3.2 + §5.2) — CRUD + `PUT /external/{id}` + สถานะ + export + ประวัติ + reveal
 * สิทธิ์: อ่าน `master:read` · แก้/เปลี่ยนสถานะ/ลบ `master:write` · ส่งออก `export:run` · ดูเลขบัตรเต็ม `users:write` (+ audit)
 */
@ApiTags('drivers')
@ApiBearerAuth()
@Controller('drivers')
export class DriversController {
  constructor(
    private readonly drivers: DriversService,
    private readonly db: DbService,
  ) {}

  /** ดูเลขเต็มได้ไม่เกิน 20 ครั้ง/นาที/ผู้ใช้ (กันดึงเลขทั้งตาราง) */
  revealLimiter = new TenantRateLimiter(DRIVER_REVEAL_PER_MIN);

  private async resolve(id: string) {
    if (id.startsWith('ext:')) return this.drivers.getByExternalId(id.slice(4));
    return this.drivers.get(decodeIdOr404('driver', id));
  }

  @Get()
  @RequireScope('master:read')
  @ApiOkResponse({ type: DriverPageDto })
  list(@Query() q: DriverListQuery) {
    return this.drivers.list(q);
  }

  @Get('summary')
  @RequireScope('master:read')
  @ApiOkResponse({ type: DriverSummaryDto })
  summary(): Promise<DriverSummaryDto> {
    return this.drivers.summary();
  }

  @Get('next-code')
  @RequireScope('master:write')
  @ApiOkResponse({ type: NextCodeDto, description: 'รหัสที่ระบบจะออกให้คนขับใหม่ (`DRV-0001`)' })
  async nextCode(): Promise<NextCodeDto> {
    return { code: await this.drivers.nextCode() };
  }

  @Get('export')
  @RequireScope('export:run')
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv')
  @ApiOkResponse({
    description:
      'ไฟล์ .xlsx หรือ .csv ตามตัวกรองเดียวกับรายการ (สูงสุด 10,000 แถว) — เลขบัตรประชาชนปิดบังเสมอ',
  })
  async export(
    @Query() q: DriverExportQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const rows = await this.drivers.exportRows(q);
    return sendExport(res, q.format ?? 'xlsx', 'drivers', EXPORT_COLUMNS, rows);
  }

  @Post()
  @RequireScope('master:write')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: DriverDto })
  async create(
    @Body() body: CreateDriverDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DriverDto> {
    const d = await this.drivers.create(body);
    setEtag(res, d.version);
    return this.drivers.dto(d);
  }

  @Put('external/:externalId')
  @RequireScope('master:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag — ใช้เมื่อแถวมีอยู่แล้ว' })
  @ApiOkResponse({ type: DriverDto, description: 'มีอยู่แล้ว → อัปเดต (ส่งซ้ำได้ ไม่เกิดแถวใหม่)' })
  @ApiCreatedResponse({ type: DriverDto, description: 'ยังไม่มี → สร้าง' })
  async upsertExternal(
    @Param('externalId') externalId: string,
    @Body() body: UpsertDriverDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DriverDto> {
    if (!/^[\x21-\x7e]{1,100}$/.test(externalId))
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'externalId',
          code: 'matches',
          message: 'externalId must be 1-100 printable ASCII',
        },
      ]);
    const { row, created } = await this.drivers.upsertExternal(
      externalId,
      body,
      expectedVersion(req),
    );
    res.status(created ? 201 : 200);
    setEtag(res, row.version);
    return this.drivers.dto(row);
  }

  @Get(':id')
  @TenantResource('driver')
  @RequireScope('master:read')
  @ApiOkResponse({ type: DriverDto })
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DriverDto> {
    const d = await this.resolve(id);
    setEtag(res, d.version);
    return this.drivers.dto(d);
  }

  @Get(':id/history')
  @TenantResource('driver')
  @RequireScope('master:read')
  @ApiOkResponse({ type: AuditPageDto, description: 'ประวัติการแก้จาก audit log ใหม่สุดก่อน' })
  async history(@Param('id') id: string, @Query() q: HistoryQuery): Promise<AuditPageDto> {
    const d = await this.resolve(id);
    return entityHistory(this.db.tx, 'driver', d.id, q);
  }

  /**
   * ดูเลขบัตรประชาชนเต็ม (spec/11 NFR-153: ต้องมีสิทธิ์ + ลง audit ทุกครั้ง)
   * สิทธิ์ `users:write` (เจ้าของ ผู้ดูแลระบบ) · ไม่รับ Idempotency-Key (ไม่เก็บค่าเต็มไว้ replay)
   */
  @Post(':id/reveal')
  @HttpCode(200)
  @TenantResource('driver')
  @RequireScope(REVEAL_SCOPE)
  @ApiOkResponse({ type: RevealDriverResultDto })
  @ApiTooManyRequestsResponse({
    description: 'rate_limited — เกิน 20 ครั้ง/นาที/ผู้ใช้ (Retry-After)',
  })
  async reveal(
    @Param('id') id: string,
    @Body() body: RevealDriverDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RevealDriverResultDto> {
    if (req.header('idempotency-key'))
      throw new ProblemException('bad_request', 'Idempotency-Key is not allowed on reveal');
    const ctx = requestContext.require();
    const wait = this.revealLimiter.take(`${ctx.tenantId}:${ctx.actorId ?? '-'}`);
    if (wait)
      throw new ProblemException('rate_limited', 'reveal rate limit', undefined, {
        retryAfter: wait,
      });
    const d = await this.resolve(id);
    res.setHeader('Cache-Control', 'no-store');
    return { field: 'nationalId', value: await this.drivers.reveal(d, body.reason) };
  }

  @Patch(':id')
  @TenantResource('driver')
  @RequireScope('master:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: DriverDto })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateDriverDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DriverDto> {
    const current = await this.resolve(id);
    const d = await this.drivers.update(current.id, body, expectedVersion(req));
    setEtag(res, d.version);
    return this.drivers.dto(d);
  }

  /** เปลี่ยนสถานะ พร้อมใช้ / ลาพัก / ปิดใช้งาน (เหตุผล ≥ 10 — state machine + audit) */
  @Post(':id/status')
  @HttpCode(200)
  @TenantResource('driver')
  @RequireScope('master:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: DriverDto })
  async status(
    @Param('id') id: string,
    @Body() body: DriverStatusDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DriverDto> {
    const current = await this.resolve(id);
    const d = await this.drivers.changeStatus(
      current.id,
      body.status,
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, d.version);
    return this.drivers.dto(d);
  }

  /** "ลบ" (MD-004) — เฉพาะที่ไม่เคยถูกอ้างอิง (เที่ยว) → soft delete; ถูกอ้างอิง → 409 `in_use` */
  @Post(':id/delete')
  @HttpCode(204)
  @TenantResource('driver')
  @RequireScope('master:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiNoContentResponse()
  async remove(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
  ): Promise<void> {
    const current = await this.resolve(id);
    await this.drivers.remove(current.id, body.reason, expectedVersion(req));
  }
}
