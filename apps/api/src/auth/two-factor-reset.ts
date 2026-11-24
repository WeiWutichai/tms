import type { AppUser, Prisma, PrismaClient } from '@prisma/client';
import { safeName } from '../common/safe-text';
import type { EmailService } from '../modules/email/email.service';

type Tx = Prisma.TransactionClient | PrismaClient;

/** วันเวลาในอีเมลแจ้ง (เวลาไทย) */
const formatAt = (d: Date) =>
  new Intl.DateTimeFormat('th-TH', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Bangkok',
  }).format(d);

/**
 * คำถามค้าง #81 (PO 24 พ.ย. 2569) — รีเซ็ต 2FA ของผู้ใช้ที่ทำเครื่องหาย + รหัสสำรองหมด
 * ผู้ทำ: ผู้ดูแลของบริษัท (`POST /v1/users/{id}/reset-2fa`) หรือทีม Innovera (`POST /v1/platform/tenants/{id}/users/{userId}/reset-2fa`)
 * — ทั้งสองทางต้อง step-up + เหตุผล + audit (ผู้เรียกบันทึกเอง) + อีเมลแจ้งเจ้าของบัญชี
 *
 * ผล: ล้าง TOTP + รหัสสำรองทั้งหมด · bump tokenVersion (access token + อุปกรณ์ที่จำไว้ใช้ไม่ได้) · เพิกถอน refresh token
 * + อุปกรณ์ที่จำไว้ + ขั้น 2FA ที่ค้าง · login ครั้งถัดไป: role ที่บังคับ 2FA (D-78) → ขั้นตั้ง 2FA ใหม่ (`mfa_enrollment_required`)
 *
 * @param userDb client ที่แก้แถว app_user (tx ของ request ฝั่ง tenant หรือ tx platform ฝั่ง Console)
 * @param platformDb client platform (ตาราง backup_code / refresh_token / trusted_device / mfa_challenge ไม่มี RLS ของแอป)
 */
export async function resetSecondFactor(
  userDb: Tx,
  platformDb: Tx,
  email: EmailService,
  user: AppUser,
  notify: { tenantName: string; actorName: string; byStaff: boolean; reason: string },
): Promise<AppUser> {
  const updated = await userDb.appUser.update({
    where: { id: user.id },
    data: {
      totpSecret: null,
      totpEnabledAt: null,
      totpLastStep: null,
      tokenVersion: { increment: 1 },
      version: { increment: 1 },
    },
  });
  const now = new Date();
  const who = { tenantId: user.tenantId, userId: user.id };
  await platformDb.backupCode.deleteMany({ where: who });
  await platformDb.refreshToken.updateMany({
    where: { ...who, revokedAt: null },
    data: { revokedAt: now },
  });
  await platformDb.trustedDevice.updateMany({
    where: { ...who, revokedAt: null },
    data: { revokedAt: now },
  });
  await platformDb.mfaChallenge.updateMany({
    where: { ...who, usedAt: null },
    data: { usedAt: now },
  });
  await email.enqueue(userDb, {
    tenantId: user.tenantId,
    to: user.email,
    template: 'two_factor_reset',
    locale: user.locale,
    vars: {
      tenantName: safeName(notify.tenantName),
      actorName: safeName(notify.actorName),
      byStaff: notify.byStaff,
      reason: safeName(notify.reason, 300),
      at: formatAt(now),
    },
  });
  return updated;
}
