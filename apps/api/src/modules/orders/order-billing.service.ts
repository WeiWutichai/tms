import { Injectable, Logger } from '@nestjs/common';
import {
  billableQtyBySoLine,
  decimalFromSatang,
  isQtyBasedPricing,
  satangFromDecimal,
  sumSatang,
} from '@tms/domain';
import { DbService, type Tx } from '../../db/db.service';
import { PricingService } from '../pricing/pricing.service';
import type { ServiceItemSnapshot } from '../service-items/snapshot';
import type { OrderBillingChargeDto, OrderBillingDto } from './order.dto';

/**
 * ยอดวางบิลของใบสั่งขนส่ง (ST4-T10; docs/04 E2 "วางบิลตามยอดส่งจริงได้ (ตั้งต่อลูกค้า)", docs/01 §3.3 `revenue_amount`
 * "คำนวณจาก snapshot × ปริมาณจริง") — **อ่านอย่างเดียว คำนวณทุกครั้ง (deterministic) ไม่เก็บยอด**
 * ST5-T01 (บรรทัดรายได้/ใบแจ้งหนี้) เรียก `compute` แล้ว snapshot ตอนออกเอกสาร
 *
 * - ลูกค้า `billByActualQty = false` → ยอดตามบรรทัดราคาขายของ SO (snapshot) เดิม
 * - `true` + มียอดส่งจริงแล้ว → บรรทัด FREIGHT ที่ระบบคิด (RATE_CARD) ของสูตรตามจำนวน (ตัน/ลบ.ม./หน่วยนับ) คิดใหม่ด้วย
 *   `PricingService.repriceFreight` (engine เดิม, rate card ฉบับเดิมที่แก้ไม่ได้แล้ว, ราคาต่อหน่วย + รายการบริการตาม snapshot)
 *   จำนวน = ผลรวมยอดส่งจริงของบรรทัด DO ที่ไม่ยกเลิก (ยังไม่บันทึก = แผน) ต่อบรรทัด SO — ขั้นต่ำของ rate ยังใช้
 * - ไม่เปลี่ยน: ค่าขนส่งที่คนกำหนด (MANUAL — ยอดเหมา, ราคาที่กำหนดเองชนะ rate card) · เหมาเที่ยว/ตามระยะทาง ·
 *   ค่าจุดเพิ่ม · ค่าบริการเสริม · vat_type/wht_rate (ไม่คำนวณภาษีที่นี่)
 * - คิดไม่ได้ (เช่น ส่งได้ 0 ทุกรายการ → QUANTITY_INVALID) → `CALCULATION_FAILURE`, ยอดรวม null (ห้ามใช้ยอดบางส่วน)
 */
@Injectable()
export class OrderBillingService {
  private readonly log = new Logger(OrderBillingService.name);
  constructor(
    private readonly db: DbService,
    private readonly pricing: PricingService,
  ) {}

  async compute(orderId: string, tx: Tx = this.db.tx): Promise<OrderBillingDto> {
    const o = await tx.salesOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        priceTotal: true,
        customer: { select: { billByActualQty: true } },
        charges: { orderBy: { lineNo: 'asc' } },
        lines: {
          orderBy: { lineNo: 'asc' },
          select: { id: true, unitId: true, productId: true, qtyOrdered: true },
        },
        deliveryOrders: {
          where: { status: { not: 'CANCELLED' } },
          select: {
            status: true,
            lines: { select: { salesOrderLineId: true, qtyPlanned: true, qtyActual: true } },
          },
        },
      },
    });
    const basis = o.customer?.billByActualQty ? 'ACTUAL' : 'PLANNED';
    // ST4-T11 [OPEN money — spec/12 §3]: DO คืนคลังทั้งใบ (RETURNED) = ส่งได้ 0 · ใบส่งซ้ำของที่ปฏิเสธรับ
    // (DRAFT, ยังไม่บันทึก = แผน) รวมกับยอดส่งจริงของใบเดิม → ยอดของ SO เดิมไม่เกินที่สั่ง
    const doLines = o.deliveryOrders.flatMap((d) =>
      d.lines.map((l) => ({
        salesOrderLineId: l.salesOrderLineId,
        qtyPlanned: l.qtyPlanned.toFixed(),
        qtyActual:
          d.status === 'RETURNED' ? '0' : l.qtyActual === null ? null : l.qtyActual.toFixed(),
      })),
    );
    const actualRecorded = doLines.some((l) => l.qtyActual !== null);
    const allReturned =
      o.deliveryOrders.length > 0 && o.deliveryOrders.every((d) => d.status === 'RETURNED');
    const charges: OrderBillingChargeDto[] = o.charges.map((c) => ({
      lineNo: c.lineNo,
      kind: c.kind,
      origin: c.origin,
      description: c.description,
      qtyPlanned: c.qty.toFixed(),
      qty: c.qty.toFixed(),
      qtyExact: c.qtyExact,
      sellUnitPrice: c.unitPrice.toFixed(2),
      sellPlannedAmount: c.amount.toFixed(2),
      sellAmount: c.amount.toFixed(2),
      minChargeApplied: c.minChargeApplied,
      vatType: c.vatType,
      whtRate: c.whtRate.toFixed(2),
      adjusted: false,
      note: null,
      qtyUnit: null,
    }));
    const plannedTotal = o.priceTotal ? o.priceTotal.toFixed(2) : null;
    const result = (
      status: string,
      billable: string | null,
      reasons: OrderBillingDto['reasons'] = [],
    ): OrderBillingDto => ({
      preview: true,
      basis,
      status,
      actualRecorded,
      charges,
      sellPlannedTotal: plannedTotal,
      sellBillableTotal: billable,
      reasons,
    });
    if (basis === 'PLANNED') return result('PLANNED', plannedTotal);
    if (!actualRecorded) return result('NOT_RECORDED', plannedTotal);

    const billable = billableQtyBySoLine(doLines, 'ACTUAL');
    // บรรทัด SO ที่ไม่มี DO (ไม่ควรเกิดหลังสร้าง DO) = ตามใบสั่ง
    const quantities = o.lines.flatMap((l) =>
      l.unitId
        ? [
            {
              qty: billable.get(l.id) ?? l.qtyOrdered.toFixed(),
              unitId: l.unitId,
              productId: l.productId,
            },
          ]
        : [],
    );
    const reasons: OrderBillingDto['reasons'] = [];
    for (const [i, c] of o.charges.entries()) {
      if (c.kind !== 'FREIGHT') continue;
      const out = charges[i]!;
      if (c.origin !== 'RATE_CARD' || !c.rateCardId) {
        out.note = 'MANUAL_PRICE';
        continue;
      }
      const rc = await tx.rateCard.findUniqueOrThrow({
        where: { id: c.rateCardId },
        select: { pricingModel: true, unit: { select: { nameTh: true } } },
      });
      if (!isQtyBasedPricing(rc.pricingModel)) {
        out.note = 'NOT_QTY_BASED';
        continue;
      }
      // ST4-T11 (QA M2) [OPEN เงิน spec/12 §3]: ทุกใบคืนคลัง → ส่งได้ 0 = ค่าขนส่งตามจำนวน 0 (ไม่ใช่คิดไม่ได้)
      if (allReturned) {
        out.qty = '0';
        out.sellAmount = '0.00';
        out.adjusted = out.sellPlannedAmount !== '0.00';
        continue;
      }
      // ปัญหาใด ๆ ของการคิดใหม่ (ข้อมูลหลักหาย/ผิด) = CALCULATION_FAILURE — ห้ามทำให้ GET ใบสั่งล้ม
      let r: Awaited<ReturnType<PricingService['repriceFreight']>>;
      try {
        r = await this.pricing.repriceFreight(
          {
            rateCardId: c.rateCardId,
            unitPrice: c.unitPrice.toFixed(2),
            serviceItem: c.serviceItemSnapshot as unknown as ServiceItemSnapshot,
            quantities,
          },
          tx,
        );
      } catch (e) {
        this.log.warn(`order ${orderId}: billing preview failed — ${(e as Error).message}`);
        reasons.push({
          code: 'CALCULATION_ERROR',
          message: 'คิดยอดตามส่งจริงไม่ได้ (ข้อมูลหลักที่ใช้คิดไม่ครบ)',
        });
        continue;
      }
      const line = r.lines.find((x) => x.kind === 'FREIGHT');
      if (r.pricingStatus !== 'AVAILABLE' || !line) {
        reasons.push(
          ...r.reasons.map((x) => ({
            code: x.code,
            message: x.message,
            ...(x.field ? { field: x.field } : {}),
          })),
        );
        continue;
      }
      out.qty = line.qty;
      // หน่วยของจำนวนที่คิดเงิน (หน่วยของสูตร) — ชื่อจาก master (อ่านแม้ถูกลบแบบ soft)
      out.qtyUnit =
        rc.pricingModel === 'PER_UNIT'
          ? (rc.unit?.nameTh ?? null)
          : ((
              await tx.unit.findFirst({
                where: { code: rc.pricingModel === 'PER_TON' ? 'TON' : 'CBM' },
                select: { nameTh: true },
              })
            )?.nameTh ?? (rc.pricingModel === 'PER_TON' ? 'TON' : 'CBM'));
      out.qtyExact = line.qtyExact;
      out.sellAmount = line.amount;
      out.minChargeApplied = line.minChargeApplied;
      out.adjusted = line.amount !== out.sellPlannedAmount;
    }
    if (reasons.length) return result('CALCULATION_FAILURE', null, reasons);
    const total = charges.length
      ? decimalFromSatang(sumSatang(charges.map((c) => satangFromDecimal(c.sellAmount))))
      : plannedTotal;
    return result('ACTUAL', total);
  }
}
