import type { Prisma } from '@prisma/client';
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
