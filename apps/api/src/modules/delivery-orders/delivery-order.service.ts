import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  DeliveryOrder,
  DeliveryOrderLine,
  DoStatus as DbDoStatus,
  SalesOrder,
  SalesOrderLine,
  SalesOrderStop,
} from '@prisma/client';
import {
  DO_TRANSITIONS,
  DoRuleError,
  checkMergeable,
  doTotals,
  isDoEditable,
  planAllocation,
  planMerge,
  planSplit,
  type DoEvent,
  type DoLinePlan,
  type DoLineRequest,
  type DoStatus,
  type SoLineInfo,
} from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { StateService } from '../../state/state.service';
import { cleanLine, stableStringify } from '../master/master-kit';
import { issueNumber } from '../sequences/sequences.service';
import { keysetArgs, type ListQuery } from '../../common/pagination';

export type DeliveryOrderRecord = DeliveryOrder & {
  lines: DeliveryOrderLine[];
  trip: { status: string } | null;
};

type OrderForDo = SalesOrder & {
  stops: SalesOrderStop[];
  lines: SalesOrderLine[];
  holdReasonCode: { code: string } | null;
};

export interface CreateFromOrderInput {
  /** ลำดับจุดส่ง (sales_order_stop.sequence) — บังคับเมื่อ SO มีจุดส่งมากกว่า 1 จุด (ORD-080 1 DO ต่อ 1 จุดส่ง) */
  destStopSeq?: number | null;
  /** ลำดับจุดรับ — ไม่ระบุ = จุดรับแรกของ SO */
  originStopSeq?: number | null;
  /** ปริมาณต่อบรรทัด SO — ไม่ระบุ = คงเหลือทั้งหมด (ห้ามเกินคงเหลือ) */
  lines?: DoLineRequest[] | null;
}

export interface DeliveryOrderFilter extends ListQuery {
  salesOrderId?: string;
  customerId?: string;
  statuses?: DoStatus[];
  /** YYYY-MM-DD */
  dateFrom?: string;
  dateTo?: string;
}

export interface CancelInput {
  /** เหตุผล ≥ 10 ตัวอักษร (MD-222) */
  note: string;
  /** reason code หมวด CANCEL (ไม่บังคับ) */
  reasonCodeId?: string | null;
}

/** ST4-T11 ยอดปฏิเสธรับของบรรทัด DO หนึ่งบรรทัด */
export interface RejectionLine {
  line: DeliveryOrderLine;
  reject: Prisma.Decimal;
  redelivered: Prisma.Decimal;
  returned: Prisma.Decimal;
  /** ยังไม่ได้ส่งซ้ำ/คืนคลัง */
  open: Prisma.Decimal;
}

export interface LineAllocation {
  salesOrderLineId: string;
  lineNo: number;
  unit: string;
  ordered: string;
  allocated: string;
  remaining: string;
}

const ENTITY = 'delivery_order';
const EVENT_TYPE = 'delivery_order.status_changed';
const CREATE_FROM = 'NONE';
const INCLUDE = {
  lines: { orderBy: { lineNo: 'asc' } },
  trip: { select: { status: true } },
} as const satisfies Prisma.DeliveryOrderInclude;

/**
 * **"DO อยู่ในเที่ยวที่ยังใช้งาน"** — นิยามเดียวที่ทุกจุดใช้ (ล็อกทางเข้า SO, แยก/รวม/ยกเลิก, sync):
 * DO ไม่ยกเลิก + มี trip_id + trip ไม่ CANCELLED · สัญญากับ ST3-T11: ยกเลิก trip ต้องล้าง trip_id ของ DO ที่ยังไม่ส่ง
 * (นิยามนี้ยังถูกแม้ trip_id ค้าง) — `ON_ACTIVE_TRIP_WHERE` (query) กับ `isOnActiveTrip` (แถวที่โหลดแล้ว) ต้องตรงกันเสมอ
 */
export const ON_ACTIVE_TRIP_WHERE = {
  // ST4-T11: คืนคลังแล้ว (RETURNED — สิ้นสุด ของกลับคลัง) ไม่นับว่าอยู่ในเที่ยว
  status: { notIn: ['CANCELLED', 'RETURNED'] },
  tripId: { not: null },
  trip: { is: { status: { not: 'CANCELLED' } } },
} as const satisfies Prisma.DeliveryOrderWhereInput;
export function isOnActiveTrip(d: {
  status: string;
  tripId: string | null;
  trip: { status: string } | null;
}): boolean {
  return (
    d.status !== 'CANCELLED' &&
    d.status !== 'RETURNED' &&
    d.tripId !== null &&
    d.trip !== null &&
    d.trip.status !== 'CANCELLED'
  );
}
/** SO ที่สร้าง/คง DO ได้: พ้นร่างและยังไม่วางแผน (หลังวางแผน DO เป็นของเที่ยว — ST3-T10/T11) */
const SO_DO_STATUSES = ['RECEIVED', 'ON_HOLD'] as const;
/** ใบค้างที่ห้าม **สร้าง** DO ใหม่ (ลูกค้า/สถานที่ใช้ไม่ได้, ข้อมูลต้นทางไม่ครบ) — DO ที่มีอยู่แล้วคงไว้ */
export const NOT_READY_HOLDS = new Set(['CUSTOMER_UNMAPPED', 'LOCATION_UNMAPPED', 'SOURCE_ERROR']);
/** สถานะ SO ที่ลง DO เข้าเที่ยวได้ (`isOrderPlannable` — กระดานวางแผน ST3-T12 ใช้ชุดเดียวกันเลือกงานรอจัด) */
export const PLANNABLE_SO_STATUSES = [
  'RECEIVED',
  'ON_HOLD',
  'PLANNED',
  'IN_TRANSIT',
  'PARTIALLY_DELIVERED',
] as const;
const SYSTEM_NOTE = {
  rebuilt: 'ใบสั่งขนส่งถูกแก้ไข — สร้างใบส่งของใหม่ทั้งชุด (ORD-085)',
};
/** event เมื่อ DO ชุดเดิมถูกยกเลิกเพราะ SO แก้ แต่ระบบสร้างใหม่ให้ไม่ได้ (หลายจุดส่ง/ยังไม่พร้อม) — ผู้จัดรถต้องสร้างเอง */
const REBUILD_REQUIRED_EVENT = 'delivery_order.rebuild_required';

const rule422 = (e: DoRuleError) => new ProblemException('validation_failed', undefined, e.issues);
const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

/**
 * ใบส่งของ (ST3-T09; docs/01 §3.3 + §4.3, docs/04 C แยก/รวม order, spec/03 §3) — **ทางเดียว** ที่เขียน delivery_order*
 * (test `delivery-orders` ตรวจ call path) · ไม่เขียน sales_order (สถานะ SO ตาม DO = ST3-T11 ผ่าน orders/order-state.service)
 *
 * - สร้างจาก SO: ค่าเริ่มต้น 1 DO = ทั้ง SO เมื่อ SO มีจุดส่งจุดเดียว (`syncWithOrder` เรียกจาก `upsertOrder` ทุกครั้ง)
 *   SO หลายจุดส่ง → ผู้จัดรถสร้างทีละจุดด้วย `createFromOrder` (ไม่มีการกระจายสินค้าต่อจุดใน SO — [OPEN] spec/12 §3)
 * - SO แก้ข้อมูลที่ DO ใช้ (ลูกค้า จุด สินค้า) ขณะ DO ยังไม่เข้าเที่ยว → DO ชุดเดิม CANCELLED แล้วสร้างใหม่ (ORD-085, ข้ามเลขได้)
 * - แยก (ORD-084): ใบแม่ CANCELLED (event `split`) → ใบลูก `{เลขแม่}-{n}` ปริมาณรวมต่อบรรทัดเท่าใบแม่พอดี
 * - รวม (ORD-086): ใบ DRAFT ของ SO + จุดส่งเดียวกัน → รวมเข้าใบแรก ใบอื่น CANCELLED (event `merge`)
 * - ยกเลิก: DRAFT ที่ยังไม่อยู่ในเที่ยว + เหตุผล ≥ 10 ตัวอักษร + audit
 * - ทุกงานเขียนล็อก SO (`FOR UPDATE` — ลำดับเดียวกับ upsertOrder) แล้วล็อก DO ของ SO นั้น → ปริมาณจัดสรรไม่เกินที่สั่งแม้ทำพร้อมกัน
 * - ไม่มีการลบจริง (REVOKE DELETE) · transition ผ่าน StateService (doc_status_history + `delivery_order.status_changed`)
 */
@Injectable()
export class DeliveryOrderService {
  constructor(
    private readonly db: DbService,
    private readonly state: StateService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // อ่าน

  /**
   * มี DO ของ SO นี้อยู่ในเที่ยวที่ยังไม่ยกเลิก (ORD-023: ทางเข้าแก้ SO ได้จนกว่า DO จะเข้าเที่ยว)
   * — เที่ยวเกิดใน ST3-T11 ก่อนหน้านั้นเป็น false เสมอ
   */
  async hasDoOnTrip(tx: Tx, salesOrderId: string): Promise<boolean> {
    return (await tx.deliveryOrder.count({ where: { salesOrderId, ...ON_ACTIVE_TRIP_WHERE } })) > 0;
  }

  /** SO พร้อมให้สร้าง DO ใหม่ไหม (T11/T12 ใช้ตรวจก่อนวางแผน DO ของ SO ที่ค้าง — DO เดิมคงอยู่แม้ SO ไม่พร้อม) */
  async isOrderReady(salesOrderId: string, tx: Tx = this.db.tx): Promise<boolean> {
    const so = await tx.salesOrder.findUnique({
      where: { id: salesOrderId },
      include: { stops: true, lines: true, holdReasonCode: { select: { code: true } } },
    });
    return !!so && isReady(so);
  }

  async listForOrder(
    salesOrderId: string,
    opts: { includeCancelled?: boolean } = {},
    tx: Tx = this.db.tx,
  ): Promise<DeliveryOrderRecord[]> {
    return tx.deliveryOrder.findMany({
      where: { salesOrderId, ...(opts.includeCancelled ? {} : { status: { not: 'CANCELLED' } }) },
      include: INCLUDE,
      orderBy: [{ createdAt: 'asc' }, { doNo: 'asc' }],
    });
  }

  /** รายการ DO (keyset บน updatedAt,id — docs/01 §5.1) กรองตาม SO / ลูกค้า / สถานะ / ช่วงวันที่ DO */
  async list(q: DeliveryOrderFilter, tx: Tx = this.db.tx) {
    const k = keysetArgs(q);
    const where: Prisma.DeliveryOrderWhereInput = {
      AND: [
        k.where as Prisma.DeliveryOrderWhereInput,
        q.salesOrderId ? { salesOrderId: q.salesOrderId } : {},
        q.customerId ? { customerId: q.customerId } : {},
        q.statuses?.length ? { status: { in: q.statuses as DbDoStatus[] } } : {},
        q.dateFrom ? { doDate: { gte: new Date(`${q.dateFrom}T00:00:00Z`) } } : {},
        q.dateTo ? { doDate: { lte: new Date(`${q.dateTo}T00:00:00Z`) } } : {},
      ],
    };
    const rows = await tx.deliveryOrder.findMany({
      where,
      include: INCLUDE,
      orderBy: [...k.orderBy],
      take: k.take,
    });
    return { rows, limit: k.limit };
  }

  async get(id: string, tx: Tx = this.db.tx): Promise<DeliveryOrderRecord> {
    const d = await tx.deliveryOrder.findUnique({ where: { id }, include: INCLUDE });
    if (!d) throw new ProblemException('not_found');
    return d;
  }

  /** ปริมาณสั่ง / จัดสรรแล้ว (DO ที่ไม่ยกเลิก) / คงเหลือ ต่อบรรทัด SO — ใช้ตรวจ "จัดครบ" (ST3-T11/T12) */
  async allocation(
    salesOrderId: string,
    tx: Tx = this.db.tx,
    /** ST4-T11: นับใบคืนคลัง (RETURNED) เป็นจัดสรรแล้ว — ใช้ตรวจ "จบครบ" ของ SO · ปกติไม่นับ (ของกลับคลัง สร้าง DO ใหม่ได้) */
    includeReturned = false,
  ): Promise<LineAllocation[]> {
    const lines = await tx.salesOrderLine.findMany({
      where: { salesOrderId },
      orderBy: { lineNo: 'asc' },
    });
    const sums = await tx.deliveryOrderLine.groupBy({
      by: ['salesOrderLineId'],
      where: {
        salesOrderLineId: { in: lines.map((l) => l.id) },
        // ST4-T11 ใบส่งซ้ำของที่ถูกปฏิเสธรับไม่นับ — ปริมาณยังอยู่ที่ใบเดิม (ส่งแล้วตามส่งจริง)
        deliveryOrder: {
          status: { notIn: includeReturned ? ['CANCELLED'] : ['CANCELLED', 'RETURNED'] },
          rejectedFromId: null,
        },
      },
      _sum: { qtyPlanned: true },
    });
    const got = new Map(sums.map((s) => [s.salesOrderLineId, s._sum.qtyPlanned]));
    return lines.map((l) => {
      const a = got.get(l.id) ?? new Prisma.Decimal(0);
      return {
        salesOrderLineId: l.id,
        lineNo: l.lineNo,
        unit: l.unit,
        ordered: dec(l.qtyOrdered)!,
        allocated: dec(a)!,
        remaining: dec(l.qtyOrdered.sub(a))!,
      };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // ใช้จาก OrderIntakeService (ภายใต้ล็อก SO เดียวกัน)

  /**
   * ให้ DO ตรงกับ SO หลัง upsert/reevaluate (ภายใต้ล็อก SO):
   * - DO ใดเข้าเที่ยว/พ้น DRAFT แล้ว → ไม่แตะ (ทางเข้าถูกล็อก `order_locked_for_update` — ST3-T10 จัดการ diff)
   * - ข้อมูลที่ใช้จัดสรรเปลี่ยน (ลูกค้า จุดรับ-ส่ง สินค้า — `allocationHash`) → DO ชุดเดิม CANCELLED ทั้งชุด (ORD-085)
   *   ถ้าระบบสร้างใหม่ให้ไม่ได้ (หลายจุดส่ง/ยังไม่พร้อม) → event `delivery_order.rebuild_required` ให้ผู้จัดรถรู้
   * - ข้อมูลหัวที่ไม่กระทบการจัดสรร (PO ลูกค้า, วันที่, ชื่อสินค้า) → แก้ใน DO เดิม (ไม่ยกเลิกใบที่คนแยกไว้)
   * - SO ไม่พร้อม (ค้างเพราะข้อมูลหลักปิดใช้/ต้นทางผิด) แต่ข้อมูลเดิม → **คง DO ไว้** (ไม่สร้างใหม่ — `isOrderReady` = false)
   * - สร้าง 1 DO = ทั้ง SO อัตโนมัติ **ครั้งเดียวต่อ hash**: มี DO ใดเคยใช้ hash นี้ (รวมใบที่คนยกเลิก/แยก/รวม) → ไม่สร้างซ้ำ
   *   (ใบที่ระบบยกเลิก/ถูกแยก/ถูกรวม ล้าง source_hash จึงไม่นับ — นับเฉพาะใบที่ยังใช้และใบที่คนยกเลิก) — คนยกเลิกแล้วส่งซ้ำค่าเดิม DO ไม่ฟื้น
   */
  async syncWithOrder(
    tx: Tx,
    salesOrderId: string,
    /** เลข DO ที่ `releaseOrderLines` ยกเลิกไปแล้วในคำขอเดียวกัน (นับเป็น rebuild เพื่อแจ้ง event) */
    alreadyCancelled: string[] = [],
  ): Promise<void> {
    const so = await this.lockOrder(tx, salesOrderId);
    if (!so) throw new ProblemException('not_found');
    const active = await this.lockActive(tx, salesOrderId);
    if (active.some((d) => d.status !== 'DRAFT' || isOnActiveTrip(d))) return;
    const hash = allocationHash(so);
    const drops = so.stops.filter((s) => s.type === 'DELIVERY');
    let remaining = active;
    const rebuilt = [...alreadyCancelled];
    if (active.some((d) => d.sourceHash !== hash)) {
      for (const d of active) await this.systemCancel(tx, d, SYSTEM_NOTE.rebuilt);
      rebuilt.push(...active.map((d) => d.doNo!));
      remaining = [];
    } else {
      for (const d of active) await this.refreshHeader(tx, so, d);
    }
    if (rebuilt.length && remaining.length === 0 && (drops.length !== 1 || !isReady(so)))
      await this.emitOrderEvent(tx, so.id, REBUILD_REQUIRED_EVENT, {
        cancelled: rebuilt,
        reason: drops.length !== 1 ? 'MULTI_DROP' : 'ORDER_NOT_READY',
      });
    if (!isReady(so) || remaining.length > 0 || drops.length !== 1) return;
    const used = await tx.deliveryOrder.count({ where: { salesOrderId, sourceHash: hash } });
    if (used > 0) return;
    await this.createOne(
      tx,
      so,
      so.lines.length ? this.plan(() => planAllocation(soLines(so), [])) : [],
      resolveStops(so, {}),
      hash,
      'auto',
    );
  }

  /**
   * ก่อน upsertOrder ลบบรรทัด SO (สินค้าลดลง): DO ที่ยังไม่ยกเลิกของ SO ถูกยกเลิก (จะสร้างใหม่ใน `syncWithOrder`)
   * แล้วปลดการอ้างของบรรทัด DO ที่ยกเลิกแล้ว (เหลือ snapshot so_line_no/description) — FK RESTRICT กันลบบรรทัดที่ DO ใช้อยู่
   */
  async releaseOrderLines(tx: Tx, salesOrderId: string, lineIds: string[]): Promise<string[]> {
    if (!lineIds.length) return [];
    await this.lockOrder(tx, salesOrderId);
    const active = await this.lockActive(tx, salesOrderId);
    if (active.some((d) => !isDoEditable(d.status as DoStatus) || isOnActiveTrip(d)))
      throw new ProblemException('order_locked_for_update');
    for (const d of active) await this.systemCancel(tx, d, SYSTEM_NOTE.rebuilt);
    await tx.deliveryOrderLine.updateMany({
      where: { salesOrderLineId: { in: lineIds }, deliveryOrder: { status: 'CANCELLED' } },
      data: { salesOrderLineId: null },
    });
    return active.map((d) => d.doNo!);
  }

  // ---------------------------------------------------------------------------------------------
  // งานของผู้จัดรถ (spec/03 §3.2 แยก/รวม: dispatcher) — endpoint มาพร้อมกระดาน/ใบส่งของ (ST3-T11/T12)

  /** สร้าง DO จาก SO (คงเหลือทั้งหมด หรือบางส่วน/ต่อจุดส่ง) — ห้ามจัดสรรเกินที่สั่ง */
  async createFromOrder(
    salesOrderId: string,
    input: CreateFromOrderInput = {},
    tx: Tx = this.db.tx,
  ): Promise<DeliveryOrderRecord> {
    const so = await this.lockOrder(tx, salesOrderId);
    if (!so) throw new ProblemException('not_found');
    if (!isReady(so)) throw new ProblemException('order_not_ready_for_delivery');
    const active = await this.lockActive(tx, salesOrderId);
    const stops = resolveStops(so, input);
    let lines: DoLinePlan[] = [];
    if (so.lines.length > 0) {
      const allocated = active
        .filter((d) => d.rejectedFromId === null && d.status !== 'RETURNED')
        .flatMap((d) => d.lines.filter(linked).map(lineAllocated));
      lines = this.plan(() => planAllocation(soLines(so), allocated, input.lines));
      if (lines.length === 0)
        throw field422('lines', 'fully_allocated', 'every order line is already allocated');
    } else if (input.lines?.length) {
      throw field422('lines', 'unknown_line', 'order has no lines');
    } else if (active.some((d) => d.destStopSeq === stops.dest)) {
      // SO ไม่มีสินค้า: ไม่มีอะไรให้แบ่ง — 1 DO ต่อจุดส่ง
      throw field422('destStopSeq', 'fully_allocated', 'this drop already has a delivery order');
    }
    return this.createOne(tx, so, lines, stops, allocationHash(so), 'manual');
  }

  /**
   * แยก DO (ORD-084): ใบ DRAFT ที่ยังไม่อยู่ในเที่ยว → `parts` (≥ 2) ปริมาณรวมต่อบรรทัดเท่าใบเดิมพอดี
   * ใบเดิม CANCELLED (event split) · ใบใหม่เลข `{เลขแม่}-{n}` (n ต่อจากใบลูกล่าสุดของแม่เดียวกัน) จุดรับ/ส่งเดิม
   */
  async split(
    deliveryOrderId: string,
    parts: DoLineRequest[][],
    tx: Tx = this.db.tx,
    expectedVersion?: number,
  ): Promise<DeliveryOrderRecord[]> {
    const src = await this.lockEditable(tx, deliveryOrderId, expectedVersion);
    const so = (await this.lockOrder(tx, src.salesOrderId))!;
    const plans = this.plan(() => planSplit(src.lines.filter(linked).map(linePlan), parts));
    const root = src.splitRootNo ?? src.doNo!;
    const last = await tx.deliveryOrder.aggregate({
      where: { splitRootNo: root },
      _max: { splitIndex: true },
    });
    let index = last._max.splitIndex ?? 0;
    const children: DeliveryOrderRecord[] = [];
    for (const lines of plans) {
      index += 1;
      children.push(
        await this.insert(tx, so, lines, {
          originStopSeq: src.originStopSeq,
          destStopSeq: src.destStopSeq,
          doNo: `${root}-${index}`,
          split: { fromId: src.id, rootNo: root, index },
          sourceHash: src.sourceHash,
          redeliveryOfId: src.redeliveryOfId,
          doDate: src.doDate.toISOString().slice(0, 10),
          rescheduleCount: src.rescheduleCount,
          rescheduleExhausted: src.rescheduleExhausted,
          redeliveryManual: src.redeliveryManual,
          rejectedFromId: src.rejectedFromId,
        }),
      );
    }
    await this.cancelOne(
      tx,
      src,
      'split',
      null,
      `แยกเป็น ${children.map((c) => c.doNo).join(', ')}`,
    );
    await this.audit.record({
      action: `${ENTITY}.split`,
      entityType: ENTITY,
      entityId: src.id,
      before: view(src),
      after: { children: children.map(view) },
    });
    return children;
  }

  /**
   * รวม DO (ORD-086): ใบ DRAFT ของ SO และจุดส่งเดียวกัน ที่ยังไม่อยู่ในเที่ยว → รวมเข้าใบแรกของรายการ
   * ใบอื่น CANCELLED (event merge) · ปริมาณ/น้ำหนักรวมเท่าเดิม
   */
  async merge(
    deliveryOrderIds: string[],
    tx: Tx = this.db.tx,
    /** If-Match ของใบปลายทาง (ใบแรก) */
    expectedVersion?: number,
  ): Promise<DeliveryOrderRecord> {
    if (new Set(deliveryOrderIds).size !== deliveryOrderIds.length || deliveryOrderIds.length < 2)
      throw field422(
        'deliveryOrderIds',
        'too_few',
        'merge needs at least 2 distinct delivery orders',
      );
    // อ่านก่อนล็อกเพื่อหา SO เท่านั้น — ทุกใบถูกอ่านใหม่ภายใต้ล็อก (SO → DO) ใน lockEditable ก่อนตัดสินใจใด ๆ
    const heads = await tx.deliveryOrder.findMany({
      where: { id: { in: deliveryOrderIds } },
      select: { id: true, salesOrderId: true },
    });
    if (heads.length !== deliveryOrderIds.length) throw new ProblemException('not_found');
    const soIds = [...new Set(heads.map((h) => h.salesOrderId))];
    if (soIds.length > 1)
      this.plan(() =>
        checkMergeable(
          deliveryOrderIds.map((id) => {
            const h = heads.find((x) => x.id === id)!;
            return {
              id,
              salesOrderId: h.salesOrderId,
              destStopSeq: 0,
              status: 'DRAFT',
              onTrip: false,
            };
          }),
        ),
      );
    await this.lockOrder(tx, soIds[0]!);
    const dos: DeliveryOrderRecord[] = [];
    for (const id of [...deliveryOrderIds].sort())
      dos.push(
        await this.lockEditable(tx, id, id === deliveryOrderIds[0] ? expectedVersion : undefined),
      );
    const ordered = deliveryOrderIds.map((id) => dos.find((d) => d.id === id)!);
    this.plan(() =>
      checkMergeable(
        ordered.map((d) => ({
          id: d.id,
          salesOrderId: d.salesOrderId,
          destStopSeq: d.destStopSeq,
          status: d.status as DoStatus,
          onTrip: d.tripId !== null,
        })),
      ),
    );
    // ST4-T11: ใบส่งซ้ำของที่ถูกปฏิเสธรับรวมได้เฉพาะกับใบที่อ้างใบเดิมเดียวกัน (ปริมาณจัดสรรของ SO ไม่เพี้ยน)
    if (new Set(ordered.map((d) => d.rejectedFromId)).size > 1)
      throw field422(
        'deliveryOrderIds',
        'redelivery_mismatch',
        'a redelivery of rejected goods merges only with redeliveries of the same delivery order',
      );
    const [target, ...others] = ordered as [DeliveryOrderRecord, ...DeliveryOrderRecord[]];
    const merged = this.plan(() =>
      planMerge(ordered.map((d) => d.lines.filter(linked).map(linePlan))),
    );
    const before = view(target);
    // บรรทัดเดิมของใบปลายทางแก้ค่า บรรทัดใหม่ต่อท้าย (ไม่มีการลบบรรทัด — ชุดที่รวมแล้วครอบบรรทัดเดิมเสมอ)
    let lineNo = target.lines.reduce((m, l) => Math.max(m, l.lineNo), 0);
    for (const l of merged) {
      const have = target.lines.find((x) => x.salesOrderLineId === l.salesOrderLineId);
      const data = { qtyPlanned: l.qty, weightKg: l.weightKg, cbm: l.cbm };
      if (have) await tx.deliveryOrderLine.update({ where: { id: have.id }, data });
      else
        await tx.deliveryOrderLine.create({
          data: {
            tenantId: target.tenantId,
            deliveryOrderId: target.id,
            lineNo: ++lineNo,
            salesOrderLineId: l.salesOrderLineId,
            soLineNo: l.soLineNo,
            description: l.description,
            unit: l.unit,
            ...data,
          },
        });
    }
    const totals = doTotals(merged);
    const r = await tx.deliveryOrder.updateMany({
      where: { id: target.id, status: 'DRAFT', version: target.version },
      data: { ...totals, version: { increment: 1 } },
    });
    if (r.count === 0) throw new ProblemException('concurrent_update');
    for (const d of others) await this.cancelOne(tx, d, 'merge', null, `รวมเข้า ${target.doNo}`);
    const final = await this.get(target.id, tx);
    await this.audit.record({
      action: `${ENTITY}.merged`,
      entityType: ENTITY,
      entityId: target.id,
      before: { target: before, merged: others.map(view) },
      after: view(final),
    });
    return final;
  }

  /** ยกเลิก DO (DRAFT ที่ยังไม่อยู่ในเที่ยว) — เหตุผล ≥ 10 ตัวอักษร + reason code หมวด CANCEL (ไม่บังคับ) + audit */
  async cancel(
    deliveryOrderId: string,
    input: CancelInput,
    tx: Tx = this.db.tx,
    expectedVersion?: number,
  ): Promise<DeliveryOrderRecord> {
    const note = cleanLine(String(input.note ?? '')).trim();
    if ([...note].length < 10)
      throw field422('note', 'too_short', 'reason must be at least 10 characters');
    if (input.reasonCodeId) {
      const rc = await tx.reasonCode.count({
        where: { id: input.reasonCodeId, category: 'CANCEL', status: 'ACTIVE', deletedAt: null },
      });
      if (!rc) throw field422('reasonCodeId', 'invalid_reference', 'reason code not found');
    }
    const d = await this.lockEditable(tx, deliveryOrderId, expectedVersion);
    // คนยกเลิก: คง source_hash ไว้ → ระบบไม่สร้าง DO คืนจากข้อมูลชุดเดิม (M1)
    await this.cancelOne(tx, d, 'cancel', input.reasonCodeId ?? null, note, true);
    const final = await this.get(d.id, tx);
    await this.audit.record({
      action: `${ENTITY}.cancelled`,
      entityType: ENTITY,
      entityId: d.id,
      before: { status: d.status },
      after: { status: final.status },
      reason: note,
    });
    return final;
  }

  /**
   * ยกเลิก SO (ST3-T10; ORD-036 "SO ที่ยกเลิก: DO ทั้งหมด cancelled") — ผู้เรียก (OrderStateService.cancel) ถือล็อก SO แล้ว
   * DO ใดอยู่ในเที่ยวที่ยังใช้ → 409 `order_on_trip` (docs/04 C "order ที่มี trip แล้วต้องถอดจาก trip ก่อน" — ไม่ถอดให้เอง)
   * DO ที่พ้น DRAFT นอกเที่ยว (ส่งแล้ว ฯลฯ) → 409 `invalid_state_transition` · DRAFT ทุกใบ → CANCELLED ด้วยเหตุผลเดียวกับ SO
   * (คนยกเลิก — คง source_hash) + audit ต่อใบ · คืนเลข DO ที่ยกเลิก
   */
  async cancelForOrder(
    tx: Tx,
    salesOrderId: string,
    input: { note: string; reasonCodeId: string | null },
  ): Promise<string[]> {
    // ST4-T11: ใบคืนคลัง (RETURNED — สิ้นสุด) คงไว้ ไม่กันการยกเลิกใบสั่ง (ใบค้าง ALL_RETURNED)
    const active = (await this.lockActive(tx, salesOrderId)).filter((d) => d.status !== 'RETURNED');
    const onTrip = active.filter((d) => isOnActiveTrip(d));
    if (onTrip.length)
      throw new ProblemException('order_on_trip', undefined, undefined, {
        deliveryOrders: onTrip.map((d) => d.doNo),
      });
    const done = active.filter((d) => d.status !== 'DRAFT');
    if (done.length)
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        deliveryOrders: done.map((d) => ({ doNo: d.doNo, status: d.status })),
      });
    for (const d of active) {
      await this.cancelOne(tx, d, 'cancel', input.reasonCodeId, input.note, true);
      await this.audit.record({
        action: `${ENTITY}.cancelled`,
        entityType: ENTITY,
        entityId: d.id,
        before: { status: d.status },
        after: { status: 'CANCELLED', by: 'order_cancel' },
        reason: input.note,
      });
    }
    return active.map((d) => d.doNo!);
  }

  // ---------------------------------------------------------------------------------------------
  // ใช้จาก TripService (ST3-T11) — ลำดับล็อก SO → DO → trip เสมอ (ผู้เรียกล็อก trip หลัง lockForTrip)

  /**
   * ล็อก SO ของ DO ทุกใบ (เรียง id) แล้วล็อก DO (เรียง id) → อ่านใหม่ภายใต้ล็อก
   * DO ไม่พบ (รวมของ tenant อื่น) → 422 `invalid_reference` ที่ช่อง `field`
   */
  async lockForTrip(
    tx: Tx,
    ids: string[],
    field = 'deliveryOrderIds',
  ): Promise<DeliveryOrderRecord[]> {
    const unique = [...new Set(ids)].sort();
    if (!unique.length) return [];
    const heads = await tx.deliveryOrder.findMany({
      where: { id: { in: unique } },
      select: { id: true, salesOrderId: true },
    });
    if (heads.length !== unique.length) {
      const known = new Set(heads.map((h) => h.id));
      throw new ProblemException(
        'validation_failed',
        undefined,
        ids.flatMap((id, i) =>
          known.has(id)
            ? []
            : [
                {
                  field: `${field}[${i}]`,
                  code: 'invalid_reference',
                  message: 'delivery order not found',
                },
              ],
        ),
      );
    }
    for (const so of [...new Set(heads.map((h) => h.salesOrderId))].sort())
      await tx.$queryRaw`SELECT id FROM sales_order WHERE id = ${so}::uuid FOR UPDATE`;
    await tx.$queryRaw`
      SELECT id FROM delivery_order WHERE id = ANY(${unique}::uuid[]) ORDER BY id FOR UPDATE`;
    return tx.deliveryOrder.findMany({
      where: { id: { in: unique } },
      include: INCLUDE,
      orderBy: { id: 'asc' },
    });
  }

  /**
   * ลง DO เข้าเที่ยว: ต้องเป็น DRAFT และไม่อยู่ในเที่ยวอื่นที่ยังใช้ (409 `delivery_order_on_trip`) — SO ต้องพร้อม
   * (`isOrderReady` — ค้างเพราะลูกค้า/สถานที่/ข้อมูลต้นทาง → 409 `order_not_ready_for_delivery`)
   * `plan` = เที่ยว ASSIGNED แล้ว → DRAFT → PLANNED (docs/01 §4.3)
   */
  async attachToTrip(
    tx: Tx,
    d: DeliveryOrderRecord,
    o: { tripId: string; pickupStopId: string; dropStopId: string; plan: boolean },
  ): Promise<void> {
    if (isOnActiveTrip(d) && d.tripId !== o.tripId)
      throw new ProblemException('delivery_order_on_trip', undefined, undefined, {
        deliveryOrderId: d.id,
        doNo: d.doNo,
      });
    if (d.status !== 'DRAFT')
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        deliveryOrderId: d.id,
        doNo: d.doNo,
        from: d.status,
      });
    // ST3-T10 [OPEN #56]: ต้นทางแก้หลังวางแผนรอตัดสินอยู่ → ห้ามลงเที่ยวจนกว่าจะรับ/ไม่รับ (ย้อนได้ง่ายสุด — ไม่วางแผนบนข้อมูลที่อาจเปลี่ยน)
    const flagged = await tx.salesOrder.count({
      where: { id: d.salesOrderId, sourceChangedAfterPlan: true },
    });
    if (flagged)
      throw new ProblemException('order_source_change_pending', undefined, undefined, {
        deliveryOrderId: d.id,
        doNo: d.doNo,
      });
    if (!(await this.isOrderPlannable(tx, d.salesOrderId, d.rejectedFromId !== null)))
      throw new ProblemException('order_not_ready_for_delivery', undefined, undefined, {
        deliveryOrderId: d.id,
        doNo: d.doNo,
      });
    const data = { tripId: o.tripId, pickupTripStopId: o.pickupStopId, tripStopId: o.dropStopId };
    if (o.plan) await this.move(tx, d, 'plan', data, null);
    else await this.write(tx, d, data);
  }

  /**
   * SO ของ DO ลงเที่ยวได้ไหม: ไม่ใช่ร่าง/ยกเลิก/ปิด และไม่ค้างเพราะลูกค้า/สถานที่/ข้อมูลต้นทาง
   * (ต่างจาก `isOrderReady` ตรงที่ SO PLANNED/IN_TRANSIT แล้วก็ลง DO ใบอื่นของ SO เดียวกันได้ — หลายจุดส่ง/แยก DO)
   */
  private async isOrderPlannable(
    tx: Tx,
    salesOrderId: string,
    /** ST4-T11 ใบส่งซ้ำของที่ถูกปฏิเสธรับ — ลงเที่ยวได้แม้ SO ส่งครบแล้ว (SO คง DELIVERED ไม่ถอยสถานะ) */
    rejectedRedelivery = false,
  ): Promise<boolean> {
    const so = await tx.salesOrder.findUnique({
      where: { id: salesOrderId },
      select: { status: true, holdReasonCode: { select: { code: true } } },
    });
    if (so && rejectedRedelivery && so.status === 'DELIVERED') return true;
    return (
      !!so &&
      (PLANNABLE_SO_STATUSES as readonly string[]).includes(so.status) &&
      !(so.status === 'ON_HOLD' && NOT_READY_HOLDS.has(so.holdReasonCode?.code ?? ''))
    );
  }

  /** จุดรับ/ส่งของ DO ในเที่ยวเดิมเปลี่ยน (จัดจุดใหม่หลังเพิ่ม/ถอด DO) — ไม่เปลี่ยนสถานะ */
  async setTripStops(tx: Tx, d: DeliveryOrderRecord, pickupStopId: string, dropStopId: string) {
    if (d.pickupTripStopId === pickupStopId && d.tripStopId === dropStopId) return;
    await this.write(tx, d, { pickupTripStopId: pickupStopId, tripStopId: dropStopId });
  }

  /** เที่ยว ASSIGNED → DO DRAFT → PLANNED */
  async planForTrip(tx: Tx, d: DeliveryOrderRecord): Promise<void> {
    if (d.status === 'DRAFT') await this.move(tx, d, 'plan', {}, null);
  }

  /**
   * เปลี่ยนผู้รับเหมาหลังรับงาน (ST3-T25 — เที่ยว ASSIGNED → PLANNING): DO PLANNED → `unplan` → DRAFT **คงอยู่ในเที่ยว**
   * (จุด/ลำดับเดิม — จ้างรายใหม่ต่อทันที) · DRAFT คงเดิม
   */
  async unplanForTrip(tx: Tx, d: DeliveryOrderRecord, note: string): Promise<void> {
    if (d.status === 'PLANNED') await this.move(tx, d, 'unplan', {}, note);
  }

  /** ปล่อยรถ → DO PLANNED → DISPATCHED (docs/01 §4.2 "ทุก DO ใน trip เป็น DISPATCHED") */
  async dispatchForTrip(tx: Tx, d: DeliveryOrderRecord): Promise<void> {
    await this.move(tx, d, 'dispatch', {}, null);
  }

  /**
   * ไล่สถานะจากจุดแวะ (ST4-T03; docs/01 §4.3): `pick_up` จุดรับปิด · `deliver` จุดส่งปิดสำเร็จ/บางส่วน · `fail` ส่งไม่สำเร็จ
   * (+ เหตุผลจาก event ที่ปิดจุด) — ผู้เรียกถือล็อก SO → DO → trip แล้ว และตรวจ transition ด้วย domain `deliveryOrderStopEvent`
   */
  async applyStopResult(
    tx: Tx,
    d: Pick<DeliveryOrderRecord, 'id' | 'status' | 'version'>,
    event: Extract<DoEvent, 'pick_up' | 'deliver' | 'fail'>,
    reasonCodeId: string | null,
    note: string | null,
  ): Promise<void> {
    await this.move(tx, d, event, {}, note, reasonCodeId);
  }

  /**
   * ผลคำนวณหลักฐานส่ง (ST4-T07; docs/01 §4.3): เขียน `pod_status` และไล่ DELIVERED → POD_PENDING / UNBILLED,
   * POD_PENDING → UNBILLED (domain `podDoEvent`) — ผู้เรียก (PodService) ถือล็อกแถว DO แล้ว · ไม่เปลี่ยน = ไม่เขียน
   */
  /**
   * ST4-T10 ฉายยอดส่งจริงจากหลักฐานส่งฉบับล่าสุดลงบรรทัด DO (ผู้เรียก = PodService ถือล็อก DO แล้ว · ตรวจค่าแล้ว — CHECK ฐานเป็นด่านสุดท้าย)
   */
  async applyActualQty(
    tx: Tx,
    deliveryOrderId: string,
    lines: {
      lineNo: number;
      qtyActual: string;
      rejectQty: string;
      rejectReasonCodeId: string | null;
    }[],
  ): Promise<void> {
    for (const l of lines)
      await tx.deliveryOrderLine.updateMany({
        where: { deliveryOrderId, lineNo: l.lineNo },
        data: {
          qtyActual: l.qtyActual,
          rejectQty: l.rejectQty,
          rejectReasonCodeId: l.rejectReasonCodeId,
        },
      });
  }

  async applyPodResult(
    tx: Tx,
    d: Pick<DeliveryOrderRecord, 'id' | 'status' | 'version' | 'podStatus'>,
    podStatus: string,
    event: Extract<DoEvent, 'pod_wait' | 'pod_accept'> | null,
    note: string | null,
  ): Promise<void> {
    if (event) return this.move(tx, d, event, { podStatus }, note);
    if (d.podStatus === podStatus) return;
    const r = await tx.deliveryOrder.updateMany({
      where: { id: d.id, status: d.status as DbDoStatus, version: d.version },
      data: { podStatus, version: { increment: 1 } },
    });
    if (r.count === 0) throw new ProblemException('concurrent_update');
  }

  /**
   * ปลด DO ออกจากเที่ยว (ถอด DO / ยกเลิกเที่ยว): ล้าง trip_id + จุด (สัญญากับ T09) แล้ว
   * DRAFT คงเดิม · PLANNED → `unplan` → DRAFT · DISPATCHED → `recall` → DRAFT (ยกเลิกเที่ยวที่ปล่อยแล้วก่อนรับของ)
   * PICKED_UP ขึ้นไป (ของอยู่บนรถ/ส่งแล้ว) → 409 `trip_has_loaded_orders` (ปิดเที่ยวบางส่วน + เที่ยวใหม่ — ST4)
   */
  async releaseFromTrip(tx: Tx, d: DeliveryOrderRecord, note: string): Promise<void> {
    const clear = { tripId: null, pickupTripStopId: null, tripStopId: null };
    if (d.status === 'DRAFT') return this.write(tx, d, clear);
    if (d.status === 'PLANNED') return this.move(tx, d, 'unplan', clear, note);
    if (d.status === 'DISPATCHED') return this.move(tx, d, 'recall', clear, note);
    throw new ProblemException('trip_has_loaded_orders', undefined, undefined, {
      deliveryOrderId: d.id,
      doNo: d.doNo,
      status: d.status,
    });
  }

  /**
   * ส่งใหม่ (docs/01 §4.3 `FAILED → redeliver`; D-23 "DO ใบใหม่ — ไม่วน DO เดิม"): DO เดิม FAILED → CANCELLED
   * (event `redeliver` + เหตุผลของการส่งไม่สำเร็จ) แล้วสร้าง DO ใหม่ DRAFT **นอกเที่ยว** อ้าง `redelivery_of` —
   * บรรทัด/จุดรับ-ส่ง/น้ำหนักเท่าใบเดิม, วันส่ง `doDate` (ST4-T12 นัดส่งใหม่อัตโนมัติ = วันถัดไป) → ลงกล่อง "SO รอจัด" ของกระดาน
   * (ไม่จัดรถให้เอง) · ผู้เรียกถือล็อก SO → DO แล้ว (projection: `StopProjectionService.lockTrip`) · ST4-T11 (ส่งซ้ำมือ) ใช้ทางเดียวกัน
   * ไม่ใช่ FAILED → 409 `invalid_state_transition` (ส่งใหม่ไปแล้ว = ใบเดิม CANCELLED — กันสร้างซ้ำ)
   */
  async redeliver(
    tx: Tx,
    id: string,
    o: {
      doDate: string;
      rescheduleCount: number;
      /** ST4-T12 ครั้งนี้เกินค่าตั้ง (เหตุรอง RESCHEDULES_EXHAUSTED ของใบสั่ง) */
      exhausted?: boolean;
      reasonCodeId: string | null;
      note: string;
      mode: 'auto' | 'manual';
    },
  ): Promise<DeliveryOrderRecord> {
    const src = await this.get(id, tx);
    if (src.status !== 'FAILED')
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        deliveryOrderId: src.id,
        doNo: src.doNo,
        from: src.status,
      });
    const so = await this.lockOrder(tx, src.salesOrderId);
    if (!so) throw new ProblemException('not_found');
    await this.cancelOne(tx, src, 'redeliver', o.reasonCodeId, o.note);
    const d = await this.insert(tx, so, src.lines.filter(linked).map(linePlan), {
      originStopSeq: src.originStopSeq,
      destStopSeq: src.destStopSeq,
      doNo: await issueNumber(tx, this.tenantId(), { docType: 'DO' }),
      split: null,
      sourceHash: src.sourceHash,
      redeliveryOfId: src.id,
      doDate: o.doDate,
      rescheduleCount: o.rescheduleCount,
      rescheduleExhausted: o.exhausted ?? false,
      redeliveryManual: o.mode === 'manual',
      // ใบส่งซ้ำของที่ถูกปฏิเสธรับส่งไม่สำเร็จอีก → ใบใหม่ยังเป็นของชุดเดิม (ไม่นับจัดสรร SO)
      rejectedFromId: src.rejectedFromId,
    });
    await this.audit.record({
      action: `${ENTITY}.redelivered`,
      entityType: ENTITY,
      entityId: src.id,
      before: view(src),
      after: {
        ...view(d),
        id: d.id,
        doDate: o.doDate,
        rescheduleCount: o.rescheduleCount,
        mode: o.mode,
      },
      reason: o.note,
    });
    return d;
  }

  // ---------------------------------------------------------------------------------------------
  // ST4-T11 ตีกลับบางส่วน/ทั้งหมด (docs/04 E2; docs/01 §4.3) — ผู้เรียก (DeliveryOrderReturnService) ถือล็อก SO → DO แล้ว

  /**
   * ยอดที่ลูกค้าปฏิเสธรับต่อบรรทัด (POD ฉบับล่าสุด) / ส่งซ้ำแล้ว (DO ที่ยังไม่ยกเลิกซึ่งอ้าง `rejected_from` ใบนี้ —
   * รวมใบที่แยก/ส่งใหม่ต่อ) / คืนคลังแล้ว / **คงเหลือรอจัดการ** — กันส่งซ้ำ/คืนคลังเกินที่ปฏิเสธ (กดซ้ำได้ 422)
   */
  async rejectionBalance(
    tx: Tx,
    srcs: Pick<DeliveryOrderRecord, 'id' | 'lines'>[],
  ): Promise<Map<string, RejectionLine[]>> {
    const kids = srcs.length
      ? await tx.deliveryOrder.findMany({
          where: { rejectedFromId: { in: srcs.map((d) => d.id) }, status: { not: 'CANCELLED' } },
          select: {
            rejectedFromId: true,
            lines: { select: { salesOrderLineId: true, qtyPlanned: true } },
          },
        })
      : [];
    const zero = new Prisma.Decimal(0);
    const out = new Map<string, RejectionLine[]>();
    for (const src of srcs) {
      const got = new Map<string, Prisma.Decimal>();
      for (const k of kids.filter((x) => x.rejectedFromId === src.id))
        for (const l of k.lines)
          if (l.salesOrderLineId)
            got.set(l.salesOrderLineId, (got.get(l.salesOrderLineId) ?? zero).add(l.qtyPlanned));
      out.set(
        src.id,
        src.lines.map((l) => {
          const reject = l.rejectQty ?? zero;
          const redelivered = (l.salesOrderLineId && got.get(l.salesOrderLineId)) || zero;
          const open = reject.sub(redelivered).sub(l.returnedQty);
          return {
            line: l,
            reject,
            redelivered,
            returned: l.returnedQty,
            open: open.lt(0) ? zero : open,
          };
        }),
      );
    }
    return out;
  }

  /**
   * ส่งซ้ำของที่ถูกปฏิเสธรับ: **ใบเดิมคงส่งแล้ว** (ยอดตามส่งจริง — วางบิล/ยอดประมาณไม่เปลี่ยน) + DO ใหม่ DRAFT นอกเที่ยว
   * อ้าง `redelivery_of` + `rejected_from` = ใบเดิม ปริมาณ = ที่เลือก (น้ำหนัก/ปริมาตรตามสัดส่วน) จุดรับ-ส่งเดิม
   * ใบเดิม version + 1 (If-Match ของคำขอซ้ำ → 412) + audit
   */
  async redeliverRejected(
    tx: Tx,
    src: DeliveryOrderRecord,
    take: { lineId: string; qty: Prisma.Decimal }[],
    o: { doDate: string; reasonCodeId: string; reason: string; before: unknown },
  ): Promise<DeliveryOrderRecord> {
    const so = await this.lockOrder(tx, src.salesOrderId);
    if (!so) throw new ProblemException('not_found');
    const lines: DoLinePlan[] = take.map((t) => {
      const l = src.lines.find((x) => x.id === t.lineId)!;
      return {
        salesOrderLineId: l.salesOrderLineId!,
        soLineNo: l.soLineNo,
        description: l.description,
        qty: dec(t.qty)!,
        unit: l.unit,
        weightKg: part(l.weightKg, t.qty, l.qtyPlanned),
        cbm: part(l.cbm, t.qty, l.qtyPlanned),
      };
    });
    const d = await this.insert(tx, so, lines, {
      originStopSeq: src.originStopSeq,
      destStopSeq: src.destStopSeq,
      doNo: await issueNumber(tx, this.tenantId(), { docType: 'DO' }),
      split: null,
      sourceHash: src.sourceHash,
      redeliveryOfId: src.id,
      doDate: o.doDate,
      rescheduleCount: 0,
      redeliveryManual: true,
      rejectedFromId: src.id,
    });
    await this.write(tx, src, {});
    await this.audit.record({
      action: `${ENTITY}.rejected_redelivered`,
      entityType: ENTITY,
      entityId: src.id,
      before: { doNo: src.doNo, status: src.status, rejection: o.before },
      after: { ...view(d), id: d.id, doDate: o.doDate, reasonCodeId: o.reasonCodeId },
      reason: o.reason,
    });
    return d;
  }

  /** คืนคลังของที่ถูกปฏิเสธรับ (ใบเดิมคงส่งแล้ว): `returned_qty` ต่อบรรทัด + version + 1 + audit */
  async returnRejected(
    tx: Tx,
    src: DeliveryOrderRecord,
    take: { lineId: string; qty: Prisma.Decimal }[],
    o: { reasonCodeId: string; reason: string; before: unknown },
  ): Promise<void> {
    for (const t of take)
      await tx.deliveryOrderLine.update({
        where: { id: t.lineId },
        data: { returnedQty: { increment: t.qty } },
      });
    await this.write(tx, src, {});
    await this.audit.record({
      action: `${ENTITY}.rejected_returned`,
      entityType: ENTITY,
      entityId: src.id,
      before: { doNo: src.doNo, status: src.status, rejection: o.before },
      after: {
        returned: take.map((t) => ({
          lineNo: src.lines.find((l) => l.id === t.lineId)!.lineNo,
          qty: dec(t.qty),
        })),
        reasonCodeId: o.reasonCodeId,
      },
      reason: o.reason,
    });
  }

  /** ส่งไม่สำเร็จทั้งใบ → คืนคลัง (docs/01 §4.3 FAILED → RETURNED) + เหตุผล + audit */
  async returnFailed(
    tx: Tx,
    src: DeliveryOrderRecord,
    o: { reasonCodeId: string; reason: string },
  ): Promise<void> {
    await this.move(tx, src, 'return', {}, o.reason, o.reasonCodeId);
    await this.audit.record({
      action: `${ENTITY}.returned`,
      entityType: ENTITY,
      entityId: src.id,
      before: { doNo: src.doNo, status: src.status },
      after: { status: 'RETURNED', reasonCodeId: o.reasonCodeId },
      reason: o.reason,
    });
  }

  /**
   * ใบนี้ถูกยกเลิกด้วย `redeliver` ไหม (สถานะล่าสุดในประวัติ = redeliver) — หลักฐานชุดไม่สำเร็จยังบันทึกได้ (review H2),
   * คืนได้เมื่อผลส่งไม่สำเร็จถูกพลิก (review H1b)
   */
  async isRedeliverCancelled(tx: Tx, id: string, status?: string): Promise<boolean> {
    if (status === undefined)
      status = (await tx.deliveryOrder.findUnique({ where: { id }, select: { status: true } }))
        ?.status;
    if (status !== 'CANCELLED') return false;
    // เวลาในประวัติเท่ากันภายใน transaction เดียว (now()) — นับจำนวนแทนการเรียงเวลา:
    // ส่งใหม่มากกว่าคืน = ยกเลิกครั้งล่าสุดมาจาก redeliver (ใบที่คืนแล้วยกเลิกทางอื่นต้องผ่าน DRAFT → cancel)
    const rows = await tx.docStatusHistory.groupBy({
      by: ['event'],
      where: { docType: ENTITY, docId: id, event: { in: ['redeliver', 'restore'] } },
      _count: { _all: true },
    });
    const n = (e: string) => rows.find((r) => r.event === e)?._count._all ?? 0;
    return n('redeliver') > n('restore');
  }

  /**
   * ST4-T12 (review H1b; [DECISION spec/12 §3]): ผลส่งไม่สำเร็จที่ทำให้นัดส่งใหม่ถูกพลิก (ผู้จัดรถไม่ใช้ event /
   * event อื่นชนะ) และ DO ส่งใหม่ทุกใบยัง DRAFT นอกเที่ยว → ระบบยกเลิก DO ส่งใหม่ (เหตุผล + audit) แล้วคืนใบเดิม
   * CANCELLED → `restore` → DISPATCHED (กลับไปไล่จากจุดแวะ) · DO ส่งใหม่ถูกจัดรถแล้ว → คืน false (ผู้เรียกขึ้นธง
   * OUTCOME_MISMATCH ให้ผู้จัดรถ) · ผู้เรียกถือล็อก SO → DO ของใบเดิมแล้ว
   */
  async restoreRedelivered(tx: Tx, id: string, note: string): Promise<boolean> {
    const src = await this.get(id, tx);
    if (!(await this.isRedeliverCancelled(tx, id, src.status))) return false;
    // ลูกหลานทั้งหมด = ใบที่อ้างใบนี้ (ใบส่งใหม่ + ใบที่แยกจากใบส่งใหม่ — แยกคง redelivery_of เดิม)
    await tx.$queryRaw`
      SELECT id FROM delivery_order WHERE redelivery_of_id = ${id}::uuid ORDER BY id FOR UPDATE`;
    const all = await tx.deliveryOrder.findMany({
      where: { redeliveryOfId: id },
      include: INCLUDE,
      orderBy: { id: 'asc' },
    });
    // review M: คืนได้เฉพาะเมื่อลูกหลานทุกใบ "ยังไม่เคยไปไหน" — DRAFT นอกเที่ยว ไม่เคยแก้/ถูกรวมเข้า (version 1)
    // และประวัติมีแค่การสร้าง · ใบที่ยกเลิกได้เฉพาะเพราะถูกแยก · อื่น (เคยจัดรถ/ส่งใหม่ต่อ/ถูกรวม/คนยกเลิก) → false (ผู้เรียกขึ้นธง)
    const hist = await tx.docStatusHistory.findMany({
      where: { docType: ENTITY, docId: { in: all.map((d) => d.id) } },
      select: { docId: true, event: true },
    });
    const CREATE = ['create', 'redelivery_create', 'split_create'];
    const clean = all.every((d) => {
      const evs = hist.filter((h) => h.docId === d.id).map((h) => h.event);
      if (d.status === 'DRAFT')
        return d.tripId === null && d.version === 1 && evs.every((e) => CREATE.includes(e));
      return d.status === 'CANCELLED' && evs.every((e) => CREATE.includes(e) || e === 'split');
    });
    // ST4-T11: ส่งซ้ำมือ (ผู้ใช้ตัดสินแล้ว) → ไม่คืนเอง (ผู้เรียกขึ้นธง OUTCOME_MISMATCH)
    if (!all.length || !clean || all.some((d) => d.redeliveryManual)) return false;
    const kids = all.filter((d) => d.status === 'DRAFT');
    for (const k of kids) await this.systemCancel(tx, k, note);
    await this.state.transition<DoStatus, DoEvent>(tx, {
      docType: ENTITY,
      docId: src.id,
      table: DO_TRANSITIONS,
      from: 'CANCELLED',
      event: 'restore',
      note,
      eventType: EVENT_TYPE,
      apply: async (to) => {
        const r = await tx.deliveryOrder.updateMany({
          where: { id: src.id, status: 'CANCELLED', version: src.version },
          data: { status: to as DbDoStatus, version: { increment: 1 } },
        });
        if (r.count === 0) throw new ProblemException('concurrent_update');
        return eventView(await this.get(src.id, tx));
      },
    });
    await this.audit.record({
      action: `${ENTITY}.redelivery_reverted`,
      entityType: ENTITY,
      entityId: src.id,
      before: { status: 'CANCELLED', redeliveries: kids.map((k) => k.doNo) },
      after: { status: 'DISPATCHED' },
      reason: note,
    });
    return true;
  }

  private async write(
    tx: Tx,
    d: DeliveryOrderRecord,
    data: Prisma.DeliveryOrderUncheckedUpdateManyInput,
  ): Promise<void> {
    const r = await tx.deliveryOrder.updateMany({
      where: { id: d.id, status: d.status as DbDoStatus, version: d.version },
      data: { ...data, version: { increment: 1 } },
    });
    if (r.count === 0) throw new ProblemException('concurrent_update');
  }

  private async move(
    tx: Tx,
    d: Pick<DeliveryOrderRecord, 'id' | 'status' | 'version'>,
    event: Extract<
      DoEvent,
      | 'plan'
      | 'unplan'
      | 'dispatch'
      | 'recall'
      | 'pick_up'
      | 'deliver'
      | 'fail'
      | 'pod_wait'
      | 'pod_accept'
      | 'return'
    >,
    data: Prisma.DeliveryOrderUncheckedUpdateManyInput,
    note: string | null,
    reasonCodeId: string | null = null,
  ): Promise<void> {
    await this.state.transition<DoStatus, DoEvent>(tx, {
      docType: ENTITY,
      docId: d.id,
      table: DO_TRANSITIONS,
      from: d.status as DoStatus,
      event,
      note,
      reasonCodeId,
      eventType: EVENT_TYPE,
      apply: async (to) => {
        const r = await tx.deliveryOrder.updateMany({
          where: { id: d.id, status: d.status as DbDoStatus, version: d.version },
          data: { ...data, status: to as DbDoStatus, version: { increment: 1 } },
        });
        if (r.count === 0) throw new ProblemException('concurrent_update');
        return eventView(await this.get(d.id, tx));
      },
    });
  }

  // ---------------------------------------------------------------------------------------------

  private tenantId(): string {
    const t = requestContext.require().tenantId;
    if (!t) throw new Error('delivery orders: tenant missing in request context');
    return t;
  }

  private plan<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof DoRuleError) throw rule422(e);
      throw e;
    }
  }

  /** ล็อก SO (ลำดับเดียวกับ upsertOrder: SO ก่อน DO) แล้วอ่านใหม่ */
  private async lockOrder(tx: Tx, id: string): Promise<OrderForDo | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM sales_order WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) return null;
    return tx.salesOrder.findUnique({
      where: { id },
      include: {
        stops: { orderBy: { sequence: 'asc' } },
        lines: { orderBy: { lineNo: 'asc' } },
        holdReasonCode: { select: { code: true } },
      },
    });
  }

  /** DO ที่ยังไม่ยกเลิกของ SO (ล็อกตามลำดับ id) */
  private async lockActive(tx: Tx, salesOrderId: string): Promise<DeliveryOrderRecord[]> {
    await tx.$queryRaw`
      SELECT id FROM delivery_order WHERE sales_order_id = ${salesOrderId}::uuid AND status <> 'CANCELLED'
      ORDER BY id FOR UPDATE`;
    return tx.deliveryOrder.findMany({
      where: { salesOrderId, status: { not: 'CANCELLED' } },
      include: INCLUDE,
      orderBy: { id: 'asc' },
    });
  }

  /** ล็อก SO ของ DO ก่อน แล้วล็อก DO → ต้องเป็น DRAFT และไม่อยู่ในเที่ยว */
  private async lockEditable(
    tx: Tx,
    id: string,
    expectedVersion?: number,
  ): Promise<DeliveryOrderRecord> {
    const head = await tx.deliveryOrder.findUnique({
      where: { id },
      select: { salesOrderId: true },
    });
    if (!head) throw new ProblemException('not_found');
    await this.lockOrder(tx, head.salesOrderId);
    await tx.$queryRaw`SELECT id FROM delivery_order WHERE id = ${id}::uuid FOR UPDATE`;
    const d = await this.get(id, tx);
    if (expectedVersion !== undefined && d.version !== expectedVersion)
      throw new ProblemException('precondition_failed');
    if (isOnActiveTrip(d))
      throw new ProblemException('delivery_order_on_trip', undefined, undefined, {
        status: d.status,
      });
    if (!isDoEditable(d.status as DoStatus))
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        from: d.status,
      });
    return d;
  }

  private async createOne(
    tx: Tx,
    so: OrderForDo,
    lines: DoLinePlan[],
    stops: { origin: number; dest: number },
    hash: string,
    mode: 'auto' | 'manual',
  ): Promise<DeliveryOrderRecord> {
    const d = await this.insert(tx, so, lines, {
      originStopSeq: stops.origin,
      destStopSeq: stops.dest,
      doNo: await issueNumber(tx, this.tenantId(), { docType: 'DO' }),
      split: null,
      sourceHash: hash,
      redeliveryOfId: null,
    });
    await this.audit.record({
      action: `${ENTITY}.created`,
      entityType: ENTITY,
      entityId: d.id,
      after: { ...view(d), mode },
    });
    return d;
  }

  /** ยกเลิกโดยระบบ (SO แก้/ไม่พร้อม) — เหตุผลเป็นข้อความระบบ + audit */
  private async systemCancel(tx: Tx, d: DeliveryOrderRecord, note: string) {
    await this.cancelOne(tx, d, 'cancel', null, note);
    await this.audit.record({
      action: `${ENTITY}.cancelled`,
      entityType: ENTITY,
      entityId: d.id,
      before: { status: d.status },
      after: { status: 'CANCELLED', by: 'system' },
      reason: note,
    });
  }

  private async insert(
    tx: Tx,
    so: OrderForDo,
    lines: DoLinePlan[],
    o: {
      originStopSeq: number;
      destStopSeq: number;
      doNo: string;
      split: { fromId: string; rootNo: string; index: number } | null;
      sourceHash: string | null;
      redeliveryOfId: string | null;
      /** วันส่ง (YYYY-MM-DD) — ไม่ระบุ = วันที่ลูกค้าขอของ SO (ส่งใหม่ = วันที่นัด — ST4-T12) */
      doDate?: string;
      rescheduleCount?: number;
      rescheduleExhausted?: boolean;
      /** ST4-T11 ส่งซ้ำมือ (ไม่คืนใบเดิมเอง) */
      redeliveryManual?: boolean;
      /** ST4-T11 ใบส่งซ้ำของที่ถูกปฏิเสธรับจากใบนี้ (ไม่นับจัดสรร SO) */
      rejectedFromId?: string | null;
    },
  ): Promise<DeliveryOrderRecord> {
    const tenantId = this.tenantId();
    const origin = so.stops.find((s) => s.sequence === o.originStopSeq)!;
    const dest = so.stops.find((s) => s.sequence === o.destStopSeq)!;
    const row = await tx.deliveryOrder.create({
      data: {
        tenantId,
        doNo: o.doNo,
        doDate: o.doDate ? new Date(`${o.doDate}T00:00:00Z`) : so.requestedDate,
        salesOrderId: so.id,
        customerId: so.customerId!,
        originSiteId: origin.siteId!,
        destSiteId: dest.siteId!,
        originStopSeq: o.originStopSeq,
        destStopSeq: o.destStopSeq,
        ...doTotals(lines),
        customerRef: so.customerRef,
        sourceHash: o.sourceHash,
        redeliveryOfId: o.redeliveryOfId,
        rescheduleCount: o.rescheduleCount ?? 0,
        rescheduleExhausted: o.rescheduleExhausted ?? false,
        redeliveryManual: o.redeliveryManual ?? false,
        rejectedFromId: o.rejectedFromId ?? null,
        splitFromId: o.split?.fromId ?? null,
        splitRootNo: o.split?.rootNo ?? null,
        splitIndex: o.split?.index ?? null,
        status: 'DRAFT',
        lines: {
          create: lines.map((l, i) => ({
            tenantId,
            lineNo: i + 1,
            salesOrderLineId: l.salesOrderLineId,
            soLineNo: l.soLineNo,
            description: l.description,
            qtyPlanned: l.qty,
            unit: l.unit,
            weightKg: l.weightKg,
            cbm: l.cbm,
          })),
        },
      },
      include: INCLUDE,
    });
    await this.history(
      tx,
      row.id,
      CREATE_FROM,
      'DRAFT',
      o.split ? 'split_create' : o.redeliveryOfId ? 'redelivery_create' : 'create',
    );
    await this.emit(tx, row, { status: null });
    return row;
  }

  /**
   * DRAFT → CANCELLED ด้วย event cancel/split/merge · FAILED → CANCELLED ด้วย redeliver (กันชน where status เดิม)
   * source_hash ถูกล้าง **ยกเว้นคนยกเลิก** (`keepHash`) — ใบที่ถูกแยก/รวม/ระบบยกเลิก ไม่กันการสร้าง DO อัตโนมัติจากข้อมูลชุดนั้น
   */
  private async cancelOne(
    tx: Tx,
    d: DeliveryOrderRecord,
    event: Extract<DoEvent, 'cancel' | 'split' | 'merge' | 'redeliver'>,
    reasonCodeId: string | null,
    note: string,
    keepHash = false,
  ) {
    await this.state.transition<DoStatus, DoEvent>(tx, {
      docType: ENTITY,
      docId: d.id,
      table: DO_TRANSITIONS,
      from: d.status as DoStatus,
      event,
      reasonCodeId,
      note,
      eventType: EVENT_TYPE,
      apply: async (to) => {
        const r = await tx.deliveryOrder.updateMany({
          where: { id: d.id, status: d.status as DbDoStatus },
          data: {
            status: to as DbDoStatus,
            version: { increment: 1 },
            ...(keepHash ? {} : { sourceHash: null }),
          },
        });
        if (r.count === 0) throw new ProblemException('concurrent_update');
        return eventView(await this.get(d.id, tx));
      },
    });
  }

  /** แก้ข้อมูลหัว/ชื่อสินค้าของ DO ตาม SO (ไม่กระทบปริมาณ) — ใบ DRAFT นอกเที่ยวเท่านั้น */
  private async refreshHeader(tx: Tx, so: OrderForDo, d: DeliveryOrderRecord) {
    // DO ส่งใหม่ (redelivery_of) คงวันที่นัดไว้ — ไม่ย้อนกลับไปวันที่ลูกค้าขอเดิมของ SO (ST4-T12)
    const head = {
      customerRef: so.customerRef,
      doDate: d.redeliveryOfId ? d.doDate : so.requestedDate,
    };
    const names = new Map(so.lines.map((l) => [l.id, l.description]));
    const stale = d.lines.filter(
      (l) => l.salesOrderLineId !== null && names.get(l.salesOrderLineId) !== l.description,
    );
    const headChanged =
      d.customerRef !== head.customerRef || d.doDate.getTime() !== head.doDate.getTime();
    if (!headChanged && !stale.length) return;
    for (const l of stale)
      await tx.deliveryOrderLine.update({
        where: { id: l.id },
        data: { description: names.get(l.salesOrderLineId!)! },
      });
    await tx.deliveryOrder.update({
      where: { id: d.id },
      data: { ...head, version: { increment: 1 } },
    });
    const desc = (l: DeliveryOrderLine) =>
      l.salesOrderLineId ? (names.get(l.salesOrderLineId) ?? l.description) : l.description;
    await this.audit.changed(
      `${ENTITY}.updated`,
      ENTITY,
      d.id,
      {
        customerRef: d.customerRef,
        doDate: d.doDate.toISOString().slice(0, 10),
        lines: d.lines.map((l) => l.description),
      },
      {
        customerRef: head.customerRef,
        doDate: head.doDate.toISOString().slice(0, 10),
        lines: d.lines.map(desc),
      },
    );
  }

  private async emitOrderEvent(
    tx: Tx,
    salesOrderId: string,
    type: string,
    snapshot: Record<string, unknown>,
  ) {
    const ctx = requestContext.require();
    await tx.domainEvent.create({
      data: {
        tenantId: ctx.tenantId!,
        type,
        entityType: 'sales_order',
        localId: salesOrderId,
        snapshot: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue,
        previousAttributes: {},
        requestId: ctx.requestId ?? null,
        actorId: ctx.actorId ?? null,
      },
    });
  }

  private async history(
    tx: Tx,
    docId: string,
    fromStatus: string,
    toStatus: string,
    event: string,
  ) {
    const ctx = requestContext.require();
    await tx.docStatusHistory.create({
      data: {
        tenantId: ctx.tenantId!,
        docType: ENTITY,
        docId,
        fromStatus,
        toStatus,
        event,
        actorId: ctx.actorId ?? null,
      },
    });
  }

  private async emit(tx: Tx, d: DeliveryOrderRecord, previous: Record<string, unknown>) {
    const ctx = requestContext.require();
    await tx.domainEvent.create({
      data: {
        tenantId: ctx.tenantId!,
        type: EVENT_TYPE,
        entityType: ENTITY,
        localId: d.id,
        snapshot: JSON.parse(JSON.stringify(eventView(d))) as Prisma.InputJsonValue,
        previousAttributes: previous as Prisma.InputJsonValue,
        requestId: ctx.requestId ?? null,
        actorId: ctx.actorId ?? null,
      },
    });
  }
}

// ---------------------------------------------------------------------------------------------

function dec(v: Prisma.Decimal | null): string | null {
  return v === null ? null : v.toFixed(3).replace(/\.?0+$/, '') || '0';
}

const linked = (l: DeliveryOrderLine) => l.salesOrderLineId !== null;

/** ส่วนของน้ำหนัก/ปริมาตรตามปริมาณ (ทศนิยม 3 ตำแหน่ง ปัดครึ่งขึ้น — Decimal ไม่ใช้ float) */
function part(
  total: Prisma.Decimal | null,
  qty: Prisma.Decimal,
  of: Prisma.Decimal,
): string | null {
  if (total === null) return null;
  if (qty.eq(of) || of.isZero()) return dec(total);
  return dec(total.mul(qty).div(of).toDecimalPlaces(3, Prisma.Decimal.ROUND_HALF_UP));
}

function linePlan(l: DeliveryOrderLine): DoLinePlan {
  return {
    salesOrderLineId: l.salesOrderLineId!,
    soLineNo: l.soLineNo,
    description: l.description,
    qty: dec(l.qtyPlanned)!,
    unit: l.unit,
    weightKg: dec(l.weightKg),
    cbm: dec(l.cbm),
  };
}

function lineAllocated(l: DeliveryOrderLine) {
  return {
    salesOrderLineId: l.salesOrderLineId ?? '',
    qty: dec(l.qtyPlanned)!,
    weightKg: dec(l.weightKg),
    cbm: dec(l.cbm),
  };
}

function soLines(so: OrderForDo): SoLineInfo[] {
  return so.lines.map((l) => ({
    id: l.id,
    lineNo: l.lineNo,
    description: l.description,
    qtyOrdered: dec(l.qtyOrdered)!,
    unit: l.unit,
    weightKg: dec(l.weightKg),
    cbm: dec(l.cbm),
  }));
}

/** จุดรับ (ค่าเริ่มต้น = จุดรับแรก) / จุดส่ง (บังคับเลือกเมื่อ SO มีหลายจุดส่ง) ของ DO ใบใหม่ */
function resolveStops(
  so: OrderForDo,
  input: CreateFromOrderInput,
): { origin: number; dest: number } {
  const pick = (seq: number | null | undefined, type: 'PICKUP' | 'DELIVERY') => {
    if (seq === undefined || seq === null) {
      const all = so.stops.filter((s) => s.type === type);
      return type === 'PICKUP' || all.length === 1 ? all[0] : null;
    }
    return so.stops.find((s) => s.sequence === seq);
  };
  const origin = pick(input.originStopSeq, 'PICKUP');
  const dest = pick(input.destStopSeq, 'DELIVERY');
  if (dest === null)
    throw field422(
      'destStopSeq',
      'required',
      'order has several drop stops — choose one (1 delivery order per drop)',
    );
  if (!origin || origin.type !== 'PICKUP')
    throw field422('originStopSeq', 'invalid_stop', 'must be a PICKUP stop of the order');
  if (!dest || dest.type !== 'DELIVERY')
    throw field422('destStopSeq', 'invalid_stop', 'must be a DELIVERY stop of the order');
  return { origin: origin.sequence, dest: dest.sequence };
}

/**
 * SO พร้อมให้ **สร้าง** DO: พ้นร่าง ยังไม่วางแผน ลูกค้า + ทุกจุดจับคู่แล้ว และไม่ได้ค้างเพราะลูกค้า/สถานที่/ข้อมูลต้นทาง
 * (ค้าง RATE_MISSING ยังสร้างได้ — ข้อมูลส่งของครบ)
 */
function isReady(so: {
  status: string;
  customerId: string | null;
  stops: { siteId: string | null; type: string }[];
  holdReasonCode: { code: string } | null;
}): boolean {
  return (
    (SO_DO_STATUSES as readonly string[]).includes(so.status) &&
    so.customerId !== null &&
    so.stops.length > 0 &&
    so.stops.every((s) => s.siteId !== null) &&
    so.stops.some((s) => s.type === 'PICKUP') &&
    so.stops.some((s) => s.type === 'DELIVERY') &&
    !(so.status === 'ON_HOLD' && NOT_READY_HOLDS.has(so.holdReasonCode?.code ?? ''))
  );
}

/**
 * ลายนิ้วมือข้อมูล SO **ที่ใช้จัดสรร** (ลูกค้า จุดรับ-ส่ง สินค้า/ปริมาณ/หน่วย/น้ำหนัก) — เปลี่ยน = DO ชุดเดิมใช้ไม่ได้ (ORD-085)
 * ข้อมูลหัว (PO ลูกค้า วันที่ ช่วงเวลา ชื่อสินค้า) ไม่อยู่ใน hash — แก้ใน DO เดิม (`refreshHeader`)
 * หมายเหตุ: บรรทัดของ DO ที่ยกเลิกเพราะ rebuild ยังอ้างบรรทัด SO เดิม (ค่าในบรรทัด DO เป็น snapshot ณ ตอนนั้น) —
 * ปลดการอ้างเฉพาะเมื่อบรรทัด SO ถูกลบ (`releaseOrderLines`)
 */
function allocationHash(so: OrderForDo): string {
  return createHash('sha256')
    .update(
      stableStringify({
        customerId: so.customerId,
        stops: so.stops.map((s) => [s.sequence, s.type, s.siteId]),
        lines: so.lines.map((l) => [
          l.id,
          l.lineNo,
          dec(l.qtyOrdered),
          l.unit,
          dec(l.weightKg),
          dec(l.cbm),
        ]),
      }),
    )
    .digest('hex');
}

function view(d: DeliveryOrderRecord) {
  return {
    doNo: d.doNo,
    status: d.status,
    destStopSeq: d.destStopSeq,
    weightKg: dec(d.weightKg),
    lines: d.lines.map((l) => ({ soLineNo: l.soLineNo, qty: dec(l.qtyPlanned), unit: l.unit })),
  };
}

/**
 * payload ของ `delivery_order.status_changed` = `data.object` ของ webhook (ไม่มีราคา)
 * ST7-T06: id แบบ prefix (docs/01 §5.1) + `orderId` ตามชื่อใน DeliveryOrderDto (เดิม uuid ดิบ + `salesOrderId`)
 */
function eventView(d: DeliveryOrderRecord) {
  return {
    id: encodeId('deliveryOrder', d.id),
    doNo: d.doNo,
    status: d.status,
    orderId: encodeId('salesOrder', d.salesOrderId),
    customerId: encodeId('customer', d.customerId),
    tripId: d.tripId ? encodeId('trip', d.tripId) : null,
    destStopSeq: d.destStopSeq,
    splitFromId: d.splitFromId ? encodeId('deliveryOrder', d.splitFromId) : null,
    weightKg: dec(d.weightKg),
    cbm: dec(d.cbm),
    lines: d.lines.map((l) => ({
      lineNo: l.lineNo,
      soLineNo: l.soLineNo,
      description: l.description,
      qty: dec(l.qtyPlanned),
      unit: l.unit,
    })),
  };
}
