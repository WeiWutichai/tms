import { Injectable, Logger } from '@nestjs/common';
import type { AppUser, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { ProblemException } from '../common/problem';
import { PrismaService } from '../db/prisma.service';
import { hashPassword, verifyPassword } from './password';
import { isLocalEnv } from './tokens';

/**
 * นโยบายรหัสผ่าน (ST1-T02; docs/04 A1): ≥ 12 ตัว, ไม่อยู่ในรายการรหัสที่รั่ว (HIBP k-anonymity),
 * ห้ามซ้ำ 5 ครั้งล่าสุด, ไม่บังคับเปลี่ยนตามเวลา
 * ใช้ตอนตั้งรหัสทุกทาง: เปลี่ยนเอง (/me/password), ลืมรหัส (T03), รับคำเชิญ (T07)
 */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;
export const PASSWORD_HISTORY = 5;

/** ตรวจรหัสรั่ว — ส่งแค่ 5 ตัวแรกของ SHA-1 ออกไป (k-anonymity) */
export interface BreachChecker {
  isBreached(password: string): Promise<boolean>;
}

/**
 * Have I Been Pwned range API — เปิดด้วย HIBP_ENABLED=true (production)
 * เรียกไม่ได้ (เน็ตล่ม/timeout) → ปล่อยผ่านและ log (ไม่ให้ผู้ใช้ตั้งรหัสไม่ได้เพราะบริการภายนอก)
 */
export class HibpChecker implements BreachChecker {
  private readonly log = new Logger('HibpChecker');
  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 3000,
  ) {}

  async isBreached(password: string): Promise<boolean> {
    const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    try {
      const res = await this.fetchFn(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: { 'Add-Padding': 'true', 'User-Agent': 'tms-password-policy' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`HIBP ${res.status}`);
      const body = await res.text();
      return body.split('\n').some((line) => {
        const [s, count] = line.trim().split(':');
        return s === suffix && Number(count) > 0;
      });
    } catch (e) {
      this.log.warn(`breach check skipped: ${(e as Error).message}`);
      return false;
    }
  }
}

/** dev/test: ไม่เรียกเน็ต — ใช้รายการรหัสยอดนิยมเล็ก ๆ แทน */
export class LocalBreachChecker implements BreachChecker {
  private static readonly COMMON = new Set([
    'password1234',
    '123456789012',
    'qwertyuiop12',
    'passwordpassword',
    'iloveyou1234',
    'admin1234567',
  ]);
  async isBreached(password: string) {
    return LocalBreachChecker.COMMON.has(password.toLowerCase());
  }
}

@Injectable()
export class PasswordPolicy {
  /** HIBP เปิดเสมอนอกเครื่อง dev/test (ปิดได้ด้วย HIBP_ENABLED=false เท่านั้น) — ลืมตั้งค่าต้องไม่ทำให้ข้ามการตรวจ */
  readonly breach: BreachChecker =
    process.env.HIBP_ENABLED === 'true' || (!isLocalEnv() && process.env.HIBP_ENABLED !== 'false')
      ? new HibpChecker()
      : new LocalBreachChecker();

  constructor(private readonly prisma: PrismaService) {}

  /** ตรวจรหัสใหม่ — ผิดข้อใดคืน 422 พร้อม code ต่อ field (UI แปลเป็นข้อความไทย) */
  async validate(
    password: string,
    user?: Pick<AppUser, 'id' | 'tenantId' | 'passwordHash'>,
    field = 'newPassword',
  ) {
    const fail = (code: string, message: string) =>
      new ProblemException('validation_failed', undefined, [{ field, code, message }]);
    if (password.length < PASSWORD_MIN)
      throw fail('password_too_short', `password must be at least ${PASSWORD_MIN} characters`);
    if (password.length > PASSWORD_MAX) throw fail('password_too_long', 'password is too long');
    if (user) {
      const recent = await this.prisma.platform.passwordHistory.findMany({
        where: { tenantId: user.tenantId, userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: PASSWORD_HISTORY,
      });
      const hashes = [user.passwordHash, ...recent.map((r) => r.passwordHash)].filter(
        (h): h is string => !!h,
      );
      for (const h of hashes.slice(0, PASSWORD_HISTORY))
        if (await verifyPassword(h, password))
          throw fail(
            'password_reused',
            `password was used in the last ${PASSWORD_HISTORY} changes`,
          );
    }
    if (await this.breach.isBreached(password))
      throw fail('password_breached', 'password appears in a known data breach');
  }

  /**
   * ตั้งรหัสใหม่หลังผ่านนโยบาย — เก็บรหัสเดิมเข้าประวัติ, bump tokenVersion (ทุก session + อุปกรณ์ที่จำไว้หลุดทันที),
   * เพิกถอน refresh token ทั้งหมด และลง audit ใน transaction เดียว
   * เขียนแบบมีเงื่อนไข (hash เดิมต้องยังเหมือนตอนอ่าน) — เปลี่ยนพร้อมกันสองทาง ทางหลัง 409
   */
  async setPassword(
    user: AppUser,
    password: string,
    meta: { ip?: string; requestId?: string } = {},
  ) {
    await this.validate(password, user);
    const hash = await hashPassword(password);
    await this.prisma.platform.$transaction((tx) =>
      this.apply(tx, user, hash, 'security.password_changed', meta),
    );
  }

  /**
   * เขียนรหัสใหม่ (hash แล้ว) ใน transaction ของผู้เรียก — ใช้ร่วมกับลืมรหัสผ่าน (T03) ที่ต้องใช้ token ใน transaction เดียวกัน
   * เขียนแบบมีเงื่อนไข: hash เดิมต้องยังเหมือนตอนอ่าน ไม่งั้น 412
   */
  async apply(
    tx: Prisma.TransactionClient,
    user: AppUser,
    hash: string,
    action: 'security.password_changed' | 'auth.password_reset',
    meta: { ip?: string; requestId?: string } = {},
  ) {
    const r = await tx.appUser.updateMany({
      where: { id: user.id, passwordHash: user.passwordHash },
      data: { passwordHash: hash, tokenVersion: { increment: 1 } },
    });
    if (r.count !== 1) throw new ProblemException('precondition_failed');
    if (user.passwordHash)
      await tx.passwordHistory.create({
        data: { tenantId: user.tenantId, userId: user.id, passwordHash: user.passwordHash },
      });
    await tx.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorId: user.id,
        action,
        entityType: 'user',
        entityId: user.id,
        ip: meta.ip ?? null,
        requestId: meta.requestId ?? null,
      },
    });
    await tx.refreshToken.updateMany({
      where: { tenantId: user.tenantId, userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // เก็บแค่ 5 ครั้งล่าสุด
    const old = await tx.passwordHistory.findMany({
      where: { tenantId: user.tenantId, userId: user.id },
      orderBy: { createdAt: 'desc' },
      skip: PASSWORD_HISTORY,
      select: { id: true },
    });
    if (old.length)
      await tx.passwordHistory.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  }
}
