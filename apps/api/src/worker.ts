import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { createLogger } from './common/logger';
import { JobQueue } from './jobs/job-queue.service';
import { EmailDispatcher } from './modules/email/email.service';
import { MessageDispatcher } from './modules/messaging/message-dispatcher';
import { OutboxDispatcher } from './modules/integration/outbox.dispatcher';
import { OutboxWorkerPool } from './modules/integration/outbox-worker';
import { purgeAuthData } from './auth/maintenance';
import { PrismaService } from './db/prisma.service';
import { WebhookRetentionService } from './modules/webhooks/webhook-retention';
import {
  CONNECTOR_PULL_EVERY_MS,
  ConnectorPullScheduler,
} from './modules/connectors/connector-pull.scheduler';
import { ConnectorsService } from './modules/erp/connectors.service';
import { InboundWebhookService } from './modules/erp/inbound-webhook.service';
import { ExpiryReminderService } from './modules/reminders/expiry-reminder.service';
import { DepreciationService } from './modules/depreciation/depreciation.service';
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
  const ctx = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
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
  // งานบำรุงรักษารายวัน (ST1-T11 เก็บประวัติ login 1 ปี) — รันตอนเริ่มและทุก 24 ชม.
  const prisma = ctx.get(PrismaService);
  // ST7-T05 ประวัติการส่ง webhook เก็บ 30 วัน + คำสั่งที่พักเพราะบริษัทถูกระงับเกิน 30 วันทิ้ง (INT-109)
  const webhookRetention = ctx.get(WebhookRetentionService);
  const connectors = ctx.get(ConnectorsService);
  // ST7-T22 webhook ขาเข้า: ล้าง payload เกิน 30 วัน + ลบแถว ledger เกิน 24 เดือน
  const inbound = ctx.get(InboundWebhookService);
  const daily = () =>
    Promise.all([
      inbound
        .purge()
        .then((r) => log.info({ inbound: r }, 'inbound webhook retention'))
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
  // ST2-T18 เตือนต่ออายุ: ตรวจทุก 10 นาที — ตั้งแต่ 08:00 เวลาไทย (docs/04 I) สร้าง job ของวันนี้ให้ tenant ที่ยังไม่มี (ซ้ำได้ ไม่เตือนซ้ำ)
  const reminders = ctx.get(ExpiryReminderService);
  const schedule = () =>
    reminders
      .scheduleDue()
      .then((n) => n && log.info({ tenants: n }, 'expiry reminders scheduled'))
      .catch((e) => log.error(e));
  void schedule();
  const reminderTimer = setInterval(schedule, 10 * 60 * 1000);
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
  // ตัวเลขคิว outbox ทุก 5 นาที (monitoring ST9-T19 อ่านจาก log/metrics นี้)
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
  clearInterval(depreciationTimer);
  clearInterval(offerTimeoutTimer);
  clearInterval(pullTimer);
  clearInterval(outboxStatsTimer);
  shutdown();
  const released = await outboxStopped!;
  if (released) log.warn({ released }, 'outbox commands released on shutdown');
  await ctx.close();
}

void main();
