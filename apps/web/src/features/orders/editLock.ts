import type { Schemas } from '@tms/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, unwrap } from '../../api';

export type EditLock = Schemas['OrderEditLockDto'];

/** ส่ง heartbeat ทุก 60 วินาที เฉพาะเมื่อมีกิจกรรมตั้งแต่ครั้งก่อน — ไม่มีกิจกรรม 10 นาที server ปล่อยล็อกเอง */
export const HEARTBEAT_MS = 60_000;

export type LockState =
  /** กำลังขอล็อก */
  | { kind: 'pending' }
  /** ถือล็อกอยู่ — แก้ได้ */
  | { kind: 'mine'; lock: EditLock }
  /** ผู้อื่นแก้อยู่ — อ่านอย่างเดียว */
  | { kind: 'other'; lock: EditLock }
  /** ขอไม่ได้ด้วยเหตุอื่น (เน็ต/ไม่ใช่ผู้ใช้) — ให้แก้ต่อได้ server ตรวจซ้ำตอนบันทึก */
  | { kind: 'free' };

export interface LockApi {
  acquire: () => Promise<EditLock>;
  release: (keepalive: boolean) => Promise<void>;
}

/** ผู้อื่นถือล็อก (409 `order_locked_by_user`) → ข้อมูลผู้ถือจาก problem */
export function lockedBy(e: unknown): EditLock | null {
  if (e instanceof ApiError && e.problem.code === 'order_locked_by_user')
    return ((e.problem as unknown as { editLock?: EditLock }).editLock ?? null) as EditLock | null;
  return null;
}

/** ขอล็อกไม่ได้คำตอบภายในเวลานี้ → ถือว่าว่าง (ปุ่มบันทึกไม่ค้าง — server ตรวจซ้ำตอนบันทึก) */
export const LOCK_TIMEOUT_MS = 10_000;
/** ผู้อื่นถือ/ขอไม่สำเร็จ: ลองใหม่เมื่อผู้ใช้มีกิจกรรม แต่ไม่ถี่กว่านี้ */
export const RETRY_MIN_MS = 10_000;

/**
 * ตัวคุมล็อกการแก้ของฟอร์ม (ST3-T08) — แยกจาก React ให้ test ด้วย fake timer ได้
 * - `start()` ขอล็อกทันที · ไม่ได้คำตอบใน `LOCK_TIMEOUT_MS` → `free` (แก้ต่อได้)
 * - ถือล็อก: ทุก `HEARTBEAT_MS` ถ้ามีกิจกรรม (`activity()`) ตั้งแต่ครั้งก่อน → ต่ออายุ (ไม่มีกิจกรรม = ปล่อยให้หมดอายุ)
 * - ผู้อื่นถือ/ขอไม่สำเร็จ: ลองขอใหม่เฉพาะเมื่อผู้ใช้มีกิจกรรม (ทันที ห่างกันอย่างน้อย `RETRY_MIN_MS`)
 *   — ผู้ที่เปิดดูเฉย ๆ ไม่ยึดล็อก (ป้ายอัปเดตจาก GET ที่ poll อยู่แล้ว)
 * - heartbeat ได้ 409 (ถูกปลด/หมดอายุแล้วคนอื่นเอาไป) → เปลี่ยนเป็นอ่านอย่างเดียว
 * - `stop(keepalive)` ปลดล็อกถ้าถืออยู่ (ปิดฟอร์ม/ออกจากหน้า — keepalive ให้คำขอไปถึงแม้ปิดแท็บ)
 */
export class EditLockController {
  state: LockState = { kind: 'pending' };
  private timer: ReturnType<typeof setInterval> | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private stopped = false;
  private busy = false;
  private keepalive = false;
  private lastTry = 0;

  constructor(
    private readonly lockApi: LockApi,
    private readonly onChange: (s: LockState) => void,
    private readonly everyMs = HEARTBEAT_MS,
  ) {}

  private set(s: LockState) {
    if (this.stopped) return;
    this.state = s;
    this.onChange(s);
  }

  private async beat(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    this.lastTry = Date.now();
    try {
      const lock = await this.lockApi.acquire();
      // ปิดฟอร์มระหว่างรอผล → ปลดทันที (ไม่ค้างล็อกให้คนอื่นรอ 10 นาที)
      if (this.stopped) return void this.lockApi.release(this.keepalive).catch(() => undefined);
      this.set({ kind: 'mine', lock });
    } catch (e) {
      const other = lockedBy(e);
      if (other) this.set({ kind: 'other', lock: other });
      else if (this.state.kind === 'pending') this.set({ kind: 'free' });
    } finally {
      this.busy = false;
    }
  }

  start(): void {
    void this.beat();
    this.waitTimer = setTimeout(() => {
      if (this.state.kind === 'pending') this.set({ kind: 'free' });
    }, LOCK_TIMEOUT_MS);
    this.timer = setInterval(() => {
      // ต่ออายุ/ลองใหม่เฉพาะเมื่อมีกิจกรรมตั้งแต่รอบก่อน
      if (this.active && this.state.kind !== 'pending') {
        this.active = false;
        void this.beat();
      }
    }, this.everyMs);
  }

  /** ขอใหม่ทันที (เช่น เพิ่งปลดล็อกของผู้อื่นสำเร็จ / บันทึกแล้วได้ 409) */
  retry(): void {
    void this.beat();
  }

  /** ผู้ใช้พิมพ์/คลิกในฟอร์ม */
  activity(): void {
    this.active = true;
    const k = this.state.kind;
    if ((k === 'other' || k === 'free') && Date.now() - this.lastTry >= RETRY_MIN_MS) {
      this.active = false;
      void this.beat();
    }
  }

  stop(keepalive = false): void {
    if (this.stopped) return;
    this.stopped = true;
    this.keepalive = keepalive;
    if (this.timer) clearInterval(this.timer);
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.timer = null;
    if (this.state.kind === 'mine') void this.lockApi.release(keepalive).catch(() => undefined);
  }
}

/** API ของล็อก (endpoint ชุดเดียวกับลูกค้า — /v1/orders/{id}/lock, /unlock) */
export function orderLockApi(id: string): LockApi {
  return {
    acquire: () =>
      unwrap(api.POST('/v1/orders/{id}/lock', { params: { path: { id } } })) as Promise<EditLock>,
    release: async (keepalive) => {
      await unwrap(
        api.POST('/v1/orders/{id}/unlock', {
          params: { path: { id } },
          body: {},
          ...(keepalive ? { keepalive: true } : {}),
        }),
      );
    },
  };
}

/**
 * ล็อกการแก้ของฟอร์มแก้ใบสั่ง — ขอเมื่อเปิด, ต่ออายุระหว่างใช้งาน, ปลดเมื่อปิด/ออกจากหน้า
 * `id` null = ไม่ใช้ล็อก (สร้าง/คัดลอก)
 * - กลับมาหน้าเดิมจาก bfcache (`pageshow.persisted`) หลัง `pagehide` ปลดไปแล้ว → สร้างตัวคุมใหม่แล้วขอใหม่
 * - ล็อกผูกกับผู้ใช้ ไม่ใช่แท็บ: ผู้ใช้เดียวกันเปิด 2 แท็บ = แก้ได้ทั้งคู่ (ปิดแท็บหนึ่ง = ปลด แท็บที่เหลือขอใหม่เมื่อมีกิจกรรม)
 */
export function useOrderEditLock(id: string | null): { state: LockState; retry: () => void } {
  const qc = useQueryClient();
  const [state, setState] = useState<LockState>(id ? { kind: 'pending' } : { kind: 'free' });
  const ref = useRef<{ id: string; c: EditLockController; closing?: number } | null>(null);
  useEffect(() => {
    if (!id) return;
    let prevKind: LockState['kind'] = 'pending';
    const create = () => {
      const c = new EditLockController(orderLockApi(id), (s) => {
        setState(s);
        // ป้าย/ปุ่มในหน้ารายละเอียดใช้ editLock จาก GET — โหลดใหม่เมื่อชนิดสถานะเปลี่ยนเท่านั้น (ไม่ทุก heartbeat)
        if (s.kind !== prevKind) void qc.invalidateQueries({ queryKey: ['orders', 'one', id] });
        prevKind = s.kind;
      });
      c.start();
      return c;
    };
    // StrictMode (dev) ถอด-ใส่ effect ทันที → ใช้ตัวคุมเดิมต่อ (ยกเลิกการปลดที่ตั้งไว้) ไม่ให้คำขอปลดของรอบแรก
    // ไปลบล็อกที่รอบที่สองเพิ่งได้
    let cur = ref.current;
    if (cur && cur.id === id && cur.closing !== undefined) {
      window.clearTimeout(cur.closing);
      cur.closing = undefined;
    } else {
      cur = ref.current = { id, c: create() };
    }
    const entry = cur;
    const onActivity = () => entry.c.activity();
    const onLeave = () => entry.c.stop(true);
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      prevKind = 'pending';
      setState({ kind: 'pending' });
      entry.c = create();
    };
    const events = ['keydown', 'pointerdown', 'input', 'wheel'] as const;
    for (const e of events) document.addEventListener(e, onActivity, true);
    window.addEventListener('pagehide', onLeave);
    window.addEventListener('pageshow', onShow);
    return () => {
      for (const e of events) document.removeEventListener(e, onActivity, true);
      window.removeEventListener('pagehide', onLeave);
      window.removeEventListener('pageshow', onShow);
      entry.closing = window.setTimeout(() => {
        if (ref.current === entry) ref.current = null;
        entry.c.stop(false);
        void qc.invalidateQueries({ queryKey: ['orders', 'one', id] });
      }, 0);
    };
  }, [id, qc]);
  return { state, retry: () => ref.current?.c.retry() };
}
