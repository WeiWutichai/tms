import { Injectable, Logger } from '@nestjs/common';
import { WEBHOOK_DELIVERY_RETENTION_DAYS, WEBHOOK_PARKED_MAX_DAYS } from '@tms/domain';
import { PrismaService } from '../../db/prisma.service';

const DAY = 24 * 60 * 60 * 1000;
const BATCH = 5000;

export interface WebhookPurgeResult {
  /** แถว webhook_delivery ที่ลบ (ส่งเกิน 30 วัน) */
  deliveries: number;
  /** คำสั่ง webhook ที่พักไว้เพราะบริษัทถูกระงับเกิน 30 วัน → SKIPPED */
  parkedDropped: number;
}

/**
 * งานบำรุงรักษา webhook รายวัน (ST7-T05) — worker เรียกพร้อมงานรายวันอื่น · ใช้ role platform (ข้าม tenant)
 * 1) ล้างประวัติการส่ง (webhook_delivery) ที่ส่งเกิน 30 วัน (docs/04 G1 "เก็บ 30 วัน") ทีละ 5,000 แถวผ่าน index sent_at
 *    (migration 0097) — role แอปลบไม่ได้ (migration 0093)
 * 2) INT-109: คำสั่ง webhook ที่พักไว้เพราะบริษัทถูกระงับ (outbox PENDING + error_class AUTH) นานเกิน 30 วันนับจาก `parked_at`
 *    (เวลาที่เริ่มพัก — ไม่ใช่เวลาสร้างคำสั่ง) → ทิ้ง (SKIPPED)
 *    พร้อม log ต่อบริษัท · คำสั่ง connector (ADAPTER) ไม่แตะ — นโยบาย AUTH ของ connector อยู่ใน ST7-T13/T16
 */
@Injectable()
export class WebhookRetentionService {
  private readonly logger = new Logger('WebhookRetention');

  constructor(private readonly prisma: PrismaService) {}

  async purge(now = new Date()): Promise<WebhookPurgeResult> {
    const db = this.prisma.platform;
    const cutoff = new Date(now.getTime() - WEBHOOK_DELIVERY_RETENTION_DAYS * DAY);
    let deliveries = 0;
    for (;;) {
      const n = await db.$executeRaw`
        DELETE FROM webhook_delivery
         WHERE id IN (SELECT id FROM webhook_delivery WHERE sent_at < ${cutoff} LIMIT ${BATCH})`;
      deliveries += n;
      if (n < BATCH) break;
    }
    const parkedCutoff = new Date(now.getTime() - WEBHOOK_PARKED_MAX_DAYS * DAY);
    const dropped = await db.$queryRaw<{ tenant_id: string; n: number }[]>`
      WITH d AS (
        UPDATE integration_outbox
           SET status = 'SKIPPED', done_at = now(), updated_at = now(), lease_id = NULL, lease_until = NULL,
               last_error = coalesce(last_error, '{}'::jsonb)
                            || jsonb_build_object('code', 'parked_expired', 'parkedDays', ${WEBHOOK_PARKED_MAX_DAYS}::int)
         WHERE kind = 'WEBHOOK' AND status = 'PENDING' AND error_class = 'AUTH'
           AND parked_at < ${parkedCutoff}
        RETURNING tenant_id
      )
      SELECT tenant_id::text, count(*)::int AS n FROM d GROUP BY tenant_id`;
    let parkedDropped = 0;
    for (const r of dropped) {
      parkedDropped += r.n;
      this.logger.warn(
        JSON.stringify({ msg: 'webhook parked commands dropped', tenantId: r.tenant_id, n: r.n }),
      );
    }
    return { deliveries, parkedDropped };
  }
}
