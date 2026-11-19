/**
 * ตรวจลายเซ็น webhook ของ TMS (docs/04 G1 "Webhook"; spec/07 INT-102) — ทำงานได้ทั้ง Node ≥ 20 และ browser/edge (Web Crypto)
 * header `X-TMS-Signature: t=<unix>,v1=<hex>[,v1=<hex>]` · v1 = HMAC-SHA256(secret, `${t}.${rawBody}`) เป็น hex
 * ช่วงหมุน secret ระบบส่ง v1 สองตัว (secret ใหม่ + เดิม) 24 ชม. → ตรงตัวใดตัวหนึ่งก็ผ่าน
 * ต้องใช้ body **ดิบ** (สตริง/ไบต์ตามที่รับมา) — parse แล้ว stringify ใหม่ลายเซ็นจะไม่ตรง
 */
export const WEBHOOK_TOLERANCE_SEC = 300;

export type WebhookVerifyResult =
  | { ok: true; timestamp: number }
  | { ok: false; reason: 'malformed' | 'timestamp_out_of_tolerance' | 'no_matching_signature' };

export interface VerifyWebhookInput {
  /** body ดิบของคำขอ */
  rawBody: string | Uint8Array;
  /** ค่า header `X-TMS-Signature` */
  header: string | null | undefined;
  /** signing secret (`whsec_…`) — ส่งหลายตัวได้ระหว่างหมุนฝั่งคุณ */
  secret: string | readonly string[];
  /** ยอมเวลาต่างกันกี่วินาที (ค่าเริ่ม 300 — กัน replay) */
  toleranceSec?: number;
  /** เวลาปัจจุบัน (วินาที unix) — test */
  nowSec?: number;
}

const enc = new TextEncoder();

async function hmacHex(secret: string, data: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto (globalThis.crypto.subtle) is required');
  const key = await subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await subtle.sign('HMAC', key, data as BufferSource));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** เทียบสตริงยาวเท่ากันแบบเวลาคงที่ */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyWebhookSignature(
  input: VerifyWebhookInput,
): Promise<WebhookVerifyResult> {
  const parts = (input.header ?? '').split(',').map((p) => p.trim().split('='));
  const ts = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts
    .filter(([k, v]) => k === 'v1' && v && /^[0-9a-f]+$/i.test(v))
    .map(([, v]) => v!.toLowerCase());
  const t = ts && /^\d+$/.test(ts) ? Number(ts) : NaN;
  if (!Number.isFinite(t) || !sigs.length) return { ok: false, reason: 'malformed' };
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (input.toleranceSec ?? WEBHOOK_TOLERANCE_SEC))
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  const body = typeof input.rawBody === 'string' ? enc.encode(input.rawBody) : input.rawBody;
  const signed = new Uint8Array(enc.encode(`${t}.`).length + body.length);
  signed.set(enc.encode(`${t}.`), 0);
  signed.set(body, enc.encode(`${t}.`).length);
  const secrets = typeof input.secret === 'string' ? [input.secret] : input.secret;
  for (const s of secrets) {
    const want = await hmacHex(s, signed);
    if (sigs.some((g) => safeEqual(g, want))) return { ok: true, timestamp: t };
  }
  return { ok: false, reason: 'no_matching_signature' };
}

export class WebhookSignatureError extends Error {
  constructor(readonly reason: Exclude<WebhookVerifyResult, { ok: true }>['reason']) {
    super(`invalid webhook signature: ${reason}`);
    this.name = 'WebhookSignatureError';
  }
}

/** envelope ของ webhook (docs/04 G1) — `data.object` ตาม schema ของ event ใน `x-webhooks` */
export interface WebhookEvent<T = unknown> {
  id: string;
  type: string;
  version: string;
  occurredAt: string;
  tenantId: string;
  mode?: 'live' | 'test';
  data: { object: T; previousAttributes?: Record<string, unknown> | null };
  [k: string]: unknown;
}

/** ตรวจลายเซ็นแล้ว parse JSON — ลายเซ็นผิด = throw `WebhookSignatureError` (ตอบ 400 กลับไป) */
export async function constructWebhookEvent<T = unknown>(
  input: VerifyWebhookInput,
): Promise<WebhookEvent<T>> {
  const r = await verifyWebhookSignature(input);
  if (!r.ok) throw new WebhookSignatureError(r.reason);
  const text =
    typeof input.rawBody === 'string' ? input.rawBody : new TextDecoder().decode(input.rawBody);
  return JSON.parse(text) as WebhookEvent<T>;
}
