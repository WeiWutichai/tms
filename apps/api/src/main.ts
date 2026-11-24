import { createApp } from './bootstrap';
import { createLogger, PinoNestLogger } from './common/logger';
import { MonitorScheduler } from './modules/monitoring/monitor-scheduler';

async function main() {
  const log = createLogger();
  const app = await createApp();
  app.useLogger(new PinoNestLogger(log)); // ST9-T13 R2 (L-02)
  const port = Number(process.env.API_PORT ?? 4410);
  await app.listen(port);
  // ST9-T19 flush ตัวนับคำขอ + ตรวจแทน worker เมื่อ worker หยุด (MONITOR=off ปิด)
  app.get(MonitorScheduler).startApi();
  log.info({ port }, 'TMS API listening');
}

void main();
