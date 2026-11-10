import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { RequireScope, TenantResource } from '../../common/decorators';
import { decodeIdOr404, encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { DbService } from '../../db/db.service';

export class JobDto {
  @ApiProperty({ example: 'job_…' }) id!: string;
  @ApiProperty() type!: string;
  @ApiProperty({ enum: ['pending', 'running', 'succeeded', 'failed', 'skipped'] }) status!: string;
  @ApiProperty({ minimum: 0, maximum: 100 }) progress!: number;
  @ApiProperty({ nullable: true, type: Object }) result!: unknown;
  @ApiProperty({ nullable: true, type: Object }) error!: unknown;
  @ApiProperty() attempts!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) finishedAt!: string | null;
}

/** สถานะงาน async (docs/01 §5.1 Bulk/async: 202 {jobId, statusUrl} → GET /v1/jobs/{id}) */
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
    return {
      id: encodeId('job', j.id),
      type: j.type,
      status: j.status.toLowerCase(),
      progress: j.progress,
      result: j.result,
      error: j.error,
      attempts: j.attempts,
      createdAt: j.createdAt.toISOString(),
      finishedAt: j.finishedAt?.toISOString() ?? null,
    };
  }
}
