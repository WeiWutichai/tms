import type { PrismaClient } from '@prisma/client';
import { ROLE_CODES, SYSTEM_ROLES } from '@tms/domain';

/**
 * สร้าง/อัปเดต role มาตรฐาน (A3 + manager) ของ tenant — role ระบบแก้ไม่ได้จาก UI (spec/01 PLT-131)
 * ใช้ใน seed และตอนสร้าง tenant (ST1-T20/T24); รันซ้ำได้ (upsert ตาม tenant + code)
 */
export async function ensureSystemRoles(
  db: Pick<PrismaClient, 'role'>,
  tenantId: string,
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const code of ROLE_CODES) {
    const r = SYSTEM_ROLES[code];
    const row = await db.role.upsert({
      where: { tenantId_code: { tenantId, code } },
      create: {
        tenantId,
        code,
        nameTh: r.th,
        nameEn: r.en,
        permissions: r.permissions,
        isSystem: true,
      },
      update: { nameTh: r.th, nameEn: r.en, permissions: r.permissions, isSystem: true },
    });
    ids[code] = row.id;
  }
  return ids;
}
