import { ProblemException } from '../common/problem';

/**
 * rate limit ต่อลิงก์ (magic link) สำหรับคำขอเขียนของหน้าลิงก์สาธารณะ (ST4-T08 review L; spec/11 NFR-1106
 * "30 req/นาที ต่อ token") — ซ้อนกับ rate limit ต่อ IP ของ `/v1/public/*` · ในหน่วยความจำต่อ process
 * (หลาย instance ให้ตั้งที่ load balancer/WAF ซ้อนอีกชั้น เหมือน `PublicRateLimitMiddleware`)
 */
export const LINK_WRITE_LIMIT_PER_MIN = Number(process.env.LINK_WRITE_RATE_LIMIT_PER_MIN ?? 30);
const WINDOW_MS = 60_000;
const MAX_KEYS = 50_000;
const hits = new Map<string, number[]>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now - (v.at(-1) ?? 0) >= WINDOW_MS) hits.delete(k);
}, WINDOW_MS).unref();

/** นับคำขอของลิงก์ `linkId` — เกินเพดาน → 429 `rate_limited` (+ `retryAfter` วินาที) */
export function assertLinkWriteRate(linkId: string): void {
  const now = Date.now();
  const list = (hits.get(linkId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= LINK_WRITE_LIMIT_PER_MIN) {
    const retryAfter = Math.ceil((WINDOW_MS - (now - list[0]!)) / 1000);
    throw new ProblemException('rate_limited', undefined, undefined, { retryAfter });
  }
  list.push(now);
  hits.delete(linkId);
  hits.set(linkId, list);
  if (hits.size > MAX_KEYS) hits.delete(hits.keys().next().value!);
}

/** สำหรับ test */
export function resetLinkWriteRate() {
  hits.clear();
}
