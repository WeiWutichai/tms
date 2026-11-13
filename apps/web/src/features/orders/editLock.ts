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

/**
 * ตัวคุมล็อกการแก้ของฟอร์ม (ST3-T08) — แยกจาก React ให้ test ด้วย fake timer ได้
 * - `start()` ขอล็อกทันที · ทุก `HEARTBEAT_MS` ถ้ามีกิจกรรม (`activity()`) ตั้งแต่ครั้งก่อน → ต่ออายุ
 * - ผู้อื่นถืออยู่ → ลองขอใหม่ทุก `HEARTBEAT_MS` (ล็อกเขาหมดอายุ/ปลดแล้ว → ได้ล็อกและแก้ต่อได้)
 * - heartbeat ได้ 409 (ถูกปลด/หมดอายุแล้วคนอื่นเอาไป) → เปลี่ยนเป็นอ่านอย่างเดียว
 * - `stop(keepalive)` ปลดล็อกถ้าถืออยู่ (ปิดฟอร์ม/ออกจากหน้า — keepalive ให้คำขอไปถึงแม้ปิดแท็บ)
 */
export class EditLockController {
  state: LockState = { kind: 'pending' };
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = false;
  private stopped = false;
  private busy = false;
  private keepalive = false;

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
    this.timer = setInterval(() => {
      const k = this.state.kind;
      // ถือล็อก: ต่ออายุเมื่อมีกิจกรรม · ผู้อื่นถือ/ขอไม่สำเร็จ: ลองใหม่
      if (k === 'mine' ? this.active : k === 'other' || k === 'free') {
        this.active = false;
        void this.beat();
      }
    }, this.everyMs);
  }

  /** ขอใหม่ทันที (เช่น เพิ่งปลดล็อกของผู้อื่นสำเร็จ) */
  retry(): void {
    void this.beat();
  }

  /** ผู้ใช้พิมพ์/คลิกในฟอร์ม */
  activity(): void {
    this.active = true;
  }

  stop(keepalive = false): void {
    if (this.stopped) return;
    this.stopped = true;
    this.keepalive = keepalive;
    if (this.timer) clearInterval(this.timer);
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
 */
export function useOrderEditLock(id: string | null): { state: LockState; retry: () => void } {
  const qc = useQueryClient();
  const [state, setState] = useState<LockState>(id ? { kind: 'pending' } : { kind: 'free' });
  const ref = useRef<{ id: string; c: EditLockController; closing?: number } | null>(null);
  useEffect(() => {
    if (!id) return;
    // StrictMode (dev) ถอด-ใส่ effect ทันที → ใช้ตัวคุมเดิมต่อ (ยกเลิกการปลดที่ตั้งไว้) ไม่ให้คำขอปลดของรอบแรก
    // ไปลบล็อกที่รอบที่สองเพิ่งได้
    let cur = ref.current;
    if (cur && cur.id === id && cur.closing !== undefined) {
      window.clearTimeout(cur.closing);
      cur.closing = undefined;
    } else {
      const c = new EditLockController(orderLockApi(id), (s) => {
        setState(s);
        // ป้าย/ปุ่มในหน้ารายละเอียดใช้ editLock จาก GET
        void qc.invalidateQueries({ queryKey: ['orders', 'one', id] });
      });
      cur = ref.current = { id, c };
      c.start();
    }
    const entry = cur;
    const c = entry.c;
    const onActivity = () => c.activity();
    const onLeave = () => c.stop(true);
    const events = ['keydown', 'pointerdown', 'input', 'wheel'] as const;
    for (const e of events) document.addEventListener(e, onActivity, true);
    window.addEventListener('pagehide', onLeave);
    return () => {
      for (const e of events) document.removeEventListener(e, onActivity, true);
      window.removeEventListener('pagehide', onLeave);
      entry.closing = window.setTimeout(() => {
        if (ref.current === entry) ref.current = null;
        c.stop(false);
        void qc.invalidateQueries({ queryKey: ['orders', 'one', id] });
      }, 0);
    };
  }, [id, qc]);
  return { state, retry: () => ref.current?.c.retry() };
}
