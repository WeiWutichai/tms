import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../common/problem';
import { AUTH_TX_OPTIONS, authTransaction, isLockTimeout, isTxAcquireTimeout } from './auth-tx';

const known = (code: string, message: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test', meta });
const lockTimeout = () =>
  known(
    'P2010',
    'Raw query failed. Code: `55P03`. Message: `canceling statement due to lock timeout`',
    {
      code: '55P03',
      message: 'canceling statement due to lock timeout',
    },
  );
const startTimeout = () =>
  known('P2028', 'Transaction API error: Unable to start a transaction in the given time.');
const expired = () =>
  known(
    'P2028',
    'Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction.',
  );

describe('authTransaction (login/2FA ภายใต้ DB โหลดหนัก)', () => {
  it('แยก "เริ่ม transaction ไม่ทัน" ออกจาก "หมดเวลาระหว่างทำงาน"', () => {
    expect(isTxAcquireTimeout(startTimeout())).toBe(true);
    expect(isTxAcquireTimeout(known('P2024', 'Timed out fetching a new connection'))).toBe(true);
    expect(isTxAcquireTimeout(expired())).toBe(false);
    expect(isTxAcquireTimeout(known('P2010', 'Raw query failed'))).toBe(false);
    expect(isTxAcquireTimeout(new Error('x'))).toBe(false);
  });

  it('เริ่มไม่ทันครั้งแรก → ลองใหม่ 1 ครั้งแล้วสำเร็จ', async () => {
    const $transaction = vi
      .fn()
      .mockRejectedValueOnce(startTimeout())
      .mockImplementationOnce(async (fn: (tx: unknown) => Promise<number>) =>
        fn({ $executeRawUnsafe: vi.fn() }),
      );
    const r = await authTransaction({ $transaction } as never, async () => 7, { retryDelayMs: 0 });
    expect(r).toBe(7);
    expect($transaction).toHaveBeenCalledTimes(2);
    expect($transaction.mock.calls[0]![1]).toEqual(AUTH_TX_OPTIONS);
  });

  it('เริ่มไม่ทัน 2 ครั้ง → 503 service_busy + Retry-After (ไม่ใช่ 429)', async () => {
    const $transaction = vi.fn().mockRejectedValue(startTimeout());
    const p = authTransaction({ $transaction } as never, async () => 1, { retryDelayMs: 0 });
    await expect(p).rejects.toBeInstanceOf(ProblemException);
    await p.catch((e: ProblemException) => {
      expect(e.code).toBe('service_busy');
      expect(e.getStatus()).toBe(503);
      expect(e.extra).toMatchObject({ retryAfter: expect.any(Number), retryable: true });
    });
    expect($transaction).toHaveBeenCalledTimes(2);
  });

  it('transaction หมดเวลาระหว่างทำงาน (DB ช้า) → 503 service_busy ไม่ลองใหม่', async () => {
    const $transaction = vi.fn().mockRejectedValue(expired());
    await expect(
      authTransaction({ $transaction } as never, async () => 1, { retryDelayMs: 0 }),
    ).rejects.toMatchObject({ code: 'service_busy' });
    expect($transaction).toHaveBeenCalledTimes(1);
  });

  it('lockWait: รอ advisory lock เกิน lock_timeout (P2010 + 55P03) → 429 rate_limited ไม่ลองใหม่', async () => {
    expect(isLockTimeout(lockTimeout())).toBe(true);
    const $transaction = vi.fn().mockRejectedValue(lockTimeout());
    await expect(
      authTransaction({ $transaction } as never, async () => 1, {
        lockWait: true,
        retryDelayMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    expect($transaction).toHaveBeenCalledTimes(1);
  });

  it('P2010 อื่น (ไม่ใช่ 55P03) → ไม่กลบเป็น 429 ส่ง error เดิมต่อ (ProblemFilter → 500)', async () => {
    const other = known('P2010', 'Raw query failed. Code: `42601`. Message: `syntax error`', {
      code: '42601',
      message: 'syntax error',
    });
    expect(isLockTimeout(other)).toBe(false);
    const $transaction = vi.fn().mockRejectedValue(other);
    await expect(
      authTransaction({ $transaction } as never, async () => 1, {
        lockWait: true,
        retryDelayMs: 0,
      }),
    ).rejects.toBe(other);
    expect($transaction).toHaveBeenCalledTimes(1);
  });

  it('ไม่มี lockWait (2FA ใช้ try-lock) → ไม่ตั้ง lock_timeout', async () => {
    const tx = { $executeRawUnsafe: vi.fn() };
    const $transaction = vi.fn(async (fn: (t: unknown) => Promise<number>) => fn(tx));
    await authTransaction({ $transaction } as never, async () => 1);
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    await authTransaction({ $transaction } as never, async () => 1, { lockWait: true });
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith("SET LOCAL lock_timeout = '2s'");
  });
});
