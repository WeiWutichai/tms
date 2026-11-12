import { describe, expect, it } from 'vitest';
import { isSmsMobile } from './useLinkMessages';

describe('isSmsMobile (ST3-T21 — สูตรเดียวกับ API)', () => {
  it('มือถือ 06/08/09 สิบหลัก รวม +66 / ขีด / ช่องว่าง', () => {
    for (const p of ['081-234-5678', '0612345678', '+66 89 111 2233', '+66 089 111 2233'])
      expect(isSmsMobile(p)).toBe(true);
  });
  it('เบอร์บ้าน / สั้น / ว่าง = ส่ง SMS ไม่ได้', () => {
    for (const p of ['02-123-4567', '038123456', '08123', '', null, undefined])
      expect(isSmsMobile(p)).toBe(false);
  });
});
