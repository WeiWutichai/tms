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
import { RateLimitClass, RequireScope, TenantResource } from '../../common/decorators';
import { decodeIdOr404, encodeId } from '../../common/ids';
import { apiOrigin, readyDocumentDto } from '../documents/documents.controller';
import {
  errorCode,
  EXPORT_JOB_MAX_ROWS,
  EXPORT_RETENTION_DAYS,
  ExportsService,
  type ExportFormat,
  type ExportResult,
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
] as const;

export class CreateExportDto {
  @ApiProperty({ enum: EXPORT_RESOURCES, example: 'orders' })
  @IsIn([...EXPORT_RESOURCES])
  resource!: (typeof EXPORT_RESOURCES)[number];

  @ApiPropertyOptional({
    enum: ['xlsx', 'csv'],
    default: 'xlsx',
    description: '.xlsx (แนะนำ — เลข 0 นำหน้าไม่หาย) หรือ .csv UTF-8 + BOM',
  })
  @IsOptional()
  @IsIn(['xlsx', 'csv'])
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
  @ApiProperty({ enum: EXPORT_RESOURCES }) resource!: string;
  @ApiProperty({ enum: ['xlsx', 'csv'] }) format!: string;
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
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiAcceptedResponse({
    type: ExportAcceptedDto,
    description:
      'รับงานแล้ว — ต้องมี `export:run` + สิทธิ์อ่านของรายการนั้น (เช่น `orders:read`, `master:read`) · ' +
      `ไฟล์ไม่เกิน ${EXPORT_JOB_MAX_ROWS} แถว · คอลัมน์ราคา/การเงินเฉพาะผู้มีสิทธิ์เห็น`,
  })
  async create(@Body() body: CreateExportDto): Promise<ExportAcceptedDto> {
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
    const { job, payload, doc } = await this.exports.get(decodeIdOr404('job', id));
    res.setHeader('Cache-Control', 'private, no-store');
    const result = job.result as ExportResult | null;
    const expiresAt = job.finishedAt
      ? new Date(job.finishedAt.getTime() + EXPORT_RETENTION_DAYS * 86_400_000)
      : null;
    const succeeded = job.status === 'SUCCEEDED' && !!doc;
    const expired = succeeded && expiresAt !== null && expiresAt.getTime() <= Date.now();
    const status = expired
      ? 'expired'
      : job.status === 'SKIPPED'
        ? 'failed'
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
