import { Injectable } from '@nestjs/common';
import { Prisma, type OrderChargeKind, type RevenueLine, type VatType } from '@prisma/client';
import { decimalFromSatang, mulRateHalfUp, satangFromDecimal, scopeAllows } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { ServiceItemsService } from '../service-items/service-items.service';
import type { AddRevenueLineDto, RevenueLineDto, RevenueLineSourceType } from './revenue-line.dto';

const MAX_SATANG = 99_999_999_999_999n; // numeric(14,2)
/** "2.5" → 2500n (ทศนิยม 3 ตำแหน่งเป็นจำนวนเต็ม — ตรวจ > 0 โดยไม่ใช้ float; รูปแบบผ่าน DTO แล้ว) */
const qtyMilli = (q: string): bigint => {
  const [i, f = ''] = q.split('.');
  return BigInt(i!) * 1000n + BigInt((f + '000').slice(0, 3));
};
/** advisory lock namespace ของ rebuild ต่อใบสั่ง (กันเลขบรรทัดชนเมื่อยืนยันค่าใช้จ่ายหน้างานหลายใบพร้อมกัน) */
const LOCK_NS = 51;
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

/** เนื้อหาของบรรทัดระบบ (ใช้เทียบว่าแหล่งเปลี่ยนหรือไม่) */
interface Desired {
  sourceType: 'SO_CHARGE' | 'DO_SURCHARGE';
  sourceId: string;
  deliveryOrderId: string | null;
  kind: OrderChargeKind;
  serviceItemId: string;
  serviceItemVersion: number | null;
  serviceItemSnapshot: Prisma.JsonValue | null;
  description: string;
  qty: string;
  unitPrice: string;
  amount: string;
  vatType: VatType;
  whtRate: string;
}

const CONTENT_KEYS = [
  'deliveryOrderId',
  'kind',
  'serviceItemId',
  'serviceItemVersion',
  'description',
  'qty',
  'unitPrice',
  'amount',
  'vatType',
  'whtRate',
] as const;

function contentOf(l: RevenueLine | Desired): Record<(typeof CONTENT_KEYS)[number], unknown> {
  const dec = (v: unknown, dp: number) =>
    v instanceof Prisma.Decimal ? v.toFixed(dp) : new Prisma.Decimal(String(v)).toFixed(dp);
  return {
    deliveryOrderId: l.deliveryOrderId,
    kind: l.kind,
    serviceItemId: l.serviceItemId,
    serviceItemVersion: l.serviceItemVersion,
    description: l.description,
    qty: dec(l.qty, 4),
    unitPrice: dec(l.unitPrice, 2),
    amount: dec(l.amount, 2),
    vatType: l.vatType,
    whtRate: dec(l.whtRate, 2),
  };
}
const sameContent = (a: RevenueLine, b: Desired) =>
  JSON.stringify(contentOf(a)) === JSON.stringify(contentOf(b));

/**
 * บรรทัดรายได้ (ST5-T01; docs/04 F3 "Revenue line ตั้งแต่สร้าง order" — ราคาจาก rate card snapshot + accessorial snapshot;
 * `sourceType/sourceId` ต่อ line; rebuild เฉพาะบรรทัดระบบเมื่อ order เปลี่ยน เก็บบรรทัดที่คนเพิ่มเอง; ไม่ rebuild หลัง finalize)
 *
 * - แหล่งของบรรทัดระบบ: `sales_order_charge` (SO_CHARGE — ราคาที่คิดไว้ของใบสั่ง ทั้ง RATE_CARD และราคาที่กำหนดเอง) +
 *   `do_surcharge` สถานะ CONFIRMED (DO_SURCHARGE) — คัดลอกตัวเลขและธงภาษีจากแหล่ง ไม่ join service_item/rate_card
 * - ราคาตามใบสั่ง (ปริมาณตามใบสั่ง) — ไม่ใช้ยอดประมาณตามส่งจริง (`sellBilling`) และยังไม่แบ่ง SO_CHARGE ลง DO: [OPEN] spec/12 §3
 * - ล็อก (`locked_at` — ST5-T09 ตั้งตอนออกเลข): บรรทัด SO_CHARGE ใดของใบสั่งถูกล็อก = ไม่ rebuild ราคาของใบสั่งนั้นอีก ·
 *   บรรทัดที่ล็อกไม่ถูกแตะเลย (trigger `tms_revenue_line_guard` กันอีกชั้นที่ฐานข้อมูล)
 * - ไม่คำนวณภาษีที่นี่ (ST5-T02)
 */
@Injectable()
export class RevenueLinesService {
  constructor(
    private readonly db: DbService,
    private readonly serviceItems: ServiceItemsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * สร้าง/ปรับบรรทัดระบบของใบสั่งให้ตรงกับแหล่ง — idempotent (แหล่งไม่เปลี่ยน = ไม่เขียน)
   * เรียกหลังราคาใบสั่งถูกคิดใหม่ (OrderIntakeService.evaluate) และหลังยืนยันค่าใช้จ่ายหน้างาน
   * คืน true เมื่อมีการเปลี่ยนแปลง
   */
  async rebuild(salesOrderId: string, tx: Tx = this.db.tx): Promise<boolean> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NS}::int, hashtext(${salesOrderId}))`;
    const so = await tx.salesOrder.findUnique({
      where: { id: salesOrderId },
      select: { id: true, tenantId: true },
    });
    if (!so) return false;
    const [existing, charges, surcharges] = await Promise.all([
      tx.revenueLine.findMany({ where: { salesOrderId }, orderBy: { lineNo: 'asc' } }),
      tx.salesOrderCharge.findMany({ where: { salesOrderId }, orderBy: { lineNo: 'asc' } }),
      tx.doSurcharge.findMany({
        where: { status: 'CONFIRMED', deliveryOrder: { salesOrderId } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    // หลัง finalize ไม่ rebuild ราคาของใบสั่ง (docs/04 F3)
    const chargesFrozen = existing.some((l) => l.sourceType === 'SO_CHARGE' && l.lockedAt);
    const desired: Desired[] = [];
    if (!chargesFrozen)
      for (const c of charges)
        desired.push({
          sourceType: 'SO_CHARGE',
          sourceId: c.id,
          deliveryOrderId: null,
          kind: c.kind,
          serviceItemId: c.serviceItemId,
          serviceItemVersion: c.serviceItemVersion,
          serviceItemSnapshot: c.serviceItemSnapshot,
          description: c.description,
          qty: c.qty.toFixed(4),
          unitPrice: c.unitPrice.toFixed(2),
          amount: c.amount.toFixed(2),
          vatType: c.vatType,
          whtRate: c.whtRate.toFixed(2),
        });
    for (const s of surcharges)
      desired.push({
        sourceType: 'DO_SURCHARGE',
        sourceId: s.id,
        deliveryOrderId: s.deliveryOrderId,
        kind: 'ACCESSORIAL',
        serviceItemId: s.serviceItemId,
        serviceItemVersion: s.serviceItemVersion,
        serviceItemSnapshot: s.serviceItemSnapshot,
        description: s.description,
        qty: s.qty.toFixed(4),
        unitPrice: s.unitPrice.toFixed(2),
        amount: s.amount.toFixed(2),
        vatType: s.vatType,
        whtRate: s.whtRate.toFixed(2),
      });

    const key = (t: string, id: string | null) => `${t}:${id}`;
    const want = new Map(desired.map((d) => [key(d.sourceType, d.sourceId), d]));
    let changed = false;
    // บรรทัดระบบที่แหล่งหายไป (ราคาคิดใหม่ได้บรรทัดใหม่) — ลบเฉพาะที่ยังไม่ล็อก
    const stale = existing.filter(
      (l) =>
        !l.isUserAdded &&
        !l.lockedAt &&
        !want.has(key(l.sourceType, l.sourceId)) &&
        !(chargesFrozen && l.sourceType === 'SO_CHARGE'),
    );
    if (stale.length) {
      await tx.revenueLine.deleteMany({ where: { id: { in: stale.map((l) => l.id) } } });
      changed = true;
    }
    const staleIds = new Set(stale.map((l) => l.id));
    const kept = existing.filter((l) => !staleIds.has(l.id));
    const have = new Map(
      kept.filter((l) => !l.isUserAdded).map((l) => [key(l.sourceType, l.sourceId), l]),
    );
    let next = kept.reduce((m, l) => Math.max(m, l.lineNo), 0);
    for (const d of desired) {
      const cur = have.get(key(d.sourceType, d.sourceId));
      const data = {
        deliveryOrderId: d.deliveryOrderId,
        kind: d.kind,
        serviceItemId: d.serviceItemId,
        serviceItemVersion: d.serviceItemVersion,
        serviceItemSnapshot: (d.serviceItemSnapshot ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        description: d.description,
        qty: d.qty,
        unitPrice: d.unitPrice,
        amount: d.amount,
        vatType: d.vatType,
        whtRate: d.whtRate,
      };
      if (cur) {
        if (cur.lockedAt || sameContent(cur, d)) continue;
        // แหล่งถูกแก้ในที่ (เช่น ราคาที่กำหนดเองเปลี่ยนจำนวนเงิน) → ปรับบรรทัดเดิม
        await tx.revenueLine.update({
          where: { id: cur.id },
          data: { ...data, version: { increment: 1 } },
        });
        changed = true;
        continue;
      }
      await tx.revenueLine.create({
        data: {
          ...data,
          tenantId: so.tenantId,
          salesOrderId,
          lineNo: ++next,
          sourceType: d.sourceType,
          sourceId: d.sourceId,
          isUserAdded: false,
        },
      });
      changed = true;
    }
    return changed;
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

  // ---------- user-added lines ----------

  /**
   * เพิ่มบรรทัดเอง (MANUAL — `is_user_added`, คงไว้เมื่อ rebuild) · ธงภาษีคัดลอกจากรายการบริการ (ฝั่งขาย) ไม่รับจาก client
   * ยอด = จำนวน × ราคาต่อหน่วย ปัดครึ่งขึ้นเป็นสตางค์ครั้งเดียว (MD-114 — กติกาเดียวกับ pricing engine / ค่าใช้จ่ายหน้างาน)
   * สิทธิ์ `orders:write` (controller) + `prices.sell:write` · เหตุผล ≥ 10 → audit `sales_order.revenue_line_added`
   * ใบสั่งปิด/ยกเลิก หรือมีบรรทัดที่ล็อกแล้ว (ออกใบแจ้งหนี้แล้ว — ส่วนเพิ่มใช้ใบเพิ่มหนี้ ST5-T13) → 409
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
    if (await tx.revenueLine.findFirst({ where: { salesOrderId, lockedAt: { not: null } } }))
      throw locked();

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
        amount: created.amount.toFixed(2),
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
    voidedAt: r.voidedAt?.toISOString() ?? null,
    voidReason: r.voidReason,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    version: r.version,
  };
}
