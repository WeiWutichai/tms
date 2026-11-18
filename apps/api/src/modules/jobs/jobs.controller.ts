import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { scopeAllows } from '@tms/domain';
import { TenantResource } from '../../common/decorators';
import { decodeIdOr404 } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { EXPORT_JOB_TYPE } from '../exports/exports.service';
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
  @ApiOperation({
    description:
      'ต้องมี `jobs:read` (ดูทุกงานของบริษัท) **หรือ** เป็นผู้สั่งงานนั้นเอง (เช่น `POST /v1/orders:bulk` + `Prefer: respond-async` ' +
      'ด้วยสิทธิ์ `orders:write`) — ไม่มี `jobs:read` และไม่ใช่งานของตน = 403 `permission_denied` (ไม่บอกว่ามีงานนั้นหรือไม่)',
  })
  @ApiOkResponse({ type: JobDto })
  async get(@Param('id') id: string): Promise<JobDto> {
    const ctx = requestContext.require();
    const j = await this.db.tx.job.findUnique({ where: { id: decodeIdOr404('job', id) } });
    // งานส่งออก (ST9-T10) มีลิงก์ไฟล์ตามสิทธิ์ของผู้สั่ง — เห็นได้เฉพาะผู้สั่ง (สอดคล้องกับ GET /v1/exports/{id}):
    // คนอื่น = 404 เสมอ แม้มี jobs:read (ตรวจก่อนสิทธิ์ เพื่อไม่บอกว่ามีงานนั้น)
    if (j && j.type === EXPORT_JOB_TYPE && jobOwner(j.payload) !== (ctx.actorId ?? null))
      throw new ProblemException('not_found');
    // ST7-T10 [DECISION spec/12]: ผู้สั่งงาน async ดูงานของตัวเองได้โดยไม่ต้องมี jobs:read (statusUrl ของ 202)
    if (
      !scopeAllows(ctx.scopes ?? [], 'jobs:read') &&
      !(j && ctx.actorId && jobOwner(j.payload) === ctx.actorId)
    )
      throw new ProblemException('permission_denied', undefined, undefined, {
        module: 'jobs',
        action: 'read',
        required: ['jobs:read'],
      });
    if (!j) throw new ProblemException('not_found');
    return toJobDto(j);
  }
}

/** ผู้สั่งงานใน payload: bulk เก็บ `actor.actorId` · นำเข้าเก็บ `actorId` (ST1-T19) · งานระบบ = ไม่มี */
function jobOwner(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as { actor?: { actorId?: unknown }; actorId?: unknown };
  const id = p.actor?.actorId ?? p.actorId;
  return typeof id === 'string' && id ? id : null;
}
