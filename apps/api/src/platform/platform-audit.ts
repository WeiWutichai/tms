import type { Prisma } from '@prisma/client';
import { requestContext } from '../common/request-context';

/**
 * audit ของการกระทำระดับแพลตฟอร์มที่ไม่ผูก tenant (P1-ST1-T01/T04 — แพ็กเกจ/ราคา/ค่าตั้งแพลตฟอร์ม, spec/01 PLT-099)
 * ลง `platform_audit_log` (append-only: role platform เพิ่มได้อย่างเดียว) · การกระทำต่อ tenant ใช้ audit_log ของ tenant นั้นตามเดิม
 * ห้ามใส่ข้อมูลลับใน before/after (PLT-127)
 */
export function platformAudit(
  tx: Prisma.TransactionClient,
  a: {
    action: string;
    entityType: string;
    entityId: string;
    reason: string;
    after: unknown;
    before?: unknown;
  },
) {
  const ctx = requestContext.require();
  return tx.platformAuditLog.create({
    data: {
      platformUserId: ctx.platformUser?.id ?? null,
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId,
      before: (a.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: a.after as Prisma.InputJsonValue,
      reason: a.reason,
      requestId: ctx.requestId,
      ip: ctx.ip ?? null,
    },
  });
}
