import { Injectable } from '@nestjs/common';
import type { AppUser } from '@prisma/client';
import { FieldCipher } from '../common/crypto';
import { ProblemException } from '../common/problem';
import { PrismaService } from '../db/prisma.service';
import { newBackupCodes, newTotpSecret, normalizeBackupCode, otpauthUri, verifyTotp } from './totp';
import { newOpaqueToken, sha256 } from './tokens';

export const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MFA_MAX_ATTEMPTS = 5;
export const TRUSTED_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * role ที่บังคับ 2FA (docs/04 A1: owner, accounting ที่อนุมัติได้; + admin เพราะถือสิทธิ์ผู้ใช้/ตั้งค่า — plan/02 T-04)
 * owner ตั้งบังคับทั้งองค์กรได้ด้วย tenant setting `security.require2faAll` (ST1-T17)
 */
export const FORCED_2FA_ROLES = ['owner', 'admin', 'accounting'];

export type MfaPurpose = 'verify' | 'enroll';

/** 2FA TOTP + backup code + จำอุปกรณ์ (ST1-T05) — ใช้ client platform เหมือน AuthService (ก่อนมี token) */
@Injectable()
export class MfaService {
  private cipherInstance?: FieldCipher;
  constructor(private readonly prisma: PrismaService) {}

  private get db() {
    return this.prisma.platform;
  }
  private get cipher() {
    return (this.cipherInstance ??= new FieldCipher());
  }

  /** ต้องผ่าน 2FA ตอน login ไหม: ตั้งไว้แล้ว / role ที่บังคับ / องค์กรบังคับทุกคน */
  async requirement(user: AppUser): Promise<'none' | 'verify' | 'enroll'> {
    if (user.totpEnabledAt && user.totpSecret) return 'verify';
    const links = await this.db.userRole.findMany({
      where: { tenantId: user.tenantId, userId: user.id },
    });
    const roles = await this.db.role.findMany({
      where: { tenantId: user.tenantId, id: { in: links.map((l) => l.roleId) } },
      select: { code: true },
    });
    if (roles.some((r) => FORCED_2FA_ROLES.includes(r.code))) return 'enroll';
    if (await this.orgRequires2fa(user.tenantId)) return 'enroll';
    return 'none';
  }

  /** ค่า `security.require2faAll` ของ tenant — registry ค่าตั้งองค์กรมาใน ST1-T17 (จนกว่าจะมี = false) */
  async orgRequires2fa(tenantId: string): Promise<boolean> {
    const rows = await this.db.$queryRaw<{ v: unknown }[]>`
      SELECT value AS v FROM tenant_setting WHERE tenant_id = ${tenantId}::uuid AND key = 'security.require2faAll'`.catch(
      () => [],
    );
    return rows[0]?.v === true;
  }

  async createChallenge(user: AppUser, purpose: MfaPurpose, codeChallenge: string) {
    const { token, hash } = newOpaqueToken();
    await this.db.mfaChallenge.create({
      data: {
        tokenHash: hash,
        tenantId: user.tenantId,
        userId: user.id,
        purpose,
        codeChallenge,
        expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_MS),
      },
    });
    return token;
  }

  /** challenge ที่ยังใช้ได้ (ไม่หมดอายุ ไม่ใช้แล้ว ผิดไม่เกินเพดาน) */
  async challenge(token: string, purpose: MfaPurpose) {
    const row = await this.db.mfaChallenge.findUnique({ where: { tokenHash: sha256(token) } });
    if (
      !row ||
      row.purpose !== purpose ||
      row.usedAt ||
      row.expiresAt <= new Date() ||
      row.attempts >= MFA_MAX_ATTEMPTS
    )
      throw new ProblemException('invalid_otp');
    const user = await this.db.appUser.findFirst({
      where: { id: row.userId, tenantId: row.tenantId, status: 'ACTIVE' },
    });
    if (!user) throw new ProblemException('invalid_otp');
    return { row, user };
  }

  /** ใช้ challenge ครั้งเดียว — คืน false ถ้ามีคนใช้ไปก่อน */
  async consume(id: string): Promise<boolean> {
    const r = await this.db.mfaChallenge.updateMany({
      where: { id, usedAt: null },
      data: { usedAt: new Date() },
    });
    return r.count === 1;
  }

  async failAttempt(id: string) {
    await this.db.mfaChallenge.update({ where: { id }, data: { attempts: { increment: 1 } } });
  }

  /**
   * ตรวจรหัสจากแอป (หรือ backup code) ของผู้ใช้ที่ตั้ง 2FA แล้ว
   * TOTP: บันทึก time-step ล่าสุดแบบมีเงื่อนไข (กันรหัสเดียวใช้ 2 ครั้งพร้อมกัน); backup: ใช้ได้ครั้งเดียว
   */
  async checkSecondFactor(user: AppUser, input: { otp?: string; backupCode?: string }) {
    if (!user.totpSecret || !user.totpEnabledAt) return false;
    if (input.otp) {
      const secret = this.cipher.decrypt(user.totpSecret);
      const last = user.totpLastStep == null ? null : Number(user.totpLastStep);
      const step = verifyTotp(secret, input.otp, last);
      if (step === null) return false;
      const r = await this.db.appUser.updateMany({
        where: {
          id: user.id,
          OR: [{ totpLastStep: null }, { totpLastStep: { lt: BigInt(step) } }],
        },
        data: { totpLastStep: BigInt(step) },
      });
      return r.count === 1;
    }
    if (input.backupCode) {
      const hash = sha256(normalizeBackupCode(input.backupCode));
      const r = await this.db.backupCode.updateMany({
        where: { tenantId: user.tenantId, userId: user.id, codeHash: hash, usedAt: null },
        data: { usedAt: new Date() },
      });
      return r.count === 1;
    }
    return false;
  }

  /** เริ่มตั้ง: สร้าง secret ใหม่ (เก็บเข้ารหัสไว้ที่ challenge จนกว่าจะยืนยัน) */
  async startEnroll(challengeId: string, user: AppUser) {
    const secret = newTotpSecret();
    await this.db.mfaChallenge.update({
      where: { id: challengeId },
      data: { pendingSecret: this.cipher.encrypt(secret) },
    });
    return { secret, otpauthUri: otpauthUri(secret, user.email) };
  }

  /** ยืนยันรหัสแรกจากแอป → เปิด 2FA + ออก backup code 10 ชุด (แสดงครั้งเดียว) */
  async confirmEnroll(pendingSecret: string | null, user: AppUser, otp: string) {
    if (!pendingSecret) return null;
    const secret = this.cipher.decrypt(pendingSecret);
    const step = verifyTotp(secret, otp);
    if (step === null) return null;
    await this.db.appUser.update({
      where: { id: user.id },
      data: {
        totpSecret: this.cipher.encrypt(secret),
        totpEnabledAt: new Date(),
        totpLastStep: BigInt(step),
      },
    });
    return this.replaceBackupCodes(user);
  }

  async replaceBackupCodes(user: Pick<AppUser, 'id' | 'tenantId'>): Promise<string[]> {
    const codes = newBackupCodes();
    await this.db.$transaction([
      this.db.backupCode.deleteMany({ where: { tenantId: user.tenantId, userId: user.id } }),
      this.db.backupCode.createMany({
        data: codes.map((c) => ({
          tenantId: user.tenantId,
          userId: user.id,
          codeHash: sha256(normalizeBackupCode(c)),
        })),
      }),
    ]);
    return codes;
  }

  async remainingBackupCodes(user: Pick<AppUser, 'id' | 'tenantId'>) {
    return this.db.backupCode.count({
      where: { tenantId: user.tenantId, userId: user.id, usedAt: null },
    });
  }

  async trustDevice(user: AppUser, client: { ip: string; userAgent?: string }) {
    const { token, hash } = newOpaqueToken();
    const expiresAt = new Date(Date.now() + TRUSTED_DEVICE_TTL_MS);
    await this.db.trustedDevice.create({
      data: {
        tokenHash: hash,
        tenantId: user.tenantId,
        userId: user.id,
        tokenVersion: user.tokenVersion,
        expiresAt,
        userAgent: client.userAgent?.slice(0, 500),
        ip: client.ip,
      },
    });
    return { token, expiresAt };
  }

  /** อุปกรณ์ที่จำไว้ยังใช้ข้าม TOTP ได้ไหม — bump tokenVersion (ระงับ/เปลี่ยน role) แล้วไม่ได้ */
  async isTrusted(token: string | undefined, user: AppUser): Promise<boolean> {
    if (!token) return false;
    const d = await this.db.trustedDevice.findUnique({ where: { tokenHash: sha256(token) } });
    return (
      !!d &&
      d.userId === user.id &&
      d.tenantId === user.tenantId &&
      !d.revokedAt &&
      d.expiresAt > new Date() &&
      d.tokenVersion === user.tokenVersion
    );
  }
}
