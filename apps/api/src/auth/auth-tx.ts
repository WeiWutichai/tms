import type { Prisma, PrismaClient } from '@prisma/client';
import { ProblemException } from '../common/problem';

/**
 * transaction สั้นของขั้นตรวจสิทธิ์ (login จองช่อง / ขั้น 2FA / รับคำเชิญ)
 * - maxWait 5 วิ: เวลารอ connection + เริ่ม transaction (เดิม 2 วิ — เครื่อง/DB โหลดหนัก login ปกติได้ 429)
 * - timeout 10 วิ: เวลาถือ transaction ทั้งหมด
 * - lock_timeout 6 วิ: เวลารอ advisory lock ต่ออีเมล/IP — เกิน = มีคำขออีเมล/IP เดียวกันค้างคิวจำนวนมาก
 *   (ยิงพร้อมกัน) → Postgres 55P03 → Prisma P2010 → ผู้เรียกตอบ 429 `rate_limited` ตามเดิม
 * แยกกันแบบนี้เพื่อให้ "DB ช้า" ได้ 503 `service_busy` ส่วน "ยิงถี่" ยังได้ 429 (กันเดารหัสเหมือนเดิม)
 */
export const AUTH_TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;
const AUTH_LOCK_TIMEOUT = '6s';
/** วินาทีที่บอก client ให้รอก่อนลองใหม่ เมื่อระบบรับงานไม่ทัน */
export const SERVICE_BUSY_RETRY_AFTER = 2;

/**
 * เริ่ม transaction ไม่ได้ทันเวลา = คำขอยังไม่ได้เริ่มทำงานเลย (ปลอดภัยที่จะลองใหม่)
 * - P2024: รอ connection จาก pool เกินเวลา
 * - P2028 "Unable to start a transaction in the given time": เกิน maxWait
 */
export function isTxAcquireTimeout(e: unknown): boolean {
  const { code, message } = (e ?? {}) as { code?: string; message?: string };
  if (code === 'P2024') return true;
  return code === 'P2028' && /unable to start a transaction/i.test(message ?? '');
}

const busy = () =>
  new ProblemException('service_busy', undefined, undefined, {
    retryAfter: SERVICE_BUSY_RETRY_AFTER,
    retryable: true,
  });

/**
 * `$transaction` สำหรับ auth (ใช้แทน `db.$transaction(fn, { maxWait, timeout })` + map P2024/P2028 → 429 แบบเดิม)
 * - เริ่มไม่ทัน → ลองใหม่ 1 ครั้ง (fn ยังไม่ได้ทำงาน); ยังไม่ได้ → 503 `service_busy` + Retry-After
 * - transaction หมดเวลาระหว่างทำงาน (P2028 แบบอื่น — รอ lock ถูกตัดที่ lock_timeout ไปก่อนแล้ว จึงเหลือแต่ DB ช้า) → 503
 * - error อื่น (รวม P2010 lock_timeout จากการรอ advisory lock) ส่งต่อให้ผู้เรียกตัดสินเหมือนเดิม
 */
export async function authTransaction<T>(
  db: Pick<PrismaClient, '$transaction'>,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts: { retryDelayMs?: number } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${AUTH_LOCK_TIMEOUT}'`);
        return fn(tx);
      }, AUTH_TX_OPTIONS);
    } catch (e) {
      if (!isTxAcquireTimeout(e)) {
        if ((e as { code?: string }).code === 'P2028') throw busy();
        throw e;
      }
      if (attempt >= 1) throw busy();
      // jitter เล็กน้อย ไม่ให้คำขอที่ค้างพร้อมกันกลับมาแย่ง connection พร้อมกันอีก
      const delay = opts.retryDelayMs ?? 100 + Math.floor(Math.random() * 200);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
