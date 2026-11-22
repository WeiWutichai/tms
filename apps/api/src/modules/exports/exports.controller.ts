import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional } from 'class-validator';
import type { Request, Response } from 'express';
import { RateLimitClass, RequireScope, StepUpWhen, TenantResource } from '../../common/decorators';
import { assertHumanStepUp, exportNeedsStepUp, EXPORT_STEP_UP_WHEN } from '../../auth/step-up';
import { decodeIdOr404, encodeId } from '../../common/ids';
import { apiOrigin, readyDocumentDto } from '../documents/documents.controller';
import {
  errorCode,
  EXPORT_JOB_MAX_ROWS,
  EXPORT_RETENTION_DAYS,
  ExportsService,
  type ExportFormat,
} from './exports.service';

/** resource ที่ส่งออกตามตัวกรองได้ (ST9-T10) — ตรงกับ `GET /v1/{resource}` ของรายการ (orders รวมหน้าใบค้าง: `held=true`) */
export const EXPORT_RESOURCES = [
  'orders',
  'customers',
  'customer-sites',
  'carriers',
  'vehicles',
  'vehicle-documents',
  'drivers',
  'vehicle-types',
  'routes',
  'products',
  'service-items',
  'rate-cards',
  'reason-codes',
  // ST9-T06 รายงาน (หน้า รายงาน → ส่งออก Excel)
  'unbilled-delivery-orders',
  'receivables-aging',
  // ST9-T05 รายงานรายได้ (xlsx / csv / pdf)
  'revenue',
  // ST7-T23 ส่งออกให้นักบัญชี (layout กลาง ผ่าน FileExportAdapter — ตัวกรอง dateFrom/dateTo/template)
  'accounting-sales',
  'accounting-receipts',
  'accounting-settlements',
] as const;

/** resource ของไฟล์ที่ระบบสร้างเองจากงานอื่น (ไม่รับใน `POST /exports`) — ST5-T12b ไฟล์สรุปรอบวางบิล */
export const INVOICE_RUN_SUMMARY_RESOURCE = 'invoice-run-summary';
/** ค่าที่ `GET /v1/exports/{id}` ตอบใน `resource` */
export const EXPORT_FILE_RESOURCES = [...EXPORT_RESOURCES, INVOICE_RUN_SUMMARY_RESOURCE] as const;

export class CreateExportDto {
  @ApiProperty({ enum: EXPORT_RESOURCES, example: 'orders' })
  @IsIn([...EXPORT_RESOURCES])
  resource!: (typeof EXPORT_RESOURCES)[number];

  @ApiPropertyOptional({
    enum: ['xlsx', 'csv', 'pdf'],
    default: 'xlsx',
    description:
      '.xlsx (แนะนำ — เลข 0 นำหน้าไม่หาย) หรือ .csv UTF-8 + BOM · `pdf` (ตาราง A4 ≤ 2,000 แถว) เฉพาะรายงานสรุป — resource `revenue` (อื่น ๆ = 422)',
  })
  @IsOptional()
  @IsIn(['xlsx', 'csv', 'pdf'])
  format?: ExportFormat;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { held: 'true', holdReason: 'RATE_MISSING' },
    description:
      'ตัวกรองชุดเดียวกับ query ของ `GET /v1/{resource}` (ค่าเป็น string) — ตรวจกติกาเดียวกัน (field แปลก = 422) · ' +
      '`limit`/`cursor`/`sort`/`fields`/`updatedAfter` ไม่มีผล (ไฟล์มีทุกแถวที่ตรงตัวกรอง)',
  })
  @IsOptional()
  @IsObject()
  filter?: Record<string, string>;
}

export class ExportAcceptedDto {
  @ApiProperty({ example: 'job_…' }) id!: string;
  @ApiProperty({ example: 'job_…' }) jobId!: string;
  @ApiProperty({ example: '/v1/exports/job_…' }) statusUrl!: string;
  @ApiProperty({ enum: ['pending'] }) status!: string;
}

export class ExportErrorDto {
  @ApiProperty({
    enum: ['too_many_rows', 'permission_denied', 'failed'],
    description: `too_many_rows = เกิน ${EXPORT_JOB_MAX_ROWS} แถว (กรองให้แคบลง)`,
  })
  code!: string;
}

export class ExportDto {
  @ApiProperty({ example: 'job_…' }) id!: string;
  @ApiProperty({
    enum: EXPORT_FILE_RESOURCES,
    description:
      '`invoice-run-summary` = ไฟล์สรุปรอบวางบิล (สร้างเองเมื่อ `POST /v1/invoice-runs` จบ — `id` = jobId ของรอบ; สั่งผ่าน `POST /exports` ไม่ได้)',
  })
  resource!: string;
  @ApiProperty({ enum: ['xlsx', 'csv', 'pdf'] }) format!: string;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  filter!: Record<string, string>;
  @ApiProperty({
    enum: ['pending', 'running', 'succeeded', 'failed', 'expired'],
    description: `expired = ไฟล์เกิน ${EXPORT_RETENTION_DAYS} วันแล้ว (ส่งออกใหม่)`,
  })
  status!: string;
  @ApiProperty({ minimum: 0, maximum: 100 }) progress!: number;
  @ApiProperty({ nullable: true, type: Number }) rows!: number | null;
  @ApiProperty({ nullable: true, type: String }) fileName!: string | null;
  @ApiProperty({ nullable: true, type: Number }) bytes!: number | null;
  @ApiProperty({ nullable: true, type: ExportErrorDto }) error!: ExportErrorDto | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) finishedAt!: string | null;
  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description: `ไฟล์ดาวน์โหลดได้ถึงเวลานี้ (${EXPORT_RETENTION_DAYS} วันหลังเสร็จ)`,
  })
  expiresAt!: string | null;
  @ApiPropertyOptional({
    description: 'สถานะ succeeded: ลิงก์ดาวน์โหลด (หมดอายุ 5 นาที — เรียกใหม่ได้)',
  })
  downloadUrl?: string;
  @ApiPropertyOptional({ format: 'date-time' }) urlExpiresAt?: string;
}

/**
 * ส่งออกตามตัวกรองของหน้ารายการ (ST9-T10; docs/04 I "export ตาม filter; งานใหญ่ background + แจ้งเมื่อเสร็จ")
 * ทุกขนาดวิ่งเป็น job (docs/01 §5.1 Bulk/async: 202 + statusUrl) — เสร็จแล้วแจ้งเตือนผู้สั่งพร้อมลิงก์ดาวน์โหลด
 * ส่งออกทันทีแบบเดิม (≤ 10,000 แถว) ยังใช้ `GET /v1/{master}/export` ได้
 */
@ApiTags('exports')
@ApiBearerAuth()
@Controller('exports')
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Post()
  @HttpCode(202)
  @RateLimitClass('heavy')
  @RequireScope('export:run')
  @StepUpWhen(EXPORT_STEP_UP_WHEN)
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiAcceptedResponse({
    type: ExportAcceptedDto,
    description:
      'รับงานแล้ว — ต้องมี `export:run` + สิทธิ์อ่านของรายการนั้น (เช่น `orders:read`, `master:read`) · ' +
      `ไฟล์ไม่เกิน ${EXPORT_JOB_MAX_ROWS} แถว · คอลัมน์ราคา/การเงินเฉพาะผู้มีสิทธิ์เห็น`,
  })
  async create(@Body() body: CreateExportDto): Promise<ExportAcceptedDto> {
    if (exportNeedsStepUp(body.resource, body.filter ?? {})) assertHumanStepUp();
    const job = await this.exports.create({
      resource: body.resource,
      format: body.format ?? 'xlsx',
      filter: body.filter ?? {},
    });
    const id = encodeId('job', job.id);
    return { id, jobId: id, statusUrl: `/v1/exports/${id}`, status: 'pending' };
  }

  @Get(':id')
  @TenantResource('export')
  @RequireScope('export:run')
  @ApiOkResponse({ type: ExportDto, description: 'งานส่งออกของผู้เรียกเท่านั้น (ของคนอื่น = 404)' })
  async get(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ExportDto> {
    const { job, payload, doc, result } = await this.exports.get(decodeIdOr404('job', id));
    res.setHeader('Cache-Control', 'private, no-store');
    const expiresAt = job.finishedAt
      ? new Date(job.finishedAt.getTime() + EXPORT_RETENTION_DAYS * 86_400_000)
      : null;
    // งานที่ผลิตไฟล์เป็นผลพลอยได้ (สรุปรอบวางบิล) จบแบบ SUCCEEDED_WITH_ERRORS ได้ — ไฟล์ยังพร้อมดาวน์โหลด
    const finished = job.status === 'SUCCEEDED' || job.status === 'SUCCEEDED_WITH_ERRORS';
    const succeeded = finished && !!doc;
    const expired = succeeded && expiresAt !== null && expiresAt.getTime() <= Date.now();
    const status = expired
      ? 'expired'
      : job.status === 'SKIPPED'
        ? 'failed'
        : finished
          ? 'succeeded'
          : job.status.toLowerCase();
    const dto: ExportDto = {
      id: encodeId('job', job.id),
      resource: payload.resource,
      format: payload.format,
      filter: payload.filter ?? {},
      status,
      progress: job.progress,
      rows: result?.rows ?? null,
      fileName: result?.fileName ?? null,
      bytes: result?.bytes ?? null,
      error:
        job.status === 'FAILED' || job.status === 'SKIPPED'
          ? { code: errorCode((job.error as { message?: string } | null)?.message) ?? 'failed' }
          : null,
      createdAt: job.createdAt.toISOString(),
      finishedAt: job.finishedAt?.toISOString() ?? null,
      expiresAt: succeeded ? (expiresAt?.toISOString() ?? null) : null,
    };
    if (succeeded && !expired) {
      const d = readyDocumentDto(doc, apiOrigin(req));
      dto.downloadUrl = d.downloadUrl!;
      dto.urlExpiresAt = d.urlExpiresAt!;
    }
    return dto;
  }
}
