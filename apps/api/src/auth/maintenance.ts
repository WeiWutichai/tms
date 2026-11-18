import type { PrismaClient } from '@prisma/client';

/** อีเมลขาออก (เนื้อหาลบตั้งแต่ส่งแล้ว เหลือแค่ผู้รับ/หัวเรื่อง/สถานะ) เก็บ 90 วัน */
export const EMAIL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** แจ้งเตือน (ST1-T23) เก็บ 1 ปี เท่าประวัติ login — ค่าที่เลือกไว้ก่อน รอ PO (PROGRESS) */
export const NOTIFICATION_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * งานบำรุงรักษาข้อมูล auth (รันวันละครั้งใน worker) — ใช้ client platform เพราะเป็นตาราง platform
 * - ประวัติ login (ST1-T11) ย้ายไป retention job ST9-T14 (`RetentionService.purgeLoginLog` — ตั้งต่อ tenant ≥ 12 เดือน)
 * - ลบ auth code / challenge 2FA ที่หมดอายุเกิน 1 วัน (ไม่มีค่าเก็บต่อ)
 */
export async function purgeAuthData(db: PrismaClient, now = Date.now()) {
  const day = 24 * 60 * 60 * 1000;
  const [authCodes, challenges, resetTokens, emails, notifications] = await Promise.all([
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
    db.notification.deleteMany({
      where: { createdAt: { lt: new Date(now - NOTIFICATION_RETENTION_MS) } },
    }),
  ]);
  return {
    authCodes: authCodes.count,
    challenges: challenges.count,
    resetTokens: resetTokens.count,
    emails: emails.count,
    notifications: notifications.count,
  };
}
