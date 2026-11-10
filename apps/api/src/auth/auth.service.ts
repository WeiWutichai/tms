import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { encodeId } from '../common/ids';
import { ProblemException } from '../common/problem';
import { PrismaService } from '../db/prisma.service';
import { dummyHash, verifyPassword } from './password';
import {
  newOpaqueToken,
  pkceChallenge,
  sha256,
  signAccessToken,
  ACCESS_TTL_SECONDS,
} from './tokens';

/** A1: ผิด 5 ครั้งใน 15 นาที (ต่อบัญชี และต่อ IP) → ครั้งที่ 6 ถูกล็อก 15 นาที */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_FAILURES = 5;
const CODE_TTL_MS = 60 * 1000;
export const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** idle 8 ชม. — ST1-T17 จะอ่านจาก tenant_setting */
/** review 10 พ.ย. 2569 ข้อ 3 */
export const REFRESH_REUSE_GRACE_MS = 30 * 1000;
export const IDLE_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_TENANT_STATUSES = ['TRIAL', 'ACTIVE'] as const;

export interface ClientInfo {
  ip: string;
  userAgent?: string;
}

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
  constructor(private readonly prisma: PrismaService) {}

  private get db() {
    return this.prisma.platform;
  }

  /**
   * ตรวจรหัสผ่าน → คืน authorization code (ผูก code_challenge)
   * ทั้งขั้น "ตรวจล็อก → ตรวจรหัส → บันทึกผล" อยู่ใน transaction เดียวที่ถือ advisory lock ต่ออีเมลและต่อ IP
   * — request ที่ยิงพร้อมกันต้องรอคิว จึงเดารหัสได้ไม่เกิน 5 ครั้งต่อหน้าต่างจริง (review 10 พ.ย. 2569 ข้อ 1)
   * ล็อกเรียง อีเมล → IP เสมอ กัน deadlock; รอคิวนานเกิน → 429 rate_limited
   */
  async login(
    input: { email: string; password: string; codeChallenge: string; tenantId?: string },
    client: ClientInfo,
  ): Promise<{ code: string; expiresIn: number }> {
    const email = input.email.trim().toLowerCase();
    try {
      const result = await this.db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'login:e:' + email}))`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'login:i:' + client.ip}))`;
          return this.loginLocked(tx as unknown as PrismaClient, email, input, client);
        },
        { maxWait: 5_000, timeout: 20_000 },
      );
      // ล้มเหลวต้อง commit แถว login_attempt ก่อน แล้วจึงโยน error (throw ใน transaction = rollback)
      if (result instanceof ProblemException) throw result;
      return result;
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const code = (e as { code?: string }).code;
      if (code === 'P2024' || code === 'P2028') throw new ProblemException('rate_limited');
      throw e;
    }
  }

  private async loginLocked(
    db: PrismaClient,
    email: string,
    input: { password: string; codeChallenge: string; tenantId?: string },
    client: ClientInfo,
  ): Promise<{ code: string; expiresIn: number } | ProblemException> {
    const now = Date.now();

    const lockedFor = await this.lockSeconds(db, email, client.ip, now);
    if (lockedFor > 0) {
      await this.record(db, email, client, { success: false, reason: 'locked' });
      return new ProblemException('account_locked', undefined, undefined, {
        retryAfter: lockedFor,
      });
    }
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
      await this.record(db, email, client, { success: false, reason: 'invalid_credentials' });
      return new ProblemException('invalid_credentials');
    }
    if (chosen.length > 1) {
      await this.record(db, email, client, { success: false, reason: 'tenant_selection_required' });
      return new ProblemException('tenant_selection_required', undefined, undefined, {
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
    const { token: code, hash } = newOpaqueToken();
    await db.authCode.create({
      data: {
        codeHash: hash,
        codeChallenge: input.codeChallenge,
        tenantId: user.tenantId,
        userId: user.id,
        expiresAt: new Date(now + CODE_TTL_MS),
      },
    });
    await db.appUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date(now) } });
    await this.record(db, email, client, {
      success: true,
      reason: 'ok',
      tenantId: user.tenantId,
      userId: user.id,
    });
    return { code, expiresIn: CODE_TTL_MS / 1000 };
  }

  /** grant_type=authorization_code — ตรวจ PKCE แล้วออก access + refresh */
  async exchangeCode(code: string, verifier: string, client: ClientInfo): Promise<TokenPair> {
    const row = await this.db.authCode.findUnique({ where: { codeHash: sha256(code) } });
    const now = new Date();
    if (!row || row.usedAt || row.expiresAt <= now || pkceChallenge(verifier) !== row.codeChallenge)
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
      // หลายแท็บ refresh พร้อมกันด้วย cookie เดียว: ใบที่เพิ่งหมุนไปไม่เกิน 30 วินาที → ปฏิเสธเฉย ๆ ไม่เพิกถอนทั้ง family
      // (แท็บนั้นลองใหม่ด้วย cookie ใหม่ที่อีกแท็บได้รับ) — ใช้ซ้ำหลังจากนั้น = ถือว่าถูกขโมย เพิกถอนทั้ง family
      if (now.getTime() - row.usedAt.getTime() > REFRESH_REUSE_GRACE_MS)
        await this.revokeFamily(row.familyId);
      throw new ProblemException('invalid_grant');
    }
    if (row.expiresAt <= now || row.idleExpiresAt <= now)
      throw new ProblemException('invalid_grant');
    if ((await this.currentTokenVersion(row.tenantId, row.userId)) === null)
      throw new ProblemException('invalid_grant');
    const claimed = await this.db.refreshToken.updateMany({
      where: { id: row.id, usedAt: null, revokedAt: null },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) {
      await this.revokeFamily(row.familyId);
      throw new ProblemException('invalid_grant');
    }
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
    await this.db.refreshToken.create({
      data: {
        tokenHash: hash,
        familyId,
        tenantId,
        userId,
        tokenVersion: user.tokenVersion,
        expiresAt: absoluteExpiry,
        idleExpiresAt: new Date(Math.min(now + IDLE_TTL_MS, absoluteExpiry.getTime())),
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
  private async lockSeconds(
    db: PrismaClient,
    email: string,
    ip: string,
    now: number,
  ): Promise<number> {
    const since = new Date(now - LOGIN_WINDOW_MS);
    const [byEmail, byIp] = await Promise.all([
      db.loginAttempt.findMany({
        where: { email, reason: 'invalid_credentials', createdAt: { gt: since } },
        orderBy: { createdAt: 'desc' },
        take: LOGIN_MAX_FAILURES,
        select: { createdAt: true },
      }),
      db.loginAttempt.findMany({
        where: { ip, reason: 'invalid_credentials', createdAt: { gt: since } },
        orderBy: { createdAt: 'desc' },
        take: LOGIN_MAX_FAILURES,
        select: { createdAt: true },
      }),
    ]);
    // ล็อกจนกว่าครั้งที่ผิดเก่าสุดใน 5 ครั้งล่าสุดจะพ้นหน้าต่าง 15 นาที
    const until = [byEmail, byIp]
      .filter((rows) => rows.length >= LOGIN_MAX_FAILURES)
      .map((rows) => rows[LOGIN_MAX_FAILURES - 1]!.createdAt.getTime() + LOGIN_WINDOW_MS);
    if (until.length === 0) return 0;
    return Math.max(1, Math.ceil((Math.max(...until) - now) / 1000));
  }

  private async record(
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
}
