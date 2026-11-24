/**
 * สร้างบัญชีทีม Innovera สำหรับ Platform Console (ST1-T24) — ใช้บนเครื่อง ops เท่านั้น (ต่อฐานด้วย PLATFORM_DATABASE_URL)
 * ใช้: pnpm --filter @tms/api platform:user <email> "<ชื่อ>" <SUPER_ADMIN|SUPPORT|BILLING>
 * พิมพ์รหัสผ่านชั่วคราว + otpauth URI (สแกนด้วยแอป authenticator) ครั้งเดียว — ไม่เก็บค่าจริงที่ใดอีก
 * ⚠ ต้องตั้ง `NODE_ENV` ให้ตรงกับ environment ของฐานนั้น (เช่น `NODE_ENV=production pnpm --filter @tms/api platform:user …`)
 *   และ `FIELD_ENCRYPTION_KEYS` ชุดเดียวกับ API — ไม่ตั้ง NODE_ENV = ถือว่าไม่ใช่ dev: กุญแจตัวอย่างของ `.env.example` ใช้ไม่ได้ (ST9-T13 R2-M01)
 */
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../src/auth/password';
import { newTotpSecret, otpauthUri } from '../src/auth/totp';
import { FieldCipher } from '../src/common/crypto';

async function main() {
  const [email, name, role] = process.argv.slice(2);
  if (!email || !name || !['SUPER_ADMIN', 'SUPPORT', 'BILLING'].includes(role ?? ''))
    throw new Error('usage: platform:user <email> "<name>" <SUPER_ADMIN|SUPPORT|BILLING>');
  const db = new PrismaClient({ datasources: { db: { url: process.env.PLATFORM_DATABASE_URL } } });
  const password = randomBytes(18).toString('base64url');
  const secret = newTotpSecret();
  await db.platformUser.create({
    data: {
      email: email.trim().toLowerCase(),
      name,
      role: role as 'SUPER_ADMIN' | 'SUPPORT' | 'BILLING',
      passwordHash: await hashPassword(password),
      totpSecret: new FieldCipher().encrypt(secret),
    },
  });
  await db.$disconnect();
  console.log(`created ${email} (${role})`);
  console.log(`temporary password: ${password}`);
  console.log(`2FA (scan once): ${otpauthUri(secret, email, 'TMS Console')}`);
}

void main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
