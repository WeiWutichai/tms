import type { AppUser, Prisma, PrismaClient } from '@prisma/client';
import { ProblemException } from '../common/problem';
import { safeName } from '../common/safe-text';
import type { EmailService } from '../modules/email/email.service';
import type { MfaService } from './mfa.service';

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
 * — ทั้งสองทางต้อง step-up + เหตุผล + audit (ผู้เรียกบันทึกเอง ใน transaction เดียวกับขั้นนี้) + อีเมลแจ้งเจ้าของบัญชี
 *
 * ขั้นหลัก (ใน transaction ของผู้เรียก): ล้าง TOTP + bump tokenVersion แบบมีเงื่อนไข (`totpEnabledAt` ยังไม่ว่าง —
 * รีเซ็ตพร้อมกัน 2 ครั้ง = ครั้งที่สอง 409 ไม่มี audit/อีเมลซ้ำ) + เข้าคิวอีเมล
 * — bump tokenVersion อย่างเดียวก็ทำให้ access token, refresh token (`issue` เทียบ tokenVersion) และอุปกรณ์ที่จำไว้ใช้ไม่ได้แล้ว;
 * รหัสสำรองที่เหลือใช้ไม่ได้เมื่อไม่มี TOTP (`checkSecondFactor`) และถูกแทนทั้งชุดตอนตั้ง 2FA ใหม่
 * ขั้นเก็บกวาด (`cleanupSecondFactor`): ลบรหัสสำรอง + เพิกถอน refresh token / อุปกรณ์ที่จำไว้ / ขั้น 2FA ค้าง — ทำ**หลัง**ขั้นหลัก commit
 * (ฝั่งบริษัทผ่าน `ctx.afterCommit`) หรือใน transaction เดียวกัน (Console) → รีเซ็ตล้มเหลว = ไม่มีอะไรถูกลบ
 *
 * อีเมล: ถ้า role/องค์กรบังคับ 2FA (D-78 / ST1-T17) → "เข้าสู่ระบบครั้งถัดไปต้องตั้ง 2FA ใหม่" · ไม่บังคับ → "2FA ปิดอยู่"
 */
export async function resetSecondFactor(
  userDb: Tx,
  email: EmailService,
  mfa: MfaService,
  user: AppUser,
  notify: { tenantName: string; actorName: string; byStaff: boolean; reason: string },
): Promise<void> {
  const r = await userDb.appUser.updateMany({
    where: { id: user.id, totpEnabledAt: { not: null } },
    data: {
      totpSecret: null,
      totpEnabledAt: null,
      totpLastStep: null,
      tokenVersion: { increment: 1 },
      version: { increment: 1 },
    },
  });
  if (r.count !== 1) throw new ProblemException('invalid_state_transition');
  const mustEnroll =
    (await mfa.requirement({ ...user, totpEnabledAt: null, totpSecret: null })) === 'enroll';
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
      at: formatAt(new Date()),
      mustEnroll,
    },
  });
}

/** ขั้นเก็บกวาดหลังรีเซ็ต (ตาราง platform ไม่มี RLS ของแอป) — เรียกหลังขั้นหลักสำเร็จเท่านั้น */
export async function cleanupSecondFactor(
  platformDb: Tx,
  user: Pick<AppUser, 'id' | 'tenantId'>,
): Promise<void> {
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
}
