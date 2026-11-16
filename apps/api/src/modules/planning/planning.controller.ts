import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { scopeAllows } from '@tms/domain';
import { RequireScope } from '../../common/decorators';
import { ProblemException } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import { requestContext } from '../../common/request-context';
import { isRealDate } from '../vehicle-documents/expiry';
import { T403, T422 } from '../trips/trip-problems';
import { PlanningBoardDto, PlanningBoardQuery } from './planning.dto';
import { PlanningService } from './planning.service';

/**
 * กระดานวางแผน (ST3-T12; docs/04 D2; spec/03 §5) — อ่านรวมในคำขอเดียว: แถวรถ + เที่ยวในช่วงวัน (ซ้อนเวลา ณ ตอนอ่าน)
 * + SO รอจัด · การลากวาง/ย้าย/ปรับขนาดเขียนผ่าน `/v1/trips` (POST, `/schedule`, `/attach`) ชุดเดียวกับลูกค้า
 * สิทธิ์: `trips:read` + `orders:read` (งานรอจัดมาจาก SO/DO)
 */
@ApiTags('planning')
@ApiBearerAuth()
@Controller('planning')
export class PlanningController {
  constructor(private readonly planning: PlanningService) {}

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
}
