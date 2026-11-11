import { createHmac } from 'node:crypto';

/**
 * blind index (HMAC-SHA256) ของค่าลับที่ต้องตรวจซ้ำได้ (ST2-T05: เลขบัตรประชาชนของรถร่วมบุคคลธรรมดา)
 * key แยกจาก FieldCipher — BLIND_INDEX_KEY (base64 32 byte) · production: เก็บใน KMS/secret manager แบบเดียวกับ key เข้ารหัส
 * ค่าที่เก็บ = `v1:<hex>` (เปลี่ยน key = ต้องคำนวณใหม่ทั้งตาราง — ระบุ version ไว้หน้าค่า)
 */
export class BlindIndex {
  private readonly key: Buffer;

  constructor(spec = process.env.BLIND_INDEX_KEY ?? '') {
    const key = Buffer.from(spec, 'base64');
    if (key.length !== 32) throw new Error('BLIND_INDEX_KEY required (base64, 32 bytes)');
    this.key = key;
  }

  /** ค่าเดียวกัน (ตัดช่องว่าง/ขีด) → hash เดียวกัน */
  of(value: string): string {
    const norm = value.replace(/[\s-]/g, '');
    return `v1:${createHmac('sha256', this.key).update(norm).digest('hex')}`;
  }
}
