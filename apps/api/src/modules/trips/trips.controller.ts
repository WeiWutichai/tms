import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  pendingRules,
  ruleKey,
  RULE_OVERRIDE_SCOPE,
  scopeAllows,
  type RuleOverride,
  type TripStatus,
} from '@tms/domain';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { RequireScope, TenantResource } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404, encodeId, tryDecodeId, type IdKind } from '../../common/ids';
import { toPage } from '../../common/pagination';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { ApiProblems } from '../../common/problem.dto';
import { isRealDate } from '../vehicle-documents/expiry';
import { T403, T404, T409, T412, T422 } from './trip-problems';
import {
  AssignTripDto,
  AttachDeliveryOrdersDto,
  CancelTripDto,
  ConfirmRulesDto,
  CreateTripDto,
  DetachDeliveryOrdersDto,
  DispatchTripDto,
  OfferTripDto,
  ReorderStopsDto,
  ScheduleTripDto,
  TripDto,
  TripListQuery,
  TripPageDto,
  type RuleConfirmDto,
} from './trip.dto';
import {
  TripService,
  type RuleConfirmInput,
  type TripRecord,
  type TripWarning,
} from './trip.service';

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const kg = (vs: (Prisma.Decimal | null)[]) =>
  vs
    .reduce<Prisma.Decimal>((a, v) => (v === null ? a : a.add(v)), new Prisma.Decimal(0))
    .toFixed(3)
    .replace(/\.?0+$/, '') || '0';

/** ช่องยืนยัน/ยกเว้นกฎ (ST3-T14) จาก body + สิทธิ์ `trips:override` ของผู้เรียก */
function rulesOf(b: RuleConfirmDto): RuleConfirmInput {
  return {
    ruleKeys: b.ruleKeys ?? [],
    reason: b.overrideReason ?? null,
    canOverride: scopeAllows(requestContext.require().scopes ?? [], RULE_OVERRIDE_SCOPE),
  };
}

/** ผลตรวจล่าสุด + สถานะยืนยัน/ยกเว้น (ชุดเดียวกับ `enforceRules`) */
export function tripRules(t: TripRecord) {
  const ctx = { vehicleId: t.vehicleId, driverId: t.driverId, reliefDriverId: t.reliefDriverId };
  const results = (t.ruleWarnings as unknown as TripWarning[]) ?? [];
  const overrides = (t.ruleOverrides as unknown as RuleOverride[]) ?? [];
  const p = pendingRules(results, overrides, ctx);
  const covered = new Set(p.covered);
  const activeKeys = new Set(p.covered.map((w) => ruleKey(w, ctx)));
  return { results, overrides, pending: p, covered, activeKeys, ctx };
}

export function toTripDto(t: TripRecord): TripDto {
  return {
    id: encodeId('trip', t.id),
    tripNo: t.tripNo!,
    tripDate: t.tripDate.toISOString().slice(0, 10),
    status: t.status as TripStatus,
    plannedStartAt: iso(t.plannedStartAt),
    plannedEndAt: iso(t.plannedEndAt),
    vehicle: t.vehicleId
      ? {
          id: encodeId('vehicle', t.vehicleId),
          plate: t.vehiclePlateSnapshot!,
          vehicleTypeId: encodeId('vehicleType', t.vehicleTypeId!),
          vehicleTypeName: t.vehicleTypeSnapshot,
        }
      : null,
    trailer: t.trailerId
      ? { id: encodeId('vehicle', t.trailerId), plate: t.trailerPlateSnapshot! }
      : null,
    driver: t.driverId
      ? {
          id: encodeId('driver', t.driverId),
          name: t.driverNameSnapshot!,
          phone: t.driverPhoneSnapshot,
        }
      : null,
    reliefDriver: t.reliefDriverId
      ? {
          id: encodeId('driver', t.reliefDriverId),
          name: t.reliefDriverNameSnapshot!,
          phone: t.reliefDriverPhoneSnapshot,
        }
      : null,
    carrier: t.carrierId
      ? { id: encodeId('carrier', t.carrierId), name: t.carrierNameSnapshot! }
      : null,
    assignmentStatus: t.assignmentStatus,
    offeredAt: iso(t.offeredAt),
    offerExpiresAt: iso(t.assignmentExpiresAt),
    assignedAt: iso(t.assignedAt),
    dispatchedAt: iso(t.dispatchedAt),
    completedAt: iso(t.completedAt),
    cancelledAt: iso(t.cancelledAt),
    cancelReason: t.cancelReason,
    stops: t.stops.map((s) => ({
      id: encodeId('tripStop', s.id),
      sequence: s.sequence,
      type: s.type,
      siteId: encodeId('site', s.siteId),
      status: s.status,
      windowStart: iso(s.windowStart),
      windowEnd: iso(s.windowEnd),
      plannedArrival: iso(s.plannedArrival),
      plannedDeparture: iso(s.plannedDeparture),
      deliveryOrderIds: t.deliveryOrders
        .filter((d) => (s.type === 'PICKUP' ? d.pickupTripStopId : d.tripStopId) === s.id)
        .map((d) => encodeId('deliveryOrder', d.id)),
      siteName: s.site.name,
      legDistanceKm: s.legDistanceKm?.toFixed(1) ?? null,
      legMinutes: s.legMinutes,
      legSource: s.legSource,
    })),
    deliveryOrders: t.deliveryOrders.map((d) => ({
      id: encodeId('deliveryOrder', d.id),
      doNo: d.doNo!,
      status: d.status,
      orderId: encodeId('salesOrder', d.salesOrderId),
      customerId: encodeId('customer', d.customerId),
      pickupStopId: d.pickupTripStopId ? encodeId('tripStop', d.pickupTripStopId) : null,
      dropStopId: d.tripStopId ? encodeId('tripStop', d.tripStopId) : null,
    })),
    weightKg: kg(t.deliveryOrders.map((d) => d.weightKg)),
    route: {
      distanceKm: t.plannedDistanceKm?.toFixed(1) ?? null,
      minutes: t.plannedDurationMin,
      missingLegs: t.stops.slice(1).filter((s) => s.legSource === null).length,
      estimated: t.stops.some((s) => s.legSource === 'ESTIMATE'),
    },
    ...(() => {
      const r = tripRules(t);
      return {
        warnings: r.results.map((w) => ({
          ...w,
          key: ruleKey(w, r.ctx),
          confirmed: w.severity === 'info' || r.covered.has(w),
        })),
        ruleOverrides: r.overrides.map((o) => ({
          code: o.code,
          severity: o.severity,
          kind: o.kind,
          reason: o.reason,
          actorId: o.actorId,
          at: o.at,
          message: o.message,
          active: !o.supersededAt && r.activeKeys.has(o.key),
          supersededAt: o.supersededAt ?? null,
          supersededReason: o.supersededReason ?? null,
        })),
      };
    })(),
    version: t.version,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
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
 * ไม่มีราคาซื้อ/ขายใน payload (buy_rate_snapshot = ST3-T22)
 */
@ApiTags('trips')
@ApiBearerAuth()
@Controller('trips')
export class TripsController {
  constructor(private readonly trips: TripService) {}

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

  @Get(':id')
  @ApiProblems(T403('trips:read'), T404)
  @TenantResource('trip')
  @RequireScope('trips:read')
  @ApiOkResponse({ type: TripDto })
  async get(@Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<TripDto> {
    const t = await this.trips.get(decodeIdOr404('trip', id));
    setEtag(res, t.version);
    return toTripDto(t);
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

  /** จัดรถ + คนขับ (snapshot) → ASSIGNED · คำเตือนอยู่ใน `warnings` (ไม่บล็อก) */
  @Post(':id/assign')
  @ApiProblems(
    T403('trips:assign'),
    T404,
    T409('trip_empty', 'offer_required', 'carrier_change_requires_cancel', 'assignment_blocked'),
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
    );
    setEtag(res, t.version);
    return toTripDto(t);
  }

  /** เสนองานรถร่วม → OFFERED (ลิงก์รับงาน = ST3-T23) */
  @Post(':id/offer')
  @ApiProblems(T403('trips:assign'), T404, T409('trip_empty'), T412, T422)
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
    const trip = await this.trips.get(decodeIdOr404('trip', id));
    const t = await this.trips.offer(
      trip.id,
      ref('carrier', body.carrierId, 'carrierId'),
      undefined,
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
