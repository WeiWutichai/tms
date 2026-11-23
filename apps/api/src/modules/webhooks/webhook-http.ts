import type { LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  allowPrivateTargets,
  checkUrlShape,
  resolvePublic,
  SsrfBlockedError,
  systemResolver,
  urlHost,
  type Resolver,
} from './ssrf';

/** INT-103: รอคำตอบไม่เกิน 10 วินาที (รวมต่อ DNS + TLS + response) */
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** spec/07 §10 ข้อ 8: อ่าน response ไม่เกิน 64 KB (ที่เกินตัดทิ้ง ไม่ถือว่าล้ม) */
export const WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1024;
/** เก็บ response ใน webhook_delivery ไม่เกิน 4 KB (docs/01 §3.7) */
export const WEBHOOK_STORED_RESPONSE_BYTES = 4096;

/**
 * timeout / network = ลองใหม่ได้ · ssrf_blocked / invalid_url / invalid_request (สร้างคำขอไม่ได้ เช่น ค่า header ผิดอักขระ)
 * = ไม่ลองใหม่ · aborted = ถูกยกเลิกเพราะ lease หาย/ปิด worker (ไม่ใช่ผลของปลายทาง — ไม่บันทึก/ไม่นับ)
 */
export type SendErrorCode =
  'timeout' | 'network' | 'ssrf_blocked' | 'invalid_url' | 'invalid_request' | 'aborted';

/** error ตอนประกอบคำขอ (ไม่ได้ส่งออกไป) — ฝั่งเราผิด ไม่ใช่เครือข่าย */
const REQUEST_BUILD_ERRORS = new Set([
  'ERR_INVALID_CHAR',
  'ERR_INVALID_HTTP_TOKEN',
  'ERR_HTTP_INVALID_HEADER_VALUE',
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE',
  'ERR_INVALID_URL',
  'ERR_UNESCAPED_CHARACTERS',
]);

export interface SendResult {
  /** null = ไม่ได้ response (ดู errorCode) */
  status: number | null;
  /** response ที่อ่านได้ (≤ 64 KB) */
  body: string;
  durationMs: number;
  errorCode?: SendErrorCode;
  errorMessage?: string;
  /**
   * ST8-T09 `errorCode = network` ที่**รู้แน่ว่าคำขอไม่ได้ออกไปถึงปลายทาง** (ต่อไม่ติด / หา host ไม่เจอ) — ปลายทางที่ไม่ idempotent
   * แยก "ต่อไม่ติด" (TRANSIENT — docs/01 §6.3 connection refused) ออกจาก "สายหลุดหลังส่ง" (AMBIGUOUS — A.5 connection reset) ได้
   */
  notSent?: boolean;
}

/** error ของเครือข่ายที่เกิดก่อนต่อติด — คำขอไม่ถึงปลายทางแน่นอน */
const NOT_SENT_NETWORK_ERRORS = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
]);

export interface SendOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  resolver?: Resolver;
  /** ค่าเริ่ม = allowPrivateTargets() (dev/test + env เท่านั้น) */
  allowPrivate?: boolean;
  signal?: AbortSignal;
}

class Timeout extends Error {}

/**
 * POST JSON ไป webhook endpoint แบบปลอดภัย (ST7-T04) — ไม่โยน error (คืน errorCode แทน) ยกเว้นบั๊กของโค้ดเอง
 * - SSRF: ตรวจรูปแบบ URL → resolve DNS แล้วตรวจทุก address → socket ต่อด้วย address ที่ตรวจแล้วเท่านั้น (custom lookup)
 * - ไม่ follow redirect (3xx คืนเป็น status ให้ผู้เรียกตัดสิน) · ไม่ใช้ keep-alive agent (socket ไม่ถูกใช้ข้ามปลายทาง)
 * - timeout รวม 10 วิ · อ่าน response ≤ 64 KB · TLS ตรวจใบรับรองตามชื่อโฮสต์ปกติ
 */
export function postWebhook(
  url: string,
  headers: Record<string, string>,
  body: string,
  opts: SendOptions = {},
): Promise<SendResult> {
  return safeHttpRequest('POST', url, headers, body, opts);
}

/**
 * คำขอ HTTP ขาออกแบบกัน SSRF ตัวเดียวกับ webhook (ST8-T03: ErpAdapter ที่เรียก API ภายนอก เช่น healthCheck ใช้ GET)
 * กติกาเดียวกับ `postWebhook` ทุกข้อ · GET ไม่ส่ง body
 */
export async function safeHttpRequest(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  headers: Record<string, string>,
  body: string,
  opts: SendOptions = {},
): Promise<SendResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const maxBytes = opts.maxResponseBytes ?? WEBHOOK_MAX_RESPONSE_BYTES;
  const allowPrivate = opts.allowPrivate ?? allowPrivateTargets();
  const done = (r: Omit<SendResult, 'durationMs'>): SendResult => ({
    ...r,
    durationMs: Date.now() - started,
  });

  const shape = checkUrlShape(url, { allowPrivate });
  if (shape)
    return done({
      status: null,
      body: '',
      errorCode:
        shape.code === 'url_not_allowed' || shape.code === 'port_not_allowed'
          ? 'ssrf_blocked'
          : 'invalid_url',
      errorMessage: shape.message,
    });
  const u = new URL(url);
  if (opts.signal?.aborted)
    return done({ status: null, body: '', errorCode: 'aborted', errorMessage: 'aborted' });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Timeout('timeout')), timeoutMs);
  const onAbort = () => ctl.abort(opts.signal?.reason ?? new Error('aborted'));
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let addrs: LookupAddress[];
    try {
      addrs = await raceAbort(
        resolvePublic(urlHost(u), opts.resolver ?? systemResolver, allowPrivate),
        ctl.signal,
      );
    } catch (e) {
      if (e instanceof SsrfBlockedError)
        return done({ status: null, body: '', errorCode: 'ssrf_blocked', errorMessage: e.message });
      throw e;
    }
    const pinned = addrs[0]!;
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
        u,
        {
          method,
          headers:
            method !== 'GET'
              ? { ...headers, 'Content-Length': String(Buffer.byteLength(body)) }
              : headers,
          agent: false,
          signal: ctl.signal,
          // ต่อด้วย address ที่ตรวจแล้วเท่านั้น (ไม่ resolve ใหม่ — กัน DNS rebinding ระหว่างตรวจกับต่อ)
          lookup: ((
            _h: string,
            o: { all?: boolean },
            cb: (e: Error | null, a: string | LookupAddress[], f?: number) => void,
          ) =>
            o?.all ? cb(null, addrs) : cb(null, pinned.address, pinned.family)) as unknown as never,
        },
        (r: IncomingMessage) => {
          const chunks: Buffer[] = [];
          let size = 0;
          let cut = false;
          r.on('data', (c: Buffer) => {
            if (cut) return;
            const room = maxBytes - size;
            if (c.length > room) {
              chunks.push(c.subarray(0, room));
              size = maxBytes;
              cut = true;
              resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
              r.destroy();
              return;
            }
            chunks.push(c);
            size += c.length;
          });
          r.on('end', () =>
            resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          );
          r.on('error', (e) => (cut ? undefined : reject(e)));
        },
      );
      req.on('error', reject);
      req.end(method === 'GET' ? undefined : body);
    });
    return done({ status: res.status, body: res.body });
  } catch (e) {
    const reason = ctl.signal.aborted ? ctl.signal.reason : e;
    if (opts.signal?.aborted && !(reason instanceof Timeout))
      return done({ status: null, body: '', errorCode: 'aborted', errorMessage: 'aborted' });
    const code = (e as { code?: string })?.code;
    if (!ctl.signal.aborted && code && REQUEST_BUILD_ERRORS.has(code))
      return done({
        status: null,
        body: '',
        errorCode: 'invalid_request',
        errorMessage: networkMessage(e),
      });
    if (reason instanceof Timeout)
      return done({
        status: null,
        body: '',
        errorCode: 'timeout',
        errorMessage: `no response within ${Math.round(timeoutMs / 1000)}s`,
      });
    const netCode = (reason as { code?: string })?.code;
    return done({
      status: null,
      body: '',
      errorCode: 'network',
      errorMessage: networkMessage(reason),
      ...(netCode && NOT_SENT_NETWORK_ERRORS.has(netCode) ? { notSent: true } : {}),
    });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const on = () => reject(signal.reason);
    signal.addEventListener('abort', on, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', on));
  });
}

/** ข้อความ error เครือข่ายแบบสั้น (ไม่มี header/ข้อมูลลับ) */
function networkMessage(e: unknown): string {
  const err = e as { code?: string; message?: string };
  return (err?.code ? `${err.code}: ` : '') + String(err?.message ?? e).slice(0, 300);
}
