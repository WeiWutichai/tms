import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireScope, TenantResource } from '../../common/decorators';
import { decodeIdOr404, encodeId } from '../../common/ids';
import { PROBLEMS, type ProblemCode } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import {
  ResolveStopEventFlagDto,
  StopEventFlagDto,
  StopEventFlagListQuery,
  StopEventFlagPageDto,
  StopEventFlagSummaryDto,
} from './stop-event.dto';
import { flagsOf, StopEventsService, type FLAG_INCLUDE } from './stop-events.service';
import { toResolutionDto, toStopEventDto } from './stops.controller';
import type { Prisma } from '@prisma/client';

type FlagRow = Prisma.StopEventGetPayload<{ include: typeof FLAG_INCLUDE }> & {
  stateBefore?: string | null;
};

export function toFlagDto(r: FlagRow, names: Map<string, string> = new Map()): StopEventFlagDto {
  const dos = r.tripStop.type === 'PICKUP' ? r.tripStop.pickupOrders : r.tripStop.deliveryOrders;
  const res = r.resolutions[0];
  return {
    id: encodeId('event', r.id),
    event: toStopEventDto(r),
    flags: res ? res.flags : flagsOf(r),
    status: res ? 'RESOLVED' : 'OPEN',
    tripId: encodeId('trip', r.tripId),
    tripNo: r.trip.tripNo,
    tripStatus: r.trip.status,
    stopId: encodeId('tripStop', r.tripStopId),
    stopSequence: r.tripStop.sequence,
    stopType: r.tripStop.type,
    siteName: r.tripStop.site.name,
    vehiclePlate: r.trip.vehiclePlateSnapshot,
    customerName: dos[0]?.customer.legalName ?? r.tripStop.site.customer?.legalName ?? null,
    doNos: dos.flatMap((d) => (d.doNo ? [d.doNo] : [])),
    stateBefore: r.stateBefore ?? null,
    resolution: toResolutionDto(res),
    recordedByName: (r.actor && names.get(r.actor)) ?? null,
    resolvedByName: (res?.resolvedBy && names.get(res.resolvedBy)) ?? null,
  };
}

const actorsOf = (rows: FlagRow[]) =>
  rows.flatMap((r) => [r.actor, r.resolutions[0]?.resolvedBy ?? null]);

const P = (code: ProblemCode, extra: Record<string, unknown> = {}) => ({
  type: `https://docs.tms.example/problems/${code}`,
  title: PROBLEMS[code].th,
  status: PROBLEMS[code].status,
  code,
  instance: '/v1/stop-event-flags/evt_3f2a…/resolve',
  requestId: 'b6a1c2d3-…',
  ...extra,
});
const F403 = (scope: 'trips:read' | 'trips:dispatch') => ({
  status: 403,
  description: `ไม่มีสิทธิ์ (\`${scope}\`)`,
  examples: {
    permission_denied: P('permission_denied', {
      module: 'trips',
      action: scope.split(':')[1],
      required: [scope],
    }),
  },
});

/**
 * ธงของ stop event ให้ผู้จัดรถตัดสิน (ST4-T02; docs/04 E1 "ขัดแย้ง → เก็บทั้งคู่ + flag ให้ dispatcher ตัดสิน") — หน้า ศูนย์ข้อยกเว้น
 * ธง: LATE (มาหลังจุดถูกถอด/เที่ยวยกเลิก/จบ — spec/04 DRV-072/075) · SEQUENCE_CONFLICT (ขัด state machine เมื่อเรียงตาม occurredAt)
 * · CLOCK_SKEW (เวลาเครื่องเพี้ยน — docs/01 §3.9) · การตัดสิน = แถวใหม่ `stop_event_resolution` + เหตุผล + audit
 * ศูนย์ข้อยกเว้นเต็มรูป (SLA/ผู้รับผิดชอบ/ประเภทอื่น — spec/04 §2) อยู่นอกเฟส 0 (plan/01 ผู้สมัครเพิ่ม #11)
 */
@ApiTags('stops')
@ApiBearerAuth()
@Controller('stop-event-flags')
export class StopEventFlagsController {
  constructor(private readonly events: StopEventsService) {}

  @Get()
  @ApiOperation({ summary: 'รายการธงของ stop event (ล่าสุดก่อน)' })
  @ApiProblems(F403('trips:read'))
  @RequireScope('trips:read')
  @ApiOkResponse({ type: StopEventFlagPageDto })
  async list(@Query() q: StopEventFlagListQuery): Promise<StopEventFlagPageDto> {
    const page = await this.events.listFlags(q);
    const names = await this.events.userNames(actorsOf(page.rows));
    return {
      data: page.rows.map((r) => toFlagDto(r, names)),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  @Get('summary')
  @ApiOperation({ summary: 'ตัวเลขสรุปธง (ใหม่ / ตัดสินแล้ว / ตัดสินแล้ววันนี้)' })
  @ApiProblems(F403('trips:read'))
  @RequireScope('trips:read')
  @ApiOkResponse({ type: StopEventFlagSummaryDto })
  summary(): Promise<StopEventFlagSummaryDto> {
    return this.events.flagSummary();
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'ตัดสินธง: ใช้ (ACCEPT) / ไม่ใช้ (IGNORE) event นี้ — เหตุผลบังคับ',
    description:
      'สร้างแถวใหม่ใน `stop_event_resolution` (ไม่แก้ event) + audit `stop_event.resolve` แล้วคำนวณลำดับของจุดใหม่ · ตัดสินได้ครั้งเดียวต่อ event',
  })
  @ApiProblems(
    F403('trips:dispatch'),
    {
      status: 404,
      description: 'ไม่พบ event (รวมของบริษัทอื่น)',
      examples: { not_found: P('not_found') },
    },
    {
      status: 409,
      description: 'ไม่มีธงให้ตัดสิน / ตัดสินไปแล้ว',
      examples: {
        stop_event_not_flagged: P('stop_event_not_flagged'),
        stop_event_already_resolved: P('stop_event_already_resolved'),
      },
    },
    {
      status: 422,
      description: 'ข้อมูลไม่ถูกต้อง',
      examples: {
        validation_failed: P('validation_failed', {
          errors: [{ field: 'reason', code: 'minLength', message: 'reason must be ≥ 10 chars' }],
        }),
      },
    },
  )
  @TenantResource('stopEvent')
  @RequireScope('trips:dispatch')
  @ApiOkResponse({ type: StopEventFlagDto })
  async resolve(
    @Param('id') id: string,
    @Body() body: ResolveStopEventFlagDto,
  ): Promise<StopEventFlagDto> {
    const e = await this.events.resolve(decodeIdOr404('event', id), body.decision, body.reason);
    const row = await this.events.flagById(e.id);
    return toFlagDto(row, await this.events.userNames(actorsOf([row])));
  }
}
