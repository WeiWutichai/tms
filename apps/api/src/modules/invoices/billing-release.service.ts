import { Injectable } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { ProblemException } from '../../common/problem';
import { DbService, type Tx } from '../../db/db.service';
import { cleanLine } from '../master/master-kit';
import {
  DeliveryOrderService,
  type DeliveryOrderRecord,
} from '../delivery-orders/delivery-order.service';
import { PodService } from '../pod/pod.service';
import { BillingQueueService, type NotReadyReason } from './billing-queue.service';
import { assertNotInInvoice } from './billing-lock';

export interface ReleaseOutcome {
  d: DeliveryOrderRecord;
  outcome: 'RELEASED' | 'UNCHANGED';
}

/**
 * ขั้นส่งบัญชี (RELEASED — ST5-T04; docs/04 F3 "ขั้นส่งบัญชี", F4 "RELEASED (ส่งบัญชี): Invoicer; ต้อง stop ครบ arrive+depart และ POD ครบ")
 * [DECISION spec/12 §3]: เก็บเป็น `released_at/released_by` บน DO — สถานะ DO คงตาม docs/01 §4.3 (UNBILLED) · ย้อน/ล็อกแก้ = ST5-T06
 *
 * เงื่อนไข (ภายใต้ล็อก SO → DO; กฎเดียวกับคิว `BillingQueueService.readiness`):
 * ส่งถึงแล้ว · ไม่ระงับวางบิล · ราคาพร้อม (AVAILABLE + บรรทัดรายได้ยืนยันแล้ว ไม่ล็อก ไม่มีค่าใช้จ่ายหน้างานรอยืนยัน) ·
 * จุดส่งมีเวลาถึง+ออก · ลูกค้าเปิด "ไม่มี POD ไม่วางบิล" → DO ผ่านเกณฑ์ POD แล้ว **และ** หลักฐานล่าสุดผ่าน checklist **ปัจจุบัน**
 * ไม่ครบ → 409 `not_ready_to_bill` + `reasons[]` (+ `missing[]`) · ส่งแล้ว = ไม่ทำซ้ำ (UNCHANGED)
 */
@Injectable()
export class BillingReleaseService {
  constructor(
    private readonly db: DbService,
    private readonly dos: DeliveryOrderService,
    private readonly pod: PodService,
    private readonly queue: BillingQueueService,
    private readonly clock: Clock,
  ) {}

  async release(
    id: string,
    o: { version?: number; note?: string | null },
    tx: Tx = this.db.tx,
  ): Promise<ReleaseOutcome> {
    const d = await this.dos.lockForRelease(tx, id, o.version);
    if (d.releasedAt) return { d, outcome: 'UNCHANGED' };
    const r = await this.queue.readiness(tx, d.id);
    if (!r) throw notReady(['NOT_DELIVERED'], { doStatus: d.status });
    const reasons = BillingQueueService.blockers(r);
    let missing: unknown[] | undefined;
    if (r.req_pod) {
      const now = await this.pod.checkCurrent(tx, d);
      if (!r.pod_ok || !now.ok) {
        reasons.push('POD_INCOMPLETE');
        missing = now.missing;
      }
    }
    if (reasons.length)
      throw notReady(reasons, { doStatus: d.status, ...(missing ? { missing } : {}) });
    const note = o.note ? cleanLine(o.note).trim() || null : null;
    return { d: await this.dos.markReleased(tx, d, this.clock.now(), note), outcome: 'RELEASED' };
  }

  /**
   * ST5-T06 ย้อนการส่งบัญชี (RELEASED → DELIVERED — docs/04 F4 "RELEASED ย้อนได้โดย Invoicer") [DECISION spec/12 §3]:
   * เหตุผลบังคับ (≥ 10 ตัวอักษร) + audit `delivery_order.unreleased` · DO ในร่าง → 409 `do_in_invoice` (ถอดออกจากร่างก่อน — ST5-T07)
   * · ใบออกเลขแล้ว (INVOICED) → 409 ย้อนไม่ได้ (ใบลดหนี้) · ยังไม่ส่งบัญชี = ตอบ DO เดิม (UNCHANGED ไม่ลง audit)
   */
  async unrelease(
    id: string,
    o: { version?: number; reason: string },
    tx: Tx = this.db.tx,
  ): Promise<DeliveryOrderRecord> {
    const reason = cleanLine(o.reason).trim();
    if ([...reason].length < 10)
      throw new ProblemException('validation_failed', undefined, [
        { field: 'reason', code: 'too_short', message: 'reason must be at least 10 characters' },
      ]);
    const d = await this.dos.lockForRelease(tx, id, o.version);
    assertNotInInvoice(d);
    if (!d.releasedAt) return d;
    return this.dos.markUnreleased(tx, d, reason);
  }

  /**
   * ส่งบัญชีหลาย DO — ทำทีละรายการแยกกัน (savepoint ต่อรายการ; สำเร็จบางรายการได้) เรียงตาม id (กัน deadlock) คืนผลตามลำดับคำขอ
   */
  async bulkRelease(
    items: { id: string | null; version?: number }[],
    note: string | null,
    tx: Tx = this.db.tx,
  ): Promise<({ ok: ReleaseOutcome } | { error: ProblemException })[]> {
    const out: ({ ok: ReleaseOutcome } | { error: ProblemException })[] = new Array(items.length);
    const order = items
      .map((it, i) => ({ it, i }))
      .sort((x, y) => (x.it.id ?? '').localeCompare(y.it.id ?? ''));
    for (const { it, i } of order) {
      await tx.$executeRawUnsafe('SAVEPOINT tms_do_release');
      try {
        if (!it.id) throw new ProblemException('not_found');
        out[i] = { ok: await this.release(it.id, { version: it.version, note }, tx) };
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT tms_do_release');
      } catch (e) {
        if (!(e instanceof ProblemException)) throw e;
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT tms_do_release');
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT tms_do_release');
        out[i] = { error: e };
      }
    }
    return out;
  }
}

function notReady(reasons: NotReadyReason[], extra: Record<string, unknown>): ProblemException {
  return new ProblemException('not_ready_to_bill', undefined, undefined, { reasons, ...extra });
}
