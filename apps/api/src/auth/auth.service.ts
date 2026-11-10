import { Injectable } from '@nestjs/common';
import type { AppUser, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { encodeId } from '../common/ids';
import { ProblemException } from '../common/problem';
import { PrismaService } from '../db/prisma.service';
import { MFA_CHALLENGE_TTL_MS, MfaService } from './mfa.service';
import { lockSeconds, recordAttempt, type ClientInfo } from './throttle';
import { readSettings } from '../modules/settings/settings.service';
export { LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, type ClientInfo } from './throttle';
import { dummyHash, verifyPassword } from './password';
import {
  newOpaqueToken,
  pkceChallenge,
  sha256,
  signAccessToken,
  ACCESS_TTL_SECONDS,
} from './tokens';

const CODE_TTL_MS = 60 * 1000;
export const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** idle 8 ชม. ค่าเริ่มต้น — tenant ตั้งเองได้ที่ `security.idleTimeoutMinutes` (ST1-T17) */
/** review 10 พ.ย. 2569 ข้อ 3 */
export const REFRESH_REUSE_GRACE_MS = 30 * 1000;
export const IDLE_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_TENANT_STATUSES = ['TRIAL', 'ACTIVE'] as const;

export interface TokenPair {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
}

/**
 * Login + Auth Code/PKCE + refresh (ST1-T01, T04)
 * ทำงานก่อนรู้ tenant จึงใช้ client `platform` (BYPASSRLS) — จำกัดเฉพาะตาราง auth และการค้นผู้ใช้ด้วยอีเมล
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mfa: MfaService,
  ) {}

  private get db() {
    return this.prisma.platform;
  }

  /**
   * ตรวจรหัสผ่าน → คืน authorization code (ผูก code_challenge)
   * กันยิงพร้อมกัน (review 10 พ.ย. 2569): จองช่องก่อนตรวจรหัส —
   *   1) transaction สั้น: advisory lock ต่ออีเมลและ IP → นับ → ถ้ายังไม่เกินเพดาน เขียนแถว `attempt` → commit
   *   2) ตรวจ argon2 นอก transaction (ไม่ถือ connection ระหว่างคำนวณ)
   *   3) เขียนผล (`ok` / `invalid_credentials` / …)
   * ความพยายามที่ยังไม่มีผล นับเป็นครั้งผิดไว้ก่อน (fail closed) จึงผ่านไปตรวจรหัสได้ไม่เกิน 5 ครั้งต่อหน้าต่าง
   */
  async login(
    input: {
      email: string;
      password: string;
      codeChallenge: string;
      tenantId?: string;
      trustedDevice?: string;
    },
    client: ClientInfo,
  ): Promise<{ code: string; expiresIn: number }> {
    const email = input.email.trim().toLowerCase();
    const db = this.db;
    let lockedFor = 0;
    try {
      lockedFor = await db.$transaction(
        async (tx) => {
          // key 2 ตัว (namespace, hash) แยกอีเมลกับ IP ไม่ให้ชนกัน; ล็อกเรียง อีเมล → IP เสมอ กัน deadlock
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(1, hashtext(${email}))`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(2, hashtext(${client.ip}))`;
          const t = tx as unknown as PrismaClient;
          const locked = await lockSeconds(t, email, client.ip, Date.now());
          await recordAttempt(t, email, client, {
            success: false,
            reason: locked > 0 ? 'locked' : 'attempt',
          });
          return locked;
        },
        { maxWait: 2_000, timeout: 5_000 },
      );
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'P2024' || code === 'P2028' || code === 'P2010')
        throw new ProblemException('rate_limited');
      throw e;
    }
    if (lockedFor > 0)
      throw new ProblemException('account_locked', undefined, undefined, { retryAfter: lockedFor });
    return this.verifyAndIssueCode(db, email, input, client);
  }

  private async verifyAndIssueCode(
    db: PrismaClient,
    email: string,
    input: { password: string; codeChallenge: string; tenantId?: string; trustedDevice?: string },
    client: ClientInfo,
  ): Promise<{ code: string; expiresIn: number }> {
    const users = await db.appUser.findMany({
      where: { email: { equals: email, mode: 'insensitive' }, status: 'ACTIVE' },
    });
    const tenants = await db.tenant.findMany({
      where: {
        id: { in: users.map((u) => u.tenantId) },
        status: { in: [...LOGIN_TENANT_STATUSES] },
      },
    });
    const candidates = users.filter(
      (u) => u.passwordHash && tenants.some((t) => t.id === u.tenantId),
    );

    const matched = [];
    for (const u of candidates) {
      if (await verifyPassword(u.passwordHash!, input.password)) matched.push(u);
    }
    if (candidates.length === 0) await verifyPassword(await dummyHash(), input.password);

    const chosen = input.tenantId ? matched.filter((u) => u.tenantId === input.tenantId) : matched;
    if (chosen.length === 0) {
      await recordAttempt(db, email, client, { success: false, reason: 'invalid_credentials' });
      throw new ProblemException('invalid_credentials');
    }
    if (chosen.length > 1) {
      await recordAttempt(db, email, client, {
        success: false,
        reason: 'tenant_selection_required',
      });
      throw new ProblemException('tenant_selection_required', undefined, undefined, {
        tenants: chosen
          .map((u) => tenants.find((t) => t.id === u.tenantId)!)
          .map((t) => ({
            id: encodeId('tenant', t.id),
            name: t.name,
            status: t.status.toLowerCase(),
          })),
      });
    }

    const user = chosen[0]!;
    // ST1-T05: รหัสผ่านถูกแล้ว → ขั้นที่ 2 (TOTP) ถ้าจำเป็น; อุปกรณ์ที่จำไว้ 30 วันข้ามได้
    const need = await this.mfa.requirement(user);
    if (
      need !== 'none' &&
      !(need === 'verify' && (await this.mfa.isTrusted(input.trustedDevice, user)))
    ) {
      await recordAttempt(db, email, client, {
        success: false,
        reason: 'password_ok',
        tenantId: user.tenantId,
        userId: user.id,
      });
      const mfaToken = await this.mfa.createChallenge(user, need, input.codeChallenge);
      throw new ProblemException(
        need === 'verify' ? 'mfa_required' : 'mfa_enrollment_required',
        undefined,
        undefined,
        { mfaToken, expiresIn: MFA_CHALLENGE_TTL_MS / 1000 },
      );
    }
    const code = await this.issueAuthCode(user, input.codeChallenge);
    await recordAttempt(db, email, client, {
      success: true,
      reason: 'ok',
      tenantId: user.tenantId,
      userId: user.id,
    });
    return { code, expiresIn: CODE_TTL_MS / 1000 };
  }

  /** ออก authorization code (ผูก PKCE) หลังผ่านทุกขั้น — ใช้ทั้ง login ปกติและหลังผ่าน 2FA */
  async issueAuthCode(user: AppUser, codeChallenge: string): Promise<string> {
    const now = Date.now();
    const { token: code, hash } = newOpaqueToken();
    await this.db.authCode.create({
      data: {
        codeHash: hash,
        codeChallenge,
        tenantId: user.tenantId,
        userId: user.id,
        expiresAt: new Date(now + CODE_TTL_MS),
      },
    });
    await this.db.appUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date(now) } });
    return code;
  }

  /** grant_type=authorization_code — ตรวจ PKCE แล้วออก access + refresh */
  async exchangeCode(code: string, verifier: string, client: ClientInfo): Promise<TokenPair> {
    const row = await this.db.authCode.findUnique({ where: { codeHash: sha256(code) } });
    const now = new Date();
    if (!row || row.usedAt || row.expiresAt <= now || pkceChallenge(verifier) !== row.codeChallenge)
      throw new ProblemException('invalid_grant');
    if ((await this.currentTokenVersion(row.tenantId, row.userId)) === null)
      throw new ProblemException('invalid_grant');
    const claimed = await this.db.authCode.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) throw new ProblemException('invalid_grant');
    return this.issue(
      row.tenantId,
      row.userId,
      randomUUID(),
      new Date(now.getTime() + REFRESH_TTL_MS),
      client,
    );
  }

  /** grant_type=refresh_token — หมุน token; ใช้ token เก่าซ้ำ = เพิกถอนทั้ง family */
  async refresh(refreshToken: string, client: ClientInfo): Promise<TokenPair> {
    const row = await this.db.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
    });
    const now = new Date();
    if (!row || row.revokedAt) throw new ProblemException('invalid_grant');
    if (row.usedAt) {
      if (now.getTime() - row.usedAt.getTime() > REFRESH_REUSE_GRACE_MS) {
        // ใช้ซ้ำหลังพ้น grace = ถือว่าถูกขโมย → เพิกถอนทั้ง family (A1)
        await this.revokeFamily(row.familyId);
        throw new ProblemException('invalid_grant');
      }
      // ภายใน 30 วินาที: browser เดิมที่ไม่ได้รับ cookie ใหม่ (หลายแท็บพร้อมกัน, reload ตัด response กลางทาง)
      // → ออก token ใหม่ใน family เดียวกัน เฉพาะเมื่อ IP + User-Agent ตรงกับ request ที่หมุนไป; ไม่ตรง = ปฏิเสธเฉย ๆ
      const successor = await this.db.refreshToken.findFirst({
        where: { familyId: row.familyId, createdAt: { gte: row.usedAt }, id: { not: row.id } },
        orderBy: { createdAt: 'asc' },
      });
      const sameClient =
        !!successor &&
        successor.ip === client.ip &&
        successor.userAgent === (client.userAgent?.slice(0, 500) ?? null);
      if (!sameClient || row.expiresAt <= now || row.idleExpiresAt <= now)
        throw new ProblemException('invalid_grant');
      if ((await this.currentTokenVersion(row.tenantId, row.userId)) === null)
        throw new ProblemException('invalid_grant');
      return this.issue(
        row.tenantId,
        row.userId,
        row.familyId,
        row.expiresAt,
        client,
        row.tokenVersion,
      );
    }
    if (row.expiresAt <= now || row.idleExpiresAt <= now)
      throw new ProblemException('invalid_grant');
    if ((await this.currentTokenVersion(row.tenantId, row.userId)) === null)
      throw new ProblemException('invalid_grant');
    const claimed = await this.db.refreshToken.updateMany({
      where: { id: row.id, usedAt: null, revokedAt: null },
      data: { usedAt: now },
    });
    // แพ้การแย่งกับ request ที่มาพร้อมกัน (เช่นหลายแท็บตอนเปิด browser) = เพิ่งหมุนไปเมื่อมิลลิวินาทีก่อน
    // → ปฏิเสธเฉย ๆ ไม่เพิกถอน family (web ลองซ้ำด้วย cookie ใหม่) — review รอบ 2 ข้อ 1
    if (claimed.count !== 1) throw new ProblemException('invalid_grant');
    return this.issue(
      row.tenantId,
      row.userId,
      row.familyId,
      row.expiresAt,
      client,
      row.tokenVersion,
    );
  }

  /** ออกจากระบบ: เพิกถอน refresh token ทั้ง family (ไม่บอกว่ามี token หรือไม่) */
  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    const row = await this.db.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
    });
    if (row) await this.revokeFamily(row.familyId);
  }

  /** tokenVersion ปัจจุบันของผู้ใช้ (guard ใช้ตรวจทุก request) — null = ผู้ใช้ถูกระงับ/ไม่พบ */
  async currentTokenVersion(tenantId: string, userId: string): Promise<number | null> {
    // tenant ถูกระงับ/ยกเลิก → token เดิมใช้ไม่ได้ทันที (spec/01 PLT-001; review 10 พ.ย. 2569 ข้อ 2)
    const [u, t] = await Promise.all([
      this.db.appUser.findFirst({
        where: { id: userId, tenantId, status: 'ACTIVE' },
        select: { tokenVersion: true },
      }),
      this.db.tenant.findFirst({
        where: { id: tenantId, status: { in: [...LOGIN_TENANT_STATUSES] } },
        select: { id: true },
      }),
    ]);
    return u && t ? u.tokenVersion : null;
  }

  private async issue(
    tenantId: string,
    userId: string,
    familyId: string,
    absoluteExpiry: Date,
    client: ClientInfo,
    expectedTokenVersion?: number,
  ): Promise<TokenPair> {
    const user = await this.db.appUser.findFirst({
      where: { id: userId, tenantId, status: 'ACTIVE' },
    });
    if (
      !user ||
      (expectedTokenVersion !== undefined && user.tokenVersion !== expectedTokenVersion)
    ) {
      await this.revokeFamily(familyId);
      throw new ProblemException('invalid_grant');
    }
    const scope = await this.scopeOf(tenantId, userId);
    const accessToken = await signAccessToken({
      sub: userId,
      tid: tenantId,
      scope,
      pt: 'user',
      tv: user.tokenVersion,
    });
    const { token, hash } = newOpaqueToken();
    const now = Date.now();
    const idleMs = await this.idleMs(tenantId);
    await this.db.refreshToken.create({
      data: {
        tokenHash: hash,
        familyId,
        tenantId,
        userId,
        tokenVersion: user.tokenVersion,
        expiresAt: absoluteExpiry,
        idleExpiresAt: new Date(Math.min(now + idleMs, absoluteExpiry.getTime())),
        userAgent: client.userAgent?.slice(0, 500),
        ip: client.ip,
      },
    });
    return {
      accessToken,
      expiresIn: ACCESS_TTL_SECONDS,
      refreshToken: token,
      refreshExpiresAt: absoluteExpiry,
    };
  }

  /** scope = permission ของทุก role ที่ผู้ใช้ถือ (ST1-T12 ขยายเป็นตาราง A3) */
  /**
   * idle timeout ของ tenant (ST1-T17 `security.idleTimeoutMinutes`, ปิด `security.autoLogout` = ไม่ตัดตามเวลาไม่ใช้งาน
   * เหลือแค่อายุสูงสุด 7 วัน) — ไม่ตั้ง = 8 ชม. ตาม docs/04 A1
   */
  private async idleMs(tenantId: string): Promise<number> {
    const v = await readSettings(this.db, tenantId, [
      'security.autoLogout',
      'security.idleTimeoutMinutes',
    ]);
    if (v['security.autoLogout'] === false) return REFRESH_TTL_MS;
    const m = Number(v['security.idleTimeoutMinutes']);
    return Number.isFinite(m) && m > 0 ? m * 60 * 1000 : IDLE_TTL_MS;
  }

  private async scopeOf(tenantId: string, userId: string): Promise<string> {
    const links = await this.db.userRole.findMany({ where: { tenantId, userId } });
    if (links.length === 0) return '';
    const roles = await this.db.role.findMany({
      where: { tenantId, id: { in: links.map((l) => l.roleId) } },
    });
    return [...new Set(roles.flatMap((r) => r.permissions))].sort().join(' ');
  }

  private async revokeFamily(familyId: string) {
    await this.db.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** วินาทีที่ยังถูกล็อก (0 = ไม่ล็อก) — นับเฉพาะครั้งที่รหัสผิด */
}
