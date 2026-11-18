/**
 * retry ของ SDK (ST7-T12; docs/04 G1 "Rate limit" + "Idempotency")
 * - 429 = ถูกจำกัดก่อนประมวลผล → ลองใหม่ได้เสมอ รอตาม `Retry-After`
 * - 502/503/504 และ network error → ลองใหม่เฉพาะคำขอที่ส่งซ้ำได้ปลอดภัย:
 *   GET/HEAD/OPTIONS/PUT/DELETE หรือคำขอที่มี `Idempotency-Key` (เซิร์ฟเวอร์ replay ผลเดิม)
 * - `Retry-After` ยาวกว่า `maxDelayMs` → ไม่รอ คืน response ให้ผู้เรียกตัดสินใจเอง
 */
export interface RetryOptions {
  /** จำนวนครั้งที่ลองใหม่สูงสุด (ไม่นับครั้งแรก) — ค่าเริ่ม 3 */
  maxRetries?: number;
  /** รอนานสุดต่อครั้ง (มิลลิวินาที) — ค่าเริ่ม 30000 */
  maxDelayMs?: number;
  /** ฐานของ exponential backoff เมื่อไม่มี Retry-After (มิลลิวินาที) — ค่าเริ่ม 500 */
  baseDelayMs?: number;
  /** ทับฟังก์ชันรอ (test) */
  sleep?: (ms: number) => Promise<void>;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
const RETRYABLE_5XX = new Set([502, 503, 504]);

/** ส่งซ้ำได้โดยไม่เกิดผลซ้ำ — method idempotent ตาม HTTP หรือมี Idempotency-Key */
export function isReplaySafe(req: Request): boolean {
  return SAFE_METHODS.has(req.method.toUpperCase()) || req.headers.has('Idempotency-Key');
}

/** `Retry-After` เป็นวินาที หรือ HTTP-date → มิลลิวินาที (อ่านไม่ได้ = undefined) */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value == null || value.trim() === '') return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

const defaultSleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

export function withRetry(
  base: (req: Request) => Promise<Response>,
  opts: RetryOptions = {},
): (req: Request) => Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3;
  const maxDelay = opts.maxDelayMs ?? 30_000;
  const baseDelay = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;
  return async (req) => {
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= maxRetries;
      let res: Response;
      try {
        res = await base(req.clone());
      } catch (err) {
        if (last || !isReplaySafe(req)) throw err;
        await sleep(Math.min(maxDelay, baseDelay * 2 ** attempt));
        continue;
      }
      const retryable = res.status === 429 || (RETRYABLE_5XX.has(res.status) && isReplaySafe(req));
      if (!retryable || last) return res;
      const wait = parseRetryAfter(res.headers.get('Retry-After')) ?? baseDelay * 2 ** attempt;
      if (wait > maxDelay) return res;
      await res.body?.cancel().catch(() => undefined);
      await sleep(wait);
    }
  };
}
