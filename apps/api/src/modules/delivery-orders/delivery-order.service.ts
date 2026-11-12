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
  status: { not: 'CANCELLED' },
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
    d.tripId !== null &&
    d.trip !== null &&
    d.trip.status !== 'CANCELLED'
  );
}
/** SO ที่สร้าง/คง DO ได้: พ้นร่างและยังไม่วางแผน (หลังวางแผน DO เป็นของเที่ยว — ST3-T10/T11) */
const SO_DO_STATUSES = ['RECEIVED', 'ON_HOLD'] as const;
/** ใบค้างที่ห้าม **สร้าง** DO ใหม่ (ลูกค้า/สถานที่ใช้ไม่ได้, ข้อมูลต้นทางไม่ครบ) — DO ที่มีอยู่แล้วคงไว้ */
const NOT_READY_HOLDS = new Set(['CUSTOMER_UNMAPPED', 'LOCATION_UNMAPPED', 'SOURCE_ERROR']);
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
  async allocation(salesOrderId: string, tx: Tx = this.db.tx): Promise<LineAllocation[]> {
    const lines = await tx.salesOrderLine.findMany({
      where: { salesOrderId },
      orderBy: { lineNo: 'asc' },
    });
    const sums = await tx.deliveryOrderLine.groupBy({
      by: ['salesOrderLineId'],
      where: {
        salesOrderLineId: { in: lines.map((l) => l.id) },
        deliveryOrder: { status: { not: 'CANCELLED' } },
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
      const allocated = active.flatMap((d) => d.lines.filter(linked).map(lineAllocated));
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
    },
  ): Promise<DeliveryOrderRecord> {
    const tenantId = this.tenantId();
    const origin = so.stops.find((s) => s.sequence === o.originStopSeq)!;
    const dest = so.stops.find((s) => s.sequence === o.destStopSeq)!;
    const row = await tx.deliveryOrder.create({
      data: {
        tenantId,
        doNo: o.doNo,
        doDate: so.requestedDate,
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
    await this.history(tx, row.id, CREATE_FROM, 'DRAFT', o.split ? 'split_create' : 'create');
    await this.emit(tx, row, { status: null });
    return row;
  }

  /**
   * DRAFT → CANCELLED ด้วย event cancel/split/merge (กันชน where status = DRAFT)
   * source_hash ถูกล้าง **ยกเว้นคนยกเลิก** (`keepHash`) — ใบที่ถูกแยก/รวม/ระบบยกเลิก ไม่กันการสร้าง DO อัตโนมัติจากข้อมูลชุดนั้น
   */
  private async cancelOne(
    tx: Tx,
    d: DeliveryOrderRecord,
    event: Extract<DoEvent, 'cancel' | 'split' | 'merge'>,
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
    const head = { customerRef: so.customerRef, doDate: so.requestedDate };
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

/** payload ของ `delivery_order.status_changed` (ไม่มีราคา) */
function eventView(d: DeliveryOrderRecord) {
  return {
    id: d.id,
    doNo: d.doNo,
    status: d.status,
    salesOrderId: d.salesOrderId,
    customerId: d.customerId,
    tripId: d.tripId,
    destStopSeq: d.destStopSeq,
    splitFromId: d.splitFromId,
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
