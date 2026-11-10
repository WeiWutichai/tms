import type { PrismaClient } from '@prisma/client';

export interface ClientInfo {
  ip: string;
  userAgent?: string;
}

/** A1: ผิด 5 ครั้งใน 15 นาที (ต่อบัญชี และต่อ IP) → ครั้งที่ 6 ถูกล็อก 15 นาที */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_FAILURES = 5;

/**
 * เพดานความพยายามเข้าระบบ (ST1-T01 + T05) — ใช้ร่วมกันระหว่างรหัสผ่าน, ขั้น 2FA และ step-up
 * ทุกความพยายามเขียนแถว `attempt` ก่อน; แถวที่ยืนยันสำเร็จ (`ok`, `password_ok`, `tenant_selection_required`) หักออกทีละแถว
 * รหัส 2FA ที่ผิดเขียน `attempt` โดยไม่มีแถวสำเร็จมาหัก → นับเป็นครั้งผิดของอีเมล/IP นั้น (review T05 B2/B3)
 */
/**
 * วินาทีที่ยังล็อก — นับ "ความพยายามที่ไม่สำเร็จ" ใน 15 นาที แยกต่ออีเมลและต่อ IP
 * = แถว `attempt` − แถวที่ยืนยันสำเร็จ (`ok`, `password_ok`, `tenant_selection_required`); ถึง 5 → ล็อกจนครั้งที่ 5 นับย้อนหลังพ้นหน้าต่าง
 */
export async function lockSeconds(
  db: PrismaClient,
  email: string,
  ip: string | null,
  now: number,
): Promise<number> {
  const since = new Date(now - LOGIN_WINDOW_MS);
  const OK = ['ok', 'tenant_selection_required', 'password_ok'];
  const until: number[] = [];
  // ip = null → นับเฉพาะต่อบัญชี (ขั้น 2FA: ผู้โจมตีมีรหัสผ่านแล้ว เป้าคือบัญชีนั้น)
  for (const key of ip === null ? [{ email }] : [{ email }, { ip }]) {
    const [attempts, oks] = await Promise.all([
      db.loginAttempt.findMany({
        where: { ...key, reason: 'attempt', createdAt: { gt: since } },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { createdAt: true },
      }),
      db.loginAttempt.count({ where: { ...key, reason: { in: OK }, createdAt: { gt: since } } }),
    ]);
    const failures = attempts.length - oks;
    if (failures >= LOGIN_MAX_FAILURES)
      until.push(attempts[LOGIN_MAX_FAILURES - 1]!.createdAt.getTime() + LOGIN_WINDOW_MS);
  }
  if (until.length === 0) return 0;
  return Math.max(1, Math.ceil((Math.max(...until) - now) / 1000));
}

export async function recordAttempt(
  db: PrismaClient,
  email: string,
  client: ClientInfo,
  r: { success: boolean; reason: string; tenantId?: string; userId?: string },
) {
  await db.loginAttempt.create({
    data: {
      email,
      ip: client.ip,
      userAgent: client.userAgent?.slice(0, 500),
      success: r.success,
      reason: r.reason,
      tenantId: r.tenantId,
      userId: r.userId,
    },
  });
}
