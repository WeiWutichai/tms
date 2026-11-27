import { Body, Controller, HttpCode, Module, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { createApp } from '../src/bootstrap';
import { Public } from '../src/common/decorators';
import { PrismaService } from '../src/db/prisma.service';
import {
  BotProtectionService,
  createBotProtection,
  NoopBotProtection,
  TURNSTILE_VERIFY_URL,
  TurnstileBotProtection,
  type BotProtectionProvider,
} from '../src/http/public-entry/bot-protection';
import {
  BotProtected,
  OtpSendLimit,
  phoneE164,
  recipientKey,
  SignupAttemptLimit,
} from '../src/http/public-entry/public-entry.guard';
import { platform, truncateAll } from './helpers';

/**
 * P1-ST2-T08 ป้องกันทางเข้าสาธารณะ — เกณฑ์ตรวจรับ: "ยิงสมัครครั้งที่ 6 จาก IP เดียวใน 1 ชม. → 429 โดยไม่เปิด transaction"
 * endpoint สมัครจริงมากับ P1-ST2-T03 → ที่นี่ใช้ controller เฉพาะ test ใต้ `/v1/public/signup/*` ที่ติด decorator ชุดเดียวกัน
 * (handler เปิด transaction ทุกครั้งที่ถูกเรียก — นับจาก spy ของ `$transaction`)
 */
let handled = 0;

@Public()
@Controller('public/signup/__probe')
class SignupProbeController {
  /** ตั้งใน beforeAll (PrismaService ไม่ได้ export ออกจาก AppModule) */
  static prisma: PrismaService;
  private get prisma() {
    return SignupProbeController.prisma;
  }

  @Post()
  @HttpCode(201)
  @SignupAttemptLimit()
  @BotProtected('signup')
  async start() {
    await this.prisma.app.$transaction(async () => {
      handled++;
    });
    return { ok: true };
  }

  @Post('otp')
  @HttpCode(202)
  @OtpSendLimit('mobile')
  async otp(@Body() _body: unknown) {
    await this.prisma.app.$transaction(async () => {
      handled++;
    });
    return { sent: true };
  }
}
@Module({ imports: [AppModule], controllers: [SignupProbeController] })
class TestModule {}

/** ของปลอม — นับครั้งที่ถูกเรียก (ต้องไม่ถูกเรียกเมื่อเกินเพดานแล้ว) */
class FakeBot implements BotProtectionProvider {
  readonly name = 'fake';
  calls: Array<{ token?: string; action: string }> = [];
  constructor(private readonly verdict: Awaited<ReturnType<BotProtectionProvider['verify']>>) {}
  async verify(input: { token?: string; action: string }) {
    this.calls.push({ token: input.token, action: input.action });
    return this.verdict;
  }
}

describe('P1-ST2-T08 ป้องกันทางเข้าสาธารณะ', () => {
  let app: NestExpressApplication;
  let bot: BotProtectionService;
  let tx: ReturnType<typeof vi.spyOn>;
  const db = platform();
  let ipSeq = 10;
  /** IP ใหม่ต่อ test (TRUST_PROXY dev/test = 1 → เชื่อ X-Forwarded-For 1 ชั้น) */
  const nextIp = () => `198.51.100.${ipSeq++}`;
  const signup = (ip: string, token?: string) => {
    const r = request(app.getHttpServer())
      .post('/v1/public/signup/__probe')
      .set('X-Forwarded-For', ip);
    return token ? r.set('X-Bot-Token', token) : r;
  };

  beforeAll(async () => {
    await truncateAll();
    app = await createApp(TestModule);
    bot = app.get(BotProtectionService);
    SignupProbeController.prisma = app.get(PrismaService);
    tx = vi.spyOn(SignupProbeController.prisma.app, '$transaction');
  });
  afterEach(() => {
    bot.provider = new NoopBotProtection();
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('สมัครครั้งที่ 6 จาก IP เดียวใน 1 ชม. → 429 (scope ip + Retry-After) โดยไม่เปิด transaction และไม่ถึง handler', async () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i++) await signup(ip).expect(201);
    const before = { handled, tx: tx.mock.calls.length };
    const res = await signup(ip).expect(429);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ code: 'rate_limited', scope: 'ip' });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(3000); // หน้าต่าง 1 ชม.
    expect(handled).toBe(before.handled);
    expect(tx.mock.calls.length).toBe(before.tx);
    // IP อื่นไม่ถูกกระทบ
    await signup(nextIp()).expect(201);
  });

  it('OTP ≤ 5 ครั้ง/ผู้รับ/วัน — นับเบอร์เดียวกันแม้รูปแบบต่าง (08x / +668x) · ผู้รับอื่นยังขอได้ · ไม่มีผู้รับ = ไม่นับ', async () => {
    const otp = (mobile: string | undefined, ip = nextIp()) =>
      request(app.getHttpServer())
        .post('/v1/public/signup/__probe/otp')
        .set('X-Forwarded-For', ip)
        .send(mobile === undefined ? {} : { mobile });
    const forms = ['0812345678', '+66812345678', '081-234-5678', '+66 81 234 5678', '0812345678'];
    for (const m of forms) await otp(m).expect(202); // คนละ IP ทุกครั้ง — เพดานต่อผู้รับ ไม่ใช่ต่อ IP
    const before = tx.mock.calls.length;
    const res = await otp('66812345678').expect(429);
    expect(res.body).toMatchObject({ code: 'rate_limited', scope: 'recipient' });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(80_000); // หน้าต่าง 1 วัน
    expect(tx.mock.calls.length).toBe(before);
    await otp('0899999999').expect(202);
    for (let i = 0; i < 7; i++) await otp(undefined).expect(202);
  });

  it('ไม่เก็บ IP / เบอร์ดิบในตัวนับ (PDPA)', async () => {
    const ip = '203.0.113.77';
    await signup(ip).expect(201);
    await request(app.getHttpServer())
      .post('/v1/public/signup/__probe/otp')
      .set('X-Forwarded-For', ip)
      .send({ mobile: '0811112222' })
      .expect(202);
    const rows = await db.$queryRaw<{ key: string }[]>`SELECT key FROM rate_limit_bucket`;
    const keys = rows.map((r) => r.key).join('\n');
    expect(keys).toMatch(/su:otp:/);
    expect(keys).not.toMatch(/203\.0\.113\.77|0811112222|811112222/);
    expect(recipientKey('0811112222')).toBe(recipientKey('+66 81 111 2222'));
    expect(recipientKey('0811112222')).toBe(recipientKey('0066811112222'));
    // เบอร์บ้าน: 02 / +66 2 เป็นเบอร์เดียวกัน แต่ต่างจากมือถือที่เลขท้ายเหมือนกัน และต่างจากเบอร์ต่างประเทศ
    expect(phoneE164('02-123-4567')).toBe('6621234567');
    expect(recipientKey('02-123-4567')).toBe(recipientKey('+66 2 123 4567'));
    expect(recipientKey('021234567')).not.toBe(recipientKey('021234568'));
    expect(recipientKey('0621234567')).not.toBe(recipientKey('021234567'));
    expect(recipientKey('+44 20 1234 5678')).not.toBe(recipientKey('020 1234 5678'));
    expect(recipientKey(' A@Example.test ')).toBe(recipientKey('a@example.test'));
  });

  it('ด่านกันบอท: provider ปฏิเสธ → 403 bot_check_failed (ไม่ถึง handler) · ผ่าน → 201 · ได้ token จาก X-Bot-Token + action ของขั้น', async () => {
    const deny = new FakeBot({ ok: false, reason: 'invalid' });
    bot.provider = deny;
    const before = handled;
    const res = await signup(nextIp(), 'tok-bad').expect(403);
    expect(res.body).toMatchObject({ code: 'bot_check_failed' });
    expect(handled).toBe(before);
    expect(deny.calls).toEqual([{ token: 'tok-bad', action: 'signup' }]);

    const allow = new FakeBot({ ok: true });
    bot.provider = allow;
    await signup(nextIp(), 'tok-ok').expect(201);
    expect(allow.calls).toEqual([{ token: 'tok-ok', action: 'signup' }]);
  });

  it('ด่านกันบอท: ผู้ให้บริการล่ม → 503 service_busy (fail-closed) · เกินเพดานแล้วไม่เรียกผู้ให้บริการ', async () => {
    const down = new FakeBot({ ok: false, reason: 'unavailable' });
    bot.provider = down;
    const res = await signup(nextIp(), 't').expect(503);
    expect(res.body).toMatchObject({ code: 'service_busy' });

    const ip = nextIp();
    const allow = new FakeBot({ ok: true });
    bot.provider = allow;
    for (let i = 0; i < 5; i++) await signup(ip, 't').expect(201);
    await signup(ip, 't').expect(429);
    expect(allow.calls.length).toBe(5);
  });

  it('/v1/auth/* จำกัดต่อ IP ก่อนถึงฐาน: เกินเพดาน → 429 scope ip และไม่บันทึก login_attempt เพิ่ม', async () => {
    const prev = process.env.AUTH_RATE_LIMIT_PER_MIN;
    process.env.AUTH_RATE_LIMIT_PER_MIN = '3';
    try {
      const ip = nextIp();
      const login = () =>
        request(app.getHttpServer())
          .post('/v1/auth/login')
          .set('X-Forwarded-For', ip)
          .send({
            email: 'nobody@example.test',
            password: 'wrong-password-1',
            codeChallenge: 'a'.repeat(43),
          });
      for (let i = 0; i < 3; i++) expect((await login()).status).toBe(401);
      const attempts = await db.loginAttempt.count();
      const res = await login().expect(429);
      expect(res.body).toMatchObject({ code: 'rate_limited', scope: 'ip' });
      expect(res.headers['retry-after']).toBeDefined();
      expect(await db.loginAttempt.count()).toBe(attempts);
      // คำเชิญใช้ตัวนับของตัวเอง (กลุ่ม invite) — ไม่ถูกเพดาน auth กระทบ
      const inv = await request(app.getHttpServer())
        .post('/v1/auth/invitations/inspect')
        .set('X-Forwarded-For', ip)
        .send({ token: 'x' });
      expect(inv.status).not.toBe(429);
    } finally {
      if (prev === undefined) delete process.env.AUTH_RATE_LIMIT_PER_MIN;
      else process.env.AUTH_RATE_LIMIT_PER_MIN = prev;
    }
  });
});

describe('BotProtection adapters (ไม่มีการเรียกออกภายนอก)', () => {
  it('ค่าเริ่ม = none · turnstile ต้องมี secret · ค่าที่ไม่รู้จัก = ไม่ยอมเริ่ม', () => {
    expect(createBotProtection({}).name).toBe('none');
    expect(createBotProtection({ BOT_PROTECTION_PROVIDER: 'none' }).name).toBe('none');
    expect(() => createBotProtection({ BOT_PROTECTION_PROVIDER: 'turnstile' })).toThrow(
      /TURNSTILE_SECRET_KEY/,
    );
    expect(
      createBotProtection({ BOT_PROTECTION_PROVIDER: 'turnstile', TURNSTILE_SECRET_KEY: 's' }).name,
    ).toBe('turnstile');
    expect(() => createBotProtection({ BOT_PROTECTION_PROVIDER: 'recaptcha' })).toThrow();
  });

  it('Turnstile: ส่ง secret/response/remoteip ไป siteverify · success / ไม่ success / action ไม่ตรง / ล่ม', async () => {
    const calls: Array<{ url: string; body: URLSearchParams }> = [];
    const fake =
      (reply: unknown, ok = true) =>
      async (url: string, init: { body: URLSearchParams }) => {
        calls.push({ url, body: init.body });
        if (reply instanceof Error) throw reply;
        return { ok, json: async () => reply };
      };
    const ok = new TurnstileBotProtection('sec', fake({ success: true, action: 'signup' }));
    expect(await ok.verify({ token: 'tk', ip: '1.2.3.4', action: 'signup' })).toEqual({
      ok: true,
    });
    expect(calls[0]!.url).toBe(TURNSTILE_VERIFY_URL);
    expect(Object.fromEntries(calls[0]!.body)).toEqual({
      secret: 'sec',
      response: 'tk',
      remoteip: '1.2.3.4',
    });
    expect(await ok.verify({ token: 'tk', action: 'login' })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(
      await new TurnstileBotProtection('s', fake({ success: false })).verify({
        token: 't',
        action: 'signup',
      }),
    ).toEqual({ ok: false, reason: 'invalid' });
    expect(
      await new TurnstileBotProtection('s', fake(new Error('net'))).verify({
        token: 't',
        action: 'signup',
      }),
    ).toEqual({ ok: false, reason: 'unavailable' });
    expect(
      await new TurnstileBotProtection('s', fake({}, false)).verify({
        token: 't',
        action: 'signup',
      }),
    ).toEqual({ ok: false, reason: 'unavailable' });
    const host = (h: string) =>
      new TurnstileBotProtection(
        's',
        fake({ success: true, hostname: h }),
        undefined,
        'tms.example',
      ).verify({ token: 't', action: 'signup' });
    expect(await host('tms.example')).toEqual({ ok: true });
    expect(await host('evil.example')).toEqual({ ok: false, reason: 'invalid' });
    const n = calls.length;
    expect(
      await new TurnstileBotProtection('s', fake({ success: true })).verify({ action: 'signup' }),
    ).toEqual({ ok: false, reason: 'missing' });
    expect(calls.length).toBe(n); // ไม่มี token = ไม่เรียกออก
  });
});
