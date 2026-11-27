import type { PlanVersion, Prisma, PrismaClient } from '@prisma/client';

/**
 * แพ็กเกจ (ST1-T18 → P1-ST1-T01) — ข้อมูลจริงอยู่ในฐาน: `plan` + `plan_version` (มีเวอร์ชัน, publish แล้วแก้ไม่ได้) + `plan_entitlement`
 * seed ใน migration 0175 ตาม docs/02 §2 (plan/13 R-06: 4 tier ราคาตั้งต้น — ยังไม่ประกาศ) · ฟีเจอร์ปิดเดือน = isBasic (R-07)
 * ลำดับด้านล่าง = ลำดับจากถูกไปแพง (ใช้หา "แพ็กเกจแรกที่มีฟีเจอร์นี้" — PLT-076) · รหัสเดิม start/std/ent คงไว้ + biz
 */
export const PLANS = [
  { code: 'start', nameTh: 'Starter', nameEn: 'Starter' },
  { code: 'std', nameTh: 'Growth', nameEn: 'Growth' },
  { code: 'biz', nameTh: 'Business', nameEn: 'Business' },
  { code: 'ent', nameTh: 'Enterprise', nameEn: 'Enterprise' },
] as const;

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * เวอร์ชันที่มีผลตอนนี้ของแพ็กเกจ = published ที่เลขเวอร์ชันสูงสุดในกลุ่ม effectiveFrom ≤ now
 * ขอบเขต (review N8): ≤ = รวมวินาทีที่ถึงวันมีผลพอดี · publish บังคับวันมีผลไม่ก่อนเวอร์ชันที่เผยแพร่แล้ว (N1)
 * → เลขเวอร์ชันเรียงตามวันมีผลเสมอ "สูงสุด" จึงเท่ากับ "วันมีผลล่าสุด" · เวลาเทียบกับนาฬิกาเครื่อง API (ไม่ใช่ DB)
 */
export async function currentPlanVersion(db: Db, planCode: string): Promise<PlanVersion | null> {
  return db.planVersion.findFirst({
    where: { planCode, status: 'published', effectiveFrom: { lte: new Date() } },
    orderBy: { version: 'desc' },
  });
}

/** เวอร์ชันที่มีผลตอนนี้ของทุกแพ็กเกจ (planCode → version) */
export async function currentPlanVersions(db: Db): Promise<Map<string, PlanVersion>> {
  const rows = await db.planVersion.findMany({
    where: { status: 'published', effectiveFrom: { lte: new Date() } },
    orderBy: [{ planCode: 'asc' }, { version: 'desc' }],
  });
  const out = new Map<string, PlanVersion>();
  for (const r of rows) if (!out.has(r.planCode)) out.set(r.planCode, r);
  return out;
}

/**
 * ตรวจว่าแคตตาล็อกมาครบ (migration 0175 เป็นผู้ใส่ข้อมูล) — seed/test/perf เรียกก่อนสร้าง tenant
 * ไม่สร้าง/ทับข้อมูลเอง: ราคาและสิทธิ์แก้ได้ทางเวอร์ชันใหม่จาก Platform Console เท่านั้น (PLT-060)
 */
export async function ensurePlanCatalog(db: Db): Promise<void> {
  const cur = await currentPlanVersions(db);
  const missing = PLANS.filter((p) => !cur.has(p.code)).map((p) => p.code);
  if (missing.length)
    throw new Error(
      `แคตตาล็อกแพ็กเกจไม่ครบ (ไม่มีเวอร์ชันที่มีผล: ${missing.join(', ')}) — รัน pnpm --filter @tms/api db:migrate`,
    );
}
