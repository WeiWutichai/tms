import { Injectable, OnModuleInit } from '@nestjs/common';
import { encodeId } from '../../common/ids';
import { requestContext } from '../../common/request-context';
import type { Tx } from '../../db/db.service';
import { StateService } from '../../state/state.service';
import { NotificationService } from './notification.service';

/** ผู้ขอเอง (ผู้ใช้ที่ login) ไม่ต้องได้แจ้งเตือนของสิ่งที่ตัวเองเพิ่งทำ */
function selfExclude(): string[] {
  const ctx = requestContext.get();
  return ctx?.principalType === 'user' && ctx.actorId ? [ctx.actorId] : [];
}

/**
 * ต่อ event P0 ของศูนย์แจ้งเตือน (ST9-T08; docs/04 I) — โมดูลต้นทางเรียกใน transaction ของงาน (rollback = ไม่แจ้ง)
 * ผู้รับตามสิทธิ์ของ role (รวม role กำหนดเอง) · การตั้งค่ารับต่อผู้ใช้กรองใน `NotificationService.notify`
 *
 * - ใบค้างใหม่: ฟัง `order.held` จาก StateService (ทุกทาง: ทางเข้า/รถร่วมปฏิเสธ/นัดส่งใหม่เกิน/คืนคลัง) → ผู้มี `orders:write`
 * - ขออนุมัติ: ค่าใช้จ่ายหน้างานรอยืนยัน → ฝั่งขาย `invoices:draft` · ฝั่งซื้อ `settlements:approve` (ตรงกับสิทธิ์ยืนยัน ST4-T13)
 * - connector ล่ม: connector → ERROR → ผู้ดูแลการเชื่อมต่อ `settings:write` + ผู้ส่งซ้ำ `integrations:retry`
 * - รถร่วมหมดเวลา / เอกสารใกล้หมด / webhook ถูกปิด: โมดูลเดิมเรียก notify เอง (ST3-T24, ST2-T18, ST7-T04)
 */
@Injectable()
export class NotificationEvents implements OnModuleInit {
  constructor(
    private readonly notifications: NotificationService,
    private readonly state: StateService,
  ) {}

  onModuleInit() {
    this.state.on('order.held', async (tx, e) => {
      if (e.to === 'ON_HOLD') await this.orderHeld(tx, e.tenantId, e.docId);
    });
  }

  async orderHeld(tx: Tx, tenantId: string, orderId: string): Promise<void> {
    const so = await tx.salesOrder.findUnique({
      where: { id: orderId },
      select: {
        soNo: true,
        customerText: true,
        customer: { select: { legalName: true } },
        holdReasonCode: { select: { code: true, labelTh: true } },
      },
    });
    if (!so) return;
    await this.notifications.notify(tx, {
      tenantId,
      to: { permissions: ['orders:write'], exclude: selfExclude() },
      template: 'order.held',
      vars: {
        orderNo: so.soNo ?? encodeId('salesOrder', orderId),
        customer: so.customer?.legalName ?? so.customerText ?? '-',
        reasonCode: so.holdReasonCode?.code ?? '-',
        reason: so.holdReasonCode?.labelTh ?? '-',
      },
      link: '/so/hold',
      entity: { type: 'order', id: encodeId('salesOrder', orderId) },
    });
  }

  async fieldChargePending(
    tx: Tx,
    input: { tenantId: string; tripId: string; item: string; sell: boolean; buy: boolean },
  ): Promise<void> {
    const trip = await tx.trip.findUnique({
      where: { id: input.tripId },
      select: { tripNo: true },
    });
    const tripId = encodeId('trip', input.tripId);
    await this.notifications.notify(tx, {
      tenantId: input.tenantId,
      to: {
        permissions: [
          ...(input.sell ? ['invoices:draft'] : []),
          ...(input.buy ? ['settlements:approve'] : []),
        ],
        exclude: selfExclude(),
      },
      template: 'field_charge.pending',
      vars: {
        tripNo: trip?.tripNo ?? tripId,
        item: input.item,
        side: input.sell && input.buy ? 'BOTH' : input.sell ? 'SELL' : 'BUY',
      },
      link: `/plan?trip=${tripId}`,
      entity: { type: 'trip', id: tripId },
    });
  }

  async connectorDown(
    tx: Tx,
    input: { tenantId: string; connectorId: string; label: string; code: string },
  ): Promise<void> {
    await this.notifications.notify(tx, {
      tenantId: input.tenantId,
      to: { permissions: ['settings:write', 'integrations:retry'] },
      template: 'connector.error',
      vars: { label: input.label, code: input.code },
      link: '/settings?sec=conn',
      entity: { type: 'connector', id: encodeId('connector', input.connectorId) },
    });
  }
}
