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
import { TenantRateLimiter } from '../geo/rate-limit';
import { DbService } from '../../db/db.service';
import { NextCodeDto } from '../customers/customer.dto';
import { sendExport, type ExportColumn } from '../master/export';
import { entityHistory, HistoryQuery } from '../master/history';
import { MasterOptionalReasonDto, MasterReasonDto } from '../master/master-kit';
import {
  CarrierDto,
  CarrierExportQuery,
  CarrierListQuery,
  CarrierPageDto,
  CarrierSummaryDto,
  CreateCarrierDto,
  RevealCarrierDto,
  RevealCarrierResultDto,
  UpdateCarrierDto,
  UpsertCarrierDto,
} from './carrier.dto';
import { CarriersService, mask } from './carriers.service';

export const REVEAL_PER_MIN = 20;

const ENTITY_TH = { INDIVIDUAL: 'บุคคล', JURISTIC: 'นิติบุคคล' } as const;

/**
 * คอลัมน์ไฟล์ส่งออก — หัวคอลัมน์ไทยตรงกับ template นำเข้า (ST2-T23)
 * เลขบัตรประชาชน/เลขบัญชีเป็นแบบปิดบัง (`•••• 1234`) เสมอ — ไฟล์ส่งออกไม่มีค่าเต็ม
 */
const EXPORT_COLUMNS: ExportColumn<CarrierDto>[] = [
  { header: 'รหัส', value: (r) => r.code },
  { header: 'ชื่อ', value: (r) => r.legalName },
  { header: 'บุคคล / นิติบุคคล', value: (r) => ENTITY_TH[r.entityType] },
  { header: 'เลขผู้เสียภาษี', value: (r) => r.taxId ?? mask(r.taxIdLast4) },
  { header: 'รหัสสาขา', value: (r) => r.branchCode },
  { header: 'ที่อยู่', value: (r) => r.address?.line1 ?? null },
  { header: 'หัก ณ ที่จ่าย (%)', value: (r) => r.whtRate },
  { header: 'ธนาคาร', value: (r) => r.bankAccount?.bankCode ?? null },
  { header: 'เลขบัญชี', value: (r) => mask(r.bankAccount?.last4) },
  { header: 'ชื่อบัญชี', value: (r) => r.bankAccount?.accountName ?? null },
  { header: 'เงื่อนไขจ่าย (วัน)', value: (r) => r.paymentTermDays },
  { header: 'ไม่มี POD ไม่จ่าย', value: (r) => (r.requirePodToPay ? 'ใช่' : 'ไม่') },
  { header: 'เบอร์โทร', value: (r) => r.phone },
  { header: 'LINE ID', value: (r) => r.lineContact },
  { header: 'สังกัด', value: (r) => r.parent?.code ?? null },
  { header: 'เพดานเที่ยว/วัน', value: (r) => r.maxTripsPerDay },
  { header: 'ลำดับ', value: (r) => r.priority },
  { header: 'จำนวนรถ', value: (r) => r.usage.vehicles },
  { header: 'รหัสในระบบต้นทาง', value: (r) => r.externalId },
  { header: 'สถานะ', value: (r) => (r.status === 'active' ? 'ใช้งาน' : 'ระงับชั่วคราว') },
];

/**
 * รถร่วม / ผู้รับเหมา (ST2-T05; docs/04 B Carrier, docs/01 §3.2 + §5.2 #8) — CRUD + `PUT /external/{id}` + export + ประวัติ
 * สิทธิ์: อ่าน `master:read` · แก้/ระงับ/ลบ `master:write` · ส่งออก `export:run` · ดูเลขเต็ม `settlements:pay` (+ audit)
 */
@ApiTags('carriers')
@ApiBearerAuth()
@Controller('carriers')
export class CarriersController {
  constructor(
    private readonly carriers: CarriersService,
    private readonly db: DbService,
  ) {}

  /** ดูเลขเต็มได้ไม่เกิน 20 ครั้ง/นาที/ผู้ใช้ (กันดึงเลขทั้งตาราง) — ต่อ process เหมือน geocode limiter */
  revealLimiter = new TenantRateLimiter(REVEAL_PER_MIN);

  private async resolve(id: string) {
    if (id.startsWith('ext:')) return this.carriers.getByExternalId(id.slice(4));
    return this.carriers.get(decodeIdOr404('carrier', id));
  }

  @Get()
  @RequireScope('master:read')
  @ApiOkResponse({ type: CarrierPageDto })
  list(@Query() q: CarrierListQuery) {
    return this.carriers.list(q);
  }

  @Get('summary')
  @RequireScope('master:read')
  @ApiOkResponse({ type: CarrierSummaryDto })
  summary(): Promise<CarrierSummaryDto> {
    return this.carriers.summary();
  }

  @Get('next-code')
  @RequireScope('master:write')
  @ApiOkResponse({
    type: NextCodeDto,
    description: 'รหัสที่ระบบจะออกให้ผู้รับเหมาใหม่ (`SUB-0001`)',
  })
  async nextCode(): Promise<NextCodeDto> {
    return { code: await this.carriers.nextCode() };
  }

  @Get('export')
  @RequireScope('export:run')
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv')
  @ApiOkResponse({
    description:
      'ไฟล์ .xlsx หรือ .csv ตามตัวกรองเดียวกับรายการ (สูงสุด 10,000 แถว) — เลขบัตร/เลขบัญชีปิดบังเสมอ',
  })
  async export(
    @Query() q: CarrierExportQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const rows = await this.carriers.exportRows(q);
    return sendExport(res, q.format ?? 'xlsx', 'carriers', EXPORT_COLUMNS, rows);
  }

  @Post()
  @RequireScope('master:write')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: CarrierDto })
  async create(
    @Body() body: CreateCarrierDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CarrierDto> {
    const c = await this.carriers.create(body);
    setEtag(res, c.version);
    return this.carriers.dto(c);
  }

  @Put('external/:externalId')
  @RequireScope('master:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag — ใช้เมื่อแถวมีอยู่แล้ว' })
  @ApiOkResponse({
    type: CarrierDto,
    description: 'มีอยู่แล้ว → อัปเดต (ส่งซ้ำได้ ไม่เกิดแถวใหม่)',
  })
  @ApiCreatedResponse({ type: CarrierDto, description: 'ยังไม่มี → สร้าง' })
  async upsertExternal(
    @Param('externalId') externalId: string,
    @Body() body: UpsertCarrierDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CarrierDto> {
    if (!/^[\x21-\x7e]{1,100}$/.test(externalId))
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'externalId',
          code: 'matches',
          message: 'externalId must be 1-100 printable ASCII',
        },
      ]);
    const { row, created } = await this.carriers.upsertExternal(
      externalId,
      body,
      expectedVersion(req),
    );
    res.status(created ? 201 : 200);
    setEtag(res, row.version);
    return this.carriers.dto(row);
  }

  @Get(':id')
  @TenantResource('carrier')
  @RequireScope('master:read')
  @ApiOkResponse({ type: CarrierDto })
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CarrierDto> {
    const c = await this.resolve(id);
    setEtag(res, c.version);
    return this.carriers.dto(c);
  }

  @Get(':id/history')
  @TenantResource('carrier')
  @RequireScope('master:read')
  @ApiOkResponse({ type: AuditPageDto, description: 'ประวัติการแก้จาก audit log ใหม่สุดก่อน' })
  async history(@Param('id') id: string, @Query() q: HistoryQuery): Promise<AuditPageDto> {
    const c = await this.resolve(id);
    return entityHistory(this.db.tx, 'carrier', c.id, q);
  }

  /**
   * ดูเลขบัตรประชาชน/เลขบัญชีเต็ม (spec/11 NFR-153: ต้องมีสิทธิ์ + ลง audit ทุกครั้ง)
   * สิทธิ์ `settlements:pay` (เจ้าของ ผู้ดูแลระบบ บัญชี — ผู้จ่ายเงินรถร่วม) · ไม่รับ Idempotency-Key (ไม่เก็บค่าเต็มไว้ replay)
   */
  @Post(':id/reveal')
  @HttpCode(200)
  @TenantResource('carrier')
  @RequireScope('settlements:pay')
  @ApiOkResponse({ type: RevealCarrierResultDto })
  @ApiTooManyRequestsResponse({
    description: 'rate_limited — เกิน 20 ครั้ง/นาที/ผู้ใช้ (Retry-After)',
  })
  async reveal(
    @Param('id') id: string,
    @Body() body: RevealCarrierDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RevealCarrierResultDto> {
    if (req.header('idempotency-key'))
      throw new ProblemException('bad_request', 'Idempotency-Key is not allowed on reveal');
    const ctx = requestContext.require();
    const wait = this.revealLimiter.take(`${ctx.tenantId}:${ctx.actorId ?? '-'}`);
    if (wait)
      throw new ProblemException('rate_limited', 'reveal rate limit', undefined, {
        retryAfter: wait,
      });
    const c = await this.resolve(id);
    res.setHeader('Cache-Control', 'no-store');
    return { field: body.field, value: await this.carriers.reveal(c, body.field, body.reason) };
  }

  @Patch(':id')
  @TenantResource('carrier')
  @RequireScope('master:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: CarrierDto })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateCarrierDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CarrierDto> {
    const current = await this.resolve(id);
    const c = await this.carriers.update(current.id, body, expectedVersion(req));
    setEtag(res, c.version);
    return this.carriers.dto(c);
  }

  /** ระงับชั่วคราว (เหตุผล ≥ 10) — ระบบไม่เสนองานใหม่ให้รายนี้ */
  @Post(':id/deactivate')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(200)
  @TenantResource('carrier')
  @RequireScope('master:write')
  @ApiOkResponse({ type: CarrierDto })
  async deactivate(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CarrierDto> {
    const current = await this.resolve(id);
    const c = await this.carriers.changeStatus(
      current.id,
      'deactivate',
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, c.version);
    return this.carriers.dto(c);
  }

  @Post(':id/activate')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(200)
  @TenantResource('carrier')
  @RequireScope('master:write')
  @ApiOkResponse({ type: CarrierDto })
  async activate(
    @Param('id') id: string,
    @Body() body: MasterOptionalReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CarrierDto> {
    const current = await this.resolve(id);
    const c = await this.carriers.changeStatus(
      current.id,
      'activate',
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, c.version);
    return this.carriers.dto(c);
  }

  /** "ลบ" (MD-004) — เฉพาะที่ไม่เคยถูกอ้างอิง (รถ คนขับ rate card เที่ยว carrier ลูก) → soft delete; ถูกอ้างอิง → 409 `in_use` */
  @Post(':id/delete')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(204)
  @TenantResource('carrier')
  @RequireScope('master:write')
  @ApiNoContentResponse()
  async remove(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
  ): Promise<void> {
    const current = await this.resolve(id);
    await this.carriers.remove(current.id, body.reason, expectedVersion(req));
  }
}
