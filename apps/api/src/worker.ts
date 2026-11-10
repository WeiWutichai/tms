import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { createLogger } from './common/logger';
import { JobQueue } from './jobs/job-queue.service';
import { purgeAuthData } from './auth/maintenance';
import { PrismaService } from './db/prisma.service';

/**
 * Worker process (outbox, webhook, job) — ใช้โค้ดร่วมกับ api (plan/02 T-01)
 * ST0: วนหยิบ job; ST7 จะเพิ่ม outbox/webhook dispatcher ในลูปเดียวกัน
 */
async function main() {
  const log = createLogger();
  const ctx = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const queue = ctx.get(JobQueue);
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
  while (!stopping) {
    const worked = await queue.runOnce().catch((e) => (log.error(e), false));
    if (!worked) await new Promise((r) => setTimeout(r, 1000));
  }
  clearInterval(timer);
  await ctx.close();
}

void main();
