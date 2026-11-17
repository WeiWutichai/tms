import createClient, { type Middleware } from 'openapi-fetch';
import type { components, paths } from './schema';

export type { components, paths };
export type Schemas = components['schemas'];

/** รูปแบบ error ของทุก endpoint (RFC 9457) — UI แสดงข้อความจาก `code` ไม่ใช่จาก `title` */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  requestId?: string;
  errors?: { field: string; code: string; message: string }[];
}

/**
 * ST7-T07: เวอร์ชันพฤติกรรมของ API ที่ schema นี้สร้างจาก (= `info.x-api-version-latest` ของ openapi.json — test ฝั่ง API ตรวจให้ตรงกัน)
 * client ส่ง `X-Api-Version` ค่านี้ทุกคำขอ → UI ได้พฤติกรรมล่าสุดเสมอ ไม่ขึ้นกับวันสร้างบริษัท
 */
export const API_VERSION = '2026-11-18';

export interface ClientOptions {
  baseUrl: string;
  getToken: () => string | null | Promise<string | null>;
  locale?: () => 'th' | 'en';
  /** ทับเวอร์ชันที่ส่ง (ค่าเริ่ม API_VERSION) */
  apiVersion?: string;
  /** ทับ fetch (test) */
  fetch?: (input: Request) => Promise<Response>;
}

/** client ชุดเดียวที่ UI ใช้ — endpoint เดียวกับลูกค้า (API-first, docs/01 §5.4) */
export function createTmsClient(opts: ClientOptions) {
  const client = createClient<paths>({
    baseUrl: opts.baseUrl,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const auth: Middleware = {
    async onRequest({ request }) {
      request.headers.set('X-Api-Version', opts.apiVersion ?? API_VERSION);
      const token = await opts.getToken();
      if (token) request.headers.set('Authorization', `Bearer ${token}`);
      if (opts.locale) request.headers.set('Accept-Language', opts.locale());
      return request;
    },
  };
  client.use(auth);
  return client;
}

export type TmsClient = ReturnType<typeof createTmsClient>;
