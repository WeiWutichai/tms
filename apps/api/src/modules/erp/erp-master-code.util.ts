import { Prisma } from '@prisma/client';
import { ProblemException } from '../../common/problem';
import type { Tx } from '../../db/db.service';

/** ตัวช่วยของผังรหัส ERP (ST7-T18) — แยกไฟล์ให้ service และ import spec ใช้ร่วมกันโดยไม่ import วนกัน */
export function chunks<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

/** ซิงก์/นำเข้าผังรหัสของ (connector, ชนิด) เดียวกันทีละรายการ — ปลดเมื่อจบ transaction */
export async function lockKind(tx: Tx, connectorId: string, kind: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`erp_master_code:${connectorId}`}), hashtext(${kind}))`;
}

/** unique ชนที่หลุดล็อก (เช่น แถวที่สร้างนอกทางนี้) → 409 ลองใหม่ได้ แทน 500 */
export function rethrowUniqueAsConflict(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
    throw new ProblemException('concurrent_update');
  throw e;
}
