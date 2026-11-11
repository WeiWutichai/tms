import { Prisma } from '@prisma/client';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { isRetryableDbError } from './problem.filter';
import { decimalPlaces, IsDecimal } from './validation';

class Km {
  @IsDecimal(1)
  km!: number;
}
const check = (km: unknown) => validateSync(Object.assign(new Km(), { km })).length === 0;

describe('IsDecimal / decimalPlaces (review ST2-T09)', () => {
  it('นับทศนิยมรวมรูปแบบ exponent', () => {
    expect(decimalPlaces(95)).toBe(0);
    expect(decimalPlaces(95.5)).toBe(1);
    expect(decimalPlaces(1e-7)).toBe(7);
    expect(decimalPlaces(1.25e-1)).toBe(3);
    expect(decimalPlaces(1.5e3)).toBe(0);
    expect(decimalPlaces(1e21)).toBe(0);
  });
  it('ไม่ throw กับ exponent / NaN / Infinity / ไม่ใช่ตัวเลข', () => {
    expect(check(95.5)).toBe(true);
    expect(check(1.5e1)).toBe(true);
    expect(check(1e-7)).toBe(false);
    expect(check(10.25)).toBe(false);
    expect(check(NaN)).toBe(false);
    expect(check(Infinity)).toBe(false);
    expect(check('9')).toBe(false);
  });
});

describe('isRetryableDbError', () => {
  it('deadlock / serialization = ลองใหม่ได้', () => {
    const k = (code: string, meta?: Record<string, unknown>) =>
      new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 'x', meta });
    expect(isRetryableDbError(k('P2034'))).toBe(true);
    expect(isRetryableDbError(k('P2010', { code: '40P01', message: 'deadlock detected' }))).toBe(
      true,
    );
    expect(isRetryableDbError(k('P2002'))).toBe(false);
    expect(
      isRetryableDbError(
        new Prisma.PrismaClientUnknownRequestError('ERROR: deadlock detected', {
          clientVersion: 'x',
        }),
      ),
    ).toBe(true);
    expect(isRetryableDbError(Object.assign(new Error('x'), { code: '40001' }))).toBe(true);
    expect(isRetryableDbError(new Error('boom'))).toBe(false);
  });
});
