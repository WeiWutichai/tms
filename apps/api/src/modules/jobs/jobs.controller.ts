import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { RequireScope, TenantResource } from '../../common/decorators';
import { decodeIdOr404, encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { toJobDto } from '../../jobs/job-dto';

export class JobDto {
  @ApiProperty({ example: 'job_…' }) id!: string;
  @ApiProperty() type!: string;
  @ApiProperty({
    enum: ['pending', 'running', 'succeeded', 'succeeded_with_errors', 'failed', 'skipped'],
    description:
      '`succeeded_with_errors` = ทำครบแต่บางรายการไม่ผ่าน (bulk — ดู `result.results[]`) · `failed` = งานล้มทั้งงาน · client ต้องรับค่าที่ไม่รู้จักได้',
  })
  status!: string;
  @ApiProperty({ minimum: 0, maximum: 100 }) progress!: number;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true }) result!: unknown;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true }) error!: unknown;
  @ApiProperty() attempts!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) finishedAt!: string | null;
}

/**
 * สถานะงาน async (docs/01 §5.1 Bulk/async: 202 {jobId, statusUrl} → GET /v1/jobs/{id})
 * งานที่ client สั่ง (นำเข้า, bulk) เก็บ 7 วันหลังจบ แล้วลบ → 404 (ST7-T10)
 */
@ApiTags('jobs')
@ApiBearerAuth()
@Controller('jobs')
export class JobsController {
  constructor(private readonly db: DbService) {}

  @Get(':id')
  @TenantResource('job')
  @RequireScope('jobs:read')
  @ApiOkResponse({ type: JobDto })
  async get(@Param('id') id: string): Promise<JobDto> {
    const j = await this.db.tx.job.findUnique({ where: { id: decodeIdOr404('job', id) } });
    if (!j) throw new ProblemException('not_found');
    return toJobDto(j);
  }
}
