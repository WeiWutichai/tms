import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { PrismaService } from '../../db/prisma.service';
import { ProblemException } from '../../common/problem';
import { DEFAULT_PROFILE, profileOf, type RateLimitProfile, type RateSpec } from './profiles';

/**
 * ตัวจำกัดอัตรากลาง (ST7-T08; docs/04 G1/J) — ใช้ร่วมทุกชั้น: tenant, API key, ผู้ใช้, คำขอหนัก, IP ของลิงก์สาธารณะ,
 * ลิงก์ (magic link), ส่งทดสอบ/ส่งซ้ำ webhook — เก็บในตาราง UNLOGGED `rate_limit_bucket` จึงใช้ร่วมทุก instance ของ API
 * ตัดหลาย bucket พร้อมกันแบบ all-or-nothing ด้วยฟังก์ชัน `tms_rate_limit_take()` (1 round trip ต่อคำขอ — migration 0098)
 *
 * ชนิด bucket:
 * - `gcra(rate, burst)` token bucket (GCRA) — ชั้นหลักของ API
 * - `window(n, ms)` sliding window log — N ครั้งในหน้าต่างเลื่อน ใช้กับตัวจำกัดเดิมที่ย้ายมา (ความหมายเดิมทุกประการ)
 *
 * ฐานล่ม/ช้า [DECISION spec/12 §3]: ชั้น tenant/key/user/heavy = fail-open (ปล่อยผ่าน + log) — ระบบหลักใช้ฐานเดียวกันอยู่แล้ว
 * ส่วนลิงก์สาธารณะ/ส่งทดสอบ webhook (ตัวกันการใช้ระบบเป็นเครื่องยิง) = fail-closed → 503 `service_busy`
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
}

/** test: แยก key ต่อไฟล์ test (vitest แยก module ต่อไฟล์) — ฐาน test ใช้ร่วมกันทุกไฟล์ · นอก test = '' (ใช้ร่วมทุก instance) */
const NS = process.env.NODE_ENV === 'test' ? `${randomUUID().slice(0, 8)}:` : '';
/** เส้นตายของการถามฐาน (มิลลิวินาที) */
const OPEN_TIMEOUT_MS = Number(process.env.RATE_LIMIT_TIMEOUT_MS ?? 1000);
const CLOSED_TIMEOUT_MS = 2000;
const PROFILE_TTL_MS = 60_000;
const CLEANUP_MS = 5 * 60_000;

let current: RateLimitService | undefined;
/** instance ล่าสุด — ให้ฟังก์ชันระดับ module (เช่น reset ใน test) เข้าถึงได้ */
export const rateLimitInstance = () => current;

@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly logger = new Logger('RateLimit');
  /**
   * เปิดชั้น tenant/key/user/heavy ของ API หรือไม่ — `RATE_LIMIT=off` ปิด · NODE_ENV=test ปิดเป็นค่าเริ่ม (test อื่นยิงถี่โดยตั้งใจ)
   * เปิดด้วย `RATE_LIMIT=on` (E2E) หรือ test ตั้ง `enabled = true` เอง · ตัวจำกัดที่ย้ายมา (ลิงก์/IP/webhook) ทำงานเสมอ
   */
  enabled =
    process.env.RATE_LIMIT === 'on' ||
    (process.env.RATE_LIMIT !== 'off' && process.env.NODE_ENV !== 'test');
  private readonly profiles = new Map<string, { at: number; value: RateLimitProfile }>();
  private lastWarn = 0;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {
    current = this;
    this.timer = setInterval(() => void this.cleanup().catch(() => undefined), CLEANUP_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
    if (current === this) current = undefined;
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
    let rows: Array<{
      idx: number;
      allowed: boolean;
      remaining: number;
      retry_ms: bigint | number;
      reset_ms: bigint | number;
    }>;
    try {
      rows = await this.withTimeout(
        this.prisma.platform.$queryRaw`SELECT * FROM tms_rate_limit_take(
          ${list.map((b) => b.key)}::text[], ${list.map((b) => b.kind)}::text[],
          ${list.map((b) => b.periodMs)}::float8[], ${list.map((b) => b.limit)}::int[],
          ${list.map((b) => b.cost!)}::int[])`,
        opts.failOpen ? OPEN_TIMEOUT_MS : CLOSED_TIMEOUT_MS,
      );
    } catch (e) {
      if (Date.now() - this.lastWarn > 10_000) {
        this.lastWarn = Date.now();
        this.logger.warn(
          `rate limit store unavailable (${opts.failOpen ? 'fail-open' : 'fail-closed'}): ${(e as Error).message?.slice(0, 200)}`,
        );
      }
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
    // ไม่ผ่านตัวใด = ทุกแถว allowed=false (ไม่ตัดเลย) · bucket ที่เต็มจริงคือที่ retry_ms > 0 → รายงานตัวที่ต้องรอนานสุด
    if (res.some((r) => !r.allowed)) {
      const worst = res.reduce((a, b) => (b.retryMs > a.retryMs ? b : a));
      return {
        allowed: false,
        scope: worst.b.scope,
        limit: worst.b.limit,
        remaining: 0,
        resetS: Math.max(1, Math.ceil(worst.resetMs / 1000)),
        retryAfterS: Math.max(1, Math.ceil(worst.retryMs / 1000)),
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
    };
  }

  /** ตัด แล้วโยน 429 `rate_limited` (+ `retryAfter`, `scope`) เมื่อเกิน — สำหรับตัวจำกัดในโมดูล (fail-closed) */
  async assert(buckets: Bucket[], res?: Response): Promise<void> {
    const d = await this.take(buckets, { failOpen: false });
    if (d && res) setRateHeaders(res, d);
    if (d && !d.allowed)
      throw new ProblemException('rate_limited', undefined, undefined, {
        retryAfter: d.retryAfterS,
        scope: d.scope,
      });
  }

  /** โปรไฟล์ของบริษัท (tenant ทับ → แพ็กเกจ) — cache 60 วินาที */
  async profile(tenantId: string): Promise<RateLimitProfile> {
    const hit = this.profiles.get(tenantId);
    if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.value;
    let name: string = DEFAULT_PROFILE;
    try {
      const [row] = await this.withTimeout(
        this.prisma.platform.$queryRaw<Array<{ p: string | null }>>`
          SELECT coalesce(t.rate_limit_profile, p.rate_limit_profile) AS p
            FROM tenant t JOIN plan p ON p.code = t.plan_code WHERE t.id = ${tenantId}::uuid`,
        OPEN_TIMEOUT_MS,
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

  /** ลบ bucket ที่ว่างแล้ว (เทียบเท่าไม่มีแถว) — SKIP LOCKED ไม่แย่งล็อกกับคำขอ · หน้าต่างเลื่อนยาวสุดที่ใช้ < 1 วัน */
  async cleanup(): Promise<number> {
    return this.prisma.platform.$executeRaw`
      DELETE FROM rate_limit_bucket WHERE "key" IN (
        SELECT "key" FROM rate_limit_bucket
         WHERE (tat IS NULL OR tat < now())
           AND (hits IS NULL OR cardinality(hits) = 0 OR hits[cardinality(hits)] < now() - interval '1 day')
         LIMIT 5000 FOR UPDATE SKIP LOCKED)`;
  }

  /** test: ล้าง bucket ของไฟล์ test นี้ (ขึ้นต้นด้วย prefix) */
  async reset(prefix = ''): Promise<void> {
    await this.prisma.platform
      .$executeRaw`DELETE FROM rate_limit_bucket WHERE "key" LIKE ${NS + prefix + '%'}`;
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let t: NodeJS.Timeout;
    return Promise.race([
      p,
      new Promise<never>((_, rej) => {
        t = setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms);
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
