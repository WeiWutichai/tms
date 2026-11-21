import { Prisma } from '@prisma/client';
import { formatOrderSource, type IntakeHold, type OrderSource } from '@tms/domain';
import { encodeId } from '../../common/ids';
import { redactPrices } from '../../common/price-fields';
import type { Tx } from '../../db/db.service';
import type { MatchSuggestion } from './order-matching.service';
import type { OrderDto, SoStatusValue, SourceChangeEntryDto } from './order.dto';

/**
 * DTO ของใบสั่ง (ย้ายจาก orders.service — ST7-T06): ใช้ทั้ง `GET /v1/orders/{id}` และ `data.object` ของ webhook `order.*`
 * ไฟล์นี้ไม่ import service (กัน import วนจาก OrderIntakeService/OrderStateService)
 */
export const READ_INCLUDE = {
  stops: { orderBy: { sequence: 'asc' } },
  lines: { orderBy: { lineNo: 'asc' } },
  charges: { orderBy: { lineNo: 'asc' } },
  holdReasonCode: { select: { code: true, labelTh: true } },
  customer: { select: { code: true, legalName: true } },
  // ชุดการเปลี่ยนแปลงจากต้นทางที่รอตัดสิน (ST3-T10 — ได้ครั้งละ 1 ชุด)
  sourceChanges: { where: { status: 'PENDING' }, take: 1 },
  // ST4-T12 DO ส่งใหม่ที่ยังรอจัด → วันที่นัด + เหตุรอง RESCHEDULES_EXHAUSTED (review M1/L)
  deliveryOrders: {
    where: { status: 'DRAFT', redeliveryOfId: { not: null } },
    select: { doDate: true, rescheduleExhausted: true },
  },
} as const satisfies Prisma.SalesOrderInclude;

export type OrderRow = Prisma.SalesOrderGetPayload<{ include: typeof READ_INCLUDE }>;

export const dec = (v: Prisma.Decimal | null) => (v === null ? null : v.toFixed());

export function toOrderDto(o: OrderRow): OrderDto {
  const detail = (o.pricingDetail ?? {}) as {
    reasons?: { code: string; message: string; field?: string }[];
    holds?: IntakeHold[];
  };
  const primaryHold = o.holdReasonCode
    ? (detail.holds ?? []).find((h) => h.code === o.holdReasonCode!.code)
    : undefined;
  return {
    id: encodeId('salesOrder', o.id),
    soNo: o.soNo,
    status: o.status.toLowerCase() as SoStatusValue,
    source: formatOrderSource({ source: o.source as OrderSource, connector: o.sourceConnector }),
    sourceType: o.source as OrderSource,
    connector: o.sourceConnector || null,
    externalId: o.externalId,
    customer: {
      id: o.customerId ? encodeId('customer', o.customerId) : null,
      code: o.customer?.code ?? null,
      legalName: o.customer?.legalName ?? null,
      externalId: o.customerExternalId,
      name: o.customerText,
      match: {
        method: o.customerMatchMethod,
        candidates: candidatesDto('customer', o.customerCandidates),
      },
    },
    billingCompanyId: encodeId('company', o.billingCompanyId),
    customerRef: o.customerRef,
    requestedDate: o.requestedDate.toISOString().slice(0, 10),
    vehicleTypeId: o.vehicleTypeId ? encodeId('vehicleType', o.vehicleTypeId) : null,
    holdReason: o.holdReasonCode
      ? {
          code: o.holdReasonCode.code,
          label: o.holdReasonCode.labelTh,
          note: o.holdNote,
          // ช่องต้นเหตุ (เหตุของทางเข้า — เช่น stops[1].site) ให้หน้าใบค้างพาไปจุดที่ต้องแก้ (ST3-T07)
          field: primaryHold?.field ?? null,
          fields: primaryHold?.fields ?? (primaryHold?.field ? [primaryHold.field] : []),
        }
      : null,
    holdCodes: [
      ...new Set([
        ...(detail.holds ?? []).map((h) => h.code),
        ...(o.deliveryOrders.some((d) => d.rescheduleExhausted) ? ['RESCHEDULES_EXHAUSTED'] : []),
      ]),
    ],
    rescheduledDate:
      o.deliveryOrders
        .map((d) => d.doDate.toISOString().slice(0, 10))
        .sort()
        .at(-1) ?? null,
    pricingStatus: o.pricingStatus,
    pricingReasons: (detail.reasons ?? []).map((r) => ({
      code: r.code,
      message: r.message,
      ...(r.field ? { field: r.field } : {}),
    })),
    sellTotal: o.priceTotal ? o.priceTotal.toFixed(2) : null,
    sellCharges: o.charges.map((c) => ({
      lineNo: c.lineNo,
      kind: c.kind,
      origin: c.origin,
      serviceItemId: encodeId('serviceItem', c.serviceItemId),
      serviceItemVersion: c.serviceItemVersion,
      description: c.description,
      qty: c.qty.toFixed(),
      sellUnitPrice: c.unitPrice.toFixed(2),
      sellAmount: c.amount.toFixed(2),
      vatType: c.vatType,
      whtRate: c.whtRate.toFixed(2),
      rateCardId: c.rateCardId ? encodeId('rateCard', c.rateCardId) : null,
      rateCardCode: c.rateCardCode,
      rateCardRevision: c.rateCardRevision,
    })),
    stops: o.stops.map((s) => ({
      sequence: s.sequence,
      type: s.type,
      siteId: s.siteId ? encodeId('site', s.siteId) : null,
      siteText: s.siteText,
      windowStart: s.windowStart?.toISOString() ?? null,
      windowEnd: s.windowEnd?.toISOString() ?? null,
      match: {
        method: s.matchMethod,
        score: s.matchScore === null ? null : Number(s.matchScore.toFixed(3)),
        candidates: candidatesDto('site', s.matchCandidates),
      },
    })),
    lines: o.lines.map((l) => ({
      lineNo: l.lineNo,
      description: l.description,
      qty: l.qtyOrdered.toFixed(),
      unitId: l.unitId ? encodeId('unit', l.unitId) : null,
      unit: l.unit,
      productId: l.productId ? encodeId('product', l.productId) : null,
      itemCode: l.itemCode,
      weightKg: dec(l.weightKg),
      cbm: dec(l.cbm),
      isDangerous: l.isDangerous,
      tempMin: dec(l.tempMin),
      tempMax: dec(l.tempMax),
    })),
    sourceChangedAfterPlan: o.sourceChangedAfterPlan,
    sourceCancelledAt: o.sourceCancelledAt?.toISOString() ?? null,
    sourceChange: o.sourceChanges[0]
      ? {
          id: encodeId('orderSourceChange', o.sourceChanges[0].id),
          status: o.sourceChanges[0].status,
          source: formatOrderSource({
            source: o.sourceChanges[0].source as OrderSource,
            connector: o.sourceChanges[0].sourceConnector,
          }),
          orderStatus: o.sourceChanges[0].orderStatus.toLowerCase(),
          receivedAt: o.sourceChanges[0].createdAt.toISOString(),
          changes: o.sourceChanges[0].changes as unknown as SourceChangeEntryDto[],
        }
      : null,
    version: o.version,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

/** รายการแนะนำที่เก็บไว้ (uuid) → public id */
function candidatesDto(kind: 'site' | 'customer', v: Prisma.JsonValue) {
  return ((v ?? []) as unknown as MatchSuggestion[]).map((c) => ({
    id: encodeId(kind, c.id),
    code: c.code,
    name: c.name,
    score: c.score,
  }));
}

/**
 * `data.object` ของ webhook `order.*` (ST7-T06 — QA): toOrderDto ตัวเดียวกับ REST แล้วตัด field ราคาทุกตัว
 * (`sellTotal`, `sellCharges` — webhook ระดับ tenant ไม่ผ่านสิทธิ์ราคา) · ไม่มี editableFields/editLock/sellBilling (ขึ้นกับผู้เรียก)
 */
export function orderEventObject(o: OrderRow): Record<string, unknown> {
  return JSON.parse(JSON.stringify(redactPrices(toOrderDto(o), []))) as Record<string, unknown>;
}

export async function loadOrderEventObject(tx: Tx, id: string): Promise<Record<string, unknown>> {
  return orderEventObject(
    await tx.salesOrder.findUniqueOrThrow({ where: { id }, include: READ_INCLUDE }),
  );
}

/** ค่าเดิมของ field ที่เปลี่ยน (ระดับบนสุด) — `previousAttributes` ของ webhook */
export function previousOf(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)]))
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out[k] = before[k] ?? null;
  return out;
}

/** มีการเปลี่ยนที่ผู้รับสนใจ (ไม่นับ version/updatedAt ที่เปลี่ยนทุกครั้ง) */
export const meaningful = (prev: Record<string, unknown>) =>
  Object.keys(prev).some((k) => k !== 'version' && k !== 'updatedAt');
