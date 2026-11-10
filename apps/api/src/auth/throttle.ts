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
/** แถวที่หมายถึง "ผ่านขั้นรหัสผ่านแล้ว" — หักกับแถว `attempt` ของตัวเองแบบ 1:1 */
const PASSWORD_OK = ['ok', 'tenant_selection_required', 'password_ok'];
/** รหัส 2FA ผิด (login, ตั้ง 2FA, step-up) — นับแยก ไม่มีแถวสำเร็จใดหักได้ (re-review T05) */
export const OTP_FAILED = 'otp_failed';

/**
 * วินาทีที่ยังล็อก (0 = ไม่ล็อก) ในหน้าต่าง 15 นาที — ล็อกเมื่อข้อใดข้อหนึ่งถึง 5:
 * - รหัสผ่านผิดต่ออีเมล และต่อ IP (= แถว `attempt` − แถวผ่านรหัสผ่าน; นับครบไม่ตัดจำนวน)
 * - รหัส 2FA ผิดต่ออีเมล (`otp_failed`)
 * ip = null → ไม่นับต่อ IP (ขั้น 2FA: ผู้โจมตีมีรหัสผ่านแล้ว เป้าคือบัญชีนั้น)
 */
export async function lockSeconds(
  db: PrismaClient,
  email: string,
  ip: string | null,
  now: number,
): Promise<number> {
  const since = new Date(now - LOGIN_WINDOW_MS);
  const until: number[] = [];
  for (const key of ip === null ? [{ email }] : [{ email }, { ip }]) {
    const [attempts, oks] = await Promise.all([
      db.loginAttempt.count({ where: { ...key, reason: 'attempt', createdAt: { gt: since } } }),
      db.loginAttempt.count({
        where: { ...key, reason: { in: PASSWORD_OK }, createdAt: { gt: since } },
      }),
    ]);
    if (attempts - oks >= LOGIN_MAX_FAILURES) {
      const last = await db.loginAttempt.findFirst({
        where: { ...key, reason: 'attempt', createdAt: { gt: since } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      until.push(last!.createdAt.getTime() + LOGIN_WINDOW_MS);
    }
  }
  const otp = await db.loginAttempt.findMany({
    where: { email, reason: OTP_FAILED, createdAt: { gt: since } },
    orderBy: { createdAt: 'desc' },
    take: LOGIN_MAX_FAILURES,
    select: { createdAt: true },
  });
  if (otp.length >= LOGIN_MAX_FAILURES) until.push(otp[0]!.createdAt.getTime() + LOGIN_WINDOW_MS);
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
