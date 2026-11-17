import { Logger } from '@nestjs/common';
import { ProblemException } from '../common/problem';
import { linkWriteBucket } from './link-rate-limit';
import {
  ipKey,
  rateLimitInstance,
  slidingWindow,
  type RateLimitService,
} from './rate-limit/rate-limit.service';

/**
 * rate limit ของหน้าติดตามสาธารณะ (ST4-T14; spec/04 §4 EXE-062/063) — ซ้อนกับ 120 req/นาที/IP ของ `/v1/public/*`
 * - ทุกคำขอ: 60 req/นาที ต่อ IP (EXE-063)
 * - lookup นับเป็น "ครั้งที่ลอง" — จองแบบ atomic ในที่เก็บกลาง (คำขอพร้อมกันเลี่ยงเพดานไม่ได้) และคืนเฉพาะเมื่อค้นพบ (`refund`)
 *   เพดานใน 1 ชม.: ต่อ IP 5 ครั้ง (EXE-062) · ต่อ (ลิงก์ + เลขที่ค้น) 10 ครั้ง · ต่อลิงก์รวม 200 ครั้ง (+ log เตือน)
 *   + 30 คำขอ/นาที ต่อลิงก์ (ไม่คืน)
 * ST7-T08 (QA M3): ย้ายจากหน่วยความจำต่อ process มาที่ตัวจำกัดกลาง — ใช้ร่วมทุก instance · ฐานใช้ไม่ได้ = 503 (fail-closed)
 * 429 มี `scope`: ip · lookup (ต่อเลขที่ค้น) · link
 * ⚠ ต่อ IP ต้องได้ IP จริง (ตั้ง `TRUST_PROXY` หลัง load balancer) · ผู้ใช้หลัง CGNAT เดียวกันใช้เพดาน IP ร่วมกัน
 */
export const TRACKING_REQ_PER_MIN = Number(process.env.TRACKING_RATE_LIMIT_PER_MIN ?? 60);
export const TRACKING_FAILS_PER_IP = 5;
export const TRACKING_FAILS_PER_REF = 10;
export const TRACKING_FAILS_PER_LINK = 200;
const MIN = 60_000;
const HOUR = 3_600_000;
const log = new Logger('TrackingRateLimit');

const reqBucket = (ip: string | undefined) =>
  slidingWindow(`trk:r:${ipKey(ip)}`, TRACKING_REQ_PER_MIN, MIN, 'ip');

/** นับคำขอของ IP — เกิน 60/นาที → 429 */
export async function assertTrackingRate(
  limiter: RateLimitService,
  ip: string | undefined,
): Promise<void> {
  await limiter.assert([reqBucket(ip)]);
}

/** ใบจองของ lookup หนึ่งครั้ง — `refund()` เมื่อค้นพบ (ไม่นับเป็นครั้งที่ผิด) */
export interface LookupReservation {
  refund(): Promise<void>;
}

/** เลขที่ค้น → key (ตัวใหญ่ ไม่มีช่องว่าง) */
const refKey = (ref: string) => ref.replace(/\s+/g, '').toUpperCase();

/**
 * ตัดคำขอ (ต่อ IP + ต่อลิงก์) และจองครั้งที่ลองของ lookup ในครั้งเดียว (all-or-nothing) — เพดานใดเต็ม → 429 โดยไม่นับเพิ่ม
 * ไม่บอกว่าเลขไหนถูก
 */
export async function reserveLookup(
  limiter: RateLimitService,
  ip: string | undefined,
  linkId: string,
  ref: string,
): Promise<LookupReservation> {
  const caps = [
    slidingWindow(`trk:fi:${ipKey(ip)}`, TRACKING_FAILS_PER_IP, HOUR, 'ip'),
    slidingWindow(`trk:fr:${linkId}:${refKey(ref)}`, TRACKING_FAILS_PER_REF, HOUR, 'lookup'),
    slidingWindow(`trk:fl:${linkId}`, TRACKING_FAILS_PER_LINK, HOUR, 'link'),
  ];
  const d = await limiter.take([reqBucket(ip), linkWriteBucket(linkId), ...caps], {
    failOpen: false,
  });
  if (d && !d.allowed) {
    if (d.scope === 'link' && d.limit === TRACKING_FAILS_PER_LINK)
      log.warn(`tracking link ${linkId} reached ${TRACKING_FAILS_PER_LINK} lookups/h`);
    throw new ProblemException('rate_limited', undefined, undefined, {
      retryAfter: d.retryAfterS,
      scope: d.scope,
    });
  }
  let done = false;
  return {
    async refund() {
      if (done) return;
      done = true;
      await limiter.refund(
        caps.map((c) => c.key),
        d?.atMs ?? null,
      );
    },
  };
}

/** สำหรับ test */
export async function resetTrackingRate(): Promise<void> {
  await rateLimitInstance()?.reset('trk:');
}
