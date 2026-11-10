import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

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
