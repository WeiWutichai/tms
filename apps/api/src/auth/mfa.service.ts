import { Injectable } from '@nestjs/common';
import type { AppUser, PrismaClient } from '@prisma/client';
import { FieldCipher } from '../common/crypto';
import { ProblemException } from '../common/problem';
import { PrismaService } from '../db/prisma.service';
import { newBackupCodes, newTotpSecret, normalizeBackupCode, otpauthUri, verifyTotp } from './totp';
import { newOpaqueToken, sha256 } from './tokens';
import { lockSeconds, OTP_FAILED, recordAttempt, type ClientInfo } from './throttle';

export const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MFA_MAX_ATTEMPTS = 5;
export const TRUSTED_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * role ที่บังคับ 2FA (docs/04 A1: owner, accounting ที่อนุมัติได้; + admin เพราะถือสิทธิ์ผู้ใช้/ตั้งค่า — plan/02 T-04)
 * owner ตั้งบังคับทั้งองค์กรได้ด้วย tenant setting `security.require2faAll` (ST1-T17)
 */
export const FORCED_2FA_ROLES = ['owner', 'admin', 'accounting'];

export type MfaPurpose = 'verify' | 'enroll';
type Db = PrismaClient;

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
        const pg = (e as { meta?: { code?: string } }).meta?.code;
        if (pg === '42P01') return []; // undefined_table เท่านั้น — error อื่น (สิทธิ์/RLS) ไม่ข้ามการบังคับ
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
   * challenge ใช้ต่อไม่ได้ (หมดอายุ/ผิดครบ/ใช้แล้ว) → 401 `mfa_expired` ให้ UI พากลับไป login ใหม่
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
      if (r.count !== 1) throw new ProblemException('mfa_expired');
    }
    const row = await this.db.mfaChallenge.findFirst({
      where: reserve ? { tokenHash, purpose, usedAt: null, expiresAt: { gt: new Date() } } : live,
    });
    if (!row) throw new ProblemException('mfa_expired');
    const user = await this.db.appUser.findFirst({
      where: { id: row.userId, tenantId: row.tenantId, status: 'ACTIVE' },
    });
    if (!user) throw new ProblemException('mfa_expired');
    // enroll ใช้ได้เฉพาะผู้ใช้ที่ยังไม่ตั้ง 2FA — กันเขียนทับ secret ของคนที่ตั้งแล้ว (review T05 S1)
    if (purpose === 'enroll' && user.totpEnabledAt) throw new ProblemException('mfa_expired');
    return { row, user };
  }

  /** ล็อกจากความพยายามผิดของอีเมล/IP นี้ (รวมรหัสผ่านและรหัส 2FA) — 0 = ไม่ล็อก */
  async lockedFor(user: AppUser, db: Db = this.db): Promise<number> {
    return lockSeconds(db, user.email.toLowerCase(), null, Date.now());
  }

  /** รหัส 2FA ผิด = ความพยายามผิด 1 ครั้งของอีเมล/IP (ไม่มีแถวสำเร็จมาหัก) — review T05 B2/B3 */
  async recordOtpFailure(user: AppUser, client: ClientInfo, db: Db = this.db) {
    await recordAttempt(db, user.email.toLowerCase(), client, {
      success: false,
      reason: OTP_FAILED,
      tenantId: user.tenantId,
      userId: user.id,
    });
  }

  /**
   * ทำงานขั้น 2FA ทีละ request ต่อผู้ใช้ (advisory lock) — ตรวจล็อก → ตรวจรหัส → บันทึกครั้งผิด อยู่ในคิวเดียว
   * กันยิงพร้อมกันหลาย challenge จนผ่านเพดาน (re-review T05); มีอีก request ถืออยู่ → 429 rate_limited ทันที
   */
  async serialized<T>(user: AppUser, fn: (db: Db) => Promise<T>): Promise<T> {
    try {
      return await this.db.$transaction(
        async (tx) => {
          // try-lock: มี request 2FA ของผู้ใช้นี้ค้างอยู่ → ตอบ 429 ทันที ไม่ต่อคิวถือ connection (ผู้ใช้จริงไม่ยิงพร้อมกัน)
          const [r] = await tx.$queryRaw<{ ok: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(3, hashtext(${user.email.toLowerCase()})) AS ok`;
          if (!r?.ok) throw new ProblemException('rate_limited');
          // ทุกอย่างใน fn ใช้ connection เดียวกับ lock (ไม่ขอ connection ที่ 2 — กัน pool ตันตอนคนเข้าพร้อมกัน)
          return fn(tx as unknown as Db);
        },
        { maxWait: 2_000, timeout: 5_000 },
      );
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'P2024' || code === 'P2028') throw new ProblemException('rate_limited');
      throw e;
    }
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
  async checkSecondFactor(
    user: AppUser,
    input: { otp?: string; backupCode?: string },
    db: Db = this.db,
  ) {
    if (!user.totpSecret || !user.totpEnabledAt) return false;
    if (input.otp) {
      const secret = this.cipher.decrypt(user.totpSecret);
      const last = user.totpLastStep == null ? null : Number(user.totpLastStep);
      const step = verifyTotp(secret, input.otp, last);
      if (step === null) return false;
      const r = await db.appUser.updateMany({
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
      const r = await db.backupCode.updateMany({
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
  async confirmEnroll(pendingSecret: string | null, user: AppUser, otp: string, db: Db = this.db) {
    if (!pendingSecret) return null;
    const secret = this.cipher.decrypt(pendingSecret);
    const step = verifyTotp(secret, otp);
    if (step === null) return null;
    const r = await db.appUser.updateMany({
      where: { id: user.id, totpEnabledAt: null },
      data: {
        totpSecret: this.cipher.encrypt(secret),
        totpEnabledAt: new Date(),
        totpLastStep: BigInt(step),
      },
    });
    if (r.count !== 1) return null;
    return this.replaceBackupCodes(user, db);
  }

  async replaceBackupCodes(user: Pick<AppUser, 'id' | 'tenantId'>, db?: Db): Promise<string[]> {
    const codes = newBackupCodes();
    const ops = (c: Db) => [
      c.backupCode.deleteMany({ where: { tenantId: user.tenantId, userId: user.id } }),
      c.backupCode.createMany({
        data: codes.map((x) => ({
          tenantId: user.tenantId,
          userId: user.id,
          codeHash: sha256(normalizeBackupCode(x)),
        })),
      }),
    ];
    if (db) for (const op of ops(db)) await op;
    else await this.db.$transaction(ops(this.db));
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
