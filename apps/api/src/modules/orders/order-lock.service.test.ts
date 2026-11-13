import { describe, expect, it, vi } from 'vitest';
import { Clock } from '../../common/clock';
import { requestContext } from '../../common/request-context';
import { OrderLockService } from './order-lock.service';

/**
 * ST3-T08 review: เส้นทางที่จังหวะชนกันจริงสร้างยากใน integration test — ตรวจด้วย tx ปลอม
 * (1) PATCH: ต่ออายุไม่สำเร็จเพราะล็อกเปลี่ยนมือหลังอ่าน → 409 · (2) ปลดล็อกหมดอายุของคนอื่น = ลบเฉพาะเมื่อยังหมดอายุ
 */
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const SO = '00000000-0000-4000-8000-0000000000f1';
const NOW = new Date('2026-11-13T02:05:00.000Z');
const row = (userId: string, expiresAt: Date) => ({
  id: 'l1',
  userId,
  acquiredAt: new Date('2026-11-13T02:00:00.000Z'),
  lastSeenAt: new Date('2026-11-13T02:00:00.000Z'),
  expiresAt,
  user: { name: userId === A ? 'เอ' : 'บี' },
});

function make(tx: Record<string, unknown>) {
  const clock = new Clock();
  clock.set(NOW);
  const svc = new OrderLockService({ tx } as never, clock, { record: vi.fn() } as never);
  const as = <T>(actorId: string, fn: () => Promise<T>) =>
    requestContext.run({ requestId: 'r', tenantId: 't', actorId, locale: 'th', scopes: [] }, fn);
  return { svc, as };
}

describe('OrderLockService (ST3-T08)', () => {
  it('PATCH ของผู้ถือ: ต่ออายุไม่สำเร็จ (คนอื่นได้ล็อกไปแล้ว) → 409 order_locked_by_user', async () => {
    const later = new Date(NOW.getTime() + 60_000);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'l1', user_id: A, expires_at: later }]),
      orderEditLock: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue(row(B, new Date(NOW.getTime() + 600_000))),
      },
    };
    const { svc, as } = make(tx);
    await expect(as(A, () => svc.assertWritable(SO))).rejects.toMatchObject({
      code: 'order_locked_by_user',
    });
  });

  it('PATCH ของผู้ถือ: ต่ออายุสำเร็จ → ผ่าน', async () => {
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValue([{ id: 'l1', user_id: A, expires_at: new Date(NOW.getTime() + 1) }]),
      orderEditLock: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn() },
    };
    const { svc, as } = make(tx);
    await expect(as(A, () => svc.assertWritable(SO))).resolves.toBeUndefined();
    expect(tx.orderEditLock.findUnique).not.toHaveBeenCalled();
  });

  it('ปลดล็อกที่หมดอายุของคนอื่น → ลบเฉพาะเมื่อยังหมดอายุ (expiresAt ≤ now) · ของตัวเองลบตาม id + ผู้ถือ', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUnique = vi.fn().mockResolvedValue(row(A, new Date(NOW.getTime() - 1)));
    const { svc, as } = make({ orderEditLock: { findUnique, deleteMany } });
    await as(B, () => svc.release(SO));
    expect(deleteMany).toHaveBeenLastCalledWith({
      where: { id: 'l1', userId: A, expiresAt: { lte: NOW } },
    });
    findUnique.mockResolvedValue(row(A, new Date(NOW.getTime() + 60_000)));
    await as(A, () => svc.release(SO));
    expect(deleteMany).toHaveBeenLastCalledWith({ where: { id: 'l1', userId: A } });
  });
});
