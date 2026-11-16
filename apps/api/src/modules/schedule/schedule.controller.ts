import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RequireScope, TenantResource } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404 } from '../../common/ids';
import { ApiProblems } from '../../common/problem.dto';
import { PROBLEMS, type ProblemCode } from '../../common/problem';
import { T403, T412, T422 } from '../trips/trip-problems';
import {
  CancelScheduleEntryDto,
  CreateScheduleEntryDto,
  ScheduleEntryDto,
  ScheduleEntryListDto,
  ScheduleEntryListQuery,
} from './schedule.dto';
import { ScheduleService, toDto } from './schedule.service';

const P = (code: ProblemCode, extra: Record<string, unknown> = {}) => ({
  type: `https://docs.tms.example/problems/${code}`,
  title: PROBLEMS[code].th,
  status: PROBLEMS[code].status,
  code,
  instance: '/v1/schedule-entries/sch_3f2a…',
  requestId: 'b6a1c2d3-…',
  ...extra,
});
const S404 = {
  status: 404,
  description: 'ไม่พบรายการ (รวมของบริษัทอื่น)',
  examples: { not_found: P('not_found') },
};
const S409 = {
  status: 409,
  description: 'วันลาทับวันลาเดิมของคนขับ (`conflict`) / ยกเลิกไปแล้ว (`invalid_state_transition`)',
  examples: {
    conflict: P('conflict', {
      detail: 'มีวันลาของคนขับคนนี้ทับช่วงนี้อยู่แล้ว (2026-11-18 – 2026-11-19)',
    }),
    invalid_state_transition: P('invalid_state_transition', { detail: 'รายการนี้ถูกยกเลิกแล้ว' }),
  },
};

/**
 * ตารางรถ/คนขับรายวัน (ST3-T19; docs/04 D2) — วันลาคนขับ / โน้ตรายวันของคนขับหรือรถ
 * สิทธิ์: อ่าน `trips:read` (ชุดเดียวกับกระดาน) · เพิ่ม/ยกเลิก `trips:assign` (ผู้จัดรถ — คลิกขวาบนกระดาน)
 * กระดาน (`GET /v1/planning/board`) คืนรายการชุดเดียวกันใน `schedule`
 */
@ApiTags('schedule')
@ApiBearerAuth()
@Controller('schedule-entries')
export class ScheduleController {
  constructor(private readonly schedule: ScheduleService) {}

  @Get()
  @ApiProblems(T403('trips:read'), T422)
  @RequireScope('trips:read')
  @ApiOkResponse({
    type: ScheduleEntryListDto,
    description: 'รายการที่ยังไม่ยกเลิกซึ่งทับช่วง from–to (≤ 62 วัน) เรียงวันเริ่ม',
  })
  async list(@Query() q: ScheduleEntryListQuery): Promise<ScheduleEntryListDto> {
    return { data: await this.schedule.list(q) };
  }

  @Post()
  @ApiProblems(T403('trips:assign'), S409, T422)
  @RequireScope('trips:assign')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({
    type: ScheduleEntryDto,
    description:
      'ใส่วันลา/โน้ต — วันลาทับวันลาเดิมของคนขับคนเดียวกัน → 409 `conflict` (`existing`) · ใส่วันลาแล้วตรวจกฎเที่ยวที่ยังไม่จบของคนขับในช่วงนั้นใหม่',
  })
  async create(
    @Body() body: CreateScheduleEntryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ScheduleEntryDto> {
    const e = await this.schedule.create(body);
    setEtag(res, e.version);
    return e;
  }

  @Get(':id')
  @TenantResource('scheduleEntry')
  @ApiProblems(T403('trips:read'), S404)
  @RequireScope('trips:read')
  @ApiOkResponse({ type: ScheduleEntryDto })
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ScheduleEntryDto> {
    const e = toDto(await this.schedule.get(decodeIdOr404('scheduleEntry', id)));
    setEtag(res, e.version);
    return e;
  }

  /** ยกเลิกวันลา/โน้ต (ไม่ลบ) — เหตุผล ≥ 10 ตัวอักษร ลง audit */
  @Post(':id/cancel')
  @HttpCode(200)
  @TenantResource('scheduleEntry')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiProblems(T403('trips:assign'), S404, S409, T412, T422)
  @RequireScope('trips:assign')
  @ApiOkResponse({ type: ScheduleEntryDto })
  async cancel(
    @Param('id') id: string,
    @Body() body: CancelScheduleEntryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ScheduleEntryDto> {
    const e = await this.schedule.cancel(
      decodeIdOr404('scheduleEntry', id),
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, e.version);
    return e;
  }
}
