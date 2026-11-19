import { Injectable } from '@nestjs/common';
import { BILLING_REVERT_RULES, revertDeliveryWindow, scopeAllows } from '@tms/domain';
import { Clock } from '../../common/clock';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { assertDeliveryUnlocked } from '../invoices/billing-lock';
import { cleanLine } from '../master/master-kit';
import { OrderStateService } from '../orders/order-state.service';
import { ReasonCodesService } from '../reason-codes/reason-codes.service';
import { StopProjectionService } from '../stops/stop-projection.service';
import { DeliveryOrderService, type DeliveryOrderRecord } from './delivery-order.service';

/** สถานะ DO ในขั้น DELIVERED ของ F4 (ส่งถึงแล้ว ยังไม่วางบิล) */
const REVERTIBLE = ['DELIVERED', 'POD_PENDING', 'UNBILLED'];
const RULE = BILLING_REVERT_RULES.DELIVERED!;

const conflict = (
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
  detail?: string,
) =>
  new ProblemException(
    'invalid_state_transition',
    detail,
    [{ field: 'deliveryOrderId', code, message }],
    extra,
  );
/** เที่ยวที่ปิดต้นทุนแล้ว — ต้นทุนปันลง DO แล้ว (ST4-T15) ย้อนผลส่งไม่ได้ [DECISION spec/12 §3; OPEN การปันใหม่] */
const COSTED_TRIPS = ['COSTED', 'SETTLED'];

/**
 * ST5-T06 ย้อนผลส่งถึง (docs/04 F4 แถว DELIVERED "ย้อนได้โดย Dispatcher (ภายใน 24 ชม.) / Admin") [DECISION spec/12 §3]
 *
 * - สิทธิ์: `trips:close` (A3 Trip "ปิด" — Dispatcher) ภายใน 24 ชม. นับจากเวลาที่ DO เป็นส่งถึง (ประวัติสถานะ event `deliver`,
 *   เวลาเซิร์ฟเวอร์ — Clock) · เกิน 24 ชม. ต้องมี `deliveries:revert` (owner/admin — F4 "Admin") ไม่งั้น 403 `permission_denied`
 *   (`reason: revert_window_expired` + `deliveredAt` / `revertDeadline`)
 * - เงื่อนไข: DO ส่งถึง (DELIVERED/POD_PENDING/UNBILLED) · ไม่อยู่ในใบแจ้งหนี้ (`do_in_invoice`) · ไม่เคยถูกลดหนี้ (`do_credited`) ·
 *   ยังไม่ส่งบัญชี (`do_released` — Invoicer ย้อนการส่งบัญชีก่อน) · ยังไม่มีงานต่อจากยอดปฏิเสธรับ (ส่งซ้ำ/คืนคลัง — `has_followups`) ·
 *   เที่ยวยังไม่ปิดต้นทุน (COSTED/SETTLED → `trip_costed` — ต้นทุนปันลง DO แล้ว) ·
 *   ใบสั่งไม่ปิด/ยกเลิก → ไม่ผ่าน = 409 `invalid_state_transition` + `errors[].code`
 * - ผล: DO → FAILED (`revert_delivery`) + เหตุผล ≥ 10 ตัวอักษร (+ reason code หมวด DELIVERY_FAILED ไม่บังคับ) + audit
 *   `delivery_order.delivery_reverted` · ใบสั่งไล่ตาม DO (ส่งครบ → ส่งบางส่วน) · จัดการต่อด้วยส่งซ้ำ/คืนคลัง (ST4-T11)
 * - ล็อกลำดับเดียวกับ projection ของเที่ยว (SO → DO → trip) · If-Match ไม่ตรง → 412
 */
@Injectable()
export class DeliveryOrderRevertService {
  constructor(
    private readonly db: DbService,
    private readonly dos: DeliveryOrderService,
    private readonly projection: StopProjectionService,
    private readonly orderState: OrderStateService,
    private readonly reasons: ReasonCodesService,
    private readonly clock: Clock,
  ) {}

  async revertDelivery(
    id: string,
    input: { reason: string; reasonCodeId?: string | null },
    expectedVersion?: number,
  ): Promise<DeliveryOrderRecord> {
    const tx = this.db.tx;
    const ctx = requestContext.require();
    const reason = cleanLine(String(input.reason ?? '')).trim();
    if ([...reason].length < 10)
      throw new ProblemException('validation_failed', undefined, [
        { field: 'reason', code: 'too_short', message: 'reason must be at least 10 characters' },
      ]);
    const head = await this.dos.get(id, tx);
    if (head.tripId) await this.projection.lockTrip(tx, head.tripId);
    else await this.dos.lockForTrip(tx, [id]);
    const d = await this.dos.get(id, tx);
    if (expectedVersion !== undefined && d.version !== expectedVersion)
      throw new ProblemException('precondition_failed');

    const extra = { doNo: d.doNo, doStatus: d.status, billingStatus: d.billingStatus };
    assertDeliveryUnlocked(d);
    if (d.billingStatus === 'CREDITED')
      throw conflict('do_credited', 'delivery order was invoiced and credited', extra);
    if (!REVERTIBLE.includes(d.status))
      throw conflict('not_delivered', `delivery order is ${d.status}`, extra);
    const so = await tx.salesOrder.findUniqueOrThrow({
      where: { id: d.salesOrderId },
      select: { status: true },
    });
    if (so.status === 'CLOSED' || so.status === 'CANCELLED')
      throw conflict('order_closed', `order is ${so.status}`, { ...extra, orderStatus: so.status });
    if (d.tripId) {
      const trip = await tx.trip.findUniqueOrThrow({
        where: { id: d.tripId },
        select: { status: true, tripNo: true },
      });
      if (COSTED_TRIPS.includes(trip.status))
        throw conflict(
          'trip_costed',
          `trip is ${trip.status}`,
          { ...extra, tripNo: trip.tripNo, tripStatus: trip.status },
          'เที่ยวนี้ปิดต้นทุนแล้ว (ต้นทุนปันลงใบส่งของแล้ว) — ย้อนผลส่งถึงไม่ได้',
        );
    }
    const kids = await tx.deliveryOrder.count({
      where: { rejectedFromId: d.id, status: { not: 'CANCELLED' } },
    });
    if (kids > 0 || d.lines.some((l) => l.returnedQty.gt(0)))
      throw conflict(
        'has_followups',
        'rejected quantity was already redelivered or returned',
        extra,
      );

    const reasonCodeId = input.reasonCodeId
      ? (await this.reasons.snapshotFor(input.reasonCodeId, 'DELIVERY_FAILED')).sourceId
      : null;

    const deliveredAt = await this.dos.deliveredAt(tx, d.id);
    const win = deliveredAt ? revertDeliveryWindow(deliveredAt, this.clock.now()) : null;
    const within = win?.within ?? false;
    const canOverride = scopeAllows(ctx.scopes ?? [], RULE.overrideScope!);
    if (!within && !canOverride) {
      const [module, action] = RULE.overrideScope!.split(':');
      throw new ProblemException(
        'permission_denied',
        'ย้อนผลส่งถึงได้ภายใน 24 ชม. — เกินแล้วต้องให้ผู้ดูแลระบบทำ',
        undefined,
        {
          module,
          action,
          required: [RULE.overrideScope],
          reason: 'revert_window_expired',
          deliveredAt: deliveredAt?.toISOString() ?? null,
          revertDeadline: win?.deadline.toISOString() ?? null,
        },
      );
    }

    await this.dos.revertDelivery(tx, d, {
      reason,
      reasonCodeId,
      deliveredAt,
      deadline: win?.deadline ?? null,
      override: !within,
    });
    await this.orderState.syncFromDeliveryOrders(
      tx,
      [d.salesOrderId],
      new Map([[d.salesOrderId, `ย้อนผลส่งถึง ${d.doNo} — ${reason}`]]),
    );
    return this.dos.get(d.id, tx);
  }
}
