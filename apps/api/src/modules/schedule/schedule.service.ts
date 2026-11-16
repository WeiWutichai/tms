import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { SCHEDULE_MAX_SPAN_DAYS } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { TripService } from '../trips/trip.service';
import { daysBetween, isRealDate } from '../vehicle-documents/expiry';
import type {
  CreateScheduleEntryDto,
  ScheduleEntryDto,
  ScheduleEntryListQuery,
} from './schedule.dto';

/** ช่วงอ่านยาวสุดต่อคำขอ (วัน) */
export const SCHEDULE_LIST_MAX_DAYS = 62;

const INCLUDE = {
  driver: { select: { id: true, name: true } },
  vehicle: { select: { id: true, plate: true, plateProvince: true } },
} as const;
type Row = Prisma.ScheduleEntryGetPayload<{ include: typeof INCLUDE }>;

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (day: string) => new Date(`${day}T00:00:00Z`);

export function toDto(r: Row): ScheduleEntryDto {
  return {
    id: encodeId('scheduleEntry', r.id),
    kind: r.kind,
    driver: r.driver ? { id: encodeId('driver', r.driver.id), name: r.driver.name } : null,
    vehicle: r.vehicle
      ? {
          id: encodeId('vehicle', r.vehicle.id),
          plate: r.vehicle.plate,
          plateProvince: r.vehicle.plateProvince,
        }
      : null,
    startsOn: ymd(r.startsOn),
    endsOn: ymd(r.endsOn),
    note: r.note,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    cancelReason: r.cancelReason,
    createdAt: r.createdAt.toISOString(),
    version: r.version,
  };
}

/** snapshot สำหรับ audit (ไม่มี version/เวลา) */
const auditView = (r: Row) => ({
  kind: r.kind,
  driverId: r.driverId,
  driverName: r.driver?.name ?? null,
  vehicleId: r.vehicleId,
  plate: r.vehicle?.plate ?? null,
  startsOn: ymd(r.startsOn),
  endsOn: ymd(r.endsOn),
  note: r.note,
  ...(r.cancelledAt ? { cancelledAt: r.cancelledAt.toISOString() } : {}),
});

/**
 * ตารางรถ/คนขับรายวัน (ST3-T19; docs/04 D2 "ภาระงาน ว่าง ซ่อม ลา (คลิกขวาใส่วันลา/โน้ต)"; spec/06 FLT-302 ลาตามช่วงวันที่)
 * - LEAVE = วันลาคนขับ (ช่วงวันไทย รวมสองปลาย) — มีผลกับกฎตอนจัด `driver_on_leave` (ST3-T14), คนขับประจำใน
 *   รถที่รับได้ (ST3-T15 `driverHints`) และช่อง "ว่าง" ของกระดาน · วันลาของคนขับคนเดียวกันห้ามทับกัน (409)
 * - NOTE = โน้ตรายวันของคนขับหรือรถ (แสดงอย่างเดียว ไม่มีผลกับกฎ)
 * - ไม่ลบ — ยกเลิกพร้อมเหตุผล ≥ 10 ตัวอักษร · ทุกการเพิ่ม/ยกเลิกลง audit · ใส่/ยกเลิกวันลา → ตรวจกฎเที่ยวที่ยังไม่จบของคนขับใหม่
 */
@Injectable()
export class ScheduleService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly trips: TripService,
  ) {}

  async list(q: ScheduleEntryListQuery, tx: Tx = this.db.tx): Promise<ScheduleEntryDto[]> {
    for (const f of ['from', 'to'] as const)
      if (!isRealDate(q[f])) throw field422(f, 'invalid_date', 'must be a real date (YYYY-MM-DD)');
    if (q.to < q.from) throw field422('to', 'before_from', 'to must not be before from');
    if (daysBetween(q.from, q.to) >= SCHEDULE_LIST_MAX_DAYS)
      throw field422(
        'to',
        'range_too_long',
        `range must be at most ${SCHEDULE_LIST_MAX_DAYS} days`,
      );
    const ref = (kind: 'driver' | 'vehicle', v?: string) => {
      if (v === undefined) return undefined;
      const id = tryDecodeId(kind, v);
      if (!id) throw field422(`${kind}Id`, 'invalid_id', `must be a ${kind} id`);
      return id;
    };
    return this.range(tx, q.from, q.to, {
      driverId: ref('driver', q.driverId),
      vehicleId: ref('vehicle', q.vehicleId),
    });
  }

  /** รายการที่ยังไม่ยกเลิกซึ่งทับช่วง (ใช้ร่วมกับกระดาน) — เรียงวันเริ่ม → เวลาสร้าง */
  async range(
    tx: Tx,
    from: string,
    to: string,
    by: { driverId?: string | undefined; vehicleId?: string | undefined } = {},
  ): Promise<ScheduleEntryDto[]> {
    const rows = await tx.scheduleEntry.findMany({
      where: {
        cancelledAt: null,
        startsOn: { lte: dbDate(to) },
        endsOn: { gte: dbDate(from) },
        ...(by.driverId ? { driverId: by.driverId } : {}),
        ...(by.vehicleId ? { vehicleId: by.vehicleId } : {}),
      },
      include: INCLUDE,
      orderBy: [{ startsOn: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toDto);
  }

  async get(id: string, tx: Tx = this.db.tx): Promise<Row> {
    const r = await tx.scheduleEntry.findUnique({ where: { id }, include: INCLUDE });
    if (!r) throw new ProblemException('not_found');
    return r;
  }

  async create(b: CreateScheduleEntryDto, tx: Tx = this.db.tx): Promise<ScheduleEntryDto> {
    for (const f of ['startsOn', 'endsOn'] as const)
      if (!isRealDate(b[f]) || b[f] < '2000-01-01' || b[f] > '2100-12-31')
        throw field422(f, 'invalid_date', 'must be a real date between 2000 and 2100');
    if (b.endsOn < b.startsOn)
      throw field422('endsOn', 'before_start', 'endsOn must not be before startsOn');
    if (daysBetween(b.startsOn, b.endsOn) > SCHEDULE_MAX_SPAN_DAYS)
      throw field422(
        'endsOn',
        'range_too_long',
        `range must be at most ${SCHEDULE_MAX_SPAN_DAYS} days`,
      );
    const note = b.note.trim();
    if (!note) throw field422('note', 'required', 'note is required');
    if (b.kind === 'LEAVE' && b.vehicleId !== undefined)
      throw field422('vehicleId', 'not_allowed', 'leave belongs to a driver only');
    if ((b.driverId === undefined) === (b.vehicleId === undefined))
      throw field422(
        b.driverId === undefined ? 'driverId' : 'vehicleId',
        'exactly_one',
        'send exactly one of driverId, vehicleId',
      );

    let driverId: string | null = null;
    let vehicleId: string | null = null;
    if (b.driverId !== undefined) {
      const id = tryDecodeId('driver', b.driverId);
      // ล็อกแถวคนขับ — กันวันลาทับกันจากสองคำขอพร้อมกัน
      const [d] = id
        ? await tx.$queryRaw<{ id: string; status: string; deleted_at: Date | null }[]>`
            SELECT id, status::text AS status, deleted_at FROM driver WHERE id = ${id}::uuid FOR UPDATE`
        : [];
      if (!d || d.deleted_at) throw field422('driverId', 'invalid_reference', 'driver not found');
      if (d.status === 'INACTIVE')
        throw field422('driverId', 'driver_inactive', 'driver is inactive');
      driverId = d.id;
      if (b.kind === 'LEAVE') {
        const clash = await tx.scheduleEntry.findFirst({
          where: {
            driverId,
            kind: 'LEAVE',
            cancelledAt: null,
            startsOn: { lte: dbDate(b.endsOn) },
            endsOn: { gte: dbDate(b.startsOn) },
          },
          include: INCLUDE,
        });
        if (clash)
          throw new ProblemException(
            'conflict',
            `มีวันลาของคนขับคนนี้ทับช่วงนี้อยู่แล้ว (${ymd(clash.startsOn)} – ${ymd(clash.endsOn)})`,
            [{ field: 'startsOn', code: 'leave_overlap', message: 'overlaps an existing leave' }],
            { existing: toDto(clash) },
          );
      }
    } else {
      const id = tryDecodeId('vehicle', b.vehicleId!);
      const v = id
        ? await tx.vehicle.findFirst({
            where: { id, deletedAt: null },
            select: { id: true, status: true },
          })
        : null;
      if (!v) throw field422('vehicleId', 'invalid_reference', 'vehicle not found');
      if (v.status === 'RETIRED')
        throw field422('vehicleId', 'vehicle_retired', 'vehicle is retired');
      vehicleId = v.id;
    }

    const row = await tx.scheduleEntry.create({
      data: {
        tenantId: requestContext.require().tenantId!,
        kind: b.kind,
        driverId,
        vehicleId,
        startsOn: dbDate(b.startsOn),
        endsOn: dbDate(b.endsOn),
        note,
      },
      include: INCLUDE,
    });
    await this.audit.record({
      action: 'schedule_entry.created',
      entityType: 'schedule_entry',
      entityId: row.id,
      after: auditView(row),
    });
    if (row.kind === 'LEAVE' && driverId)
      await this.trips.refreshForDriverLeave(driverId, b.startsOn, b.endsOn, tx);
    return toDto(row);
  }

  /** ยกเลิก (ไม่ลบ) — เหตุผลลง audit · ยกเลิกแล้ว → 409 · If-Match ไม่ตรง → 412 */
  async cancel(
    id: string,
    reason: string,
    expected: number | undefined,
    tx: Tx = this.db.tx,
  ): Promise<ScheduleEntryDto> {
    await tx.$queryRaw`SELECT id FROM schedule_entry WHERE id = ${id}::uuid FOR UPDATE`;
    const cur = await this.get(id, tx);
    if (expected !== undefined && expected !== cur.version)
      throw new ProblemException('precondition_failed');
    if (cur.cancelledAt)
      throw new ProblemException('invalid_state_transition', 'รายการนี้ถูกยกเลิกแล้ว', [
        { field: 'id', code: 'cancelled', message: 'already cancelled' },
      ]);
    const row = await tx.scheduleEntry.update({
      where: { id },
      data: { cancelledAt: new Date(), cancelReason: reason, version: { increment: 1 } },
      include: INCLUDE,
    });
    await this.audit.record({
      action: 'schedule_entry.cancelled',
      entityType: 'schedule_entry',
      entityId: row.id,
      before: auditView(cur),
      after: auditView(row),
      reason,
    });
    if (row.kind === 'LEAVE' && row.driverId)
      await this.trips.refreshForDriverLeave(row.driverId, ymd(row.startsOn), ymd(row.endsOn), tx);
    return toDto(row);
  }
}
