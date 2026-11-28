import type { Prisma, TenantJoinRequest } from '@prisma/client';
import { webBaseUrl } from '../../auth/password-reset.controller';
import { addBusinessDays } from '../../common/business-days';
import { safeName } from '../../common/safe-text';
import { ProblemException } from '../../common/problem';
import type { EmailService } from '../email/email.service';

/**
 * คำขอเข้าร่วมบริษัทเดิม (P1-ST2-T06; spec/01 PLT-107) — ใช้ร่วมกันโดยหน้าสมัคร (T04), คิว Console และหน้าผู้ใช้ของบริษัท
 * สถานะ: pending_owner (owner ของบริษัทเดิมตัดสิน ≤ 3 วันทำการ) → pending (เข้าคิว Console — เลยกำหนดถือว่าอยู่ในคิวทันที
 * ไม่ต้องรอ job) | info_requested → approved (เชิญเข้าบริษัท) | rejected
 */
export const OPEN_JOIN = ['pending_owner', 'pending', 'info_requested'];

/** วันเวลาไทยแบบสั้น "2 ธ.ค. 2569 10:00 น." (อีเมล — กำหนดตอบของ owner) */
export function dueText(d: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale === 'th' ? 'th-TH-u-ca-buddhist' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Bangkok',
  }).format(d);
}

/** อีเมลแจ้ง owner ที่ใช้งานอยู่ทุกคนว่ามีคำขอเข้าร่วม (กำหนดตอบ = `due`) */
export async function notifyOwnersOfJoin(
  tx: Prisma.TransactionClient,
  email: EmailService,
  j: Pick<TenantJoinRequest, 'tenantId' | 'applicantName' | 'email'>,
  due: Date,
) {
  const t = await tx.tenant.findUniqueOrThrow({ where: { id: j.tenantId } });
  const owners = await ownersOf(tx, j.tenantId);
  await email.enqueueMany(
    tx,
    owners.map((o) => ({
      tenantId: j.tenantId,
      to: o.email,
      template: 'join_request_owner' as const,
      locale: o.locale,
      vars: {
        companyName: safeName(t.name),
        applicantName: safeName(j.applicantName),
        applicantEmail: j.email,
        dueDate: dueText(due, o.locale),
        link: `${webBaseUrl()}/settings?sec=users`,
      },
    })),
  );
  return owners.length;
}

/**
 * T04 "ส่งคำขอเข้าร่วมบริษัท" / "ติดต่อเรา" → แถวคำขอถาวร (ข้อมูล session ถูกลบวันที่ 30) — เรียกในธุรกรรมเดียวกับการอัปเดต session
 * - บริษัทเดิมถูกยกเลิก/ระงับ → 409 (ไม่รับคำขอ — review S5)
 * - join: อีเมลถึง owner ที่ใช้งานอยู่ (ตัดสินใน 3 วันทำการ) · ไม่มี owner ที่ใช้งานอยู่ = เข้าคิวทีมงานทันที
 * - contact ("ติดต่อเรา"): เข้าคิวทีมงาน — ทีมงานปิดเรื่องหรือส่งต่อ owner เท่านั้น (ไม่เพิ่มคนเข้าบริษัทเอง — review B1)
 * - ส่งซ้ำขณะมีคำขอเปิดอยู่ = คงคำขอเดิม (ติดต่อเราไม่ทับคำขอที่ owner ถืออยู่)
 */
export async function createJoinRequest(
  tx: Prisma.TransactionClient,
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
  },
  now = new Date(),
): Promise<TenantJoinRequest> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(33::int, hashtext(${input.tenantId + input.email}))`;
  const target = await tx.tenant.findUnique({ where: { id: input.tenantId } });
  if (!target || target.status === 'CANCELLED' || target.status === 'SUSPENDED')
    throw new ProblemException('invalid_state_transition');
  const open = await tx.tenantJoinRequest.findFirst({
    where: { tenantId: input.tenantId, email: input.email, status: { in: OPEN_JOIN } },
  });
  if (open) return open;
  const owners = input.kind === 'join' ? await ownersOf(tx, input.tenantId) : [];
  const toOwner = input.kind === 'join' && owners.length > 0;
  const due = toOwner ? addBusinessDays(now, 3) : null;
  const row = await tx.tenantJoinRequest.create({
    data: {
      tenantId: input.tenantId,
      kind: input.kind,
      status: toOwner ? 'pending_owner' : 'pending',
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
      after: { kind: input.kind, status: row.status, ownerDueAt: due?.toISOString() ?? null },
    },
  });
  if (due) await notifyOwnersOfJoin(tx, email, row, due);
  return row;
}

/** คำขอที่อยู่ในคิว Console: pending / info_requested / pending_owner ที่เลยกำหนด owner ตอบแล้ว */
export function inQueue(j: Pick<TenantJoinRequest, 'status' | 'ownerDueAt'>, now: Date): boolean {
  return (
    j.status === 'pending' ||
    j.status === 'info_requested' ||
    (j.status === 'pending_owner' && !!j.ownerDueAt && j.ownerDueAt <= now)
  );
}

/**
 * อีเมลผลคำขอเข้าร่วมถึงผู้สมัคร (ปฏิเสธ / ขอข้อมูลเพิ่ม / ปิดเรื่อง) — tenantId ของ outbox = บริษัทเดิม
 * ภาษา = ภาษาของการสมัคร (session ยังไม่ถูกลบ) ไม่พบ = ไทย
 */
export async function notifyJoinApplicant(
  tx: Pick<Prisma.TransactionClient, 'emailOutbox' | 'company' | 'tenant'> & {
    signupSession?: Prisma.TransactionClient['signupSession'];
  },
  email: EmailService,
  j: TenantJoinRequest,
  outcome: 'rejected' | 'info_requested' | 'closed',
  reason: string,
  /** client platform อ่าน session ได้ · role แอป (owner ปฏิเสธ) อ่านไม่ได้ → ไทย */
  platform = true,
) {
  const s =
    platform && j.signupSessionId && tx.signupSession
      ? await tx.signupSession.findUnique({
          where: { id: j.signupSessionId },
          select: { locale: true },
        })
      : null;
  const c = await tx.company.findFirst({
    where: { tenantId: j.tenantId, taxId: j.taxId },
    select: { legalName: true },
  });
  const name = c?.legalName ?? (await tx.tenant.findUnique({ where: { id: j.tenantId } }))?.name;
  await email.enqueue(tx, {
    tenantId: j.tenantId,
    to: j.email,
    template: 'join_request_decision',
    locale: s?.locale === 'en' ? 'en' : 'th',
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
