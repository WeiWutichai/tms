import { afterEach, describe, expect, it } from 'vitest';
import { BlindIndex } from './blind-index';
import {
  assertNoDevKeys,
  DEV_BLIND_INDEX_KEY,
  DEV_FIELD_ENCRYPTION_KEY,
  FieldCipher,
  usesDevKey,
} from './crypto';

/** ST9-T13 รอบสุดท้าย R2-M01 — นอก dev/test ห้ามใช้กุญแจตัวอย่างที่เผยแพร่ใน .env.example / CI */
const OTHER = Buffer.alloc(32, 7).toString('base64');
const env0 = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = env0;
});

describe('dev keys (R2-M01)', () => {
  it('usesDevKey จับกุญแจตัวอย่างทุกตำแหน่งใน key ring (รวมตัวถอดของเก่า) และ base64 รูปแบบอื่น', () => {
    expect(usesDevKey(`k1:${DEV_FIELD_ENCRYPTION_KEY}`, DEV_FIELD_ENCRYPTION_KEY)).toBe(true);
    expect(usesDevKey(`k2:${OTHER},k1:${DEV_FIELD_ENCRYPTION_KEY}`, DEV_FIELD_ENCRYPTION_KEY)).toBe(
      true,
    );
    const noPad = DEV_FIELD_ENCRYPTION_KEY.replace(/=+$/, '');
    expect(usesDevKey(`k1:${noPad}`, DEV_FIELD_ENCRYPTION_KEY)).toBe(true);
    expect(usesDevKey(DEV_BLIND_INDEX_KEY, DEV_BLIND_INDEX_KEY)).toBe(true);
    expect(usesDevKey(`k1:${OTHER}`, DEV_FIELD_ENCRYPTION_KEY)).toBe(false);
    expect(usesDevKey('', DEV_FIELD_ENCRYPTION_KEY)).toBe(false);
  });

  it('assertNoDevKeys: นอก dev/test + กุญแจตัวอย่าง → ไม่ยอมเริ่ม · dev/test หรือกุญแจของตัวเอง → ผ่าน', () => {
    const dev = {
      FIELD_ENCRYPTION_KEYS: `k1:${DEV_FIELD_ENCRYPTION_KEY}`,
      BLIND_INDEX_KEY: DEV_BLIND_INDEX_KEY,
    };
    expect(() => assertNoDevKeys(dev, false)).toThrow(/FIELD_ENCRYPTION_KEYS/);
    expect(() => assertNoDevKeys({ ...dev, FIELD_ENCRYPTION_KEYS: `k1:${OTHER}` }, false)).toThrow(
      /BLIND_INDEX_KEY/,
    );
    expect(() =>
      assertNoDevKeys({ FIELD_ENCRYPTION_KEYS: `k1:${OTHER}`, BLIND_INDEX_KEY: OTHER }, false),
    ).not.toThrow();
    expect(() => assertNoDevKeys(dev, true)).not.toThrow();
  });

  it('FieldCipher / BlindIndex ที่สร้างตอนใช้งาน (worker/สคริปต์) ก็ไม่ยอมใช้กุญแจตัวอย่างนอก dev/test', () => {
    process.env.NODE_ENV = 'production';
    expect(() => new FieldCipher(`k1:${DEV_FIELD_ENCRYPTION_KEY}`)).toThrow(/dev key/);
    expect(() => new BlindIndex(DEV_BLIND_INDEX_KEY)).toThrow(/dev key/);
    expect(
      new FieldCipher(`k1:${OTHER}`).decrypt(new FieldCipher(`k1:${OTHER}`).encrypt('x')),
    ).toBe('x');
    process.env.NODE_ENV = 'test';
    expect(() => new FieldCipher(`k1:${DEV_FIELD_ENCRYPTION_KEY}`)).not.toThrow();
    expect(() => new BlindIndex(DEV_BLIND_INDEX_KEY)).not.toThrow();
  });
});
