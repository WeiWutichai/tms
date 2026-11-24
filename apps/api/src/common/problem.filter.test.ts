import type { ArgumentsHost } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ProblemFilter } from './problem.filter';

function run(exception: unknown) {
  const out: { status?: number; headers: Record<string, string>; body?: Record<string, unknown> } =
    { headers: {} };
  const res = {
    setHeader: (k: string, v: string) => (out.headers[k.toLowerCase()] = v),
    status(s: number) {
      out.status = s;
      return res;
    },
    type: () => res,
    send: (b: string) => (out.body = JSON.parse(b) as Record<string, unknown>),
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ originalUrl: '/v1/x' }) }),
  } as unknown as ArgumentsHost;
  new ProblemFilter().catch(exception, host);
  return out;
}

const known = (code: string, message: string) =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test' });

describe('ProblemFilter: DB รับงานไม่ทัน', () => {
  it.each([
    ['P2024', 'Timed out fetching a new connection from the connection pool.'],
    ['P2028', 'Transaction API error: Unable to start a transaction in the given time.'],
    ['P2028', 'Transaction already closed: A query cannot be executed on an expired transaction.'],
  ])('%s → 503 service_busy + Retry-After (ไม่ใช่ 429)', (code, msg) => {
    const r = run(known(code, msg));
    expect(r.status).toBe(503);
    expect(r.body?.code).toBe('service_busy');
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('ProblemFilter: log ไม่รั่วค่า argument ของ Prisma (ST9-T13 R2 L-02)', () => {
  it('PrismaClientValidationError / KnownRequestError ที่ไม่รู้จัก → 500 + log เฉพาะชื่อ/รหัส ไม่มีข้อความ', async () => {
    const { Logger } = await import('@nestjs/common');
    const logged: string[] = [];
    const spy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((m: unknown) => void logged.push(String(m)));
    try {
      const secret = 'tax_id_enc: "v1.k1.SECRET-CIPHERTEXT"';
      const v = new Prisma.PrismaClientValidationError(`Invalid invocation:\n{ ${secret} }`, {
        clientVersion: 'test',
      });
      expect(run(v).status).toBe(500);
      const k = known('P2003', `Foreign key failed: ${secret}`);
      expect(run(k).status).toBe(500);
      expect(logged.length).toBe(2);
      for (const l of logged) expect(l).not.toContain('SECRET-CIPHERTEXT');
      expect(logged[0]).toContain('PrismaClientValidationError');
      expect(logged[1]).toContain('P2003');
    } finally {
      spy.mockRestore();
    }
  });

  it('prismaSummary เก็บบรรทัด stack ของ src/ และ dist/ (รันจาก build) ไม่เก็บ node_modules', async () => {
    const { prismaSummary } = await import('./problem.filter');
    const e = known('P2003', 'secret message');
    e.stack = [
      'PrismaClientKnownRequestError: secret message',
      '    at a (/app/node_modules/@prisma/client/runtime.js:1:1)',
      '    at b (/app/apps/api/dist/modules/x.service.js:10:5)',
      '    at c (/repo/apps/api/src/modules/y.service.ts:20:3)',
    ].join('\n');
    const out = prismaSummary(e);
    expect(out).toContain('dist/modules/x.service.js');
    expect(out).toContain('src/modules/y.service.ts');
    expect(out).not.toContain('node_modules');
    expect(out).not.toContain('secret message');
  });
});
