import { Injectable } from '@nestjs/common';
import type { SoStatus as DbSoStatus } from '@prisma/client';
import { SO_TRANSITIONS, transition, type SoEvent, type SoStatus } from '@tms/domain';
import { ProblemException } from '../../common/problem';
import type { Tx } from '../../db/db.service';
import { StateService } from '../../state/state.service';
import { ON_ACTIVE_TRIP_WHERE } from '../delivery-orders/delivery-order.service';
import { OrderIntakeService } from './order-intake.service';

const ENTITY = 'sales_order';
/** DO ที่ออกรถแล้วแต่ยังไม่จบการส่ง */
const MOVING = new Set(['DISPATCHED', 'PICKED_UP']);

/**
 * สถานะ SO ตาม DO (ST3-T11; docs/01 §4.1) — **ทางเดียว** นอกทางเข้า (OrderIntakeService) ที่เปลี่ยนสถานะ sales_order
 * (test `order-intake` call path อนุญาตไฟล์นี้) · ผู้เรียกต้องถือล็อก SO แล้ว (ลำดับ SO → DO → trip)
 *
 * - RECEIVED/ON_HOLD + มี DO อยู่ในเที่ยวที่ยังใช้ → `plan` → PLANNED (เคลียร์เหตุค้าง — §4.1 "ON_HOLD → PLANNED คนจัดรถให้โดยตรง")
 * - PLANNED + มี DO ออกรถแล้ว → `dispatch` → IN_TRANSIT ("trip ของ DO แรก DISPATCHED")
 * - PLANNED + ไม่มี DO ในเที่ยวแล้ว (ถอด/ยกเลิกเที่ยว) → `unplan` → RECEIVED แล้วประเมินใบค้างใหม่ (`reevaluate` — เช่น RATE_MISSING กลับมา)
 * - IN_TRANSIT + ไม่มี DO ที่ออกรถแล้ว (ยกเลิกเที่ยวที่ปล่อยแล้วก่อนรับของ) → `recall` → PLANNED (→ `unplan` ถ้าไม่มี DO ในเที่ยว)
 * - ส่งแล้ว/ส่งบางส่วน (ST4) — ยังไม่แตะ
 */
@Injectable()
export class OrderStateService {
  constructor(
    private readonly state: StateService,
    private readonly intake: OrderIntakeService,
  ) {}

  async syncFromDeliveryOrders(tx: Tx, salesOrderIds: string[]): Promise<void> {
    for (const id of [...new Set(salesOrderIds)].sort()) await this.syncOne(tx, id);
  }

  private async syncOne(tx: Tx, id: string): Promise<void> {
    const so = await tx.salesOrder.findUnique({ where: { id }, select: { status: true } });
    if (!so) return;
    const onTrip =
      (await tx.deliveryOrder.count({ where: { salesOrderId: id, ...ON_ACTIVE_TRIP_WHERE } })) > 0;
    const moving =
      (await tx.deliveryOrder.count({
        where: { salesOrderId: id, status: { in: [...MOVING] as never[] } },
      })) > 0;
    let status = so.status as SoStatus;
    const events: SoEvent[] = [];
    const step = (e: SoEvent) => {
      events.push(e);
      status = transition(ENTITY, SO_TRANSITIONS, status, e);
    };
    if ((status === 'RECEIVED' || status === 'ON_HOLD') && onTrip) step('plan');
    if (status === 'IN_TRANSIT' && !moving) step('recall');
    if (status === 'PLANNED' && moving) step('dispatch');
    else if (status === 'PLANNED' && !onTrip) step('unplan');
    let from = so.status as SoStatus;
    for (const event of events) {
      await this.state.transition<SoStatus, SoEvent>(tx, {
        docType: ENTITY,
        docId: id,
        table: SO_TRANSITIONS,
        from,
        event,
        eventType: 'order.updated',
        apply: async (next) => {
          const r = await tx.salesOrder.updateMany({
            where: { id, status: from as DbSoStatus },
            data: {
              status: next as DbSoStatus,
              ...(event === 'plan' ? { holdReasonCodeId: null, holdNote: null } : {}),
              version: { increment: 1 },
            },
          });
          if (r.count === 0) throw new ProblemException('concurrent_update');
          const after = await tx.salesOrder.findUniqueOrThrow({
            where: { id },
            select: { id: true, soNo: true, status: true, customerId: true },
          });
          return { ...after };
        },
      });
      from = transition(ENTITY, SO_TRANSITIONS, from, event);
    }
    // กลับเข้ากองงานค้างจัด → ประเมินราคา/ใบค้างใหม่ด้วยกฎทางเข้าชุดเดียว (ไม่แต่งกฎเอง)
    if (events.at(-1) === 'unplan') await this.intake.reevaluate(id, tx);
  }
}
