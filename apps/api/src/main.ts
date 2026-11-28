import { createApp } from './bootstrap';
import { createLogger, PinoNestLogger } from './common/logger';
import { MonitorScheduler } from './modules/monitoring/monitor-scheduler';
import { PrismaService } from './db/prisma.service';
import { API_USAGE_FLUSH_MS, apiUsageMeter } from './modules/usage/api-usage-meter';
import { apiTrafficMeter } from './modules/usage/api-traffic-meter';

async function main() {
  const log = createLogger();
  const app = await createApp();
  app.useLogger(new PinoNestLogger(log)); // ST9-T13 R2 (L-02)
  const port = Number(process.env.API_PORT ?? 4410);
  await app.listen(port);
  // ST9-T19 flush ตัวนับคำขอ + ตรวจแทน worker เมื่อ worker หยุด (MONITOR=off ปิด)
  app.get(MonitorScheduler).startApi();
  // P1-ST1-T07 flush ตัวนับ API calls ลง usage_daily (+ P1-ST4-T05 api_traffic_daily) แบบ batch (บวกเพิ่ม) + รอบสุดท้ายตอนปิด process
  const platformDb = app.get(PrismaService).platform;
  const flushUsage = () =>
    Promise.all([
      apiUsageMeter.flush(platformDb).catch((e) => log.error(e, 'api usage flush failed')),
      // P1-ST4-T05 สถิติคำขอ Open API (Console "การใช้งาน API")
      apiTrafficMeter.flush(platformDb).catch((e) => log.error(e, 'api traffic flush failed')),
    ]);
  setInterval(flushUsage, API_USAGE_FLUSH_MS).unref();
  // ปิด process: หยุดรับคำขอ + รอคำขอที่ค้างจบ (app.close) → flush รอบสุดท้าย (ไม่เกิน 5 วิ) → ออก 0 (SIGTERM) / 130 (SIGINT)
  for (const [sig, code] of [
    ['SIGTERM', 0],
    ['SIGINT', 130],
  ] as const)
    process.once(sig, () => {
      void (async () => {
        await app.close().catch((e) => log.error(e, 'app close failed'));
        await Promise.race([flushUsage(), new Promise((ok) => setTimeout(ok, 5_000).unref())]);
        process.exit(code);
      })();
    });
  log.info({ port }, 'TMS API listening');
}

void main();
