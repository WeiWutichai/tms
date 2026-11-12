import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  formatOrderSource,
  parseOrderSource,
  soEditableFields,
  type IntakeHold,
  type SoStatus,
  type OrderSource,
  type OrderSourceRef,
} from '@tms/domain';
import { encodeId, tryDecodeId, type IdKind } from '../../common/ids';
import { keysetArgs, toPage } from '../../common/pagination';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { likeEscape } from '../master/master-kit';
import type { UpsertOrderInput } from './order-input';
import { OrderIntakeService, type UpsertOrderResult } from './order-intake.service';
import type {
  CreateOrderDto,
  OrderDto,
  OrderFieldsDto,
  OrderListQuery,
  OrderSummaryDto,
  SoStatusValue,
  UpdateOrderDto,
} from './order.dto';

const READ_INCLUDE = {
  stops: { orderBy: { sequence: 'asc' } },
  lines: { orderBy: { lineNo: 'asc' } },
  charges: { orderBy: { lineNo: 'asc' } },
  holdReasonCode: { select: { code: true, labelTh: true } },
  customer: { select: { code: true, legalName: true } },
} as const satisfies Prisma.SalesOrderInclude;

type OrderRow = Prisma.SalesOrderGetPayload<{ include: typeof READ_INCLUDE }>;

/** ชื่อ field ของ OrderDto ที่ `?fields=` เลือกได้ */
const ORDER_FIELDS = new Set([
  'id',
  'soNo',
  'status',
  'source',
  'sourceType',
  'connector',
  'externalId',
  'customer',
  'billingCompanyId',
  'customerRef',
  'requestedDate',
  'vehicleTypeId',
  'holdReason',
  'holdCodes',
  'pricingStatus',
  'pricingReasons',
  'sellTotal',
  'sellCharges',
  'stops',
  'lines',
  'version',
  'createdAt',
  'updatedAt',
]);

const dec = (v: Prisma.Decimal | null) => (v === null ? null : v.toFixed());

export function toOrderDto(o: OrderRow): OrderDto {
  const detail = (o.pricingDetail ?? {}) as {
    reasons?: { code: string; message: string; field?: string }[];
    holds?: IntakeHold[];
  };
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
    },
    billingCompanyId: encodeId('company', o.billingCompanyId),
    customerRef: o.customerRef,
    requestedDate: o.requestedDate.toISOString().slice(0, 10),
    vehicleTypeId: o.vehicleTypeId ? encodeId('vehicleType', o.vehicleTypeId) : null,
    holdReason: o.holdReasonCode
      ? { code: o.holdReasonCode.code, label: o.holdReasonCode.labelTh, note: o.holdNote }
      : null,
    holdCodes: (detail.holds ?? []).map((h) => h.code),
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
    version: o.version,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

/**
 * public id → uuid สำหรับ `upsertOrder` · id ผิดรูป/ผิดชนิด → ค่าที่ไม่ใช่ uuid ให้กฎชุดเดียว (`normalizeOrderInput`)
 * ตอบ 422 `invalid_id` พร้อม path ของช่อง (รวมกับข้อผิดอื่นใน 422 เดียว) — ไม่รับ uuid ดิบ
 */
function pub(kind: IdKind, v: unknown): unknown {
  if (v === undefined || v === null || v === '') return v;
  if (typeof v !== 'string') return v;
  return tryDecodeId(kind, v) ?? `invalid:${v}`;
}

/**
 * ที่มาของผู้เรียก (docs/04 C) — ผู้ใช้ในหน้าจอ (session Auth Code + PKCE) = MANUAL; API client / token อื่น = API
 * connector (ST3-T05/ST8) เรียก `upsertOrder` ด้วย `ERP:{connector}` ของตัวเอง
 */
export function callerOrderSource(): OrderSourceRef {
  const pt = requestContext.get()?.principalType;
  return pt === 'user' || pt === 'imp'
    ? { source: 'MANUAL', connector: '' }
    : { source: 'API', connector: '' };
}

/**
 * Open API `orders` (ST3-T03) — อ่าน/รายการ + แปลง body เป็น `UpsertOrderInput` แล้วเรียก
 * `OrderIntakeService.upsertOrder` (ทางเขียนเดียว — test `orders-api` ตรวจว่า controller เขียนผ่านทางนี้เท่านั้น)
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly db: DbService,
    private readonly intake: OrderIntakeService,
  ) {}

  // ---------- read ----------

  async get(id: string): Promise<OrderRow> {
    const o = await this.db.tx.salesOrder.findUnique({ where: { id }, include: READ_INCLUDE });
    if (!o) throw new ProblemException('not_found');
    return o;
  }

  async getByExternalId(externalId: string): Promise<OrderRow> {
    const tenantId = requestContext.require().tenantId!;
    const o = await this.db.tx.salesOrder.findUnique({
      where: { tenantId_externalId: { tenantId, externalId } },
      include: READ_INCLUDE,
    });
    if (!o) throw new ProblemException('not_found');
    return o;
  }

  /**
   * ช่องที่แก้ได้ในสถานะปัจจุบัน (`soEditableFields` — กฎเดียวกับที่ upsertOrder ใช้ตอนเขียน) ให้ฟอร์มปิดช่องก่อนส่ง
   * DO ของใบอยู่ในเที่ยวแล้ว = เหมือน PLANNED (ORD-023)
   */
  async editableFields(o: { id: string; status: string }): Promise<string[]> {
    const onTrip =
      (await this.db.tx.deliveryOrder.count({
        where: { salesOrderId: o.id, tripId: { not: null }, status: { not: 'CANCELLED' } },
      })) > 0;
    return [...soEditableFields(o.status as SoStatus, onTrip)];
  }

  /** ตัวนับของหน้ารายการ (แถบสรุป/แท็บ) — วันนี้ตามเวลาไทย (Asia/Bangkok) */
  async summary(): Promise<OrderSummaryDto> {
    const tx = this.db.tx;
    const today = new Date(
      `${new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)}T00:00:00Z`,
    );
    const [total, draft, onHold, planned, plannedToday, overdue, loc, cus] = await Promise.all([
      tx.salesOrder.count(),
      tx.salesOrder.count({ where: { status: 'DRAFT' } }),
      tx.salesOrder.count({ where: { status: 'ON_HOLD' } }),
      tx.salesOrder.count({ where: { status: 'PLANNED' } }),
      tx.salesOrder.count({ where: { status: 'PLANNED', requestedDate: today } }),
      tx.salesOrder.count({
        where: { status: { in: ['RECEIVED', 'ON_HOLD', 'PLANNED'] }, requestedDate: { lt: today } },
      }),
      this.countHeld('LOCATION_UNMAPPED'),
      this.countHeld('CUSTOMER_UNMAPPED'),
    ]);
    return {
      total,
      draft,
      onHold,
      locationUnmapped: loc,
      customerUnmapped: cus,
      overdue,
      planned,
      plannedToday,
    };
  }

  /** ใบค้างที่มีเหตุนี้ (เหตุหลักหรือเหตุรอง — เงื่อนไขเดียวกับตัวกรอง `status=on_hold&holdReason=`) */
  private async countHeld(code: string): Promise<number> {
    return this.db.tx.salesOrder.count({
      where: {
        AND: [{ status: 'ON_HOLD' }, await this.where({ holdReason: code } as OrderListQuery)],
      },
    });
  }

  /** ใบที่เหตุค้างของการรับงานครั้งล่าสุด (`pricing_detail.holds[].code`) มีรหัสใดรหัสหนึ่ง (RLS จำกัด tenant) */
  private async heldIds(codes: string[]): Promise<string[]> {
    const rows = await this.db.tx.$queryRaw<{ id: string }[]>`
      SELECT o.id FROM sales_order o
       WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(o.pricing_detail->'holds', '[]'::jsonb)) h
                      WHERE h->>'code' = ANY(${codes}::text[]))`;
    return rows.map((r) => r.id);
  }

  private async where(q: OrderListQuery): Promise<Prisma.SalesOrderWhereInput> {
    const and: Prisma.SalesOrderWhereInput[] = [];
    if (q.status)
      and.push({
        status: { in: q.status.split(',').map((s) => s.toUpperCase()) as OrderRow['status'][] },
      });
    // เหตุค้าง: ตรงกับเหตุใดก็ได้ของการรับงานครั้งล่าสุด (`holdCodes` — เหตุหลัก + เหตุรอง) หรือเหตุหลักบนใบ
    // (เหตุที่ flow อื่นตั้ง เช่น CARRIER_REJECTED) — หน้าใบค้าง (ST3-T07) กรองเหตุรองได้
    // เหตุค้าง: เหตุหลักบนใบ (รวมเหตุที่ flow อื่นตั้ง) หรือเหตุใดก็ได้ของ `holdCodes` (เหตุรอง) — หน้าใบค้าง ST3-T07
    if (q.holdReason) {
      const codes = q.holdReason.split(',');
      and.push({
        OR: [
          { holdReasonCode: { code: { in: codes } } },
          { id: { in: await this.heldIds(codes) } },
        ],
      });
    }
    if (q.customerId) and.push({ customerId: tryDecodeId('customer', q.customerId)! });
    if (q.source) {
      const or: Prisma.SalesOrderWhereInput[] = q.source.split(',').map((v) => {
        if (v === 'ERP' || v === 'CONNECTOR') return { source: 'CONNECTOR' };
        const ref = parseOrderSource(v);
        if (!ref)
          throw new ProblemException('validation_failed', undefined, [
            { field: 'source', code: 'invalid_source', message: `unknown source ${v}` },
          ]);
        return ref.source === 'CONNECTOR'
          ? { source: 'CONNECTOR', sourceConnector: ref.connector }
          : { source: ref.source };
      });
      and.push({ OR: or });
    }
    if (q.requestedFrom)
      and.push({ requestedDate: { gte: dateOr422(q.requestedFrom, 'requestedFrom') } });
    if (q.requestedTo)
      and.push({ requestedDate: { lte: dateOr422(q.requestedTo, 'requestedTo') } });
    if (q.externalId) and.push({ externalId: q.externalId });
    if (q.q) {
      const like = { contains: likeEscape(q.q), mode: 'insensitive' as const };
      and.push({
        OR: [
          { soNo: like },
          { externalId: like },
          { customerRef: like },
          { customerText: like },
          { customerExternalId: like },
          { customer: { legalName: like } },
          { customer: { code: like } },
        ],
      });
    }
    return { AND: and };
  }

  async list(q: OrderListQuery) {
    const unknown = q.fields?.split(',').filter((f) => !ORDER_FIELDS.has(f)) ?? [];
    if (unknown.length)
      throw new ProblemException('validation_failed', undefined, [
        { field: 'fields', code: 'unknown_field', message: `unknown field: ${unknown.join(', ')}` },
      ]);
    const k = keysetArgs(q);
    const rows = await this.db.tx.salesOrder.findMany({
      where: { AND: [await this.where(q), k.where as Prisma.SalesOrderWhereInput] },
      orderBy: k.orderBy as unknown as Prisma.SalesOrderOrderByWithRelationInput[],
      take: k.take,
      include: READ_INCLUDE,
    });
    return toPage(rows, k, toOrderDto, q.fields);
  }

  // ---------- write (ผ่าน upsertOrder เท่านั้น) ----------

  /** POST /orders — ที่มา = ผู้เรียก (MANUAL/API); มี externalId = upsert idempotent ต่อ externalId */
  create(body: CreateOrderDto): Promise<UpsertOrderResult> {
    return this.intake.upsertOrder({
      ...toInput(body),
      source: callerOrderSource(),
      externalId: body.externalId ?? null,
    });
  }

  /** PUT /orders/external/{externalId} — ที่มา API เสมอ (ทางเข้าของระบบภายนอก); ใบของช่องทางอื่น → 409 */
  upsertExternal(
    externalId: string,
    body: OrderFieldsDto,
    expectedVersion?: number | '*',
  ): Promise<UpsertOrderResult> {
    return this.intake.upsertOrder({
      ...toInput(body),
      source: { source: 'API', connector: '' },
      externalId,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    });
  }

  /**
   * PATCH — ล็อกแถวก่อน แล้วรวมช่องที่ส่งกับข้อมูลเดิม (ช่องบนสุด; customer/stops/lines แทนทั้งก้อน) → `upsertOrder({id})`
   * ช่องที่ไม่ได้ส่งคงค่าเดิม (นิติบุคคลออกบิล/ข้อความสถานที่/sourceIssues/rawPayload) — ช่องที่ห้ามแก้ตามสถานะ → 409
   */
  async update(id: string, body: UpdateOrderDto, expectedVersion?: number | '*') {
    const tx = this.db.tx;
    await tx.$queryRaw`SELECT id FROM sales_order WHERE id = ${id}::uuid FOR UPDATE`;
    const cur = await this.get(id);
    const base: UpsertOrderInput = {
      id: cur.id,
      source: { source: cur.source as OrderSource, connector: cur.sourceConnector },
      draft: cur.status === 'DRAFT',
      customer: { id: cur.customerId, externalId: cur.customerExternalId, text: cur.customerText },
      billingCompanyId: cur.billingCompanyId,
      customerRef: cur.customerRef,
      requestedDate: cur.requestedDate.toISOString().slice(0, 10),
      vehicleTypeId: cur.vehicleTypeId,
      stops: cur.stops.map((s) => ({
        type: s.type,
        siteId: s.siteId,
        siteText: s.siteText,
        windowStart: s.windowStart?.toISOString() ?? null,
        windowEnd: s.windowEnd?.toISOString() ?? null,
      })),
      lines: cur.lines.map((l) => ({
        description: l.description,
        qty: l.qtyOrdered.toFixed(),
        unitId: l.unitId,
        unit: l.unit,
        productId: l.productId,
        itemCode: l.itemCode,
        weightKg: dec(l.weightKg),
        cbm: dec(l.cbm),
        isDangerous: l.isDangerous,
        tempMin: dec(l.tempMin),
        tempMax: dec(l.tempMax),
      })),
      sourceIssues: (cur.sourceIssues as string[] | null) ?? [],
      rawPayload: cur.rawPayload ?? null,
    };
    const patch = toInput(body, true);
    const merged: UpsertOrderInput = { ...base };
    for (const [k, v] of Object.entries(patch))
      if (v !== undefined) (merged as unknown as Record<string, unknown>)[k] = v;
    return this.intake.upsertOrder({
      ...merged,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    });
  }
}

function dateOr422(v: string, field: string): Date {
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v)
    throw new ProblemException('validation_failed', undefined, [
      { field, code: 'invalid_date', message: 'must be YYYY-MM-DD' },
    ]);
  return d;
}

/**
 * body (public id) → UpsertOrderInput (uuid) — `partial` (PATCH) = ช่องที่ไม่ส่งเป็น undefined
 * ข้อความสถานที่ของจุดที่ส่งมาแบบมีแต่ siteId: ใช้ข้อความเดิมของจุดลำดับเดียวกัน (upsertOrder) หรือชื่อสถานที่
 */
export function toInput(
  b: Partial<OrderFieldsDto>,
  partial = false,
): Omit<UpsertOrderInput, 'source'> & { requestedDate: string } {
  const o = <T>(v: T | undefined, d: T): T => (v === undefined && !partial ? d : (v as T));
  return {
    draft: o(b.draft, false),
    customer:
      b.customer === undefined
        ? (o(undefined, {}) as UpsertOrderInput['customer'])
        : {
            id: pub('customer', b.customer.id) as string | null,
            externalId: b.customer.externalId ?? null,
            text: b.customer.name ?? null,
          },
    billingCompanyId: o(pub('company', b.billingCompanyId) as string | null | undefined, null),
    customerRef: o(b.customerRef, null),
    requestedDate: b.requestedDate as string,
    vehicleTypeId: o(pub('vehicleType', b.vehicleTypeId) as string | null | undefined, null),
    stops:
      b.stops === undefined
        ? (undefined as unknown as UpsertOrderInput['stops'])
        : b.stops.map((s) => ({
            type: s.type,
            siteId: pub('site', s.siteId) as string | null,
            siteText: s.siteText ?? null,
            windowStart: s.windowStart ?? null,
            windowEnd: s.windowEnd ?? null,
          })),
    lines:
      b.lines === undefined
        ? (o(undefined, []) as UpsertOrderInput['lines'])
        : b.lines.map((l) => ({
            description: l.description,
            qty: l.qty,
            unitId: pub('unit', l.unitId) as string | null,
            unit: l.unit ?? null,
            productId: pub('product', l.productId) as string | null,
            itemCode: l.itemCode ?? null,
            weightKg: l.weightKg ?? null,
            cbm: l.cbm ?? null,
            ...(l.isDangerous !== undefined ? { isDangerous: l.isDangerous } : {}),
            tempMin: l.tempMin ?? null,
            tempMax: l.tempMax ?? null,
          })),
  };
}
