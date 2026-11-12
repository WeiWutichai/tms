import type { ArgumentsHost } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
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
