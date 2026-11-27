import { Injectable, Logger } from '@nestjs/common';
import { isLocalEnv } from '../../auth/tokens';

/**
 * ด่านกันบอทของทางเข้าสาธารณะ (P1-ST2-T08; spec/01 PLT-026 "bot protection (เช่น Turnstile) ที่ขั้น 1")
 * interface กลาง — ไม่ผูกผู้ให้บริการ · ค่าเริ่ม = ไม่ตรวจ (`none`) จนกว่าจะได้บัญชี X-11 (ขวางเฉพาะ go-live)
 *
 * เลือกด้วย env `BOT_PROTECTION_PROVIDER`:
 * - `none` (ค่าเริ่ม) — ผ่านทุกคำขอ · นอก dev/test เตือนตอนบูต (go-live checklist P1-ST6-T08 ต้องเปิด)
 * - `turnstile` — Cloudflare Turnstile (`TURNSTILE_SECRET_KEY` บังคับ) — หน้าเว็บส่ง token ใน header `X-Bot-Token`
 */
export interface BotCheckInput {
  /** token จาก widget ฝั่งเว็บ (header `X-Bot-Token`) */
  token?: string;
  ip?: string;
  /** ชื่อขั้น (เช่น `signup`) — ผู้ให้บริการที่รองรับใช้ตรวจว่า token ออกให้ขั้นนี้ */
  action: string;
}
export type BotVerdict =
  { ok: true } | { ok: false; reason: 'missing' | 'invalid' | 'unavailable' };

export interface BotProtectionProvider {
  readonly name: string;
  verify(input: BotCheckInput): Promise<BotVerdict>;
}

/** ไม่ตรวจ — dev/test และก่อนได้บัญชี X-11 */
export class NoopBotProtection implements BotProtectionProvider {
  readonly name = 'none';
  async verify(): Promise<BotVerdict> {
    return { ok: true };
  }
}

type FetchLike = (
  url: string,
  init: { method: string; body: URLSearchParams; signal?: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Cloudflare Turnstile (server-side siteverify) — ปิดเป็นค่าเริ่ม · test ใส่ `fetchImpl` ปลอม (ไม่มีการเรียกออกภายนอก)
 * เรียกไม่ได้/ตอบผิดรูป = `unavailable` → guard ตอบ 503 `service_busy` (fail-closed: ทางเข้าสาธารณะไม่เปิดโล่งตอนผู้ให้บริการล่ม)
 */
export class TurnstileBotProtection implements BotProtectionProvider {
  readonly name = 'turnstile';
  constructor(
    private readonly secret: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly timeoutMs = 5000,
  ) {}

  async verify({ token, ip, action }: BotCheckInput): Promise<BotVerdict> {
    if (!token) return { ok: false, reason: 'missing' };
    // Turnstile: token ยาวไม่เกิน 2048 ตัว — เกินถือว่าไม่ถูกต้อง ไม่ส่งออกไป
    if (token.length > 2048) return { ok: false, reason: 'invalid' };
    const body = new URLSearchParams({ secret: this.secret, response: token });
    if (ip) body.set('remoteip', ip);
    let data: { success?: unknown; action?: unknown };
    try {
      const res = await this.fetchImpl(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return { ok: false, reason: 'unavailable' };
      data = (await res.json()) as typeof data;
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    if (typeof data?.success !== 'boolean') return { ok: false, reason: 'unavailable' };
    if (!data.success) return { ok: false, reason: 'invalid' };
    // widget ตั้ง action ไว้ → ต้องตรงกับขั้นที่เรียก (กัน token ของขั้นอื่น) · ไม่ตั้ง = ไม่ตรวจ
    if (typeof data.action === 'string' && data.action && data.action !== action)
      return { ok: false, reason: 'invalid' };
    return { ok: true };
  }
}

/** สร้างผู้ให้บริการจาก env — ค่าผิด/ขาด secret = API ไม่ยอมเริ่ม (ไม่เปิดทางเข้าโดยไม่รู้ตัว) */
export function createBotProtection(
  env: Record<string, string | undefined> = process.env,
): BotProtectionProvider {
  const kind = (env.BOT_PROTECTION_PROVIDER ?? 'none').trim().toLowerCase();
  if (kind === 'none' || kind === '') return new NoopBotProtection();
  if (kind === 'turnstile') {
    const secret = env.TURNSTILE_SECRET_KEY?.trim();
    if (!secret) throw new Error('BOT_PROTECTION_PROVIDER=turnstile ต้องตั้ง TURNSTILE_SECRET_KEY');
    return new TurnstileBotProtection(secret);
  }
  throw new Error(`BOT_PROTECTION_PROVIDER ไม่รู้จัก: ${kind} (ใช้ none | turnstile)`);
}

/** ตัวถือผู้ให้บริการ (inject ได้ทั้งแอป · test เปลี่ยน `provider` เป็นของปลอมได้) */
@Injectable()
export class BotProtectionService {
  provider: BotProtectionProvider = createBotProtection();
  constructor() {
    if (this.provider.name === 'none' && !isLocalEnv())
      new Logger('BotProtection').warn(
        'BOT_PROTECTION_PROVIDER=none — ทางเข้าสมัครสาธารณะไม่มีด่านกันบอท (ต้องเปิดก่อน go-live: X-11)',
      );
  }
  verify(input: BotCheckInput): Promise<BotVerdict> {
    return this.provider.verify(input);
  }
}
