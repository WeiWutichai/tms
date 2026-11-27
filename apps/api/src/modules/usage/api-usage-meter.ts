import type { NextFunction, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { requestContext } from '../../common/request-context';
import { type ApiSource, bangkokDate, USAGE_METRIC } from './usage-metrics';

/** flush ลง usage_daily ทุก 30 วินาที (main.ts) */
export const API_USAGE_FLUSH_MS = 30_000;
/** กันหน่วยความจำโตเมื่อฐานล่มนาน — คีย์ (tenant × วัน × source) ที่รอ flush ได้สูงสุด */
const MAX_PENDING_KEYS = 50_000;

/**
 * ตัวนับ API calls (P1-ST1-T07; spec/01 §7 `api.calls` "REST + MCP แยก source ที่ได้ 2xx/4xx ไม่นับ 429/5xx")
 *
 * ออกแบบให้ถูกบน hot path: ต่อคำขอ = บวก 1 ใน Map ในหน่วยความจำ (ไม่มี I/O) เมื่อส่งคำตอบเสร็จ
 * → flush แบบ batch ทุก 30 วิ: INSERT … SELECT unnest(…) ครั้งเดียว ON CONFLICT บวกเพิ่ม (หลาย API instance บวกแถวเดียวกันได้)
 * - นับเฉพาะ principal `client` (API key / OAuth client) — UI ของเราไม่นับ · ไม่นับ 429 และ 5xx
 * - sandbox (key `tk_test_`) ไม่นับ: ตัดที่ ctx.sandbox และตอน flush เขียนเฉพาะ tenant mode = live (กันสองชั้น)
 * - เดือนที่ปิดยอดแล้ว (มี usage_record) ไม่ถูกบวก — ปิดยอด 02:00 วันที่ 1 ห่างจาก flush รอบสุดท้ายของเดือนมาก
 * - ฐานล่ม: เก็บไว้ส่งรอบหน้า · process ตายกะทันหันเสียได้ไม่เกิน ~30 วิของตัวนับ (ยอมรับได้สำหรับการนับใช้งาน — ไม่ใช่เงิน)
 */
export class ApiUsageMeter {
  private pending = new Map<string, number>();

  get pendingKeys(): number {
    return this.pending.size;
  }

  record(tenantId: string, source: ApiSource, at: Date = new Date()): void {
    const k = `${tenantId}|${bangkokDate(at)}|${source}`;
    const cur = this.pending.get(k);
    if (cur === undefined && this.pending.size >= MAX_PENDING_KEYS) return;
    this.pending.set(k, (cur ?? 0) + 1);
  }

  /** เขียนยอดที่ค้างลง usage_daily (บวกเพิ่ม) — คืนจำนวนคีย์ที่เขียน */
  async flush(db: Pick<PrismaClient, '$executeRaw'>): Promise<number> {
    const rows = [...this.pending.entries()];
    if (!rows.length) return 0;
    this.pending = new Map();
    const tenants: string[] = [];
    const days: string[] = [];
    const sources: string[] = [];
    const counts: number[] = [];
    for (const [k, n] of rows) {
      const [t, d, s] = k.split('|');
      tenants.push(t!);
      days.push(d!);
      sources.push(s!);
      counts.push(n);
    }
    try {
      await db.$executeRaw`
        INSERT INTO usage_daily (tenant_id, date, metric, source, value)
        SELECT x.t, x.d, ${USAGE_METRIC.apiCalls}, x.s, x.n
          FROM unnest(${tenants}::uuid[], ${days}::date[], ${sources}::text[], ${counts}::int[]) AS x(t, d, s, n)
          JOIN tenant tn ON tn.id = x.t AND tn.mode = 'live'
         WHERE NOT EXISTS (SELECT 1 FROM usage_record r
                            WHERE r.tenant_id = x.t AND r.period = to_char(x.d, 'YYYY-MM'))
        ON CONFLICT (tenant_id, date, metric, source) DO UPDATE
          SET value = usage_daily.value + excluded.value, updated_at = now()`;
    } catch (e) {
      for (const [k, n] of rows) this.pending.set(k, (this.pending.get(k) ?? 0) + n);
      throw e;
    }
    return rows.length;
  }
}

/** instance เดียวต่อ process */
export const apiUsageMeter = new ApiUsageMeter();

/** นับได้ไหม: client ภายนอก, ไม่ใช่ sandbox, ไม่ใช่ 429/5xx */
export function countsAsApiCall(
  ctx: { tenantId?: string; principalType?: string; sandbox?: unknown } | undefined,
  status: number,
): ctx is { tenantId: string } {
  return (
    !!ctx?.tenantId &&
    ctx.principalType === 'client' &&
    !ctx.sandbox &&
    status < 500 &&
    status !== 429
  );
}

/** middleware: อ่าน context ตอนส่งคำตอบเสร็จ (AuthGuard เติม tenant/principal ใน object เดียวกัน) */
export function apiUsageMiddleware(_req: Request, res: Response, next: NextFunction): void {
  const ctx = requestContext.get();
  res.on('finish', () => {
    if (countsAsApiCall(ctx, res.statusCode)) apiUsageMeter.record(ctx.tenantId, 'rest');
  });
  next();
}
