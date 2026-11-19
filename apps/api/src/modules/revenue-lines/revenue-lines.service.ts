import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { OrderChargeKind, Prisma, RevenueLine, VatType } from '@prisma/client';
import { decimalFromSatang, mulRateHalfUp, satangFromDecimal, scopeAllows } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { JobQueue } from '../../jobs/job-queue.service';
import { ServiceItemsService } from '../service-items/service-items.service';
import { allocatedCostForDeliveryOrder } from '../trips/trip-costs';
import type {
  AddRevenueLineDto,
  DeliveryOrderRevenueDto,
  RevenueLineDto,
  RevenueLineSourceType,
} from './revenue-line.dto';
import {
  REVENUE_LOCK_NS as LOCK_NS,
  rebuildRevenueLines,
  revenueTotalsByDeliveryOrder,
} from './revenue-rebuild';

const MAX_SATANG = 99_999_999_999_999n; // numeric(14,2)
/** "2.5" → 2500n (ทศนิยม 3 ตำแหน่งเป็นจำนวนเต็ม — ตรวจ > 0 โดยไม่ใช้ float; รูปแบบผ่าน DTO แล้ว) */
const qtyMilli = (q: string): bigint => {
  const [i, f = ''] = q.split('.');
  return BigInt(i!) * 1000n + BigInt((f + '000').slice(0, 3));
};
/** งานเบื้องหลังคิดบรรทัดรายได้ใหม่เมื่อลูกค้าเปลี่ยนเกณฑ์วางบิล (ST5-T01b review M2) */
export const REBUILD_CUSTOMER_JOB = 'revenue_lines.rebuild_customer';
/** audit อยู่ใต้ใบสั่ง (entity ที่กันไม่ให้ retention ลบ — retention-policy.ts) */
const ENTITY = 'sales_order';
/** ใบสั่งที่ปิด/ยกเลิกแล้ว — เพิ่มบรรทัดเองไม่ได้ */
const CLOSED_SO = new Set(['CLOSED', 'CANCELLED']);
/** ลำดับแสดงผล: ราคาตามใบสั่ง → ค่าใช้จ่ายหน้างาน → ที่คนเพิ่ม */
const RANK: Record<string, number> = { SO_CHARGE: 0, DO_SURCHARGE: 1, MANUAL: 2 };

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);
const denied = (required: string[]) =>
  new ProblemException('permission_denied', undefined, undefined, {
    module: 'revenue-lines',
    action: 'write',
    required,
  });
const locked = (extra: Record<string, unknown> = {}) =>
  new ProblemException('invalid_state_transition', undefined, undefined, {
    reason: 'revenue_line_locked',
    ...extra,
  });

/**
 * บรรทัดรายได้ (ST5-T01; docs/04 F3 "Revenue line ตั้งแต่สร้าง order" — ราคาจาก rate card snapshot + accessorial snapshot;
 * `sourceType/sourceId` ต่อ line; rebuild เฉพาะบรรทัดระบบเมื่อ order เปลี่ยน เก็บบรรทัดที่คนเพิ่มเอง; ไม่ rebuild หลัง finalize)
 *
 * - แหล่งของบรรทัดระบบ: `sales_order_charge` (SO_CHARGE — ราคาที่คิดไว้ของใบสั่ง ทั้ง RATE_CARD และราคาที่กำหนดเอง) +
 *   `do_surcharge` สถานะ CONFIRMED (DO_SURCHARGE) — คัดลอกตัวเลขและธงภาษีจากแหล่ง ไม่ join service_item/rate_card
 * - **ต่อ DO (ST5-T01b — PO ตัดสิน 19 พ.ย. 2569):** SO_CHARGE แบ่งลง DO = snapshot × ปริมาณของ DO (ยอดส่งจริงเมื่อลูกค้าวางบิล
 *   ตามยอดส่งจริง — ก่อนบันทึก = แผน `provisional`) · ยังไม่มี DO = ระดับใบสั่ง (`provisional`) — กติกาเต็มที่ `rebuildRevenueLines`
 * - ล็อก (`locked_at` — ST5-T09 ตั้งตอนออกเลข): DO ที่มีบรรทัด SO_CHARGE ล็อก = ไม่ rebuild ราคาของ DO นั้นอีก ·
 *   บรรทัดที่ล็อกไม่ถูกแตะเลย (trigger `tms_revenue_line_guard` กันอีกชั้นที่ฐานข้อมูล)
 * - ไม่คำนวณภาษีที่นี่ (ST5-T02)
 */
@Injectable()
export class RevenueLinesService implements OnModuleInit {
  private readonly log = new Logger(RevenueLinesService.name);
  constructor(
    private readonly db: DbService,
    private readonly serviceItems: ServiceItemsService,
    private readonly audit: AuditService,
    private readonly queue: JobQueue,
  ) {}

  /**
   * งานเบื้องหลัง (review M2): ลูกค้าเปลี่ยนเกณฑ์วางบิล → คิดบรรทัดรายได้ของใบสั่งที่ยังเปิดใหม่ **ทีละใบสั่ง transaction สั้น**
   * (ไม่ทำทั้งหมดใน request เดียว) · ใบที่ล้ม → งานล้มให้ลองใหม่ (ใบที่ทำแล้ว idempotent — ไม่เปลี่ยนซ้ำ)
   */
  onModuleInit() {
    this.queue.register(
      REBUILD_CUSTOMER_JOB,
      async ({ job, withTx }) => {
        const customerId = (job.payload as { customerId?: unknown } | null)?.customerId;
        if (typeof customerId !== 'string') return { skipped: 'bad_payload' };
        const orders = await withTx((tx) =>
          tx.salesOrder.findMany({
            where: { customerId, status: { notIn: ['CLOSED', 'CANCELLED'] } },
            select: { id: true },
            orderBy: { id: 'asc' },
          }),
        );
        let changed = 0;
        const failed: string[] = [];
        for (const o of orders) {
          try {
            if (await withTx((tx) => rebuildRevenueLines(tx, o.id, 'system:billing-basis')))
              changed += 1;
          } catch (e) {
            this.log.warn(`order ${o.id}: rebuild failed — ${(e as Error).message}`);
            failed.push(o.id);
          }
        }
        if (failed.length)
          throw new Error(`revenue rebuild failed for ${failed.length} order(s) — retrying`);
        return { orders: orders.length, changed };
      },
      { outsideTransaction: true },
    );
  }

  /** คิดบรรทัดรายได้ของใบสั่งที่ยังเปิดของลูกค้าใหม่ในงานเบื้องหลัง (enqueue ใน transaction ของคำขอ) */
  async scheduleRebuildForCustomer(customerId: string, tx: Tx = this.db.tx) {
    const tenantId = requestContext.require().tenantId;
    if (!tenantId) throw new Error('revenue lines: tenant missing in request context');
    return this.queue.enqueue(tx, {
      tenantId,
      type: REBUILD_CUSTOMER_JOB,
      payload: { customerId },
      maxAttempts: 5,
    });
  }

  /**
   * สร้าง/ปรับบรรทัดระบบของใบสั่งให้ตรงกับแหล่ง (ต่อ DO — ST5-T01b; กติกาเต็มที่ `rebuildRevenueLines`) — idempotent
   * เรียกหลังราคาใบสั่งถูกคิดใหม่/DO ชุดใหม่ (OrderIntakeService.evaluate), ยืนยันค่าใช้จ่ายหน้างาน, และทุกงานของ DeliveryOrderService
   * ที่เปลี่ยนชุด DO/ปริมาณ (สร้าง แยก รวม ยกเลิก ส่งใหม่ คืนคลัง บันทึกยอดส่งจริง ส่งถึง) · คืน true เมื่อมีการเปลี่ยนแปลง
   */
  async rebuild(salesOrderId: string, tx: Tx = this.db.tx): Promise<boolean> {
    return rebuildRevenueLines(tx, salesOrderId, requestContext.get()?.actorId ?? 'system', (m) =>
      this.log.warn(`order ${salesOrderId}: ${m}`),
    );
  }

  /** rebuild ของใบสั่งที่ DO นี้อยู่ (ยืนยันค่าใช้จ่ายหน้างาน) */
  async rebuildForDeliveryOrder(deliveryOrderId: string, tx: Tx = this.db.tx): Promise<boolean> {
    const d = await tx.deliveryOrder.findUnique({
      where: { id: deliveryOrderId },
      select: { salesOrderId: true },
    });
    return d ? this.rebuild(d.salesOrderId, tx) : false;
  }

  // ---------- read ----------

  async list(salesOrderId: string): Promise<RevenueLineDto[]> {
    // RLS กรองใบของบริษัทอื่น → ไม่พบ (404) แทนรายการว่าง
    if (
      !(await this.db.tx.salesOrder.findUnique({
        where: { id: salesOrderId },
        select: { id: true },
      }))
    )
      throw new ProblemException('not_found');
    const rows = await this.db.tx.revenueLine.findMany({
      where: { salesOrderId },
      include: {
        deliveryOrder: { select: { doNo: true } },
        serviceItem: { select: { code: true } },
      },
    });
    rows.sort(
      (a, b) =>
        (RANK[a.sourceType] ?? 9) - (RANK[b.sourceType] ?? 9) ||
        a.lineNo - b.lineNo ||
        a.id.localeCompare(b.id),
    );
    return rows.map((r) => toDto(r));
  }

  /**
   * บรรทัดรายได้ของ DO + ยอดรวม (ST5-T01b — docs/01 §3.3 `revenue_amount` ต่อ DO; งานปันต้นทุนตามสัดส่วนรายได้อ่านยอดนี้)
   * DO ไม่พบ/บริษัทอื่น → 404 · ยอดรวม = บรรทัดที่ยังใช้ (ACTIVE) ทั้งหมดที่ผูก DO
   */
  async listForDeliveryOrder(deliveryOrderId: string): Promise<DeliveryOrderRevenueDto> {
    const tx = this.db.tx;
    const d = await tx.deliveryOrder.findUnique({
      where: { id: deliveryOrderId },
      select: { id: true, doNo: true },
    });
    if (!d) throw new ProblemException('not_found');
    const rows = await tx.revenueLine.findMany({
      where: { deliveryOrderId },
      include: {
        deliveryOrder: { select: { doNo: true } },
        serviceItem: { select: { code: true } },
      },
    });
    rows.sort(
      (a, b) =>
        (RANK[a.sourceType] ?? 9) - (RANK[b.sourceType] ?? 9) ||
        a.lineNo - b.lineNo ||
        a.id.localeCompare(b.id),
    );
    const total = (await revenueTotalsByDeliveryOrder(tx, [deliveryOrderId])).get(deliveryOrderId);
    return {
      deliveryOrderId: encodeId('deliveryOrder', d.id),
      doNo: d.doNo,
      sellRevenueTotal: total?.amount ?? '0.00',
      provisional: total?.provisional ?? false,
      buyAllocatedCost: await allocatedCostForDeliveryOrder(tx, d.id),
      data: rows.map((r) => toDto(r)),
    };
  }

  /** ยอดรายได้ต่อ DO (ACTIVE) — สำหรับโมดูลอื่น (ปันต้นทุนตามสัดส่วนรายได้) · id เป็น uuid */
  totalsByDeliveryOrder(ids: readonly string[], tx: Tx = this.db.tx) {
    return revenueTotalsByDeliveryOrder(tx, ids);
  }

  // ---------- user-added lines ----------

  /**
   * เพิ่มบรรทัดเอง (MANUAL — `is_user_added`, คงไว้เมื่อ rebuild) · ธงภาษีคัดลอกจากรายการบริการ (ฝั่งขาย) ไม่รับจาก client
   * ยอด = จำนวน × ราคาต่อหน่วย ปัดครึ่งขึ้นเป็นสตางค์ครั้งเดียว (MD-114 — กติกาเดียวกับ pricing engine / ค่าใช้จ่ายหน้างาน)
   * สิทธิ์ `orders:write` (controller) + `prices.sell:write` · เหตุผล ≥ 10 → audit `sales_order.revenue_line_added`
   * ใบสั่งปิด/ยกเลิก หรือ DO ที่ระบุ (ไม่ระบุ = ระดับใบสั่ง) มีบรรทัดที่ล็อกแล้ว (ออกใบแล้ว — ส่วนเพิ่มใช้ใบเพิ่มหนี้ ST5-T13) → 409
   */
  async add(salesOrderId: string, input: AddRevenueLineDto): Promise<RevenueLineDto> {
    const tx = this.db.tx;
    const ctx = requestContext.require();
    if (!scopeAllows(ctx.scopes ?? [], 'prices.sell:write')) throw denied(['prices.sell:write']);
    const [row] = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT id::text AS id, status::text AS status FROM sales_order WHERE id = ${salesOrderId}::uuid FOR UPDATE`;
    if (!row) throw new ProblemException('not_found');
    if (CLOSED_SO.has(row.status))
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        orderStatus: row.status,
      });
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NS}::int, hashtext(${salesOrderId}))`;

    const errors: { field: string; code: string; message: string }[] = [];
    const qty = input.qty ?? '1';
    if (qtyMilli(qty) <= 0n)
      errors.push({ field: 'qty', code: 'out_of_range', message: 'qty must be > 0' });
    const unit = satangFromDecimal(input.sellUnitPrice);
    if (unit <= 0n)
      errors.push({
        field: 'sellUnitPrice',
        code: 'out_of_range',
        message: 'sellUnitPrice must be > 0',
      });
    const amount = mulRateHalfUp(unit, qty);
    // ยอดปัดแล้วเป็น 0 (เช่น 0.001 × 0.01) → ไม่รับ (บรรทัดที่คนเพิ่มต้องมียอด)
    if (unit > 0n && qtyMilli(qty) > 0n && amount <= 0n)
      errors.push({ field: 'qty', code: 'amount_zero', message: 'line amount rounds to 0.00' });
    if (amount > MAX_SATANG)
      errors.push({ field: 'sellUnitPrice', code: 'too_large', message: 'amount is too large' });
    if (errors.length) throw new ProblemException('validation_failed', undefined, errors);

    let doId: string | null = null;
    if (input.deliveryOrderId) {
      const id = tryDecodeId('deliveryOrder', input.deliveryOrderId);
      const d = id
        ? await tx.deliveryOrder.findFirst({
            where: { id, salesOrderId },
            select: { id: true, status: true },
          })
        : null;
      if (!d)
        throw field422(
          'deliveryOrderId',
          'invalid_reference',
          'delivery order is not in this order',
        );
      if (d.status === 'CANCELLED' || d.status === 'BILLED')
        throw new ProblemException(
          'invalid_state_transition',
          undefined,
          [
            {
              field: 'deliveryOrderId',
              code: 'do_closed',
              message: `delivery order is ${d.status}`,
            },
          ],
          { doStatus: d.status },
        );
      doId = d.id;
    }
    // ST5-T01b (review M3): ออกใบต่อ DO → กันเฉพาะ DO ที่มีบรรทัดออกใบแล้ว · บรรทัดระดับใบสั่ง = กันเมื่อมีบรรทัดระดับใบสั่งที่ล็อก
    if (
      await tx.revenueLine.findFirst({
        where: { salesOrderId, deliveryOrderId: doId, lockedAt: { not: null } },
        select: { id: true },
      })
    )
      throw locked(doId ? { deliveryOrderId: encodeId('deliveryOrder', doId) } : {});

    const itemId = tryDecodeId('serviceItem', input.serviceItemId);
    if (!itemId)
      throw field422('serviceItemId', 'service_item_not_found', 'service item not found');
    const snap = await this.serviceItems.snapshotFor(itemId, 'SELL');
    const item = await tx.serviceItem.findUniqueOrThrow({
      where: { id: itemId },
      select: { systemKey: true },
    });
    const kind: OrderChargeKind =
      item.systemKey === 'FREIGHT'
        ? 'FREIGHT'
        : item.systemKey === 'EXTRA_STOP'
          ? 'EXTRA_STOP'
          : 'ACCESSORIAL';

    const max = await tx.revenueLine.aggregate({ where: { salesOrderId }, _max: { lineNo: true } });
    const created = await tx.revenueLine.create({
      data: {
        tenantId: ctx.tenantId!,
        salesOrderId,
        deliveryOrderId: doId,
        lineNo: (max._max.lineNo ?? 0) + 1,
        sourceType: 'MANUAL',
        sourceId: null,
        isUserAdded: true,
        kind,
        serviceItemId: snap.sourceItemId,
        serviceItemVersion: snap.sourceVersion,
        serviceItemSnapshot: JSON.parse(JSON.stringify(snap)) as Prisma.InputJsonValue,
        description: input.description?.trim() || snap.name,
        qty,
        unitPrice: decimalFromSatang(unit),
        amount: decimalFromSatang(amount),
        vatType: snap.vatType as VatType,
        whtRate: snap.whtRate,
        createdBy: ctx.actorId ?? null,
      },
    });
    await this.audit.record({
      action: `${ENTITY}.revenue_line_added`,
      entityType: ENTITY,
      entityId: salesOrderId,
      after: {
        revenueLineId: encodeId('revenueLine', created.id),
        lineNo: created.lineNo,
        serviceItemCode: snap.code,
        description: created.description,
        deliveryOrderId: doId ? encodeId('deliveryOrder', doId) : null,
        qty: created.qty.toFixed(4),
        // ชื่อ field ราคาที่ลงทะเบียน (@PriceField) — คนที่ไม่มี prices.sell:read อ่าน audit แล้วถูกตัดออก
        sellUnitPrice: created.unitPrice.toFixed(2),
        sellAmount: created.amount.toFixed(2),
      },
      reason: input.reason,
    });
    return this.one(created.id);
  }

  /**
   * ยกเลิกบรรทัดที่คนเพิ่ม (VOIDED — ไม่ลบ) · บรรทัดระบบยกเลิกไม่ได้ (ตามแหล่ง — แก้ที่ใบสั่ง/ค่าใช้จ่ายหน้างาน) → 409
   * ล็อกแล้ว → 409 · If-Match = version · เหตุผล ≥ 10 → audit `sales_order.revenue_line_voided`
   */
  async void(id: string, reason: string, expected: number | undefined): Promise<RevenueLineDto> {
    const tx = this.db.tx;
    const ctx = requestContext.require();
    if (!scopeAllows(ctx.scopes ?? [], 'prices.sell:write')) throw denied(['prices.sell:write']);
    const [r] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM revenue_line WHERE id = ${id}::uuid FOR UPDATE`;
    if (!r) throw new ProblemException('not_found');
    const line = await tx.revenueLine.findUniqueOrThrow({ where: { id } });
    if (expected !== undefined && expected !== line.version)
      throw new ProblemException('precondition_failed');
    const so = await tx.salesOrder.findUniqueOrThrow({
      where: { id: line.salesOrderId },
      select: { status: true },
    });
    if (CLOSED_SO.has(so.status))
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        orderStatus: so.status,
      });
    if (line.lockedAt) throw locked();
    if (!line.isUserAdded)
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        reason: 'system_line',
        sourceType: line.sourceType,
      });
    if (line.status !== 'ACTIVE')
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        status: line.status,
      });
    await tx.revenueLine.update({
      where: { id },
      data: {
        status: 'VOIDED',
        voidedAt: new Date(),
        voidedBy: ctx.actorId ?? 'unknown',
        voidReason: reason,
        version: { increment: 1 },
      },
    });
    await this.audit.record({
      action: `${ENTITY}.revenue_line_voided`,
      entityType: ENTITY,
      entityId: line.salesOrderId,
      before: { revenueLineId: encodeId('revenueLine', id), status: 'ACTIVE' },
      after: { revenueLineId: encodeId('revenueLine', id), status: 'VOIDED' },
      reason,
    });
    return this.one(id);
  }

  /** ใบสั่งของบรรทัด (controller ใช้ตรวจล็อกการแก้ใบสั่ง) — ไม่พบ/บริษัทอื่น → 404 */
  async salesOrderOf(id: string): Promise<string> {
    const l = await this.db.tx.revenueLine.findUnique({
      where: { id },
      select: { salesOrderId: true },
    });
    if (!l) throw new ProblemException('not_found');
    return l.salesOrderId;
  }

  /**
   * ใบสั่งถูกยกเลิก (OrderStateService.cancel) → บรรทัดที่ยังใช้และยังไม่ล็อกทั้งหมดเป็น VOIDED (ไม่ลบ) พร้อมเหตุผลของการยกเลิก
   * บรรทัดที่ล็อก (ออกใบแล้ว) ไม่แตะ — ต้องจัดการด้วยใบลดหนี้ (ST5-T12) · คืนจำนวนบรรทัด
   */
  async voidForCancelledOrder(salesOrderId: string, reason: string, tx: Tx = this.db.tx) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NS}::int, hashtext(${salesOrderId}))`;
    const r = await tx.revenueLine.updateMany({
      where: { salesOrderId, status: 'ACTIVE', lockedAt: null },
      data: {
        status: 'VOIDED',
        voidedAt: new Date(),
        voidedBy: requestContext.get()?.actorId ?? 'system',
        voidReason: `ยกเลิกใบสั่ง: ${reason}`,
        version: { increment: 1 },
      },
    });
    return r.count;
  }

  /**
   * ปลดล็อกบรรทัดของเอกสารที่ถูกยกเลิก (ทางเดียว — ST5-T10 เรียก) ผ่านฟังก์ชันฐานข้อมูล `tms_revenue_line_unlock`
   * (SECURITY DEFINER + ธงใน transaction — role แอปปลดตรงด้วย UPDATE ไม่ได้) · ลง audit ในฟังก์ชัน · คืนจำนวนบรรทัด
   */
  async unlockForDocument(documentId: string, reason: string, tx: Tx = this.db.tx) {
    const actor = requestContext.get()?.actorId ?? 'system';
    const [r] = await tx.$queryRaw<{ n: number }[]>`
      SELECT tms_revenue_line_unlock(${documentId}::uuid, ${actor}, ${reason}) AS n`;
    return Number(r?.n ?? 0);
  }

  private async one(id: string): Promise<RevenueLineDto> {
    const r = await this.db.tx.revenueLine.findUniqueOrThrow({
      where: { id },
      include: {
        deliveryOrder: { select: { doNo: true } },
        serviceItem: { select: { code: true } },
      },
    });
    return toDto(r);
  }
}

type Row = RevenueLine & {
  deliveryOrder: { doNo: string | null } | null;
  serviceItem: { code: string };
};

function sourceIdOf(r: RevenueLine): string | null {
  if (!r.sourceId) return null;
  if (r.sourceType === 'DO_SURCHARGE') return encodeId('doSurcharge', r.sourceId);
  if (r.sourceType === 'SO_CHARGE') return encodeId('orderCharge', r.sourceId);
  return null;
}

function toDto(r: Row): RevenueLineDto {
  const snapCode = (r.serviceItemSnapshot as { code?: string } | null)?.code;
  return {
    id: encodeId('revenueLine', r.id),
    lineNo: r.lineNo,
    sourceType: r.sourceType as RevenueLineSourceType,
    sourceId: sourceIdOf(r),
    isUserAdded: r.isUserAdded,
    kind: r.kind,
    deliveryOrderId: r.deliveryOrderId ? encodeId('deliveryOrder', r.deliveryOrderId) : null,
    doNo: r.deliveryOrder?.doNo ?? null,
    serviceItemId: encodeId('serviceItem', r.serviceItemId),
    serviceItemCode: snapCode ?? r.serviceItem.code,
    description: r.description,
    qty: r.qty.toFixed(4).replace(/\.?0+$/, ''),
    sellUnitPrice: r.unitPrice.toFixed(2),
    sellAmount: r.amount.toFixed(2),
    vatType: r.vatType,
    whtRate: r.whtRate.toFixed(2),
    status: r.status as 'ACTIVE' | 'VOIDED',
    locked: r.lockedAt !== null,
    lockedAt: r.lockedAt?.toISOString() ?? null,
    provisional: r.provisional,
    voidedAt: r.voidedAt?.toISOString() ?? null,
    voidReason: r.voidReason,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    version: r.version,
  };
}
