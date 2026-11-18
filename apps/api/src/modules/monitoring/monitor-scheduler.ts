import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { PrismaService } from '../../db/prisma.service';
import { AlertEvaluator, type EvaluateResult } from './alert-evaluator';
import { AvailabilityService } from './availability.service';
import { httpMetrics } from './http-metrics';
import { HEARTBEAT_EVERY_MS, MONITOR_TICK_MS, WORKER_STALE_SEC } from './monitor-config';

/**
 * ST9-T19 จังหวะงาน monitoring — รอบละนาทีตรงต้นนาที (setTimeout ไปยังต้นนาทีถัดไป ไม่ใช่ setInterval ที่เลื่อน)
 * - worker: heartbeat ทุก 30 วิ · ต้นนาที +2 วิ: self-probe + ประเมิน alert (อีเมลเข้าคิว outbox)
 * - api: flush ตัวนับคำขอทุก 15 วิ · ต้นนาที +5 วิ: self-probe **ทุกนาที** (นาทีเดียวกัน = แถวเดียว ON CONFLICT —
 *   worker restart/deploy จึงไม่ทำให้นาทีหายแล้วนับเป็นล่ม) · ประเมิน alert แทนเมื่อ heartbeat ของ worker เก่ากว่า 3 นาที (ส่งอีเมลตรง)
 * ปิดทั้งหมดด้วย `MONITOR=off`
 */
@Injectable()
export class MonitorScheduler {
  private readonly logger = new Logger('Monitoring');
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

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

  /** 1 รอบของ API — probe ทุกครั้ง · ประเมินเฉพาะเมื่อ worker หยุด (evaluated = null = worker ยังทำงาน) */
  async tickApi(): Promise<{ evaluated: EvaluateResult | null }> {
    const now = this.clock.now();
    await this.availability.probe(now, 'api').catch((e) => this.logger.error(e));
    const age = await this.availability.workerBeatAgeSec(now);
    if (age !== null && age <= WORKER_STALE_SEC) return { evaluated: null };
    return { evaluated: await this.evaluator.evaluate(now, { direct: true }) };
  }

  startWorker(): void {
    if (!MonitorScheduler.enabled()) return;
    const beat = () =>
      this.availability.beat('worker', this.clock.now()).catch((e) => this.logger.error(e));
    void beat();
    this.every(HEARTBEAT_EVERY_MS, beat);
    this.everyMinute(2_000, () =>
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
    httpMetrics.persist = true;
    this.every(15_000, () =>
      httpMetrics.flush(this.prisma.platform).catch((e) => this.logger.error(e)),
    );
    this.everyMinute(5_000, () => this.tickApi().catch((e) => this.logger.error(e)));
  }

  stop(): void {
    this.stopped = true;
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
  }

  private every(ms: number, fn: () => unknown) {
    const t = setInterval(fn, ms);
    t.unref();
    this.timers.push(t);
  }

  /** เรียก fn ที่ต้นนาที + offset ทุกนาที — คำนวณใหม่ทุกรอบ (ไม่สะสมความคลาดเคลื่อน) · รอบที่ยังไม่จบไม่ซ้อน */
  private everyMinute(offsetMs: number, fn: () => Promise<unknown>) {
    const schedule = () => {
      if (this.stopped) return;
      const delay = msToNextMinute(Date.now(), offsetMs);
      const t = setTimeout(() => {
        this.timers = this.timers.filter((x) => x !== t);
        void fn().finally(schedule);
      }, delay);
      t.unref();
      this.timers.push(t);
    };
    schedule();
  }
}

/** ms จาก `at` ถึงต้นนาทีถัดไป + offset (ถ้าต้นนาทีนี้ + offset ยังไม่ถึง = รอบนี้) */
export function msToNextMinute(at: number, offsetMs: number): number {
  const into = at % MONITOR_TICK_MS;
  return into < offsetMs ? offsetMs - into : MONITOR_TICK_MS - into + offsetMs;
}
