import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  formatOrderSource,
  ORDER_HOLD_CODES,
  parseOrderSource,
  soEditableFields,
  SOURCE_CHANGED_HOLD_CODE,
  type IntakeHold,
  type SoStatus,
  type OrderSource,
  type OrderSourceRef,
  OPS_ORDER_WAITING,
  OPS_ORDER_WAITING_DAYS_AHEAD,
} from '@tms/domain';
import { Clock } from '../../common/clock';
import { addDays, bangkokToday } from '../vehicle-documents/expiry';
import { encodeId, tryDecodeId, type IdKind } from '../../common/ids';
import { keysetArgs, toPage } from '../../common/pagination';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { exportFetchArgs, type ExportPage } from '../master/export';
import { likeEscape } from '../master/master-kit';
import type { UpsertOrderInput } from './order-input';
import { OrderIntakeService, type UpsertOrderResult } from './order-intake.service';
import { OrderStateService } from './order-state.service';
import { dec, READ_INCLUDE, toOrderDto, type OrderRow } from './order-dto';

export { toOrderDto };
import type {
  CreateOrderDto,
  OrderDto,
  OrderFieldsDto,
  OrderListQuery,
  OrderSummaryDto,
  SoStatusValue,
  SourceChangeEntryDto,
  UpdateOrderDto,
} from './order.dto';

/** ใบสั่งที่มี DO ส่งใหม่เกินจำนวนครั้งรอจัด (เหตุรอง — ไม่ทับเหตุหลักของทางเข้า) */
const EXHAUSTED_WHERE = {
  deliveryOrders: { some: { status: 'DRAFT', rescheduleExhausted: true } },
} as const satisfies Prisma.SalesOrderWhereInput;

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
  'rescheduledDate',
  'pricingStatus',
  'pricingReasons',
  'sellTotal',
  'sellCharges',
  'stops',
  'lines',
  'sourceChangedAfterPlan',
  'sourceChange',
  'version',
  'createdAt',
  'updatedAt',
]);

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
    private readonly state: OrderStateService,
    private readonly clock: Clock,
  ) {}

  // ---------- ST3-T10 ยกเลิก + ชุดการเปลี่ยนแปลงจากต้นทาง ----------

  /** POST /orders/{id}/cancel — public id ของ reason code → uuid (ผิดรูป/ไม่พบ = 422 ที่ช่องเดียวกัน) */
  cancel(
    id: string,
    body: { reason: string; reasonCodeId?: string | null },
    expectedVersion?: number | '*',
  ) {
    let reasonCodeId: string | null = null;
    if (body.reasonCodeId) {
      reasonCodeId = tryDecodeId('reasonCode', body.reasonCodeId);
      if (!reasonCodeId)
        throw new ProblemException('validation_failed', undefined, [
          { field: 'reasonCodeId', code: 'invalid_reference', message: 'reason code not found' },
        ]);
    }
    return this.state.cancel(id, {
      reason: body.reason,
      reasonCodeId,
      ...(typeof expectedVersion === 'number' ? { expectedVersion } : {}),
    });
  }

  /** รับ/ไม่รับ ชุดการเปลี่ยนแปลงจากต้นทาง — changeId ผิดรูป = 404 */
  decideSourceChange(
    id: string,
    changeId: string,
    accept: boolean,
    reason: string,
    expectedVersion?: number | '*',
  ) {
    const change = tryDecodeId('orderSourceChange', changeId);
    if (!change) throw new ProblemException('not_found');
    const ev = typeof expectedVersion === 'number' ? expectedVersion : undefined;
    return accept
      ? this.intake.acceptSourceChange(id, change, reason, undefined, ev)
      : this.intake.rejectSourceChange(id, change, reason, undefined, ev);
  }

  /** diff ของชุดที่รอ เทียบข้อมูล TMS ตอนนี้ (ค่า "เดิม" คำนวณตอนอ่าน) — ใช้ใน GET ทีละใบ */
  previewSourceChange(orderId: string, changeId: string) {
    return this.intake.previewSourceChange(orderId, changeId);
  }

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
      // จัดรถแล้ว: ไม่นับใบที่ต้นทางแก้หลังวางแผนรอตัดสิน (อยู่กลุ่มงานค้าง — docs/01 §4.1, QA ST3-T10)
      tx.salesOrder.count({ where: { status: 'PLANNED', sourceChangedAfterPlan: false } }),
      tx.salesOrder.count({
        where: { status: 'PLANNED', sourceChangedAfterPlan: false, requestedDate: today },
      }),
      tx.salesOrder.count({
        where: { status: { in: ['RECEIVED', 'ON_HOLD', 'PLANNED'] }, requestedDate: { lt: today } },
      }),
      this.countHeld('LOCATION_UNMAPPED'),
      this.countHeld('CUSTOMER_UNMAPPED'),
    ]);
    const day = bangkokToday(this.clock.now());
    const [holdReasons, heldTotal, waiting, waitingOverdue] = await Promise.all([
      this.holdReasonCounts(),
      tx.salesOrder.count({
        where: { OR: [{ status: 'ON_HOLD' }, { sourceChangedAfterPlan: true }] },
      }),
      // ST9-T01 dashboard "รอจัดรถ" (spec/09 §1) — ตัวกรองเดียวกับ `GET /orders?status=received,on_hold&requestedTo=`
      tx.salesOrder.count({
        where: await this.where({
          status: OPS_ORDER_WAITING.join(','),
          requestedTo: addDays(day, OPS_ORDER_WAITING_DAYS_AHEAD),
        } as OrderListQuery),
      }),
      tx.salesOrder.count({
        where: await this.where({
          status: OPS_ORDER_WAITING.join(','),
          requestedTo: addDays(day, -1),
        } as OrderListQuery),
      }),
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
      heldTotal,
      holdReasons,
      today: day,
      waiting,
      waitingOverdue,
    };
  }

  /**
   * หน้าใบค้าง (ST3-T07): จำนวนใบค้างต่อเหตุ (เหตุหลักบนใบ ∪ เหตุของการรับงานครั้งล่าสุด) ครบ 12 รหัส — query เดียว (RLS จำกัด tenant)
   * เงื่อนไขเดียวกับ `held=true&holdReason={code}` ของรายการ · ใบที่ต้นทางแก้หลังวางแผน (ธง — สถานะ PLANNED)
   * นับใต้ SOURCE_CHANGED_AFTER_PLAN
   */
  private async holdReasonCounts(): Promise<{ code: string; count: number }[]> {
    const rows = await this.db.tx.$queryRaw<{ code: string; n: bigint }[]>`
      SELECT c.code, count(DISTINCT o.id) AS n
        FROM sales_order o
        LEFT JOIN reason_code r ON r.id = o.hold_reason_code_id
       CROSS JOIN LATERAL (
             SELECT r.code WHERE o.status = 'ON_HOLD'
             UNION
             SELECT h->>'code' FROM jsonb_array_elements(
               CASE WHEN o.status = 'ON_HOLD' THEN COALESCE(o.pricing_detail->'holds', '[]'::jsonb)
                    ELSE '[]'::jsonb END) h
             UNION
             SELECT ${SOURCE_CHANGED_HOLD_CODE}::text WHERE o.source_changed_after_plan
           ) c(code)
       WHERE (o.status = 'ON_HOLD' OR o.source_changed_after_plan) AND c.code IS NOT NULL
       GROUP BY c.code`;
    const n = new Map(rows.map((r) => [r.code, Number(r.n)]));
    return ORDER_HOLD_CODES.map((code) => ({ code, count: n.get(code) ?? 0 }));
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
    // เหตุค้าง: เหตุหลักบนใบ (รวมเหตุที่ flow อื่นตั้ง) หรือเหตุใดก็ได้ของ `holdCodes` (เหตุรอง) — หน้าใบค้าง ST3-T07
    if (q.holdReason) {
      const codes = q.holdReason.split(',');
      and.push({
        OR: [
          { holdReasonCode: { code: { in: codes } } },
          { id: { in: await this.heldIds(codes) } },
          ...(codes.includes('RESCHEDULES_EXHAUSTED') ? [EXHAUSTED_WHERE] : []),
          // ต้นทางแก้หลังวางแผน = ธงข้างสถานะ (ไม่ใช่ ON_HOLD) แต่อยู่หน้างานค้างกลุ่มเดียวกัน (docs/01 §4.1)
          ...(codes.includes(SOURCE_CHANGED_HOLD_CODE) ? [{ sourceChangedAfterPlan: true }] : []),
        ],
      });
    }
    // หน้าใบค้าง (ST3-T07): ใบค้างทั้งหมดในตารางเดียว — รวมใบที่ต้นทางแก้หลังวางแผน (สถานะยัง PLANNED ตาม ST3-T10
    // แต่อยู่หน้างานค้าง — PO ตัดสิน 16 พ.ย. 2569)
    if (q.held === 'true')
      and.push({ OR: [{ status: 'ON_HOLD' }, { sourceChangedAfterPlan: true }] });
    if (q.held === 'false')
      and.push({ status: { not: 'ON_HOLD' } }, { sourceChangedAfterPlan: false });
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

  /**
   * ส่งออกตามตัวกรอง (ST9-T10) — where-builder เดียวกับ `list` อ่านทีละหน้า เรียงตามเวลาสร้าง (ไม่เปลี่ยนระหว่างส่งออก)
   * DTO เดียวกับรายการ (field ราคาถูกตัดตามสิทธิ์ที่ชั้นส่งออก)
   */
  async exportRows(q: OrderListQuery, page: ExportPage): Promise<OrderDto[]> {
    const rows = await this.db.tx.salesOrder.findMany({
      where: await this.where(q),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      ...exportFetchArgs(page),
      include: READ_INCLUDE,
    });
    return rows.map(toOrderDto);
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

  /**
   * PATCH /orders/external/{externalId} (ST7-T02) — ทางเข้าของระบบภายนอกเหมือน PUT: แก้ได้เฉพาะใบที่มาจาก API
   * ใบจากช่องทางอื่น (MANUAL/EXCEL/PORTAL/ERP:{c}) → 409 `external_id_conflict` (กติกาเดียวกับ PUT — ไม่ทับใบของต้นทางอื่น)
   * แก้ใบช่องทางอื่นใช้ `PATCH /orders/{id}` หรือ `ext:{externalId}`
   */
  async assertExternalSource(externalId: string): Promise<void> {
    const o = await this.getByExternalId(externalId);
    if (o.source !== 'API' || o.sourceConnector)
      throw new ProblemException('external_id_conflict', undefined, undefined, {
        existingSource: o.source,
        existingConnector: o.sourceConnector || null,
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

  /** POST /orders/{id}/stops/{seq}/map-site — คนเลือกสถานที่ + เรียนรู้ alias (ST3-T06) */
  mapStopSite(id: string, sequence: number, siteId: string, expectedVersion?: number | '*') {
    return this.intake.mapStopSite(id, sequence, publicIdOr422(siteId, 'site', 'siteId'), {
      expectedVersion,
    });
  }

  /** POST /orders/{id}/reevaluate — หน้าใบค้าง "ตรวจอีกครั้ง" (ST3-T07) */
  recheck(id: string, expectedVersion?: number | '*') {
    return this.intake.recheck(id, { expectedVersion });
  }

  /** POST /orders/{id}/manual-price — กำหนดราคาเอง (ORD-043; ST3-T07) */
  setManualPrice(id: string, amount: string, reason: string, expectedVersion?: number | '*') {
    return this.intake.setManualPrice(id, amount, reason, { expectedVersion });
  }

  /** POST /orders/{id}/resolve-source-error — ยืนยันข้อมูลใบที่ต้นทางแจ้งว่าไม่ครบ (ST3-T07) */
  resolveSourceError(id: string, reason: string, expectedVersion?: number | '*') {
    return this.intake.resolveSourceError(id, reason, { expectedVersion });
  }

  /** POST /orders/{id}/map-customer — คนเลือกลูกค้า + เรียนรู้ alias รหัส/ชื่อตามต้นทาง (ST3-T06) */
  mapCustomer(
    id: string,
    body: { customerId: string; confirmReassign?: boolean; reason?: string },
    expectedVersion?: number | '*',
  ) {
    return this.intake.mapCustomer(id, publicIdOr422(body.customerId, 'customer', 'customerId'), {
      expectedVersion,
      confirmReassign: body.confirmReassign === true,
      reason: body.reason ?? null,
    });
  }
}

function publicIdOr422(v: string, kind: IdKind, field: string): string {
  const id = tryDecodeId(kind, v);
  if (!id)
    throw new ProblemException('validation_failed', undefined, [
      { field, code: 'invalid_id', message: `must be a ${kind} id` },
    ]);
  return id;
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
