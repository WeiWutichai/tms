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

/** job ประมวลผล event ที่บันทึกใหม่ `{eventId}` (ST7-T22) — อยู่ที่นี่ให้ ConnectorsService ปลุกได้โดยไม่วนพึ่งกัน */
export const INBOUND_PROCESS_JOB = 'inbound.process';
/**
 * รอก่อนลองใหม่ครั้งที่ n (ล้มแบบลองใหม่ได้ — ครอบ ERP ล่มสั้น ๆ): 1 นาที, 5 นาที, 15 นาที, 1 ชม., 6 ชม. แล้ว FAILED
 * จำนวนครั้ง = ช่วงรอ + 1
 */
export const INBOUND_RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000];
export const INBOUND_MAX_ATTEMPTS = INBOUND_RETRY_DELAYS_MS.length + 1;
