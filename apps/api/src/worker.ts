import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { createLogger } from './common/logger';
import { JobQueue } from './jobs/job-queue.service';
import { EmailDispatcher } from './modules/email/email.service';
import { purgeAuthData } from './auth/maintenance';
import { PrismaService } from './db/prisma.service';
import { ExpiryReminderService } from './modules/reminders/expiry-reminder.service';

/**
 * Worker process (outbox, webhook, job) — ใช้โค้ดร่วมกับ api (plan/02 T-01)
 * ST0: วนหยิบ job; ST7 จะเพิ่ม outbox/webhook dispatcher ในลูปเดียวกัน
 */
async function main() {
  const log = createLogger();
  const ctx = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const queue = ctx.get(JobQueue);
  const mail = ctx.get(EmailDispatcher);
  mail.init();
  let stopping = false;
  process.on('SIGTERM', () => (stopping = true));
  process.on('SIGINT', () => (stopping = true));
  log.info('worker started');
  // งานบำรุงรักษารายวัน (ST1-T11 เก็บประวัติ login 1 ปี) — รันตอนเริ่มและทุก 24 ชม.
  const prisma = ctx.get(PrismaService);
  const daily = () =>
    purgeAuthData(prisma.platform)
      .then((r) => log.info({ purged: r }, 'auth maintenance'))
      .catch((e) => log.error(e));
  void daily();
  const timer = setInterval(daily, 24 * 60 * 60 * 1000);
  // ST2-T18 เตือนต่ออายุ: ตรวจทุก 10 นาที — ตั้งแต่ 06:00 เวลาไทย สร้าง job ของวันนี้ให้ tenant ที่ยังไม่มี (ซ้ำได้ ไม่เตือนซ้ำ)
  const reminders = ctx.get(ExpiryReminderService);
  const schedule = () =>
    reminders
      .scheduleDue()
      .then((n) => n && log.info({ tenants: n }, 'expiry reminders scheduled'))
      .catch((e) => log.error(e));
  void schedule();
  const reminderTimer = setInterval(schedule, 10 * 60 * 1000);
  while (!stopping) {
    // ST1-T03: อีเมลใน outbox ส่งก่อน job (ลิงก์ลืมรหัสผ่านมีอายุ 30 นาที)
    const mailed = await mail.runOnce().catch((e) => (log.error(e), false));
    const worked = (await queue.runOnce().catch((e) => (log.error(e), false))) || mailed;
    if (!worked) await new Promise((r) => setTimeout(r, 1000));
  }
  clearInterval(timer);
  clearInterval(reminderTimer);
  await ctx.close();
}

void main();
