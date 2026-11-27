import { describe, expect, it } from 'vitest';
import { publicBucketGroup } from './public-rate-limit.middleware';

/** ST9-T13 R2 review — ตัวนับต่อ IP แยกกลุ่ม: ลิงก์สาธารณะ / login Console / คำเชิญ */
describe('publicBucketGroup', () => {
  it('แยกกลุ่มตาม path (ไม่สน query)', () => {
    expect(publicBucketGroup('/v1/public/offers/ml1.x')).toBe('public');
    expect(publicBucketGroup('/v1/platform/auth/login')).toBe('console');
    expect(publicBucketGroup('/v1/platform/auth/step-up?x=1')).toBe('console');
    expect(publicBucketGroup('/v1/auth/invitations/inspect')).toBe('invite');
    expect(publicBucketGroup('/v1/public/x?u=/v1/platform/auth/')).toBe('public');
    // P1-ST2-T08: /v1/auth/* อื่น (login, 2FA, ลืมรหัสผ่าน) = กลุ่ม auth แยกจากคำเชิญ
    expect(publicBucketGroup('/v1/auth/login')).toBe('auth');
    expect(publicBucketGroup('/v1/auth/password/forgot?x=/v1/auth/invitations/')).toBe('auth');
  });
});
