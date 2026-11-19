import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  InvalidTransitionError,
  pendingRules,
  ruleKey,
  RULE_OVERRIDE_SCOPE,
  scopeAllows,
  type RuleOverride,
  type TripStatus,
} from '@tms/domain';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { RequireScope, TenantResource, RateLimitClass } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404, encodeId, tryDecodeId, type IdKind } from '../../common/ids';
import { toPage } from '../../common/pagination';
import { PROBLEMS, ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { ApiProblems } from '../../common/problem.dto';
import { isRealDate } from '../vehicle-documents/expiry';
import { T403, T404, T409, T412, T422 } from './trip-problems';
import { TripCostListDto } from './trip-costs.dto';
import {
  AssignTripDto,
  AttachDeliveryOrdersDto,
  BulkAssignTripsDto,
  BulkTripResultsDto,
  SendAllTripsDto,
  SendAllTripsResultDto,
  CancelTripDto,
  ConfirmRulesDto,
  CreateTripDto,
  DetachDeliveryOrdersDto,
  HireOptionsDto,
  HireOptionsQuery,
  DispatchTripDto,
  OfferTripDto,
  ReorderStopsDto,
  ScheduleTripDto,
  TripDto,
  TripListQuery,
  TripPageDto,
  TripSummaryDto,
  type RuleConfirmDto,
} from './trip.dto';
import {
  TripService,
  type BulkOutcome,
  type RuleConfirmInput,
  type TripRecord,
  type TripWarning,
  type TripRescheduled,
} from './trip.service';
import { SubconHireService } from './subcon-hire.service';
import { toTripDto, tripRules } from './trip-dto';

/** ช่องยืนยัน/ยกเว้นกฎ (ST3-T14) จาก body + สิทธิ์ `trips:override` ของผู้เรียก */
function rulesOf(b: RuleConfirmDto): RuleConfirmInput {
  return {
    ruleKeys: b.ruleKeys ?? [],
    reason: b.overrideReason ?? null,
    canOverride: scopeAllows(requestContext.require().scopes ?? [], RULE_OVERRIDE_SCOPE),
  };
}

/** problem body ของรายการใน bulk (รูปเดียวกับ ProblemFilter — ไม่มี instance/requestId ต่อรายการ) */
function problemOf(e: unknown) {
  const locale = requestContext.get()?.locale ?? 'th';
  if (e instanceof InvalidTransitionError)
    return {
      type: 'https://docs.tms.example/problems/invalid_state_transition',
      title: PROBLEMS.invalid_state_transition[locale],
      status: PROBLEMS.invalid_state_transition.status,
      code: 'invalid_state_transition',
    };
  const p = e as ProblemException;
  const def = PROBLEMS[p.code];
  const { title, ...extra } = (p.extra ?? {}) as { title?: { th: string; en: string } } & Record<
    string,
    unknown
  >;
  return {
    type: `https://docs.tms.example/problems/${p.code}`,
    title: title?.[locale] ?? def[locale],
    status: def.status as number,
    code: p.code as string,
    ...(p.detail ? { detail: p.detail } : {}),
    ...(p.errors?.length ? { errors: p.errors } : {}),
    ...extra,
  };
}

/** ผลต่อรายการของ bulk / send-all (207) เรียงตามคำขอ — `tripNo` ของรายการที่ไม่สำเร็จ = ที่รู้ก่อนทำ (ถ้ามี) */
function bulkResults(
  out: BulkOutcome[],
  refs: { tripId: string; tripNo: string | null }[],
): BulkTripResultsDto {
  const results = out.map((r, i) => {
    const { tripId, tripNo } = refs[i]!;
    if (r.trip)
      return {
        tripId,
        tripNo: r.trip.tripNo,
        status: 200,
        outcome: r.outcome,
        trip: toTripDto(r.trip),
        problem: null,
      };
    const problem = problemOf(r.error);
    return { tripId, tripNo, status: problem.status, outcome: r.outcome, trip: null, problem };
  });
  const n = (o: string) => results.filter((r) => r.outcome === o).length;
  return {
    results,
    succeeded: n('ASSIGNED') + n('DISPATCHED'),
    unchanged: n('UNCHANGED'),
    failed: n('FAILED'),
  };
}

/** ผู้เรียกต้องมี scope นี้เพิ่ม (เช่น `/assign` + `dispatch: true` ต้องมี `trips:dispatch`) */
function requireAlso(scope: string) {
  if (!scopeAllows(requestContext.require().scopes ?? [], scope))
    throw new ProblemException('permission_denied', undefined, undefined, {
      module: 'trips',
      action: scope.split(':')[1],
      required: [scope],
    });
}

/** id ใน body ที่ผิดรูป/ไม่พบ → 422 รายช่อง (ไม่ใช่ 404 ของ resource หลัก) */
function ref(kind: IdKind, v: string, field: string): string {
  const id = tryDecodeId(kind, v);
  if (!id)
    throw new ProblemException('validation_failed', undefined, [
      { field, code: 'invalid_reference', message: 'not found' },
    ]);
  return id;
}
const optRef = (kind: IdKind, v: string | null | undefined, field: string) =>
  v === undefined ? undefined : v === null ? null : ref(kind, v, field);

/**
 * เที่ยวรถ (ST3-T11; docs/01 §5.2 #3 `trips`) — list/get + สร้างจาก DO + เพิ่ม/ถอด DO + action ตาม state machine
 * (`/assign` `/offer` `/dispatch` `/complete` `/cancel`) · `/attach` `/detach` ไม่อยู่ในรายการ docs §5.2 (spec/12 §3)
 * สิทธิ์ (docs/04 A3 "Trip: assign / dispatch / ปิด"): อ่าน `trips:read` · สร้าง/เพิ่ม-ถอด/จัดรถ/เสนอ/ยกเลิก `trips:assign`
 * (ยกเลิกเที่ยวที่ปล่อยแล้วต้องมี `trips:dispatch` ด้วย) · ปล่อยรถ `trips:dispatch` · ปิดเที่ยว `trips:close`
 * ราคาซื้อ (ST3-T22 `hire.buyAmount`) ถูกตัดที่ serializer เมื่อไม่มี `prices.buy:read` · ไม่มีราคาขายใน payload
 */
@ApiTags('trips')
@ApiBearerAuth()
@Controller('trips')
export class TripsController {
  constructor(
    private readonly trips: TripService,
    private readonly subcon: SubconHireService,
  ) {}

  /** ST9-T01 ตัวนับของ dashboard ปฏิบัติการ (กำลังวิ่ง / รถร่วมรอตอบ) — ตัวกรองเดียวกับรายการ */
  @Get('summary')
  @ApiOperation({
    summary: 'ตัวนับเที่ยวของ dashboard ปฏิบัติการ',
    description:
      'นับด้วยตัวกรองชุดเดียวกับ `GET /trips` — `running` = `?status=IN_PROGRESS`, `offered` = `?status=OFFERED`',
  })
  @ApiProblems(T403('trips:read'))
  @RequireScope('trips:read')
  @ApiOkResponse({ type: TripSummaryDto })
  summary(): Promise<TripSummaryDto> {
    return this.trips.summary();
  }

  @Get()
  @ApiProblems(T403('trips:read'), T422)
  @RequireScope('trips:read')
  @ApiOkResponse({ type: TripPageDto })
  async list(@Query() q: TripListQuery) {
    const badDates = (['dateFrom', 'dateTo'] as const).flatMap((f) =>
      q[f] !== undefined && !isRealDate(q[f]!)
        ? [{ field: f, code: 'invalid_date', message: 'must be a real date (YYYY-MM-DD)' }]
        : [],
    );
    if (badDates.length) throw new ProblemException('validation_failed', undefined, badDates);
    const none = '00000000-0000-0000-0000-000000000000';
    const dec = (kind: IdKind, v?: string) =>
      v === undefined ? undefined : (tryDecodeId(kind, v) ?? none);
    const { rows, k } = await this.trips.list({
      ...q,
      statuses: q.status ? (q.status.split(',') as TripStatus[]) : undefined,
      vehicleId: dec('vehicle', q.vehicleId),
      driverId: dec('driver', q.driverId),
      carrierId: dec('carrier', q.carrierId),
    });
    return toPage(rows, k, toTripDto, q.fields);
  }

  /**
   * จัดรถ / จัดรถและปล่อยเที่ยว หลายเที่ยว (ST3-T17 bulk — docs/04 D2, spec/03 PLN-047/048) → 207 ผลต่อรายการ
   * ไม่ใช่ all-or-nothing: แต่ละเที่ยวสำเร็จ/ไม่สำเร็จแยกกัน (ไม่สำเร็จ = `problem` รูปเดียวกับคำขอเดี่ยว เช่น 409 `assignment_warnings`)
   */
  @Post('bulk-assign')
  @RateLimitClass('heavy')
  @ApiOperation({
    summary: 'จัดรถ / จัดรถและปล่อยเที่ยว หลายเที่ยว',
    description:
      '≤ 50 เที่ยว ทำทีละรายการแยกกัน (สำเร็จบางรายการได้) · PLANNING: จัดรถด้วยรถที่วางไว้ + คนขับประจำรถ · ' +
      'ASSIGNED: `dispatch` = ปล่อยรถ, ไม่ dispatch = ไม่เปลี่ยน · สถานะอื่น = 409 · ' +
      'ตอบ 207 เสมอเมื่อคำขอถูกต้อง — ดู `results[].status` / `problem` · `dispatch: true` ต้องมี `trips:dispatch`',
  })
  @ApiProblems(T403('trips:assign'), T422)
  @HttpCode(207)
  @RequireScope('trips:assign')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiResponse({ status: 207, type: BulkTripResultsDto, description: 'ผลต่อรายการ' })
  async bulkAssign(@Body() body: BulkAssignTripsDto): Promise<BulkTripResultsDto> {
    if (body.dispatch) requireAlso('trips:dispatch');
    const ids = body.items.map((i) => i.tripId);
    const dup = ids.flatMap((x, i) =>
      ids.indexOf(x) !== i
        ? [{ field: `items[${i}].tripId`, code: 'duplicate', message: 'trip listed twice' }]
        : [],
    );
    if (dup.length) throw new ProblemException('validation_failed', undefined, dup);
    const out = await this.trips.bulkAssign(
      body.items.map((i) => ({
        tripId: tryDecodeId('trip', i.tripId),
        version: i.version,
        ruleKeys: i.ruleKeys,
      })),
      {
        dispatch: body.dispatch === true,
        reason: body.overrideReason ?? null,
        canOverride: scopeAllows(requestContext.require().scopes ?? [], RULE_OVERRIDE_SCOPE),
      },
    );
    return bulkResults(
      out,
      body.items.map((i) => ({ tripId: i.tripId, tripNo: null })),
    );
  }

  /**
   * ส่งแผนทั้งวัน (ST3-T18 "Send all" — docs/04 D2 "checkbox ส่งงานทั้งวันของทุกรถทีเดียว", spec/03 §9 PLN-170)
   * งานต่อเที่ยว = bulk จัดรถและปล่อย (207 ผลต่อรายการ) + `day` สถานะการส่งของวันหลังทำ (ส่งครบ = เขียว)
   */
  @Post('send-all')
  @RateLimitClass('heavy')
  @ApiOperation({
    summary: 'ส่งแผนทั้งวัน (ปล่อยทุกเที่ยวของวัน)',
    description:
      'ไม่ส่ง `items` = ทุกเที่ยว PLANNING/OFFERED/ASSIGNED ของวันนั้น (≤ 400) · ส่ง `items` = เฉพาะที่เลือก (ต้องเป็นเที่ยวของวันนั้น) · ' +
      'แต่ละเที่ยวทำแยกกันเหมือน `bulk-assign` + `dispatch: true` (ติดกฎ/ไม่มีรถ/รอรถร่วมตอบ = ไม่ผ่านพร้อม `problem`) · ' +
      'เที่ยวที่ส่งแล้ว = `UNCHANGED` · `dryRun` = ตรวจล่วงหน้าไม่เปลี่ยนข้อมูล · ตอบ 207 พร้อม `day` (ส่งครบ = มีเที่ยวและทุกเที่ยวปล่อยรถแล้ว) · ต้องมี `trips:dispatch` + `trips:assign` · audit `trip.sent_all`',
  })
  @ApiProblems(T403('trips:dispatch'), T422)
  @HttpCode(207)
  @RequireScope('trips:dispatch')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiResponse({
    status: 207,
    type: SendAllTripsResultDto,
    description: 'ผลต่อรายการ + สถานะของวัน',
  })
  async sendAll(@Body() body: SendAllTripsDto): Promise<SendAllTripsResultDto> {
    requireAlso('trips:assign');
    if (!isRealDate(body.date))
      throw new ProblemException('validation_failed', undefined, [
        { field: 'date', code: 'invalid_date', message: 'must be a real date (YYYY-MM-DD)' },
      ]);
    const ids = (body.items ?? []).map((i) => i.tripId);
    const dup = ids.flatMap((x, i) =>
      ids.indexOf(x) !== i
        ? [{ field: `items[${i}].tripId`, code: 'duplicate', message: 'trip listed twice' }]
        : [],
    );
    if (dup.length) throw new ProblemException('validation_failed', undefined, dup);
    const r = await this.trips.sendAll(
      body.date,
      body.items?.map((i) => ({
        tripId: tryDecodeId('trip', i.tripId),
        version: i.version,
        ruleKeys: i.ruleKeys,
      })),
      {
        reason: body.overrideReason ?? null,
        canOverride: scopeAllows(requestContext.require().scopes ?? [], RULE_OVERRIDE_SCOPE),
        dryRun: body.dryRun === true,
      },
    );
    return {
      ...bulkResults(
        r.outcomes,
        r.items.map((it, i) => ({
          tripId: body.items?.[i]?.tripId ?? (it.tripId ? encodeId('trip', it.tripId) : ''),
          tripNo: it.tripNo,
        })),
      ),
      day: { date: body.date, ...r.day },
    };
  }

  @Get(':id')
  @ApiProblems(T403('trips:read'), T404)
  @TenantResource('trip')
  @RequireScope('trips:read')
  @ApiOkResponse({ type: TripDto })
  async get(@Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<TripDto> {
    const t = await this.trips.get(decodeIdOr404('trip', id));
    setEtag(res, t.version);
    return toTripDto(
      t,
      await this.trips.rescheduled(t.id),
      await this.trips.rejectedRedelivered(t.id),
    );
  }

  /** สร้างเที่ยว PLANNING จาก DO (DRAFT ไม่อยู่ในเที่ยวอื่น) — จุดแวะจัดจาก DO, เลขเที่ยวจาก document_series TRIP */
  @Post()
  @ApiProblems(
    T403('trips:assign'),
    T409('delivery_order_on_trip', 'order_not_ready_for_delivery', 'assignment_blocked'),
    T422,
  )
  @RequireScope('trips:assign')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: TripDto })
  async create(
    @Body() body: CreateTripDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TripDto> {
    if (!isRealDate(body.tripDate))
      throw new ProblemException('validation_failed', undefined, [
        { field: 'tripDate', code: 'invalid_date', message: 'must be a real date (YYYY-MM-DD)' },
      ]);
    const t = await this.trips.create({
      tripDate: body.tripDate,
      deliveryOrderIds: body.deliveryOrderIds.map((x, i) =>
        ref('deliveryOrder', x, `deliveryOrderIds[${i}]`),
      ),
      plannedStartAt: body.plannedStartAt,
      plannedEndAt: body.plannedEndAt,
      vehicleId: optRef('vehicle', body.vehicleId, 'vehicleId'),
      rules: rulesOf(body),
    });
    setEtag(res, t.version);
    return toTripDto(t);
  }

  /**
   * ย้าย/ปรับขนาดเที่ยวบนกระดานวางแผน (ST3-T12; spec/03 PLN-040) — วันเที่ยว/ช่วงวิ่ง/รถที่วางไว้ (PLANNING)
   * ซ้อนเวลา = คำเตือนใน `warnings` บันทึกได้ (docs/04 D2)
   */
  @Post(':id/schedule')
  @ApiProblems(T403('trips:assign'), T404, T409('assignment_blocked'), T412, T422)
  @HttpCode(200)
  @TenantResource('trip')
  @RequireScope('trips:assign')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOkResponse({ type: TripDto })
  async schedule(
    @Param('id') id: string,
    @Body() body: ScheduleTripDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TripDto> {
    const trip = await this.trips.get(decodeIdOr404('trip', id));
    if (body.tripDate !== undefined && !isRealDate(body.tripDate))
      throw new ProblemException('validation_failed', undefined, [
        { field: 'tripDate', code: 'invalid_date', message: 'must be a real date (YYYY-MM-DD)' },
      ]);
    const t = await this.trips.schedule(
      trip.id,
      {
        tripDate: body.tripDate,
        plannedStartAt: body.plannedStartAt,
        plannedEndAt: body.plannedEndAt,
        vehicleId: optRef('vehicle', body.vehicleId, 'vehicleId'),
        rules: rulesOf(body),
      },
      undefined,
      expectedVersion(req),
    );
    setEtag(res, t.version);
    return toTripDto(t);
  }

  /** เพิ่ม DO เข้าเที่ยว (PLANNING/ASSIGNED) */
  @Post(':id/attach')
  @ApiOperation({
    summary: 'เพิ่มใบส่งของเข้าเที่ยว',
    description:
      'กฎตอนจัด (ST3-T14) **ไม่บังคับตอนเพิ่ม/ถอด DO** — ตรวจใหม่และเก็บใน `warnings` (กระดานแสดงเป็นค้างยกเว้น/ยืนยัน) ' +
      'แล้วบังคับอีกครั้งตอน `/dispatch` (บล็อกค้าง → 409 `assignment_blocked`, คำเตือนค้าง → 409 `assignment_warnings`) · ' +
      'น้ำหนักที่เพิ่มขึ้นทำให้การยืนยัน "น้ำหนักเกิน" เดิมหมดผล',
  })
  @ApiProblems(
    T403('trips:assign'),
    T404,
    T409('delivery_order_on_trip', 'order_not_ready_for_delivery'),
    T412,
    T422,
  )
  @HttpCode(200)
  @TenantResource('trip')
  @RequireScope('trips:assign')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOkResponse({ type: TripDto })
  async attach(
    @Param('id') id: string,
    @Body() body: AttachDeliveryOrdersDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TripDto> {
    const trip = await this.trips.get(decodeIdOr404('trip', id));
    const t = await this.trips.attach(
      trip.id,
      body.deliveryOrderIds.map((x, i) => ref('deliveryOrder', x, `deliveryOrderIds[${i}]`)),
      undefined,
      expectedVersion(req),
    );
    setEtag(res, t.version);
    return toTripDto(t);
  }

  /** ถอด DO ออกจากเที่ยว (PLANNING/ASSIGNED) — DO กลับ DRAFT นอกเที่ยว */
  @Post(':id/detach')
  @ApiProblems(T403('trips:assign'), T404, T409('trip_has_loaded_orders'), T412, T422)
  @HttpCode(200)
  @TenantResource('trip')
  @RequireScope('trips:assign')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOkResponse({ type: TripDto })
  async detach(
    @Param('id') id: string,
    @Body() body: DetachDeliveryOrdersDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TripDto> {
    const trip = await this.trips.get(decodeIdOr404('trip', id));
    const t = await this.trips.detach(
      trip.id,
      body.deliveryOrderIds.map((x, i) => ref('deliveryOrder', x, `deliveryOrderIds[${i}]`)),
      body.note ?? null,
      undefined,
      expectedVersion(req),
    );
    setEtag(res, t.version);
    return toTripDto(t);
  }

  /**
   * เรียงจุดแวะเอง (ST3-T16 Multi-drop — docs/04 D2, spec/03 PLN-003) · PLANNING/ASSIGNED
   * ส่งก่อนรับ (จุดส่งของ DO อยู่ก่อนจุดรับของ DO เดียวกัน) → 422 `stop_order_invalid` (บล็อก) ·
   * คำนวณระยะ/เวลาช่วงวิ่งใหม่ (`stops[].leg*`, `route`) + ตรวจกฎตอนจัดใหม่ (`warnings`)
   */
  @Post(':id/reorder-stops')
  @ApiOperation({
    summary: 'เรียงลำดับจุดแวะของเที่ยว',
    description:
      'ส่ง id ของจุดแวะทุกจุดตามลำดับใหม่ · ลำดับเท่าเดิม = ไม่เปลี่ยน version · ' +
      'จุดส่งก่อนจุดรับของใบส่งของเดียวกัน → 422 `stop_order_invalid` พร้อม `violations[]` · ' +
      'ระยะ/เวลา: route master ก่อน ไม่มี → ค่าประมาณจากพิกัด (เส้นตรง × 1.3, 50 กม./ชม.) ไม่มีทั้งคู่ = ไม่ทราบ',
  })
  @ApiProblems(T403('trips:assign'), T404, T409(), T412, {
    ...T422,
    examples: {
      ...T422.examples,
      stop_order_invalid: {
        type: 'https://docs.tms.example/problems/stop_order_invalid',
        title: 'ลำดับจุดไม่ถูกต้อง — จุดส่งของใบส่งของต้องอยู่หลังจุดรับของใบเดียวกัน',
        status: 422,
        code: 'stop_order_invalid',
        detail:
          'ใบส่งของ DO-6911-0001: จุดส่ง (ลำดับ 1) อยู่ก่อนจุดรับ (ลำดับ 2) — ต้องรับของก่อนส่ง',
        errors: [
          {
            field: 'stopIds',
            code: 'delivery_before_pickup',
            message: 'DO-6911-0001: drop stop 1 is not after pickup stop 2',
          },
        ],
        violations: [
          {
            deliveryOrderId: 'do_3f2a…',
            doNo: 'DO-6911-0001',
            pickupStopId: 'stp_3f2a…',
            dropStopId: 'stp_8c1d…',
            pickupSequence: 2,
            dropSequence: 1,
          },
        ],
      },
    },
  })
  @HttpCode(200)
  @TenantResource('trip')
  @RequireScope('trips:assign')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOkResponse({ type: TripDto })
  async reorderStops(
    @Param('id') id: string,
    @Body() body: ReorderStopsDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TripDto> {
    const trip = await this.trips.get(decodeIdOr404('trip', id));
    const t = await this.trips.reorderStops(
      trip.id,
      body.stopIds.map((x, i) => ref('tripStop', x, `stopIds[${i}]`)),
      undefined,
      expectedVersion(req),
    );
    setEtag(res, t.version);
    return toTripDto(t);
  }

  /**
   * จัดรถ + คนขับ (snapshot) → ASSIGNED (ยังไม่ส่งงาน) · คำเตือนอยู่ใน `warnings` (ต้องยืนยันก่อนปล่อยรถ)
   * ST3-T17: `dispatch: true` = จัดรถและปล่อยเที่ยว (→ DISPATCHED, ทุก DO DISPATCHED) ในคำขอเดียว — ต้องมี `trips:dispatch` ด้วย
   */
  @Post(':id/assign')
  @ApiOperation({
    summary: 'จัดรถ / จัดรถและปล่อยเที่ยว',
    description:
      'PLANNING → ASSIGNED (รถบริษัท) · ASSIGNED → ASSIGNED (เปลี่ยนรถ/คนขับก่อนปล่อยรถ — docs/01 §4.2) · OFFERED → ASSIGNED (รถร่วมรับงาน) · ' +
      '`dispatch: true` → ปล่อยรถต่อทันที (atomic; ต้องมี `trips:dispatch`; คำเตือนที่ยังไม่ยืนยัน → 409 `assignment_warnings`)',
  })
  @ApiProblems(
    T403('trips:assign'),
    T404,
    T409(
      'trip_empty',
      'offer_required',
      'carrier_change_requires_cancel',
      'assignment_blocked',
      'assignment_warnings',
    ),
    T412,
    T422,
  )
  @HttpCode(200)
  @TenantResource('trip')
  @RequireScope('trips:assign')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOkResponse({ type: TripDto })
  async assign(
    @Param('id') id: string,
    @Body() body: AssignTripDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TripDto> {
    const trip = await this.trips.get(decodeIdOr404('trip', id));
    if (body.dispatch) requireAlso('trips:dispatch');
    const t = await this.trips.assign(
      trip.id,
      {
        vehicleId: ref('vehicle', body.vehicleId, 'vehicleId'),
        driverId: optRef('driver', body.driverId, 'driverId'),
        reliefDriverId: optRef('driver', body.reliefDriverId, 'reliefDriverId'),
        trailerId: optRef('vehicle', body.trailerId, 'trailerId'),
        rules: rulesOf(body),
      },
      undefined,
      expectedVersion(req),
      { dispatch: body.dispatch === true },
    );
    setEtag(res, t.version);
    return toTripDto(t);
  }

  /**
   * ตัวเลือกจ้างรถร่วมของเที่ยว (ST3-T22; docs/04 D3): รถร่วมที่ใช้งานอยู่ทุกราย + ราคาขาซื้อจาก rate card + ราคา 5 ครั้งล่าสุด
   * + รายที่ถูกสุด · ต้องมี `trips:assign` + `prices.buy:read` · ราคาขายของเที่ยวเห็นเมื่อมี `prices.sell:read`
   */
  @Get(':id/hire-options')
  @ApiProblems(T403('prices.buy:read'), T404, T422)
  @TenantResource('trip')
  @RequireScope('trips:assign')
  @ApiOkResponse({ type: HireOptionsDto })
  async hireOptions(
    @Param('id') id: string,
    @Query() q: HireOptionsQuery,
  ): Promise<HireOptionsDto> {
    requireAlso('prices.buy:read');
    const trip = await this.trips.get(decodeIdOr404('trip', id));
    return this.subcon.optionsDto(
      trip,
      optRef('vehicleType', q.vehicleTypeId, 'vehicleTypeId'),
      q.change === 'true',
    );
  }

  /**
   * จ้างรถร่วม = เสนองาน → OFFERED (ST3-T22; ลิงก์รับงาน = ST3-T23): ราคาซื้อ → `trip_cost` CARRIER_FEE + `selectionReason`
   * ไม่ใช่ราคาถูกสุด/ไม่มีราคาให้เทียบ → ต้องมีเหตุผล (422 `selection_reason_required`) · ต้องมี `prices.buy:read` ด้วย
   * ST3-T24 `replaceOffer` = ส่งรายถัดไปเมื่อครบ N ชม. · ST3-T25 `changeReason` = เปลี่ยนผู้รับเหมา (ยกเลิกการจ้างเดิมแล้วจ้างใหม่)
   */
  @Post(':id/offer')
  @ApiProblems(
    T403('trips:assign'),
    T404,
    T409('trip_empty', 'offer_closed', 'offer_not_timed_out', 'carrier_change_not_allowed'),
    T412,
    T422,
  )
  @HttpCode(200)
  @TenantResource('trip')
  @RequireScope('trips:assign')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOkResponse({ type: TripDto })
  async offer(
    @Param('id') id: string,
    @Body() body: OfferTripDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TripDto> {
    requireAlso('prices.buy:read');
    const trip = await this.trips.get(decodeIdOr404('trip', id));
    const t = await this.subcon.hire(
      trip.id,
      {
        carrierId: ref('carrier', body.carrierId, 'carrierId'),
        cost: body.cost ?? null,
        selectionReason: body.selectionReason ?? null,
        vehicleTypeId: optRef('vehicleType', body.vehicleTypeId, 'vehicleTypeId') ?? null,
        replaceOffer: body.replaceOffer === true,
        replaceNote: body.replaceNote ?? null,
        changeReason: body.changeReason ?? null,
      },
      expectedVersion(req),
    );
    setEtag(res, t.version);
    return toTripDto(t);
  }

  /**
   * ปล่อยรถ → DISPATCHED (ทุก DO → DISPATCHED) · ST3-T14: ตรวจกฎใหม่ — บล็อกที่ยังไม่ยกเว้น 409 `assignment_blocked`,
   * คำเตือนที่ยังไม่ยืนยัน 409 `assignment_warnings` (ยืนยัน/ยกเว้นใน body ได้)
   */
  @Post(':id/dispatch')
  @ApiProblems(
    T403('trips:dispatch'),
    T404,
    T409('trip_empty', 'assignment_blocked', 'assignment_warnings'),
    T412,
    T422,
  )
  @HttpCode(200)
  @TenantResource('trip')
  @RequireScope('trips:dispatch')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOkResponse({ type: TripDto })
  async dispatch(
    @Param('id') id: string,
    @Body() body: DispatchTripDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TripDto> {
    const trip = await this.trips.get(decodeIdOr404('trip', id));
    const t = await this.trips.dispatch(
      trip.id,
      undefined,
      expectedVersion(req),
      rulesOf(body ?? {}),
    );
    setEtag(res, t.version);
    return toTripDto(t);
  }

  /**
   * ยืนยันคำเตือนที่ค้าง + ยกเว้นบล็อก (ST3-T14 — กระดาน "… · ขออนุมัติ" / "ยกเว้นและบันทึก log") — เหตุผล ≥ 10 + audit
   * `overrideBlocks` ต้องมี `trips:override` (ผู้จัดการ/ผู้ดูแล — D-07) · ไม่มีอะไรค้าง = ไม่เปลี่ยน
   */
  @Post(':id/confirm-rules')
  @ApiProblems(T403('trips:assign'), T404, T409('assignment_blocked'), T412, T422)
  @HttpCode(200)
  @TenantResource('trip')
  @RequireScope('trips:assign')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOkResponse({ type: TripDto })
  async confirmRules(
    @Param('id') id: string,
    @Body() body: ConfirmRulesDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TripDto> {
    const trip = await this.trips.get(decodeIdOr404('trip', id));
    const t = await this.trips.confirmRules(
      trip.id,
      {
        ruleKeys: body.ruleKeys,
        reason: body.overrideReason,
        canOverride: scopeAllows(requestContext.require().scopes ?? [], RULE_OVERRIDE_SCOPE),
      },
      undefined,
      expectedVersion(req),
    );
    setEtag(res, t.version);
    return toTripDto(t);
  }

  /** ปิดเที่ยว → COMPLETED (ทุกจุดจบแล้ว) */
  @Post(':id/complete')
  @ApiProblems(T403('trips:close'), T404, T409('trip_stops_open'), T412)
  @HttpCode(200)
  @TenantResource('trip')
  @RequireScope('trips:close')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOkResponse({ type: TripDto })
  async complete(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TripDto> {
    const trip = await this.trips.get(decodeIdOr404('trip', id));
    const t = await this.trips.complete(trip.id, undefined, expectedVersion(req));
    setEtag(res, t.version);
    return toTripDto(t);
  }

  /** ต้นทุนของเที่ยว (ST6-T01) — บรรทัด `trip_cost` ทุกบรรทัด (รวมกลับรายการ) + สรุป/สิ่งที่ขวางการปิดต้นทุน */
  @Get(':id/costs')
  @ApiOperation({
    summary: 'บรรทัดต้นทุนของเที่ยว + สรุป',
    description:
      'ค่าจ้างรถร่วม (บรรทัดระบบ snapshot ตอนจ้าง — แก้ rate card ภายหลังไม่เปลี่ยน) + ค่าใช้จ่ายหน้างานฝั่งซื้อ + บรรทัดกลับรายการ ' +
      '(ไม่มีการลบ) · ยอดเงิน (`buy*`) เห็นเมื่อมี `prices.buy:read`',
  })
  @ApiProblems(T403('trips:read'), T404)
  @TenantResource('trip')
  @RequireScope('trips:read')
  @ApiOkResponse({ type: TripCostListDto })
  async costs(@Param('id') id: string): Promise<TripCostListDto> {
    const { trip, data, ready } = await this.trips.costs(decodeIdOr404('trip', id));
    return {
      data,
      summary: {
        tripStatus: trip.status,
        buyTotal: ready.buyTotal.toFixed(2),
        buyCarrierFee: ready.carrierFee.toFixed(2),
        pendingCount: ready.pendingCount,
        blockers: ready.blockers,
        costedAt: trip.costedAt?.toISOString() ?? null,
        costedBy: trip.costedBy,
      },
    };
  }

  /** ปิดต้นทุน → COSTED (ต้นทุนครบ — docs/01 §4.2) */
  @Post(':id/cost')
  @ApiOperation({
    summary: 'ปิดต้นทุนเที่ยว (COMPLETED → COSTED)',
    description:
      'ต้นทุนครบ = ไม่มีค่าใช้จ่ายหน้างานฝั่งซื้อรอยืนยัน และเที่ยวรถร่วมมีค่าจ้างของการจ้างที่รถร่วมรับแล้ว · ' +
      'ไม่ครบ → 409 `trip_costs_incomplete` + `blockers` · หลังปิดบันทึก/ยืนยันค่าใช้จ่ายหน้างานไม่ได้',
  })
  @ApiProblems(T403('trips:close'), T404, T409('trip_costs_incomplete'), T412)
  @HttpCode(200)
  @TenantResource('trip')
  @RequireScope('trips:close')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOkResponse({ type: TripDto })
  async cost(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TripDto> {
    const trip = await this.trips.get(decodeIdOr404('trip', id));
    const t = await this.trips.cost(trip.id, undefined, expectedVersion(req));
    setEtag(res, t.version);
    return toTripDto(t);
  }

  /** ยกเลิกเที่ยว — เหตุผล ≥ 10 ตัวอักษร + audit · DO ที่ยังไม่รับของกลับเป็นงานรอจัด */
  @Post(':id/cancel')
  @ApiProblems(T403('trips:assign'), T404, T409('trip_has_loaded_orders'), T412, T422)
  @HttpCode(200)
  @TenantResource('trip')
  @RequireScope('trips:assign')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOkResponse({ type: TripDto })
  async cancel(
    @Param('id') id: string,
    @Body() body: CancelTripDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TripDto> {
    const trip = await this.trips.get(decodeIdOr404('trip', id));
    const t = await this.trips.cancel(
      trip.id,
      {
        reason: body.reason,
        reasonCodeId: optRef('reasonCode', body.reasonCodeId, 'reasonCodeId') ?? null,
      },
      undefined,
      expectedVersion(req),
      // เที่ยวที่ปล่อยรถแล้ว = งานของผู้จ่ายงาน (A3 Planner ไม่มี dispatch) — service ตรวจหลังล็อก
      { canCancelDispatched: scopeAllows(requestContext.require().scopes ?? [], 'trips:dispatch') },
    );
    setEtag(res, t.version);
    return toTripDto(t);
  }
}
