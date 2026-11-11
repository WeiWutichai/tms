import type { AuditLog } from '@prisma/client';
import { encodeId, type IdKind } from '../common/ids';
import { ProblemException } from '../common/problem';
import type { Tx } from '../db/db.service';

/** entity_type → prefix ของ id ใน API (ตารางที่ไม่มี prefix คืน uuid ตามเดิม) — master ใหม่เพิ่มที่นี่ */
export const AUDIT_ID_KIND: Record<string, IdKind> = {
  company: 'company',
  branch: 'branch',
  document_series: 'sequence',
  user: 'user',
  role: 'role',
  customer: 'customer',
  vehicle_document: 'vehicleDocument',
};

export interface AuditEntryShape {
  id: string;
  at: string;
  actor: { id: string; name: string | null } | null;
  actAs: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  ip: string | null;
  requestId: string | null;
}

export function decodeAuditCursor(c: string): bigint {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as { s: string };
    if (typeof v.s !== 'string' || !/^\d{1,18}$/.test(v.s)) throw new Error();
    return BigInt(v.s);
  } catch {
    throw new ProblemException('validation_failed', undefined, [
      { field: 'cursor', code: 'invalid_cursor', message: 'cursor is invalid' },
    ]);
  }
}

const UUID = /^[0-9a-f-]{36}$/i;

/** แถว audit_log (เรียง seq ใหม่ก่อน, ดึงมา limit+1) → หน้า API + ชื่อผู้ทำ (ใช้ร่วม /audit-logs และ /{master}/{id}/history) */
export async function toAuditPage(
  tx: Tx,
  rows: AuditLog[],
  limit: number,
  opts: { redactNetwork?: boolean } = {},
): Promise<{ data: AuditEntryShape[]; nextCursor: string | null; hasMore: boolean }> {
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const actorIds = [...new Set(page.map((r) => r.actorId).filter((x): x is string => !!x))];
  const users = await tx.appUser.findMany({
    where: { id: { in: actorIds.filter((a) => UUID.test(a)) } },
    select: { id: true, name: true },
  });
  const names = new Map(users.map((u) => [u.id, u.name]));
  const last = page[page.length - 1];
  return {
    data: page.map((r) => ({
      id: encodeId('audit', r.id),
      at: r.at.toISOString(),
      actor: r.actorId
        ? {
            id: UUID.test(r.actorId) ? encodeId('user', r.actorId) : r.actorId,
            name: names.get(r.actorId) ?? null,
          }
        : null,
      actAs: r.actAs,
      action: r.action,
      entityType: r.entityType,
      entityId:
        r.entityId && AUDIT_ID_KIND[r.entityType] && UUID.test(r.entityId)
          ? encodeId(AUDIT_ID_KIND[r.entityType]!, r.entityId)
          : r.entityId,
      before: r.before ?? null,
      after: r.after ?? null,
      reason: r.reason,
      // ip/requestId เป็นข้อมูลของหน้า audit รวม (audit:read) — แท็บประวัติของ master ส่ง null
      ip: opts.redactNetwork ? null : r.ip,
      requestId: opts.redactNetwork ? null : r.requestId,
    })),
    nextCursor:
      hasMore && last
        ? Buffer.from(JSON.stringify({ s: String(last.seq) })).toString('base64url')
        : null,
    hasMore,
  };
}
