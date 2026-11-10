import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { scopeAllows } from '@tms/domain';
import { map, type Observable } from 'rxjs';
import { requestContext } from './request-context';

/**
 * สิทธิ์ระดับฟิลด์ราคา (ST1-T13; docs/04 A3 "ดู/แก้ราคาขาย", "ดูราคาซื้อรถร่วม")
 * - ประกาศที่ DTO ด้วย `@PriceField('sell' | 'buy')` → ชื่อ field ถูกลงทะเบียนเป็น field ราคา
 * - `PriceFieldInterceptor` (global) ตัด field เหล่านี้ออกจาก response ที่ชั้น serializer — UI ไม่ใช่ด่านเดียว
 *   ราคาขายต้องมี `prices.sell:read`, ราคาซื้อต้องมี `prices.buy:read`
 * - principal ภายนอก (ลิงก์รถร่วม/คนขับ — ST1-T06, E2) ไม่มี scope ราคาขายเลย จึงไม่มีทางเห็น
 * ชื่อ field ต้องไม่ซ้ำกับ field ที่ไม่ใช่ราคาในทุก DTO (ตรวจด้วย test) — ตั้งชื่อชัด ๆ เช่น `sellPrice`, `buyAmount`
 */
export type PriceKind = 'sell' | 'buy';
const SCOPE: Record<PriceKind, string> = { sell: 'prices.sell:read', buy: 'prices.buy:read' };
const REGISTRY = new Map<string, PriceKind>();

export function PriceField(kind: PriceKind): PropertyDecorator {
  return (_target, key) => {
    const name = String(key);
    const prev = REGISTRY.get(name);
    if (prev && prev !== kind)
      throw new Error(`price field '${name}' registered as both ${prev} and ${kind}`);
    REGISTRY.set(name, kind);
  };
}

export function priceFieldNames(): ReadonlyMap<string, PriceKind> {
  return REGISTRY;
}

/** ตัด field ราคาที่ไม่มีสิทธิ์ออก (เดินทั้งก้อน รวม array/nested) — คืน object ใหม่ ไม่แก้ของเดิม */
export function redactPrices(value: unknown, scopes: readonly string[]): unknown {
  const hidden = new Set(
    [...REGISTRY].filter(([, kind]) => !scopeAllows(scopes, SCOPE[kind])).map(([name]) => name),
  );
  if (hidden.size === 0) return value;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (!hidden.has(k)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value);
}

@Injectable()
export class PriceFieldInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((body) => {
        const scopes = requestContext.get()?.scopes;
        // ยังไม่ผ่าน auth (route public) = ไม่มี scope ราคาใด ๆ
        return redactPrices(body, scopes ?? []);
      }),
    );
  }
}
