import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../common/problem';
import { AUTH_TX_OPTIONS, authTransaction, isTxAcquireTimeout } from './auth-tx';

const known = (code: string, message: string) =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test' });
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

  it('error อื่น (เช่น P2010 lock_timeout ระหว่างรอ advisory lock) → ส่งต่อให้ผู้เรียก (429 กันยิงถี่)', async () => {
    const $transaction = vi.fn().mockRejectedValue(known('P2010', 'Raw query failed. 55P03'));
    await expect(
      authTransaction({ $transaction } as never, async () => 1, { retryDelayMs: 0 }),
    ).rejects.toMatchObject({ code: 'P2010' });
    expect($transaction).toHaveBeenCalledTimes(1);
  });
});
