import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiForbiddenResponse, ApiHeader, ApiTooManyRequestsResponse } from '@nestjs/swagger';
import { createHmac, createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { ProblemException } from '../../common/problem';
import {
  ipKey,
  RateLimitService,
  slidingWindow,
  type Bucket,
} from '../rate-limit/rate-limit.service';
import { BotProtectionService } from './bot-protection';

/**
 * ป้องกันทางเข้าสาธารณะของการสมัคร (P1-ST2-T08; spec/01 PLT-026 [PROPOSED]; docs/04 J Rate limiting)
 * — "สมัคร ≤ 5 ครั้ง/IP/ชม., OTP ≤ 5 ครั้ง/ผู้รับ/วัน" + ด่านกันบอทที่ขั้น 1
 *
 * ใช้เป็น decorator บน handler ของ `/v1/public/signup/*` (P1-ST2-T03 เป็นต้นไป):
 *   `@SignupAttemptLimit()` — นับต่อ IP ทุกครั้งที่เรียก (สำเร็จหรือไม่ก็นับ)
 *   `@OtpSendLimit('mobile')` — นับต่อผู้รับ OTP (ค่าจาก body field ที่ระบุ — เบอร์หรืออีเมลจนกว่า X-04)
 *   `@BotProtected('signup')` — ตรวจ token จาก header `X-Bot-Token` ผ่าน `BotProtectionService`
 * guard ทำงาน **ก่อน interceptor/handler** (Nest: middleware → guard → interceptor) → คำขอที่เกินเพดาน
 * ไม่เปิด transaction และไม่แตะตารางธุรกิจ (ตัวนับอยู่ในตาราง UNLOGGED ของตัวจำกัดกลาง ด้วย pool แยก)
 * ซ้อนกับเพดาน 60/นาที/IP ของ `/v1/public/*` (public-rate-limit.middleware) · ตัวนับเก็บแบบ hash (PDPA)
 * ตัวจำกัดใช้ไม่ได้ = 503 `service_busy` (fail-closed เหมือนตัวจำกัดสาธารณะอื่น)
 */
export const PUBLIC_ENTRY = 'tms:publicEntry';

type EntryRule =
  | { kind: 'signup_ip' }
  | { kind: 'otp_recipient'; field: string }
  | { kind: 'bot'; action: string };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** อ่านทุกคำขอ (test/ops ปรับได้โดยไม่ต้อง restart ในกระบวนการเดียวกัน) */
export const signupPerIpPerHour = () => Number(process.env.SIGNUP_RATE_LIMIT_PER_IP_PER_HOUR ?? 5);
export const otpPerRecipientPerDay = () =>
  Number(process.env.OTP_RATE_LIMIT_PER_RECIPIENT_PER_DAY ?? 5);

/** เพิ่มกติกาลง metadata ของ handler (ใช้หลาย decorator ซ้อนกันได้) */
const addRule =
  (rule: EntryRule): MethodDecorator =>
  (_target, _key, descriptor) => {
    const fn = descriptor.value as object;
    const prev = (Reflect.getMetadata(PUBLIC_ENTRY, fn) as EntryRule[] | undefined) ?? [];
    SetMetadata(PUBLIC_ENTRY, [...prev, rule])(_target, _key, descriptor);
    return descriptor;
  };

/** ติดเฉพาะ handler ขั้น 1 ของการสมัคร (สร้างคำขอสมัคร) — ไม่ติดทุก route ใต้ /v1/public/signup (ผู้สมัครคนเดียวเรียกหลายครั้งต่อการสมัคร) */
export const SignupAttemptLimit = () =>
  applyDecorators(
    addRule({ kind: 'signup_ip' }),
    ApiTooManyRequestsResponse({
      description:
        'rate_limited (`scope: ip`) — สมัครเกินเพดานต่อ IP (ค่าเริ่ม 5 ครั้ง/ชม.) มี header Retry-After',
    }),
  );

/**
 * ติดเฉพาะ handler ที่ส่ง OTP (ขอ/ขอใหม่) · ⚠ ใครก็ใช้โควตาของผู้รับคนอื่นได้ (ยิงขอ OTP ด้วยเบอร์ของเหยื่อ 5 ครั้ง
 * → เจ้าของเบอร์ขอไม่ได้ทั้งวัน) — ยอมรับตาม PLT-026 · ด่านกันบอท + เพดานต่อ IP ช่วยลด (spec/12 §3)
 */
export const OtpSendLimit = (field: string) =>
  applyDecorators(
    addRule({ kind: 'otp_recipient', field }),
    ApiTooManyRequestsResponse({
      description:
        'rate_limited (`scope: recipient`) — ขอ OTP ไปผู้รับเดียวกันเกินเพดาน (ค่าเริ่ม 5 ครั้ง/วัน) มี header Retry-After',
    }),
  );

export const BotProtected = (action: string) =>
  applyDecorators(
    addRule({ kind: 'bot', action }),
    ApiHeader({
      name: 'X-Bot-Token',
      required: false,
      description:
        'token ของด่านกันบอท (เช่น Cloudflare Turnstile) — บังคับเมื่อระบบเปิดด่าน (BOT_PROTECTION_PROVIDER ≠ none)',
    }),
    ApiForbiddenResponse({ description: 'bot_check_failed — token ไม่มีหรือไม่ถูกต้อง' }),
  );

const RECIPIENT_KEY = (() => {
  const spec = process.env.RATE_LIMIT_KEY ?? process.env.BLIND_INDEX_KEY ?? '';
  return spec ? Buffer.from(spec, 'base64') : null;
})();
/**
 * เบอร์โทร → E.164 แบบไม่มี `+` (ไทยเป็นค่าเริ่ม): ตัดช่องว่าง/ขีด/วงเล็บ · `+`/`00` นำหน้า = รหัสประเทศ ·
 * `0` นำหน้า = เบอร์ในประเทศ → `66` + ที่เหลือ (มือถือ 08x และเบอร์บ้าน 02x ได้ผลต่างกัน) · ไม่ใช่เบอร์ = null
 */
export function phoneE164(raw: string): string | null {
  const v = raw.trim().replace(/[\s\-().]/g, '');
  if (!/^\+?\d{8,16}$/.test(v)) return null;
  if (v.startsWith('+')) return v.slice(1);
  if (v.startsWith('00')) return v.slice(2);
  if (v.startsWith('0')) return `66${v.slice(1)}`;
  return v;
}
/** ผู้รับ OTP → key: เบอร์ใช้ E.164 (08x / +668x / 00668x = เบอร์เดียวกัน) · อีเมลตัดช่องว่าง+ตัวพิมพ์เล็ก แล้ว hash (PDPA) */
export function recipientKey(raw: string): string {
  const norm = phoneE164(raw) ?? raw.trim().toLowerCase();
  const h = RECIPIENT_KEY
    ? createHmac('sha256', RECIPIENT_KEY).update(norm)
    : createHash('sha256').update(norm);
  return h.digest('base64url').slice(0, 22);
}

/** bucket เพดาน OTP ต่อผู้รับ (≤ 5/วัน) — ใช้ร่วมกับ `@OtpSendLimit` (เช่น ขอรหัสใหม่ที่ผู้รับมาจาก session ไม่ใช่ body) */
export function otpRecipientBuckets(values: string[]): Bucket[] {
  return values
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) =>
      slidingWindow(`su:otp:${recipientKey(v)}`, otpPerRecipientPerDay(), DAY_MS, 'recipient'),
    );
}

@Injectable()
export class PublicEntryGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimitService,
    private readonly bot: BotProtectionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const rules = this.reflector.get<EntryRule[] | undefined>(PUBLIC_ENTRY, ctx.getHandler());
    if (!rules?.length) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const route = `${req.method}:${(req.route as { path?: string } | undefined)?.path ?? req.path}`;

    // 1) ตัวนับก่อน (ถูก — ไม่ยิงผู้ให้บริการกันบอทให้ผู้ที่เกินเพดานแล้ว) · ทุก bucket ตัดพร้อมกันแบบ all-or-nothing
    const buckets: Bucket[] = [];
    for (const r of rules) {
      if (r.kind === 'signup_ip')
        buckets.push(
          slidingWindow(`su:ip:${route}:${ipKey(req.ip)}`, signupPerIpPerHour(), HOUR_MS, 'ip'),
        );
      if (r.kind === 'otp_recipient') {
        const v = (req.body as Record<string, unknown> | undefined)?.[r.field];
        // ไม่มีผู้รับ = ไม่มี OTP ถูกส่ง (validation ตอบ 422 ต่อ) — ไม่นับ
        if (typeof v === 'string') buckets.push(...otpRecipientBuckets([v]));
      }
    }
    if (buckets.length) await this.limiter.assert(buckets, res);

    // 2) ด่านกันบอท
    for (const r of rules) {
      if (r.kind !== 'bot') continue;
      const header = req.headers['x-bot-token'];
      const token = Array.isArray(header) ? header[0] : header;
      const v = await this.bot.verify({ token: token || undefined, ip: req.ip, action: r.action });
      if (v.ok) continue;
      if (v.reason === 'unavailable')
        throw new ProblemException('service_busy', undefined, undefined, {
          retryAfter: 5,
          retryable: true,
        });
      throw new ProblemException('bot_check_failed');
    }
    return true;
  }
}
