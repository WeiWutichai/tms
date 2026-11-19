/**
 * @tms/sdk — TypeScript SDK ของ TMS Open API /v1 (ST7-T12; docs/04 G1 "OpenAPI & SDK")
 * type ทุก path/body/response generate จาก `packages/contracts/openapi.json` (แหล่งเดียวกับเอกสาร + Postman)
 */
import createClient, { type Client, type Middleware } from 'openapi-fetch';
import type { components, paths } from './schema';
import { IDEMPOTENT_POSTS } from './idempotency.gen';
import { withRetry, type RetryOptions } from './retry';

export type { components, paths };
export type Schemas = components['schemas'];
export { IDEMPOTENT_POSTS } from './idempotency.gen';
export { isReplaySafe, parseRetryAfter, withRetry, type RetryOptions } from './retry';
export {
  constructWebhookEvent,
  verifyWebhookSignature,
  WebhookSignatureError,
  WEBHOOK_TOLERANCE_SEC,
  type VerifyWebhookInput,
  type WebhookEvent,
  type WebhookVerifyResult,
} from './webhooks';

/** เวอร์ชันพฤติกรรมที่ SDK นี้สร้างจาก (= `info.x-api-version-latest` — test ตรวจให้ตรง) */
export const API_VERSION = '2026-11-18';
/** base URL ตัวอย่าง — ใส่ของจริงตามที่ได้รับ (โหมด Sandbox/Production ตาม key ไม่ใช่ตาม URL) */
export const DEFAULT_BASE_URL = 'https://api.tms.example';

export interface TmsClientOptions {
  /** API key `tk_live_…` / `tk_test_…` หรือ access token จาก `POST /v1/oauth/token` */
  apiKey?: string;
  /** ทางเลือกของ apiKey: คืน token ทุกคำขอ (เช่น OAuth token ที่ต่ออายุเอง) */
  getToken?: () => string | null | undefined | Promise<string | null | undefined>;
  /** ไม่รวม `/v1` (path ของ SDK มี `/v1` แล้ว) — ค่าเริ่ม DEFAULT_BASE_URL */
  baseUrl?: string;
  /** `X-Api-Version` — ค่าเริ่ม API_VERSION (ได้พฤติกรรมตรงกับ type ของ SDK) · null = ไม่ส่ง (ใช้ค่าที่ pin บน key) */
  apiVersion?: string | null;
  /** `Accept-Language` ของข้อความ error */
  locale?: 'th' | 'en';
  /** false = ปิด retry */
  retry?: RetryOptions | false;
  /**
   * ใส่ `Idempotency-Key` (UUID) ให้ POST ที่ประกาศรับ header นี้ใน OpenAPI (`IDEMPOTENT_POSTS`) และยังไม่มีเอง
   * → retry ได้ปลอดภัย — ค่าเริ่ม true · endpoint ที่ไม่รับ header ไม่ใส่ (บางตัวตอบ 400)
   */
  autoIdempotencyKey?: boolean;
  /** ทับ fetch (test / proxy) */
  fetch?: (req: Request) => Promise<Response>;
}

export type TmsClient = Client<paths>;

/** สร้าง Idempotency-Key ใหม่ (UUID v4) — เก็บไว้ใช้ซ้ำเมื่อส่งคำขอเดิมอีกครั้ง */
export function idempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

/** header `If-Match` จาก ETag ของ GET (`"3"`) หรือเลข version ของ resource — ไม่ตรง → 412 */
export function ifMatch(etagOrVersion: string | number): { 'If-Match': string } {
  const v = String(etagOrVersion);
  return { 'If-Match': /^(W\/)?".*"$/.test(v) || v === '*' ? v : `"${v}"` };
}

/** ETag ของ response (ใช้คู่กับ ifMatch) */
export function etagOf(res: { headers: Headers } | Response): string | null {
  return res.headers.get('ETag');
}

/** problem+json (RFC 9457) ของทุก 4xx/5xx */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: { field: string; code: string; message: string }[];
  [k: string]: unknown;
}

export class TmsApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  constructor(
    readonly problem: Problem,
    readonly response: Response,
  ) {
    super(`${problem.status} ${problem.code}: ${problem.detail ?? problem.title}`);
    this.name = 'TmsApiError';
    this.status = problem.status ?? response.status;
    this.code = problem.code;
    this.requestId = problem.requestId ?? response.headers.get('X-Request-Id') ?? undefined;
  }
}

function toProblem(error: unknown, res: Response): Problem {
  if (error && typeof error === 'object' && 'code' in error) return error as Problem;
  return { type: 'about:blank', title: res.statusText, status: res.status, code: 'http_error' };
}

/** ผลของ client.GET/POST/… → data (ผิด = throw TmsApiError) */
export function unwrap<T>(r: { data?: T; error?: unknown; response: Response }): T {
  if (r.error !== undefined || !r.response.ok)
    throw new TmsApiError(toProblem(r.error, r.response), r.response);
  return r.data as T;
}

/**
 * เดินทุกหน้าของ list แบบ cursor (`{data, nextCursor, hasMore}` — docs/04 G1 "Pagination")
 * for await (const o of paginate((cursor) => tms.GET('/v1/orders', { params: { query: { limit: 200, cursor } } }))) …
 */
export async function* paginate<Item>(
  fetchPage: (cursor: string | undefined) => Promise<{
    data?: { data: Item[]; nextCursor?: string | null; hasMore?: boolean };
    error?: unknown;
    response: Response;
  }>,
): AsyncGenerator<Item, void, undefined> {
  let cursor: string | undefined;
  for (;;) {
    const page = unwrap(await fetchPage(cursor));
    for (const item of page.data) yield item;
    if (!page.hasMore || !page.nextCursor) return;
    cursor = page.nextCursor;
  }
}

/** client ที่มี type ครบทุก path ของ /v1 — `tms.POST('/v1/orders', { body })` คืน `{ data, error, response }` */
export function createTmsClient(opts: TmsClientOptions = {}): TmsClient {
  const base = opts.fetch ?? ((req: Request) => globalThis.fetch(req));
  const client = createClient<paths>({
    baseUrl: (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    fetch: opts.retry === false ? base : withRetry(base, opts.retry ?? {}),
  });
  const auth: Middleware = {
    async onRequest({ request, schemaPath }) {
      const token = opts.getToken ? await opts.getToken() : opts.apiKey;
      if (token) request.headers.set('Authorization', `Bearer ${token}`);
      const v = opts.apiVersion === undefined ? API_VERSION : opts.apiVersion;
      if (v) request.headers.set('X-Api-Version', v);
      if (opts.locale) request.headers.set('Accept-Language', opts.locale);
      if (
        opts.autoIdempotencyKey !== false &&
        request.method === 'POST' &&
        IDEMPOTENT_POSTS.has(schemaPath) &&
        !request.headers.has('Idempotency-Key')
      )
        request.headers.set('Idempotency-Key', idempotencyKey());
      return request;
    },
  };
  client.use(auth);
  return client;
}
