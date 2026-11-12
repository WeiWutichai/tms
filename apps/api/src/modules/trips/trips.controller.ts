import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { scopeAllows, type TripStatus } from '@tms/domain';
import type { Request, Response } from 'express';
import { RequireScope, TenantResource } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404, encodeId, tryDecodeId, type IdKind } from '../../common/ids';
import { toPage } from '../../common/pagination';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { isRealDate } from '../vehicle-documents/expiry';
import {
  AssignTripDto,
  AttachDeliveryOrdersDto,
  CancelTripDto,
  CreateTripDto,
  DetachDeliveryOrdersDto,
  OfferTripDto,
  TripDto,
  TripListQuery,
  TripPageDto,
  type TripWarningDto,
} from './trip.dto';
import { TripService, type TripRecord } from './trip.service';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

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
    warnings: (t.ruleWarnings as unknown as TripWarningDto[]) ?? [],
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
    });
    setEtag(res, t.version);
    return toTripDto(t);
  }

  /** เพิ่ม DO เข้าเที่ยว (PLANNING/ASSIGNED) */
  @Post(':id/attach')
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

  /** จัดรถ + คนขับ (snapshot) → ASSIGNED · คำเตือนอยู่ใน `warnings` (ไม่บล็อก) */
  @Post(':id/assign')
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
      },
      undefined,
      expectedVersion(req),
    );
    setEtag(res, t.version);
    return toTripDto(t);
  }

  /** เสนองานรถร่วม → OFFERED (ลิงก์รับงาน = ST3-T23) */
  @Post(':id/offer')
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

  /** ปล่อยรถ → DISPATCHED (ทุก DO → DISPATCHED) */
  @Post(':id/dispatch')
  @HttpCode(200)
  @TenantResource('trip')
  @RequireScope('trips:dispatch')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOkResponse({ type: TripDto })
  async dispatch(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TripDto> {
    const trip = await this.trips.get(decodeIdOr404('trip', id));
    const t = await this.trips.dispatch(trip.id, undefined, expectedVersion(req));
    setEtag(res, t.version);
    return toTripDto(t);
  }

  /** ปิดเที่ยว → COMPLETED (ทุกจุดจบแล้ว) */
  @Post(':id/complete')
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
