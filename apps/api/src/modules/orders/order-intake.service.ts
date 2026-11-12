import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  SalesOrder,
  SalesOrderCharge,
  SalesOrderLine,
  SalesOrderStop,
  SoStatus as DbSoStatus,
} from '@prisma/client';
import {
  SO_TRANSITIONS,
  evaluateIntakeHolds,
  isIntakeEditable,
  planIntake,
  transition,
  type IntakeHold,
  type SoEvent,
  type SoStatus,
} from '@tms/domain';
import { AuditService, diff } from '../../audit/audit.service';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { StateService } from '../../state/state.service';
import { lockKey, lockReferenced, stableStringify } from '../master/master-kit';
import { PricingService, type Quote } from '../pricing/pricing.service';
import { resolveDocumentEntity } from '../routing/document-routing';
import { issueNumber } from '../sequences/sequences.service';
import { normalizeOrderInput, type NormalizedOrder, type UpsertOrderInput } from './order-input';
import { orderEventView } from './order-view';

export type { UpsertOrderInput } from './order-input';

export type OrderRecord = SalesOrder & {
  stops: SalesOrderStop[];
  lines: SalesOrderLine[];
  charges: SalesOrderCharge[];
  holdReasonCode: { id: string; code: string } | null;
};

export interface UpsertOrderResult {
  order: OrderRecord;
  /** สร้างใบใหม่ (false = อัปเดตใบเดิมที่ key เดียวกัน) */
  created: boolean;
  /** มีอะไรเปลี่ยน (false = ส่งซ้ำค่าเดิม — idempotent ไม่เพิ่ม version/ไม่ลง audit) */
  changed: boolean;
  /** เหตุค้างทั้งหมดของทางเข้า (ตัวแรก = reason code บน SO) */
  holds: IntakeHold[];
}

const ENTITY = 'sales_order';
const INCLUDE = {
  stops: { orderBy: { sequence: 'asc' } },
  lines: { orderBy: { lineNo: 'asc' } },
  charges: { orderBy: { lineNo: 'asc' } },
  holdReasonCode: { select: { id: true, code: true } },
} as const satisfies Prisma.SalesOrderInclude;

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

/** event สาธารณะของแต่ละ transition (docs/01 §5.3) */
const EVENT_TYPE: Partial<Record<SoEvent, string>> = {
  hold: 'order.held',
  release: 'order.released',
  submit: 'order.updated',
  cancel: 'order.cancelled',
};

/**
 * **ทางเดียว** ที่เขียน order เข้าระบบ (ST3-T01; docs/04 C "order ทุกใบเข้าทางเดียวกันผ่าน domain service เดียว")
 * ผู้เรียก: ฟอร์มกรอกมือ (ST3-T02), Open API `POST /orders` + `PUT /orders/external/{id}` (T03), Excel (T04),
 * connector `pullOrders` (T05) — ห้ามเขียนตาราง sales_order* ที่อื่น (test `order-intake` ตรวจ call path)
 *
 * - idempotent ด้วย (tenant, source, connector, externalId): ส่งซ้ำ = อัปเดตใบเดิม; ค่าเดิมทุกช่อง = ไม่เปลี่ยนอะไร
 *   คำขอพร้อมกันของ key เดียวกันรอกันด้วย advisory lock (+ unique index เป็นด่านสุดท้าย)
 * - ตรวจรูปแบบด้วยกฎชุดเดียว (`normalizeOrderInput`) — รูปแบบผิด/อ้างอิง id ที่ไม่มี → 422
 * - ข้อมูลไม่ครบ/จับคู่ไม่ได้ **ไม่ปฏิเสธ**: order เข้าระบบเสมอแล้วเป็น ON_HOLD + reason code (`evaluateIntakeHolds`)
 * - คิดราคาด้วย `PricingService.quote` (ขาขาย) → `pricing_status` + บรรทัดราคา snapshot (`sales_order_charge`, MD-117:
 *   พารามิเตอร์ใน `pricing_detail.params`, ธงภาษี vat_type/wht_rate(%) ต่อบรรทัดจากรายการบริการ) — ไม่คิด VAT/WHT ที่นี่
 * - เลข SO จาก document_series `SO` ตอนพ้นร่าง (ร่างไม่กินเลข) · transition ผ่าน StateService (doc_status_history +
 *   domain_event) · audit ใน transaction เดียวกัน
 * - `tx` = transaction ที่ตั้ง tenant แล้ว (ค่าเริ่มต้น = ของ request) — นอก HTTP (worker) ต้องมี requestContext ด้วย
 */
@Injectable()
export class OrderIntakeService {
  constructor(
    private readonly db: DbService,
    private readonly pricing: PricingService,
    private readonly state: StateService,
    private readonly audit: AuditService,
  ) {}

  async upsertOrder(input: UpsertOrderInput, tx: Tx = this.db.tx): Promise<UpsertOrderResult> {
    const ctx = requestContext.require();
    const tenantId = ctx.tenantId;
    if (!tenantId) throw new Error('upsertOrder: tenant missing in request context');
    const n = normalizeOrderInput(input);
    const inputHash = createHash('sha256').update(stableStringify(n)).digest('hex');

    let current: OrderRecord | null = null;
    if (n.externalId !== null) {
      await lockKey(tx, `${ENTITY}.ext:${n.source}:${n.connector}:${n.externalId}`);
      current = await tx.salesOrder.findUnique({
        where: {
          tenantId_source_sourceConnector_externalId: {
            tenantId,
            source: n.source,
            sourceConnector: n.connector,
            externalId: n.externalId,
          },
        },
        include: INCLUDE,
      });
      if (current) {
        if (current.inputHash === inputHash)
          return {
            order: current,
            created: false,
            changed: false,
            holds: (current.pricingDetail as { holds?: IntakeHold[] } | null)?.holds ?? [],
          };
        if (!isIntakeEditable(current.status as SoStatus))
          throw new ProblemException('order_locked_for_update', undefined, undefined, {
            status: current.status,
          });
        await tx.$queryRaw`SELECT id FROM sales_order WHERE id = ${current.id}::uuid FOR UPDATE`;
      }
    }

    // อ้างอิง: ล็อกแถว master ที่จะอ้าง (FOR SHARE) กันถูกลบระหว่างสร้าง — ลำดับตายตัวลด deadlock
    const refs = await this.resolveReferences(tx, n);
    const routing = await resolveDocumentEntity(tx, tenantId, {
      kind: 'invoice',
      companyId: n.billingCompanyId,
      partyCompanyId: refs.customer?.defaultBillingCompanyId ?? null,
    });
    const quote = await this.quote(tx, n, refs.customer?.id ?? null);
    const holds = evaluateIntakeHolds({
      sourceIssues: n.sourceIssues,
      customerMapped: !!refs.customer,
      stops: n.stops.map((s) => ({ type: s.type, mapped: s.siteId !== null })),
      pricingStatus: quote.pricingStatus,
    });
    const plan = planIntake({
      current: (current?.status as SoStatus | undefined) ?? null,
      currentHoldCode: current?.holdReasonCode?.code ?? null,
      draft: n.draft,
      holds,
    });
    const pricingDetail = {
      params: quote.params,
      reasons: quote.reasons,
      warnings: quote.warnings,
      routeId: quote.routeId,
      holds,
    };
    const header = {
      customerId: refs.customer?.id ?? null,
      customerExternalId: n.customer.externalId,
      customerText: n.customer.text,
      billingCompanyId: routing.company.id,
      customerRef: n.customerRef,
      requestedDate: new Date(`${n.requestedDate}T00:00:00Z`),
      vehicleTypeId: n.vehicleTypeId,
      pricingStatus: quote.pricingStatus,
      pricingDetail: JSON.parse(JSON.stringify(pricingDetail)) as Prisma.InputJsonValue,
      priceTotal: quote.total,
      pricedAt: new Date(),
      inputHash,
      rawPayload:
        n.rawPayload === null
          ? Prisma.DbNull
          : (JSON.parse(JSON.stringify(n.rawPayload)) as Prisma.InputJsonValue),
    };
    const holdId = plan.holdCode ? await this.holdReasonId(tx, plan.holdCode) : null;

    let id: string;
    let created = false;
    const before = current ? orderEventView(current) : null;
    if (!current) {
      created = true;
      const initial = plan.initial!;
      const row = await tx.salesOrder.create({
        data: {
          tenantId,
          source: n.source,
          sourceConnector: n.connector,
          externalId: n.externalId,
          ...header,
          status: initial,
          soNo: initial === 'DRAFT' ? null : await issueNumber(tx, tenantId, { docType: 'SO' }),
        },
      });
      id = row.id;
    } else {
      id = current.id;
      await tx.salesOrder.update({
        where: { id },
        data: { ...header, version: { increment: 1 } },
      });
      await tx.salesOrderStop.deleteMany({ where: { salesOrderId: id } });
      await tx.salesOrderLine.deleteMany({ where: { salesOrderId: id } });
      // บรรทัดราคาที่ระบบคิด (RATE_CARD) rebuild ได้ — บรรทัดที่คนเพิ่ม (MANUAL, ST3-T02/ST5) คงไว้
      await tx.salesOrderCharge.deleteMany({ where: { salesOrderId: id, origin: 'RATE_CARD' } });
    }
    await this.writeChildren(tx, tenantId, id, n, quote);
    if (created) {
      // order.created ก่อน event ของ transition (held/…) — ผู้รับ webhook เห็นลำดับตามจริง
      const v = orderEventView(
        await tx.salesOrder.findUniqueOrThrow({ where: { id }, include: INCLUDE }),
      );
      await this.audit.record({
        action: `${ENTITY}.created`,
        entityType: ENTITY,
        entityId: id,
        after: v,
      });
      await this.emit(tx, 'order.created', id, v, {});
    }

    // สถานะ: เดินตาม event ที่ planIntake ตัดสิน (ผ่านตาราง SO_TRANSITIONS — ผิดตาราง = 409)
    let status = (current?.status ?? plan.initial) as SoStatus;
    for (const event of plan.events) {
      const from = status;
      const to = transition(ENTITY, SO_TRANSITIONS, from, event);
      const needsNo = from === 'DRAFT' && to !== 'DRAFT';
      const soNo =
        needsNo && !current?.soNo ? await issueNumber(tx, tenantId, { docType: 'SO' }) : undefined;
      await this.state.transition<SoStatus, SoEvent>(tx, {
        docType: ENTITY,
        docId: id,
        table: SO_TRANSITIONS,
        from,
        event,
        reasonCodeId: event === 'hold' ? holdId : null,
        note: event === 'hold' ? (holds[0]?.field ?? null) : null,
        eventType: EVENT_TYPE[event] ?? 'order.updated',
        apply: async (next) => {
          const row = await tx.salesOrder.update({
            where: { id },
            data: {
              status: next as DbSoStatus,
              holdReasonCodeId: next === 'ON_HOLD' ? holdId : null,
              ...(soNo ? { soNo } : {}),
            },
            include: INCLUDE,
          });
          return orderEventView(row);
        },
      });
      status = to;
    }
    if (plan.holdCodeChanged) {
      // ค้างต่อด้วยเหตุใหม่ (ไม่ใช่ transition) — บันทึกประวัติให้เห็นว่าเหตุเปลี่ยน
      await tx.salesOrder.update({ where: { id }, data: { holdReasonCodeId: holdId } });
      await tx.docStatusHistory.create({
        data: {
          tenantId,
          docType: ENTITY,
          docId: id,
          fromStatus: 'ON_HOLD',
          toStatus: 'ON_HOLD',
          event: 'hold_reason_changed',
          actorId: ctx.actorId ?? null,
          reasonCodeId: holdId,
          note: holds[0]?.field ?? null,
        },
      });
    }

    const order = await tx.salesOrder.findUniqueOrThrow({ where: { id }, include: INCLUDE });
    if (!created) {
      const view = orderEventView(order);
      await this.audit.changed(`${ENTITY}.updated`, ENTITY, id, before!, view);
      await this.emit(tx, 'order.updated', id, view, diff(before!, view).before);
    }
    return { order, created, changed: true, holds };
  }

  private async resolveReferences(tx: Tx, n: NormalizedOrder) {
    // ลูกค้า: id ตรง → ต้องมีอยู่ (422) · รหัสต้นทาง (externalId) → จับคู่ตรงตัว ไม่พบ = CUSTOMER_UNMAPPED (alias/fuzzy = ST3-T06)
    let customerId = n.customer.id;
    if (customerId) {
      const ok = await lockReferenced(tx, 'customer', [customerId]);
      if (!ok.length) throw field422('customer.id', 'reference_not_found', 'customer not found');
    } else if (n.customer.externalId) {
      const byExt = await tx.customer.findFirst({
        where: { externalId: n.customer.externalId, deletedAt: null },
        select: { id: true },
      });
      if (byExt) {
        await lockReferenced(tx, 'customer', [byExt.id]);
        customerId = byExt.id;
      }
    }
    const customer = customerId
      ? await tx.customer.findUnique({
          where: { id: customerId },
          select: { id: true, defaultBillingCompanyId: true },
        })
      : null;

    const check = async (
      table: Parameters<typeof lockReferenced>[1],
      items: { field: string; id: string | null }[],
      what: string,
    ) => {
      const ids = items.flatMap((x) => (x.id ? [x.id] : []));
      const found = new Set((await lockReferenced(tx, table, ids)).map((r) => r.id));
      const miss = items.find((x) => x.id && !found.has(x.id));
      if (miss) throw field422(miss.field, 'reference_not_found', `${what} not found`);
    };
    await check(
      'customer_site',
      n.stops.map((s, i) => ({ field: `stops[${i}].siteId`, id: s.siteId })),
      'site',
    );
    await check('vehicle_type', [{ field: 'vehicleTypeId', id: n.vehicleTypeId }], 'vehicle type');
    await check(
      'unit',
      n.lines.map((l, i) => ({ field: `lines[${i}].unitId`, id: l.unitId })),
      'unit',
    );
    await check(
      'product',
      n.lines.map((l, i) => ({ field: `lines[${i}].productId`, id: l.productId })),
      'product',
    );
    return { customer };
  }

  /** ราคาขาย: ข้อมูลไม่พอหา rate (ลูกค้า/จุดรับ/จุดส่ง/ประเภทรถ) = RATE_MISSING พร้อมช่องที่ขาด — ไม่เรียก engine */
  private async quote(tx: Tx, n: NormalizedOrder, customerId: string | null): Promise<Quote> {
    const origin = n.stops.find((s) => s.type === 'PICKUP')?.siteId ?? null;
    const dest = [...n.stops].reverse().find((s) => s.type === 'DELIVERY')?.siteId ?? null;
    const missing = [
      ['customer', customerId],
      ['stops.pickup', origin],
      ['stops.delivery', dest],
      ['vehicleTypeId', n.vehicleTypeId],
    ].filter(([, v]) => !v);
    if (missing.length || !customerId || !origin || !dest || !n.vehicleTypeId)
      return {
        pricingStatus: 'RATE_MISSING',
        total: null,
        lines: [],
        reasons: missing.map(([field]) => ({
          code: 'RATE_MISSING' as const,
          message: `ยังหา rate card ไม่ได้ — ขาดข้อมูล ${field}`,
          field: field!,
        })),
        warnings: [],
        params: {
          rateCardId: null,
          rateCode: null,
          rateRevision: null,
          pricingModel: null,
          unitPrice: null,
          minCharge: null,
          includedStops: null,
          extraStopPrice: null,
          distanceKm: null,
          quantity: null,
          stops: n.stops.length,
          extraStops: null,
        },
        routeId: null,
      };
    return this.pricing.quote(
      {
        side: 'SELL',
        partyId: customerId,
        originSiteId: origin,
        destSiteId: dest,
        vehicleTypeId: n.vehicleTypeId,
        date: n.requestedDate,
        quantities: n.lines.flatMap((l) =>
          l.unitId ? [{ qty: l.qty, unitId: l.unitId, productId: l.productId }] : [],
        ),
        stops: n.stops.length,
      },
      tx,
    );
  }

  private async writeChildren(
    tx: Tx,
    tenantId: string,
    salesOrderId: string,
    n: NormalizedOrder,
    quote: Quote,
  ) {
    // ข้อความสถานที่: ตามต้นทาง หรือชื่อสถานที่ ณ เวลารับงาน (เลือกจาก master โดยไม่มีข้อความ)
    const siteIds = n.stops.flatMap((s) => (s.siteId && !s.siteText ? [s.siteId] : []));
    const names = new Map(
      (siteIds.length
        ? await tx.customerSite.findMany({
            where: { id: { in: siteIds } },
            select: { id: true, name: true },
          })
        : []
      ).map((x) => [x.id, x.name]),
    );
    if (n.stops.length)
      await tx.salesOrderStop.createMany({
        data: n.stops.map((s, i) => ({
          tenantId,
          salesOrderId,
          sequence: i + 1,
          type: s.type,
          siteId: s.siteId,
          siteText: s.siteText || names.get(s.siteId!) || '',
          windowStart: s.windowStart ? new Date(s.windowStart) : null,
          windowEnd: s.windowEnd ? new Date(s.windowEnd) : null,
        })),
      });
    if (n.lines.length) {
      const units = await tx.unit.findMany({
        where: { id: { in: n.lines.flatMap((l) => (l.unitId ? [l.unitId] : [])) } },
        select: { id: true, code: true },
      });
      const code = new Map(units.map((u) => [u.id, u.code]));
      await tx.salesOrderLine.createMany({
        data: n.lines.map((l, i) => ({
          tenantId,
          salesOrderId,
          lineNo: i + 1,
          itemCode: l.itemCode,
          productId: l.productId,
          description: l.description,
          qtyOrdered: l.qty,
          unitId: l.unitId,
          unit: l.unit ?? code.get(l.unitId!)!,
          weightKg: l.weightKg,
          cbm: l.cbm,
          isDangerous: l.isDangerous,
          tempMin: l.tempMin,
          tempMax: l.tempMax,
        })),
      });
    }
    if (quote.pricingStatus === 'AVAILABLE' && quote.lines.length) {
      const manual = await tx.salesOrderCharge.aggregate({
        where: { salesOrderId },
        _max: { lineNo: true },
      });
      const base = manual._max.lineNo ?? 0;
      await tx.salesOrderCharge.createMany({
        data: quote.lines.map((l, i) => ({
          tenantId,
          salesOrderId,
          lineNo: base + i + 1,
          kind: l.kind,
          origin: 'RATE_CARD',
          serviceItemId: l.serviceItem.sourceItemId,
          serviceItemVersion: l.serviceItem.sourceVersion,
          serviceItemSnapshot: JSON.parse(JSON.stringify(l.serviceItem)) as Prisma.InputJsonValue,
          description: l.serviceItem.name,
          qty: l.qty,
          qtyExact: l.qtyExact,
          unitPrice: l.unitPrice,
          amount: l.amount,
          calculatedAmount: l.calculatedAmount,
          minChargeApplied: l.minChargeApplied,
          vatType: l.vatType,
          // เปอร์เซ็นต์ตาม snapshot ("1.00") — เอกสารภาษี (ST5) แปลงด้วย toCalcWhtRate() ก่อน computeDocumentTax
          whtRate: l.whtRate,
          rateCardId: l.kind === 'ACCESSORIAL' ? null : quote.params.rateCardId,
          rateCardCode: l.kind === 'ACCESSORIAL' ? null : quote.params.rateCode,
          rateCardRevision: l.kind === 'ACCESSORIAL' ? null : quote.params.rateRevision,
        })),
      });
    }
  }

  private async holdReasonId(tx: Tx, code: string): Promise<string> {
    const r = await tx.reasonCode.findFirst({
      where: { category: 'ORDER_HOLD', code, deletedAt: null },
      select: { id: true },
    });
    // รหัสระบบ (is_system) ลบ/ปิดไม่ได้ และ bootstrap สร้างให้ทุก tenant — ไม่พบ = ข้อมูลตั้งต้นของ tenant เสีย
    if (!r) throw new Error(`ORDER_HOLD reason code ${code} missing — run tenants:bootstrap`);
    return r.id;
  }

  private async emit(
    tx: Tx,
    type: string,
    localId: string,
    snapshot: Record<string, unknown>,
    previous: Record<string, unknown>,
  ) {
    const ctx = requestContext.require();
    await tx.domainEvent.create({
      data: {
        tenantId: ctx.tenantId!,
        type,
        entityType: ENTITY,
        localId,
        snapshot: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue,
        previousAttributes: JSON.parse(JSON.stringify(previous)) as Prisma.InputJsonValue,
        requestId: ctx.requestId ?? null,
        actorId: ctx.actorId ?? null,
      },
    });
  }
}
