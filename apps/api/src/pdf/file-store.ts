import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface StoredFile {
  key: string; // tenantId/sha256.ext
  sha256: string;
  size: number;
}

/**
 * ที่เก็บไฟล์แบบเขียนครั้งเดียว (immutable) — key ผูกกับ sha256 ของเนื้อไฟล์
 * เขียนซ้ำเนื้อเดิม = ได้ key เดิม; ไม่มี API ลบ/เขียนทับ (PDF เอกสารภาษี ณ วันออก — docs/01 §1, J Retention)
 * production: S3-compatible + object lock (plan/02 T-09) — interface เดียวกัน
 */
export interface FileStore {
  put(tenantId: string, data: Buffer, ext: string): Promise<StoredFile>;
  get(key: string): Promise<Buffer>;
}

/** key ของเนื้อไฟล์ (คำนวณก่อนเขียนได้ — ใช้ล็อก key ก่อน put: ST9-T14) */
export function fileKeyFor(tenantId: string, data: Buffer, ext: string): string {
  return `${tenantId}/${createHash('sha256').update(data).digest('hex')}.${ext}`;
}

export class LocalFileStore implements FileStore {
  constructor(private readonly root: string) {}

  async put(tenantId: string, data: Buffer, ext: string): Promise<StoredFile> {
    if (!/^[0-9a-f-]{36}$/.test(tenantId) || !/^[a-z0-9]{1,8}$/.test(ext))
      throw new Error('invalid tenant or ext');
    const sha256 = createHash('sha256').update(data).digest('hex');
    const key = `${tenantId}/${sha256}.${ext}`;
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, data, { flag: 'wx', mode: 0o444 }); // wx = ห้ามทับไฟล์ที่มีอยู่
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const existing = await readFile(path);
      if (createHash('sha256').update(existing).digest('hex') !== sha256)
        throw new Error(`immutable file corrupted: ${key}`);
    }
    return { key, sha256, size: data.length };
  }

  async get(key: string): Promise<Buffer> {
    if (key.includes('..')) throw new Error('invalid key');
    return readFile(join(this.root, key));
  }

  /**
   * ลบไฟล์ — ใช้ได้เฉพาะ retention job (ST9-T14 `RetentionService`) ภายใต้ advisory lock ของ key หลังตรวจแล้วว่าไม่มี stored_document ใดอ้าง key นี้อีก
   * (key ผูกกับเนื้อไฟล์ — เนื้อเดียวกัน 2 แถวใช้ไฟล์เดียวกัน) · ไม่อยู่ใน interface `FileStore` ที่ส่วนอื่นใช้
   * ไม่มีไฟล์ = ไม่ error (ลบซ้ำได้)
   */
  async remove(key: string): Promise<void> {
    if (!/^[0-9a-f-]{36}\/[0-9a-f]{64}\.[a-z0-9]{1,8}$/.test(key)) throw new Error('invalid key');
    await rm(join(this.root, key), { force: true });
  }
}

/** ที่เก็บไฟล์ของระบบ (`FILES_ROOT`) — ใช้ร่วมกับ worker อีเมล (ไฟล์แนบ ST5-T21) โดยไม่ต้อง import controller */
export const defaultFileStore = () =>
  new LocalFileStore(process.env.FILES_ROOT ?? join(process.cwd(), '.data', 'files'));
