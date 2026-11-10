import { hash, verify } from '@node-rs/argon2';

/** argon2id ตาม OWASP (m=19 MiB, t=2, p=1) — A1, T-04 */
const OPTS = {
  algorithm: 2 /* Argon2id */,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTS);
}

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}

/** hash จำลอง — ใช้ตรวจเมื่อไม่พบผู้ใช้ เพื่อให้เวลาตอบเท่ากัน (ไม่เผยว่ามีอีเมลในระบบ) */
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword('dummy-password-for-timing-equalisation');
  return dummy;
}
