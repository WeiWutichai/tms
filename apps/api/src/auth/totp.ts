import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP ตาม RFC 6238 (HMAC-SHA1, 30 วินาที, 6 หลัก) — ใช้กับแอป Authenticator ทั่วไป (ST1-T05)
 * ยอมคลาดเคลื่อน ±1 ช่วง (นาฬิกามือถือไม่ตรง) และคืน time-step ที่ใช้ เพื่อกันใช้รหัสเดิมซ้ำ
 */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_PERIOD = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** secret 160 bit (RFC 4226 แนะนำ) เป็น base32 */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1]! & 0xf;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 1_000_000).padStart(6, '0');
}

export function currentStep(now = Date.now()): number {
  return Math.floor(now / 1000 / TOTP_PERIOD);
}

/** คืน time-step ที่ตรง หรือ null — ไม่รับ step ที่ ≤ lastStep (ใช้ไปแล้ว) */
export function verifyTotp(
  secret: string,
  code: string,
  lastStep?: number | null,
  now = Date.now(),
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = currentStep(now);
  for (const s of [step - 1, step, step + 1]) {
    if (lastStep != null && s <= lastStep) continue;
    const want = Buffer.from(hotp(secret, s));
    if (timingSafeEqual(want, Buffer.from(code))) return s;
  }
  return null;
}

export function otpauthUri(secret: string, account: string, issuer = 'TMS'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_PERIOD}`;
}

/** backup code 10 ชุด รูปแบบ xxxx-xxxx (ตัวพิมพ์เล็ก/ตัวเลข ตัดตัวที่สับสน) */
const BC = 'abcdefghjkmnpqrstuvwxyz23456789';
export function newBackupCodes(n = 10): string[] {
  return Array.from({ length: n }, () => {
    const b = randomBytes(8);
    const s = [...b].map((x) => BC[x % BC.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}
export function normalizeBackupCode(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}
