import { createHmac, timingSafeEqual } from 'node:crypto';
import { isLocalEnv } from '../../auth/tokens';

/**
 * URL อัปโหลด/ดาวน์โหลดแบบมีลายเซ็นและหมดอายุ (เทียบเท่า presigned URL ของ object storage)
 * ลายเซ็นครอบ (การกระทำ, tenant, id เอกสาร, เวลาหมดอายุ) — แก้ส่วนใดส่วนหนึ่ง = ลายเซ็นไม่ตรง
 * production เปลี่ยนเป็น presigned URL ของ S3 ได้โดยไม่เปลี่ยนสัญญา API (uploadUrl / downloadUrl + expiresAt)
 */
export type UrlAction = 'upload' | 'download';
export const UPLOAD_TTL_S = 15 * 60;
export const DOWNLOAD_TTL_S = 5 * 60;

function key(): Buffer {
  const s =
    process.env.DOCUMENT_URL_SECRET ??
    process.env.AUTH_JWT_SECRET ??
    (isLocalEnv() ? process.env.AUTH_DEV_SECRET : undefined);
  if (!s || s.length < 32) throw new Error('DOCUMENT_URL_SECRET (>= 32 chars) required');
  return createHmac('sha256', s).update('tms-document-url-v1').digest();
}

function mac(action: UrlAction, tenantId: string, id: string, exp: number) {
  return createHmac('sha256', key())
    .update(`${action}|${tenantId}|${id}|${exp}`)
    .digest('base64url');
}

export function signDocumentUrl(action: UrlAction, tenantId: string, id: string, ttlS: number) {
  const exp = Math.floor(Date.now() / 1000) + ttlS;
  const t = Buffer.from(tenantId.replace(/-/g, ''), 'hex').toString('base64url');
  return {
    query: `t=${t}&exp=${exp}&sig=${mac(action, tenantId, id, exp)}`,
    expiresAt: new Date(exp * 1000),
  };
}

/** คืน tenantId ถ้าลายเซ็นถูกและยังไม่หมดอายุ */
export function verifyDocumentUrl(
  action: UrlAction,
  id: string,
  q: { t?: string; exp?: string; sig?: string },
): string | null {
  if (!q.t || !q.exp || !q.sig || !/^\d{1,12}$/.test(q.exp)) return null;
  const exp = Number(q.exp);
  if (exp * 1000 < Date.now()) return null;
  const hex = Buffer.from(q.t, 'base64url').toString('hex');
  if (hex.length !== 32) return null;
  const tenantId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const want = Buffer.from(mac(action, tenantId, id, exp));
  const got = Buffer.from(q.sig);
  return want.length === got.length && timingSafeEqual(want, got) ? tenantId : null;
}
