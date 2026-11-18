import { createHash, randomBytes } from 'node:crypto';
import { hashApiKey } from '../api-keys/key-material';

/**
 * token ใน URL รับ webhook ขาเข้า (ST7-T22; docs/04 G3 "URL มี tenant token")
 * `whin_` + 43 ตัว base64url (256 bit) — ต่อ connector, ไม่ซ้ำทั้งระบบ, ใช้หา tenant + connector โดยไม่ต้อง login
 * เก็บในฐานเฉพาะ HMAC-SHA256(pepper, token) (pepper เดียวกับ API key) — ฐานรั่วอย่างเดียวย้อนหา token ไม่ได้
 * token ไม่ใช่การยืนยันตัวตนผู้ส่ง: ทุกคำขอต้องผ่านการตรวจลายเซ็นของ adapter ด้วย
 */
export const INBOUND_TOKEN_PREFIX = 'whin_';
export const INBOUND_TOKEN_RE = /^whin_[A-Za-z0-9_-]{43}$/;

export function generateInboundToken(): { token: string; prefix: string; hash: string } {
  const token = `${INBOUND_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return {
    token,
    prefix: token.slice(0, INBOUND_TOKEN_PREFIX.length + 4),
    hash: hashApiKey(token),
  };
}

export const hashInboundToken = (token: string) => hashApiKey(token);

/** key ของ rate limit ต่อ token (ไม่เก็บ token ตัวจริงในที่เก็บของตัวจำกัด — ใช้ได้แม้ token ผิดรูป) */
export const inboundTokenRateKey = (token: string) =>
  createHash('sha256').update(token).digest('base64url').slice(0, 32);
