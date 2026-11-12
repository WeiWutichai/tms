import { afterEach, describe, expect, it } from 'vitest';
import {
  HttpSmsProvider,
  LineMessagingProvider,
  lineProviderFromEnv,
  maskRecipient,
  MessagingError,
  redactLinks,
  safeError,
  smsProviderFromEnv,
} from './providers';
import { messageName, renderMessage } from './templates';

const env0 = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = env0;
});

describe('เลือกผู้ให้บริการจาก env (ST3-T21)', () => {
  it('dev/test = mock · none = ปิด · production ห้าม mock และค่าเริ่มต้นคือปิด', () => {
    expect(lineProviderFromEnv({})!.name).toBe('mock');
    expect(smsProviderFromEnv({ SMS_PROVIDER: '' })!.name).toBe('mock');
    expect(lineProviderFromEnv({ LINE_PROVIDER: 'none' })).toBeNull();
    expect(lineProviderFromEnv({ LINE_PROVIDER: 'line' })!.name).toBe('line');
    expect(() => lineProviderFromEnv({ LINE_PROVIDER: 'nope' })).toThrow(/unknown LINE_PROVIDER/);
    expect(() => smsProviderFromEnv({ SMS_PROVIDER: 'http' })).toThrow(/SMS_HTTP_URL/);
    process.env.NODE_ENV = 'production';
    expect(lineProviderFromEnv({})).toBeNull();
    expect(smsProviderFromEnv({})).toBeNull();
    expect(() => lineProviderFromEnv({ LINE_PROVIDER: 'mock' })).toThrow(/only allowed/);
    expect(() => smsProviderFromEnv({ SMS_PROVIDER: 'mock' })).toThrow(/only allowed/);
    expect(() =>
      lineProviderFromEnv({ LINE_PROVIDER: 'line', LINE_API_BASE: 'http://x.test' }),
    ).toThrow(/https/);
    expect(() =>
      smsProviderFromEnv({
        SMS_PROVIDER: 'http',
        SMS_HTTP_URL: 'http://x.test',
        SMS_HTTP_TOKEN: 't',
      }),
    ).toThrow(/https/);
    expect(
      smsProviderFromEnv({
        SMS_PROVIDER: 'http',
        SMS_HTTP_URL: 'https://sms.test',
        SMS_HTTP_TOKEN: 't',
      })!.name,
    ).toBe('http');
  });
});

describe('adapter (fetch ปลอม — ไม่เรียกของจริง)', () => {
  it('LINE: ไม่มี token = ล้มแบบไม่ลองซ้ำ · เครือข่ายล่ม = ลองซ้ำได้ · 400 = ไม่ลองซ้ำ', async () => {
    const msg = {
      to: 'U'.padEnd(33, 'a'),
      text: 'x',
      retryKey: '00000000-0000-0000-0000-000000000000',
    };
    const noToken = await new LineMessagingProvider('https://l.test', async () => new Response())
      .send(msg)
      .catch((e: MessagingError) => e);
    expect(noToken).toMatchObject({ code: 'not_configured', retryable: false });
    const down = await new LineMessagingProvider('https://l.test', async () => {
      throw new Error('ECONNREFUSED');
    })
      .send({ ...msg, credentials: { lineToken: 't' } })
      .catch((e: MessagingError) => e);
    expect(down).toMatchObject({ code: 'provider_unavailable', retryable: true });
    const bad = await new LineMessagingProvider(
      'https://l.test',
      async () => new Response('{"message":"invalid to"}', { status: 400 }),
    )
      .send({ ...msg, credentials: { lineToken: 't' } })
      .catch((e: MessagingError) => e);
    expect(bad).toMatchObject({ code: 'provider_rejected', retryable: false });
  });

  it('SMS http: เบอร์เป็น +66, Bearer token, Idempotency-Key = id แถว', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const p = new HttpSmsProvider(
      'https://sms.test/send',
      'secret',
      'SRITHAI',
      async (url, init) => {
        seen = { url, init };
        return new Response('{"id":"sms-1"}', { status: 200 });
      },
    );
    const r = await p.send({ to: '0812345678', text: 'hello', retryKey: 'k-1' });
    expect(r.messageId).toBe('sms-1');
    expect(JSON.parse(String(seen!.init.body))).toEqual({
      to: '+66812345678',
      text: 'hello',
      sender: 'SRITHAI',
    });
    const h = seen!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer secret');
    expect(h['Idempotency-Key']).toBe('k-1');
    const slow = await new HttpSmsProvider('https://sms.test', 't', 's', async () => {
      return new Response('busy', { status: 429 });
    })
      .send({ to: '0812345678', text: 'x', retryKey: 'k' })
      .catch((e: MessagingError) => e);
    expect(slow).toMatchObject({ code: 'provider_unavailable', retryable: true });
  });

  it('ปิดบังผู้รับ + ตัด token ของลิงก์ใน log', () => {
    expect(maskRecipient('LINE', `U${'1'.repeat(32)}`)).toBe('U11•••1111');
    expect(maskRecipient('SMS', '0812345678')).toBe('081•••5678');
    expect(redactLinks('open https://x/link/carrier-docs/ml1.abc.123.sig now')).toBe(
      'open https://x/link/carrier-docs/ml1.••• now',
    );
  });
});

describe('template ข้อความ (ไทย)', () => {
  const v = {
    sender: 'ศรีสมมติขนส่ง',
    recipientName: 'หจก. รถร่วมสมมติ',
    url: 'https://tms.test/link/carrier-docs/ml1.x',
    expiresAt: new Date('2026-11-20T03:14:00Z'),
    yearStyle: 'BE' as const,
  };
  it('LINE: ทักชื่อ + ลิงก์ + วันหมดอายุเวลาไทย พ.ศ. · SMS: ข้อความคงที่ ไม่มีชื่อที่ tenant กรอก', () => {
    expect(renderMessage('carrier_docs_link', 'LINE', 'th', v)).toBe(
      'เรียน หจก. รถร่วมสมมติ\nศรีสมมติขนส่ง ขอให้ส่งเอกสารรถและใบขับขี่ (ประกันภัย พ.ร.บ. ใบขับขี่) ผ่านลิงก์นี้ ไม่ต้องสมัครหรือ login\nhttps://tms.test/link/carrier-docs/ml1.x\nลิงก์ใช้ได้ถึง 20 พฤศจิกายน 2569 10:14 น.',
    );
    expect(renderMessage('job_offer_link', 'SMS', 'th', { ...v, ref: 'JOB-0001' })).toBe(
      'TMS: ข้อเสนองานขนส่ง https://tms.test/link/carrier-docs/ml1.x (ถึง 20 พฤศจิกายน 2569 10:14 น.)',
    );
    expect(renderMessage('carrier_docs_link', 'LINE', 'th', { ...v, yearStyle: 'CE' })).toContain(
      '20 พฤศจิกายน 2026',
    );
    expect(renderMessage('carrier_docs_link', 'SMS', 'en', v)).toContain('until 20 Nov 2026 10:14');
  });
  it('sanitiser: ตัด URL/โดเมนใด ๆ (คำที่มีจุด + ตัวอักษร ≥ 2) และตัวเลขยาว ≥ 6 หลักออกจากชื่อ', () => {
    expect(messageName('โปรโมชั่น https://evil.example/x evil.com bit.ly/a x.zz')).toBe(
      'โปรโมชั่น',
    );
    expect(messageName('โทรด่วน 081-234-5678 หรือ 0812345678 บัญชี 123 456 789')).toBe(
      'โทรด่วน หรือ บัญชี',
    );
    expect(messageName('หจก. รถร่วม 12 ล้อ สาขา 00001')).toBe('หจก. รถร่วม 12 ล้อ สาขา 00001');
    // QA: เลี่ยงด้วยเลขไทย / จุดคั่น / ตัวเต็มความกว้าง / [.] / 。 / ช่องว่างก่อน .tld / @handle
    expect(messageName('โทร ๐๘๑๒๓๔๕๖๗๘ ด่วน')).toBe('โทร ด่วน');
    expect(messageName('โทร 081.234.5678 หรือ 08 1 2 3 4 5 6 7 8')).toBe('โทร หรือ');
    expect(messageName('ｅｖｉｌ．ｃｏｍ ลดราคา')).toBe('ลดราคา');
    expect(messageName('เข้า evil[.]cc หรือ evil。cc หรือ evil .cc หรือ evil dot cc')).toBe(
      'เข้า หรือ หรือ หรือ',
    );
    expect(messageName('แอดไลน์ @promo99 ได้เลย')).toBe('แอดไลน์ ได้เลย');
    // คำต่อท้ายบริษัทไม่ถูกตัด
    expect(messageName('Siam Transport Co., Ltd.')).toBe('Siam Transport Co., Ltd.');
    expect(messageName('Siam Transport Co.Ltd')).toBe('Siam Transport Co.Ltd');
    expect(messageName('Thai Freight Inc. evil.com')).toBe('Thai Freight Inc.');
    const t = renderMessage('carrier_docs_link', 'LINE', 'th', {
      ...v,
      sender: 'โปรโมชั่น evil.co 0899999999',
    });
    expect(t).toContain('\nโปรโมชั่น ขอให้ส่ง');
    expect(t).not.toMatch(/evil|0899999999/);
  });
  it('error ที่เก็บไม่มีตัวเลขยาว/ลิงก์', () => {
    expect(safeError(new Error('to 0812345678 failed ml1.abc.1.x'))).toBe('to ••• failed ml1.•••');
  });
});
