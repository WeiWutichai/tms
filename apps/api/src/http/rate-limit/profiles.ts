/**
 * โปรไฟล์ rate limit (ST7-T08; docs/04 G1 "Rate limit", J; docs/01 §5.1; spec/07 INT-081; spec/11 §12)
 * `plan.rate_limit_profile` (ต่อแพ็กเกจ) → ทับด้วย `tenant.rate_limit_profile` (Console) — ค่าตัวเลขอยู่ที่นี่ที่เดียว
 *
 * - tenant: เพดานรวมทุกช่องทางของบริษัท (UI + API key + client credentials) — 50 req/s burst 100 (token bucket)
 * - key: ต่อ API key / OAuth client — 20 req/s
 * - user: ต่อผู้ใช้ (UI, NFR-1105 กัน script) — 20 req/s burst 40 (เปิดหน้าที่ยิงหลายคำขอพร้อมกันได้)
 * - heavy: คำขอหนัก (export, นำเข้า, สร้าง PDF, ส่งทดสอบ, ทำทีละหลายรายการ) ต่อบริษัท — 5 req/s
 * `high` = 2 เท่าทุกชั้น สำหรับลูกค้าที่ Console อนุมัติ [DECISION spec/12 §3]
 */
export interface RateSpec {
  /** token ต่อวินาที */
  rate: number;
  /** ความจุ (จำนวนคำขอติดกันได้ทันที) */
  burst: number;
}
export interface RateLimitProfile {
  tenant: RateSpec;
  key: RateSpec;
  user: RateSpec;
  heavy: RateSpec;
}

export const RATE_LIMIT_PROFILES = {
  standard: {
    tenant: { rate: 50, burst: 100 },
    key: { rate: 20, burst: 20 },
    user: { rate: 20, burst: 40 },
    heavy: { rate: 5, burst: 5 },
  },
  high: {
    tenant: { rate: 100, burst: 200 },
    key: { rate: 40, burst: 40 },
    user: { rate: 40, burst: 80 },
    heavy: { rate: 10, burst: 10 },
  },
} satisfies Record<string, RateLimitProfile>;

export type RateLimitProfileName = keyof typeof RATE_LIMIT_PROFILES;
export const DEFAULT_PROFILE: RateLimitProfileName = 'standard';

export function profileOf(name: string | null | undefined): RateLimitProfile {
  return (
    RATE_LIMIT_PROFILES[(name ?? DEFAULT_PROFILE) as RateLimitProfileName] ??
    RATE_LIMIT_PROFILES[DEFAULT_PROFILE]
  );
}

/** ประเภทของ route: read (GET/HEAD) · write (อื่น ๆ) · heavy (ติด @RateLimitClass('heavy')) */
export type RouteClass = 'read' | 'write' | 'heavy';
