import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { StopEvent, StopEventResolution } from '@prisma/client';
import type { StopEventType, StopOutcome } from '@tms/domain';
import type { Response } from 'express';
import { RequireScope, TenantResource } from '../../common/decorators';
import { decodeIdOr404, encodeId } from '../../common/ids';
import { PROBLEMS, ProblemException, type ProblemCode } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import type { ReasonSnapshot } from '../reason-codes/snapshot';
import {
  ArriveStopDto,
  CompleteStopDto,
  DepartStopDto,
  FailStopDto,
  StopEventDto,
  StopDto,
  StopEventSequenceDto,
  TripTimelineDto,
  type StopEventBaseDto,
} from './stop-event.dto';
import { flagsOf, StopEventsService, type StopEventPayload } from './stop-events.service';

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
    appliedAt: e.appliedAt?.toISOString() ?? null,
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
    photoDocumentIds: (p.photoDocumentIds ?? []).map((d) => encodeId('document', d)),
    sequenceConflict: e.sequenceConflict,
    clockSkew: e.clockSkew,
    lateReason: e.lateReason,
    flags: flagsOf(e),
  };
}

export function toResolutionDto(r: StopEventResolution | undefined) {
  return r
    ? {
        decision: r.decision,
        reason: r.reason,
        flags: r.flags,
        resolvedBy: r.resolvedBy,
        resolvedAt: r.createdAt.toISOString(),
      }
    : null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

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
const T403R = {
  status: 403,
  description: 'ไม่มีสิทธิ์ (`trips:read`)',
  examples: {
    permission_denied: P('permission_denied', {
      module: 'trips',
      action: 'read',
      required: ['trips:read'],
    }),
  },
};
const S404 = {
  status: 404,
  description:
    'ไม่พบจุดแวะ (รวมของบริษัทอื่น) — จุดที่ถอดออกแล้วยังรับ event ได้ (ธง LATE: STOP_REMOVED)',
  examples: { not_found: P('not_found') },
};
const S409 = {
  status: 409,
  description:
    'เที่ยวยังไม่ปล่อยรถ / clientEventId ถูกใช้กับ event อื่น (คนละจุดหรือคนละชนิด) / ชนกับการแก้ไขพร้อมกัน',
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
 * ST4-T03: ทุก event ใหม่ไล่สถานะจุด → เที่ยว → DO → SO ในคำขอเดียวกัน (`StopProjectionService`)
 */
@ApiTags('stops')
@ApiBearerAuth()
@Controller('stops')
export class StopsController {
  constructor(private readonly events_: StopEventsService) {}

  /** สร้างใหม่ = 201 · ส่งซ้ำ (clientEventId + จุด + ชนิดเดิม) = 200 + event เดิม (ST4-T02; spec/04 DRV-061) */
  private async record(
    id: string,
    type: StopEventType,
    body: StopEventBaseDto & { outcome?: StopOutcome | null },
    res: Response,
  ) {
    const { event, replayed } = await this.events_.record(
      decodeIdOr404('tripStop', id),
      type,
      body,
    );
    res.status(replayed ? 200 : 201);
    return toStopEventDto(event);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'จุดแวะเดียว — สถานะ เวลา และ DO ที่รับ/ส่งที่จุดนี้',
    description:
      'ST7-T11 (docs/04 G2 #3 `GET`): สถานะ/เวลาเป็นค่าที่ไล่จาก event แล้ว (projection ST4-T03) · จุดที่ถอดออกแล้วยังเปิดได้ (`removedAt`) · ' +
      'ลำดับ event ทั้งหมด `GET /v1/stops/{id}/events` · จุดทั้งเที่ยว `GET /v1/trips/{id}` (`stops[]`)',
  })
  @ApiProblems(
    {
      ...T403R,
      examples: {
        permission_denied: P('permission_denied', {
          module: 'trips',
          action: 'read',
          required: ['trips:read'],
          instance: '/v1/stops/stp_3f2a…',
        }),
      },
    },
    {
      ...S404,
      description: 'ไม่พบจุดแวะ (รวมของบริษัทอื่น)',
      examples: { not_found: P('not_found', { instance: '/v1/stops/stp_3f2a…' }) },
    },
  )
  @TenantResource('tripStop')
  @RequireScope('trips:read')
  @ApiOkResponse({ type: StopDto })
  async get(@Param('id') id: string): Promise<StopDto> {
    const s = await this.events_.stopView(decodeIdOr404('tripStop', id));
    if (!s) throw new ProblemException('not_found');
    const dos = s.type === 'PICKUP' ? s.pickupOrders : s.deliveryOrders;
    return {
      id: encodeId('tripStop', s.id),
      tripId: encodeId('trip', s.tripId),
      tripNo: s.trip.tripNo ?? '',
      tripStatus: s.trip.status,
      sequence: s.sequence,
      type: s.type,
      siteId: encodeId('site', s.siteId),
      siteName: s.site.name,
      status: s.status,
      outcome: s.outcome,
      windowStart: iso(s.windowStart),
      windowEnd: iso(s.windowEnd),
      plannedArrival: iso(s.plannedArrival),
      plannedDeparture: iso(s.plannedDeparture),
      arrivedAt: iso(s.arrivedAt),
      departedAt: iso(s.departedAt),
      deliveryOrderIds: dos.map((d) => encodeId('deliveryOrder', d.id)),
      lastEventId: s.lastEventId ? encodeId('event', s.lastEventId) : null,
      removedAt: iso(s.removedAt),
    };
  }

  @Get(':id/events')
  @ApiOperation({
    summary: 'ลำดับ event ของจุด (เรียงตาม occurredAt) + สถานะที่มีผล',
    description:
      'ST4-T02 (docs/01 §3.9): ทุก event ของจุด (รวมที่ขัดลำดับ/มาหลังปิด/ผู้จัดรถไม่ใช้) เรียง `occurredAt` → ชนิด (ออก → ถึง → ปิด) → `receivedAt` พร้อมผลของแต่ละตัว (`seqStatus`) และสถานะที่มีผลของจุด — ST4-T03 ลง `trip_stop` แล้ว (เที่ยวที่จบ/ยกเลิกไม่ไล่ต่อ)',
  })
  @ApiProblems(T403R, S404)
  @TenantResource('tripStop')
  @RequireScope('trips:read')
  @ApiOkResponse({ type: StopEventSequenceDto })
  async events(@Param('id') id: string): Promise<StopEventSequenceDto> {
    const stopId = decodeIdOr404('tripStop', id);
    if (!(await this.events_.stopExists(stopId))) throw new ProblemException('not_found');
    const seq = await this.events_.sequence(stopId);
    return {
      data: seq.events.map((e) => ({
        ...toStopEventDto(e),
        seqStatus: e.seqStatus,
        counted: e.counted,
        resolution: toResolutionDto(e.resolution ?? undefined),
      })),
      effective: {
        state: seq.state,
        outcome: seq.outcome,
        enRouteAt: iso(seq.enRouteAt),
        arrivedAt: iso(seq.arrivedAt),
        closedAt: iso(seq.closedAt),
        lastEventId: seq.lastEventId ? encodeId('event', seq.lastEventId) : null,
      },
    };
  }

  @Post(':id/arrive')
  @ApiOperation({ summary: 'ถึงจุด' })
  @ApiProblems(S403, S404, S409, S422)
  @HttpCode(201)
  @TenantResource('tripStop')
  @RequireScope('trips:dispatch')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: StopEventDto, description: 'สร้าง event ใหม่' })
  @ApiOkResponse({
    type: StopEventDto,
    description:
      'ส่งซ้ำ (clientEventId + จุด + ชนิดเดิม) → event เดิม ไม่สร้างแถวใหม่ (ST4-T02 — เดิม T01 ตอบ 409)',
  })
  arrive(
    @Param('id') id: string,
    @Body() body: ArriveStopDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StopEventDto> {
    return this.record(id, 'ARRIVE', body, res);
  }

  @Post(':id/depart')
  @ApiOperation({ summary: 'ออกเดินทางมุ่งหน้าไปจุดนี้ (docs/01 §3.9 DEPART)' })
  @ApiProblems(S403, S404, S409, S422)
  @HttpCode(201)
  @TenantResource('tripStop')
  @RequireScope('trips:dispatch')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: StopEventDto, description: 'สร้าง event ใหม่' })
  @ApiOkResponse({
    type: StopEventDto,
    description:
      'ส่งซ้ำ (clientEventId + จุด + ชนิดเดิม) → event เดิม ไม่สร้างแถวใหม่ (ST4-T02 — เดิม T01 ตอบ 409)',
  })
  depart(
    @Param('id') id: string,
    @Body() body: DepartStopDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StopEventDto> {
    return this.record(id, 'DEPART', body, res);
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
  @ApiCreatedResponse({ type: StopEventDto, description: 'สร้าง event ใหม่' })
  @ApiOkResponse({
    type: StopEventDto,
    description:
      'ส่งซ้ำ (clientEventId + จุด + ชนิดเดิม) → event เดิม ไม่สร้างแถวใหม่ (ST4-T02 — เดิม T01 ตอบ 409)',
  })
  complete(
    @Param('id') id: string,
    @Body() body: CompleteStopDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StopEventDto> {
    return this.record(id, 'COMPLETE', body, res);
  }

  @Post(':id/fail')
  @ApiOperation({ summary: 'ส่งไม่สำเร็จ (เหตุผลบังคับ)' })
  @ApiProblems(S403, S404, S409, S422)
  @HttpCode(201)
  @TenantResource('tripStop')
  @RequireScope('trips:dispatch')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: StopEventDto, description: 'สร้าง event ใหม่' })
  @ApiOkResponse({
    type: StopEventDto,
    description:
      'ส่งซ้ำ (clientEventId + จุด + ชนิดเดิม) → event เดิม ไม่สร้างแถวใหม่ (ST4-T02 — เดิม T01 ตอบ 409)',
  })
  fail(
    @Param('id') id: string,
    @Body() body: FailStopDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StopEventDto> {
    return this.record(id, 'FAIL', body, res);
  }
}

/**
 * ไทม์ไลน์ของเที่ยว (ST4-T04 — แท็บ "ไทม์ไลน์" ของ drawer เที่ยวรถ, docs/04 E2 "เห็นชื่อผู้บันทึก"): ทุก event ของทุกจุด
 * พร้อมชื่อผู้บันทึก ผล (`seqStatus`) และธง — หน้าเว็บใช้ endpoint เดียวกับลูกค้า (API-first)
 */
@ApiTags('stops')
@ApiBearerAuth()
@Controller('trips')
export class TripEventsController {
  constructor(private readonly events_: StopEventsService) {}

  @Get(':id/events')
  @ApiOperation({
    summary: 'ไทม์ไลน์ event หน้างานของเที่ยว (ทุกจุด) พร้อมชื่อผู้บันทึก',
    description:
      'ST4-T04: เรียงตามลำดับจุด (จุดที่ถอดแล้วอยู่ท้าย) แล้วตามลำดับที่มีผลของจุด · `recordedByName` = ชื่อผู้ใช้ภายในที่บันทึก (บันทึกแทนคนขับผ่านเว็บ) · `flags` ไม่ว่าง = รอผู้จัดรถตัดสินในศูนย์ข้อยกเว้น',
  })
  @ApiProblems(
    {
      ...T403R,
      examples: {
        permission_denied: P('permission_denied', {
          module: 'trips',
          action: 'read',
          required: ['trips:read'],
          instance: '/v1/trips/trp_3f2a…/events',
        }),
      },
    },
    {
      status: 404,
      description: 'ไม่พบเที่ยว (รวมของบริษัทอื่น)',
      examples: { not_found: P('not_found') },
    },
  )
  @TenantResource('trip')
  @RequireScope('trips:read')
  @ApiOkResponse({ type: TripTimelineDto })
  async timeline(@Param('id') id: string): Promise<TripTimelineDto> {
    const tripId = decodeIdOr404('trip', id);
    if (!(await this.events_.tripExists(tripId))) throw new ProblemException('not_found');
    const rows = await this.events_.tripTimeline(tripId);
    const names = await this.events_.userNames(
      rows.flatMap((e) => [e.actor, e.resolution?.resolvedBy ?? null]),
    );
    return {
      data: rows.map((e) => ({
        ...toStopEventDto(e),
        seqStatus: e.seqStatus,
        counted: e.counted,
        resolution: toResolutionDto(e.resolution ?? undefined),
        recordedByName: (e.actor && names.get(e.actor)) ?? null,
        resolvedByName: (e.resolution?.resolvedBy && names.get(e.resolution.resolvedBy)) ?? null,
      })),
    };
  }
}
