import { Logger } from '@nestjs/common';
import type { ClaimedCommand, OutboxDispatcher } from './outbox.dispatcher';

export interface OutboxWorkerOptions {
  /** จำนวนคำสั่งที่ส่งพร้อมกันใน process นี้ (ค่าเริ่ม 4 — env OUTBOX_CONCURRENCY) */
  concurrency?: number;
  /** พักเมื่อไม่มีงาน (ms) */
  idleMs?: number;
}

/**
 * ลูปส่ง outbox แยกจากลูป email/LINE/job ของ worker (review ST7-T03 M1) — sink ที่ช้า (ปลายทางค้าง timeout)
 * ไม่ทำให้อีเมลลืมรหัสผ่านหรือ job รอ · มีหลาย slot ส่งพร้อมกัน แต่ claim ทีละรายการ (mutex ใน dispatcher)
 * จึงจำกัดต่อปลายทางได้ตาม MAX_IN_FLIGHT_PER_TARGET
 * `stop(graceMs)` (SIGTERM): หยุดหยิบงานใหม่ → รอคำสั่งที่กำลังส่งไม่เกิน graceMs → ที่ยังไม่จบ ยกเลิก (AbortSignal)
 * และคืนเป็น PENDING ให้ worker อื่นหยิบได้ทันที (fencing ด้วย lease_id)
 */
export class OutboxWorkerPool {
  private readonly logger = new Logger('OutboxWorker');
  private stopping = false;
  private readonly abort = new AbortController();
  private readonly inFlight = new Map<string, { cmd: ClaimedCommand; done: Promise<void> }>();
  private slots: Promise<void>[] = [];
  private readonly wakers = new Set<() => void>();

  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly opts: OutboxWorkerOptions = {},
  ) {}

  start(): void {
    const n = Math.max(1, this.opts.concurrency ?? 4);
    this.slots = Array.from({ length: n }, (_, i) => this.slot(i));
  }

  /** จำนวนคำสั่งที่กำลังส่ง */
  get active(): number {
    return this.inFlight.size;
  }

  private async slot(i: number): Promise<void> {
    const idleMs = this.opts.idleMs ?? 1000;
    while (!this.stopping) {
      let cmd: ClaimedCommand | null = null;
      try {
        cmd = await this.dispatcher.claim();
      } catch (e) {
        this.logger.error(`outbox slot ${i} claim failed: ${String(e)}`);
      }
      if (this.stopping && cmd) {
        // หยิบได้ตอนกำลังปิด → คืนทันที
        await this.dispatcher.release([cmd]).catch(() => 0);
        break;
      }
      if (!cmd) {
        await new Promise<void>((r) => {
          const wake = () => {
            clearTimeout(t);
            this.wakers.delete(wake);
            r();
          };
          const t = setTimeout(wake, idleMs);
          this.wakers.add(wake);
        });
        continue;
      }
      const c = cmd;
      const done = this.dispatcher
        .process(c, this.abort.signal)
        .catch((e) => this.logger.error(`outbox ${c.id} process failed: ${String(e)}`));
      this.inFlight.set(c.id, { cmd: c, done });
      try {
        await done;
      } finally {
        this.inFlight.delete(c.id);
      }
    }
  }

  /** หยุดหยิบงาน รอที่ค้างไม่เกิน graceMs แล้วคืนคำสั่งที่ยังไม่จบ — คืนจำนวนที่คืน */
  async stop(graceMs = 8000): Promise<number> {
    this.stopping = true;
    for (const w of [...this.wakers]) w();
    const pending = [...this.inFlight.values()];
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(pending.map((p) => p.done)),
      new Promise<void>((r) => (timer = setTimeout(r, graceMs))),
    ]);
    clearTimeout(timer);
    const left = [...this.inFlight.values()].map((p) => p.cmd);
    let released = 0;
    if (left.length) {
      // คืนก่อนแล้วค่อยยกเลิก sink — ผลล้มจากการยกเลิกเขียนทับไม่ได้ (lease_id ถูกล้างแล้ว)
      released = await this.dispatcher.release(left);
      this.abort.abort(new Error('worker shutting down'));
      this.logger.warn(`outbox: released ${released} unfinished command(s) on shutdown`);
    }
    await Promise.race([
      Promise.all(this.slots),
      new Promise<void>((r) => setTimeout(r, 1000).unref?.()),
    ]);
    return released;
  }
}
