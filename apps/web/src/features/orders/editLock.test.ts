import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import {
  EditLockController,
  HEARTBEAT_MS,
  LOCK_TIMEOUT_MS,
  RETRY_MIN_MS,
  lockedBy,
  type EditLock,
  type LockState,
} from './editLock';

const lock = (userName: string, mine: boolean): EditLock => ({
  userId: 'usr_1',
  userName,
  acquiredAt: '2026-11-13T02:00:00.000Z',
  lastSeenAt: '2026-11-13T02:00:00.000Z',
  expiresAt: '2026-11-13T02:10:00.000Z',
  mine,
});
const taken = (name: string) =>
  new ApiError({
    type: '',
    title: '',
    status: 409,
    code: 'order_locked_by_user',
    editLock: lock(name, false),
  } as never);

const released = (name: string) =>
  new ApiError({
    type: '',
    title: '',
    status: 409,
    code: 'order_lock_released',
    releasedBy: { userId: 'usr_m', userName: name },
    releasedAt: '2026-11-13T02:05:00.000Z',
    reason: 'ผู้แก้ไม่อยู่ ต้องแก้ด่วน',
  } as never);

/** ST3-T08: ขอล็อกเมื่อเปิด · heartbeat เฉพาะเมื่อมีกิจกรรม · ปลดเมื่อปิด · ผู้อื่นถือ = อ่านอย่างเดียว */
describe('EditLockController', () => {
  let states: LockState[];
  const flush = () => vi.advanceTimersByTimeAsync(0);
  beforeEach(() => {
    vi.useFakeTimers();
    states = [];
  });
  afterEach(() => vi.useRealTimers());

  it('ขอล็อกตอนเปิด → mine; heartbeat ทุก 60 วิ เฉพาะเมื่อมีกิจกรรม; ปิด → ปลด', async () => {
    const acquire = vi.fn().mockResolvedValue(lock('ฉัน', true));
    const release = vi.fn().mockResolvedValue(undefined);
    const c = new EditLockController({ acquire, release }, (s) => states.push(s));
    c.start();
    await flush();
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(c.state.kind).toBe('mine');
    // ไม่มีกิจกรรม → ไม่ต่ออายุ (server ปล่อยเองเมื่อครบ 10 นาที)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(acquire).toHaveBeenCalledTimes(1);
    // มีกิจกรรม → ต่ออายุรอบถัดไปครั้งเดียว
    c.activity();
    c.activity();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(acquire).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(acquire).toHaveBeenCalledTimes(2);
    c.stop(true);
    expect(release).toHaveBeenCalledWith(true);
    // หยุดแล้วไม่มี heartbeat อีก
    c.activity();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('ผู้อื่นถืออยู่ → other ไม่ปลดตอนปิด; เปิดดูเฉย ๆ ไม่ขอซ้ำ · ลองใหม่เมื่อมีกิจกรรม (ห่างกัน ≥ 10 วิ) จนได้ล็อก', async () => {
    const acquire = vi
      .fn()
      .mockRejectedValueOnce(taken('สมชาย'))
      .mockRejectedValueOnce(taken('สมชาย'))
      .mockResolvedValue(lock('ฉัน', true));
    const release = vi.fn().mockResolvedValue(undefined);
    const c = new EditLockController({ acquire, release }, (s) => states.push(s));
    c.start();
    await flush();
    expect(c.state).toMatchObject({ kind: 'other', lock: { userName: 'สมชาย' } });
    // ไม่มีกิจกรรม → ไม่ขอซ้ำเลย (ไม่ยึดล็อกเมื่อของเขาหมดอายุ)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 5);
    expect(acquire).toHaveBeenCalledTimes(1);
    c.activity();
    await flush();
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(c.state.kind).toBe('other');
    // กิจกรรมถี่ ๆ ภายใน 10 วิ ไม่ขอซ้ำทันที
    c.activity();
    await flush();
    expect(acquire).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RETRY_MIN_MS);
    c.activity();
    await flush();
    expect(c.state.kind).toBe('mine');
    expect(acquire).toHaveBeenCalledTimes(3);
    c.stop();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('ขอล็อกไม่ได้คำตอบภายใน 10 วิ → free (บันทึกไม่ค้าง); ได้คำตอบทีหลัง → mine', async () => {
    let resolve!: (l: EditLock) => void;
    const acquire = vi.fn(() => new Promise<EditLock>((r) => (resolve = r)));
    const c = new EditLockController(
      { acquire, release: vi.fn().mockResolvedValue(undefined) },
      (s) => states.push(s),
    );
    c.start();
    await vi.advanceTimersByTimeAsync(LOCK_TIMEOUT_MS - 1);
    expect(c.state.kind).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(c.state.kind).toBe('free');
    resolve(lock('ฉัน', true));
    await flush();
    expect(c.state.kind).toBe('mine');
    c.stop();
  });

  it('heartbeat ได้ 409 (ถูกปลด/หมดอายุแล้วคนอื่นเอาไป) → other และปิดแล้วไม่ปลดของคนอื่น', async () => {
    const acquire = vi
      .fn()
      .mockResolvedValueOnce(lock('ฉัน', true))
      .mockRejectedValue(taken('ผู้จัดการ'));
    const release = vi.fn().mockResolvedValue(undefined);
    const c = new EditLockController({ acquire, release }, (s) => states.push(s));
    c.start();
    await flush();
    c.activity();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(c.state).toMatchObject({ kind: 'other', lock: { userName: 'ผู้จัดการ' } });
    c.stop();
    expect(release).not.toHaveBeenCalled();
  });

  it('ขอไม่สำเร็จด้วยเหตุอื่น → free (แก้ต่อได้ server ตรวจตอนบันทึก)', async () => {
    const acquire = vi.fn().mockRejectedValue(new Error('network'));
    const c = new EditLockController({ acquire, release: vi.fn() }, (s) => states.push(s));
    c.start();
    await flush();
    expect(c.state.kind).toBe('free');
    c.stop();
  });

  it('ปิดฟอร์มก่อนได้ผลการขอ → ปลดทันทีเมื่อได้ล็อก (ไม่ค้าง 10 นาที)', async () => {
    let resolve!: (l: EditLock) => void;
    const acquire = vi.fn(() => new Promise<EditLock>((r) => (resolve = r)));
    const release = vi.fn().mockResolvedValue(undefined);
    const c = new EditLockController({ acquire, release }, (s) => states.push(s));
    c.start();
    c.stop(true);
    expect(release).not.toHaveBeenCalled();
    resolve(lock('ฉัน', true));
    await flush();
    expect(release).toHaveBeenCalledWith(true);
    expect(states).toEqual([]);
  });

  it('QA: ถูกปลดล็อก → heartbeat ได้ 409 order_lock_released → released (ไม่ขอซ้ำ/ไม่ปลดตอนปิด) · ครั้งแรก = เปิดแก้, ต่อจากนั้น = heartbeat', async () => {
    const acquire = vi
      .fn()
      .mockResolvedValueOnce(lock('ฉัน', true))
      .mockRejectedValueOnce(released('ผู้จัดการ'))
      .mockResolvedValue(lock('ฉัน', true));
    const release = vi.fn().mockResolvedValue(undefined);
    const c = new EditLockController({ acquire, release }, (s) => states.push(s));
    c.start();
    await flush();
    expect(acquire).toHaveBeenLastCalledWith(false);
    c.activity();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(acquire).toHaveBeenLastCalledWith(true);
    expect(c.state).toMatchObject({ kind: 'released', by: 'ผู้จัดการ' });
    // ไม่ได้ล็อกคืนเอง ไม่ว่ามีกิจกรรมหรือเวลาผ่านไป
    c.activity();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    c.activity();
    await flush();
    expect(acquire).toHaveBeenCalledTimes(2);
    // retry หลังบันทึกได้ 409 = heartbeat · retry(true) = ผู้ใช้ตั้งใจเปิดแก้
    c.retry();
    await flush();
    expect(acquire).toHaveBeenLastCalledWith(true);
    c.retry(true);
    await flush();
    expect(acquire).toHaveBeenLastCalledWith(false);
    c.stop();
  });

  it('lockedBy อ่านผู้ถือจาก problem 409 เท่านั้น', () => {
    expect(lockedBy(taken('สมชาย'))?.userName).toBe('สมชาย');
    expect(lockedBy(new Error('x'))).toBeNull();
  });
});
