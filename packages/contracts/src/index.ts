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

export interface ClientOptions {
  baseUrl: string;
  getToken: () => string | null | Promise<string | null>;
  locale?: () => 'th' | 'en';
}

/** client ชุดเดียวที่ UI ใช้ — endpoint เดียวกับลูกค้า (API-first, docs/01 §5.4) */
export function createTmsClient(opts: ClientOptions) {
  const client = createClient<paths>({ baseUrl: opts.baseUrl });
  const auth: Middleware = {
    async onRequest({ request }) {
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
