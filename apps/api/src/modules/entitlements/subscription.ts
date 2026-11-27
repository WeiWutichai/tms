import type { Prisma, PrismaClient, Subscription } from '@prisma/client';
import { readPlatformSetting } from '../../platform/platform-settings.service';
import { currentPlanVersion } from './plan-catalog';

/**
 * Subscription ต่อ tenant (P1-ST1-T01; spec/01 §6) — สร้าง/ย้ายในโค้ดแอปที่เดียว (review S2: ไม่ใช้ trigger)
 * ฐานข้อมูลมีแค่ guard (migration 0177): tenant live ทุกรายต้องมีแถวเมื่อจบ transaction
 * - สร้าง: bootstrapTenant (ขั้น `subscription`) — tenant ใหม่ทุกทาง (Console, createTenantWithDefaults, seed, tenants:bootstrap)
 * - ย้ายแพ็กเกจ: Console `PATCH /v1/platform/tenants/{id}/plan` → เวอร์ชันที่มีผลของแพ็กเกจใหม่
 * - publish เวอร์ชันใหม่ของแพ็กเกจเดิม → ไม่ย้ายใคร (PLT-060)
 * - status ตาม tenant.status (trial หมด/ค้างชำระ/ยกเลิก) = งานของ P1-ST1-T03
 */
type Db = PrismaClient | Prisma.TransactionClient;

const DAY = 864e5;
const BKK = 7 * 3600e3;

/** ต้นเดือนถัดไป 00:00 เวลาไทย (รอบบิลรายเดือนตามปฏิทินไทย) */
export function nextBangkokMonthStart(now: Date): Date {
  const b = new Date(now.getTime() + BKK);
  return new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + 1, 1) - BKK);
}

function statusOf(t: string): string {
  return t === 'TRIAL' ? 'trialing' : t === 'CANCELLED' ? 'cancelled' : 'active';
}

/** สร้างแถวถ้ายังไม่มี (idempotent) · sandbox (mode test) ใช้ของบริษัทจริง — ไม่มีแถวของตัวเอง */
export async function ensureSubscription(db: Db, tenantId: string): Promise<Subscription | null> {
  const t = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { mode: true, planCode: true, status: true },
  });
  if (!t || t.mode !== 'live') return null;
  const cur = await db.subscription.findUnique({ where: { tenantId } });
  if (cur) return cur;
  const v = await currentPlanVersion(db, t.planCode);
  if (!v) throw new Error(`แพ็กเกจ ${t.planCode} ไม่มีเวอร์ชันที่มีผล`);
  // trial ของ tenant ใหม่ = ค่าตั้ง trial.days (ค่าเริ่มต้น 30 — D-43) อ่าน ณ ตอนสร้าง → แก้ค่าภายหลังไม่ย้อนแถวเดิม (PLT-099)
  const days = await readPlatformSetting<number>(db, 'trial.days');
  const now = new Date();
  const trialEndsAt = t.status === 'TRIAL' ? new Date(now.getTime() + days * DAY) : null;
  return db.subscription.create({
    data: {
      tenantId,
      planVersionId: v.id,
      status: statusOf(t.status),
      trialEndsAt,
      currentPeriodStart: now,
      currentPeriodEnd: trialEndsAt ?? nextBangkokMonthStart(now),
    },
  });
}

/** เปลี่ยนแพ็กเกจ → เวอร์ชันที่มีผลของแพ็กเกจใหม่ (ล้างการย้ายที่รอมีผล) · ไม่มีแถว = สร้าง */
export async function moveSubscriptionPlan(db: Db, tenantId: string, planCode: string) {
  const v = await currentPlanVersion(db, planCode);
  if (!v) throw new Error(`แพ็กเกจ ${planCode} ไม่มีเวอร์ชันที่มีผล`);
  const cur = await db.subscription.findUnique({ where: { tenantId } });
  if (!cur) return ensureSubscription(db, tenantId);
  if (cur.planVersionId === v.id) return cur;
  return db.subscription.update({
    where: { tenantId },
    data: { planVersionId: v.id, nextPlanVersionId: null, version: { increment: 1 } },
  });
}
