import { beforeEach, describe, expect, it, vi } from 'vitest';

const drop = vi.fn();
vi.mock('./auth/session', () => ({ dropAccessToken: () => drop(), getAccessToken: () => 'tok' }));
const { ApiError, unwrap } = await import('./api');

const res = (status: number, code: string) =>
  Promise.resolve({
    error: { type: '', title: '', status, code },
    response: new Response(null, { status }),
  });

describe('unwrap: 401 (ST9-T12 QA Q1)', () => {
  beforeEach(() => drop.mockReset());

  it('รหัส 2FA ผิดตอน step-up (401 invalid_otp) → โยน error แต่ไม่ทิ้ง session', async () => {
    await expect(unwrap(res(401, 'invalid_otp'))).rejects.toBeInstanceOf(ApiError);
    expect(drop).not.toHaveBeenCalled();
  });

  it('401 อื่น (token หมด/ถูกเพิกถอน) → ทิ้ง token', async () => {
    await expect(unwrap(res(401, 'unauthorized'))).rejects.toBeInstanceOf(ApiError);
    expect(drop).toHaveBeenCalledTimes(1);
  });
});
