import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { DoSurcharge, StoredDocument, TripCost } from '@prisma/client';
import { decimalFromSatang, mulRateHalfUp, satangFromDecimal, scopeAllows } from '@tms/domain';
import { NotificationEvents } from '../notifications/notification-events';
import { AuditService } from '../../audit/audit.service';
import { encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { readyDocumentDto } from '../documents/documents.controller';
import { RevenueLinesService } from '../revenue-lines/revenue-lines.service';
import { ServiceItemsService } from '../service-items/service-items.service';
import { sideAllows, type ServiceItemSnapshot } from '../service-items/snapshot';
import type { ServiceItemSide } from '../service-items/service-item.dto';
import type { CreateFieldChargeDto, FieldChargeDto, FieldChargeStatus } from './field-charge.dto';

/** เที่ยวที่บันทึกค่าใช้จ่ายหน้างานได้ = ปล่อยรถแล้วจนวิ่งจบ (ก่อนคิดต้นทุน/จ่าย — COSTED/SETTLED ปิดแล้ว) */
export const FIELD_CHARGE_TRIP_STATUSES = ['DISPATCHED', 'IN_PROGRESS', 'COMPLETED'] as const;
/** DO ที่ยังรับบรรทัดเพิ่มฝั่งขายได้ (วางบิลแล้ว/ยกเลิก = ไม่ได้) */
const CLOSED_DO = new Set(['BILLED', 'CANCELLED']);
/** ชนิดไฟล์หลักฐาน (POST /v1/documents kind) */
export const EVIDENCE_KIND = 'RECEIPT';
const MAX_SATANG = 99_999_999_999_999n; // numeric(14,2)

const SELL_ENTITY = 'do_surcharge';
const BUY_ENTITY = 'trip_cost';

type Kind = 'doSurcharge' | 'tripCost';
type SurchargeRow = DoSurcharge & {
  deliveryOrder: { doNo: string | null };
  evidenceDocument: StoredDocument | null;
  tripCosts: { id: string }[];
};
type CostRow = TripCost & { evidenceDocument: StoredDocument | null };

/** เที่ยวที่ปิดต้นทุน/จ่าย/ยกเลิกแล้ว — ยืนยันบรรทัดไม่ได้ (ST5/ST6 ต้องไม่ finalize/settle ขณะมีบรรทัดรอยืนยัน) */
const CLOSED_TRIP = new Set(['COSTED', 'SETTLED', 'CANCELLED']);
/** สิทธิ์บันทึก/ยกเลิกฝั่งซื้อ: `prices.buy:write` หรือ (`trips:dispatch` + `prices.buy:read`) */
const BUY_RECORD_SCOPES = ['prices.buy:write', 'trips:dispatch+prices.buy:read'];
export const canRecordBuy = (scopes: readonly string[]) =>
  scopeAllows(scopes, 'prices.buy:write') ||
  (scopeAllows(scopes, 'trips:dispatch') && scopeAllows(scopes, 'prices.buy:read'));
const canCancel = (kind: Kind, scopes: readonly string[]) =>
  kind === 'doSurcharge' ? scopeAllows(scopes, 'prices.sell:write') : canRecordBuy(scopes);
const denied = (required: string[]) =>
  new ProblemException('permission_denied', undefined, undefined, {
    module: 'field-charges',
    action: 'write',
    required,
  });

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

/** ชนิดต้นทุน (trip_cost.cost_type ของ docs/01 §3.3) จากรหัสรายการ — ทางด่วน = TOLL ที่เหลือ = OTHER */
export const costTypeOf = (code: string) => (code.toUpperCase() === 'TOLL' ? 'TOLL' : 'OTHER');

/**
 * ค่าใช้จ่ายหน้างาน (ST4-T13; docs/04 E2 "บันทึกเหตุล่าช้า / ค่าใช้จ่ายหน้างาน", docs/01 §3.3)
 * - ฝั่งขาย → `do_surcharge` (ต่อ DO ในเที่ยว) · ฝั่งซื้อ → `trip_cost` (source MANUAL, ไม่ถูก rebuild โดย ST6-T01)
 * - ธงภาษี vat_type / wht_rate = snapshot จาก service_item ตอนบันทึก (ServiceItemsService.snapshotFor) — ไม่คำนวณภาษีที่นี่
 *   ฝั่งซื้อ vat_amount = 0 (เหมือน ST3-T22 — รอคำตอบนักบัญชี #58)
 * - รูปหลักฐาน 1 ไฟล์ต่อบรรทัด ผูกกับบรรทัด (stored_document.entity_*) — ไฟล์ที่ผูกกับรายการอื่นแล้วใช้ไม่ได้
 * - PENDING_CONFIRM → CONFIRMED / REJECTED โดยผู้วางบิล (`invoices:draft`) · ผู้บันทึกยกเลิกได้ระหว่างรอ — เหตุผล ≥ 10 + audit ทุกครั้ง
 */
@Injectable()
export class FieldChargesService {
  constructor(
    private readonly db: DbService,
    private readonly serviceItems: ServiceItemsService,
    private readonly audit: AuditService,
    private readonly events: NotificationEvents,
    private readonly revenueLines: RevenueLinesService,
  ) {}

  // ---------- read ----------

  async list(tripId: string, origin: string): Promise<FieldChargeDto[]> {
    const tx = this.db.tx;
    const trip = await tx.trip.findUnique({ where: { id: tripId }, select: { id: true } });
    if (!trip) throw new ProblemException('not_found');
    const [sells, buys] = await Promise.all([
      tx.doSurcharge.findMany({
        where: { tripId },
        include: this.sellInclude,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      tx.tripCost.findMany({
        where: { tripId, source: 'MANUAL', sourceType: { in: ['FIELD', 'DO_SURCHARGE'] } },
        include: { evidenceDocument: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    const names = await this.userNames([
      ...sells.flatMap((r) => [r.createdBy, r.decidedBy]),
      ...buys.flatMap((r) => [r.createdBy, r.decidedBy]),
    ]);
    const out = [
      ...sells.map((r) => this.sellDto(r, names, origin)),
      ...buys.map((r) => this.buyDto(r, names, origin)),
    ];
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  // ---------- create ----------

  async create(
    tripId: string,
    input: CreateFieldChargeDto,
    origin: string,
  ): Promise<FieldChargeDto[]> {
    const tx = this.db.tx;
    const ctx = requestContext.require();
    // ล็อกเที่ยว (แบบอ่าน) — กันสถานะเปลี่ยนระหว่างบันทึก
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM trip WHERE id = ${tripId}::uuid FOR SHARE`;
    if (!locked) throw new ProblemException('not_found');
    const trip = await tx.trip.findUniqueOrThrow({ where: { id: tripId } });
    if (!(FIELD_CHARGE_TRIP_STATUSES as readonly string[]).includes(trip.status))
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        tripStatus: trip.status,
      });

    const sell = input.side !== 'BUY';
    const buy = input.side !== 'SELL';
    // สิทธิ์ฝั่งซื้อ: แก้ราคาซื้อ หรือ ผู้จ่ายงานที่เห็นราคาซื้อ (บันทึกหน้างาน — ผู้อื่นยืนยัน: maker-checker)
    // ฝั่งขาย: `prices.sell:write` (interceptor ราคาตรวจจาก `sellUnitPrice` อยู่แล้ว — ตรวจซ้ำที่นี่)
    if (buy && !canRecordBuy(ctx.scopes ?? [])) throw denied(BUY_RECORD_SCOPES);
    if (sell && !scopeAllows(ctx.scopes ?? [], 'prices.sell:write'))
      throw denied(['prices.sell:write']);
    const errors: { field: string; code: string; message: string }[] = [];
    const need = (ok: boolean, field: string) => {
      if (!ok) errors.push({ field, code: 'required', message: `${field} is required` });
    };
    const notFor = (sent: boolean, field: string) => {
      if (sent)
        errors.push({
          field,
          code: 'not_applicable',
          message: `${field} is not used for side ${input.side}`,
        });
    };
    if (sell) {
      need(!!input.deliveryOrderId, 'deliveryOrderId');
      need(input.sellUnitPrice !== undefined, 'sellUnitPrice');
    } else {
      notFor(input.sellUnitPrice !== undefined, 'sellUnitPrice');
      notFor(input.qty !== undefined, 'qty');
      notFor(input.deliveryOrderId !== undefined, 'deliveryOrderId');
    }
    if (buy) need(input.costAmount !== undefined, 'costAmount');
    else notFor(input.costAmount !== undefined, 'costAmount');
    // รูปใบเสร็จบังคับทั้งสองฝั่ง (spec M15 "รูปใบเสร็จ (บังคับ)")
    if (!input.evidenceDocumentId)
      errors.push({
        field: 'evidenceDocumentId',
        code: 'evidence_required',
        message: 'receipt photo is required',
      });

    // จำนวน/ยอด (สตางค์ bigint — ไม่ใช้ float)
    const qty = input.qty ?? '1';
    let sellUnit = 0n;
    let sellAmount = 0n;
    if (sell && input.sellUnitPrice !== undefined) {
      const milli = qtyMilli(qty);
      if (milli <= 0n)
        errors.push({ field: 'qty', code: 'out_of_range', message: 'qty must be > 0' });
      sellUnit = satangFromDecimal(input.sellUnitPrice);
      if (sellUnit <= 0n)
        errors.push({
          field: 'sellUnitPrice',
          code: 'out_of_range',
          message: 'sellUnitPrice must be > 0',
        });
      sellAmount = mulRateHalfUp(sellUnit, qty);
      if (sellAmount > MAX_SATANG)
        errors.push({ field: 'sellUnitPrice', code: 'too_large', message: 'amount is too large' });
    }
    const buyAmount =
      buy && input.costAmount !== undefined ? satangFromDecimal(input.costAmount) : 0n;
    if (buy && input.costAmount !== undefined && buyAmount <= 0n)
      errors.push({
        field: 'costAmount',
        code: 'out_of_range',
        message: 'costAmount must be > 0',
      });
    if (errors.length) throw new ProblemException('validation_failed', undefined, errors);

    // DO ในเที่ยวนี้
    let doId: string | null = null;
    if (sell) {
      const id = tryDecodeId('deliveryOrder', input.deliveryOrderId!);
      const d = id
        ? await tx.deliveryOrder.findFirst({
            where: { id, tripId },
            select: { id: true, status: true },
          })
        : null;
      if (!d)
        throw field422(
          'deliveryOrderId',
          'invalid_reference',
          'delivery order is not in this trip',
        );
      if (CLOSED_DO.has(d.status))
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

    // รายการบริการ → snapshot (ตรวจใช้งานอยู่ + ฝั่ง)
    const itemId = tryDecodeId('serviceItem', input.serviceItemId);
    if (!itemId)
      throw field422('serviceItemId', 'service_item_not_found', 'service item not found');
    const snap = await this.serviceItems.snapshotFor(itemId, sell ? 'SELL' : 'BUY');
    if (sell && buy) {
      const s = await tx.serviceItem.findUniqueOrThrow({
        where: { id: itemId },
        select: { side: true },
      });
      if (!sideAllows(s.side as ServiceItemSide, 'BUY'))
        throw field422(
          'serviceItemId',
          'service_item_side',
          `service item ${snap.code} is for SELL documents only`,
        );
    }
    if (!snap.isSurcharge || snap.unit === 'PERCENT_OF_FREIGHT')
      throw field422(
        'serviceItemId',
        'service_item_not_field',
        `service item ${snap.code} cannot be recorded as a field charge`,
      );

    // หลักฐาน — ไฟล์ใบเสร็จที่อัปโหลดเสร็จแล้วและยังไม่ผูกกับรายการใด
    let docId: string | null = null;
    if (input.evidenceDocumentId) {
      docId = tryDecodeId('document', input.evidenceDocumentId);
      const doc = docId ? await tx.storedDocument.findUnique({ where: { id: docId } }) : null;
      if (!doc) throw field422('evidenceDocumentId', 'not_found', 'document not found');
      if (doc.status !== 'READY')
        throw field422('evidenceDocumentId', 'not_uploaded', 'document upload is not complete');
      if (doc.kind !== EVIDENCE_KIND)
        throw field422(
          'evidenceDocumentId',
          'invalid_kind',
          `document kind must be ${EVIDENCE_KIND}`,
        );
      if (doc.entityId !== null)
        throw field422(
          'evidenceDocumentId',
          'document_in_use',
          'document belongs to another record',
        );
    }

    const sellId = sell ? randomUUID() : null;
    const buyId = buy ? randomUUID() : null;
    if (docId) {
      // ผูกไฟล์ (ล็อกแถวไฟล์ — สองคำขอแย่งไฟล์เดียวกันได้ผลเดียว)
      const bound = await tx.storedDocument.updateMany({
        where: { id: docId, entityId: null },
        data: { entityType: sell ? SELL_ENTITY : BUY_ENTITY, entityId: (sellId ?? buyId)! },
      });
      if (bound.count !== 1)
        throw field422(
          'evidenceDocumentId',
          'document_in_use',
          'document belongs to another record',
        );
    }

    const actor = ctx.actorId ?? null;
    const note = input.note?.trim() || null;
    if (sell) {
      const row = await tx.doSurcharge.create({
        data: {
          id: sellId!,
          tenantId: ctx.tenantId!,
          deliveryOrderId: doId!,
          tripId,
          serviceItemId: snap.sourceItemId,
          serviceItemVersion: snap.sourceVersion,
          serviceItemSnapshot: snapshotJson(snap),
          description: snap.name,
          vatType: snap.vatType,
          whtRate: snap.whtRate,
          qty,
          unitPrice: decimalFromSatang(sellUnit),
          amount: decimalFromSatang(sellAmount),
          evidenceDocumentId: docId,
          note,
          createdBy: actor,
        },
      });
      await this.audit.record({
        action: `${SELL_ENTITY}.created`,
        entityType: SELL_ENTITY,
        entityId: row.id,
        after: {
          tripId,
          deliveryOrderId: doId,
          serviceItemCode: snap.code,
          vatType: snap.vatType,
          whtRate: snap.whtRate,
          qty,
          sellUnitPrice: decimalFromSatang(sellUnit),
          sellAmount: decimalFromSatang(sellAmount),
          evidenceDocumentId: docId,
          status: 'PENDING_CONFIRM',
        },
      });
    }
    if (buy) {
      const row = await tx.tripCost.create({
        data: {
          id: buyId!,
          tenantId: ctx.tenantId!,
          tripId,
          costType: costTypeOf(snap.code),
          amount: decimalFromSatang(buyAmount),
          vatAmount: '0.00',
          source: 'MANUAL',
          carrierId: trip.carrierId,
          serviceItemId: snap.sourceItemId,
          vatType: snap.vatType,
          whtRate: snap.whtRate,
          description: snap.name,
          sourceType: sell ? 'DO_SURCHARGE' : 'FIELD',
          sourceId: sellId,
          doSurchargeId: sellId,
          evidenceDocumentId: docId,
          note,
          status: 'PENDING_CONFIRM',
          createdBy: actor,
        },
      });
      await this.audit.record({
        action: `${BUY_ENTITY}.created`,
        entityType: BUY_ENTITY,
        entityId: row.id,
        after: {
          tripId,
          costType: row.costType,
          serviceItemCode: snap.code,
          vatType: snap.vatType,
          whtRate: snap.whtRate,
          buyAmount: decimalFromSatang(buyAmount),
          doSurchargeId: sellId,
          evidenceDocumentId: docId,
          status: 'PENDING_CONFIRM',
        },
      });
    }
    // ST9-T08 ขออนุมัติ: แจ้งผู้ยืนยันของแต่ละฝั่ง (ไม่รวมผู้บันทึกเอง — maker-checker)
    await this.events.fieldChargePending(tx, {
      tenantId: ctx.tenantId!,
      tripId,
      item: snap.name,
      sell,
      buy,
    });
    const all = await this.list(tripId, origin);
    const ids = new Set(
      [sellId && encodeId('doSurcharge', sellId), buyId && encodeId('tripCost', buyId)].filter(
        Boolean,
      ),
    );
    return all.filter((x) => ids.has(x.id));
  }

  // ---------- decisions ----------

  /**
   * ยืนยัน / ปฏิเสธ / ยกเลิก — เฉพาะบรรทัดที่รอยืนยัน · เหตุผลบังคับ + audit · If-Match = version ของบรรทัด
   * - ยืนยัน/ปฏิเสธ: ฝั่งขาย `invoices:draft` · ฝั่งซื้อ `settlements:approve` (controller) · ผู้บันทึกเองไม่ได้
   *   (maker-checker → 403 `self_approval_forbidden`) · ยืนยันไม่ได้เมื่อ DO วางบิล/ยกเลิก หรือเที่ยวคิดต้นทุน/จ่าย/ยกเลิกแล้ว (409)
   * - ยกเลิก: สิทธิ์บันทึกฝั่งนั้น · บรรทัดคู่ (BOTH) ที่ยังรอยืนยันถูกยกเลิกด้วยเหตุผลเดียวกัน (audit ทั้งคู่)
   */
  async decide(
    kind: Kind,
    id: string,
    action: 'confirm' | 'reject' | 'cancel',
    reason: string,
    expected: number | undefined,
    origin: string,
  ): Promise<FieldChargeDto> {
    const tx = this.db.tx;
    const ctx = requestContext.require();
    const row = await this.lockLine(kind, id);
    if (!row) throw new ProblemException('not_found');
    const scopes = ctx.scopes ?? [];
    if (action === 'cancel' && !canCancel(kind, scopes))
      throw denied(kind === 'doSurcharge' ? ['prices.sell:write'] : BUY_RECORD_SCOPES);
    if (expected !== undefined && expected !== row.version)
      throw new ProblemException('precondition_failed');
    if (row.status !== 'PENDING_CONFIRM')
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        status: row.status,
      });
    if (action !== 'cancel' && row.createdBy && row.createdBy === ctx.actorId)
      throw new ProblemException('self_approval_forbidden');
    if (action === 'confirm') {
      const trip = row.tripId
        ? await tx.trip.findUnique({ where: { id: row.tripId }, select: { status: true } })
        : null;
      if (trip && CLOSED_TRIP.has(trip.status))
        throw new ProblemException('invalid_state_transition', undefined, undefined, {
          tripStatus: trip.status,
        });
      if (kind === 'doSurcharge') {
        const d = await tx.deliveryOrder.findUniqueOrThrow({
          where: { id: row.deliveryOrderId! },
          select: { status: true },
        });
        if (CLOSED_DO.has(d.status))
          throw new ProblemException('invalid_state_transition', undefined, undefined, {
            doStatus: d.status,
          });
      }
    }
    const status: FieldChargeStatus =
      action === 'confirm' ? 'CONFIRMED' : action === 'reject' ? 'REJECTED' : 'CANCELLED';
    await this.apply(kind, id, row.status, status, reason);
    // ฝั่งขายที่ยืนยันแล้ว = บรรทัดรายได้ DO_SURCHARGE ของใบสั่ง (ST5-T01)
    if (kind === 'doSurcharge' && status === 'CONFIRMED' && row.deliveryOrderId)
      await this.revenueLines.rebuildForDeliveryOrder(row.deliveryOrderId);
    // ยกเลิกบรรทัดคู่ (BOTH) ด้วย — ยืนยัน/ปฏิเสธยังแยกฝั่ง
    if (action === 'cancel' && row.pairKind && row.pairId) {
      if (!canCancel(row.pairKind, scopes))
        throw denied(row.pairKind === 'doSurcharge' ? ['prices.sell:write'] : BUY_RECORD_SCOPES);
      const pair = await this.lockLine(row.pairKind, row.pairId);
      if (pair?.status === 'PENDING_CONFIRM')
        await this.apply(row.pairKind, row.pairId, pair.status, 'CANCELLED', reason);
    }
    return this.one(kind, id, origin);
  }

  /** ล็อกบรรทัด (FOR UPDATE) — trip_cost ที่ไม่ใช่ค่าใช้จ่ายหน้างาน (เช่น CARRIER_FEE) = ไม่พบ */
  private async lockLine(kind: Kind, id: string) {
    const tx = this.db.tx;
    const table = kind === 'doSurcharge' ? 'do_surcharge' : 'trip_cost';
    const [r] = await tx.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id::text AS id FROM ${table} WHERE id = $1::uuid FOR UPDATE`,
      id,
    );
    if (!r) return null;
    if (kind === 'doSurcharge') {
      const x = await tx.doSurcharge.findUniqueOrThrow({
        where: { id },
        include: { tripCosts: { select: { id: true } } },
      });
      return {
        status: x.status,
        version: x.version,
        createdBy: x.createdBy,
        tripId: x.tripId,
        deliveryOrderId: x.deliveryOrderId as string | null,
        pairKind: 'tripCost' as Kind,
        pairId: x.tripCosts[0]?.id ?? null,
      };
    }
    const c = await tx.tripCost.findUniqueOrThrow({ where: { id } });
    if (c.source !== 'MANUAL' || !['FIELD', 'DO_SURCHARGE'].includes(c.sourceType ?? ''))
      return null;
    return {
      status: c.status,
      version: c.version,
      createdBy: c.createdBy,
      tripId: c.tripId as string | null,
      deliveryOrderId: null as string | null,
      pairKind: 'doSurcharge' as Kind,
      pairId: c.doSurchargeId,
    };
  }

  private async apply(
    kind: Kind,
    id: string,
    before: string,
    status: FieldChargeStatus,
    reason: string,
  ) {
    const tx = this.db.tx;
    const actor = requestContext.require().actorId ?? 'unknown';
    const data = {
      status,
      decidedBy: actor,
      decidedAt: new Date(),
      decisionReason: reason,
      version: { increment: 1 },
    };
    if (kind === 'doSurcharge')
      await tx.doSurcharge.update({
        where: { id },
        data: { ...data, ...(status === 'CONFIRMED' ? { approvedBy: actor } : {}) },
      });
    else await tx.tripCost.update({ where: { id }, data });
    const entity = kind === 'doSurcharge' ? SELL_ENTITY : BUY_ENTITY;
    const verb =
      status === 'CONFIRMED' ? 'confirmed' : status === 'REJECTED' ? 'rejected' : 'cancelled';
    await this.audit.record({
      action: `${entity}.${verb}`,
      entityType: entity,
      entityId: id,
      before: { status: before },
      after: { status },
      reason,
    });
  }

  private async one(kind: Kind, id: string, origin: string): Promise<FieldChargeDto> {
    const tx = this.db.tx;
    if (kind === 'doSurcharge') {
      const r = await tx.doSurcharge.findUniqueOrThrow({
        where: { id },
        include: this.sellInclude,
      });
      return this.sellDto(r, await this.userNames([r.createdBy, r.decidedBy]), origin);
    }
    const r = await tx.tripCost.findUniqueOrThrow({
      where: { id },
      include: { evidenceDocument: true },
    });
    return this.buyDto(r, await this.userNames([r.createdBy, r.decidedBy]), origin);
  }

  // ---------- mapping ----------

  private readonly sellInclude = {
    deliveryOrder: { select: { doNo: true } },
    evidenceDocument: true,
    tripCosts: { select: { id: true } },
  } as const;

  private evidence(doc: StoredDocument | null, origin: string) {
    if (!doc) return null;
    const d = readyDocumentDto(doc, origin);
    return {
      id: d.id,
      mime: d.mime,
      bytes: d.bytes,
      filename: d.filename,
      downloadUrl: d.downloadUrl!,
      urlExpiresAt: d.urlExpiresAt!,
    };
  }

  private common(r: DoSurcharge | TripCost, names: Map<string, string>) {
    return {
      status: r.status as FieldChargeStatus,
      // แถวก่อน ST4-T13 ไม่มี trip_id — ตอบ null แทน 500
      tripId: r.tripId ? encodeId('trip', r.tripId) : null,
      note: r.note,
      createdBy: r.createdBy,
      createdByName: (r.createdBy && names.get(r.createdBy)) ?? null,
      createdAt: r.createdAt.toISOString(),
      decidedBy: r.decidedBy,
      decidedByName: (r.decidedBy && names.get(r.decidedBy)) ?? null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      decisionReason: r.decisionReason,
      version: r.version,
    };
  }

  private sellDto(r: SurchargeRow, names: Map<string, string>, origin: string): FieldChargeDto {
    const snap = (r.serviceItemSnapshot ?? {}) as Partial<ServiceItemSnapshot>;
    return {
      id: encodeId('doSurcharge', r.id),
      side: 'SELL',
      ...this.common(r, names),
      deliveryOrderId: encodeId('deliveryOrder', r.deliveryOrderId),
      doNo: r.deliveryOrder.doNo,
      serviceItemId: encodeId('serviceItem', r.serviceItemId),
      serviceItemCode: snap.code ?? '',
      description: r.description,
      unitLabel: snap.unitLabel ?? null,
      vatType: r.vatType,
      whtRate: r.whtRate.toFixed(2),
      qty: r.qty.toFixed(3).replace(/\.?0+$/, '') || '0',
      sellUnitPrice: r.unitPrice.toFixed(2),
      sellAmount: r.amount.toFixed(2),
      costType: null,
      pairedId: r.tripCosts[0] ? encodeId('tripCost', r.tripCosts[0].id) : null,
      evidence: this.evidence(r.evidenceDocument, origin),
    };
  }

  private buyDto(r: CostRow, names: Map<string, string>, origin: string): FieldChargeDto {
    return {
      id: encodeId('tripCost', r.id),
      side: 'BUY',
      ...this.common(r, names),
      deliveryOrderId: null,
      doNo: null,
      serviceItemId: r.serviceItemId ? encodeId('serviceItem', r.serviceItemId) : '',
      serviceItemCode: '',
      description: r.description ?? '',
      unitLabel: null,
      vatType: r.vatType,
      whtRate: r.whtRate?.toFixed(2) ?? null,
      qty: null,
      buyAmount: r.amount.toFixed(2),
      costType: r.costType,
      pairedId: r.doSurchargeId ? encodeId('doSurcharge', r.doSurchargeId) : null,
      evidence: this.evidence(r.evidenceDocument, origin),
    };
  }

  private async userNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const uuids = [...new Set(ids.filter((x): x is string => !!x && /^[0-9a-f-]{36}$/i.test(x)))];
    if (!uuids.length) return new Map();
    const users = await this.db.tx.appUser.findMany({
      where: { id: { in: uuids } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }
}

/** "2.5" → 2500n (ทศนิยม 3 ตำแหน่งเป็นจำนวนเต็ม — ตรวจ > 0 โดยไม่ใช้ float) */
export function qtyMilli(q: string): bigint {
  const [i, f = ''] = q.split('.');
  return BigInt(i!) * 1000n + BigInt((f + '000').slice(0, 3));
}

function snapshotJson(s: Readonly<ServiceItemSnapshot>) {
  return { ...s };
}
