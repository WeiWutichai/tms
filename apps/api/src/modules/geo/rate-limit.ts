/**
 * token bucket ต่อ tenant ในหน่วยความจำ (ST2-T03: จำกัดปุ่ม "ประมาณจากที่อยู่" — ผู้ให้บริการจริงคิดเงินต่อครั้ง)
 * ต่อ process — หลาย instance = เพดานรวมคูณจำนวน instance; เปลี่ยนเป็นที่เก็บกลางเมื่อมีผู้ให้บริการจริง [ทบทวน]
 */
export class TenantRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** ใช้ได้ = 0 · เกินเพดาน = จำนวนวินาทีที่ต้องรอ (สำหรับ Retry-After) */
  take(key: string): number {
    const rate = this.perMinute / 60_000;
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.perMinute, at: t };
    b.tokens = Math.min(this.perMinute, b.tokens + (t - b.at) * rate);
    b.at = t;
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000));
  }
}
