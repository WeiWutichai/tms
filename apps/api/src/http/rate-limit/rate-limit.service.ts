import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { ProblemException } from '../../common/problem';
import { DEFAULT_PROFILE, profileOf, type RateLimitProfile, type RateSpec } from './profiles';

/**
 * ตัวจำกัดอัตรากลาง (ST7-T08; docs/04 G1/J) — ใช้ร่วมทุกชั้น: tenant, API key, ผู้ใช้, คำขอหนัก, IP ของลิงก์สาธารณะ,
 * ลิงก์ (magic link), หน้าติดตาม, ส่งทดสอบ/ส่งซ้ำ webhook, ขอ token — เก็บในตาราง UNLOGGED `rate_limit_bucket` จึงใช้ร่วมทุก instance
 * ตัดหลาย bucket พร้อมกันแบบ all-or-nothing ด้วยฟังก์ชัน `tms_rate_limit_take()` (1 round trip ต่อคำขอ — migration 0098)
 *
 * ชนิด bucket:
 * - `gcra(rate, burst)` token bucket (GCRA) — ชั้นหลักของ API
 * - `slidingWindow(n, ms)` N ครั้งในหน้าต่างเลื่อน — ตัวจำกัดเดิมที่ย้ายมา (ความหมายเดิม) · คืนได้ (`refund`)
 *
 * แยกจากงานหลัก (review M1): connection pool ของตัวเอง (role platform, `RATE_LIMIT_POOL` ค่าเริ่ม 4 ช่อง, รอ pool ≤ 1 วิ)
 * + statement_timeout 500 ms / lock_timeout 200 ms ฝั่งฐาน (ยกเลิกคำสั่งจริง) — แถวร้อน/ฐานช้าไม่ดึงคำขออื่นหรือ pool ของแอป
 * bucket GCRA ที่ถูกปฏิเสธจำไว้ในเครื่องจนถึง Retry-After (ไม่ยิงแถวร้อนซ้ำระหว่างถูกจำกัด)
 *
 * ฐานล่ม/ช้า [DECISION spec/12 §3]: ชั้น tenant/key/user/heavy = fail-open (ปล่อยผ่าน + log)
 * ตัวกันการใช้ระบบเป็นเครื่องยิง (สาธารณะ, ลิงก์, webhook, ขอ token) = fail-closed → 503 `service_busy`
 */
export interface Bucket {
  key: string;
  kind: 'g' | 'w';
  /** g: มิลลิวินาทีต่อ 1 token · w: ความยาวหน้าต่าง (มิลลิวินาที) */
  periodMs: number;
  /** g: burst · w: จำนวนครั้งในหน้าต่าง */
  limit: number;
  cost?: number;
  /** ขอบเขตที่บอกผู้เรียกใน problem+json (`scope`) เมื่อ bucket นี้เต็ม */
  scope: string;
}

export const gcra = (key: string, spec: RateSpec, scope: string): Bucket => ({
  key,
  kind: 'g',
  periodMs: 1000 / spec.rate,
  limit: spec.burst,
  scope,
});
export const slidingWindow = (key: string, n: number, windowMs: number, scope: string): Bucket => ({
  key,
  kind: 'w',
  periodMs: windowMs,
  limit: n,
  scope,
});

/** IPv6 นับต่อ /64 (ผู้ใช้หนึ่งคนเปลี่ยนเลขท้ายได้ทั้ง block) · IPv4 / IPv4-mapped นับต่อ IP */
export function rateKey(ip: string): string {
  const v4 = ip.replace(/^::ffff:/, '');
  if (!v4.includes(':')) return v4;
  if (v4 === '::1') return '::1';
  // ขยาย "::" ให้ครบ 8 กลุ่มก่อนตัด /64
  const [head, tail] = v4.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const full =
    tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${full
    .slice(0, 4)
    .map((x) => x.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

const IP_KEY = (() => {
  const spec = process.env.RATE_LIMIT_KEY ?? process.env.BLIND_INDEX_KEY ?? '';
  return spec ? Buffer.from(spec, 'base64') : null;
})();
/** IP ในที่เก็บเป็น HMAC (PDPA — ไม่เก็บ IP ดิบในตารางตัวจำกัด) · ไม่มี key (dev) = SHA-256 */
export function ipKey(ip: string | undefined): string {
  const v = rateKey(ip ?? 'unknown');
  const h = IP_KEY ? createHmac('sha256', IP_KEY).update(v) : createHash('sha256').update(v);
  return h.digest('base64url').slice(0, 22);
}

export interface RateDecision {
  allowed: boolean;
  /** bucket ที่รายงานใน header (ที่เหลือน้อยที่สุด หรือที่ทำให้ถูกปฏิเสธ) */
  scope: string;
  limit: number;
  remaining: number;
  /** วินาทีจนกว่า bucket ที่รายงานจะเต็ม (`RateLimit-Reset`) */
  resetS: number;
  /** วินาทีที่ต้องรอ (`Retry-After`) — 0 เมื่อผ่าน */
  retryAfterS: number;
  /** เวลาที่ตัด (มิลลิวินาที, ของฐาน) — ใช้กับ `refund` · null = ตอบจากที่จำในเครื่อง */
  atMs: number | null;
}

/** test: แยก key ต่อไฟล์ test (vitest แยก module ต่อไฟล์) — ฐาน test ใช้ร่วมกันทุกไฟล์ · นอก test = '' (ใช้ร่วมทุก instance) */
const NS = process.env.NODE_ENV === 'test' ? `${randomUUID().slice(0, 8)}:` : '';
/** key จริงในตาราง (test ใช้ตรวจแถว) */
export const storedKey = (key: string) => NS + key;
/** เส้นตายฝั่ง JS (สำรอง — ฐานยกเลิกเองที่ 500 ms) */
const CALL_TIMEOUT_MS = Number(process.env.RATE_LIMIT_TIMEOUT_MS ?? 1000);
const PROFILE_TTL_MS = 60_000;
const CLEANUP_MS = 60_000;
const MAX_DENIALS = 10_000;
const BUSY_MS = 1000;

function limiterUrl(): string {
  const raw = process.env.PLATFORM_DATABASE_URL ?? '';
  try {
    const u = new URL(raw);
    u.searchParams.set('connection_limit', process.env.RATE_LIMIT_POOL ?? '4');
    u.searchParams.set('pool_timeout', '1');
    u.searchParams.set('options', '-c statement_timeout=500 -c lock_timeout=200');
    u.searchParams.set('application_name', 'tms-rate-limit');
    return u.toString();
  } catch {
    return raw;
  }
}

let current: RateLimitService | undefined;
/** instance ล่าสุด — ให้ฟังก์ชันระดับ module (เช่น reset ใน test) เข้าถึงได้ */
export const rateLimitInstance = () => current;

@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly logger = new Logger('RateLimit');
  /**
   * เปิดชั้น tenant/key/user/heavy ของ API หรือไม่ — `RATE_LIMIT=off` ปิด · NODE_ENV=test ปิดเป็นค่าเริ่ม (test อื่นยิงถี่โดยตั้งใจ)
   * เปิดด้วย `RATE_LIMIT=on` (E2E) หรือ test ตั้ง `enabled = true` เอง · ตัวจำกัดในโมดูล (ลิงก์/IP/webhook/token) ทำงานเสมอ
   */
  enabled =
    process.env.RATE_LIMIT === 'on' ||
    (process.env.RATE_LIMIT !== 'off' && process.env.NODE_ENV !== 'test');
  /** pool แยกของตัวจำกัด (role platform) — test เปลี่ยนเป็นของปลอมได้ */
  db: Pick<PrismaClient, '$queryRaw' | '$executeRaw' | '$disconnect'>;
  private readonly profiles = new Map<string, { at: number; value: RateLimitProfile }>();
  /** bucket GCRA ที่ถูกปฏิเสธ → เวลาที่จะผ่านได้ (ไม่ถามฐานซ้ำจนถึงเวลานั้น) */
  private readonly denied = new Map<string, number>();
  /** bucket ที่ถามฐานแล้วล้ม (ล็อกค้าง/หมดเวลา/ฐานล่ม) → พักถึงเวลานี้ */
  private readonly busy = new Map<string, number>();
  /** คิวต่อ bucket แรก (ทีละคำขอต่อ instance) */
  private readonly chains = new Map<string, Promise<unknown>>();
  private lastWarn = 0;
  private readonly timer: NodeJS.Timeout;

  constructor() {
    current = this;
    this.db = new PrismaClient({ datasources: { db: { url: limiterUrl() } } });
    this.timer = setInterval(() => void this.cleanup().catch(() => undefined), CLEANUP_MS);
    this.timer.unref();
  }

  async onModuleDestroy() {
    clearInterval(this.timer);
    if (current === this) current = undefined;
    await this.db.$disconnect().catch(() => undefined);
  }

  /**
   * ตัดทุก bucket พร้อมกัน — ผ่านทุกตัวจึงตัด (ไม่ผ่านตัวใด = ไม่ตัดเลย)
   * ฐานใช้ไม่ได้: failOpen → ผ่าน (null) · ไม่งั้น throw 503 `service_busy`
   */
  async take(buckets: Bucket[], opts: { failOpen: boolean }): Promise<RateDecision | null> {
    if (!buckets.length) return null;
    // key ซ้ำในคำขอเดียว → รวม cost
    const merged = new Map<string, Bucket>();
    for (const b of buckets) {
      const k = NS + b.key;
      const cur = merged.get(k);
      if (cur) cur.cost = (cur.cost ?? 1) + (b.cost ?? 1);
      else merged.set(k, { ...b, key: k, cost: b.cost ?? 1 });
    }
    const list = [...merged.values()];
    // ถูกจำกัดอยู่ (จำในเครื่อง) → ตอบทันที ไม่แตะแถวร้อน
    const now = Date.now();
    let cachedUntil = 0;
    let cachedB: Bucket | undefined;
    for (const b of list) {
      const until = this.denied.get(b.key);
      if (until === undefined) continue;
      if (until <= now) this.denied.delete(b.key);
      else if (until > cachedUntil) [cachedUntil, cachedB] = [until, b];
    }
    if (cachedB) {
      const s = Math.max(1, Math.ceil((cachedUntil - now) / 1000));
      return {
        allowed: false,
        scope: cachedB.scope,
        limit: cachedB.limit,
        remaining: 0,
        resetS: s,
        retryAfterS: s,
        atMs: null,
      };
    }
    let rows: Array<{
      idx: number;
      allowed: boolean;
      remaining: number;
      retry_ms: bigint | number;
      reset_ms: bigint | number;
      at_ms: number;
    }>;
    // ต่อ instance: คำขอที่ bucket แรก (เช่น t:<tenant>) เดียวกันเข้าฐานทีละตัว — แถวร้อน/ล็อกค้างใช้ connection ได้แค่ 1 ช่อง
    // ไม่ดึง pool ทั้งหมดไปจากบริษัทอื่น · ล้มแล้วพัก bucket นั้น 1 วิ (ไม่ถามฐานซ้ำระหว่างนั้น)
    const gate = list[0]!.key;
    const query = () => {
      if ((this.busy.get(gate) ?? 0) > Date.now()) throw new Error('rate limit store busy');
      return this.withTimeout(
        this.db.$queryRaw<typeof rows>`SELECT * FROM tms_rate_limit_take(
          ${list.map((b) => b.key)}::text[], ${list.map((b) => b.kind)}::text[],
          ${list.map((b) => b.periodMs)}::float8[], ${list.map((b) => b.limit)}::int[],
          ${list.map((b) => b.cost!)}::int[])`,
      );
    };
    const run = (this.chains.get(gate) ?? Promise.resolve()).then(query, query);
    const tail = run.catch(() => undefined);
    this.chains.set(gate, tail);
    void tail.then(() => {
      if (this.chains.get(gate) === tail) this.chains.delete(gate);
    });
    try {
      rows = await run;
    } catch (e) {
      if ((this.busy.get(gate) ?? 0) <= Date.now()) {
        if (this.busy.size >= MAX_DENIALS) this.busy.clear();
        this.busy.set(gate, Date.now() + BUSY_MS);
      }
      this.warn(opts.failOpen, e);
      if (opts.failOpen) return null;
      throw new ProblemException('service_busy', undefined, undefined, {
        retryAfter: 2,
        retryable: true,
      });
    }
    const res = rows.map((r) => ({
      b: list[r.idx]!,
      allowed: r.allowed,
      remaining: r.remaining,
      retryMs: Number(r.retry_ms),
      resetMs: Number(r.reset_ms),
    }));
    const atMs = rows[0]?.at_ms ?? null;
    // ไม่ผ่านตัวใด = ทุกแถว allowed=false (ไม่ตัดเลย) · bucket ที่เต็มจริงคือที่ retry_ms > 0 → รายงานตัวที่ต้องรอนานสุด
    if (res.some((r) => !r.allowed)) {
      for (const r of res)
        if (r.b.kind === 'g' && r.retryMs > 0) {
          if (this.denied.size >= MAX_DENIALS) this.denied.clear();
          this.denied.set(r.b.key, now + r.retryMs);
        }
      const worst = res.reduce((a, b) => (b.retryMs > a.retryMs ? b : a));
      return {
        allowed: false,
        scope: worst.b.scope,
        limit: worst.b.limit,
        remaining: 0,
        resetS: Math.max(1, Math.ceil(worst.resetMs / 1000)),
        retryAfterS: Math.max(1, Math.ceil(worst.retryMs / 1000)),
        atMs,
      };
    }
    // ผ่าน: รายงาน bucket ที่เหลือน้อยที่สุด (เท่ากัน → ความจุน้อยกว่า)
    const tight = res.reduce((a, b) =>
      b.remaining < a.remaining || (b.remaining === a.remaining && b.b.limit < a.b.limit) ? b : a,
    );
    return {
      allowed: true,
      scope: tight.b.scope,
      limit: tight.b.limit,
      remaining: tight.remaining,
      resetS: Math.max(0, Math.ceil(tight.resetMs / 1000)),
      retryAfterS: 0,
      atMs,
    };
  }

  /** ตัด แล้วโยน 429 `rate_limited` (+ `retryAfter`, `scope`) เมื่อเกิน — สำหรับตัวจำกัดในโมดูล (fail-closed) */
  async assert(buckets: Bucket[], res?: Response): Promise<RateDecision | null> {
    const d = await this.take(buckets, { failOpen: false });
    if (d && res) setRateHeaders(res, d);
    if (d && !d.allowed)
      throw new ProblemException('rate_limited', undefined, undefined, {
        retryAfter: d.retryAfterS,
        scope: d.scope,
      });
    return d;
  }

  /** คืนการตัดของ bucket หน้าต่างเลื่อน (เช่น ค้นพบ = ไม่นับเป็นครั้งที่ผิด) — ไม่สำเร็จแค่ log */
  async refund(keys: string[], atMs: number | null): Promise<void> {
    if (atMs === null || !keys.length) return;
    try {
      await this.withTimeout(
        this.db
          .$executeRaw`SELECT tms_rate_limit_refund(${keys.map((k) => NS + k)}::text[], ${atMs}::float8)`,
      );
    } catch (e) {
      this.warn(true, e);
    }
  }

  /** โปรไฟล์ของบริษัท (tenant ทับ → แพ็กเกจ) — cache 60 วินาที */
  async profile(tenantId: string): Promise<RateLimitProfile> {
    const hit = this.profiles.get(tenantId);
    if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.value;
    let name: string = DEFAULT_PROFILE;
    try {
      const [row] = await this.withTimeout(
        this.db.$queryRaw<Array<{ p: string | null }>>`
          SELECT coalesce(t.rate_limit_profile, p.rate_limit_profile) AS p
            FROM tenant t JOIN plan p ON p.code = t.plan_code WHERE t.id = ${tenantId}::uuid`,
      );
      name = row?.p ?? DEFAULT_PROFILE;
    } catch {
      return hit?.value ?? profileOf(DEFAULT_PROFILE); // ไม่ cache ค่าที่เดา
    }
    const value = profileOf(name);
    this.profiles.set(tenantId, { at: Date.now(), value });
    if (this.profiles.size > 10_000) this.profiles.clear();
    return value;
  }

  invalidateProfile(tenantId?: string) {
    if (tenantId) this.profiles.delete(tenantId);
    else this.profiles.clear();
  }

  /**
   * ลบ bucket ที่กลับเป็นเต็มแล้ว (`expires_at` ผ่านไปแล้ว = เทียบเท่าไม่มีแถว — คิดจากหน้าต่าง/อัตราของ bucket นั้นเอง)
   * ทีละ 5,000 แถวจนหมด · SKIP LOCKED ไม่แย่งล็อกกับคำขอ
   */
  async cleanup(): Promise<number> {
    let total = 0;
    for (let i = 0; i < 200; i++) {
      const n = await this.db.$executeRaw`
        DELETE FROM rate_limit_bucket WHERE "key" IN (
          SELECT "key" FROM rate_limit_bucket
           WHERE expires_at IS NULL OR expires_at < now()
           LIMIT 5000 FOR UPDATE SKIP LOCKED)`;
      total += n;
      if (n < 5000) break;
    }
    return total;
  }

  /** test: ล้าง bucket ของไฟล์ test นี้ (ขึ้นต้นด้วย prefix) */
  async reset(prefix = ''): Promise<void> {
    for (const m of [this.denied, this.busy])
      for (const k of m.keys()) if (k.startsWith(NS + prefix)) m.delete(k);
    await this.db.$executeRaw`DELETE FROM rate_limit_bucket WHERE "key" LIKE ${NS + prefix + '%'}`;
  }

  private warn(open: boolean, e: unknown) {
    if (Date.now() - this.lastWarn < 10_000) return;
    this.lastWarn = Date.now();
    this.logger.warn(
      `rate limit store unavailable (${open ? 'fail-open' : 'fail-closed'}): ${(e as Error).message?.slice(-200)}`,
    );
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    let t: NodeJS.Timeout;
    return Promise.race([
      p,
      new Promise<never>((_, rej) => {
        t = setTimeout(() => rej(new Error(`timeout ${CALL_TIMEOUT_MS}ms`)), CALL_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(t));
  }
}

/** header ตาม docs/04 G1: `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` (+ `Retry-After` เมื่อเกิน — ผ่าน ProblemFilter) */
export function setRateHeaders(res: Response, d: RateDecision) {
  if (res.headersSent) return;
  res.setHeader('RateLimit-Limit', String(d.limit));
  res.setHeader('RateLimit-Remaining', String(d.remaining));
  res.setHeader('RateLimit-Reset', String(d.resetS));
}
