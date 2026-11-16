import { Body, Controller, Get, Put, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { scopeAllows } from '@tms/domain';
import { RequireScope } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { PROBLEMS, ProblemException } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import { requestContext } from '../../common/request-context';
import { isRealDate } from '../vehicle-documents/expiry';
import { T403, T422 } from '../trips/trip-problems';
import { BoardPreferencesService } from './board-preferences.service';
import {
  BoardPreferencesDto,
  PlanningBoardDto,
  PlanningBoardQuery,
  UpdateBoardPreferencesDto,
} from './planning.dto';
import { PlanningService } from './planning.service';

const prob = (code: 'not_found' | 'precondition_failed') => ({
  type: `https://docs.tms.example/problems/${code}`,
  title: PROBLEMS[code].th,
  status: PROBLEMS[code].status,
  code,
  instance: '/v1/planning/board/preferences',
  requestId: 'b6a1c2d3-…',
});
const P404 = {
  status: 404,
  description: 'credential ไม่ใช่ผู้ใช้ (API key) — ไม่มีค่าส่วนตัว',
  examples: { not_found: prob('not_found') },
};
const P412 = {
  status: 412,
  description: 'If-Match ไม่ตรง version (บันทึกจากอีกแท็บ/เครื่อง)',
  examples: { precondition_failed: prob('precondition_failed') },
};

/**
 * กระดานวางแผน (ST3-T12; docs/04 D2; spec/03 §5) — อ่านรวมในคำขอเดียว: แถวรถ + เที่ยวในช่วงวัน (ซ้อนเวลา ณ ตอนอ่าน)
 * + SO รอจัด · การลากวาง/ย้าย/ปรับขนาดเขียนผ่าน `/v1/trips` (POST, `/schedule`, `/attach`) ชุดเดียวกับลูกค้า
 * สิทธิ์: `trips:read` + `orders:read` (งานรอจัดมาจาก SO/DO)
 */
@ApiTags('planning')
@ApiBearerAuth()
@Controller('planning')
export class PlanningController {
  constructor(
    private readonly planning: PlanningService,
    private readonly prefs: BoardPreferencesService,
  ) {}

  @Get('board')
  @ApiProblems(T403('trips:read'), T422)
  @RequireScope('trips:read')
  @ApiOkResponse({ type: PlanningBoardDto })
  async board(@Query() q: PlanningBoardQuery): Promise<PlanningBoardDto> {
    if (!scopeAllows(requestContext.require().scopes ?? [], 'orders:read'))
      throw new ProblemException('permission_denied', undefined, undefined, {
        module: 'orders',
        action: 'read',
        required: ['orders:read'],
      });
    if (q.date !== undefined && !isRealDate(q.date))
      throw new ProblemException('validation_failed', undefined, [
        { field: 'date', code: 'invalid_date', message: 'must be a real date (YYYY-MM-DD)' },
      ]);
    return this.planning.board(q);
  }

  /** มุมมอง + field บนการ์ดที่ผู้ใช้เลือกไว้ (ST3-T13) — ยังไม่เคยบันทึก = ค่าเริ่มต้น (FLEET + ทุก field, version 0) */
  @Get('board/preferences')
  @ApiProblems(T403('trips:read'), P404)
  @RequireScope('trips:read')
  @ApiOkResponse({ type: BoardPreferencesDto })
  async getPreferences(@Res({ passthrough: true }) res: Response): Promise<BoardPreferencesDto> {
    const p = await this.prefs.get();
    setEtag(res, p.version);
    return p;
  }

  /** บันทึกมุมมอง + field บนการ์ดของผู้ใช้ที่ login (แทนทั้งชุด) — จำข้ามเครื่อง/การ login */
  @Put('board/preferences')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiProblems(T403('trips:read'), P404, P412, T422)
  @RequireScope('trips:read')
  @ApiOkResponse({ type: BoardPreferencesDto })
  async putPreferences(
    @Body() body: UpdateBoardPreferencesDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BoardPreferencesDto> {
    const p = await this.prefs.put(body, expectedVersion(req));
    setEtag(res, p.version);
    return p;
  }
}
