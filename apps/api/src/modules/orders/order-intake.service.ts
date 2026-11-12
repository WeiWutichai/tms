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
  SO_FIELD_GROUPS,
  SO_TRANSITIONS,
  evaluateIntakeHolds,
  formatOrderSource,
  soEditableFields,
  intakeHoldNoteTh,
  isIntakeHoldCode,
  isIntakeEditable,
  planIntake,
  transition,
  type IntakeHold,
  type OrderSource,
  type PricingStatus,
  type SoEvent,
  type SoFieldGroup,
  type SoStatus,
} from '@tms/domain';
import { AuditService, diff } from '../../audit/audit.service';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { DeliveryOrderService } from '../delivery-orders/delivery-order.service';
import { StateService } from '../../state/state.service';
import { lockKey, lockReferenced, stableStringify, type RefTable } from '../master/master-kit';
import { PricingService, type Quote } from '../pricing/pricing.service';
import { resolveDocumentEntity } from '../routing/document-routing';
import { issueNumber } from '../sequences/sequences.service';
import {
  canonDecimal,
  normalizeOrderInput,
  type NormalizedOrder,
  type UpsertOrderInput,
} from './order-input';
import { orderEventView } from './order-view';
import {
  OrderMatchingService,
  suggestionsJson,
  type AliasLearnResult,
} from './order-matching.service';

export type { UpsertOrderInput } from './order-input';

interface ActiveRefs {
  customer: boolean;
  sites: Set<string>;
  vehicleType: boolean;
}

export type OrderRecord = SalesOrder & {
  stops: SalesOrderStop[];
  lines: SalesOrderLine[];
  charges: SalesOrderCharge[];
  holdReasonCode: { id: string; code: string } | null;
};

interface OrderChildren {
  stops: {
    type: SalesOrderStop['type'];
    siteId: string | null;
    siteText: string;
    windowStart: Date | null;
    windowEnd: Date | null;
    /** ผลจับคู่ (ST3-T06) — ต้นทางระบุ siteId = null · ข้อความ/สถานที่เดิมของจุดเดิม = คงผลเดิม · ยังไม่ได้ = null (evaluate จับคู่) */
    matchMethod: string | null;
    matchScore: string | null;
    matchCandidates: Prisma.InputJsonValue | typeof Prisma.DbNull;
  }[];
  lines: {
    itemCode: string | null;
    productId: string | null;
    description: string;
    qtyOrdered: string;
    unitId: string | null;
    unit: string;
    weightKg: string | null;
    cbm: string | null;
    isDangerous: boolean;
    tempMin: string | null;
    tempMax: string | null;
  }[];
}

export interface UpsertOrderResult {
  order: OrderRecord;
  /** สร้างใบใหม่ (false = ใบเดิมที่ id/externalId เดียวกัน) */
  created: boolean;
  /** มีอะไรเปลี่ยน (ข้อมูล ราคา หรือสถานะ) — false = ส่งซ้ำค่าเดิมและผลประเมินเท่าเดิม (ไม่เพิ่ม version/ไม่ลง audit) */
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

/** event สาธารณะของแต่ละ transition (docs/01 §5.3) — ส่ง (พ้นร่าง) = order.created (ร่างไม่ส่ง event) */
const EVENT_TYPE: Partial<Record<SoEvent, string>> = {
  submit: 'order.created',
  hold: 'order.held',
  release: 'order.released',
  cancel: 'order.cancelled',
};

/** สถานะต้นทางของแถวประวัติแรก ([*] ใน docs/01 §4.1) */
const CREATE_FROM = 'NONE';

/**
 * **ทางเดียว** ที่เขียน order เข้าระบบ (ST3-T01; docs/04 C "order ทุกใบเข้าทางเดียวกันผ่าน domain service เดียว")
 * ผู้เรียก: ฟอร์มกรอกมือ (ST3-T02), Open API `POST /orders` + `PUT /orders/external/{id}` (T03), Excel (T04),
 * connector `pullOrders` (T05), หน้าใบค้าง (T07 → `reevaluate`) — ห้ามเขียนตาราง sales_order* ที่อื่น
 * (test `order-intake` ตรวจ call path; T02–T05 ต้องมี test ยืนยันว่าเรียก `upsertOrder`)
 *
 * - หาใบเดิม: `id` (แก้ใบกรอกมือ/ร่าง) หรือ `externalId` — **unique ต่อ tenant** (docs/01 §3.3, plan/00a "รหัสภายนอก");
 *   externalId เดิมจากช่องทาง/connector อื่น → 409 `external_id_conflict` (ไม่ทับใบของต้นทางอื่น)
 * - ล็อกก่อนเสมอ (advisory lock ต่อ externalId → `FOR UPDATE` แถว) แล้วอ่านใหม่ แล้วจึงเทียบ hash/สถานะ
 * - ส่งซ้ำค่าเดิม (hash ของข้อมูลที่ normalize แล้ว — ไม่รวม rawPayload) = ไม่เขียนข้อมูลซ้ำ แต่ยังคิดราคา + ประเมินใบค้างใหม่
 *   (เช่น เพิ่ง อนุมัติ rate → ปล่อย RATE_MISSING)
 * - ตรวจรูปแบบด้วยกฎชุดเดียว (`normalizeOrderInput`) — รูปแบบผิด/อ้าง id ที่ไม่มีหรือปิดใช้ → 422
 * - ข้อมูลไม่ครบ/จับคู่ไม่ได้ **ไม่ปฏิเสธ**: order เข้าระบบเสมอแล้วเป็น ON_HOLD + reason code (`evaluateIntakeHolds`)
 * - คิดราคาด้วย `PricingService.quote` (ขาขาย) → `pricing_status` + บรรทัดราคาระบบ (RATE_CARD) snapshot ใน
 *   `sales_order_charge` (MD-117 พารามิเตอร์ใน `pricing_detail.params`, vat_type/wht_rate(%) ต่อบรรทัด) — ไม่คิด VAT/WHT ที่นี่
 *   บรรทัดที่คนกำหนด (MANUAL, ORD-043 — ST3-T02) ไม่ถูกลบตอนคิดใหม่ และ `price_total` = ทุกบรรทัด
 * - เลข SO จาก document_series `SO` ตอนพ้นร่าง · transition ผ่าน StateService (กันชนด้วย where status = from)
 * - `tx` = transaction ที่ตั้ง tenant แล้ว (ค่าเริ่มต้น = ของ request) — นอก HTTP (worker) ต้องมี requestContext ด้วย
 */
@Injectable()
export class OrderIntakeService {
  constructor(
    private readonly db: DbService,
    private readonly pricing: PricingService,
    private readonly state: StateService,
    private readonly audit: AuditService,
    private readonly deliveryOrders: DeliveryOrderService,
    private readonly matching: OrderMatchingService,
  ) {}

  async upsertOrder(input: UpsertOrderInput, tx: Tx = this.db.tx): Promise<UpsertOrderResult> {
    const tenantId = this.tenantId();
    const n = normalizeOrderInput(input);

    // 1) หาใบเดิม + ล็อกก่อน แล้วอ่านใหม่ภายใต้ล็อก
    let current: OrderRecord | null = null;
    if (n.id) {
      current = await this.lockAndLoad(tx, n.id);
      if (!current) throw new ProblemException('not_found');
      if (n.externalId !== null && n.externalId !== current.externalId)
        throw field422('externalId', 'external_id_locked', 'externalId of an order cannot change');
      // ช่องทาง/externalId เป็นของใบเดิม (คนแก้ใบที่มาจาก API ก็ยังเป็นใบจาก API)
      n.source = current.source;
      n.connector = current.sourceConnector;
      n.externalId = current.externalId;
    } else if (n.externalId !== null) {
      await lockKey(tx, `${ENTITY}.ext:${n.externalId}`);
      const hit = await tx.salesOrder.findUnique({
        where: { tenantId_externalId: { tenantId, externalId: n.externalId } },
        select: { id: true },
      });
      if (hit) {
        current = (await this.lockAndLoad(tx, hit.id))!;
        if (current.source !== n.source || current.sourceConnector !== n.connector)
          throw new ProblemException('external_id_conflict', undefined, undefined, {
            existingSource: current.source,
            existingConnector: current.sourceConnector || null,
          });
      }
    }

    // If-Match (RFC 9110): `*` = ต้องมีใบอยู่แล้ว · version = ต้องตรง · ใบยังไม่มีแต่ส่ง If-Match → 412
    const ev = input.expectedVersion;
    if (ev !== undefined && (!current || (ev !== '*' && ev !== current.version)))
      throw new ProblemException('precondition_failed');

    const inputHash = hashInput(n);
    if (current && current.inputHash === inputHash)
      // ส่งซ้ำค่าเดิม: ไม่เขียนข้อมูล แต่ราคา/ใบค้างประเมินใหม่ได้ (ข้อมูลหลักอาจเปลี่ยน)
      return this.evaluate(tx, current, { draft: n.draft, created: false, dataChanged: false });
    // ช่องที่แก้ได้ตามสถานะ (ST3-T03; docs/04 C + spec/03 ORD-032) — ไม่มีเลย (ปิด/ยกเลิก) → 409
    let editable: readonly SoFieldGroup[] = SO_FIELD_GROUPS;
    if (current) {
      editable = soEditableFields(
        current.status as SoStatus,
        await this.deliveryOrders.hasDoOnTrip(tx, current.id),
      );
      if (!editable.length)
        throw new ProblemException('order_locked_for_update', undefined, undefined, {
          // ไม่ใช้ชื่อ `status` (ชนกับ HTTP status ของ RFC 9457)
          orderStatus: current.status,
          editableFields: [],
        });
      if (n.draft && current.status !== 'DRAFT')
        throw new ProblemException('invalid_state_transition', undefined, undefined, {
          from: current.status,
          event: 'save_draft',
        });
    }

    // 2) อ้างอิง (ล็อก FOR SHARE + ตรวจใช้งานอยู่ + สถานที่ของลูกค้านี้/ของบริษัท) → นิติบุคคลออกบิล
    // ใบเดิม: ตรวจเฉพาะอ้างอิงที่เปลี่ยน (ของเดิมที่ถูกปิดใช้ภายหลังไม่ขวางการแก้ช่องอื่น เช่น เลข PO)
    const { customer, matchMethod: customerMatchMethod } = await this.resolveReferences(
      tx,
      n,
      current,
    );
    // นิติบุคคลออกบิล: ไม่ส่ง/ส่งค่าเดิม = คงของเดิม (ไม่หาใหม่จาก routing) · ใบใหม่/เปลี่ยน = routing ST1-T16
    const keepCompany =
      current !== null &&
      (n.billingCompanyId === null || n.billingCompanyId === current.billingCompanyId);
    const billingCompanyId = keepCompany
      ? current!.billingCompanyId
      : (
          await resolveDocumentEntity(tx, tenantId, {
            kind: 'invoice',
            companyId: n.billingCompanyId,
            partyCompanyId: customer?.defaultBillingCompanyId ?? null,
          })
        ).company.id;
    const header = {
      customerId: customer?.id ?? null,
      customerExternalId: n.customer.externalId,
      customerText: n.customer.text,
      customerMatchMethod,
      billingCompanyId,
      customerRef: n.customerRef,
      requestedDate: new Date(`${n.requestedDate}T00:00:00Z`),
      vehicleTypeId: n.vehicleTypeId,
      sourceIssues: n.sourceIssues,
      inputHash,
      rawPayload:
        n.rawPayload === null
          ? Prisma.DbNull
          : (JSON.parse(JSON.stringify(n.rawPayload)) as Prisma.InputJsonValue),
    };
    const children = await this.effectiveChildren(tx, n, current);

    if (current) {
      // เทียบค่าที่จะเก็บจริงกับของเดิม (ไม่ใช่รูป input) — รูปต่างแต่ค่าเท่าเดิม = ไม่มีอะไรเปลี่ยน
      const changes = orderChanges(current, header, children);
      if (!changes.length)
        return this.evaluate(tx, current, { draft: n.draft, created: false, dataChanged: false });
      const locked = changes.filter((c) => !editable.includes(c.group));
      if (locked.length)
        // ต้นทาง (ERP) แก้หลังวางแผน → ST3-T10 จะเปลี่ยนเป็นใบค้าง SOURCE_CHANGED_AFTER_PLAN + diff (ไม่ทับ) — ตอนนี้ 409
        throw new ProblemException(
          'order_locked_for_update',
          undefined,
          locked.map((c) => ({
            field: c.field,
            code: 'locked',
            message: `cannot change ${c.group} when order is ${current.status}`,
          })),
          { orderStatus: current.status, editableFields: editable },
        );
      if (editable.length < SO_FIELD_GROUPS.length)
        return this.applyRestricted(tx, current, header, children);
    }

    // 3) เขียนข้อมูล
    let id: string;
    const before = current ? orderEventView(current, { lines: true }) : null;
    if (!current) {
      const initial: SoStatus = n.draft ? 'DRAFT' : 'RECEIVED';
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
      await this.history(tx, id, CREATE_FROM, initial, 'create');
    } else {
      id = current.id;
      await tx.salesOrder.update({ where: { id }, data: { ...header, version: { increment: 1 } } });
    }
    // สินค้าลดลง: DO ที่อ้างบรรทัดที่จะลบต้องยกเลิก/ปลดก่อน (FK RESTRICT บรรทัด DO → บรรทัด SO) — สร้างใหม่ตอน sync
    const releasedDos = current
      ? await this.deliveryOrders.releaseOrderLines(
          tx,
          id,
          current.lines.filter((l) => l.lineNo > children.lines.length).map((l) => l.id),
        )
      : [];
    await this.writeChildren(tx, tenantId, id, children);
    const loaded = await tx.salesOrder.findUniqueOrThrow({ where: { id }, include: INCLUDE });
    return this.evaluate(tx, loaded, {
      draft: n.draft,
      created: !current,
      dataChanged: true,
      releasedDos,
      before,
    });
  }

  /**
   * ประเมินราคา + ใบค้างใหม่จากข้อมูลที่เก็บอยู่ (ไม่เปลี่ยนข้อมูลงาน) — หน้าใบค้าง (ST3-T07) เรียกหลังเคลียร์เหตุ
   * (map ลูกค้า/สถานที่, เพิ่ม rate) · ใบที่พ้นช่วงรับงาน (วางแผนแล้ว ฯลฯ) → ไม่ทำอะไร
   */
  async reevaluate(orderId: string, tx: Tx = this.db.tx): Promise<UpsertOrderResult> {
    const current = await this.lockAndLoad(tx, orderId);
    if (!current) throw new ProblemException('not_found');
    return this.evaluate(tx, current, {
      draft: current.status === 'DRAFT',
      created: false,
      dataChanged: false,
    });
  }

  /**
   * คนเลือกสถานที่ให้จุดที่ยังจับคู่ไม่ได้ (ST3-T06 "เรียนรู้ alias"; หน้าใบค้าง T07 เรียก) — `POST /orders/{id}/stops/{seq}/map-site`
   * สถานที่ต้องใช้งานอยู่และเป็นของลูกค้าของใบหรือของบริษัท (ใบยังไม่มีลูกค้า = เฉพาะของบริษัท — จับคู่ลูกค้าก่อน)
   * → จุดได้สถานที่ (MANUAL) + จำข้อความเป็น alias ของสถานที่ (order ถัดไปข้อความเดิมจับคู่เอง) → ประเมินราคา/ใบค้างใหม่
   * ใช้ได้เมื่อแก้จุดได้ตามสถานะ (ก่อนวางแผน) — ไม่งั้น 409 `order_locked_for_update`
   */
  async mapStopSite(
    orderId: string,
    sequence: number,
    siteId: string,
    opts: { expectedVersion?: number | '*' } = {},
    tx: Tx = this.db.tx,
  ): Promise<UpsertOrderResult & { aliasLearning: AliasLearnResult }> {
    const current = await this.lockForMapping(tx, orderId, opts.expectedVersion, 'stops');
    const stop = current.stops.find((s) => s.sequence === sequence);
    if (!stop) throw new ProblemException('not_found');
    // FOR UPDATE ตั้งแต่แรก (ไม่ใช่ FOR SHARE แล้วค่อยยก) — การเรียนรู้ alias เขียนแถวนี้; สองคำขอถือ SHARE แล้วยกพร้อมกัน = deadlock
    const [ref] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM customer_site
       WHERE id = ${siteId}::uuid AND deleted_at IS NULL FOR UPDATE`;
    if (!ref) throw field422('siteId', 'reference_not_found', 'site not found');
    if (ref.status !== 'ACTIVE') throw field422('siteId', 'reference_inactive', 'site is inactive');
    const site = await tx.customerSite.findUniqueOrThrow({
      where: { id: siteId },
      select: { customerId: true },
    });
    if (site.customerId && site.customerId !== current.customerId)
      throw field422(
        'siteId',
        current.customerId ? 'site_other_customer' : 'customer_unmapped',
        current.customerId
          ? 'site belongs to another customer'
          : 'map the customer before choosing a customer site',
      );
    const changed = stop.siteId !== siteId || stop.matchMethod !== 'MANUAL';
    if (changed) {
      await tx.salesOrderStop.update({
        where: { id: stop.id },
        data: {
          siteId,
          matchMethod: 'MANUAL',
          matchScore: null,
          matchCandidates: Prisma.DbNull,
        },
      });
      await tx.salesOrder.update({ where: { id: orderId }, data: { version: { increment: 1 } } });
    }
    const scope = await this.matching.siteScope(tx, current.customerId);
    const aliasLearning = await this.matching.learnSiteAlias(tx, siteId, stop.siteText, scope);
    const loaded = (await tx.salesOrder.findUnique({ where: { id: orderId }, include: INCLUDE }))!;
    const r = await this.evaluate(tx, loaded, {
      draft: current.status === 'DRAFT',
      created: false,
      dataChanged: changed,
      before: orderEventView(current, { lines: true }),
    });
    return { ...r, aliasLearning };
  }

  /**
   * คนเลือกลูกค้าให้ใบที่ยังจับคู่ไม่ได้ (ST3-T06; docs/01 §4.1 CUSTOMER_UNMAPPED "map ลูกค้า") — `POST /orders/{id}/map-customer`
   * จำรหัสต้นทาง (ต่อช่องทาง) หรือชื่อตามต้นทางเป็น alias ของลูกค้า → order ถัดไปจับคู่เอง · นิติบุคคลออกบิลตามค่าตั้งต้นของลูกค้า
   * จุดที่เลือกสถานที่ของลูกค้าอื่นไว้ → 422 · หลังได้ลูกค้า จุดที่ยังว่างจับคู่ในขอบเขตลูกค้านั้นต่อทันที (evaluate)
   */
  async mapCustomer(
    orderId: string,
    customerId: string,
    opts: { expectedVersion?: number | '*' } = {},
    tx: Tx = this.db.tx,
  ): Promise<UpsertOrderResult & { aliasLearning: AliasLearnResult }> {
    const current = await this.lockForMapping(tx, orderId, opts.expectedVersion, 'customer');
    const [ref] = await lockReferenced(tx, 'customer', [customerId]);
    if (!ref) throw field422('customerId', 'reference_not_found', 'customer not found');
    if (ref.status !== 'ACTIVE')
      throw field422('customerId', 'reference_inactive', 'customer is inactive');
    const siteIds = current.stops.flatMap((s) => (s.siteId ? [s.siteId] : []));
    if (siteIds.length) {
      const owners = await tx.customerSite.findMany({
        where: { id: { in: siteIds }, customerId: { not: null } },
        select: { id: true, customerId: true },
      });
      const bad = current.stops.findIndex((s) =>
        owners.some((o) => o.id === s.siteId && o.customerId !== customerId),
      );
      if (bad >= 0)
        throw field422(
          `stops[${bad}].siteId`,
          'site_other_customer',
          'site belongs to another customer',
        );
    }
    const changed = current.customerId !== customerId || current.customerMatchMethod !== 'MANUAL';
    if (changed)
      await tx.salesOrder.update({
        where: { id: orderId },
        data: {
          customerId,
          customerMatchMethod: 'MANUAL',
          customerCandidates: Prisma.DbNull,
          billingCompanyId: await this.billingFor(tx, customerId, current.billingCompanyId),
          version: { increment: 1 },
        },
      });
    const aliasLearning = await this.matching.learnCustomerAlias(tx, {
      customerId,
      externalId: current.customerExternalId,
      text: current.customerText,
      source: formatOrderSource({
        source: current.source as OrderSource,
        connector: current.sourceConnector,
      }),
    });
    const loaded = (await tx.salesOrder.findUnique({ where: { id: orderId }, include: INCLUDE }))!;
    const r = await this.evaluate(tx, loaded, {
      draft: current.status === 'DRAFT',
      created: false,
      dataChanged: changed,
      before: orderEventView(current, { lines: true }),
    });
    return { ...r, aliasLearning };
  }

  // ---------------------------------------------------------------------------------------------

  /** ล็อกใบ + If-Match + ช่องที่แก้ได้ตามสถานะ (ชุดเดียวกับ upsert) สำหรับการจับคู่ด้วยมือ */
  private async lockForMapping(
    tx: Tx,
    orderId: string,
    expectedVersion: number | '*' | undefined,
    group: SoFieldGroup,
  ): Promise<OrderRecord> {
    const current = await this.lockAndLoad(tx, orderId);
    if (!current) throw new ProblemException('not_found');
    if (
      expectedVersion !== undefined &&
      expectedVersion !== '*' &&
      expectedVersion !== current.version
    )
      throw new ProblemException('precondition_failed');
    const editable = soEditableFields(
      current.status as SoStatus,
      await this.deliveryOrders.hasDoOnTrip(tx, current.id),
    );
    if (!editable.includes(group) || !isIntakeEditable(current.status as SoStatus))
      throw new ProblemException(
        'order_locked_for_update',
        undefined,
        [
          {
            field: group,
            code: 'locked',
            message: `cannot change ${group} when order is ${current.status}`,
          },
        ],
        { orderStatus: current.status, editableFields: editable },
      );
    return current;
  }

  /** นิติบุคคลออกบิลเมื่อเพิ่งได้ลูกค้า: ลูกค้ามีค่าตั้งต้น → routing ด้วยค่านั้น (ST1-T16) · ไม่มี = คงของเดิม */
  private async billingFor(tx: Tx, customerId: string, current: string): Promise<string> {
    const c = await tx.customer.findUnique({
      where: { id: customerId },
      select: { defaultBillingCompanyId: true },
    });
    if (!c?.defaultBillingCompanyId || c.defaultBillingCompanyId === current) return current;
    return (
      await resolveDocumentEntity(tx, this.tenantId(), {
        kind: 'invoice',
        companyId: null,
        partyCompanyId: c.defaultBillingCompanyId,
      })
    ).company.id;
  }

  /**
   * จับคู่อัตโนมัติจากข้อมูลที่เก็บ (ST3-T06) — ลูกค้าที่ยังว่าง (externalId/alias) แล้วจุดที่ยังว่าง (ขอบเขตลูกค้า + บริษัท)
   * ได้ = เขียน id + วิธี/คะแนน · ไม่ได้ = เก็บรายการแนะนำ (เขียนเฉพาะเมื่อเปลี่ยน) · `changed` = ได้ลูกค้า/สถานที่เพิ่ม
   * ลูกค้าที่ขัดกับสถานที่ที่ต้นทางระบุไว้ (สถานที่ของลูกค้าอื่น) → ไม่จับคู่ลูกค้าเอง (ให้คนตัดสิน)
   */
  private async autoMatch(
    tx: Tx,
    order: OrderRecord,
  ): Promise<{ order: OrderRecord; changed: boolean }> {
    let changed = false;
    let wrote = false;
    let customerId = order.customerId;
    const same = (a: unknown, b: unknown) =>
      stableStringify(a ?? null) === stableStringify(b ?? null);
    if (!customerId && (order.customerExternalId || order.customerText)) {
      const m = await this.matching.matchCustomer(tx, {
        externalId: order.customerExternalId,
        text: order.customerText,
        source: formatOrderSource({
          source: order.source as OrderSource,
          connector: order.sourceConnector,
        }),
      });
      const siteIds = order.stops.flatMap((s) => (s.siteId ? [s.siteId] : []));
      const conflict =
        m.customerId && siteIds.length
          ? await tx.customerSite.count({
              where: { id: { in: siteIds }, customerId: { notIn: [m.customerId] } },
            })
          : 0;
      if (m.customerId && !conflict) {
        customerId = m.customerId;
        await tx.salesOrder.update({
          where: { id: order.id },
          data: {
            customerId,
            customerMatchMethod: m.method,
            customerCandidates: Prisma.DbNull,
            billingCompanyId: await this.billingFor(tx, customerId, order.billingCompanyId),
          },
        });
        changed = wrote = true;
      } else if (!same(order.customerCandidates, m.candidates.length ? m.candidates : null)) {
        await tx.salesOrder.update({
          where: { id: order.id },
          data: { customerCandidates: suggestionsJson(m.candidates) },
        });
        wrote = true;
      }
    } else if (customerId && order.customerCandidates !== null) {
      await tx.salesOrder.update({
        where: { id: order.id },
        data: { customerCandidates: Prisma.DbNull },
      });
      wrote = true;
    }

    const pending = order.stops.filter((s) => !s.siteId && s.siteText);
    if (pending.length) {
      const scope = await this.matching.siteScope(tx, customerId);
      for (const s of pending) {
        const m = this.matching.matchSite(s.siteText, scope);
        if (m.siteId) {
          await tx.salesOrderStop.update({
            where: { id: s.id },
            data: {
              siteId: m.siteId,
              matchMethod: m.method,
              matchScore: m.score!.toFixed(3),
              matchCandidates: Prisma.DbNull,
            },
          });
          changed = wrote = true;
        } else if (
          !same(s.matchCandidates, m.candidates.length ? m.candidates : null) ||
          s.matchMethod !== null
        ) {
          await tx.salesOrderStop.update({
            where: { id: s.id },
            data: {
              matchMethod: null,
              matchScore: null,
              matchCandidates: suggestionsJson(m.candidates),
            },
          });
          wrote = true;
        }
      }
    }
    if (!wrote) return { order, changed };
    const reloaded = await tx.salesOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: INCLUDE,
    });
    return { order: reloaded, changed };
  }

  private tenantId(): string {
    const t = requestContext.require().tenantId;
    if (!t) throw new Error('order intake: tenant missing in request context');
    return t;
  }

  private async lockAndLoad(tx: Tx, id: string): Promise<OrderRecord | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM sales_order WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) return null;
    return tx.salesOrder.findUnique({ where: { id }, include: INCLUDE });
  }

  private async evaluate(
    tx: Tx,
    loadedOrder: OrderRecord,
    opts: {
      draft: boolean;
      created: boolean;
      dataChanged: boolean;
      before?: Record<string, unknown> | null;
      /** DO ที่ถูกยกเลิกก่อนลบบรรทัด SO ในคำขอนี้ (ส่งต่อให้ sync แจ้ง rebuild_required) */
      releasedDos?: string[];
    },
  ): Promise<UpsertOrderResult> {
    const ctx = requestContext.require();
    const tenantId = ctx.tenantId!;
    const id = loadedOrder.id;
    const storedHolds = (loadedOrder.pricingDetail as { holds?: IntakeHold[] } | null)?.holds ?? [];
    if (!isIntakeEditable(loadedOrder.status as SoStatus))
      return { order: loadedOrder, created: false, changed: false, holds: storedHolds };

    // จับคู่อัตโนมัติ (ST3-T06) ก่อนคิดราคา/ใบค้าง — ทุกทาง (ใบใหม่ / ส่งซ้ำ / reevaluate หลังเรียนรู้ alias)
    const matched = await this.autoMatch(tx, loadedOrder);
    const order = matched.order;
    if (matched.changed && !opts.dataChanged && !opts.created)
      await tx.salesOrder.update({ where: { id }, data: { version: { increment: 1 } } });
    const dataChanged = opts.dataChanged || matched.changed;

    // ราคา: บรรทัดระบบ (RATE_CARD) คิดใหม่ — เขียนใหม่เฉพาะเมื่อผลต่าง; บรรทัด MANUAL คงไว้
    const act = await this.activeRefs(tx, order);
    const quote = await this.quote(tx, order, act);
    const manual = order.charges.filter((c) => c.origin !== 'RATE_CARD');
    const system = order.charges.filter((c) => c.origin === 'RATE_CARD');
    const want = quote.pricingStatus === 'AVAILABLE' ? quote.lines : [];
    const chargeKey = (x: {
      kind: string;
      serviceItemId: string;
      serviceItemVersion: number;
      qtyExact: string;
      unitPrice: string;
      amount: string;
      vatType: string;
      whtRate: string;
      rateCardId: string | null;
    }) => stableStringify(x);
    const haveKeys = system.map((c) =>
      chargeKey({
        kind: c.kind,
        serviceItemId: c.serviceItemId,
        serviceItemVersion: c.serviceItemVersion,
        qtyExact: c.qtyExact,
        unitPrice: c.unitPrice.toFixed(2),
        amount: c.amount.toFixed(2),
        vatType: c.vatType,
        whtRate: c.whtRate.toFixed(2),
        rateCardId: c.rateCardId,
      }),
    );
    const wantRows = want.map((l) => ({
      kind: l.kind,
      serviceItemId: l.serviceItem.sourceItemId,
      serviceItemVersion: l.serviceItem.sourceVersion,
      qtyExact: l.qtyExact,
      unitPrice: l.unitPrice,
      amount: l.amount,
      vatType: l.vatType,
      whtRate: l.whtRate,
      rateCardId: l.kind === 'ACCESSORIAL' ? null : quote.params.rateCardId,
      line: l,
    }));
    const chargesChanged =
      stableStringify(haveKeys) !==
      stableStringify(wantRows.map(({ line: _l, ...k }) => chargeKey(k)));
    if (chargesChanged) {
      await tx.salesOrderCharge.deleteMany({ where: { salesOrderId: id, origin: 'RATE_CARD' } });
      const base = manual.reduce((m, c) => Math.max(m, c.lineNo), 0);
      if (wantRows.length)
        await tx.salesOrderCharge.createMany({
          data: wantRows.map(({ line: l, rateCardId }, i) => ({
            tenantId,
            salesOrderId: id,
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
            rateCardId,
            rateCardCode: rateCardId ? quote.params.rateCode : null,
            rateCardRevision: rateCardId ? quote.params.rateRevision : null,
          })),
        });
    }
    // ยอดรวมก่อน VAT = บรรทัดระบบ + บรรทัดที่คนกำหนด (null = ไม่มีบรรทัดราคาเลย)
    const amounts = [...want.map((l) => l.amount), ...manual.map((c) => c.amount.toFixed(2))];
    const priceTotal = amounts.length
      ? amounts.reduce((s, a) => s.add(new Prisma.Decimal(a)), new Prisma.Decimal(0)).toFixed(2)
      : null;
    const manualFreight = manual.some((c) => c.kind === 'FREIGHT');

    const sourceIssues = (order.sourceIssues as string[] | null) ?? [];
    const holds = evaluateIntakeHolds({
      sourceIssues,
      customerMapped: act.customer,
      stops: order.stops.map((s) => ({
        type: s.type,
        mapped: s.siteId !== null && act.sites.has(s.siteId),
      })),
      pricingStatus: quote.pricingStatus,
      manualFreight,
    });
    const pricingDetail = {
      params: quote.params,
      reasons: quote.reasons,
      warnings: quote.warnings,
      routeId: quote.routeId,
      holds,
    };
    const pricingChanged =
      chargesChanged ||
      order.pricingStatus !== quote.pricingStatus ||
      (order.priceTotal?.toFixed(2) ?? null) !== priceTotal ||
      stableStringify(order.pricingDetail) !==
        stableStringify(JSON.parse(JSON.stringify(pricingDetail)));
    if (pricingChanged)
      await tx.salesOrder.update({
        where: { id },
        data: {
          pricingStatus: quote.pricingStatus as PricingStatus,
          pricingDetail: JSON.parse(JSON.stringify(pricingDetail)) as Prisma.InputJsonValue,
          priceTotal,
          pricedAt: new Date(),
          ...(dataChanged || opts.created ? {} : { version: { increment: 1 } }),
        },
      });

    // สถานะ: planIntake → เดินตามตาราง SO_TRANSITIONS
    const plan = planIntake({
      current: order.status as SoStatus,
      currentHoldCode: order.holdReasonCode?.code ?? null,
      draft: opts.draft,
      holds,
    });
    const holdId = plan.holdCode ? await this.holdReasonId(tx, plan.holdCode) : null;
    const holdNote = holds[0]
      ? intakeHoldNoteTh(holds[0], {
          customerRef: order.customerExternalId ?? order.customerText,
          customerInactive: !!order.customerId && !act.customer,
          stopInactive: order.stops.map((s) => s.siteId !== null && !act.sites.has(s.siteId)),
          stopTexts: order.stops.map((s) => s.siteText),
          sourceIssues,
        })
      : null;
    if (opts.created && order.status === 'RECEIVED')
      await this.emit(tx, 'order.created', id, orderEventView(order), {});
    let status = order.status as SoStatus;
    for (const event of plan.events) {
      const from = status;
      const to = transition(ENTITY, SO_TRANSITIONS, from, event);
      const soNo =
        from === 'DRAFT' && !order.soNo ? await issueNumber(tx, tenantId, { docType: 'SO' }) : null;
      await this.state.transition<SoStatus, SoEvent>(tx, {
        docType: ENTITY,
        docId: id,
        table: SO_TRANSITIONS,
        from,
        event,
        reasonCodeId: event === 'hold' ? holdId : null,
        note: event === 'hold' ? holdNote : null,
        eventType: EVENT_TYPE[event] ?? 'order.updated',
        apply: async (next) => {
          // กันชน: เปลี่ยนเฉพาะเมื่อสถานะยังเป็น from (ล็อกแถวแล้ว — ด่านสุดท้ายกันโค้ดอื่นที่ไม่ได้ล็อก)
          const r = await tx.salesOrder.updateMany({
            where: { id, status: from as DbSoStatus },
            data: {
              status: next as DbSoStatus,
              holdReasonCodeId: next === 'ON_HOLD' ? holdId : null,
              holdNote: next === 'ON_HOLD' ? holdNote : null,
              ...(soNo ? { soNo } : {}),
            },
          });
          if (r.count === 0) throw new ProblemException('concurrent_update');
          return orderEventView(
            await tx.salesOrder.findUniqueOrThrow({ where: { id }, include: INCLUDE }),
          );
        },
      });
      status = to;
    }
    let noteChanged = false;
    if (
      status === 'ON_HOLD' &&
      plan.events.length === 0 &&
      isIntakeHoldCode(plan.holdCode) &&
      (plan.holdCodeChanged || order.holdNote !== holdNote)
    ) {
      // ค้างต่อแต่เหตุ/รายละเอียดเปลี่ยน (ไม่ใช่ transition) — เหตุเปลี่ยนลงประวัติด้วย
      noteChanged = true;
      await tx.salesOrder.update({ where: { id }, data: { holdReasonCodeId: holdId, holdNote } });
      if (plan.holdCodeChanged)
        await this.history(tx, id, 'ON_HOLD', 'ON_HOLD', 'hold_reason_changed', holdId, holdNote);
    }
    if ((plan.events.length || noteChanged) && !dataChanged && !pricingChanged && !opts.created)
      await tx.salesOrder.update({ where: { id }, data: { version: { increment: 1 } } });

    // ใบส่งของตาม SO (ST3-T09): 1 DO = ทั้ง SO เมื่อพร้อม · SO แก้ข้อมูลที่ DO ใช้ → สร้างชุดใหม่ (ORD-085)
    await this.deliveryOrders.syncWithOrder(tx, id, opts.releasedDos ?? []);

    const changed =
      opts.created || dataChanged || pricingChanged || plan.events.length > 0 || noteChanged;
    const final = await tx.salesOrder.findUniqueOrThrow({ where: { id }, include: INCLUDE });
    if (opts.created) {
      await this.audit.record({
        action: `${ENTITY}.created`,
        entityType: ENTITY,
        entityId: id,
        after: orderEventView(final, { lines: true }),
      });
    } else if (changed) {
      const before = opts.before ?? orderEventView(loadedOrder, { lines: true });
      const after = orderEventView(final, { lines: true });
      await this.audit.changed(`${ENTITY}.updated`, ENTITY, id, before, after);
      // ร่างไม่ส่ง event (order.created เกิดตอนพ้นร่าง — transition submit)
      if ((dataChanged || pricingChanged) && order.status !== 'DRAFT' && final.status !== 'DRAFT') {
        const evBefore = orderEventView(loadedOrder);
        const evAfter = orderEventView(final);
        await this.emit(tx, 'order.updated', id, evAfter, diff(evBefore, evAfter).before);
      }
    }
    return { order: final, created: opts.created, changed, holds };
  }

  /**
   * ลูกค้า + ตรวจอ้างอิงทั้งหมด → ลูกค้าที่จับคู่ได้ (null = CUSTOMER_UNMAPPED)
   * ใบเดิม (`current`): อ้างอิงที่มีอยู่ในใบแล้ว (หน่วย/สินค้า/สถานที่/ประเภทรถเดิม) ไม่ตรวจซ้ำ — ถูกปิดใช้/ลบภายหลังก็แก้ช่องอื่นได้
   */
  private async resolveReferences(tx: Tx, n: NormalizedOrder, current: OrderRecord | null = null) {
    // ลูกค้า: id ตรง → ต้องมีอยู่ (422) · ปิดใช้ = order ยังเข้าระบบแต่ค้าง CUSTOMER_UNMAPPED และไม่ใช้ rate ของลูกค้านั้น
    // (docs/04 C ทุกใบเข้าระบบ > spec/02 MD-003/MD-026 — [OPEN] spec/12 §3) · รหัสต้นทาง → จับคู่ตรงตัวกับลูกค้าที่ใช้งานอยู่
    // (ไม่พบ = CUSTOMER_UNMAPPED; alias/fuzzy = ST3-T06)
    // ST3-T06: ไม่มี id → จับคู่ (externalId ตรง → alias รหัสของช่องทางนี้ → alias ชื่อ) — ไม่พบ = CUSTOMER_UNMAPPED
    let customerId = n.customer.id;
    let matchMethod: string | null = null;
    if (customerId) {
      const [row] = await lockReferenced(tx, 'customer', [customerId]);
      if (!row) throw field422('customer.id', 'reference_not_found', 'customer not found');
      // ลูกค้าเดิมของใบ (เช่น PATCH ส่ง id ที่ได้จากการจับคู่) = คงวิธีเดิม
      matchMethod =
        current?.customerId === customerId ? (current.customerMatchMethod ?? 'INPUT') : 'INPUT';
    } else if (n.customer.externalId || n.customer.text) {
      const m = await this.matching.matchCustomer(tx, {
        externalId: n.customer.externalId,
        text: n.customer.text,
        source: formatOrderSource({ source: n.source, connector: n.connector }),
      });
      customerId = m.customerId;
      matchMethod = m.method;
    }
    const customer = customerId
      ? await tx.customer.findUnique({
          where: { id: customerId },
          select: { id: true, defaultBillingCompanyId: true },
        })
      : null;

    const check = async (
      table: RefTable,
      items: { field: string; id: string | null }[],
      what: string,
      /** ปิดใช้ = ไม่ปฏิเสธ (สถานที่/ประเภทรถ → ใบค้าง/ไม่คิดราคา ตอนประเมิน) */
      allowInactive: boolean,
      /** id ที่ใบเดิมอ้างอยู่แล้ว — ไม่ตรวจ */
      kept: (string | null)[] = [],
    ) => {
      const keep = new Set(kept);
      items = items.filter((x) => !x.id || !keep.has(x.id));
      const ids = items.flatMap((x) => (x.id ? [x.id] : []));
      const found = new Map((await lockReferenced(tx, table, ids)).map((r) => [r.id, r.status]));
      for (const x of items) {
        if (!x.id) continue;
        const st = found.get(x.id);
        if (!st) throw field422(x.field, 'reference_not_found', `${what} not found`);
        if (st !== 'ACTIVE' && !allowInactive)
          throw field422(x.field, 'reference_inactive', `${what} is inactive`);
      }
    };
    const stopRefs = n.stops.map((s, i) => ({ field: `stops[${i}].siteId`, id: s.siteId }));
    await check(
      'customer_site',
      stopRefs,
      'site',
      true,
      (current?.stops ?? []).map((s) => s.siteId),
    );
    // สถานที่ต้องเป็นของลูกค้าของ order หรือของบริษัทเอง (customer_id null) — กติกาเดียวกับ rate card (ST2-T13)
    const siteIds = stopRefs.flatMap((x) => (x.id ? [x.id] : []));
    if (customer && siteIds.length) {
      const owners = await tx.customerSite.findMany({
        where: { id: { in: siteIds } },
        select: { id: true, customerId: true },
      });
      const bad = stopRefs.find((x) => {
        const o = owners.find((y) => y.id === x.id);
        return o?.customerId && o.customerId !== customer.id;
      });
      if (bad) throw field422(bad.field, 'site_other_customer', 'site belongs to another customer');
    }
    await check(
      'vehicle_type',
      [{ field: 'vehicleTypeId', id: n.vehicleTypeId }],
      'vehicle type',
      true,
      [current?.vehicleTypeId ?? null],
    );
    await check(
      'unit',
      n.lines.map((l, i) => ({ field: `lines[${i}].unitId`, id: l.unitId })),
      'unit',
      false,
      (current?.lines ?? []).map((l) => l.unitId),
    );
    await check(
      'product',
      n.lines.map((l, i) => ({ field: `lines[${i}].productId`, id: l.productId })),
      'product',
      false,
      (current?.lines ?? []).map((l) => l.productId),
    );
    return { customer, matchMethod: customer ? matchMethod : null };
  }

  /**
   * ราคาขายจากข้อมูลที่เก็บใน SO — ข้อมูลไม่พอหา rate (ลูกค้า/จุดรับ/จุดส่ง/ประเภทรถ) = RATE_MISSING พร้อมช่องที่ขาด
   * จำนวนจุด = จุดรับ + จุดส่ง (QuoteInput.stops; จุดคืนสินค้า RETURN ไม่นับเป็นจุดเพิ่ม — MD-115 [DECISION spec/12])
   */
  private async quote(tx: Tx, o: OrderRecord, act: ActiveRefs): Promise<Quote> {
    // ต้นทาง = จุดรับแรก, ปลายทาง = จุดส่งสุดท้าย (rate card เฟส 0 เป็นคู่ต้นทาง-ปลายทาง) · ข้อมูลหลักที่ปิดใช้ = ไม่ใช้หา rate
    const live = (id: string | null | undefined) => (id && act.sites.has(id) ? id : null);
    const origin = live(o.stops.find((s) => s.type === 'PICKUP')?.siteId);
    const dest = live([...o.stops].reverse().find((s) => s.type === 'DELIVERY')?.siteId);
    const customerId = act.customer ? o.customerId : null;
    const vehicleTypeId = act.vehicleType ? o.vehicleTypeId : null;
    const stops = o.stops.filter((s) => s.type !== 'RETURN').length;
    const missing = (
      [
        ['customer', customerId],
        ['stops.pickup', origin],
        ['stops.delivery', dest],
        ['vehicleTypeId', vehicleTypeId],
      ] as const
    ).filter(([, v]) => !v);
    if (!customerId || !origin || !dest || !vehicleTypeId)
      return {
        pricingStatus: 'RATE_MISSING',
        total: null,
        lines: [],
        reasons: missing.map(([field]) => ({
          code: 'RATE_MISSING' as const,
          message: `ยังหา rate card ไม่ได้ — ขาดข้อมูลหรือข้อมูลถูกปิดใช้งาน: ${field}`,
          field,
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
          stops,
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
        vehicleTypeId,
        date: o.requestedDate.toISOString().slice(0, 10),
        quantities: o.lines.flatMap((l) =>
          l.unitId
            ? [{ qty: l.qtyOrdered.toFixed(), unitId: l.unitId, productId: l.productId }]
            : [],
        ),
        stops,
      },
      tx,
    );
  }

  /** สถานะใช้งานของข้อมูลหลักที่ SO อ้าง ณ ตอนประเมิน (ปิดใช้/ลบ = ไม่นับว่าจับคู่ได้) */
  private async activeRefs(tx: Tx, o: OrderRecord): Promise<ActiveRefs> {
    const siteIds = o.stops.flatMap((s) => (s.siteId ? [s.siteId] : []));
    const [cust, sites, vt] = await Promise.all([
      o.customerId
        ? tx.customer.count({ where: { id: o.customerId, status: 'ACTIVE', deletedAt: null } })
        : 0,
      siteIds.length
        ? tx.customerSite.findMany({
            where: { id: { in: siteIds }, status: 'ACTIVE', deletedAt: null },
            select: { id: true },
          })
        : [],
      o.vehicleTypeId
        ? tx.vehicleType.count({
            where: { id: o.vehicleTypeId, status: 'ACTIVE', deletedAt: null },
          })
        : 0,
    ]);
    return { customer: cust > 0, sites: new Set(sites.map((x) => x.id)), vehicleType: vt > 0 };
  }

  /**
   * ค่าจุด/สินค้าที่จะเก็บจริง — ข้อความสถานที่: ตามต้นทาง หรือ (เลือกจาก master โดยไม่มีข้อความ) ข้อความเดิมของจุดลำดับเดียวกัน
   * ที่เป็นสถานที่เดียวกัน / ชื่อสถานที่ ณ เวลารับงาน · หน่วย: ข้อความตามต้นทาง หรือรหัสหน่วยใน master
   */
  private async effectiveChildren(
    tx: Tx,
    n: NormalizedOrder,
    current: OrderRecord | null,
  ): Promise<OrderChildren> {
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
    const unitIds = n.lines.flatMap((l) => (l.unitId && !l.unit ? [l.unitId] : []));
    const code = new Map(
      (unitIds.length
        ? await tx.unit.findMany({
            where: { id: { in: unitIds } },
            select: { id: true, code: true },
          })
        : []
      ).map((u) => [u.id, u.code]),
    );
    return {
      stops: n.stops.map((s, i) => {
        const prev = current?.stops[i];
        const keep = !s.siteText && s.siteId && prev?.siteId === s.siteId ? prev.siteText : null;
        const siteText = s.siteText || keep || names.get(s.siteId!) || '';
        // ST3-T06: ข้อความเดิมของจุดเดิมที่จับคู่ไว้แล้ว (อัตโนมัติ/คนเลือก) → คงสถานที่ + ผลจับคู่เดิม
        // (ต้นทางส่งซ้ำแบบไม่มี siteId ไม่ลบผลที่คน map ไว้ และไม่นับเป็นการแก้จุดหลังวางแผน)
        const samePrev =
          !!prev?.siteId &&
          prev.siteText === siteText &&
          prev.type === s.type &&
          (s.siteId === null || s.siteId === prev.siteId);
        return {
          type: s.type,
          siteId: samePrev ? prev.siteId : s.siteId,
          siteText,
          windowStart: s.windowStart ? new Date(s.windowStart) : null,
          windowEnd: s.windowEnd ? new Date(s.windowEnd) : null,
          matchMethod: samePrev ? prev.matchMethod : null,
          matchScore: samePrev ? (prev.matchScore?.toFixed(3) ?? null) : null,
          matchCandidates: Prisma.DbNull,
        };
      }),
      lines: n.lines.map((l) => ({
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
    };
  }

  /** จุด/สินค้า: upsert ตามลำดับ (sequence / line_no) — id ของแถวคงเดิม (DO ST3-T09 อ้างบรรทัดได้); ส่วนเกินลบ */
  private async writeChildren(tx: Tx, tenantId: string, salesOrderId: string, c: OrderChildren) {
    for (const [i, data] of c.stops.entries())
      await tx.salesOrderStop.upsert({
        where: {
          tenantId_salesOrderId_sequence: { tenantId, salesOrderId, sequence: i + 1 },
        },
        create: { tenantId, salesOrderId, sequence: i + 1, ...data },
        update: data,
      });
    await tx.salesOrderStop.deleteMany({
      where: { salesOrderId, sequence: { gt: c.stops.length } },
    });
    for (const [i, data] of c.lines.entries())
      await tx.salesOrderLine.upsert({
        where: { tenantId_salesOrderId_lineNo: { tenantId, salesOrderId, lineNo: i + 1 } },
        create: { tenantId, salesOrderId, lineNo: i + 1, ...data },
        update: data,
      });
    await tx.salesOrderLine.deleteMany({ where: { salesOrderId, lineNo: { gt: c.lines.length } } });
  }

  /**
   * แก้ใบที่พ้นช่วงรับงาน (วางแผน/ออกรถแล้ว) เฉพาะช่องที่สถานะอนุญาต (ผ่าน `orderChanges` แล้ว) — เลข PO + ช่วงเวลาของจุด
   * ไม่คิดราคา/ไม่ประเมินใบค้างใหม่ (ราคาหลังยืนยัน = ORD-046 งานถัดไป) · version +1, audit, `order.updated`
   */
  private async applyRestricted(
    tx: Tx,
    current: OrderRecord,
    header: { customerRef: string | null; inputHash: string; rawPayload: unknown },
    children: OrderChildren,
  ): Promise<UpsertOrderResult> {
    const id = current.id;
    await tx.salesOrder.update({
      where: { id },
      data: {
        customerRef: header.customerRef,
        inputHash: header.inputHash,
        rawPayload: header.rawPayload as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    });
    for (const [i, s] of children.stops.entries()) {
      const prev = current.stops[i]!;
      if (
        (prev.windowStart?.getTime() ?? null) !== (s.windowStart?.getTime() ?? null) ||
        (prev.windowEnd?.getTime() ?? null) !== (s.windowEnd?.getTime() ?? null)
      )
        await tx.salesOrderStop.update({
          where: { id: prev.id },
          data: { windowStart: s.windowStart, windowEnd: s.windowEnd },
        });
    }
    const final = await tx.salesOrder.findUniqueOrThrow({ where: { id }, include: INCLUDE });
    await this.audit.changed(
      `${ENTITY}.updated`,
      ENTITY,
      id,
      orderEventView(current, { lines: true }),
      orderEventView(final, { lines: true }),
    );
    const evBefore = orderEventView(current);
    const evAfter = orderEventView(final);
    await this.emit(tx, 'order.updated', id, evAfter, diff(evBefore, evAfter).before);
    const holds = (current.pricingDetail as { holds?: IntakeHold[] } | null)?.holds ?? [];
    return { order: final, created: false, changed: true, holds };
  }

  private async history(
    tx: Tx,
    docId: string,
    fromStatus: string,
    toStatus: string,
    event: string,
    reasonCodeId: string | null = null,
    note: string | null = null,
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
        reasonCodeId,
        note,
      },
    });
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

/**
 * hash ของข้อมูลขาเข้าที่ normalize แล้ว (ทศนิยมรูปมาตรฐาน, ข้อความล้างแล้ว) — **ไม่รวม rawPayload** (ต้นทางมักมีช่องที่
 * เปลี่ยนทุกครั้ง เช่น เวลาส่ง) และ id → ส่งซ้ำค่าเดิมที่ raw ต่างเล็กน้อยก็ยังเป็น no-op (raw เก็บเมื่อข้อมูลเปลี่ยนจริง)
 */
function hashInput(n: NormalizedOrder): string {
  const { rawPayload: _raw, id: _id, ...rest } = n;
  return createHash('sha256').update(stableStringify(rest)).digest('hex');
}

/** ช่องที่เปลี่ยน (กลุ่มตาม `SO_FIELD_GROUPS` + path ของช่อง) — เทียบค่าที่จะเก็บกับแถวเดิม */
export function orderChanges(
  current: OrderRecord,
  header: {
    customerId: string | null;
    customerExternalId: string | null;
    customerText: string | null;
    billingCompanyId: string;
    customerRef: string | null;
    requestedDate: Date;
    vehicleTypeId: string | null;
    sourceIssues: string[];
  },
  c: OrderChildren,
): { group: SoFieldGroup; field: string }[] {
  const out: { group: SoFieldGroup; field: string }[] = [];
  const dec = (v: Prisma.Decimal | null) => (v === null ? null : canonDecimal(v.toFixed()));
  const time = (v: Date | null) => v?.getTime() ?? null;
  const ne = (a: unknown, b: unknown) => a !== b;
  if (ne(header.customerId, current.customerId)) out.push({ group: 'customer', field: 'customer' });
  else if (
    ne(header.customerExternalId, current.customerExternalId) ||
    ne(header.customerText, current.customerText)
  )
    out.push({ group: 'customer', field: 'customer' });
  if (ne(header.billingCompanyId, current.billingCompanyId))
    out.push({ group: 'billingCompanyId', field: 'billingCompanyId' });
  if (ne(header.customerRef, current.customerRef))
    out.push({ group: 'customerRef', field: 'customerRef' });
  if (ne(time(header.requestedDate), time(current.requestedDate)))
    out.push({ group: 'requestedDate', field: 'requestedDate' });
  if (ne(header.vehicleTypeId, current.vehicleTypeId))
    out.push({ group: 'vehicleTypeId', field: 'vehicleTypeId' });
  if (stableStringify(header.sourceIssues) !== stableStringify(current.sourceIssues ?? []))
    out.push({ group: 'sourceIssues', field: 'sourceIssues' });

  if (c.stops.length !== current.stops.length) out.push({ group: 'stops', field: 'stops' });
  c.stops.forEach((s, i) => {
    const p = current.stops[i];
    if (!p) return;
    for (const k of ['type', 'siteId', 'siteText'] as const)
      // ข้อความสถานที่ที่ตามมาจากการเปลี่ยนสถานที่ ไม่นับซ้ำ
      if (ne(s[k], p[k]) && !(k === 'siteText' && ne(s.siteId, p.siteId)))
        out.push({ group: 'stops', field: `stops[${i}].${k}` });
    for (const k of ['windowStart', 'windowEnd'] as const)
      if (ne(time(s[k]), time(p[k])))
        out.push({ group: 'stops.window', field: `stops[${i}].${k}` });
  });

  if (c.lines.length !== current.lines.length) out.push({ group: 'lines', field: 'lines' });
  c.lines.forEach((l, i) => {
    const p = current.lines[i];
    if (!p) return;
    const was = {
      itemCode: p.itemCode,
      productId: p.productId,
      description: p.description,
      qtyOrdered: dec(p.qtyOrdered),
      unitId: p.unitId,
      unit: p.unit,
      weightKg: dec(p.weightKg),
      cbm: dec(p.cbm),
      isDangerous: p.isDangerous,
      tempMin: dec(p.tempMin),
      tempMax: dec(p.tempMax),
    };
    for (const k of Object.keys(was) as (keyof typeof was)[])
      if (ne(l[k], was[k]))
        out.push({ group: 'lines', field: `lines[${i}].${k === 'qtyOrdered' ? 'qty' : k}` });
  });
  return out;
}
