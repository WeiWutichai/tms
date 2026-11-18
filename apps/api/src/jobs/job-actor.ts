import { scopeAllows } from '@tms/domain';
import { requestContext } from '../common/request-context';
import type { Tx } from '../db/db.service';

/** ผู้สั่งงาน async — เก็บใน payload ของ job ตอนสั่ง แล้วตั้งเป็น request context ตอนรัน (นำเข้า ST1-T19, bulk ST7-T10) */
export interface JobActor {
  actorId: string | null;
  scopes: string[];
  principalType?: string;
  actAs?: string;
  ip?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ผู้สั่งจาก request ปัจจุบัน */
export function requestActor(): JobActor {
  const c = requestContext.get();
  return {
    actorId: c?.actorId && UUID_RE.test(c.actorId) ? c.actorId : null,
    scopes: c?.scopes ?? [],
    ...(c?.principalType ? { principalType: c.principalType } : {}),
    ...(c?.actAs ? { actAs: c.actAs } : {}),
    ...(c?.ip ? { ip: c.ip } : {}),
  };
}

/**
 * ผู้สั่งใน job: scope = ที่ส่งมาตอนสั่ง ∩ สิทธิ์ปัจจุบันของผู้ใช้ (ถูกถอดสิทธิ์ระหว่างรอ = ไม่ได้สิทธิ์นั้นแล้ว)
 * principal ที่ไม่ใช่ผู้ใช้ (token dev/API client) ใช้ scope ตอนสั่ง
 */
export async function resolveJobActor(tx: Tx, p: Partial<JobActor>): Promise<JobActor> {
  let scopes = p.scopes ?? [];
  const actorId = p.actorId ?? null;
  if (actorId && UUID_RE.test(actorId) && (p.principalType ?? 'user') === 'user') {
    const links = await tx.userRole.findMany({ where: { userId: actorId } });
    const roles = links.length
      ? await tx.role.findMany({ where: { id: { in: links.map((l) => l.roleId) } } })
      : [];
    const user = await tx.appUser.findFirst({
      where: { id: actorId, deletedAt: null, status: 'ACTIVE' },
      select: { id: true },
    });
    const current = user ? roles.flatMap((r) => r.permissions) : [];
    scopes = scopes.filter((x) => scopeAllows(current, x));
  }
  return {
    actorId,
    scopes,
    ...(p.principalType ? { principalType: p.principalType } : {}),
    ...(p.actAs ? { actAs: p.actAs } : {}),
    ...(p.ip ? { ip: p.ip } : {}),
  };
}
