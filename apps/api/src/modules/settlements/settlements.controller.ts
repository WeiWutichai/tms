import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireScope } from '../../common/decorators';
import { ProblemException } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import { T403, T422 } from '../trips/trip-problems';
import { isRealDate } from '../vehicle-documents/expiry';
import { SettlementQueuePageDto, SettlementQueueQuery } from './settlement-queue.dto';
import { SettlementQueueService } from './settlement-queue.service';

/**
 * Settlement รถร่วม (AP — docs/04 F6, docs/01 §4.5, §5.2 #12 `settlements`)
 * ST6-T02: คิวจ่ายรถร่วม — สร้างใบ/อนุมัติ/จ่าย = ST6-T03…
 */
@ApiTags('settlements')
@ApiBearerAuth()
@Controller('settlements')
export class SettlementsController {
  constructor(private readonly queue: SettlementQueueService) {}

  @Get('queue')
  @RequireScope('settlements:read')
  @ApiOperation({
    summary: 'คิวจ่ายรถร่วม (เที่ยวที่ปิดต้นทุนแล้วและยังไม่อยู่ในใบสำคัญจ่าย)',
    description:
      'เที่ยว **COSTED** ของรถร่วมที่ยังมีบรรทัดต้นทุนรอจ่าย (ค่าจ้าง CARRIER_FEE + ค่าใช้จ่ายหน้างานฝั่งซื้อที่ยืนยันแล้ว ของรถร่วมรายปัจจุบัน ' +
      'ที่ยังไม่อยู่ในใบสำคัญจ่าย) · รถร่วมที่ตั้ง "ไม่มี POD ไม่จ่าย" (`requirePodToPay`) → เที่ยวที่หลักฐานส่งยังไม่ครบไม่ขึ้นคิว · ' +
      'กรองรถร่วม (`carrierId` รับ `ext:`) / ช่วงวันที่เที่ยวจบ (เวลาไทย) / หลักฐานครบ · `carriers` = ยอดรวมต่อรถร่วมของทุกแถวที่ตรงตัวกรอง · ' +
      'ยอดเงิน (`buy*`) เห็นเมื่อมี `prices.buy:read` · ปิดต้นทุนเที่ยว (COMPLETED → COSTED) ยังปิดใช้จนกว่าจะกำหนดวิธีปันต้นทุนลง DO ' +
      '(`POST /trips/{id}/cost` → 409 `trip_costing_unavailable`) — ระหว่างนั้นคิวว่าง',
  })
  @ApiProblems(T403('settlements:read'), T422)
  @ApiOkResponse({ type: SettlementQueuePageDto })
  async list(@Query() q: SettlementQueueQuery): Promise<SettlementQueuePageDto> {
    const bad = (['dateFrom', 'dateTo'] as const).flatMap((f) =>
      q[f] !== undefined && !isRealDate(q[f]!)
        ? [{ field: f, code: 'invalid_date', message: 'must be a real date (YYYY-MM-DD)' }]
        : [],
    );
    if (q.dateFrom && q.dateTo && !bad.length && q.dateFrom > q.dateTo)
      bad.push({ field: 'dateTo', code: 'before_date_from', message: 'dateTo must be ≥ dateFrom' });
    if (bad.length) throw new ProblemException('validation_failed', undefined, bad);
    return this.queue.list(q);
  }
}
