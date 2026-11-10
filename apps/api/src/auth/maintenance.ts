import type { PrismaClient } from '@prisma/client';

/** เก็บประวัติ login 1 ปี (docs/04 A2) */
export const LOGIN_HISTORY_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
/** อีเมลขาออก (เนื้อหาลบตั้งแต่ส่งแล้ว เหลือแค่ผู้รับ/หัวเรื่อง/สถานะ) เก็บ 90 วัน */
export const EMAIL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * งานบำรุงรักษาข้อมูล auth (รันวันละครั้งใน worker) — ใช้ client platform เพราะเป็นตาราง platform
 * - ลบประวัติ login ที่เก่ากว่า 1 ปี (ST1-T11)
 * - ลบ auth code / challenge 2FA ที่หมดอายุเกิน 1 วัน (ไม่มีค่าเก็บต่อ)
 */
export async function purgeAuthData(db: PrismaClient, now = Date.now()) {
  const day = 24 * 60 * 60 * 1000;
  const [loginAttempts, authCodes, challenges, resetTokens, emails] = await Promise.all([
    db.loginAttempt.deleteMany({
      where: { createdAt: { lt: new Date(now - LOGIN_HISTORY_RETENTION_MS) } },
    }),
    db.authCode.deleteMany({ where: { expiresAt: { lt: new Date(now - day) } } }),
    db.mfaChallenge.deleteMany({ where: { expiresAt: { lt: new Date(now - day) } } }),
    // ST1-T03: token ลืมรหัสผ่านหมดอายุเกิน 1 วัน (เก็บแค่พอใช้นับเพดานคำขอ)
    db.passwordResetToken.deleteMany({ where: { expiresAt: { lt: new Date(now - day) } } }),
    // อีเมลที่ส่งแล้ว/เลิกส่งเก็บไว้ตรวจย้อน 90 วัน
    db.emailOutbox.deleteMany({
      where: {
        status: { in: ['SENT', 'FAILED'] },
        updatedAt: { lt: new Date(now - EMAIL_RETENTION_MS) },
      },
    }),
  ]);
  return {
    loginAttempts: loginAttempts.count,
    authCodes: authCodes.count,
    challenges: challenges.count,
    resetTokens: resetTokens.count,
    emails: emails.count,
  };
}
