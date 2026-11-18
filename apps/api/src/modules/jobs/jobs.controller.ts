import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { RequireScope, TenantResource } from '../../common/decorators';
import { decodeIdOr404 } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { EXPORT_JOB_TYPE } from '../exports/exports.service';
import { toJobDto } from '../../jobs/job-dto';

export class JobDto {
  @ApiProperty({ example: 'job_…' }) id!: string;
  @ApiProperty() type!: string;
  @ApiProperty({ enum: ['pending', 'running', 'succeeded', 'failed', 'skipped'] }) status!: string;
  @ApiProperty({ minimum: 0, maximum: 100 }) progress!: number;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true }) result!: unknown;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true }) error!: unknown;
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
    // งานส่งออก (ST9-T10) มีลิงก์ไฟล์ตามสิทธิ์ของผู้สั่ง — เห็นได้เฉพาะผู้สั่ง (สอดคล้องกับ GET /v1/exports/{id})
    if (
      j.type === EXPORT_JOB_TYPE &&
      (j.payload as { actorId?: string } | null)?.actorId !==
        (requestContext.require().actorId ?? null)
    )
      throw new ProblemException('not_found');
    return toJobDto(j);
  }
}
