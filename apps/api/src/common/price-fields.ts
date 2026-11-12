import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { scopeAllows } from '@tms/domain';
import { map, type Observable } from 'rxjs';
import { ProblemException } from './problem';
import { requestContext } from './request-context';

/**
 * สิทธิ์ระดับฟิลด์ราคา (ST1-T13; docs/04 A3 "ดู/แก้ราคาขาย", "ดูราคาซื้อรถร่วม")
 * - ประกาศที่ DTO ด้วย `@PriceField('sell' | 'buy')` → ชื่อ field ถูกลงทะเบียนเป็น field ราคา
 * - `PriceFieldInterceptor` (global) ตัด field เหล่านี้ออกจาก response ที่ชั้น serializer — UI ไม่ใช่ด่านเดียว
 *   ราคาขายต้องมี `prices.sell:read`, ราคาซื้อต้องมี `prices.buy:read`
 * - principal ภายนอก (ลิงก์รถร่วม/คนขับ — ST1-T06, E2) ไม่มี scope ราคาขายเลย จึงไม่มีทางเห็น
 *
 * กติกาสำหรับ DTO ที่มีราคา (ตรวจด้วย test/price-fields-guard.test.ts กับ OpenAPI):
 * 1. ทุก field ที่เผยราคาขาย/ซื้อ (รวมค่าที่คำนวณย้อนได้ เช่น VAT ของบรรทัดขาย, margin, ยอดรวม) ต้องติด `@PriceField`
 *    และตั้งชื่อขึ้นต้น `sell` / `buy` (เช่น `sellAmount`, `buyVatAmount`) — ห้ามใช้ชื่อกลาง ๆ อย่าง `amount`
 * 2. เงินส่งเป็น string "0.00" ก่อนออกจาก controller — ห้ามคืน Decimal/class instance (walker ไม่แตะ object ที่ไม่ใช่ plain)
 * 3. ช่องทางที่ไม่ผ่าน JSON response (PDF, CSV, webhook, outbox, อีเมล, audit diff, ผลของ job ที่เป็น string)
 *    ต้องเรียก `redactPrices(payload, scopesของผู้รับ)` เอง
 * 4. การเขียนราคาขายต้องมี `prices.sell:write` / ราคาซื้อต้องมี `prices.buy:write` — body ที่มี field ราคาจากผู้ไม่มีสิทธิ์ → 403 (interceptor นี้ตรวจให้)
 * 5. ห้ามใส่ราคาใน `extra` ของ ProblemException (filter เขียน response ตรง ไม่ผ่าน interceptor)
 * 6. field ราคาใน OpenAPI ต้อง `required: false` และบอกในคำอธิบายว่าขึ้นกับ `prices.*:read`
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

/** principal ภายใน (ผู้ใช้ / token dev / API client ของ tenant) — ที่เหลือ (ลิงก์รถร่วม, คนขับ) ห้ามเห็นราคาขายเด็ดขาด (A3) */
const INTERNAL_PRINCIPALS = new Set(['user', 'dev', 'client']);

const isPlain = (v: object) => {
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};

/**
 * ตัด field ราคาที่ไม่มีสิทธิ์ออก — เดินเฉพาะ plain object/array (ไม่แตะ Date, Decimal, stream, StreamableFile, class instance)
 * คืน object ใหม่ ไม่แก้ของเดิม; วนซ้ำ (circular) ไม่ทำให้ล้ม
 */
export function redactPrices(
  value: unknown,
  scopes: readonly string[],
  principalType?: string,
): unknown {
  const external = principalType !== undefined && !INTERNAL_PRINCIPALS.has(principalType);
  const hidden = new Set(
    [...REGISTRY]
      .filter(([, kind]) => (external && kind === 'sell') || !scopeAllows(scopes, SCOPE[kind]))
      .map(([name]) => name),
  );
  if (hidden.size === 0) return value;
  const seen = new WeakMap<object, unknown>();
  const walk = (v: unknown): unknown => {
    if (!v || typeof v !== 'object') return v;
    if (seen.has(v)) return seen.get(v);
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      seen.set(v, out);
      for (const x of v) out.push(walk(x));
      return out;
    }
    if (!isPlain(v)) return v;
    const out: Record<string, unknown> = {};
    seen.set(v, out);
    for (const [k, x] of Object.entries(v)) if (!hidden.has(k)) out[k] = walk(x);
    return out;
  };
  return walk(value);
}

/** หา field ราคาของฝั่ง `kind` ใน body ที่ส่งเข้ามา (ทุกชั้น) — ใช้ตรวจสิทธิ์เขียน */
export function findPriceFields(value: unknown, kind: PriceKind, path = ''): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value))
    return value.flatMap((x, i) => findPriceFields(x, kind, `${path}[${i}]`));
  return Object.entries(value).flatMap(([k, x]) => [
    ...(REGISTRY.get(k) === kind ? [path ? `${path}.${k}` : k] : []),
    ...findPriceFields(x, kind, path ? `${path}.${k}` : k),
  ]);
}

/** หา field ราคาขายใน body ที่ส่งเข้ามา (ทุกชั้น) */
export const findSellFields = (value: unknown, path = '') => findPriceFields(value, 'sell', path);

@Injectable()
export class PriceFieldInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const rc = requestContext.get();
    // ขาเข้า: ส่ง field ราคามาโดยไม่มีสิทธิ์แก้ → 403 (ไม่ใช่เงียบ ๆ บันทึก) — A3 "ดู/แก้ราคาขาย"
    // ราคาซื้อ (ST2-T14 rate card ขาซื้อ) ต้องมี `prices.buy:write` · principal ภายนอกแก้ราคาไม่ได้ทั้งสองฝั่ง
    const req = ctx.switchToHttp().getRequest<{ body?: unknown }>();
    const external = rc?.principalType !== undefined && !INTERNAL_PRINCIPALS.has(rc.principalType);
    for (const kind of ['sell', 'buy'] as const) {
      const sent = findPriceFields(req?.body, kind);
      const scope = `prices.${kind}:write`;
      if (sent.length && (external || !scopeAllows(rc?.scopes ?? [], scope)))
        throw new ProblemException('permission_denied', undefined, undefined, {
          module: `prices.${kind}`,
          action: 'write',
          required: [scope],
          fields: sent,
        });
    }
    return next.handle().pipe(
      // ยังไม่ผ่าน auth (route public) = ไม่มี scope ราคาใด ๆ
      map((body) => redactPrices(body, rc?.scopes ?? [], rc?.principalType)),
    );
  }
}
