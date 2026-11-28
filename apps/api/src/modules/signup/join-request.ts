import type { Prisma, TenantJoinRequest } from '@prisma/client';
import { webBaseUrl } from '../../auth/password-reset.controller';
import { addBusinessDays } from '../../common/business-days';
import { safeName } from '../../common/safe-text';
import { docDate } from '../../common/thai-date';
import type { PrismaService } from '../../db/prisma.service';
import type { EmailService } from '../email/email.service';

/**
 * คำขอเข้าร่วมบริษัทเดิม (P1-ST2-T06; spec/01 PLT-107) — ใช้ร่วมกันโดยหน้าสมัคร (T04), คิว Console และหน้าผู้ใช้ของบริษัท
 * สถานะ: pending_owner (owner ของบริษัทเดิมตัดสิน ≤ 3 วันทำการ) → pending (เข้าคิว Console — เลยกำหนดถือว่าอยู่ในคิวทันที
 * ไม่ต้องรอ job) | info_requested → approved (เชิญเข้าบริษัท) | rejected
 */
export const OPEN_JOIN = ['pending_owner', 'pending', 'info_requested'];

/**
 * T04 "ส่งคำขอเข้าร่วมบริษัท" / "ติดต่อเรา" → แถวคำขอถาวร (ข้อมูล session ถูกลบวันที่ 30) + อีเมลถึง owner ของบริษัทเดิม (join)
 * ส่งซ้ำ = ใช้คำขอเดิม (ติดต่อเราหลังขอเข้าร่วม = เข้าคิวทีมงานทันที)
 */
export async function createJoinRequest(
  db: PrismaService['platform'],
  email: EmailService,
  input: {
    tenantId: string;
    kind: 'join' | 'contact';
    applicantName: string;
    email: string;
    mobile: string | null;
    taxId: string;
    branchCode: string;
    ip: string | null;
    signupSessionId: string;
    locale: string;
  },
  now = new Date(),
): Promise<TenantJoinRequest> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(33::int, hashtext(${input.tenantId + input.email}))`;
    const open = await tx.tenantJoinRequest.findFirst({
      where: { tenantId: input.tenantId, email: input.email, status: { in: OPEN_JOIN } },
    });
    if (open) {
      if (input.kind === 'contact' && open.status === 'pending_owner')
        return tx.tenantJoinRequest.update({
          where: { id: open.id },
          data: { kind: 'contact', status: 'pending' },
        });
      return open;
    }
    const due = input.kind === 'join' ? addBusinessDays(now, 3) : null;
    const row = await tx.tenantJoinRequest.create({
      data: {
        tenantId: input.tenantId,
        kind: input.kind,
        status: input.kind === 'join' ? 'pending_owner' : 'pending',
        applicantName: input.applicantName,
        email: input.email,
        mobile: input.mobile,
        taxId: input.taxId,
        branchCode: input.branchCode,
        ip: input.ip,
        signupSessionId: input.signupSessionId,
        ownerDueAt: due,
        createdAt: now,
      },
    });
    await tx.auditLog.create({
      data: {
        tenantId: input.tenantId,
        actorId: 'system',
        action: 'tenant.join_requested',
        entityType: 'join_request',
        entityId: row.id,
        // ไม่เก็บอีเมลผู้สมัครใน audit (append-only — PDPA) อ้างด้วย entityId
        after: { kind: input.kind, ownerDueAt: due?.toISOString() ?? null },
      },
    });
    if (input.kind === 'join' && due) {
      const t = await tx.tenant.findUniqueOrThrow({ where: { id: input.tenantId } });
      const owners = await ownersOf(tx, input.tenantId);
      await email.enqueueMany(
        tx,
        owners.map((o) => ({
          tenantId: input.tenantId,
          to: o.email,
          template: 'join_request_owner' as const,
          locale: o.locale,
          vars: {
            companyName: safeName(t.name),
            applicantName: safeName(input.applicantName),
            applicantEmail: input.email,
            dueDate: docDate(due, o.locale === 'th' ? 'BE' : 'CE'),
            link: `${webBaseUrl()}/settings?sec=users`,
          },
        })),
      );
    }
    return row;
  });
}

/** คำขอที่อยู่ในคิว Console: pending / info_requested / pending_owner ที่เลยกำหนด owner ตอบแล้ว */
export function inQueue(j: Pick<TenantJoinRequest, 'status' | 'ownerDueAt'>, now: Date): boolean {
  return (
    j.status === 'pending' ||
    j.status === 'info_requested' ||
    (j.status === 'pending_owner' && !!j.ownerDueAt && j.ownerDueAt <= now)
  );
}

/** อีเมลผลคำขอเข้าร่วมถึงผู้สมัคร (ปฏิเสธ / ขอข้อมูลเพิ่ม) — tenantId ของ outbox = บริษัทเดิม */
export async function notifyJoinApplicant(
  tx: Pick<Prisma.TransactionClient, 'emailOutbox' | 'company' | 'tenant'>,
  email: EmailService,
  j: TenantJoinRequest,
  outcome: 'rejected' | 'info_requested',
  reason: string,
) {
  const c = await tx.company.findFirst({
    where: { tenantId: j.tenantId, taxId: j.taxId },
    select: { legalName: true },
  });
  const name = c?.legalName ?? (await tx.tenant.findUnique({ where: { id: j.tenantId } }))?.name;
  await email.enqueue(tx, {
    tenantId: j.tenantId,
    to: j.email,
    template: 'join_request_decision',
    locale: 'th',
    vars: { companyName: safeName(name ?? ''), outcome, reason: safeName(reason, 500) },
  });
}

type OwnerReader = Pick<Prisma.TransactionClient, 'role' | 'userRole' | 'appUser'>;

export async function ownersOf(db: OwnerReader, tenantId: string) {
  return [...(await ownersOfManyAll(db, [tenantId])).values()].flat();
}

/** owner ที่ใช้งานอยู่ (คนแรก) ของแต่ละ tenant = ผู้สมัคร */
export async function ownersOfMany(db: OwnerReader, tenantIds: string[]) {
  const all = await ownersOfManyAll(db, tenantIds);
  return new Map([...all].map(([k, v]) => [k, v[0]!]));
}

async function ownersOfManyAll(db: OwnerReader, tenantIds: string[]) {
  const roles = await db.role.findMany({
    where: { tenantId: { in: tenantIds }, code: 'owner' },
    select: { id: true },
  });
  const links = roles.length
    ? await db.userRole.findMany({ where: { roleId: { in: roles.map((r) => r.id) } } })
    : [];
  const users = links.length
    ? await db.appUser.findMany({
        where: { id: { in: links.map((l) => l.userId) }, status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
        select: { tenantId: true, name: true, email: true, locale: true },
      })
    : [];
  const m = new Map<string, { name: string; email: string; locale: string }[]>();
  for (const u of users) {
    m.set(u.tenantId, [...(m.get(u.tenantId) ?? []), u]);
  }
  return m;
}
