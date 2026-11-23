import {
  WEBHOOK_AUTO_DISABLE_AFTER,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_SCHEDULE_MIN,
} from '@tms/domain';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateWebhookSecret,
  signatureHeader,
  signPayload,
  verifyWebhookSignature,
} from './signature';
import { checkUrlShape, isBlockedAddress, resolvePublic, SsrfBlockedError } from './ssrf';
import { classifySend, truncate, webhookRetryDelayMs } from './webhook-engine';
import { echoes } from './webhook.sink';

/** ST7-T04 ส่วนที่ไม่แตะฐานข้อมูล: ลายเซ็น, กัน SSRF, จัดประเภทผลส่ง, ตาราง retry */
describe('webhook — ลายเซ็น (INT-102)', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'order.created' });
  const secret = 'whsec_test_secret_0123456789abcdef';

  it('secret ใหม่ whsec_ + 32 ตัว ไม่ซ้ำ', () => {
    const a = generateWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{32}$/);
    expect(generateWebhookSecret()).not.toBe(a);
  });

  it('v1 = HMAC-SHA256(secret, `t.rawBody`) hex — ผู้รับคำนวณเองแล้วตรง', () => {
    const t = 1_762_226_640;
    const mine = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    expect(signPayload(secret, t, body)).toBe(mine);
    expect(signatureHeader(t, body, [secret])).toBe(`t=${t},v1=${mine}`);
    expect(
      verifyWebhookSignature({ secret, header: `t=${t},v1=${mine}`, rawBody: body, nowSec: t }),
    ).toEqual({ ok: true, t });
  });

  it('หมุน secret: header มี v1 2 ตัว — ผู้รับที่ถือ secret ใหม่หรือเดิมตรวจผ่านทั้งคู่ · secret อื่นไม่ผ่าน', () => {
    const t = 1_762_226_640;
    const fresh = 'whsec_new_secret_aaaaaaaaaaaaaaaaaaaa';
    const h = signatureHeader(t, body, [fresh, secret]);
    expect(h.split(',').filter((p) => p.startsWith('v1='))).toHaveLength(2);
    for (const s of [fresh, secret])
      expect(verifyWebhookSignature({ secret: s, header: h, rawBody: body, nowSec: t }).ok).toBe(
        true,
      );
    expect(
      verifyWebhookSignature({ secret: 'whsec_other', header: h, rawBody: body, nowSec: t }),
    ).toEqual({
      ok: false,
      reason: 'no_matching_signature',
    });
  });

  it('tolerance 5 นาที: |now − t| > 300 วิ ถูกปฏิเสธ (กัน replay) · body ถูกแก้ = ไม่ผ่าน · header เสีย = malformed', () => {
    const t = 1_762_226_640;
    const h = signatureHeader(t, body, [secret]);
    expect(verifyWebhookSignature({ secret, header: h, rawBody: body, nowSec: t + 300 }).ok).toBe(
      true,
    );
    expect(verifyWebhookSignature({ secret, header: h, rawBody: body, nowSec: t - 300 }).ok).toBe(
      true,
    );
    expect(verifyWebhookSignature({ secret, header: h, rawBody: body, nowSec: t + 301 })).toEqual({
      ok: false,
      reason: 'timestamp_out_of_tolerance',
    });
    expect(verifyWebhookSignature({ secret, header: h, rawBody: `${body} `, nowSec: t }).ok).toBe(
      false,
    );
    expect(verifyWebhookSignature({ secret, header: 'v1=abc', rawBody: body, nowSec: t })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyWebhookSignature({ secret, header: undefined, rawBody: body }).ok).toBe(false);
  });
});

describe('webhook — กัน SSRF', () => {
  it.each([
    '127.0.0.1',
    '127.255.0.9',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.10',
    '169.254.169.254', // metadata AWS/GCP/Azure
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00:ec2::254', // metadata AWS IPv6
    'fc00::1',
    '::ffff:127.0.0.1', // IPv4-mapped
    '::ffff:a9fe:a9fe', // mapped 169.254.169.254 (hex)
    '64:ff9b::a9fe:a9fe', // NAT64
    '2002:7f00:1::', // 6to4 ของ 127.0.0.1
    '::ffff:0:7f00:1', // IPv4-translated (SIIT) ของ 127.0.0.1
  ])('ปิด %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '203.150.12.5', '2606:4700:4700::1111'])('เปิด %s', (ip) =>
    expect(isBlockedAddress(ip)).toBe(false),
  );

  it('รูปแบบ URL: https (http เฉพาะ dev/test) · ห้าม user:pass · ห้าม IP/ชื่อภายใน', () => {
    const o = { allowPrivate: false };
    expect(checkUrlShape('https://erp.example.co.th/hook', o)).toBeNull();
    expect(checkUrlShape('http://erp.example.co.th/hook', o)).toBeNull(); // NODE_ENV=test
    expect(checkUrlShape('ftp://x.example.com', o)?.code).toBe('https_required');
    expect(checkUrlShape('not a url', o)?.code).toBe('invalid_url');
    expect(checkUrlShape('https://u:p@erp.example.com', o)?.code).toBe('credentials_in_url');
    for (const u of [
      'https://127.0.0.1/x',
      'https://10.0.0.8/x',
      'http://169.254.169.254/latest/meta-data/',
      'https://[::1]:8443/',
      'https://[fd00:ec2::254]/',
      'https://localhost/x',
      'https://metadata.google.internal/',
      'https://printer.local/',
      'https://intranet/',
    ])
      expect(checkUrlShape(u, o)?.code, u).toBe('url_not_allowed');
    expect(checkUrlShape('http://127.0.0.1:9000/x', { allowPrivate: true })).toBeNull();
    // ช่องว่าง/อักขระควบคุม (new URL จะตัด/encode เงียบ ๆ)
    for (const u of [
      'https://hooks.example.com/a b',
      'https://hooks.example.com/\tx',
      ' https://hooks.example.com/x',
      'https://hooks.example.com/x\u200b',
    ])
      expect(checkUrlShape(u, o)?.code, JSON.stringify(u)).toBe('invalid_url');
    // พอร์ต: < 1024 ยกเว้น 80/443 ปิด (แม้ปลายทางในเครื่องที่อนุญาต)
    for (const p of [22, 25, 6379 - 6000, 1023])
      expect(checkUrlShape(`https://hooks.example.com:${p}/x`, o)?.code, String(p)).toBe(
        'port_not_allowed',
      );
    expect(checkUrlShape('http://127.0.0.1:25/x', { allowPrivate: true })?.code).toBe(
      'port_not_allowed',
    );
    for (const p of [80, 443, 1024, 8080, 8443, 65535])
      expect(checkUrlShape(`https://hooks.example.com:${p}/x`, o), String(p)).toBeNull();
  });

  it('production: http ไม่ได้', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(checkUrlShape('http://erp.example.com/hook', { allowPrivate: false })?.code).toBe(
        'https_required',
      );
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('DNS: มี address ภายในแม้ตัวเดียว = ปิด (round-robin / rebinding) · public ล้วน = ผ่าน', async () => {
    const r = (ips: string[]) => async () =>
      ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    await expect(
      resolvePublic('hooks.example.com', r(['93.184.216.34']), false),
    ).resolves.toHaveLength(1);
    await expect(
      resolvePublic('hooks.example.com', r(['93.184.216.34', '10.0.0.7']), false),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(resolvePublic('hooks.example.com', r(['169.254.169.254']), false)).rejects.toThrow(
      /blocked/,
    );
    // literal IP ไม่ resolve
    await expect(resolvePublic('127.0.0.1', r([]), false)).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});

describe('webhook — ผลส่ง + ตาราง retry (INT-103, docs/04 G1)', () => {
  const r = (
    status: number | null,
    errorCode?: 'timeout' | 'network' | 'ssrf_blocked' | 'invalid_url',
  ) => ({
    status,
    body: '',
    durationMs: 1,
    ...(errorCode ? { errorCode } : {}),
  });

  it('D68-48: 2xx สำเร็จ · ทุกผลที่ไม่ใช่ 2xx ลองใหม่ (รวม 3xx/4xx) · ไม่ลองใหม่เฉพาะ 410 / SSRF / URL เสีย', () => {
    expect(classifySend(r(200))).toEqual({ ok: true, retryable: false, errorCode: null });
    expect(classifySend(r(204)).ok).toBe(true);
    for (const s of [400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503])
      expect(classifySend(r(s)).retryable, String(s)).toBe(true);
    expect(classifySend(r(410))).toEqual({ ok: false, retryable: false, errorCode: 'http_status' });
    expect(classifySend(r(302))).toEqual({ ok: false, retryable: true, errorCode: 'redirect' });
    expect(classifySend(r(301)).retryable).toBe(true);
    expect(classifySend(r(null, 'invalid_url'))).toEqual({
      ok: false,
      retryable: false,
      errorCode: 'invalid_url',
    });
    expect(classifySend(r(null, 'timeout'))).toEqual({
      ok: false,
      retryable: true,
      errorCode: 'timeout',
    });
    expect(classifySend(r(null, 'network')).retryable).toBe(true);
    expect(classifySend(r(null, 'ssrf_blocked'))).toEqual({
      ok: false,
      retryable: false,
      errorCode: 'ssrf_blocked',
    });
  });

  it('8 retry: 1m, 5m, 30m, 2h, 6h, 12h, 24h, 24h (±10%) · รวม 9 ครั้ง · ปิดอัตโนมัติที่ 50 event', () => {
    expect(WEBHOOK_RETRY_SCHEDULE_MIN).toEqual([1, 5, 30, 120, 360, 720, 1440, 1440]);
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(9);
    expect(WEBHOOK_AUTO_DISABLE_AFTER).toBe(50);
    WEBHOOK_RETRY_SCHEDULE_MIN.forEach((m, i) => {
      const ms = webhookRetryDelayMs(i + 1);
      expect(ms).toBeGreaterThanOrEqual(m * 60_000 * 0.9 - 1);
      expect(ms).toBeLessThanOrEqual(m * 60_000 * 1.1 + 1);
    });
  });

  it('invalid_request (ประกอบคำขอไม่ได้) ไม่ลองใหม่ · aborted ไม่ใช่ผลของปลายทาง', () => {
    expect(classifySend(r(null, 'invalid_request' as never))).toEqual({
      ok: false,
      retryable: false,
      errorCode: 'invalid_request',
    });
  });

  it('เก็บ response ตัดที่ 4096 byte (UTF-8) ไม่ตัดกลางอักขระไทย', () => {
    const th = 'ก'.repeat(3000); // 3 byte ต่อตัว
    const out = truncate(th);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(out)).toBeGreaterThan(4090);
    expect(out).toBe('ก'.repeat(out.length));
    expect(truncate('abc')).toBe('abc');
  });

  it('verification: body = challenge หรือ JSON {challenge}', () => {
    expect(echoes('abc', 'abc')).toBe(true);
    expect(echoes(' {"challenge":"abc"} ', 'abc')).toBe(true);
    expect(echoes('{"challenge":"x"}', 'abc')).toBe(false);
    expect(echoes('ok', 'abc')).toBe(false);
  });
});
