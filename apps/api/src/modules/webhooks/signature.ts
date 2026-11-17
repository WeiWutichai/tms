import { WEBHOOK_SIGNATURE_TOLERANCE_SEC } from '@tms/domain';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** signing secret ใหม่ `whsec_` + 32 ตัว base64url (192 bit) — แสดงครั้งเดียว (spec/07 §10) */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

/** INT-102: HMAC-SHA256(secret, `${t}.${rawBody}`) เป็น hex — key = secret ทั้งสตริง (รวม `whsec_`) */
export function signPayload(secret: string, t: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
}

/**
 * ค่า header `X-TMS-Signature: t=<unix>,v1=<hex>[,v1=<hex>]` — หมุน secret แล้ว 24 ชม. ส่ง v1 ของ secret ใหม่ + เดิม (INT-102)
 * secret ตัวแรก = ปัจจุบัน
 */
export function signatureHeader(t: number, rawBody: string, secrets: readonly string[]): string {
  return [`t=${t}`, ...secrets.map((s) => `v1=${signPayload(s, t, rawBody)}`)].join(',');
}

export type VerifyResult =
  | { ok: true; t: number }
  | { ok: false; reason: 'malformed' | 'timestamp_out_of_tolerance' | 'no_matching_signature' };

/**
 * ตรวจลายเซ็นแบบที่ผู้รับควรทำ (ใช้ใน test + ตัวอย่างโค้ดในหน้าจอ/เอกสาร):
 * แยก `t` กับ `v1` ทุกตัว → ปฏิเสธ `|now − t| > 300 วิ` (กัน replay) → เทียบ HMAC แบบ constant-time กับ v1 ตัวใดตัวหนึ่ง
 */
export function verifyWebhookSignature(input: {
  secret: string;
  header: string | undefined;
  rawBody: string;
  nowSec?: number;
  toleranceSec?: number;
}): VerifyResult {
  const parts = (input.header ?? '').split(',').map((p) => p.trim().split('='));
  const ts = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k, v]) => k === 'v1' && v).map(([, v]) => v!);
  const t = ts && /^\d+$/.test(ts) ? Number(ts) : NaN;
  if (!Number.isFinite(t) || !sigs.length) return { ok: false, reason: 'malformed' };
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (input.toleranceSec ?? WEBHOOK_SIGNATURE_TOLERANCE_SEC))
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  const want = Buffer.from(signPayload(input.secret, t, input.rawBody), 'hex');
  const hit = sigs.some((s) => {
    if (!/^[0-9a-f]+$/i.test(s)) return false;
    const got = Buffer.from(s, 'hex');
    return got.length === want.length && timingSafeEqual(got, want);
  });
  return hit ? { ok: true, t } : { ok: false, reason: 'no_matching_signature' };
}
