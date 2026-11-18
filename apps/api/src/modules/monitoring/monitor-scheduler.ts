import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { PrismaService } from '../../db/prisma.service';
import { AlertEvaluator, type EvaluateResult } from './alert-evaluator';
import { AvailabilityService } from './availability.service';
import { httpMetrics } from './http-metrics';
import { HEARTBEAT_EVERY_MS, MONITOR_TICK_MS, WORKER_STALE_SEC } from './monitor-config';

/**
 * ST9-T19 จังหวะงาน monitoring
 * - worker: heartbeat ทุก 30 วิ · ทุก 1 นาที self-probe + ประเมิน alert (อีเมลเข้าคิว outbox)
 * - api: flush ตัวนับคำขอทุก 15 วิ · ทุก 1 นาที ถ้า heartbeat ของ worker เก่ากว่า 3 นาที → probe + ประเมินแทน (ส่งอีเมลตรง)
 * ปิดทั้งหมดด้วย `MONITOR=off`
 */
@Injectable()
export class MonitorScheduler {
  private readonly logger = new Logger('Monitoring');
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly availability: AvailabilityService,
    private readonly evaluator: AlertEvaluator,
  ) {}

  static enabled(): boolean {
    return (process.env.MONITOR ?? 'on') !== 'off';
  }

  /** 1 รอบของ worker */
  async tickWorker(): Promise<EvaluateResult> {
    const now = this.clock.now();
    await this.availability.probe(now, 'worker').catch((e) => this.logger.error(e));
    return this.evaluator.evaluate(now);
  }

  /** 1 รอบของ API — ทำงานเฉพาะเมื่อ worker หยุด (null = worker ยังทำงาน) */
  async tickApi(): Promise<EvaluateResult | null> {
    const now = this.clock.now();
    const age = await this.availability.workerBeatAgeSec(now);
    if (age !== null && age <= WORKER_STALE_SEC) return null;
    await this.availability.probe(now, 'api').catch((e) => this.logger.error(e));
    return this.evaluator.evaluate(now, { direct: true });
  }

  startWorker(): void {
    if (!MonitorScheduler.enabled()) return;
    const beat = () =>
      this.availability.beat('worker', this.clock.now()).catch((e) => this.logger.error(e));
    void beat();
    this.every(HEARTBEAT_EVERY_MS, beat);
    this.every(MONITOR_TICK_MS, () =>
      this.tickWorker()
        .then((r) => {
          if (r.opened.length || r.resolved.length)
            this.logger.log(`alerts opened=${r.opened.join(',')} resolved=${r.resolved.join(',')}`);
        })
        .catch((e) => this.logger.error(e)),
    );
  }

  startApi(): void {
    if (!MonitorScheduler.enabled()) return;
    this.every(15_000, () =>
      httpMetrics.flush(this.prisma.platform).catch((e) => this.logger.error(e)),
    );
    this.every(MONITOR_TICK_MS, () => this.tickApi().catch((e) => this.logger.error(e)));
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  private every(ms: number, fn: () => unknown) {
    const t = setInterval(fn, ms);
    t.unref();
    this.timers.push(t);
  }
}
