import type { ErrorClass } from '../../modules/integration/outbox.types';
import type { ErpContext, Problem } from '../../modules/erp/erp-adapter';
import { safeHttpRequest, type SendOptions } from '../../modules/webhooks/webhook-http';

/**
 * HTTP ไป AccountSystem `ext/v1` (ST8-T16; packages/contracts/accountsystem/README.md)
 * - ผ่าน HTTP client กัน SSRF ตัวเดียวกับ webhook (resolve + ตรวจ IP + ต่อด้วย address ที่ตรวจแล้ว · ไม่ follow redirect)
 * - `Authorization: Bearer inn_…` อยู่ใน header เท่านั้น (ไม่อยู่ใน URL/ข้อความ error)
 * - แปลงผลเป็น ErrorClass กลาง (docs/01 §6.3): 400/404/422 = VALIDATION · 401/403 = AUTH · 429/5xx/timeout/เครือข่าย = TRANSIENT
 *   (POST สร้างร่างกันซ้ำด้วย external_ref ฝั่ง AccountSystem → ส่งซ้ำหลัง timeout ได้อย่างปลอดภัย จึงไม่ใช้ AMBIGUOUS)
 */
export const AS_TIMEOUT_MS = 30_000;
export const AS_HEALTH_TIMEOUT_MS = 10_000;

export type HttpOpts = Pick<SendOptions, 'allowPrivate' | 'resolver'>;

export type AsCallResult =
  | { ok: true; status: number; json: unknown }
  | { ok: false; errorClass: ErrorClass; retryable: boolean; problem: Problem };

export function baseOf(ctx: ErpContext): string {
  return (ctx.config.baseUrl ?? '').trim().replace(/\/+$/, '');
}

/** ข้อความ `{error}` ของ AccountSystem (ตัดยาว) — ไม่มี credential (AccountSystem ไม่สะท้อน header กลับ) */
function errorText(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: unknown; message?: unknown };
    const m = j?.error ?? j?.message;
    if (typeof m === 'string') return m.slice(0, 300);
  } catch {
    /* ไม่ใช่ JSON */
  }
  return '';
}

export async function asCall(
  ctx: ErpContext,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body: unknown,
  http: HttpOpts,
  timeoutMs = AS_TIMEOUT_MS,
): Promise<AsCallResult> {
  const base = baseOf(ctx);
  const key = ctx.config.apiKey ?? '';
  if (!base) return fail('VALIDATION', 'config_missing', 'baseUrl is not set');
  if (!key) return fail('AUTH', 'credentials_missing', 'apiKey is not set');
  const started = Date.now();
  const at = new Date();
  const r = await safeHttpRequest(
    method,
    `${base}${path}`,
    {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body === undefined ? '' : JSON.stringify(body),
    { timeoutMs, signal: ctx.signal, maxResponseBytes: 1024 * 1024, ...http },
  );
  // ST7-T16 sync log 1 แถวต่อ 1 HTTP call (docs/01 §6.4) — ไม่ส่ง header (Authorization) · core ตัด credential/เลขบัตรซ้ำอีกชั้น
  try {
    ctx.onHttpCall?.({
      method,
      url: `${base}${path}`,
      requestBody: body,
      status: r.status,
      responseBody: r.status === null ? null : r.body,
      errorCode: r.status === null ? (r.errorCode ?? 'network') : null,
      durationMs: Date.now() - started,
      at,
    });
  } catch {
    /* ตัวบันทึกล้ม = ไม่กระทบผล */
  }
  if (r.status === null) {
    switch (r.errorCode) {
      case 'timeout':
        return fail('TRANSIENT', 'timeout', `AccountSystem did not answer within ${timeoutMs} ms`);
      case 'network':
      case 'aborted':
        return fail(
          'TRANSIENT',
          'unreachable',
          `AccountSystem unreachable: ${r.errorMessage ?? ''}`,
        );
      case 'ssrf_blocked':
        return fail('VALIDATION', 'url_not_allowed', r.errorMessage ?? 'destination not allowed');
      default:
        return fail('VALIDATION', 'invalid_request', r.errorMessage ?? 'cannot build request');
    }
  }
  const text = errorText(r.body);
  if (r.status >= 200 && r.status < 300) {
    try {
      return { ok: true, status: r.status, json: r.body ? JSON.parse(r.body) : null };
    } catch {
      return fail('TRANSIENT', 'invalid_response', 'AccountSystem returned a non-JSON response');
    }
  }
  if (r.status === 401)
    return fail('AUTH', 'unauthorized', `AccountSystem rejected the API key (HTTP 401) ${text}`);
  if (r.status === 403)
    return fail('AUTH', 'scope_missing', `AccountSystem API key lacks a scope (HTTP 403) ${text}`);
  if (r.status === 429 || r.status >= 500)
    return fail('TRANSIENT', `http_${r.status}`, `AccountSystem answered HTTP ${r.status}`);
  if (r.status === 422)
    return fail(
      'VALIDATION',
      /คู่ค้า/u.test(text) ? 'contact_not_found' : 'rejected',
      text || 'AccountSystem rejected the document (HTTP 422)',
    );
  return fail(
    'VALIDATION',
    `http_${r.status}`,
    text || `unexpected HTTP ${r.status} — check baseUrl`,
  );
}

export function fail(
  errorClass: ErrorClass,
  code: string,
  message: string,
): { ok: false; errorClass: ErrorClass; retryable: boolean; problem: Problem } {
  return {
    ok: false,
    errorClass,
    retryable: errorClass === 'TRANSIENT',
    problem: { code, message: message.trim().slice(0, 300) },
  };
}
