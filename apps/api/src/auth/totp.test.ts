import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, verifyTotp } from './totp';

describe('TOTP (RFC 6238)', () => {
  // RFC 6238 ภาคผนวก B: secret ASCII "12345678901234567890", SHA1
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('t=%i → %s', (t, code) => {
    expect(hotp(secret, Math.floor(t / 30))).toBe(code);
  });
  it('base32 ไป-กลับ', () => {
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
  });
  it('ยอม ±1 ช่วง และไม่รับ step ที่ใช้แล้ว', () => {
    const now = 1111111111 * 1000;
    const prev = hotp(secret, Math.floor(1111111111 / 30) - 1);
    const step = verifyTotp(secret, prev, null, now);
    expect(step).toBe(Math.floor(1111111111 / 30) - 1);
    expect(verifyTotp(secret, prev, step, now)).toBeNull();
    expect(verifyTotp(secret, '000000', null, now)).toBeNull();
    expect(verifyTotp(secret, 'abc', null, now)).toBeNull();
  });
});
