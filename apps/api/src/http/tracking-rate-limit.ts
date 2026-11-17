import { ProblemException } from '../common/problem';
import { rateKey } from './public-rate-limit.middleware';

/**
 * rate limit ของหน้าติดตามสาธารณะ (ST4-T14; spec/04 §4 EXE-062/063) — ซ้อนกับ 120 req/นาที/IP ของ `/v1/public/*`
 * - ทุกคำขอ: 60 req/นาที ต่อ IP (EXE-063)
 * - ค้นผิด (lookup ไม่พบ): 5 ครั้ง/ชม. ต่อ IP → ล็อก 1 ชม. (EXE-062) · 30 ครั้ง/ชม. ต่อลิงก์ (กันกระจาย IP เดาเลขในลิงก์เดียว)
 * ในหน่วยความจำต่อ process (หลาย instance ให้ตั้งที่ load balancer/WAF ซ้อนอีกชั้น เหมือน PublicRateLimitMiddleware)
 */
export const TRACKING_REQ_PER_MIN = Number(process.env.TRACKING_RATE_LIMIT_PER_MIN ?? 60);
export const TRACKING_FAILS_PER_IP = 5;
export const TRACKING_FAILS_PER_LINK = 30;
const MIN = 60_000;
const HOUR = 3_600_000;
const MAX_KEYS = 50_000;
const reqs = new Map<string, number[]>();
const fails = new Map<string, number[]>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of reqs) if (now - (v.at(-1) ?? 0) >= MIN) reqs.delete(k);
  for (const [k, v] of fails) if (now - (v.at(-1) ?? 0) >= HOUR) fails.delete(k);
}, MIN).unref();

function put(map: Map<string, number[]>, key: string, list: number[]) {
  map.delete(key);
  map.set(key, list);
  if (map.size > MAX_KEYS) map.delete(map.keys().next().value!);
}

const limited = (retryMs: number) =>
  new ProblemException('rate_limited', undefined, undefined, {
    retryAfter: Math.max(1, Math.ceil(retryMs / 1000)),
  });

/** นับคำขอของ IP — เกิน 60/นาที → 429 */
export function assertTrackingRate(ip: string | undefined): void {
  const key = rateKey(ip ?? 'unknown');
  const now = Date.now();
  const list = (reqs.get(key) ?? []).filter((t) => now - t < MIN);
  if (list.length >= TRACKING_REQ_PER_MIN) throw limited(MIN - (now - list[0]!));
  list.push(now);
  put(reqs, key, list);
}

function recent(key: string, now: number) {
  return (fails.get(key) ?? []).filter((t) => now - t < HOUR);
}

/** ล็อกอยู่ (ค้นผิดครบเพดานใน 1 ชม.) → 429 ก่อนค้น — ไม่บอกว่าเลขไหนถูก */
export function assertLookupAllowed(ip: string | undefined, linkId: string): void {
  const now = Date.now();
  const byIp = recent(`ip:${rateKey(ip ?? 'unknown')}`, now);
  if (byIp.length >= TRACKING_FAILS_PER_IP) throw limited(HOUR - (now - byIp[0]!));
  const byLink = recent(`link:${linkId}`, now);
  if (byLink.length >= TRACKING_FAILS_PER_LINK) throw limited(HOUR - (now - byLink[0]!));
}

/** บันทึกการค้นที่ไม่พบ (ต่อ IP + ต่อลิงก์) */
export function recordLookupFailure(ip: string | undefined, linkId: string): void {
  const now = Date.now();
  for (const key of [`ip:${rateKey(ip ?? 'unknown')}`, `link:${linkId}`]) {
    const list = recent(key, now);
    list.push(now);
    put(fails, key, list);
  }
}

/** สำหรับ test */
export function resetTrackingRate() {
  reqs.clear();
  fails.clear();
}
