import { Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient, SignupSession, SignupSessionStatus } from '@prisma/client';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { hashPassword, verifyPassword } from '../../auth/password';
import { PasswordPolicy } from '../../auth/password-policy';
import { isLocalEnv, newOpaqueToken, sha256 } from '../../auth/tokens';
import { iEquals } from '../../common/ilike';
import { ProblemException } from '../../common/problem';
import { PrismaService } from '../../db/prisma.service';
import { otpRecipientBuckets, phoneE164 } from '../../http/public-entry/public-entry.guard';
import { RateLimitService } from '../../http/rate-limit/rate-limit.service';
import { OtpChannelService } from './otp-channel';

/**
 * สมัครขั้น 1 "สร้างบัญชี" (P1-ST2-T03; spec/01 §2 ขั้น 1, ข้อ 6, 8; plan/13 P1-ST2-T03)
 *
 * - OTP 6 หลัก อายุ 5 นาที · ขอใหม่ได้หลัง 60 วิ · ผิดสะสม 5 ครั้ง → ล็อก 15 นาที (ล็อกแล้วรหัสเดิมใช้ไม่ได้ ต้องขอใหม่หลังปลด)
 * - เก็บ OTP เป็น HMAC-SHA256(key, sessionId:code) เท่านั้น · token ทำต่อ (resume) เก็บ sha256
 * - `signup_session`: account_pending_otp → account_verified → company_submitted → completed | abandoned (ไม่เคลื่อน 7 วัน)
 *   ลบข้อมูลส่วนบุคคลเมื่อไม่เคลื่อน 30 วัน (`signupMaintenance` — worker รายวัน)
 * - ตาราง platform (ยังไม่มีบริษัท) → ใช้ client platform เท่านั้น
 *
 * [DECISION — lead 27 พ.ย. 2569, ย้อนได้] (spec/12 §3 แถว "สมัครขั้น 1"):
 * - ตัวนับผิดเป็นของอีเมล ไม่ใช่ของรหัส: ขอรหัสใหม่ / เริ่มสมัครใหม่ด้วยอีเมลเดิม **ไม่ล้าง**ตัวนับ (กันเดาโดยวนขอรหัสใหม่)
 * - ระหว่างล็อก ขอรหัสใหม่ไม่ได้ (429 otp_locked) · ปลดล็อกแล้วตัวนับเริ่ม 0
 * - วันลบข้อมูลส่วนบุคคล = 30 วันนับจากเคลื่อนไหวล่าสุด (เท่ากับ 23 วันหลังถูกทิ้ง) — แถวคงไว้วัด funnel
 */
export const OTP_TTL_MS = 5 * 60_000;
export const OTP_RESEND_MS = 60_000;
export const OTP_MAX_FAILS = 5;
export const OTP_LOCK_MS = 15 * 60_000;
export const SIGNUP_ABANDON_MS = 7 * 86_400_000;
export const SIGNUP_ERASE_MS = 30 * 86_400_000;

/** สถานะที่ยังทำต่อได้ */
export const RESUMABLE: SignupSessionStatus[] = [
  'account_pending_otp',
  'account_verified',
  'company_submitted',
];

const STEP: Record<SignupSessionStatus, number> = {
  account_pending_otp: 1,
  account_verified: 2,
  company_submitted: 3,
  completed: 3,
  abandoned: 1,
};

/** key ของ HMAC OTP — นอก dev/test ต้องตั้ง (`OTP_HASH_KEY` หรือ `BLIND_INDEX_KEY`) */
function otpKey(env = process.env): Buffer {
  const spec = env.OTP_HASH_KEY ?? env.BLIND_INDEX_KEY;
  if (spec) return Buffer.from(spec, 'base64');
  if (isLocalEnv()) return Buffer.from('tms-dev-otp-hash-key');
  throw new Error('OTP_HASH_KEY (หรือ BLIND_INDEX_KEY) is required outside development/test');
}

export function hashOtp(sessionId: string, code: string, key = otpKey()): string {
  return createHmac('sha256', key).update(`${sessionId}:${code}`).digest('base64url');
}

/**
 * เบอร์มือถือไทย → +66XXXXXXXXX (9 หลักหลัง +66 ขึ้นต้น 6/8/9) · ไม่ใช่มือถือไทย = null
 * normalize แบบเดียวกับตัวนับ OTP ต่อผู้รับ (`phoneE164`) — 08x / +668x / 00668x = เบอร์เดียวกัน
 */
export function thaiMobileE164(raw: string): string | null {
  const v = phoneE164(raw);
  return v && /^66[689]\d{8}$/.test(v) ? `+${v}` : null;
}

export interface SignupOtpState {
  channel: string;
  /** ปลายทางที่ส่งรหัสไป (อีเมลหรือเบอร์ — ของผู้สมัครเอง) */
  sentTo: string;
  expiresAt: string | null;
  resendAvailableAt: string | null;
  lockedUntil: string | null;
  attemptsLeft: number;
}

export interface SignupSessionView {
  status: SignupSessionStatus;
  /** ขั้นของ stepper (1 บัญชี · 2 บริษัท · 3 แพ็กเกจ) */
  step: number;
  name: string;
  email: string;
  mobile: string;
  otp: SignupOtpState | null;
}

export function viewOf(s: SignupSession, now = Date.now()): SignupSessionView {
  const locked = s.otpLockedUntil && s.otpLockedUntil.getTime() > now ? s.otpLockedUntil : null;
  return {
    status: s.status,
    step: STEP[s.status],
    name: s.fullName ?? '',
    email: s.email ?? '',
    mobile: s.mobile ?? '',
    otp:
      s.status === 'account_pending_otp'
        ? {
            channel: s.otpChannel ?? 'email',
            sentTo: (s.otpChannel === 'sms' ? s.mobile : s.email) ?? '',
            expiresAt: s.otpHash && s.otpExpiresAt ? s.otpExpiresAt.toISOString() : null,
            resendAvailableAt: s.otpSentAt
              ? new Date(s.otpSentAt.getTime() + OTP_RESEND_MS).toISOString()
              : null,
            lockedUntil: locked ? locked.toISOString() : null,
            attemptsLeft: locked ? 0 : Math.max(0, OTP_MAX_FAILS - s.otpFailedCount),
          }
        : null,
  };
}

const retryS = (until: Date, now: number) => Math.max(1, Math.ceil((until.getTime() - now) / 1000));
const lockedErr = (until: Date, now: number) =>
  new ProblemException('otp_locked', undefined, undefined, { retryAfter: retryS(until, now) });

const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

/** หาแถวจาก token ทำต่อ — ผิด/หมดอายุ/ทิ้ง/ลบข้อมูลแล้ว = 401 signup_session_invalid (เหมือนกันทุกกรณี) */
async function sessionByToken(
  db: Pick<PrismaClient, 'signupSession'>,
  token: string | undefined,
  now: number,
  forUpdate?: Prisma.TransactionClient,
): Promise<SignupSession> {
  const invalid = new ProblemException('signup_session_invalid');
  if (!token || token.length > 200) throw invalid;
  const hash = sha256(token);
  if (forUpdate)
    await forUpdate.$queryRaw`SELECT id FROM signup_session WHERE resume_token_hash = ${hash} FOR UPDATE`;
  const s = await db.signupSession.findUnique({ where: { resumeTokenHash: hash } });
  if (
    !s ||
    !RESUMABLE.includes(s.status) ||
    s.personalDataErasedAt ||
    s.lastActivityAt.getTime() <= now - SIGNUP_ABANDON_MS
  )
    throw invalid;
  return s;
}

@Injectable()
export class SignupService {
  private readonly key = otpKey();

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PasswordPolicy,
    private readonly otp: OtpChannelService,
    private readonly limiter: RateLimitService,
  ) {}

  private get db() {
    return this.prisma.platform;
  }

  /** ขั้น 1: ตรวจข้อมูล → สร้าง session + ส่ง OTP — คืน token ทำต่อ (แสดงครั้งเดียว) */
  async start(
    input: { name: string; email: string; mobile: string; password: string; locale?: string },
    meta: { ip?: string },
  ): Promise<{ token: string; session: SignupSessionView }> {
    const email = input.email.trim().toLowerCase();
    const mobile = thaiMobileE164(input.mobile);
    if (!mobile)
      throw new ProblemException('validation_failed', undefined, [
        { field: 'mobile', code: 'invalid_mobile', message: 'Thai mobile number required' },
      ]);
    const name = input.name.trim().replace(/\s+/g, ' ');
    await this.policy.validate(input.password, undefined, 'password');
    const passwordHash = await hashPassword(input.password);
    const locale = input.locale === 'en' ? 'en' : 'th';
    const now = Date.now();
    const { token, hash: tokenHash } = newOpaqueToken();
    const code = newCode();

    const session = await this.db.$transaction(
      async (tx) => {
        // อีเมลเดียวกันพร้อมกัน → ทีละคำขอ (ตัวนับผิด/ล็อกไม่หลุด)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(31, hashtext(${email}))`;
        const user = await tx.appUser.findFirst({
          where: { email: iEquals(email), status: { in: ['ACTIVE', 'INVITED'] } },
          select: { id: true },
        });
        if (user) throw new ProblemException('account_exists');
        const open = await tx.signupSession.findMany({
          where: {
            email,
            status: { in: RESUMABLE },
            lastActivityAt: { gt: new Date(now - SIGNUP_ABANDON_MS) },
          },
        });
        if (open.some((s) => s.status !== 'account_pending_otp'))
          throw new ProblemException('signup_in_progress');
        const lock = open
          .map((s) => s.otpLockedUntil)
          .filter((d): d is Date => !!d && d.getTime() > now)
          .sort((a, b) => b.getTime() - a.getTime())[0];
        if (lock) throw lockedErr(lock, now);
        // ตัวนับผิดของอีเมลนี้ตามไปด้วย (เริ่มใหม่ไม่ล้าง) · ตัวที่ปลดล็อกแล้วเริ่ม 0
        const carried = Math.max(
          0,
          ...open.filter((s) => !s.otpLockedUntil).map((s) => s.otpFailedCount),
        );
        // การสมัครเดิมที่ยังรอ OTP ถูกแทนที่ (กด "แก้เบอร์โทร" แล้วขอรหัสใหม่ / เปิดหลายแท็บ)
        if (open.length)
          await tx.signupSession.updateMany({
            where: { id: { in: open.map((s) => s.id) } },
            data: {
              status: 'abandoned',
              abandonedAt: new Date(now),
              otpHash: null,
              resumeTokenHash: null,
            },
          });
        const channel = this.otp.channel;
        const created = await tx.signupSession.create({
          data: {
            fullName: name,
            email,
            mobile,
            passwordHash,
            resumeTokenHash: tokenHash,
            otpChannel: channel.kind,
            otpSentAt: new Date(now),
            otpExpiresAt: new Date(now + OTP_TTL_MS),
            otpFailedCount: carried,
            otpSendCount: 1,
            ip: meta.ip ?? null,
            locale,
            lastActivityAt: new Date(now),
          },
        });
        const withOtp = await tx.signupSession.update({
          where: { id: created.id },
          data: { otpHash: hashOtp(created.id, code, this.key) },
        });
        await channel.send(tx, {
          to: channel.destination({ email, mobile }),
          code,
          locale,
          ttlMinutes: OTP_TTL_MS / 60_000,
        });
        return withOtp;
      },
      { maxWait: 2_000, timeout: 10_000 },
    );
    return { token, session: viewOf(session, now) };
  }

  async get(token: string | undefined): Promise<SignupSessionView> {
    const now = Date.now();
    return viewOf(await sessionByToken(this.db, token, now), now);
  }

  /** ขอรหัสใหม่ — หลัง 60 วิ, ไม่ระหว่างล็อก, นับโควตาต่อผู้รับ (อีเมล + เบอร์) หลังผ่านเงื่อนไขเวลา */
  async resend(token: string | undefined, res?: Response): Promise<SignupSessionView> {
    const now = Date.now();
    const code = newCode();
    const out = await this.db.$transaction(
      async (tx) => {
        const s = await sessionByToken(tx, token, now, tx);
        if (s.status !== 'account_pending_otp')
          throw new ProblemException('invalid_state_transition');
        if (s.otpLockedUntil && s.otpLockedUntil.getTime() > now)
          throw lockedErr(s.otpLockedUntil, now);
        if (s.otpSentAt && s.otpSentAt.getTime() + OTP_RESEND_MS > now)
          throw new ProblemException('otp_resend_too_soon', undefined, undefined, {
            retryAfter: retryS(new Date(s.otpSentAt.getTime() + OTP_RESEND_MS), now),
          });
        // เพดาน OTP ต่อผู้รับ (P1-ST2-T08 PLT-026) — ตัวนับเดียวกับ @OtpSendLimit ของขั้น 1
        await this.limiter.assert(otpRecipientBuckets([s.email!, s.mobile!]), res);
        const channel = this.otp.channel;
        const lockExpired = !!s.otpLockedUntil;
        const u = await tx.signupSession.update({
          where: { id: s.id },
          data: {
            otpHash: hashOtp(s.id, code, this.key),
            otpChannel: channel.kind,
            otpSentAt: new Date(now),
            otpExpiresAt: new Date(now + OTP_TTL_MS),
            otpSendCount: { increment: 1 },
            ...(lockExpired ? { otpLockedUntil: null, otpFailedCount: 0 } : {}),
            lastActivityAt: new Date(now),
          },
        });
        await channel.send(tx, {
          to: channel.destination({ email: s.email!, mobile: s.mobile! }),
          code,
          locale: s.locale,
          ttlMinutes: OTP_TTL_MS / 60_000,
        });
        return u;
      },
      { maxWait: 2_000, timeout: 10_000 },
    );
    return viewOf(out, now);
  }

  /**
   * ยืนยันรหัส — ถูก → account_verified · ผิด → นับ (ครบ 5 = ล็อก 15 นาที + ยกเลิกรหัส)
   * ผลการนับผิดต้อง commit ก่อนตอบ error → transaction คืนผล แล้วค่อยโยนข้างนอก
   */
  async verify(token: string | undefined, code: string): Promise<SignupSessionView> {
    const now = Date.now();
    const r = await this.db.$transaction(
      async (tx) => {
        const s = await sessionByToken(tx, token, now, tx);
        if (s.status !== 'account_pending_otp') return { ok: true as const, s };
        if (s.otpLockedUntil && s.otpLockedUntil.getTime() > now)
          return { err: lockedErr(s.otpLockedUntil, now) };
        if (!s.otpHash || !s.otpExpiresAt || s.otpExpiresAt.getTime() <= now)
          return { err: new ProblemException('otp_expired') };
        const a = Buffer.from(hashOtp(s.id, code, this.key));
        const b = Buffer.from(s.otpHash);
        if (a.length === b.length && timingSafeEqual(a, b)) {
          const u = await tx.signupSession.update({
            where: { id: s.id },
            data: {
              status: 'account_verified',
              verifiedAt: new Date(now),
              otpHash: null,
              otpFailedCount: 0,
              otpLockedUntil: null,
              lastActivityAt: new Date(now),
            },
          });
          return { ok: true as const, s: u };
        }
        const fails = s.otpFailedCount + 1;
        if (fails >= OTP_MAX_FAILS) {
          const until = new Date(now + OTP_LOCK_MS);
          await tx.signupSession.update({
            where: { id: s.id },
            data: { otpFailedCount: fails, otpLockedUntil: until, otpHash: null },
          });
          return { err: lockedErr(until, now) };
        }
        await tx.signupSession.update({ where: { id: s.id }, data: { otpFailedCount: fails } });
        return {
          err: new ProblemException('otp_invalid', undefined, undefined, {
            attemptsLeft: OTP_MAX_FAILS - fails,
          }),
        };
      },
      { maxWait: 2_000, timeout: 10_000 },
    );
    if ('err' in r) throw r.err;
    return viewOf(r.s, now);
  }
}

/**
 * login ด้วยอีเมล/รหัสของการสมัครที่ยังไม่เสร็จ (spec/01 §2 ข้อ 8 "ปิดเบราว์เซอร์กลางทาง → login แล้วกลับมาขั้นที่ค้าง")
 * — เรียกจาก AuthService เมื่ออีเมลนี้ยังไม่มีผู้ใช้ · รหัสถูก → ออก token ทำต่อใหม่ (ตัวเก่าใช้ไม่ได้) · ไม่ตรง = null
 * (ทำ verifyPassword ครั้งเดียวเสมอ — เวลาตอบเท่ากับไม่มีการสมัคร)
 */
export async function resumeSignupByPassword(
  db: Pick<PrismaClient, 'signupSession'>,
  email: string,
  password: string,
  fallbackHash: () => Promise<string>,
  now = Date.now(),
): Promise<string | null> {
  const s = await db.signupSession.findFirst({
    where: {
      email: email.trim().toLowerCase(),
      status: { in: RESUMABLE },
      personalDataErasedAt: null,
      lastActivityAt: { gt: new Date(now - SIGNUP_ABANDON_MS) },
      passwordHash: { not: null },
    },
    orderBy: { lastActivityAt: 'desc' },
  });
  const ok = await verifyPassword(s?.passwordHash ?? (await fallbackHash()), password);
  if (!s || !ok) return null;
  const { token, hash } = newOpaqueToken();
  const r = await db.signupSession.updateMany({
    where: { id: s.id, status: { in: RESUMABLE } },
    data: { resumeTokenHash: hash },
  });
  return r.count === 1 ? token : null;
}

/**
 * งานรายวันของ worker: ทิ้งการสมัครที่ไม่เคลื่อน 7 วัน + ลบข้อมูลส่วนบุคคลเมื่อไม่เคลื่อน 30 วัน (spec/01 §2 ข้อ 6)
 * ลบ = ตั้ง null (ไม่ลบแถว — วัด funnel) · ใช้ client platform
 */
export async function signupMaintenance(
  db: Pick<PrismaClient, 'signupSession'>,
  now = Date.now(),
): Promise<{ abandoned: number; erased: number }> {
  const abandoned = await db.signupSession.updateMany({
    where: {
      status: { in: RESUMABLE },
      lastActivityAt: { lte: new Date(now - SIGNUP_ABANDON_MS) },
    },
    data: { status: 'abandoned', abandonedAt: new Date(now), resumeTokenHash: null, otpHash: null },
  });
  const erased = await db.signupSession.updateMany({
    where: {
      personalDataErasedAt: null,
      lastActivityAt: { lte: new Date(now - SIGNUP_ERASE_MS) },
    },
    data: {
      fullName: null,
      email: null,
      mobile: null,
      passwordHash: null,
      resumeTokenHash: null,
      otpHash: null,
      ip: null,
      personalDataErasedAt: new Date(now),
    },
  });
  return { abandoned: abandoned.count, erased: erased.count };
}
