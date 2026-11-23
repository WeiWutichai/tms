import { safeName } from '../../common/safe-text';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
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

/** ใบค้างที่เกิดระหว่างงานทีละมาก (นำเข้า / ดึงจาก connector) — เก็บไว้แจ้งรวมครั้งเดียวตอนจบ */
const holdBatch = new AsyncLocalStorage<{ ids: Set<string> }>();
/** ตัวอย่างเลขใบในข้อความรวม */
const BATCH_SAMPLE = 5;
let savepointSeq = 0;

/**
 * ต่อ event P0 ของศูนย์แจ้งเตือน (ST9-T08; docs/04 I) — โมดูลต้นทางเรียกใน transaction ของงาน (rollback = ไม่แจ้ง)
 * ผู้รับตามสิทธิ์ของ role (รวม role กำหนดเอง) · การตั้งค่ารับต่อผู้ใช้กรองใน `NotificationService.notify`
 * **แจ้งไม่สำเร็จไม่ย้อนงานหลัก**: ทุกการแจ้งอยู่ใน SAVEPOINT ของตัวเอง — ล้ม (เช่น ผู้รับเกินเพดาน) = ย้อนเฉพาะการแจ้ง + log
 *
 * - ใบค้างใหม่: ฟัง `order.held` จาก StateService (ทางเข้า/นัดส่งใหม่เกิน/คืนคลัง) → ผู้มี `orders:write`
 *   ระหว่าง `batchOrderHolds()` (นำเข้าไฟล์ / ดึงจาก connector) เก็บไว้ แล้ว `flushOrderHolds()` แจ้งรวม "ใบค้างใหม่ N ใบ" ครั้งเดียว
 * - รถร่วมปฏิเสธ (ใบค้าง CARRIER_REJECTED): อยู่ใต้ event รถร่วมปฏิเสธหรือหมดเวลา → ผู้มี `trips:assign`
 *   (ข้อเสนอหมดเวลา 48 ชม. แจ้ง `subcon_offer.expired` จาก ST3-T24 อยู่แล้ว — ไม่แจ้งซ้ำ)
 * - ขออนุมัติ: ค่าใช้จ่ายหน้างานรอยืนยัน → ฝั่งขาย `invoices:draft` · ฝั่งซื้อ `settlements:approve` (ข้อความตามฝั่งที่ผู้รับยืนยันได้)
 * - connector ล่ม: connector → ERROR → ผู้ดูแลการเชื่อมต่อ `settings:write` + ผู้ส่งซ้ำ `integrations:retry`
 * - รถร่วมหมดเวลา / เอกสารใกล้หมด / webhook ถูกปิด: โมดูลเดิมเรียก notify เอง (ST3-T24, ST2-T18, ST7-T04)
 */
@Injectable()
export class NotificationEvents implements OnModuleInit {
  private readonly logger = new Logger('NotificationEvents');

  constructor(
    private readonly notifications: NotificationService,
    private readonly state: StateService,
  ) {}

  onModuleInit() {
    this.state.on('order.held', async (tx, e) => {
      if (e.to !== 'ON_HOLD') return;
      const batch = holdBatch.getStore();
      if (batch) return void batch.ids.add(e.docId);
      await this.orderHeld(tx, e.tenantId, e.docId);
    });
  }

  /** รันงานทีละมาก — ใบค้างที่เกิดข้างในไม่แจ้งทีละใบ คืน id ไว้ให้ `flushOrderHolds` */
  async batchOrderHolds<T>(fn: () => Promise<T>): Promise<{ value: T; held: string[] }> {
    const store = { ids: new Set<string>() };
    const value = await holdBatch.run(store, fn);
    return { value, held: [...store.ids] };
  }

  /**
   * แจ้งใบค้างจากงานทีละมาก: เฉพาะใบที่ยัง ON_HOLD (ใบในขั้นตรวจ/savepoint ที่ย้อนทิ้งหลุดไปเอง)
   * 1 ใบ = ข้อความปกติ · หลายใบ = "ใบค้างใหม่ N ใบ" ฉบับเดียว · ใบ CARRIER_REJECTED แจ้งแยกตาม event รถร่วม
   */
  async flushOrderHolds(tx: Tx, tenantId: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const rows = await tx.salesOrder.findMany({
      where: { id: { in: ids }, status: 'ON_HOLD' },
      select: { id: true, soNo: true, holdReasonCode: { select: { code: true } } },
      orderBy: { soNo: 'asc' },
    });
    const normal = rows.filter((r) => r.holdReasonCode?.code !== 'CARRIER_REJECTED');
    for (const r of rows.filter((x) => x.holdReasonCode?.code === 'CARRIER_REJECTED'))
      await this.orderHeld(tx, tenantId, r.id);
    if (normal.length === 1) return this.orderHeld(tx, tenantId, normal[0]!.id);
    if (!normal.length) return;
    const counts = new Map<string, number>();
    for (const r of normal) {
      const c = r.holdReasonCode?.code ?? '-';
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    await this.safely(tx, 'order.held_batch', () =>
      this.notifications.notify(tx, {
        tenantId,
        to: { permissions: ['orders:write'], exclude: selfExclude() },
        template: 'order.held_batch',
        vars: {
          count: normal.length,
          orderNos: normal
            .slice(0, BATCH_SAMPLE)
            .map((r) => r.soNo ?? encodeId('salesOrder', r.id)),
          reasons: [...counts.entries()].map(([code, n]) => `${code} ${n}`).join(', '),
        },
        link: '/so/hold',
      }),
    );
  }

  async orderHeld(tx: Tx, tenantId: string, orderId: string): Promise<void> {
    const so = await tx.salesOrder.findUnique({
      where: { id: orderId },
      select: {
        soNo: true,
        customerText: true,
        holdNote: true,
        customer: { select: { legalName: true } },
        holdReasonCode: { select: { code: true, labelTh: true } },
      },
    });
    if (!so) return;
    const orderNo = so.soNo ?? encodeId('salesOrder', orderId);
    const customer = so.customer?.legalName ?? so.customerText ?? '-';
    if (so.holdReasonCode?.code === 'CARRIER_REJECTED') {
      // หมดเวลา 48 ชม. → ST3-T24 แจ้ง subcon_offer.expired แล้ว (ข้อเสนอล่าสุดของเที่ยวเป็น EXPIRED)
      const last = await tx.subconOffer.findFirst({
        where: { trip: { deliveryOrders: { some: { salesOrderId: orderId } } } },
        orderBy: { createdAt: 'desc' },
        select: { status: true },
      });
      if (last?.status === 'EXPIRED') return;
      return this.safely(tx, 'subcon_offer.rejected', () =>
        this.notifications.notify(tx, {
          tenantId,
          to: { permissions: ['trips:assign'], exclude: selfExclude() },
          template: 'subcon_offer.rejected',
          vars: { orderNo, customer, note: so.holdNote ?? '-' },
          link: '/so/hold',
          entity: { type: 'order', id: encodeId('salesOrder', orderId) },
        }),
      );
    }
    await this.safely(tx, 'order.held', () =>
      this.notifications.notify(tx, {
        tenantId,
        to: { permissions: ['orders:write'], exclude: selfExclude() },
        template: 'order.held',
        vars: {
          orderNo,
          customer,
          reasonCode: so.holdReasonCode?.code ?? '-',
          reason: so.holdReasonCode?.labelTh ?? '-',
        },
        link: '/so/hold',
        entity: { type: 'order', id: encodeId('salesOrder', orderId) },
      }),
    );
  }

  /**
   * ST8-T05 ต้นทางยกเลิกใบสั่งที่มี DO แล้ว (TMS ไม่ยกเลิกเอง — docs/01 A.4) → ผู้ดูแลใบสั่ง `orders:write` + ผู้จัดรถ `trips:assign`
   */
  async orderSourceCancelled(
    tx: Tx,
    input: { tenantId: string; orderId: string; source: string },
  ): Promise<void> {
    const so = await tx.salesOrder.findUnique({
      where: { id: input.orderId },
      select: { soNo: true, customerText: true, customer: { select: { legalName: true } } },
    });
    if (!so) return;
    await this.safely(tx, 'order.source_cancelled', () =>
      this.notifications.notify(tx, {
        tenantId: input.tenantId,
        to: { permissions: ['orders:write', 'trips:assign'], exclude: selfExclude() },
        template: 'order.source_cancelled',
        vars: {
          orderNo: so.soNo ?? encodeId('salesOrder', input.orderId),
          customer: so.customer?.legalName ?? so.customerText ?? '-',
          source: input.source,
        },
        link: '/so',
        entity: { type: 'order', id: encodeId('salesOrder', input.orderId) },
      }),
    );
  }

  /** ข้อความตามฝั่งที่ผู้รับยืนยันได้: มีสิทธิ์ทั้งสองฝั่ง = "ฝั่งขายและฝั่งซื้อ" · ฝั่งเดียว = ฝั่งนั้น */
  async fieldChargePending(
    tx: Tx,
    input: { tenantId: string; tripId: string; item: string; sell: boolean; buy: boolean },
  ): Promise<void> {
    const trip = await tx.trip.findUnique({
      where: { id: input.tripId },
      select: { tripNo: true },
    });
    const tripId = encodeId('trip', input.tripId);
    const exclude = selfExclude();
    const ids = async (perm: string, on: boolean) =>
      on
        ? new Set(
            (
              await this.notifications.resolve(tx, input.tenantId, { permissions: [perm], exclude })
            ).map((u) => u.id),
          )
        : new Set<string>();
    const sellers = await ids('invoices:draft', input.sell);
    const buyers = await ids('settlements:approve', input.buy);
    const groups: Record<'SELL' | 'BUY' | 'BOTH', string[]> = { SELL: [], BUY: [], BOTH: [] };
    for (const u of new Set([...sellers, ...buyers]))
      groups[sellers.has(u) && buyers.has(u) ? 'BOTH' : sellers.has(u) ? 'SELL' : 'BUY'].push(u);
    for (const side of ['SELL', 'BUY', 'BOTH'] as const) {
      if (!groups[side].length) continue;
      await this.safely(tx, 'field_charge.pending', () =>
        this.notifications.notify(tx, {
          tenantId: input.tenantId,
          to: { userIds: groups[side] },
          template: 'field_charge.pending',
          vars: { tripNo: trip?.tripNo ?? tripId, item: input.item, side },
          link: `/plan?trip=${tripId}`,
          entity: { type: 'trip', id: tripId },
        }),
      );
    }
  }

  /**
   * ST6-T06 ใบสำคัญจ่ายรถร่วมเข้า DISPUTED (docs/04 I "dispute") → ผู้เตรียมใบ (`settlements:create`) ยกเว้นผู้ทำเอง ·
   * ไม่ใส่ยอดเงิน (สิทธิ์เห็นราคาซื้อแยก) · ยังไม่มีหน้า settle — ไม่มีลิงก์ในแจ้งเตือน (spec/12 §3 แถว ST6-T07)
   */
  async settlementDisputed(
    tx: Tx,
    input: { tenantId: string; settlementId: string; carrier: string; ref: string; count: number },
  ): Promise<void> {
    await this.safely(tx, 'settlement.disputed', () =>
      this.notifications.notify(tx, {
        tenantId: input.tenantId,
        to: { permissions: ['settlements:create'], exclude: selfExclude() },
        template: 'settlement.disputed',
        vars: { carrier: input.carrier, ref: input.ref, count: input.count },
        entity: { type: 'settlement', id: encodeId('settlement', input.settlementId) },
      }),
    );
  }

  async connectorDown(
    tx: Tx,
    input: { tenantId: string; connectorId: string; label: string; code: string },
  ): Promise<void> {
    await this.safely(tx, 'connector.error', () =>
      this.notifications.notify(tx, {
        tenantId: input.tenantId,
        to: { permissions: ['settings:write', 'integrations:retry'] },
        template: 'connector.error',
        vars: { label: input.label, code: input.code },
        link: '/settings?sec=conn',
        entity: { type: 'connector', id: encodeId('connector', input.connectorId) },
      }),
    );
  }

  /** ST8-T03 connector กลับมาทำงานเอง (ERROR จากปลายทางล่ม → ACTIVE เมื่อปลายทางตอบอีกครั้ง) — ผู้รับเดียวกับ connector ล่ม */
  async connectorRecovered(
    tx: Tx,
    input: { tenantId: string; connectorId: string; label: string },
  ): Promise<void> {
    await this.safely(tx, 'connector.recovered', () =>
      this.notifications.notify(tx, {
        tenantId: input.tenantId,
        to: { permissions: ['settings:write', 'integrations:retry'] },
        template: 'connector.recovered',
        vars: { label: input.label },
        link: '/settings?sec=conn',
        entity: { type: 'connector', id: encodeId('connector', input.connectorId) },
      }),
    );
  }

  /**
   * D-81 · D68-61 รอบกระทบยอดพบส่วนต่างใหม่ (docs/01 §6.5 "severity `MONEY` แจ้งหัวหน้าบัญชีทันที (email + LINE) และสรุป 08:00")
   * → ผู้ดูแลรับชำระ `payments:record` (owner/admin/manager/บัญชี — คนแก้ต้นเหตุ: บันทึก/กลับรายการรับชำระ) 1 ฉบับต่อรอบต่อ connector
   * · ส่วนต่างเดิมที่ยังเปิดไม่นับ (diff_hash — `recordPaymentMismatch` คืน created=false) → รอบถัดไปไม่แจ้งซ้ำ · ไม่ใส่ยอดเงิน
   * · LINE ทีมภายใน = P1 (docs/04 I) — ตอนนี้ในระบบ + อีเมล
   */
  async reconcileMismatch(
    tx: Tx,
    input: {
      tenantId: string;
      connectorId: string;
      label: string;
      invoiceNos: string[];
      count: number;
    },
  ): Promise<void> {
    if (input.count <= 0) return;
    await this.safely(tx, 'reconcile.mismatch_found', () =>
      this.notifications.notify(tx, {
        tenantId: input.tenantId,
        to: { permissions: ['payments:record'] },
        template: 'reconcile.mismatch_found',
        vars: {
          label: input.label,
          count: input.count,
          invoiceNos: input.invoiceNos.slice(0, BATCH_SAMPLE),
        },
        link: '/settings?sec=conn',
        entity: { type: 'connector', id: encodeId('connector', input.connectorId) },
      }),
    );
  }

  /**
   * ST7-T20 ทีม Innovera เปลี่ยน connector (credential/สถานะ) จาก Platform Console → แจ้ง owner ทุกคน ในระบบ + อีเมล
   * (สอดคล้องกับเข้าใช้งานแทน — docs/04 A6 "อีเมลแจ้ง tenant owner ทุกครั้ง") [DECISION spec/12 §3]
   */
  async connectorChangedByPlatform(
    tx: Tx,
    input: {
      tenantId: string;
      connectorId: string;
      label: string;
      action: 'created' | 'credentials' | 'resumed' | 'paused' | 'error' | 'recovered';
      reason: string;
    },
  ): Promise<void> {
    await this.safely(tx, 'connector.platform_changed', () =>
      this.notifications.notify(tx, {
        tenantId: input.tenantId,
        to: { roles: ['owner'] },
        template: 'connector.platform_changed',
        vars: { label: input.label, action: input.action, reason: safeName(input.reason, 300) },
        link: '/settings?sec=conn',
        entity: { type: 'connector', id: encodeId('connector', input.connectorId) },
      }),
    );
  }

  /** แจ้งใน SAVEPOINT — ล้มแล้วย้อนเฉพาะการแจ้ง (transaction ของงานหลักใช้ต่อได้) + log */
  private async safely(tx: Tx, what: string, fn: () => Promise<unknown>): Promise<void> {
    const sp = `tms_notify_${++savepointSeq}`;
    await tx.$executeRawUnsafe(`SAVEPOINT ${sp}`);
    try {
      await fn();
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
    } catch (e) {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
      this.logger.warn(`notify ${what} skipped (business change kept): ${String(e)}`);
    }
  }
}
