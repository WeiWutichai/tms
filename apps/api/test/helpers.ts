import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { signDevToken } from '../src/auth/auth.guard';
import { createApp } from '../src/bootstrap';

export const platform = () =>
  new PrismaClient({ datasources: { db: { url: process.env.PLATFORM_DATABASE_URL } } });

/** ข้อมูลอ้างอิงที่มากับ migration (ไม่ใช่ข้อมูลของ tenant) — ห้ามล้าง */
const REFERENCE_TABLES = ['_prisma_migrations', 'plan', 'plan_entitlement'];

/** ลบข้อมูลทุกตาราง business (ใช้ role owner เพื่อ TRUNCATE ได้) */
export async function truncateAll(): Promise<void> {
  const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const tables = await owner.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> ALL(${REFERENCE_TABLES})`;
  if (tables.length) {
    await owner.$executeRawUnsafe(
      `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`,
    );
  }
  await owner.$disconnect();
}

export async function createTenant(db: PrismaClient, name = `tenant-${randomUUID().slice(0, 8)}`) {
  return db.tenant.create({ data: { name } });
}

export async function tokenFor(tenantId: string, scope = '*', sub = 'user-test') {
  return signDevToken({ sub, tid: tenantId, scope });
}

export async function bootApp(): Promise<NestExpressApplication> {
  return createApp();
}

/** สร้างเลขผู้เสียภาษีที่ checksum ถูกต้องจาก seed ตัวเลข */
export function validTaxId(seed: number): string {
  const base = String(1_000_000_000_00 + seed)
    .padStart(12, '0')
    .slice(-12);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

export function api(app: NestExpressApplication, token?: string) {
  const server = app.getHttpServer();
  const withAuth = (t: request.Test) => (token ? t.set('Authorization', `Bearer ${token}`) : t);
  return {
    get: (url: string) => withAuth(request(server).get(url)),
    post: (url: string) => withAuth(request(server).post(url)),
    patch: (url: string) => withAuth(request(server).patch(url)),
    put: (url: string) => withAuth(request(server).put(url)),
    delete: (url: string) => withAuth(request(server).delete(url)),
  };
}

/**
 * login ผ่าน API จริง (PKCE) และจัดการ 2FA อัตโนมัติ (ST1-T05): role ที่บังคับ 2FA จะถูกตั้ง TOTP ให้ตอน login แรก
 * คืน access token + secret (ถ้าตั้งให้) เพื่อใช้ step-up ต่อ
 */
export async function loginFull(
  app: NestExpressApplication,
  email: string,
  password: string,
  ip: string,
  totp?: { secret?: string },
): Promise<{ access: string; cookie: string; secret?: string }> {
  const { pkceChallenge } = await import('../src/auth/tokens');
  const { hotp, currentStep } = await import('../src/auth/totp');
  const { randomBytes } = await import('node:crypto');
  const v = randomBytes(32).toString('base64url');
  const srv = app.getHttpServer();
  const r1 = await request(srv)
    .post('/v1/auth/login')
    .set('X-Forwarded-For', ip)
    .send({ email, password, codeChallenge: pkceChallenge(v) });
  let code: string;
  let secret = totp?.secret;
  if (r1.status === 200) code = r1.body.code;
  else if (r1.body.code === 'mfa_enrollment_required') {
    const s = await request(srv).post('/v1/auth/2fa/enroll').send({ mfaToken: r1.body.mfaToken });
    secret = s.body.secret as string;
    const c = await request(srv)
      .post('/v1/auth/2fa/enroll/confirm')
      .send({ mfaToken: r1.body.mfaToken, otp: hotp(secret, currentStep()) });
    if (c.status !== 200) throw new Error(`enroll ${c.status} ${JSON.stringify(c.body)}`);
    code = c.body.code;
  } else if (r1.body.code === 'mfa_required' && secret) {
    const c = await request(srv)
      .post('/v1/auth/2fa/verify')
      .send({ mfaToken: r1.body.mfaToken, otp: hotp(secret, currentStep() + 1) });
    if (c.status !== 200) throw new Error(`verify ${c.status} ${JSON.stringify(c.body)}`);
    code = c.body.code;
  } else throw new Error(`login ${r1.status} ${JSON.stringify(r1.body)}`);
  const r2 = await request(srv)
    .post('/v1/oauth/token')
    .send({ grantType: 'authorization_code', code, codeVerifier: v });
  const cookie = ((r2.headers['set-cookie'] as unknown as string[]) ?? [])[0]?.split(';')[0] ?? '';
  return { access: r2.body.accessToken as string, cookie, secret };
}
