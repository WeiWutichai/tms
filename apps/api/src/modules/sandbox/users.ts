import type { Prisma, PrismaClient } from '@prisma/client';
import { requestContext } from '../../common/request-context';

/** ผู้ใช้ตาม id/ชื่อ — ในโหมด Sandbox ของผู้ใช้ (UI) หาในบริษัทจริง (sandbox ไม่มีผู้ใช้ของตัวเอง) */
export async function findUsers(
  tx: Prisma.TransactionClient,
  where: { ids?: string[]; name?: string },
): Promise<{ id: string; name: string; status: string }[]> {
  const sb = requestContext.get()?.sandbox;
  if (sb) return sb.users(where);
  if (where.ids && !where.ids.length) return [];
  return tx.appUser.findMany({
    where: {
      ...(where.ids ? { id: { in: where.ids } } : {}),
      ...(where.name ? { name: { contains: where.name, mode: 'insensitive' } } : {}),
    },
    select: { id: true, name: true, status: true },
  });
}

const modeCache = new Map<string, boolean>();
/** tenant เป็น sandbox ไหม (mode แก้ไม่ได้หลังสร้าง — cache ถาวรต่อ process) */
export async function isSandboxTenant(db: PrismaClient, tenantId: string): Promise<boolean> {
  const hit = modeCache.get(tenantId);
  if (hit !== undefined) return hit;
  const t = await db.tenant.findUnique({ where: { id: tenantId }, select: { mode: true } });
  if (!t) return false;
  if (modeCache.size > 10_000) modeCache.clear();
  modeCache.set(tenantId, t.mode === 'test');
  return t.mode === 'test';
}
