import type { Prisma } from '@prisma/client';
import { requestContext } from '../common/request-context';

type Writer = Pick<Prisma.TransactionClient, 'platformAuditLog'>;

/**
 * audit ของการกระทำระดับแพลตฟอร์มที่ไม่ผูก tenant → `platform_audit_log` (append-only: role platform เพิ่มได้อย่างเดียว
 * + trigger `platform_audit_log_append_only` — migration 0188)
 * - P1-ST1-T01/T04 แพ็กเกจ/ราคา/ค่าตั้งแพลตฟอร์ม (spec/01 PLT-099)
 * - P1-ST4-T06 เชิญ/ปิดทีมงาน, รับคำเชิญ, ส่งออก audit
 * การกระทำต่อ tenant ใช้ audit_log ของ tenant นั้นตามเดิม (actor `platform:<id>`) — หน้า Audit log ของ Console รวมสองแหล่ง
 * ห้ามใส่ข้อมูลลับใน before/after (PLT-127)
 */
export function platformAudit(
  tx: Writer,
  a: {
    action: string;
    entityType: string;
    entityId?: string | null;
    reason?: string | null;
    after?: unknown;
    before?: unknown;
    /** ไม่ส่ง = ทีมงานที่เรียก (requestContext) · null/ระบุ = ผู้รับคำเชิญที่ยังไม่มี session ฯลฯ */
    platformUserId?: string | null;
  },
) {
  const ctx = requestContext.get();
  return tx.platformAuditLog.create({
    data: {
      platformUserId:
        a.platformUserId !== undefined ? a.platformUserId : (ctx?.platformUser?.id ?? null),
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId ?? null,
      before: (a.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (a.after ?? undefined) as Prisma.InputJsonValue | undefined,
      reason: a.reason ?? null,
      requestId: ctx?.requestId ?? null,
      ip: ctx?.ip ?? null,
    },
  });
}
