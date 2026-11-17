import { Logger } from '@nestjs/common';
import { ProblemException } from '../common/problem';
import { rateKey } from './public-rate-limit.middleware';

/**
 * rate limit ของหน้าติดตามสาธารณะ (ST4-T14; spec/04 §4 EXE-062/063) — ซ้อนกับ 120 req/นาที/IP ของ `/v1/public/*`
 * - ทุกคำขอ: 60 req/นาที ต่อ IP (EXE-063)
 * - lookup นับเป็น "ครั้งที่ลอง" **จองทันทีแบบ synchronous ก่อน await ใด ๆ** (คำขอพร้อมกันเลี่ยงเพดานไม่ได้)
 *   และคืนเฉพาะเมื่อค้นพบ (`refund`) — เพดานใน 1 ชม.:
 *   · ต่อ IP 5 ครั้ง → ล็อก 1 ชม. (EXE-062)
 *   · ต่อ (ลิงก์ + เลขที่ค้น) 10 ครั้ง — กันเดาเบอร์ 4 ตัวท้ายของเลขหนึ่งจากหลาย IP
 *   · ต่อลิงก์รวม 200 ครั้ง (+ log เตือน) — เพดานกว้างพอไม่ให้คนนอกล็อกลิงก์ของลูกค้าทั้งลิงก์ได้ง่าย (DoS)
 * ⚠ ต่อ IP ต้องได้ IP จริง (ตั้ง `TRUST_PROXY` หลัง load balancer) · ผู้ใช้หลัง CGNAT เดียวกันใช้เพดาน IP ร่วมกัน
 * ในหน่วยความจำต่อ process (หลาย instance ให้ตั้งที่ load balancer/WAF ซ้อนอีกชั้น เหมือน PublicRateLimitMiddleware)
 */
export const TRACKING_REQ_PER_MIN = Number(process.env.TRACKING_RATE_LIMIT_PER_MIN ?? 60);
export const TRACKING_FAILS_PER_IP = 5;
export const TRACKING_FAILS_PER_REF = 10;
export const TRACKING_FAILS_PER_LINK = 200;
const MIN = 60_000;
const HOUR = 3_600_000;
const MAX_KEYS = 50_000;
const reqs = new Map<string, number[]>();
const tries = new Map<string, number[]>();
const log = new Logger('TrackingRateLimit');

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of reqs) if (now - (v.at(-1) ?? 0) >= MIN) reqs.delete(k);
  for (const [k, v] of tries) if (now - (v.at(-1) ?? 0) >= HOUR) tries.delete(k);
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

/** ใบจองของ lookup หนึ่งครั้ง — `refund()` เมื่อค้นพบ (ไม่นับเป็นครั้งที่ผิด) */
export interface LookupReservation {
  refund(): void;
}

/** เลขที่ค้น → key (ตัวใหญ่ ไม่มีช่องว่าง) */
const refKey = (ref: string) => ref.replace(/\s+/g, '').toUpperCase();

/**
 * จองครั้งที่ลองของ lookup (synchronous) — เพดานใดเต็ม → 429 โดยไม่นับเพิ่ม · ไม่บอกว่าเลขไหนถูก
 */
export function reserveLookup(
  ip: string | undefined,
  linkId: string,
  ref: string,
): LookupReservation {
  const now = Date.now();
  const caps: [string, number][] = [
    [`ip:${rateKey(ip ?? 'unknown')}`, TRACKING_FAILS_PER_IP],
    [`ref:${linkId}:${refKey(ref)}`, TRACKING_FAILS_PER_REF],
    [`link:${linkId}`, TRACKING_FAILS_PER_LINK],
  ];
  const lists = caps.map(([k]) => (tries.get(k) ?? []).filter((t) => now - t < HOUR));
  for (let i = 0; i < caps.length; i++) {
    const l = lists[i]!;
    if (l.length >= caps[i]![1]) {
      if (i === 2) log.warn(`tracking link ${linkId} reached ${TRACKING_FAILS_PER_LINK} lookups/h`);
      throw limited(HOUR - (now - l[0]!));
    }
  }
  caps.forEach(([k], i) => {
    lists[i]!.push(now);
    put(tries, k, lists[i]!);
  });
  let done = false;
  return {
    refund() {
      if (done) return;
      done = true;
      for (const [k] of caps) {
        const l = tries.get(k);
        const at = l?.lastIndexOf(now) ?? -1;
        if (l && at >= 0) l.splice(at, 1);
      }
    },
  };
}

/** สำหรับ test */
export function resetTrackingRate() {
  reqs.clear();
  tries.clear();
}
