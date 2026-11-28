import { Injectable } from '@nestjs/common';
import type { Prisma, Tenant, TenantJoinRequest } from '@prisma/client';
import { ensureSystemRoles } from '../../auth/system-roles';
import { addBusinessDays } from '../../common/business-days';
import { encodeId } from '../../common/ids';
import { iEquals } from '../../common/ilike';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { safeName } from '../../common/safe-text';
import { PrismaService } from '../../db/prisma.service';
import { readPlatformSetting } from '../../platform/platform-settings.service';
import { EmailService } from '../email/email.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { TenantLifecycleService } from '../tenants/tenant-lifecycle.service';
import { issueInvitation } from '../users/invitations.controller';
import type { CompanyAddress, RegistryCompany } from './company-lookup/types';
import { normalizeCompanyName } from './signup-company.service';
import { inQueue, notifyJoinApplicant, ownersOfMany } from './join-request';
import { branchAddressOf } from './signup-complete.service';

/**
 * คิวอนุมัติการสมัคร (P1-ST2-T06; spec/01 §10.3 PLT-105–107, §11.4; plan/13 R-02, R-08)
 *
 * รายการในคิว 2 แบบ:
 * - `signup` — tenant สถานะ `pending_verification` (ตรวจอัตโนมัติไม่ผ่าน / นโยบายให้ทีมตรวจทุกราย — T05)
 * - `join` / `contact` — คำขอเข้าร่วมบริษัทเดิม (T04): join ส่ง owner ของบริษัทเดิมก่อน ไม่ตอบใน 3 วันทำการ → เข้าคิว (PLT-107)
 *   · contact ("ติดต่อเรา") เข้าคิวทันที
 * เรียงตามเวลารอ (นานสุดก่อน) · เกิน SLA 1 วันทำการ = `overSla` (แถวสีรอ) · ขอข้อมูลเพิ่มแล้ว = รอผู้สมัคร ไม่นับ SLA
 *
 * เทียบ "ที่กรอก | RD | DBD": ชื่อ ที่อยู่ สาขา (ไฮไลต์ช่องที่ต่าง) + สถานะกิจการ วันจด VAT TSIC
 * DBD ไม่มี API ที่ใช้ production ได้ (R-08) → คอลัมน์ DBD = ไม่พบ/เรียกไม่สำเร็จ + ลิงก์ค้นด้วยมือ (spec ข้อ 8)
 *
 * ตัดสิน (owner / support ของ Console — §11.4; sales ยังไม่มีบทบาทใน Console): เหตุผล ≥ 10 ตัวทุกการกระทำ (CLAUDE.md "อนุมัติ" + PLT-105)
 * - signup อนุมัติ → `trialing` (trialEndsAt คงเดิม) · PLT-106 เลือกแก้ชื่อ/ที่อยู่ให้ตรง RD ได้ในขั้นเดียวกัน
 * - signup ปฏิเสธ → `cancelled` (อีเมลแจ้งเหตุผลผ่านบริการสถานะ) · ขอข้อมูลเพิ่ม → คงสถานะ + อีเมลถึงผู้สมัคร
 * - join อนุมัติ → เชิญผู้สมัครเข้าบริษัทเดิม (บทบาท viewer — owner ปรับได้) · ปฏิเสธ/ขอข้อมูลเพิ่ม → อีเมลถึงผู้สมัคร
 * - ทุกการตัดสิน: audit_log ของ tenant (actor `platform:<id>`) + event `verification.*` (signup)
 *
 * [DECISION — lead 28 พ.ย. 2569, ย้อนได้]
 * - ผู้สมัครตอบ "ขอข้อมูลเพิ่ม" ทางอีเมล (ตอบกลับ) — ยังไม่มีหน้าตอบในแอป/ต้นแบบ · ทีมอนุมัติ/ปฏิเสธต่อจากสถานะ info_requested ได้เลย
 * - วันทำการ = จันทร์–ศุกร์ (ยังไม่มีปฏิทินวันหยุด — [OPEN — PO])
 * - join อนุมัติโดยทีมงาน = บทบาท viewer (สิทธิ์น้อยสุด) · owner ของบริษัทเปลี่ยนบทบาทภายหลัง
 */

export type QueueKind = 'signup' | 'join' | 'contact';
export type QueueCheck = 'duplicate' | 'not_found' | 'mismatch' | 'match';
export type RdStatus = 'found' | 'tin_only' | 'not_found' | 'unavailable';

export interface QueueItem {
  id: string;
  kind: QueueKind;
  name: string;
  taxId: string | null;
  branchCode: string | null;
  applicantName: string | null;
  applicantEmail: string | null;
  fleetSizeOwn: number | null;
  fleetSizeSubcon: number | null;
  check: QueueCheck;
  status: 'pending' | 'info_requested';
  flags: string[];
  submittedAt: string;
  waitingSince: string;
  overSla: boolean;
}

export interface CompareRow {
  field: 'name' | 'address' | 'branch' | 'businessStatus' | 'vatRegisteredSince' | 'tsic';
  entered: string | null;
  rd: string | null;
  dbd: string | null;
  differs: boolean;
}

export interface QueueHistoryRow {
  kind: 'tenant' | 'join' | 'session';
  name: string;
  status: string;
  match: 'ip' | 'email' | 'both';
  at: string;
}

export interface QueueDetail extends QueueItem {
  rdStatus: RdStatus;
  compare: CompareRow[];
  certificate: { filename: string | null; mimeType: string; sizeBytes: number } | null;
  duplicate: { tenantId: string; name: string; status: string } | null;
  history: QueueHistoryRow[];
  accountingSoftware: string | null;
  planCode: string | null;
  ownerDueAt: string | null;
  verification: {
    status: string;
    reason: string | null;
    decidedByName: string | null;
    decidedAt: string | null;
  } | null;
}

const branchLabelOf = (code: string) => (code === '00000' ? 'สำนักงานใหญ่' : `สาขาที่ ${code}`);

/** ที่อยู่สาขา (branch.address — ภ.พ.20) → บรรทัดเดียว */
function addressLine(a: unknown): string | null {
  if (!a || typeof a !== 'object') return null;
  const x = a as Record<string, unknown>;
  const s = ['line1', 'subdistrict', 'district', 'province', 'postcode']
    .map((k) => (typeof x[k] === 'string' ? (x[k] as string).trim() : ''))
    .filter(Boolean)
    .join(' ');
  return s || null;
}
const norm = (v: string) => v.replace(/[\s.,]/g, '').toLowerCase();

interface SignupFacts {
  tenant: Tenant;
  company: { legalName: string; taxId: string } | null;
  branch: { id: string; branchCode: string; address: unknown } | null;
  signup: Prisma.TenantSignupGetPayload<object> | null;
  verification: Prisma.TenantVerificationGetPayload<object> | null;
  rd: RegistryCompany | null;
  rdStatus: RdStatus;
  owner: { name: string; email: string; locale: string } | null;
  duplicate: { tenantId: string; name: string; status: string } | null;
}

@Injectable()
export class SignupQueueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: TenantLifecycleService,
    private readonly email: EmailService,
    private readonly entitlements: EntitlementService,
  ) {}

  private get db() {
    return this.prisma.platform;
  }

  // ───────────────────────── อ่าน ─────────────────────────

  async list(now = new Date()): Promise<{ policy: string; items: QueueItem[] }> {
    const policy = await readPlatformSetting<string>(this.db, 'signup.approvalPolicy');
    const tenants = await this.db.tenant.findMany({
      where: { status: 'PENDING_VERIFICATION', mode: 'live' },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    const facts = await this.signupFacts(tenants);
    const joins = await this.db.tenantJoinRequest.findMany({
      where: {
        OR: [
          { status: { in: ['pending', 'info_requested'] } },
          { status: 'pending_owner', ownerDueAt: { lte: now } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    const targets = await this.targetNames(joins.map((j) => j.tenantId));
    const items = [
      ...facts.map((f) => this.signupItem(f, now)),
      ...joins.map((j) => this.joinItem(j, targets.get(j.tenantId) ?? '', now)),
    ].sort((a, b) => a.waitingSince.localeCompare(b.waitingSince));
    return { policy, items };
  }

  async detail(id: string, now = new Date()): Promise<QueueDetail> {
    const ref = this.parse(id);
    if (ref.kind === 'tenant') {
      const t = await this.pendingTenant(ref.id);
      const [f] = await this.signupFacts([t]);
      const item = this.signupItem(f!, now);
      const cert = f!.signup?.certificateDocumentId
        ? await this.db.storedDocument.findFirst({
            where: { id: f!.signup.certificateDocumentId, tenantId: t.id, status: 'READY' },
          })
        : null;
      const deciders = f!.verification?.decidedBy
        ? await this.db.platformUser.findUnique({
            where: { id: f!.verification.decidedBy },
            select: { name: true },
          })
        : null;
      return {
        ...item,
        rdStatus: f!.rdStatus,
        compare: this.compare(f!),
        certificate: cert
          ? { filename: cert.filename, mimeType: cert.mimeType, sizeBytes: cert.sizeBytes }
          : null,
        duplicate: f!.duplicate,
        history: await this.history({
          ip: f!.signup?.termsAcceptedIp ?? null,
          email: f!.owner?.email ?? null,
          excludeTenantId: t.id,
          excludeSessionId: f!.signup?.signupSessionId ?? null,
        }),
        accountingSoftware: f!.signup?.accountingSoftware ?? null,
        planCode: f!.signup?.planCode ?? t.planCode,
        ownerDueAt: null,
        verification: f!.verification
          ? {
              status: f!.verification.status,
              reason: f!.verification.reason,
              decidedByName: deciders?.name ?? null,
              decidedAt: f!.verification.decidedAt?.toISOString() ?? null,
            }
          : null,
      };
    }
    const j = await this.openJoin(ref.id, now);
    const target = await this.db.tenant.findUniqueOrThrow({ where: { id: j.tenantId } });
    const company = await this.db.company.findFirst({
      where: { tenantId: j.tenantId, taxId: j.taxId },
      orderBy: { createdAt: 'asc' },
    });
    const branch = company
      ? await this.db.branch.findFirst({
          where: { tenantId: j.tenantId, companyId: company.id, branchCode: j.branchCode },
        })
      : null;
    const decider =
      j.decidedBy && j.decidedByType === 'platform_user'
        ? await this.db.platformUser.findUnique({
            where: { id: j.decidedBy },
            select: { name: true },
          })
        : null;
    const item = this.joinItem(j, company?.legalName ?? target.name, now);
    return {
      ...item,
      rdStatus: 'unavailable',
      // คำขอเข้าร่วม: "ที่กรอก" = เลข/สาขาที่ผู้สมัครค้น · ข้อมูลบริษัทเดิมในระบบแสดงคู่กัน (ไม่ค้น RD ซ้ำ)
      compare: [
        {
          field: 'name',
          entered: company?.legalName ?? target.name,
          rd: null,
          dbd: null,
          differs: false,
        },
        {
          field: 'address',
          entered: addressLine(branch?.address),
          rd: null,
          dbd: null,
          differs: false,
        },
        {
          field: 'branch',
          entered: branchLabelOf(j.branchCode),
          rd: null,
          dbd: null,
          differs: false,
        },
        { field: 'businessStatus', entered: null, rd: null, dbd: null, differs: false },
        { field: 'vatRegisteredSince', entered: null, rd: null, dbd: null, differs: false },
        { field: 'tsic', entered: null, rd: null, dbd: null, differs: false },
      ],
      certificate: null,
      duplicate: {
        tenantId: encodeId('tenant', target.id),
        name: company?.legalName ?? target.name,
        status: target.status.toLowerCase(),
      },
      history: await this.history({
        ip: j.ip,
        email: j.email,
        excludeJoinId: j.id,
        excludeSessionId: j.signupSessionId,
      }),
      accountingSoftware: null,
      planCode: null,
      ownerDueAt: j.ownerDueAt?.toISOString() ?? null,
      verification:
        j.status === 'info_requested'
          ? {
              status: j.status,
              reason: j.reason,
              decidedByName: decider?.name ?? null,
              decidedAt: j.decidedAt?.toISOString() ?? null,
            }
          : null,
    };
  }

  /** ไฟล์หนังสือรับรองของรายการ signup (stored_document ของ tenant) */
  async certificate(id: string) {
    const ref = this.parse(id);
    if (ref.kind !== 'tenant') throw new ProblemException('not_found');
    const t = await this.pendingTenant(ref.id);
    const s = await this.db.tenantSignup.findUnique({ where: { tenantId: t.id } });
    const doc = s?.certificateDocumentId
      ? await this.db.storedDocument.findFirst({
          where: { id: s.certificateDocumentId, tenantId: t.id, status: 'READY' },
        })
      : null;
    if (!doc?.fileKey) throw new ProblemException('not_found');
    return doc;
  }

  // ───────────────────────── ตัดสิน ─────────────────────────

  async approve(id: string, body: { reason: string; applyOfficialData?: boolean }) {
    const ref = this.parse(id);
    if (ref.kind === 'join') return this.approveJoin(ref.id, body.reason);
    const t = await this.pendingTenant(ref.id);
    const [f] = await this.signupFacts([t]);
    const compare = this.compare(f!);
    const diff = compare.filter((c) => c.differs).map((c) => c.field);
    const staff = this.staffId();
    if (body.applyOfficialData && !f!.rd)
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'applyOfficialData',
          code: 'official_data_unavailable',
          message: 'no RD data to apply',
        },
      ]);
    await this.db.$transaction(
      async (tx) => {
        // PLT-106 แก้ชื่อ/ที่อยู่ให้ตรงข้อมูลทางการในขั้นเดียวกับอนุมัติ
        if (body.applyOfficialData && f!.rd) {
          const rd = f!.rd;
          await tx.tenant.update({ where: { id: t.id }, data: { name: rd.legalName } });
          if (f!.company)
            await tx.company.updateMany({
              where: { tenantId: t.id, taxId: f!.company.taxId },
              data: { legalName: rd.legalName },
            });
          if (f!.branch)
            await tx.branch.update({
              where: { id: f!.branch.id },
              data: { address: branchAddressOf(rd.address) },
            });
        }
        const next = await this.lifecycle.transition(
          {
            tenantId: t.id,
            to: 'TRIALING',
            reason: body.reason,
            actor: { type: 'platform_user', id: staff },
            expectFrom: 'PENDING_VERIFICATION',
            auditAction: 'platform.signup_approved',
          },
          tx,
        );
        if (!next) throw new ProblemException('invalid_state_transition');
        await this.saveVerification(tx, f!, 'approved', body.reason, diff, staff);
        if (body.applyOfficialData)
          await this.tenantAudit(
            tx,
            t.id,
            'platform.signup_official_data_applied',
            body.reason,
            {
              name: f!.rd!.legalName,
              address: addressLine(branchAddressOf(f!.rd!.address)),
            },
            {
              name: f!.company?.legalName ?? t.name,
              address: addressLine(f!.branch?.address),
            },
          );
        await this.event(tx, t.id, 'verification.approved', { diffFields: diff });
      },
      { timeout: 30_000 },
    );
    this.entitlements.invalidate(t.id);
  }

  async reject(id: string, reason: string) {
    const ref = this.parse(id);
    if (ref.kind === 'join') return this.decideJoin(ref.id, 'rejected', reason);
    const t = await this.pendingTenant(ref.id);
    const [f] = await this.signupFacts([t]);
    const diff = this.compare(f!)
      .filter((c) => c.differs)
      .map((c) => c.field);
    const staff = this.staffId();
    await this.db.$transaction(
      async (tx) => {
        // อีเมลแจ้งผู้สมัครพร้อมเหตุผล = อีเมลเปลี่ยนสถานะของบริการสถานะ (ส่งถึง owner = ผู้สมัคร)
        const next = await this.lifecycle.transition(
          {
            tenantId: t.id,
            to: 'CANCELLED',
            reason,
            actor: { type: 'platform_user', id: staff },
            expectFrom: 'PENDING_VERIFICATION',
            auditAction: 'platform.signup_rejected',
          },
          tx,
        );
        if (!next) throw new ProblemException('invalid_state_transition');
        await this.saveVerification(tx, f!, 'rejected', reason, diff, staff);
        await this.event(tx, t.id, 'verification.rejected', { reason });
      },
      { timeout: 30_000 },
    );
    this.entitlements.invalidate(t.id);
  }

  async requestInfo(id: string, reason: string) {
    const ref = this.parse(id);
    if (ref.kind === 'join') return this.decideJoin(ref.id, 'info_requested', reason);
    const t = await this.pendingTenant(ref.id);
    const [f] = await this.signupFacts([t]);
    const diff = this.compare(f!)
      .filter((c) => c.differs)
      .map((c) => c.field);
    const staff = this.staffId();
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM tenant WHERE id = ${t.id}::uuid FOR UPDATE`;
      const cur = await tx.tenant.findUniqueOrThrow({ where: { id: t.id } });
      if (cur.status !== 'PENDING_VERIFICATION')
        throw new ProblemException('invalid_state_transition');
      await this.saveVerification(tx, f!, 'info_requested', reason, diff, staff);
      await this.tenantAudit(tx, t.id, 'platform.signup_info_requested', reason, {
        verification: 'info_requested',
      });
      await this.event(tx, t.id, 'verification.info_requested', { reason });
      if (f!.owner)
        await this.email.enqueue(tx, {
          tenantId: t.id,
          to: f!.owner.email,
          template: 'signup_info_requested',
          locale: f!.owner.locale,
          vars: { companyName: safeName(t.name), reason: safeName(reason, 500) },
        });
    });
  }

  // ───────────────────────── คำขอเข้าร่วม ─────────────────────────

  private async approveJoin(id: string, reason: string) {
    const now = new Date();
    const j = await this.openJoin(id, now);
    const staff = this.staffId();
    await this.db.$transaction(
      async (tx) => {
        const cur = await this.lockJoin(tx, j.id, now);
        const target = await tx.tenant.findUniqueOrThrow({ where: { id: cur.tenantId } });
        if (target.status === 'CANCELLED' || target.status === 'SUSPENDED')
          throw new ProblemException('invalid_state_transition');
        const existing = await tx.appUser.findFirst({
          where: { email: iEquals(cur.email), status: { not: 'DELETED' } },
          select: { id: true },
        });
        if (existing) throw new ProblemException('already_member');
        // seat ตาม entitlement `users` (ล็อกเดียวกับการเชิญในแอป)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(6, hashtext(${cur.tenantId}))`;
        const limit = (await this.entitlements.resolve(cur.tenantId)).users?.limit ?? null;
        if (limit !== null) {
          const used = await tx.appUser.count({
            where: { tenantId: cur.tenantId, status: { in: ['ACTIVE', 'INVITED'] } },
          });
          if (used >= limit)
            throw new ProblemException('seat_limit_reached', undefined, undefined, { limit });
        }
        const roles = await ensureSystemRoles(tx, cur.tenantId);
        const user = await tx.appUser.create({
          data: {
            tenantId: cur.tenantId,
            email: cur.email,
            name: cur.applicantName,
            phone: cur.mobile,
            status: 'INVITED',
            locale: 'th',
          },
        });
        await tx.userRole.create({
          data: { tenantId: cur.tenantId, userId: user.id, roleId: roles.viewer! },
        });
        const role = await tx.role.findUniqueOrThrow({ where: { id: roles.viewer! } });
        await issueInvitation(tx, this.email, user, [role], null);
        await tx.tenantJoinRequest.update({
          where: { id: cur.id },
          data: {
            status: 'approved',
            reason,
            decidedByType: 'platform_user',
            decidedBy: staff,
            decidedAt: now,
            invitedUserId: user.id,
          },
        });
        await this.tenantAudit(
          tx,
          cur.tenantId,
          'platform.join_request_approved',
          reason,
          { status: 'approved', user: encodeId('user', user.id), roles: ['viewer'] },
          { status: cur.status },
          'join_request',
          cur.id,
        );
      },
      { timeout: 30_000 },
    );
  }

  private async decideJoin(id: string, status: 'rejected' | 'info_requested', reason: string) {
    const now = new Date();
    const j = await this.openJoin(id, now);
    const staff = this.staffId();
    await this.db.$transaction(async (tx) => {
      const cur = await this.lockJoin(tx, j.id, now);
      await tx.tenantJoinRequest.update({
        where: { id: cur.id },
        data: {
          status,
          reason,
          decidedByType: 'platform_user',
          decidedBy: staff,
          decidedAt: now,
        },
      });
      await this.tenantAudit(
        tx,
        cur.tenantId,
        status === 'rejected'
          ? 'platform.join_request_rejected'
          : 'platform.join_request_info_requested',
        reason,
        { status },
        { status: cur.status },
        'join_request',
        cur.id,
      );
      await notifyJoinApplicant(tx, this.email, cur, status, reason);
    });
  }

  private async lockJoin(tx: Prisma.TransactionClient, id: string, now: Date) {
    await tx.$queryRaw`SELECT id FROM tenant_join_request WHERE id = ${id}::uuid FOR UPDATE`;
    const cur = await tx.tenantJoinRequest.findUniqueOrThrow({ where: { id } });
    if (!inQueue(cur, now)) throw new ProblemException('invalid_state_transition');
    return cur;
  }

  // ───────────────────────── ภายใน ─────────────────────────

  private parse(id: string): { kind: 'tenant' | 'join'; id: string } {
    const m = /^(ten|jrq)_([0-9a-f]{32})$/.exec(id);
    if (!m) throw new ProblemException('not_found');
    const hex = m[2]!;
    const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return { kind: m[1] === 'ten' ? 'tenant' : 'join', id: uuid };
  }

  /** tenant ที่อยู่ในคิว (live + pending_verification) — อื่น ๆ 404 (ตัดสินแล้ว = ไม่อยู่ในคิว) */
  private async pendingTenant(id: string): Promise<Tenant> {
    const t = await this.db.tenant.findUnique({ where: { id } });
    if (!t || t.mode !== 'live' || t.status !== 'PENDING_VERIFICATION')
      throw new ProblemException('not_found');
    return t;
  }

  private async openJoin(id: string, now: Date): Promise<TenantJoinRequest> {
    const j = await this.db.tenantJoinRequest.findUnique({ where: { id } });
    if (!j || !inQueue(j, now)) throw new ProblemException('not_found');
    return j;
  }

  private staffId() {
    return requestContext.require().platformUser!.id;
  }

  private async targetNames(ids: string[]) {
    const rows = await this.db.company.findMany({
      where: { tenantId: { in: [...new Set(ids)] } },
      orderBy: { createdAt: 'asc' },
      select: { tenantId: true, legalName: true },
    });
    const m = new Map<string, string>();
    for (const r of rows) if (!m.has(r.tenantId)) m.set(r.tenantId, r.legalName);
    const missing = ids.filter((i) => !m.has(i));
    if (missing.length)
      for (const t of await this.db.tenant.findMany({ where: { id: { in: missing } } }))
        m.set(t.id, t.name);
    return m;
  }

  private async signupFacts(tenants: Tenant[]): Promise<SignupFacts[]> {
    if (!tenants.length) return [];
    const ids = tenants.map((t) => t.id);
    const db = this.db;
    const [companies, branches, signups, verifications] = await Promise.all([
      db.company.findMany({ where: { tenantId: { in: ids } }, orderBy: { createdAt: 'asc' } }),
      db.branch.findMany({
        where: { tenantId: { in: ids } },
        orderBy: [{ isDefaultIssuer: 'desc' }, { branchCode: 'asc' }],
      }),
      db.tenantSignup.findMany({ where: { tenantId: { in: ids } } }),
      db.tenantVerification.findMany({ where: { tenantId: { in: ids } } }),
    ]);
    const lookupIds = signups.map((s) => s.companyLookupId).filter((x): x is string => !!x);
    const lookups = lookupIds.length
      ? await db.companyLookup.findMany({ where: { id: { in: lookupIds } } })
      : [];
    const owners = await ownersOfMany(db, ids);
    const taxIds = [...new Set(companies.map((c) => c.taxId))];
    const sameTax = taxIds.length
      ? await db.company.findMany({
          where: { taxId: { in: taxIds }, tenantId: { notIn: ids } },
          orderBy: { createdAt: 'asc' },
        })
      : [];
    const dupTenants = sameTax.length
      ? await db.tenant.findMany({
          where: { id: { in: sameTax.map((c) => c.tenantId) }, mode: 'live' },
        })
      : [];
    const dupById = new Map(dupTenants.map((t) => [t.id, t]));
    return tenants.map((t) => {
      const company = companies.find((c) => c.tenantId === t.id) ?? null;
      const branch =
        (company && branches.find((b) => b.tenantId === t.id && b.companyId === company.id)) ??
        null;
      const signup = signups.find((s) => s.tenantId === t.id) ?? null;
      const lookup = signup?.companyLookupId
        ? (lookups.find((l) => l.id === signup.companyLookupId) ?? null)
        : null;
      const rd =
        lookup?.result === 'vat_found' && lookup.data
          ? (lookup.data as unknown as RegistryCompany)
          : null;
      const rdStatus: RdStatus = rd
        ? 'found'
        : lookup?.result === 'tin_exists'
          ? 'tin_only'
          : lookup?.result === 'not_found'
            ? 'not_found'
            : 'unavailable';
      const dupCompany = company
        ? sameTax.find((c) => c.taxId === company.taxId && dupById.has(c.tenantId))
        : undefined;
      const dupT = dupCompany ? dupById.get(dupCompany.tenantId)! : null;
      return {
        tenant: t,
        company: company ? { legalName: company.legalName, taxId: company.taxId } : null,
        branch: branch
          ? { id: branch.id, branchCode: branch.branchCode, address: branch.address }
          : null,
        signup,
        verification: verifications.find((v) => v.tenantId === t.id) ?? null,
        rd,
        rdStatus,
        owner: owners.get(t.id) ?? null,
        duplicate: dupT
          ? {
              tenantId: encodeId('tenant', dupT.id),
              name: dupCompany!.legalName,
              status: dupT.status.toLowerCase(),
            }
          : null,
      };
    });
  }

  /** ตารางเทียบ ที่กรอก | RD | DBD — ไฮไลต์เฉพาะช่องที่ทั้งสองฝั่งมีค่าและต่างกัน */
  private compare(f: SignupFacts): CompareRow[] {
    const rd = f.rd;
    const enteredName = f.company?.legalName ?? f.tenant.name;
    const enteredAddr = addressLine(f.branch?.address);
    const rdAddr = rd ? addressLine(branchAddressOf(rd.address as CompanyAddress)) : null;
    const enteredBranch = f.branch ? branchLabelOf(f.branch.branchCode) : null;
    const rdBranch = rd ? branchLabelOf(String(rd.branchNumber).padStart(5, '0')) : null;
    return [
      {
        field: 'name',
        entered: enteredName,
        rd: rd?.legalName ?? null,
        dbd: null,
        differs: !!rd && normalizeCompanyName(rd.legalName) !== normalizeCompanyName(enteredName),
      },
      {
        field: 'address',
        entered: enteredAddr,
        rd: rdAddr,
        dbd: null,
        differs: !!rdAddr && !!enteredAddr && norm(rdAddr) !== norm(enteredAddr),
      },
      {
        field: 'branch',
        entered: enteredBranch,
        rd: rdBranch,
        dbd: null,
        differs: !!rdBranch && !!enteredBranch && rdBranch !== enteredBranch,
      },
      { field: 'businessStatus', entered: null, rd: null, dbd: null, differs: false },
      {
        field: 'vatRegisteredSince',
        entered: null,
        rd: rd?.vatRegisteredSince ?? null,
        dbd: null,
        differs: false,
      },
      { field: 'tsic', entered: null, rd: null, dbd: null, differs: false },
    ];
  }

  private signupItem(f: SignupFacts, now: Date): QueueItem {
    const diff = this.compare(f).some((c) => c.differs);
    const flags = [...(f.signup?.flags ?? [])];
    const check: QueueCheck = f.duplicate
      ? 'duplicate'
      : f.rdStatus !== 'found'
        ? 'not_found'
        : diff
          ? 'mismatch'
          : 'match';
    const status = f.verification?.status === 'info_requested' ? 'info_requested' : 'pending';
    const waiting = f.verification?.waitingSince ?? f.tenant.createdAt;
    return {
      id: encodeId('tenant', f.tenant.id),
      kind: 'signup',
      name: f.company?.legalName ?? f.tenant.name,
      taxId: f.company?.taxId ?? null,
      branchCode: f.branch?.branchCode ?? null,
      applicantName: f.owner?.name ?? null,
      applicantEmail: f.owner?.email ?? null,
      fleetSizeOwn: f.signup?.fleetSizeOwn ?? null,
      fleetSizeSubcon: f.signup?.fleetSizeSubcon ?? null,
      check,
      status,
      flags,
      submittedAt: f.tenant.createdAt.toISOString(),
      waitingSince: waiting.toISOString(),
      overSla: status === 'pending' && addBusinessDays(waiting, 1) <= now,
    };
  }

  private joinItem(j: TenantJoinRequest, companyName: string, now: Date): QueueItem {
    // เวลาเริ่มรอในคิว: join = ครบกำหนด owner ตอบ · contact = ส่งคำขอ
    const waiting = j.kind === 'join' && j.ownerDueAt ? j.ownerDueAt : j.createdAt;
    const status = j.status === 'info_requested' ? 'info_requested' : 'pending';
    return {
      id: encodeId('joinRequest', j.id),
      kind: j.kind === 'contact' ? 'contact' : 'join',
      name: companyName,
      taxId: j.taxId,
      branchCode: j.branchCode,
      applicantName: j.applicantName,
      applicantEmail: j.email,
      fleetSizeOwn: null,
      fleetSizeSubcon: null,
      check: 'duplicate',
      status,
      flags: [],
      submittedAt: j.createdAt.toISOString(),
      waitingSince: waiting.toISOString(),
      overSla: status === 'pending' && addBusinessDays(waiting, 1) <= now,
    };
  }

  /** ประวัติการสมัครจาก IP/อีเมลเดียวกัน (บริษัทที่สมัครแล้ว + คำขอเข้าร่วม + การสมัครที่ยังไม่จบ/ทิ้งไว้) */
  private async history(q: {
    ip: string | null;
    email: string | null;
    excludeTenantId?: string;
    excludeJoinId?: string;
    excludeSessionId?: string | null;
  }): Promise<QueueHistoryRow[]> {
    if (!q.ip && !q.email) return [];
    const db = this.db;
    const out: QueueHistoryRow[] = [];
    const matchOf = (ip: string | null, email: string | null): QueueHistoryRow['match'] => {
      const byIp = !!q.ip && ip === q.ip;
      const byEmail = !!q.email && !!email && email.toLowerCase() === q.email.toLowerCase();
      return byIp && byEmail ? 'both' : byIp ? 'ip' : 'email';
    };
    // บริษัทที่สมัครเอง: IP ตอนยอมรับข้อกำหนด หรืออีเมลของ owner
    const ownerTenants = q.email
      ? (
          await db.appUser.findMany({
            where: { email: iEquals(q.email), status: { not: 'DELETED' } },
            select: { tenantId: true },
          })
        ).map((u) => u.tenantId)
      : [];
    const signups = await db.tenantSignup.findMany({
      where: {
        OR: [
          ...(q.ip ? [{ termsAcceptedIp: q.ip }] : []),
          ...(ownerTenants.length ? [{ tenantId: { in: ownerTenants } }] : []),
        ],
        ...(q.excludeTenantId ? { tenantId: { not: q.excludeTenantId } } : {}),
      },
      include: { tenant: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    for (const s of signups)
      out.push({
        kind: 'tenant',
        name: s.tenant.name,
        status: s.tenant.status.toLowerCase(),
        match: matchOf(s.termsAcceptedIp, ownerTenants.includes(s.tenantId) ? q.email : null),
        at: s.createdAt.toISOString(),
      });
    const joins = await db.tenantJoinRequest.findMany({
      where: {
        OR: [...(q.ip ? [{ ip: q.ip }] : []), ...(q.email ? [{ email: q.email }] : [])],
        ...(q.excludeJoinId ? { id: { not: q.excludeJoinId } } : {}),
      },
      include: { tenant: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    for (const j of joins)
      out.push({
        kind: 'join',
        name: j.tenant.name,
        status: j.status,
        match: matchOf(j.ip, j.email),
        at: j.createdAt.toISOString(),
      });
    const sessions = await db.signupSession.findMany({
      where: {
        personalDataErasedAt: null,
        status: { not: 'completed' },
        OR: [...(q.ip ? [{ ip: q.ip }] : []), ...(q.email ? [{ email: q.email }] : [])],
        ...(q.excludeSessionId ? { id: { not: q.excludeSessionId } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    for (const s of sessions)
      out.push({
        kind: 'session',
        name: s.legalName ?? '—',
        status: s.status,
        match: matchOf(s.ip, s.email),
        at: s.createdAt.toISOString(),
      });
    return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20);
  }

  private async saveVerification(
    tx: Prisma.TransactionClient,
    f: SignupFacts,
    status: 'approved' | 'rejected' | 'info_requested',
    reason: string,
    diff: string[],
    staff: string,
  ) {
    const source = [...(f.signup?.verificationSource ? [f.signup.verificationSource] : [])];
    const data = {
      status,
      source,
      snapshotRd: (f.rd ?? undefined) as Prisma.InputJsonValue | undefined,
      diffFields: diff,
      reason,
      decidedBy: staff,
      decidedAt: new Date(),
    };
    await tx.tenantVerification.upsert({
      where: { tenantId: f.tenant.id },
      create: { tenantId: f.tenant.id, waitingSince: f.tenant.createdAt, ...data },
      update: data,
    });
  }

  private tenantAudit(
    tx: Prisma.TransactionClient,
    tenantId: string,
    action: string,
    reason: string,
    after: object,
    before?: object,
    entityType = 'tenant',
    entityId = tenantId,
  ) {
    const ctx = requestContext.require();
    return tx.auditLog.create({
      data: {
        tenantId,
        actorId: `platform:${ctx.platformUser!.id}`,
        action,
        entityType,
        entityId,
        before: (before ?? undefined) as Prisma.InputJsonValue | undefined,
        after: after as Prisma.InputJsonValue,
        reason,
        requestId: ctx.requestId,
        ip: ctx.ip ?? null,
      },
    });
  }

  private event(tx: Prisma.TransactionClient, tenantId: string, type: string, extra: object) {
    const ctx = requestContext.require();
    return tx.domainEvent.create({
      data: {
        tenantId,
        type,
        entityType: 'tenant',
        localId: tenantId,
        snapshot: { tenantId: encodeId('tenant', tenantId), ...extra } as Prisma.InputJsonValue,
        requestId: ctx.requestId,
        actorId: `platform:${ctx.platformUser!.id}`,
      },
    });
  }
}
