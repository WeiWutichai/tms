import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { StopEvent } from '@prisma/client';
import type { StopEventType, StopOutcome } from '@tms/domain';
import { RequireScope, TenantResource } from '../../common/decorators';
import { decodeIdOr404, encodeId } from '../../common/ids';
import { PROBLEMS, type ProblemCode } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import type { ReasonSnapshot } from '../reason-codes/snapshot';
import {
  ArriveStopDto,
  CompleteStopDto,
  DepartStopDto,
  FailStopDto,
  StopEventDto,
  type StopEventBaseDto,
} from './stop-event.dto';
import { StopEventsService, type StopEventPayload } from './stop-events.service';

const num = (v: { toNumber(): number } | null) => (v === null ? null : v.toNumber());

export function toStopEventDto(e: StopEvent): StopEventDto {
  const p = (e.payload ?? {}) as StopEventPayload;
  const r: ReasonSnapshot | undefined = p.reason;
  return {
    id: encodeId('event', e.id),
    stopId: encodeId('tripStop', e.tripStopId),
    tripId: encodeId('trip', e.tripId),
    type: e.type,
    outcome: e.outcome,
    clientEventId: e.clientEventId,
    occurredAt: e.occurredAt.toISOString(),
    receivedAt: e.receivedAt.toISOString(),
    lat: num(e.lat),
    lng: num(e.lng),
    accuracyM: num(e.accuracyM),
    source: e.source,
    recordedBy: e.actor,
    reason: r
      ? {
          id: encodeId('reasonCode', r.sourceId),
          category: r.category,
          code: r.code,
          label: r.label,
        }
      : null,
    note: p.note ?? null,
  };
}

/** ตัวอย่าง problem+json ของ `/v1/stops` (OpenAPI) */
const P = (code: ProblemCode, extra: Record<string, unknown> = {}) => ({
  type: `https://docs.tms.example/problems/${code}`,
  title: PROBLEMS[code].th,
  status: PROBLEMS[code].status,
  code,
  instance: '/v1/stops/stp_3f2a…/arrive',
  requestId: 'b6a1c2d3-…',
  ...extra,
});
const S403 = {
  status: 403,
  description: 'ไม่มีสิทธิ์ (`trips:dispatch`)',
  examples: {
    permission_denied: P('permission_denied', {
      module: 'trips',
      action: 'dispatch',
      required: ['trips:dispatch'],
    }),
  },
};
const S404 = {
  status: 404,
  description: 'ไม่พบจุดแวะ (รวมของบริษัทอื่น และจุดที่ถอดออกจากเที่ยวแล้ว)',
  examples: { not_found: P('not_found') },
};
const S409 = {
  status: 409,
  description: 'เที่ยวไม่อยู่ระหว่างวิ่ง / clientEventId ซ้ำ / ชนกับการแก้ไขพร้อมกัน',
  examples: {
    trip_not_in_progress: P('trip_not_in_progress', { tripStatus: 'ASSIGNED' }),
    stop_event_duplicate: P('stop_event_duplicate', { eventId: 'evt_3f2a…' }),
    concurrent_update: P('concurrent_update'),
    idempotency_in_progress: P('idempotency_in_progress'),
  },
};
const S422 = {
  status: 422,
  description: 'ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง',
  examples: {
    validation_failed: P('validation_failed', {
      errors: [
        { field: 'reasonCodeId', code: 'required', message: 'reason is required for FAIL' },
        { field: 'outcome', code: 'required', message: 'outcome required for COMPLETE' },
      ],
    }),
    idempotency_mismatch: P('idempotency_mismatch'),
  },
};

/**
 * จุดแวะ — action หน้างาน (ST4-T01; docs/01 §5.2 #3 `POST /stops/{id}/arrive|depart|complete|fail`, docs/04 E1)
 * แต่ละคำขอ = event 1 แถวใน `stop_event` (append-only) พร้อม `occurredAt` (เครื่อง) + `receivedAt` (server)
 * สิทธิ์: `trips:dispatch` (docs/04 A3 "Trip: assign / dispatch / ปิด" — ผู้จ่ายงาน/ผู้จัดการ/ผู้ดูแล บันทึกแทนคนขับ)
 * ลิงก์รถร่วม (ST4-T08) และแอปคนขับ (P1) เรียก service เดียวกันโดย source = LINK / APP
 * สถานะจุด/เที่ยว/DO ยังไม่เปลี่ยนจาก event (ST4-T03)
 */
@ApiTags('stops')
@ApiBearerAuth()
@Controller('stops')
export class StopsController {
  constructor(private readonly events: StopEventsService) {}

  private async record(
    id: string,
    type: StopEventType,
    body: StopEventBaseDto & { outcome?: StopOutcome | null },
  ) {
    const e = await this.events.record(decodeIdOr404('tripStop', id), type, body);
    return toStopEventDto(e);
  }

  @Post(':id/arrive')
  @ApiOperation({ summary: 'ถึงจุด' })
  @ApiProblems(S403, S404, S409, S422)
  @HttpCode(201)
  @TenantResource('tripStop')
  @RequireScope('trips:dispatch')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: StopEventDto })
  arrive(@Param('id') id: string, @Body() body: ArriveStopDto): Promise<StopEventDto> {
    return this.record(id, 'ARRIVE', body);
  }

  @Post(':id/depart')
  @ApiOperation({ summary: 'ออกเดินทางมุ่งหน้าไปจุดนี้ (docs/01 §3.9 DEPART)' })
  @ApiProblems(S403, S404, S409, S422)
  @HttpCode(201)
  @TenantResource('tripStop')
  @RequireScope('trips:dispatch')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: StopEventDto })
  depart(@Param('id') id: string, @Body() body: DepartStopDto): Promise<StopEventDto> {
    return this.record(id, 'DEPART', body);
  }

  @Post(':id/complete')
  @ApiOperation({
    summary: 'ปิดงานที่จุด พร้อมผล (ส่งสำเร็จ / บางส่วน / ไม่สำเร็จ / ของยังอยู่บนรถ)',
  })
  @ApiProblems(S403, S404, S409, S422)
  @HttpCode(201)
  @TenantResource('tripStop')
  @RequireScope('trips:dispatch')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: StopEventDto })
  complete(@Param('id') id: string, @Body() body: CompleteStopDto): Promise<StopEventDto> {
    return this.record(id, 'COMPLETE', body);
  }

  @Post(':id/fail')
  @ApiOperation({ summary: 'ส่งไม่สำเร็จ (เหตุผลบังคับ)' })
  @ApiProblems(S403, S404, S409, S422)
  @HttpCode(201)
  @TenantResource('tripStop')
  @RequireScope('trips:dispatch')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: StopEventDto })
  fail(@Param('id') id: string, @Body() body: FailStopDto): Promise<StopEventDto> {
    return this.record(id, 'FAIL', body);
  }
}
