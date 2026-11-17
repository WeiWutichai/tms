import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { isLocalEnv } from '../../auth/tokens';

/**
 * รูปแบบ API key (docs/04 G1): `tk_live_` / `tk_test_` + ส่วนสุ่ม 48 hex (192 bit)
 * เก็บในฐานเฉพาะ HMAC-SHA256(pepper, key เต็ม) (spec/07 §6 "sha-256 + pepper") — ฐานรั่วอย่างเดียวย้อนหา key ไม่ได้
 * prefix แสดงผล = `tk_live_` + 4 ตัวแรกของส่วนสุ่ม (ต้นแบบ `tms_live_8f3a…`)
 */
export const API_KEY_RE = /^tk_(live|test)_([0-9a-f]{48})$/;
export type KeyMode = 'live' | 'test';

const DEV_PEPPER = 'dev-only-api-key-pepper-0123456789abcdef';

function pepper(): string {
  const p = process.env.API_KEY_PEPPER ?? (isLocalEnv() ? DEV_PEPPER : undefined);
  if (!p || p.length < 32) throw new Error('API_KEY_PEPPER (>= 32 chars) required');
  return p;
}

/** ดูรูปแบบอย่างเดียว (ไม่ตรวจกับฐาน) — ใช้แยก Bearer ที่เป็น API key ออกจาก JWT */
export const looksLikeApiKey = (v: string) => v.startsWith('tk_live_') || v.startsWith('tk_test_');

export function hashApiKey(key: string): string {
  return createHmac('sha256', pepper()).update(key).digest('base64url');
}

/** เทียบ hash แบบเวลาคงที่ (ค่าที่ได้จากฐานกับค่าที่คำนวณ) */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function generateApiKey(mode: KeyMode): { key: string; prefix: string; hash: string } {
  const rnd = randomBytes(24).toString('hex');
  const key = `tk_${mode}_${rnd}`;
  return { key, prefix: `tk_${mode}_${rnd.slice(0, 4)}`, hash: hashApiKey(key) };
}

// ---------- IP allowlist (INT-075) ----------

export const IP_ALLOWLIST_MAX = 20;

/**
 * รูปแบบมาตรฐานของรายการ allowlist: IPv4/IPv6 เดี่ยว หรือ CIDR (`203.150.12.0/24`, `2001:db8::/32`)
 * คืน null เมื่อรูปแบบผิด · IPv4 ใน IPv6 (`::ffff:1.2.3.4`) แปลงเป็น IPv4
 */
export function normalizeIpEntry(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const [addr0, bits, ...rest] = v.split('/');
  if (rest.length || addr0 === undefined) return null;
  const addr = unmapV4(addr0);
  const fam = isIP(addr);
  if (!fam) return null;
  if (bits === undefined) return addr.toLowerCase();
  if (!/^\d{1,3}$/.test(bits)) return null;
  const n = Number(bits);
  if (n > (fam === 4 ? 32 : 128)) return null;
  return `${addr.toLowerCase()}/${n}`;
}

function unmapV4(ip: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return m ? m[1]! : ip;
}

/** IP ผู้เรียกอยู่ใน allowlist ไหม — รายการว่าง = ทุก IP */
export function ipAllowed(list: readonly string[], ip: string | undefined): boolean {
  if (!list.length) return true;
  if (!ip) return false;
  const addr = unmapV4(ip);
  const fam = isIP(addr);
  if (!fam) return false;
  const bl = new BlockList();
  for (const e of list) {
    const [a, bits] = e.split('/');
    const f = isIP(a!);
    if (!f) continue;
    const type = f === 4 ? 'ipv4' : 'ipv6';
    if (bits === undefined) bl.addAddress(a!, type);
    else bl.addSubnet(a!, Number(bits), type);
  }
  return bl.check(addr, fam === 4 ? 'ipv4' : 'ipv6');
}
