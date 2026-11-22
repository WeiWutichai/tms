import type { NestExpressApplication } from '@nestjs/platform-express';
import { Prisma, PrismaClient } from '@prisma/client';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { signDevToken } from '../src/auth/auth.guard';
import { createApp } from '../src/bootstrap';
import { INVOICE_TEMPLATE_VERSION } from '../src/modules/invoices/invoice.template';

export const platform = () =>
  new PrismaClient({ datasources: { db: { url: process.env.PLATFORM_DATABASE_URL } } });

/** ข้อมูลอ้างอิงที่มากับ migration (ไม่ใช่ข้อมูลของ tenant) — ห้ามล้าง */
const REFERENCE_TABLES = ['_prisma_migrations', 'plan', 'plan_entitlement'];

/** ลบข้อมูลทุกตาราง business (ใช้ role owner เพื่อ TRUNCATE ได้) */
export async function truncateAll(): Promise<void> {
  // กันล้างฐาน dev/production โดยไม่ตั้งใจ — ล้างได้เฉพาะฐานที่ชื่อลงท้าย _test / _e2e / _qa
  const dbName = new URL(process.env.DATABASE_URL ?? 'postgres://x/none').pathname.slice(1);
  if (!/_(test|e2e|qa)$/.test(dbName)) {
    throw new Error(`truncateAll ปฏิเสธฐาน "${dbName}" — ใช้ได้เฉพาะฐาน *_test / *_e2e / *_qa`);
  }
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

/**
 * D-67 (step-up 2FA ขยาย — PO 22 พ.ย. 2569): route ที่เพิ่ม step-up ในรอบนี้ — `api()` แนบ `X-Step-Up` ที่ถูกต้องของผู้เรียก
 * (token ผู้ใช้/dev) ให้อัตโนมัติ เพื่อให้ test เดิมที่ทดสอบเรื่องอื่นของ route เหล่านี้ยังเป็น "ผู้ใช้ที่ยืนยัน 2FA แล้ว"
 * ด่าน step-up เองทดสอบใน `test/step-up-d67.test.ts` (ส่ง `X-Step-Up` ว่างทับ = ไม่ได้ยืนยัน)
 * route step-up เดิม (role/เชิญ/รหัสสำรอง/อนุมัติใบสำคัญจ่าย/ตั้งค่า) **ไม่อยู่ในรายการ** — test ของมันส่ง header เอง
 */
const D67_STEP_UP_ROUTES: [string, RegExp][] = [
  ['POST', /^\/v1\/api-keys(\/[^/?]+\/rotate)?(\?|$)/],
  ['POST', /^\/v1\/webhooks(\/[^/?]+\/rotate-secret)?(\?|$)/],
  ['POST', /^\/v1\/connectors(\/[^/?]+\/inbound-token\/rotate)?(\?|$)/],
  ['PUT', /^\/v1\/connectors\/[^/?]+\/credentials(\?|$)/],
  ['POST', /^\/v1\/carriers(\/[^/?]+\/reveal)?(\?|$)/],
  ['PATCH', /^\/v1\/carriers\/[^?]+$/],
  ['PUT', /^\/v1\/carriers\/external\/[^/?]+(\?|$)/],
  ['POST', /^\/v1\/exports(\?|$)/],
  ['GET', /^\/v1\/[\w-]+\/export(\?|$)/],
  ['POST', /^\/v1\/invoices\/[^/?]+\/void(\?|$)/],
  ['POST', /^\/v1\/billing-notes\/[^/?]+\/cancel(\?|$)/],
  ['POST', /^\/v1\/imports\/[^/?]+\/commit(\?|$)/],
];

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** step-up token (HS256 แบบเดียวกับ signStepUpToken) แบบ sync — ใช้ใน `api()` */
function stepUpHeaderFor(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null; // API key `tk_…`
  let claims: { sub?: string; tid?: string; pt?: string };
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!claims.sub || !claims.tid || (claims.pt !== 'dev' && claims.pt !== 'user')) return null;
  const secret = process.env.AUTH_JWT_SECRET ?? process.env.AUTH_DEV_SECRET ?? '';
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'HS256' }));
  const body = b64url(
    JSON.stringify({ tid: claims.tid, pur: 'step_up', sub: claims.sub, iat: now, exp: now + 300 }),
  );
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export function api(app: NestExpressApplication, token?: string) {
  const server = app.getHttpServer();
  const withAuth = (method: string, url: string, t: request.Test) => {
    if (!token) return t;
    t.set('Authorization', `Bearer ${token}`);
    if (D67_STEP_UP_ROUTES.some(([m, re]) => m === method && re.test(url))) {
      const su = stepUpHeaderFor(token);
      if (su) t.set('X-Step-Up', su);
    }
    return t;
  };
  return {
    get: (url: string) => withAuth('GET', url, request(server).get(url)),
    post: (url: string) => withAuth('POST', url, request(server).post(url)),
    patch: (url: string) => withAuth('PATCH', url, request(server).patch(url)),
    put: (url: string) => withAuth('PUT', url, request(server).put(url)),
    delete: (url: string) => withAuth('DELETE', url, request(server).delete(url)),
  };
}

/**
 * รหัส TOTP ที่ server รับแน่นอนโดยไม่ขึ้นกับจังหวะนาฬิกา (กัน test 2FA flaky — ST2-T11 fix):
 * - ไม่ออกรหัสในช่วง 3 วินาทีสุดท้ายของ time-step (รอข้ามขอบก่อน) → server ซึ่งอ่านนาฬิกาเครื่องเดียวกันอยู่ step เดียวกัน
 * - จำ step ที่ใช้ไปแล้วต่อ secret แล้วออก step ถัดไปเสมอ (server ไม่รับ step ≤ ที่ใช้ล่าสุด — กันใช้รหัสซ้ำ)
 *   แต่ไม่เกิน step ปัจจุบัน + 1 (หน้าต่างที่ server ยอม) — เกินแล้วรอ step ถัดไป
 * ใช้แทน `hotp(secret, currentStep())` / `currentStep() + 1` ที่ขึ้นกับเวลาและลำดับ test
 * ⚠ secret เดียวใช้ได้ 2 รหัสโดยไม่รอ (step ปัจจุบัน + step ถัดไป) — รหัสที่ 3 ภายใน step เดียวกันต้องรอข้าม step
 *   (สูงสุด ~30 วินาที) → test ที่ใช้ ≥ 3 รหัสต่อ secret ต้องตั้ง timeout เกิน 30 วินาที
 */
const usedTotpStep = new Map<string, number>();
export async function freshOtp(secret: string): Promise<string> {
  const { hotp, currentStep, TOTP_PERIOD } = await import('../src/auth/totp');
  const period = TOTP_PERIOD * 1000;
  for (;;) {
    const now = Date.now();
    const step = currentStep(now);
    const msLeft = period - (now % period);
    const next = Math.max(step, (usedTotpStep.get(secret) ?? -Infinity) + 1);
    if (msLeft > 3000 && next <= step + 1) {
      usedTotpStep.set(secret, next);
      return hotp(secret, next);
    }
    await new Promise((r) => setTimeout(r, Math.min(msLeft + 50, 1000)));
  }
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
      .send({ mfaToken: r1.body.mfaToken, otp: await freshOtp(secret) });
    if (c.status !== 200) throw new Error(`enroll ${c.status} ${JSON.stringify(c.body)}`);
    code = c.body.code;
  } else if (r1.body.code === 'mfa_required' && secret) {
    const c = await request(srv)
      .post('/v1/auth/2fa/verify')
      .send({ mfaToken: r1.body.mfaToken, otp: await freshOtp(secret) });
    if (c.status !== 200) throw new Error(`verify ${c.status} ${JSON.stringify(c.body)}`);
    code = c.body.code;
  } else throw new Error(`login ${r1.status} ${JSON.stringify(r1.body)}`);
  const r2 = await request(srv)
    .post('/v1/oauth/token')
    .send({ grantType: 'authorization_code', code, codeVerifier: v });
  const cookie = ((r2.headers['set-cookie'] as unknown as string[]) ?? [])[0]?.split(';')[0] ?? '';
  return { access: r2.body.accessToken as string, cookie, secret };
}

/**
 * ทดสอบ: ทำให้บรรทัดต้นทุนที่ตรงเงื่อนไข "อยู่ในใบสำคัญจ่ายแล้ว" ด้วยข้อมูลจริง (ST6-T03 — trigger ระดับ DB บังคับให้
 * `trip_cost.settlement_line_id` ชี้บรรทัดที่ยังใช้ของ cost เดียวกัน และยอดหัวใบ = ยอดบรรทัด) · 1 ใบต่อรถร่วม · คืนจำนวนบรรทัด
 */
export async function settleTripCostsForTest(
  db: PrismaClient,
  where: Prisma.TripCostWhereInput,
  /** ผู้สร้างใบ/บรรทัด (ST6-T07 — อนุมัติต้องรู้ผู้เตรียม) · ไม่ระบุ = ว่าง */
  createdBy: string | null = null,
): Promise<number> {
  return db.$transaction(async (tx) => {
    const costs = await tx.tripCost.findMany({
      where: { ...where, settlementLineId: null },
      orderBy: { id: 'asc' },
    });
    const byCarrier = new Map<string, typeof costs>();
    for (const c of costs) {
      if (!c.carrierId) throw new Error(`trip_cost ${c.id} has no carrier`);
      byCarrier.set(c.carrierId, [...(byCarrier.get(c.carrierId) ?? []), c]);
    }
    for (const [carrierId, cs] of byCarrier) {
      const gross = cs.reduce((a, c) => a.add(c.amount), new Prisma.Decimal(0));
      const s = await tx.carrierSettlement.create({
        data: {
          tenantId: cs[0]!.tenantId,
          carrierId,
          carrierSnapshot: {},
          periodFrom: new Date('2026-11-01T00:00:00Z'),
          periodTo: new Date('2026-11-30T00:00:00Z'),
          grossAmount: gross,
          netPayable: gross,
          createdBy,
        },
      });
      let no = 0;
      for (const c of cs) {
        const l = await tx.settlementLine.create({
          data: {
            tenantId: c.tenantId,
            settlementId: s.id,
            lineNo: ++no,
            lineType: c.costType === 'CARRIER_FEE' ? 'FREIGHT' : 'SURCHARGE',
            tripCostId: c.id,
            tripId: c.tripId,
            description: c.description ?? c.costType,
            amount: c.amount,
            createdBy,
          },
        });
        await tx.tripCost.update({ where: { id: c.id }, data: { settlementLineId: l.id } });
      }
    }
    return costs.length;
  });
}

/**
 * ST5-T09 (migration 0140): ใบที่ไม่ใช่ร่าง/ร่างที่ยกเลิก ต้องมีข้อมูล ณ วันออกครบ (CHECK `invoice_issued_fields_check`) —
 * test ที่ตั้งสถานะใบเองโดยไม่ผ่าน `POST /invoices/{id}/finalize` ใช้ค่านี้
 */
export function issuedTestFields(invoiceNo: string) {
  return {
    invoiceNo,
    issuedAt: new Date(),
    issuedBy: 'test',
    issueDate: new Date('2026-11-20T00:00:00.000Z'),
    dueDate: new Date('2026-12-20T00:00:00.000Z'),
    customerSnapshot: { name: 'ลูกค้าทดสอบ', taxId: null, branchCode: null, address: '' },
    issuerSnapshot: { name: 'ผู้ออกทดสอบ', taxId: null, branchCode: '00000', address: '' },
    printOptions: {
      yearStyle: 'BE',
      whtMinimumAmount: 0,
      templateVersion: INVOICE_TEMPLATE_VERSION,
    },
  };
}
