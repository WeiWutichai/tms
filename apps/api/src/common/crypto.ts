import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { isLocalEnv } from '../auth/tokens';

/**
 * ST9-T13 รอบสุดท้าย (R2-M01): กุญแจตัวอย่างที่เผยแพร่ใน `.env.example` / CI — ใช้ได้เฉพาะ dev/test
 * นอก dev/test (staging/production) ใช้ค่านี้ = ข้อมูลที่เข้ารหัส (เลขบัตร/บัญชี/credential/TOTP) ถอดได้ด้วยค่าที่อยู่ใน repo → ไม่ยอมเริ่ม
 */
export const DEV_FIELD_ENCRYPTION_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
export const DEV_BLIND_INDEX_KEY = 'YmxpbmQtaW5kZXgtZGV2LW9ubHktMDEyMzQ1Njc4OWE=';

/** ค่ากุญแจจาก env ใช้กุญแจตัวอย่างของ repo ไหม (เทียบที่ไบต์ของกุญแจ — base64 คนละรูปแบบก็จับได้) */
export function usesDevKey(spec: string, dev: string): boolean {
  const devKey = Buffer.from(dev, 'base64');
  return spec
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
    .some((e) => {
      const b64 = e.includes(':') ? e.slice(e.indexOf(':') + 1) : e;
      return Buffer.from(b64, 'base64').equals(devKey);
    });
}

/** ตรวจตอนบูต + ตอนสร้างตัวเข้ารหัส: นอก dev/test ห้ามใช้กุญแจตัวอย่าง (fail closed — แบบ API_KEY_PEPPER) */
export function assertNoDevKeys(env: NodeJS.ProcessEnv = process.env, local = isLocalEnv()): void {
  if (local) return;
  if (usesDevKey(env.FIELD_ENCRYPTION_KEYS ?? '', DEV_FIELD_ENCRYPTION_KEY))
    throw new Error('FIELD_ENCRYPTION_KEYS must not use the dev key from .env.example');
  if (usesDevKey(env.BLIND_INDEX_KEY ?? '', DEV_BLIND_INDEX_KEY))
    throw new Error('BLIND_INDEX_KEY must not be the dev key from .env.example');
}

/**
 * เข้ารหัสระดับ field ด้วย AES-256-GCM (ST0-T12) — ใช้กับเลขบัตร/บัญชีธนาคาร/credential ของ connector
 * key ring จาก FIELD_ENCRYPTION_KEYS = "k2:base64,k1:base64" (ตัวแรกใช้เข้ารหัส ตัวอื่นใช้ถอดของเก่า)
 * production: ดึง key จาก KMS แทน env (plan/02 T-08) — รูปแบบ ciphertext ไม่เปลี่ยน
 * รูปแบบ: v1.<keyId>.<iv>.<tag>.<ciphertext> (base64url)
 */
export class FieldCipher {
  private readonly keys = new Map<string, Buffer>();
  private readonly currentId: string;

  constructor(spec = process.env.FIELD_ENCRYPTION_KEYS ?? '') {
    const entries = spec
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const e of entries) {
      const [id, b64] = e.split(':');
      const key = Buffer.from(b64 ?? '', 'base64');
      if (!id || key.length !== 32) throw new Error(`invalid field encryption key '${id}'`);
      this.keys.set(id, key);
    }
    const first = entries[0]?.split(':')[0];
    if (!first) throw new Error('FIELD_ENCRYPTION_KEYS required');
    if (!isLocalEnv() && usesDevKey(spec, DEV_FIELD_ENCRYPTION_KEY))
      throw new Error('FIELD_ENCRYPTION_KEYS must not use the dev key from .env.example');
    this.currentId = first;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.currentId)!, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const parts = [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64url'));
    return ['v1', this.currentId, ...parts].join('.');
  }

  decrypt(value: string): string {
    const [ver, keyId, iv, tag, ct] = value.split('.');
    const key = keyId ? this.keys.get(keyId) : undefined;
    if (ver !== 'v1' || !key || !iv || !tag || ct === undefined)
      throw new Error('cannot decrypt field');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  }

  /** ต้องเข้ารหัสใหม่ด้วย key ปัจจุบันไหม (ใช้ตอนหมุน key) */
  needsRotation(value: string): boolean {
    return value.split('.')[1] !== this.currentId;
  }
}
