import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { createLogger, PinoNestLogger } from './common/logger';
import { assertNoDevKeys } from './common/crypto';
import { JobQueue } from './jobs/job-queue.service';
import { EmailDispatcher } from './modules/email/email.service';
import { MessageDispatcher } from './modules/messaging/message-dispatcher';
import { OutboxDispatcher } from './modules/integration/outbox.dispatcher';
import { OutboxWorkerPool } from './modules/integration/outbox-worker';
import { purgeAuthData } from './auth/maintenance';
import { PrismaService } from './db/prisma.service';
import { MonitorScheduler } from './modules/monitoring/monitor-scheduler';
import {
  PAYMENT_PULL_CHECK_EVERY_MS,
  PaymentStatusPullService,
} from './modules/erp/payment-status-pull.service';
import {
  AFTER_PUSH_CHECK_EVERY_MS,
  DocumentReconcileService,
  RECONCILE_CHECK_EVERY_MS,
} from './modules/erp/document-reconcile.service';
import { AvailabilityService } from './modules/monitoring/availability.service';
import { WebhookRetentionService } from './modules/webhooks/webhook-retention';
import { RetentionService } from './modules/retention/retention.service';
import {
  CONNECTOR_PULL_EVERY_MS,
  ConnectorPullScheduler,
} from './modules/connectors/connector-pull.scheduler';
import { ConnectorsService, HEALTH_RECHECK_EVERY_MS } from './modules/erp/connectors.service';
import { InboundWebhookService } from './modules/erp/inbound-webhook.service';
import { ExpiryReminderService } from './modules/reminders/expiry-reminder.service';
import { PaymentDueReminderService } from './modules/reminders/payment-due-reminder.service';
import { UnbilledReminderService } from './modules/reminders/unbilled-reminder.service';
import { InvoiceStatusService } from './modules/invoices/invoice-status.service';
import { DailyDigestService } from './modules/notifications/daily-digest.service';
import { DepreciationService } from './modules/depreciation/depreciation.service';
import { TenantLifecycleService } from './modules/tenants/tenant-lifecycle.service';
import {
  OFFER_TIMEOUT_EVERY_MS,
  SubconTimeoutService,
} from './modules/trips/subcon-timeout.service';

/**
 * Worker process (outbox, webhook, job) — ใช้โค้ดร่วมกับ api (plan/02 T-01)
 * ST0: วนหยิบ job; ST7-T03 เพิ่ม integration outbox ในลูปเดียวกัน (webhook ST7-T04 เป็น sink ของ outbox)
 */
async function main() {
  const log = createLogger();
  assertNoDevKeys(); // R2-M01 นอก dev/test ห้ามใช้กุญแจตัวอย่างของ repo (เหมือน API ตอนบูต)
  const ctx = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  ctx.useLogger(new PinoNestLogger(log, ['error', 'warn', 'fatal'])); // ST9-T13 R2 (L-02) — log ของโมดูลออกทาง pino (requestId/tenantId + redact)
  const queue = ctx.get(JobQueue);
  const mail = ctx.get(EmailDispatcher);
  mail.init();
  // ST3-T21 LINE/SMS outbox (ผู้ให้บริการเลือกจาก env ตอนสร้าง context — ตั้งผิด = ล้มตั้งแต่บูต)
  const messages = ctx.get(MessageDispatcher);
  // ST7-T03 integration outbox (webhook ST7-T04 / ERP push ST7-T16 เสียบเป็น sink)
  const outbox = ctx.get(OutboxDispatcher);
  // ST7-T03 outbox ลูปแยก (sink ช้าไม่ขวางอีเมล/job) — ส่งพร้อมกัน OUTBOX_CONCURRENCY (ค่าเริ่ม 4)
  const outboxPool = new OutboxWorkerPool(outbox, {
    concurrency: Number(process.env.OUTBOX_CONCURRENCY) || 4,
  });
  outboxPool.start();
  let stopping = false;
  // SIGTERM: หยุดหยิบ outbox ทันที → รอคำสั่งที่กำลังส่งไม่เกิน OUTBOX_SHUTDOWN_GRACE_MS (ค่าเริ่ม 8 วิ) → คืนที่ค้างเป็น PENDING
  let outboxStopped: Promise<number> | undefined;
  const shutdown = () => {
    stopping = true;
    outboxStopped ??= outboxPool
      .stop(Number(process.env.OUTBOX_SHUTDOWN_GRACE_MS) || 8000)
      .catch((e) => (log.error(e), 0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  log.info('worker started');
  // งานบำรุงรักษารายวัน — รันตอนเริ่มและทุก 24 ชม.
  const prisma = ctx.get(PrismaService);
  // ST7-T05 ประวัติการส่ง webhook เก็บ 30 วัน + คำสั่งที่พักเพราะบริษัทถูกระงับเกิน 30 วันทิ้ง (INT-109)
  const webhookRetention = ctx.get(WebhookRetentionService);
  const connectors = ctx.get(ConnectorsService);
  // ST7-T22 webhook ขาเข้า: ล้าง payload เกิน 30 วัน (แถว ledger ไม่ลบ — archive หลัง 24 เดือน = [OPEN — PO])
  const inbound = ctx.get(InboundWebhookService);
  // ST9-T19 heartbeat ทุก 30 วิ + self-probe / ประเมิน alert ทุก 1 นาที (MONITOR=off ปิด)
  const monitor = ctx.get(MonitorScheduler);
  monitor.startWorker();
  const availability = ctx.get(AvailabilityService);
  // ST9-T14 ระยะเก็บต่อ tenant (docs/04 J): audit log / ประวัติ login / GPS / ไฟล์ POD / ไฟล์ส่งออก 7 วัน
  const retention = ctx.get(RetentionService);
  const daily = () =>
    Promise.all([
      // ST9-T19 heartbeat เก่า 1 วัน · probe 400 วัน · ตัวนับคำขอ 35 วัน
      availability
        .purge()
        .then((r) => log.info({ monitoring: r }, 'monitoring retention'))
        .catch((e) => log.error(e)),
      inbound
        .purge()
        .then((r) => log.info({ inbound: r }, 'inbound webhook retention'))
        .catch((e) => log.error(e)),
      retention
        .run()
        .then((r) => log.info({ retention: r }, 'retention'))
        .catch((e) => log.error(e)),
      purgeAuthData(prisma.platform)
        .then((r) => log.info({ purged: r }, 'auth maintenance'))
        .catch((e) => log.error(e)),
      // ST7-T10 งานที่ client สั่ง (bulk/นำเข้า) เก็บ 7 วันหลังจบ (docs/04 G1)
      queue
        .purgeExpired()
        .then((n) => n && log.info({ jobs: n }, 'public jobs purged'))
        .catch((e) => log.error(e)),
      webhookRetention
        .purge()
        .then((r) => log.info({ webhook: r }, 'webhook retention'))
        .catch((e) => log.error(e)),
      // ST7-T14 หมุน key เข้ารหัส: credential ของ connector ที่เข้ารหัสด้วย key เก่า → เข้ารหัสใหม่ด้วย key ปัจจุบัน
      connectors
        .reencryptCredentials()
        .then(
          (r) => r.reencrypted && log.info({ connectors: r }, 'connector credentials re-encrypted'),
        )
        .catch((e) => log.error(e)),
    ]);
  void daily();
  const timer = setInterval(daily, 24 * 60 * 60 * 1000);
  // P1-ST1-T03 วงจรสถานะ tenant: ตรวจทุก 10 นาที — ตั้งแต่ 00:30 เวลาไทยกวาดวันละครั้ง (trial หมด / ค้างชำระ → read_only → suspended → cancelled)
  const lifecycle = ctx.get(TenantLifecycleService);
  const scheduleLifecycle = () =>
    lifecycle
      .scheduleDue()
      .then(
        (r) => r && (r.transitions || r.failed) && log.info({ lifecycle: r }, 'tenant lifecycle'),
      )
      .catch((e) => log.error(e));
  void scheduleLifecycle();
  const lifecycleTimer = setInterval(scheduleLifecycle, 10 * 60 * 1000);
  // ST2-T18 เตือนต่ออายุ: ตรวจทุก 10 นาที — ตั้งแต่ 08:00 เวลาไทย (docs/04 I) สร้าง job ของวันนี้ให้ tenant ที่ยังไม่มี (ซ้ำได้ ไม่เตือนซ้ำ)
  const reminders = ctx.get(ExpiryReminderService);
  const schedule = () =>
    reminders
      .scheduleDue()
      .then((n) => n && log.info({ tenants: n }, 'expiry reminders scheduled'))
      .catch((e) => log.error(e));
  void schedule();
  const reminderTimer = setInterval(schedule, 10 * 60 * 1000);
  // ST9-T08 สรุปรายวัน 08:00: ตรวจทุก 10 นาที — ตั้งแต่ 08:00 เวลาไทย สร้าง job ของวันนี้ (ซ้ำได้ ส่งครั้งเดียวต่อคนต่อวัน)
  const digests = ctx.get(DailyDigestService);
  const scheduleDigest = () =>
    digests
      .scheduleDue()
      .then((n) => n && log.info({ tenants: n }, 'daily digest scheduled'))
      .catch((e) => log.error(e));
  void scheduleDigest();
  const digestTimer = setInterval(scheduleDigest, 10 * 60 * 1000);
  // ST5-T18 ใบแจ้งหนี้เกินกำหนด: ตรวจทุก 10 นาที — ตั้งแต่ 00:05 เวลาไทย สร้าง job ของวันนี้ให้ tenant ที่ยังไม่มี (spec/05 BIL-040 · idempotent)
  const invoiceStatus = ctx.get(InvoiceStatusService);
  const scheduleOverdue = () =>
    invoiceStatus
      .scheduleDue()
      .then((n) => n && log.info({ tenants: n }, 'invoice overdue scheduled'))
      .catch((e) => log.error(e));
  void scheduleOverdue();
  const overdueTimer = setInterval(scheduleOverdue, 10 * 60 * 1000);
  // ST5-T22 เตือนครบกำหนดชำระ: ตรวจทุก 10 นาที — ตั้งแต่ 08:00 เวลาไทย สร้าง job ของวันนี้ (spec/05 BIL-121 · ไม่เตือนซ้ำ)
  const paymentDue = ctx.get(PaymentDueReminderService);
  const schedulePaymentDue = () =>
    paymentDue
      .scheduleDue()
      .then((n) => n && log.info({ tenants: n }, 'payment due reminders scheduled'))
      .catch((e) => log.error(e));
  void schedulePaymentDue();
  const paymentDueTimer = setInterval(schedulePaymentDue, 10 * 60 * 1000);
  // ST9-T06 DO ยังไม่วางบิลเกิน N วัน: ตรวจทุก 10 นาที — ตั้งแต่ 08:00 เวลาไทย สร้าง job ของวันนี้ (แจ้งผู้วางบิลเมื่อมี DO เพิ่งเกินเกณฑ์)
  const unbilled = ctx.get(UnbilledReminderService);
  const scheduleUnbilled = () =>
    unbilled
      .scheduleDue()
      .then((n) => n && log.info({ tenants: n }, 'unbilled DO reminders scheduled'))
      .catch((e) => log.error(e));
  void scheduleUnbilled();
  const unbilledTimer = setInterval(scheduleUnbilled, 10 * 60 * 1000);
  // ST2-T22 ค่าเสื่อมรายเดือน: ตรวจทุก 10 นาที — ตั้งแต่วันที่ 1 เวลา 02:00 น. ไทย สร้าง job ของเดือนที่เพิ่งปิดให้ tenant ที่ยังไม่มี (ซ้ำได้ ไม่ลงซ้ำ)
  const depreciation = ctx.get(DepreciationService);
  const scheduleDepreciation = () =>
    depreciation
      .scheduleDue()
      .then((n) => n && log.info({ tenants: n }, 'depreciation scheduled'))
      .catch((e) => log.error(e));
  void scheduleDepreciation();
  const depreciationTimer = setInterval(scheduleDepreciation, 10 * 60 * 1000);
  // ST3-T24 ข้อเสนองานรถร่วม: ครบ N ชม. ยังไม่ตอบ → แจ้งผู้จัดรถ · ลิงก์หมดอายุ → EXPIRED — ตรวจทุก 1 นาที (spec/03 PLN-154)
  const offerTimeouts = ctx.get(SubconTimeoutService);
  const scheduleOfferTimeouts = () =>
    offerTimeouts
      .scheduleDue()
      .then((n) => n && log.info({ tenants: n }, 'offer timeouts scheduled'))
      .catch((e) => log.error(e));
  void scheduleOfferTimeouts();
  const offerTimeoutTimer = setInterval(scheduleOfferTimeouts, OFFER_TIMEOUT_EVERY_MS);
  // ST7-T14 ดึง order ผ่าน connector ที่เปิด pullOrders ทุก 5 นาที (docs/01 §6.1) — job ค้างของ connector เดิมไม่สร้างซ้ำ
  const pulls = ctx.get(ConnectorPullScheduler);
  const schedulePulls = () =>
    pulls
      .scheduleDue()
      .then((n) => n && log.info({ connectors: n }, 'connector pulls scheduled'))
      .catch((e) => log.error(e));
  void schedulePulls();
  const pullTimer = setInterval(schedulePulls, CONNECTOR_PULL_EVERY_MS);
  // ST7-T21 ดึงสถานะรับชำระจากระบบบัญชีที่เปิด fetchPaymentStatus: ตรวจทุก 10 นาที — ตั้งแต่ 06:00 เวลาไทย สร้าง job ของวันนี้ต่อ connector (docs/01 §6.1 "scheduler รายวัน")
  const paymentPull = ctx.get(PaymentStatusPullService);
  const schedulePaymentPull = () =>
    paymentPull
      .scheduleDue()
      .then((n) => n && log.info({ connectors: n }, 'payment status pulls scheduled'))
      .catch((e) => log.error(e));
  void schedulePaymentPull();
  const paymentPullTimer = setInterval(schedulePaymentPull, PAYMENT_PULL_CHECK_EVERY_MS);
  // ST8-T11 reconcile เอกสารกับระบบบัญชี (docs/01 §6.5) → คำสั่ง FETCH_DOCUMENT เข้าคิวของ connector:
  // AFTER_PUSH ตรวจทุก 1 นาที (ครบค่าหน่วงของ connector หลังส่งสำเร็จ + อีกครั้ง +60 นาที — PO 24 พ.ย. 2569 #89) ·
  // NIGHTLY ตั้งแต่ 02:00 · PRE_CLOSE วันทำการสุดท้ายของเดือนตั้งแต่ 17:00 (เวลาไทย) ตรวจทุก 5 นาที
  const reconcile = ctx.get(DocumentReconcileService);
  let afterPushBusy = false;
  const scheduleAfterPush = () => {
    if (afterPushBusy) return; // รอบก่อนยังไม่จบ (ไม่ซ้อน)
    afterPushBusy = true;
    reconcile
      .scheduleAfterPush()
      .then((n) => n && log.info({ afterPush: n }, 'after-push reconcile scheduled'))
      .catch((e) => log.error(e))
      .finally(() => (afterPushBusy = false));
  };
  const scheduleReconcile = () =>
    reconcile
      .scheduleRounds()
      .then((n) => n && log.info({ rounds: n }, 'reconcile rounds scheduled'))
      .catch((e) => log.error(e));
  scheduleAfterPush();
  void scheduleReconcile();
  const afterPushTimer = setInterval(scheduleAfterPush, AFTER_PUSH_CHECK_EVERY_MS);
  const reconcileTimer = setInterval(scheduleReconcile, RECONCILE_CHECK_EVERY_MS);
  // ST8-T03 ตรวจซ้ำ connector ที่ปลายทางไม่ตอบ (ACTIVE ล้มต่อเนื่อง ≥ 30 นาที → ERROR) และคืน ERROR(TRANSIENT) → ACTIVE เมื่อกลับมา
  const recheckHealth = () =>
    connectors
      .recheckUnhealthy()
      .then((n) => n && log.info({ connectors: n }, 'connector health rechecked'))
      .catch((e) => log.error(e));
  // ST9-T04 healthCheck ทุก 5 นาทีของ connector ACTIVE ที่ยังปกติ (docs/01 §A.4) — ปลายทางล่มแล้ว dashboard เห็น health แดงแม้ไม่มีคำสั่งส่ง
  const sweepHealth = () =>
    connectors
      .healthSweep()
      .then((n) => n && log.info({ connectors: n }, 'connector health sweep'))
      .catch((e) => log.error(e));
  const healthTimer = setInterval(() => {
    recheckHealth();
    sweepHealth();
  }, HEALTH_RECHECK_EVERY_MS);
  // ตัวเลขคิว outbox ทุก 5 นาที ลง log (ST9-T19: metrics/alert อ่านจากฐานโดยตรง — /v1/metrics, AlertEvaluator)
  const outboxStats = () =>
    outbox
      .stats()
      .then((s) => log.info({ outbox: s }, 'outbox stats'))
      .catch((e) => log.error(e));
  void outboxStats(); // บรรทัดแรกตอนเริ่ม
  const outboxStatsTimer = setInterval(outboxStats, 5 * 60 * 1000);
  while (!stopping) {
    // ST1-T03: อีเมลใน outbox ส่งก่อน job (ลิงก์ลืมรหัสผ่านมีอายุ 30 นาที)
    const mailed = await mail.runOnce().catch((e) => (log.error(e), false));
    const sent = await messages.runOnce().catch((e) => (log.error(e), false));
    const worked = (await queue.runOnce().catch((e) => (log.error(e), false))) || mailed || sent;
    if (!worked) await new Promise((r) => setTimeout(r, 1000));
  }
  clearInterval(timer);
  clearInterval(reminderTimer);
  clearInterval(lifecycleTimer);
  clearInterval(digestTimer);
  clearInterval(overdueTimer);
  clearInterval(paymentDueTimer);
  clearInterval(unbilledTimer);
  clearInterval(depreciationTimer);
  clearInterval(offerTimeoutTimer);
  clearInterval(pullTimer);
  clearInterval(paymentPullTimer);
  clearInterval(reconcileTimer);
  clearInterval(afterPushTimer);
  clearInterval(healthTimer);
  clearInterval(outboxStatsTimer);
  monitor.stop();
  shutdown();
  const released = await outboxStopped!;
  if (released) log.warn({ released }, 'outbox commands released on shutdown');
  await ctx.close();
}

void main();
