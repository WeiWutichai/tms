import { Writable } from 'node:stream';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FieldCipher } from '../src/common/crypto';
import { createLogger } from '../src/common/logger';
import { api, bootApp, createTenant, platform } from './helpers';

describe('security baseline (ST0-T12)', () => {
  let app: NestExpressApplication;
  const plat = platform();

  beforeAll(async () => {
    app = await bootApp();
  });
  afterAll(async () => {
    await app.close();
    await plat.$disconnect();
  });

  it('security headers ครบ และไม่มี X-Powered-By', async () => {
    const res = await api(app).get('/v1/health');
    expect(res.status).toBe(200);
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('log ไม่มี password/token/authorization', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = createLogger(sink);
    log.info(
      {
        password: 'p@ss',
        user: { token: 'abc123' },
        req: { headers: { authorization: 'Bearer xyz' } },
        apiKey: 'tk_live_x',
      },
      'login',
    );
    const out = lines.join('');
    for (const secret of ['p@ss', 'abc123', 'Bearer xyz', 'tk_live_x'])
      expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  it('AES-256-GCM: ค่าที่เก็บใน DB อ่านตรงไม่ได้ ถอดกลับได้ และหมุน key ได้', async () => {
    const k1 = Buffer.alloc(32, 1).toString('base64');
    const k2 = Buffer.alloc(32, 2).toString('base64');
    const old = new FieldCipher(`k1:${k1}`);
    const plain = '1103700012345';
    const stored = old.encrypt(plain);
    expect(stored).not.toContain(plain);
    expect(stored.startsWith('v1.k1.')).toBe(true);

    // เก็บลง DB จริงแล้วอ่านดิบ — ไม่มีเลขบัตรในฐานข้อมูล
    const t = await createTenant(plat, stored);
    const raw = await plat.$queryRaw<
      { name: string }[]
    >`SELECT name FROM tenant WHERE id = ${t.id}::uuid`;
    expect(raw[0]!.name).not.toContain(plain);

    const rotated = new FieldCipher(`k2:${k2},k1:${k1}`);
    expect(rotated.decrypt(stored)).toBe(plain);
    expect(rotated.needsRotation(stored)).toBe(true);
    const re = rotated.encrypt(plain);
    expect(re.startsWith('v1.k2.')).toBe(true);
    expect(() => new FieldCipher(`k2:${k2}`).decrypt(stored)).toThrow();
    expect(() => old.decrypt(stored.slice(0, -2) + 'AA')).toThrow(); // แก้ ciphertext → ถอดไม่ได้
  });
});
