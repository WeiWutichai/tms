import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * ST7-T08: บรรยาย rate limit ใน OpenAPI — header `RateLimit-Limit/-Remaining/-Reset` บน response สำเร็จ
 * และ response 429 (`components.responses.RateLimited`, problem+json + `Retry-After`) ทุก operation ที่ถูกจำกัด:
 * route ที่ยืนยันตัวตนของบริษัท (ชั้น tenant/key/user/heavy), `/v1/public/*` และ `/v1/platform/auth/*` (ต่อ IP)
 * ไม่ครอบ Platform Console อื่น ๆ และ `/v1/auth/*` (มีเพดาน login ของตัวเอง — 429 บรรยายที่ route)
 */
const HEADERS = {
  'RateLimit-Limit': 'ความจุของ bucket ที่ใกล้เต็มที่สุด (จำนวนคำขอ)',
  'RateLimit-Remaining': 'จำนวนคำขอที่เหลือใน bucket นั้น',
  'RateLimit-Reset': 'วินาทีจนกว่า bucket นั้นจะเต็มอีกครั้ง',
} as const;

const limited = (path: string, op: { security?: unknown[] }) => {
  if (path.startsWith('/v1/public/') || path.startsWith('/v1/platform/auth/')) return true;
  if (path.startsWith('/v1/platform/')) return false;
  return Boolean(op.security?.length);
};

type Resp = {
  description?: string;
  headers?: Record<string, unknown>;
  content?: unknown;
  $ref?: string;
};

export function describeRateLimits(doc: OpenAPIObject): OpenAPIObject {
  const components = (doc.components ??= {});
  const headers = (components.headers ??= {}) as Record<string, unknown>;
  for (const [name, description] of Object.entries(HEADERS))
    headers[name] = { description, schema: { type: 'integer', minimum: 0 } };
  headers['Retry-After'] = {
    description: 'วินาทีที่ต้องรอก่อนส่งคำขอใหม่',
    schema: { type: 'integer', minimum: 1 },
  };
  const rlHeaders = Object.fromEntries(
    Object.keys(HEADERS).map((h) => [h, { $ref: `#/components/headers/${h}` }]),
  );
  const tooMany = {
    ...rlHeaders,
    'Retry-After': { $ref: '#/components/headers/Retry-After' },
  };
  const responses = (components.responses ??= {}) as Record<string, unknown>;
  responses.RateLimited = {
    description:
      'rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant | key | user | endpoint | ip | link และ `retryAfter`) รอตาม Retry-After',
    headers: tooMany,
    content: {
      'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDto' } },
    },
  };
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const op of Object.values(
      item as Record<string, { security?: unknown[]; responses?: Record<string, Resp> }>,
    )) {
      if (!op?.responses || !limited(path, op)) continue;
      for (const [code, r] of Object.entries(op.responses))
        if (/^2\d\d$/.test(code) && !r.$ref) r.headers = { ...rlHeaders, ...(r.headers ?? {}) };
      const cur = op.responses['429'];
      if (!cur) op.responses['429'] = { $ref: '#/components/responses/RateLimited' };
      else if (!cur.$ref) {
        cur.headers = { ...tooMany, ...(cur.headers ?? {}) };
        cur.content ??= (responses.RateLimited as Resp).content;
      }
    }
  }
  return doc;
}
