import { Injectable } from '@nestjs/common';
import type { AppUser } from '@prisma/client';
import { FieldCipher } from '../common/crypto';
import { ProblemException } from '../common/problem';
import { PrismaService } from '../db/prisma.service';
import { newBackupCodes, newTotpSecret, normalizeBackupCode, otpauthUri, verifyTotp } from './totp';
import { newOpaqueToken, sha256 } from './tokens';
import { lockSeconds, recordAttempt, type ClientInfo } from './throttle';

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
      (e: unknown) => {
        // ยังไม่มีตาราง (ก่อน ST1-T17) เท่านั้นที่ถือว่า false — error อื่นต้องไม่ทำให้ข้ามการบังคับ 2FA
        if (String((e as { message?: string }).message).includes('tenant_setting')) return [];
        throw e;
      },
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

  /**
   * challenge ที่ยังใช้ได้ — `reserve` = จองความพยายาม 1 ครั้งแบบ atomic ก่อนตรวจรหัส
   * (กันยิงพร้อมกันหลายร้อยครั้งต่อ challenge เดียว — review T05 B1); เพดาน 5 ครั้งต่อ challenge
   */
  async challenge(token: string, purpose: MfaPurpose, reserve = true) {
    const tokenHash = sha256(token);
    const live = {
      tokenHash,
      purpose,
      usedAt: null,
      attempts: { lt: MFA_MAX_ATTEMPTS },
      expiresAt: { gt: new Date() },
    };
    if (reserve) {
      const r = await this.db.mfaChallenge.updateMany({
        where: live,
        data: { attempts: { increment: 1 } },
      });
      if (r.count !== 1) throw new ProblemException('invalid_otp');
    }
    const row = await this.db.mfaChallenge.findFirst({
      where: reserve ? { tokenHash, purpose, usedAt: null, expiresAt: { gt: new Date() } } : live,
    });
    if (!row) throw new ProblemException('invalid_otp');
    const user = await this.db.appUser.findFirst({
      where: { id: row.userId, tenantId: row.tenantId, status: 'ACTIVE' },
    });
    if (!user) throw new ProblemException('invalid_otp');
    // enroll ใช้ได้เฉพาะผู้ใช้ที่ยังไม่ตั้ง 2FA — กันเขียนทับ secret ของคนที่ตั้งแล้ว (review T05 S1)
    if (purpose === 'enroll' && user.totpEnabledAt) throw new ProblemException('invalid_otp');
    return { row, user };
  }

  /** ล็อกจากความพยายามผิดของอีเมล/IP นี้ (รวมรหัสผ่านและรหัส 2FA) — 0 = ไม่ล็อก */
  async lockedFor(user: AppUser, client: ClientInfo): Promise<number> {
    void client;
    return lockSeconds(this.db, user.email.toLowerCase(), null, Date.now());
  }

  /** รหัส 2FA ผิด = ความพยายามผิด 1 ครั้งของอีเมล/IP (ไม่มีแถวสำเร็จมาหัก) — review T05 B2/B3 */
  async recordOtpFailure(user: AppUser, client: ClientInfo, reason = 'invalid_otp') {
    for (const r of ['attempt', reason])
      await recordAttempt(this.db, user.email.toLowerCase(), client, {
        success: false,
        reason: r,
        tenantId: user.tenantId,
        userId: user.id,
      });
  }

  async recordOtpSuccess(user: AppUser, client: ClientInfo, reason = 'mfa_ok') {
    await recordAttempt(this.db, user.email.toLowerCase(), client, {
      success: true,
      reason,
      tenantId: user.tenantId,
      userId: user.id,
    });
  }

  /** audit ของเหตุการณ์ความปลอดภัย (spec/01 §13.6 Event) — เขียนตรงด้วย client platform เพราะอยู่นอก transaction ของ request */
  async audit(user: AppUser, action: string, ip: string, after?: object) {
    await this.db.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorId: user.id,
        action,
        entityType: 'user',
        entityId: user.id,
        after: after ?? undefined,
        ip,
      },
    });
  }

  /** ใช้ challenge ครั้งเดียว — คืน false ถ้ามีคนใช้ไปก่อน */
  async consume(id: string): Promise<boolean> {
    const r = await this.db.mfaChallenge.updateMany({
      where: { id, usedAt: null },
      data: { usedAt: new Date() },
    });
    return r.count === 1;
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
    const r = await this.db.appUser.updateMany({
      where: { id: user.id, totpEnabledAt: null },
      data: {
        totpSecret: this.cipher.encrypt(secret),
        totpEnabledAt: new Date(),
        totpLastStep: BigInt(step),
      },
    });
    if (r.count !== 1) return null;
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
