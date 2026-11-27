import type { Prisma } from '@prisma/client';
import { requestContext } from '../common/request-context';

type Writer = Pick<Prisma.TransactionClient, 'platformAuditLog'>;

/**
 * P1-ST4-T06 audit การกระทำของทีม Innovera ที่ไม่ผูก tenant (เชิญ/ปิดทีมงาน, ส่งออก audit) → `platform_audit_log` (append-only)
 * การกระทำกับข้อมูลลูกค้ายังลง audit_log ของ tenant นั้น (actor `platform:<id>`) ตามเดิม — หน้า Audit log ของ Console รวมสองแหล่ง
 * ห้ามใส่ข้อมูลอ่อนไหว (รหัสผ่าน/secret/token) ใน before/after (PLT-127)
 */
export function platformAudit(
  tx: Writer,
  e: {
    action: string;
    entityType: string;
    entityId?: string | null;
    before?: object | null;
    after?: object | null;
    reason?: string | null;
    /** ไม่ส่ง = ทีมงานที่เรียก (requestContext) · null = ระบบ/ผู้รับคำเชิญที่ยังไม่มี session */
    actorId?: string | null;
  },
) {
  const ctx = requestContext.get();
  return tx.platformAuditLog.create({
    data: {
      actorId: e.actorId !== undefined ? e.actorId : (ctx?.platformUser?.id ?? null),
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId ?? null,
      before: (e.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (e.after ?? undefined) as Prisma.InputJsonValue | undefined,
      reason: e.reason ?? null,
      requestId: ctx?.requestId ?? null,
      ip: ctx?.ip ?? null,
    },
  });
}
