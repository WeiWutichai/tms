import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Clock } from '../../common/clock';
import { ProblemException } from '../../common/problem';
import { DbService, type Tx } from '../../db/db.service';
import { cleanLine } from '../master/master-kit';
import { OrderStateService } from '../orders/order-state.service';
import { ReasonCodesService } from '../reason-codes/reason-codes.service';
import { StopProjectionService } from '../stops/stop-projection.service';
import { bangkokToday, isRealDate } from '../vehicle-documents/expiry';
import {
  DeliveryOrderService,
  type DeliveryOrderRecord,
  type RejectionLine,
} from './delivery-order.service';

export interface ResolveInput {
  reasonCodeId: string;
  note?: string | null;
  lines?: { lineNo: number; qty: string }[];
  /** เฉพาะส่งซ้ำ */
  doDate?: string;
}

/** สถานะ DO ที่ส่งถึงแล้ว (มียอดส่งจริง/ปฏิเสธรับจากหลักฐานส่ง) */
const DELIVERED_SET = ['DELIVERED', 'POD_PENDING', 'UNBILLED', 'BILLED'];
const QTY_RE = /^\d{1,11}(\.\d{1,3})?$/;
/** MD-222: ข้อความเหตุผลรวม ≥ 10 ตัวอักษร (ชื่อเหตุผล + โน้ต) */
const REASON_MIN = 10;

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

/**
 * ST4-T11 ตีกลับบางส่วน/ทั้งหมด (docs/04 E2 "จาก actual qty → สร้างงานส่งซ้ำหรือคืนคลัง"; docs/01 §4.3) [DECISION spec/12 §3]
 *
 * - **DO ส่งแล้ว** (DELIVERED/POD_PENDING/UNBILLED/BILLED) ที่หลักฐานส่งมีปฏิเสธรับ (ST4-T10): ใบเดิม**คงสถานะ** (วางบิลตามยอดส่งจริง)
 *   · ส่งซ้ำ = DO ใหม่ DRAFT นอกเที่ยว เฉพาะปริมาณที่ปฏิเสธ (อ้าง `redelivery_of` + `rejected_from`) · คืนคลัง = `returned_qty`
 *   · ทำได้ไม่เกินยอดปฏิเสธคงเหลือ (กดซ้ำ/ทำพร้อมกัน → 422 / If-Match → 412)
 * - **DO ส่งไม่สำเร็จ** (FAILED) ทั้งใบ: ส่งซ้ำ = ใบเดิม CANCELLED + DO ใหม่ (ทางเดียวกับ ST4-T12 แบบมือ — ไม่คืนเองเมื่อผลถูกพลิก)
 *   · คืนคลัง = FAILED → RETURNED
 * - ทุกครั้ง: เหตุผลจาก reason master + โน้ต (ธงบังคับโน้ต/รูป) + audit · ใบสั่งไล่สถานะตาม DO (ส่งครบแล้ว → ส่งบางส่วน)
 * - ล็อกลำดับเดียวกับ projection ของเที่ยว (SO → DO → trip) กันชนกับนัดส่งใหม่อัตโนมัติ
 */
@Injectable()
export class DeliveryOrderReturnService {
  constructor(
    private readonly db: DbService,
    private readonly dos: DeliveryOrderService,
    private readonly projection: StopProjectionService,
    private readonly orderState: OrderStateService,
    private readonly reasons: ReasonCodesService,
    private readonly clock: Clock,
  ) {}

  async redeliver(
    id: string,
    input: ResolveInput,
    expectedVersion?: number,
  ): Promise<{ source: DeliveryOrderRecord; redelivery: DeliveryOrderRecord }> {
    const tx = this.db.tx;
    const doDate = this.doDate(input.doDate);
    const p = await this.prepare(tx, id, input, expectedVersion);
    let redelivery: DeliveryOrderRecord;
    if (p.mode === 'failed') {
      redelivery = await this.dos.redeliver(tx, p.src.id, {
        doDate,
        rescheduleCount: p.src.rescheduleCount,
        reasonCodeId: p.reasonCodeId,
        note: p.reason,
        mode: 'manual',
      });
      if (p.src.tripId) await this.projection.project(tx, p.src.tripId);
    } else {
      redelivery = await this.dos.redeliverRejected(tx, p.src, p.take, {
        doDate,
        reasonCodeId: p.reasonCodeId,
        reason: p.reason,
        before: p.before,
      });
    }
    await this.orderState.syncFromDeliveryOrders(
      tx,
      [p.src.salesOrderId],
      new Map([[p.src.salesOrderId, `ส่งซ้ำ ${redelivery.doNo} — ${p.reason}`]]),
    );
    return {
      source: await this.dos.get(p.src.id, tx),
      redelivery: await this.dos.get(redelivery.id, tx),
    };
  }

  async return(
    id: string,
    input: ResolveInput,
    expectedVersion?: number,
  ): Promise<DeliveryOrderRecord> {
    const tx = this.db.tx;
    if (input.doDate !== undefined)
      throw field422('doDate', 'not_applicable', 'doDate is for redelivery only');
    const p = await this.prepare(tx, id, input, expectedVersion);
    if (p.mode === 'failed') {
      await this.dos.returnFailed(tx, p.src, { reasonCodeId: p.reasonCodeId, reason: p.reason });
      if (p.src.tripId) await this.projection.project(tx, p.src.tripId);
    } else {
      await this.dos.returnRejected(tx, p.src, p.take, {
        reasonCodeId: p.reasonCodeId,
        reason: p.reason,
        before: p.before,
      });
    }
    await this.orderState.syncFromDeliveryOrders(tx, [p.src.salesOrderId]);
    return this.dos.get(p.src.id, tx);
  }

  // ---------------------------------------------------------------------------------------------

  private doDate(v: string | undefined): string {
    const today = bangkokToday(this.clock.now());
    if (v === undefined) return today;
    if (!isRealDate(v))
      throw field422('doDate', 'invalid_date', 'must be a real date (YYYY-MM-DD)');
    if (v < today)
      throw field422('doDate', 'date_in_past', 'must not be before today (Asia/Bangkok)');
    return v;
  }

  private async prepare(tx: Tx, id: string, input: ResolveInput, expectedVersion?: number) {
    const head = await this.dos.get(id, tx);
    // ลำดับล็อกเดียวกับ projection ของเที่ยว (SO → DO → trip) — กันชนกับนัดส่งใหม่อัตโนมัติ/ปิดจุด
    if (head.tripId) await this.projection.lockTrip(tx, head.tripId);
    else await this.dos.lockForTrip(tx, [id]);
    const src = await this.dos.get(id, tx);
    if (expectedVersion !== undefined && src.version !== expectedVersion)
      throw new ProblemException('precondition_failed');
    const mode =
      src.status === 'FAILED' ? 'failed' : DELIVERED_SET.includes(src.status) ? 'rejected' : null;
    if (!mode)
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        deliveryOrderId: src.id,
        doNo: src.doNo,
        from: src.status,
      });
    // ใบสั่งปิดแล้ว (วางบิลครบ — ST5) เปิดงานส่งซ้ำไม่ได้
    const so = await tx.salesOrder.findUniqueOrThrow({
      where: { id: src.salesOrderId },
      select: { status: true },
    });
    if (so.status === 'CLOSED' || so.status === 'CANCELLED')
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        orderStatus: so.status,
      });

    const snap = await this.reasons.snapshotFor(
      input.reasonCodeId,
      mode === 'failed' ? 'DELIVERY_FAILED' : 'REJECTED_BY_RECEIVER',
    );
    const note = cleanLine(String(input.note ?? '')).trim();
    if (snap.flags.requiresNote && !note)
      throw field422('note', 'note_required', 'this reason requires a note');
    const reason = note ? `${snap.label} — ${note}` : snap.label;
    if (reason.length < REASON_MIN)
      throw field422(
        'note',
        'too_short',
        `reason + note must be at least ${REASON_MIN} characters`,
      );
    if (mode === 'failed' && input.lines?.length)
      throw field422('lines', 'not_applicable', 'a failed delivery order is resolved as a whole');
    const balance =
      mode === 'rejected' ? (await this.dos.rejectionBalance(tx, [src])).get(src.id)! : [];
    const take = mode === 'rejected' ? pickLines(balance, input.lines) : [];
    if (snap.flags.requiresPhoto) {
      // รูปของหลักฐานส่ง (ฉบับล่าสุด) — ไม่มีปุ่มแนบรูปแยก (spec/12 §3 ST4-T10/T11)
      const pod = await tx.deliveryOrderPod.findFirst({
        where: { deliveryOrderId: src.id },
        orderBy: { version: 'desc' },
        select: { photoDocumentIds: true },
      });
      if (!pod?.photoDocumentIds.length)
        throw field422('reasonCodeId', 'photo_required', 'this reason requires a POD photo');
    }
    if (mode === 'failed')
      return { mode, src, reasonCodeId: snap.sourceId, reason, take, before: null };
    return {
      mode,
      src,
      reasonCodeId: snap.sourceId,
      reason,
      take,
      before: balance.map((b) => ({
        lineNo: b.line.lineNo,
        reject: fmt(b.reject),
        redelivered: fmt(b.redelivered),
        returned: fmt(b.returned),
      })),
    };
  }
}

const fmt = (v: Prisma.Decimal) => v.toFixed(3).replace(/\.?0+$/, '') || '0';

/** บรรทัด + ปริมาณที่จะจัดการ — ไม่ส่ง = ทุกบรรทัดที่ยังปฏิเสธคงเหลือ (ทั้งจำนวน) */
function pickLines(
  balance: RejectionLine[],
  lines: { lineNo: number; qty: string }[] | undefined,
): { lineId: string; qty: Prisma.Decimal }[] {
  if (!lines?.length) {
    const all = balance.filter((b) => b.open.gt(0));
    if (!all.length)
      throw field422('lines', 'nothing_open', 'no rejected quantity left to redeliver or return');
    return all.map((b) => ({ lineId: b.line.id, qty: b.open }));
  }
  const errors: { field: string; code: string; message: string }[] = [];
  const seen = new Set<number>();
  const out: { lineId: string; qty: Prisma.Decimal }[] = [];
  lines.forEach((l, i) => {
    const b = balance.find((x) => x.line.lineNo === l.lineNo);
    if (!b)
      return errors.push({
        field: `lines.${i}.lineNo`,
        code: 'unknown_line',
        message: 'line not found',
      });
    if (seen.has(l.lineNo))
      return errors.push({
        field: `lines.${i}.lineNo`,
        code: 'duplicate',
        message: 'line listed twice',
      });
    seen.add(l.lineNo);
    if (!QTY_RE.test(l.qty) || new Prisma.Decimal(l.qty).lte(0))
      return errors.push({
        field: `lines.${i}.qty`,
        code: 'invalid',
        message: 'quantity must be > 0',
      });
    const q = new Prisma.Decimal(l.qty);
    if (q.gt(b.open))
      return errors.push({
        field: `lines.${i}.qty`,
        code: 'exceeds_open',
        message: `exceeds the open rejected quantity (${fmt(b.open)})`,
      });
    out.push({ lineId: b.line.id, qty: q });
  });
  if (errors.length) throw new ProblemException('validation_failed', undefined, errors);
  return out;
}
