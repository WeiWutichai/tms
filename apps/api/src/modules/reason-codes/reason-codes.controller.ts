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
  CreateReasonCodeDto,
  ReasonCodeDto,
  ReasonCodeExportQuery,
  ReasonCodeListQuery,
  ReasonCodePageDto,
  UpdateReasonCodeDto,
  UpsertReasonCodeDto,
  type ReasonCategoryApi,
} from './reason-code.dto';
import { ReasonCodesService, toReasonCodeDto } from './reason-codes.service';

/** ชื่อหมวดภาษาไทย (ตรงกับหน้าจอ — ต้นแบบ TMS v4 ตั้งค่า → เหตุผล) */
const CATEGORY_TH: Record<ReasonCategoryApi, string> = {
  ORDER_HOLD: 'ค้างวางแผน',
  DELIVERY_FAILED: 'ส่งไม่สำเร็จ',
  REJECTED_BY_RECEIVER: 'ตีกลับ',
  POD_MISSING: 'ไม่เซ็นเอกสาร',
  DELAY: 'ล่าช้า',
  SETTLEMENT_DISPUTE: 'ข้อโต้แย้ง',
  CANCEL: 'ยกเลิก',
  OVERRIDE: 'ยกเว้นกฎ',
};
const yes = (b: boolean) => (b ? 'ใช่' : '');

/** คอลัมน์ไฟล์ส่งออก — หัวคอลัมน์ไทยตรงกับ template นำเข้า (ST2-T23) */
const EXPORT_COLUMNS: ExportColumn<ReasonCodeDto>[] = [
  { header: 'หมวด', value: (r) => CATEGORY_TH[r.category] },
  { header: 'รหัส', value: (r) => r.code },
  { header: 'เหตุผล', value: (r) => r.label },
  { header: 'บังคับรูป', value: (r) => yes(r.requiresPhoto) },
  { header: 'บังคับโน้ต', value: (r) => yes(r.requiresNote) },
  { header: 'นัดส่งใหม่อัตโนมัติ', value: (r) => yes(r.autoReschedule) },
  { header: 'แสดงบน tracking', value: (r) => yes(r.showOnTracking) },
  { header: 'รหัสระบบ', value: (r) => yes(r.system) },
  { header: 'รหัสในระบบต้นทาง', value: (r) => r.externalId },
  { header: 'สถานะ', value: (r) => (r.status === 'active' ? 'ใช้งาน' : 'ปิดใช้') },
];

/**
 * เหตุผลมาตรฐาน (ST2-T12; docs/04 B Reason master, docs/01 §3.2, spec/02 §9) — CRUD + `PUT /external/{id}` + export + ประวัติ
 * สิทธิ์ (docs/04 A3 แถว Master data): อ่าน `master:read` · แก้/ปิดใช้/ลบ `master:write` · ส่งออก `export:run`
 * tenant ใหม่ได้ชุดภาษาไทยจาก bootstrap (ขั้น `reason-codes`) · งานคัดลอกข้อความด้วย ReasonCodesService.snapshotFor()
 */
@ApiTags('reason-codes')
@ApiBearerAuth()
@Controller('reason-codes')
export class ReasonCodesController {
  constructor(
    private readonly reasons: ReasonCodesService,
    private readonly db: DbService,
  ) {}

  private async resolve(id: string) {
    if (id.startsWith('ext:')) return this.reasons.getByExternalId(id.slice(4));
    return this.reasons.get(decodeIdOr404('reasonCode', id));
  }

  @Get()
  @RequireScope('master:read')
  @ApiOkResponse({ type: ReasonCodePageDto })
  list(@Query() q: ReasonCodeListQuery) {
    return this.reasons.list(q);
  }

  @Get('next-code')
  @RequireScope('master:write')
  @ApiOkResponse({ type: NextCodeDto, description: 'รหัสที่ระบบจะออกให้เหตุผลใหม่ (`RSN-0001`)' })
  async nextCode(): Promise<NextCodeDto> {
    return { code: await this.reasons.nextCode() };
  }

  @Get('export')
  @RequireScope('export:run')
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv')
  @ApiOkResponse({
    description: 'ไฟล์ .xlsx หรือ .csv ตามตัวกรองเดียวกับรายการ (สูงสุด 10,000 แถว)',
  })
  async export(
    @Query() q: ReasonCodeExportQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const rows = await this.reasons.exportRows(q);
    return sendExport(res, q.format ?? 'xlsx', 'reason-codes', EXPORT_COLUMNS, rows);
  }

  @Post()
  @RequireScope('master:write')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: ReasonCodeDto })
  async create(
    @Body() body: CreateReasonCodeDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReasonCodeDto> {
    const r = await this.reasons.create(body);
    setEtag(res, r.version);
    return toReasonCodeDto(r);
  }

  @Put('external/:externalId')
  @RequireScope('master:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag — ใช้เมื่อแถวมีอยู่แล้ว' })
  @ApiOkResponse({
    type: ReasonCodeDto,
    description: 'มีอยู่แล้ว → อัปเดต (ส่งซ้ำได้ ไม่เกิดแถวใหม่)',
  })
  @ApiCreatedResponse({ type: ReasonCodeDto, description: 'ยังไม่มี → สร้าง' })
  async upsertExternal(
    @Param('externalId') externalId: string,
    @Body() body: UpsertReasonCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReasonCodeDto> {
    if (!/^[\x21-\x7e]{1,100}$/.test(externalId))
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'externalId',
          code: 'matches',
          message: 'externalId must be 1-100 printable ASCII',
        },
      ]);
    const { row, created } = await this.reasons.upsertExternal(
      externalId,
      body,
      expectedVersion(req),
    );
    res.status(created ? 201 : 200);
    setEtag(res, row.version);
    return toReasonCodeDto(row);
  }

  @Get(':id')
  @TenantResource('reasonCode')
  @RequireScope('master:read')
  @ApiOkResponse({ type: ReasonCodeDto })
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReasonCodeDto> {
    const r = await this.resolve(id);
    setEtag(res, r.version);
    return toReasonCodeDto(r);
  }

  @Get(':id/history')
  @TenantResource('reasonCode')
  @RequireScope('master:read')
  @ApiOkResponse({ type: AuditPageDto, description: 'ประวัติการแก้จาก audit log ใหม่สุดก่อน' })
  async history(@Param('id') id: string, @Query() q: HistoryQuery): Promise<AuditPageDto> {
    const r = await this.resolve(id);
    return entityHistory(this.db.tx, 'reason_code', r.id, q);
  }

  @Patch(':id')
  @TenantResource('reasonCode')
  @RequireScope('master:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: ReasonCodeDto })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateReasonCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReasonCodeDto> {
    const current = await this.resolve(id);
    const r = await this.reasons.update(current.id, body, expectedVersion(req));
    setEtag(res, r.version);
    return toReasonCodeDto(r);
  }

  /** ปิดใช้ (เหตุผล ≥ 10) — งานเดิมไม่กระทบ (snapshot) · รหัสระบบ → 409 `conflict` */
  @Post(':id/deactivate')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(200)
  @TenantResource('reasonCode')
  @RequireScope('master:write')
  @ApiOkResponse({ type: ReasonCodeDto })
  async deactivate(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReasonCodeDto> {
    const current = await this.resolve(id);
    const r = await this.reasons.changeStatus(
      current.id,
      'deactivate',
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, r.version);
    return toReasonCodeDto(r);
  }

  @Post(':id/activate')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(200)
  @TenantResource('reasonCode')
  @RequireScope('master:write')
  @ApiOkResponse({ type: ReasonCodeDto })
  async activate(
    @Param('id') id: string,
    @Body() body: MasterOptionalReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReasonCodeDto> {
    const current = await this.resolve(id);
    const r = await this.reasons.changeStatus(
      current.id,
      'activate',
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, r.version);
    return toReasonCodeDto(r);
  }

  /** "ลบ" (MD-004) — เฉพาะที่ไม่เคยถูกอ้างอิง → soft delete; ถูกอ้างอิง → 409 `in_use` · รหัสระบบ → 409 `conflict` */
  @Post(':id/delete')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(204)
  @TenantResource('reasonCode')
  @RequireScope('master:write')
  @ApiNoContentResponse()
  async remove(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
  ): Promise<void> {
    const current = await this.resolve(id);
    await this.reasons.remove(current.id, body.reason, expectedVersion(req));
  }
}
