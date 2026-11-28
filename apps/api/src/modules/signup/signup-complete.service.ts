import { Injectable, Logger } from '@nestjs/common';
import type { AppUser, Plan, PlanVersion, SignupSession, TenantStatus } from '@prisma/client';
import { AuthService, CODE_TTL_MS } from '../../auth/auth.service';
import { MfaService } from '../../auth/mfa.service';
import { webBaseUrl } from '../../auth/password-reset.controller';
import { ensureSystemRoles } from '../../auth/system-roles';
import { sha256 } from '../../auth/tokens';
import { encodeId } from '../../common/ids';
import { iEquals } from '../../common/ilike';
import { ProblemException } from '../../common/problem';
import { docDate } from '../../common/thai-date';
import { PrismaService } from '../../db/prisma.service';
import { defaultFileStore, putFileLocked } from '../../pdf/file-store';
import { readPlatformSetting } from '../../platform/platform-settings.service';
import { EmailService } from '../email/email.service';
import { EXT } from '../documents/mime';
import { currentPlanVersions } from '../entitlements/plan-catalog';
import { createSandboxTx } from '../sandbox/sandbox.service';
import { bootstrapTenant } from '../tenants/bootstrap';
import { TenantLifecycleService } from '../tenants/tenant-lifecycle.service';
import { CompanyLookupService } from './company-lookup/company-lookup.service';
import type { CompanyAddress } from './company-lookup/types';
import { SIGNUP_ABANDON_MS, viewOf, type SignupSessionView } from './signup.service';

/**
 * สมัครขั้น 3 "เลือกแพ็กเกจ" + สร้างบริษัท (P1-ST2-T05; spec/01 §2 PLT-022, PLT-025; plan/13 P1-ST2-T05)
 *
 * ธุรกรรมเดียว (ล้มกลางทาง = ไม่มีแถวค้างสักตาราง): Tenant + ค่าเริ่มต้นไทย (ST1-T20 — รวม Subscription trialing,
 * trialEndsAt = วันนี้ + `trial.days`) + ประวัติสถานะแถวแรก + นิติบุคคล/สาขาจากขั้น 2 + User + Membership(owner)
 * + SetupChecklistState (ST1-T21) + หนังสือรับรอง (stored_document) + tenant_signup (ผลตรวจ/การยอมรับข้อกำหนด)
 * + sandbox (ST7-T09) + audit + event `signup.completed` + อีเมลยืนยัน (outbox) + session → completed
 *
 * - ตรวจเลขซ้ำ (taxId, branchCode) อีกครั้งในธุรกรรม หลังล็อก advisory ต่อเลข — สมัครพร้อมกันด้วยเลขเดียวกันได้บริษัทเดียว
 * - สถานะ tenant: `signup.approvalPolicy` = auto_when_verified + ผลตรวจ auto_vat → `trialing` · อื่น ๆ (pending_manual,
 *   pending_verification, หรือนโยบาย manual_all) → `pending_verification` (เข้าคิวอนุมัติ P1-ST2-T06)
 * - แพ็กเกจตกลงราคา (isContactSales — ต้นแบบ "องค์กร · นัด demo") → ไม่สร้างบริษัท บันทึกคำขอนัด demo ใน session
 * - trialing → ออก authorization code (PKCE) ให้เข้าแอปทันที (หรือ challenge 2FA ตาม D-78 — owner ต้องตั้ง 2FA)
 * - ไฟล์หนังสือรับรองย้ายเข้าโฟลเดอร์ของ tenant ในธุรกรรม แล้วลบไฟล์ของ session หลัง commit
 *
 * [DECISION — lead 28 พ.ย. 2569, ย้อนได้]
 * - นิติบุคคล `vatRegistered` = false เฉพาะเมื่อ RD ยืนยันว่ามีเลขแต่ไม่จด VAT (tin_exists) — อื่น ๆ คงค่าเริ่มต้น (true)
 *   ให้ทีมงาน/ลูกค้าแก้ในหน้าตั้งค่า (TMS ไม่ออกเอกสารภาษี — D-54)
 * - R-02: accountingSoftware = none → ธง `no_accounting_software` ใน tenant_signup (banner = P1-ST1-T05, ธง Console/กัน paid = T06/P1-ST3)
 */

/** แพ็กเกจที่เลือกได้ในขั้น 3 (ต้นแบบ: ทดลองใช้ + "นัด demo") */
export interface SignupPlanChoice {
  plan: Plan;
  version: PlanVersion;
}

export interface SignupCompletion {
  outcome: 'ready' | 'pending' | 'demo';
  /** สถานะ tenant (ค่า 7 สถานะตัวพิมพ์เล็ก) · null = ขอนัด demo */
  tenantStatus: string | null;
  companyName: string;
  planCode: string;
  planName: string;
  trialEndsAt: string | null;
}

export type SignupSignIn =
  | { kind: 'code'; code: string; expiresIn: number }
  | { kind: 'mfa'; mfaToken: string; purpose: 'verify' | 'enroll' };

export interface SignupCompleteResult {
  session: SignupSessionView;
  completion: SignupCompletion;
  signIn: SignupSignIn | null;
}

/** ปลายทาง advisory lock: 31 = อีเมลผู้สมัคร (เหมือนขั้น 1) · 32 = เลขผู้เสียภาษี */
const LOCK_EMAIL = 31;
const LOCK_TAX = 32;

/** ที่อยู่แยกฟิลด์ (ขั้น 2) → ที่อยู่สาขาตาม ภ.พ.20 (branch.address) */
export function branchAddressOf(a: CompanyAddress | null) {
  const v = (k: keyof CompanyAddress) => (a?.[k] ?? '').trim();
  const line1 = [
    v('houseNo'),
    v('moo') && `หมู่ ${v('moo')}`,
    v('soi') && `ซอย ${v('soi')}`,
    v('street') && `ถนน ${v('street')}`,
  ]
    .filter(Boolean)
    .join(' ');
  return {
    line1,
    subdistrict: v('subDistrict'),
    district: v('district'),
    province: v('province'),
    postcode: v('postalCode'),
  };
}

const planNameOf = (p: { nameTh: string; nameEn: string | null }, locale: string | null) =>
  locale === 'en' ? (p.nameEn ?? p.nameTh) : p.nameTh;

const branchLabelOf = (code: string) => (code === '00000' ? 'สำนักงานใหญ่' : `สาขาที่ ${code}`);

@Injectable()
export class SignupCompleteService {
  private readonly log = new Logger('Signup');

  constructor(
    private readonly prisma: PrismaService,
    private readonly lookups: CompanyLookupService,
    private readonly email: EmailService,
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
  ) {}

  private get db() {
    return this.prisma.platform;
  }

  /** จุดตรวจระหว่างธุรกรรม — test ฉีด error ได้ (ไม่มีผลใน production) */
  protected checkpoint(_name: 'tenant_created' | 'before_commit'): void | Promise<void> {}

  /** แพ็กเกจที่แสดงในขั้น 3: active + showOnWeb + มีเวอร์ชันที่มีผล เรียงตาม sortOrder */
  async choices(): Promise<SignupPlanChoice[]> {
    const [plans, current] = await Promise.all([
      this.db.plan.findMany({
        where: { status: 'active', showOnWeb: true },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      }),
      currentPlanVersions(this.db),
    ]);
    return plans
      .map((plan) => ({ plan, version: current.get(plan.code)! }))
      .filter((x) => !!x.version);
  }

  /** session จาก token — รับทั้งที่ยังทำต่อได้และที่สร้างบริษัทแล้ว (เรียกซ้ำหลังสายหลุด = ตอบผลเดิม) */
  private async sessionOf(token: string | undefined, now: number): Promise<SignupSession> {
    const invalid = new ProblemException('signup_session_invalid');
    if (!token || token.length > 200) throw invalid;
    const s = await this.db.signupSession.findUnique({
      where: { resumeTokenHash: sha256(token) },
    });
    if (!s || s.personalDataErasedAt) throw invalid;
    if (s.status === 'completed') return s;
    if (
      !['account_verified', 'company_submitted'].includes(s.status) ||
      s.lastActivityAt.getTime() <= now - SIGNUP_ABANDON_MS
    )
      throw invalid;
    return s;
  }

  async complete(
    token: string | undefined,
    body: { planCode: string; codeChallenge: string },
    meta: { ip?: string },
  ): Promise<SignupCompleteResult> {
    const now = Date.now();
    const s = await this.sessionOf(token, now);
    if (s.status === 'completed') return this.replay(s, now);
    if (s.status !== 'company_submitted' || !s.taxId || !s.branchCode || !s.legalName)
      throw new ProblemException('invalid_state_transition');

    const choice = (await this.choices()).find((c) => c.plan.code === body.planCode);
    if (!choice)
      throw new ProblemException('validation_failed', undefined, [
        { field: 'planCode', code: 'unknown_plan', message: 'plan not available for sign-up' },
      ]);
    if (choice.plan.isContactSales) return this.requestDemo(s, choice, now);

    const policy = await readPlatformSetting<string>(this.db, 'signup.approvalPolicy');
    const status: TenantStatus =
      policy === 'auto_when_verified' && s.verificationStatus === 'auto_vat'
        ? 'TRIALING'
        : 'PENDING_VERIFICATION';
    // อ่านไฟล์ก่อนเปิดธุรกรรม (ไม่ถือ connection ระหว่าง I/O ไฟล์ใหญ่)
    const cert =
      s.certificateFileKey && s.certificateMime
        ? { data: await defaultFileStore().get(s.certificateFileKey), mime: s.certificateMime }
        : null;
    let movedKey: string | null = null;
    let createdId: string | null = null;

    let out: { user: AppUser; tenantId: string; trialEndsAt: Date | null };
    try {
      out = await this.db.$transaction(
        async (tx) => {
          // session ทีละคำขอ (ดับเบิลคลิก / หลายแท็บ) → ตรวจสถานะใหม่หลังล็อก
          await tx.$queryRaw`SELECT id FROM signup_session WHERE id = ${s.id}::uuid FOR UPDATE`;
          const cur = await tx.signupSession.findUniqueOrThrow({ where: { id: s.id } });
          if (cur.status !== 'company_submitted')
            throw new ProblemException('invalid_state_transition');
          // ไฟล์หนังสือรับรองถูกแทนระหว่างอ่านไฟล์ (อีกแท็บอัปโหลดใหม่) → ให้ลองใหม่ ไม่ย้ายไฟล์ผิดฉบับ
          if (cur.certificateFileKey !== s.certificateFileKey)
            throw new ProblemException('invalid_state_transition');
          const email = cur.email!;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_EMAIL}::int, hashtext(${email}))`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_TAX}::int, hashtext(${cur.taxId!}))`;
          // อีเมลถูกใช้ระหว่างทาง (ถูกเชิญเข้าบริษัทอื่น) → ไปเข้าสู่ระบบแทน
          const existing = await tx.appUser.findFirst({
            where: { email: iEquals(email), status: { in: ['ACTIVE', 'INVITED'] } },
            select: { id: true },
          });
          if (existing) throw new ProblemException('account_exists');
          // ตรวจเลขซ้ำอีกครั้งภายในธุรกรรม (T04 ตรวจตอนค้นหา/ส่งเท่านั้น)
          const dup = await this.lookups.duplicate(cur.taxId!, cur.branchCode!, tx);
          if (dup.duplicate) throw new ProblemException('company_exists');

          const tenant = await tx.tenant.create({
            data: { name: cur.legalName!, status, planCode: choice.plan.code },
          });
          createdId = tenant.id;
          await this.checkpoint('tenant_created');
          await TenantLifecycleService.recordInitial(
            tx,
            tenant.id,
            status,
            status === 'TRIALING'
              ? 'สมัครใช้งานเอง — ตรวจพบผู้จดภาษีมูลค่าเพิ่มและชื่อตรง'
              : `สมัครใช้งานเอง — รอทีมงานตรวจข้อมูลบริษัท (${cur.verificationReason ?? policy})`,
            { type: 'system' },
          );
          // ค่าเริ่มต้นไทย + subscription (trial.days) + role ระบบ (ST1-T20)
          await bootstrapTenant(tx, tenant.id);

          const company = await tx.company.create({
            data: {
              tenantId: tenant.id,
              legalName: cur.legalName!,
              taxId: cur.taxId!,
              vatRegistered: cur.verificationReason !== 'rd_vat_not_found_tin_exists',
            },
          });
          await tx.branch.create({
            data: {
              tenantId: tenant.id,
              companyId: company.id,
              branchCode: cur.branchCode!,
              branchLabel: branchLabelOf(cur.branchCode!),
              address: branchAddressOf(cur.address as CompanyAddress | null),
              isDefaultIssuer: true,
            },
          });

          const roles = await ensureSystemRoles(tx, tenant.id);
          const user = await tx.appUser.create({
            data: {
              tenantId: tenant.id,
              email,
              name: cur.fullName ?? email,
              phone: cur.mobile,
              passwordHash: cur.passwordHash,
              status: 'ACTIVE',
              locale: cur.locale === 'en' ? 'en' : 'th',
            },
          });
          await tx.userRole.create({
            data: { tenantId: tenant.id, userId: user.id, roleId: roles.owner! },
          });
          await tx.setupChecklistState.create({ data: { tenantId: tenant.id } });

          // หนังสือรับรอง → ไฟล์ของ tenant + stored_document (ก่อนข้อมูล session ถูกลบวันที่ 30)
          let certificateDocumentId: string | null = null;
          if (cert) {
            const f = await putFileLocked(
              tx,
              tenant.id,
              cert.data,
              (EXT as Record<string, string>)[cert.mime] ?? 'bin',
            );
            movedKey = f.key;
            const doc = await tx.storedDocument.create({
              data: {
                tenantId: tenant.id,
                status: 'READY',
                fileKey: f.key,
                sha256: f.sha256,
                mimeType: cert.mime,
                sizeBytes: f.size,
                filename: cur.certificateFilename,
                kind: 'COMPANY_CERTIFICATE',
                entityType: 'company',
                entityId: company.id,
                createdBy: user.id,
                metadata: { source: 'signup', uploadedAt: cur.certificateUploadedAt },
              },
            });
            certificateDocumentId = doc.id;
          }

          // ธงจากการตรวจซ้ำในธุรกรรม (สถานะ ณ ตอนสร้าง) + ธงจากขั้น 2
          const flags = [
            ...new Set([
              ...cur.flags,
              ...(dup.sameTaxOtherBranch ? ['same_tax_other_branch'] : []),
              ...(cur.accountingSoftware === 'none' ? ['no_accounting_software'] : []),
            ]),
          ];
          await tx.tenantSignup.create({
            data: {
              tenantId: tenant.id,
              signupSessionId: cur.id,
              verificationStatus: cur.verificationStatus ?? 'pending_verification',
              verificationSource: cur.verificationSource,
              verificationReason: cur.verificationReason,
              approvalPolicy: policy,
              flags,
              companyLookupId: cur.companyLookupId,
              accountingSoftware: cur.accountingSoftware,
              fleetSizeOwn: cur.fleetSizeOwn,
              fleetSizeSubcon: cur.fleetSizeSubcon,
              planCode: choice.plan.code,
              termsVersion: cur.termsVersion!,
              privacyVersion: cur.privacyVersion!,
              termsAcceptedAt: cur.termsAcceptedAt!,
              termsAcceptedIp: cur.termsAcceptedIp,
              marketingOptIn: cur.marketingOptIn,
              certificateDocumentId,
            },
          });

          // sandbox ในธุรกรรมเดียวกัน (PLT-025) — หลังสร้างนิติบุคคล (คัดลอกไป sandbox)
          await createSandboxTx(tx, tenant, { actorId: user.id, ip: meta.ip ?? null });

          await tx.auditLog.create({
            data: {
              tenantId: tenant.id,
              actorId: user.id,
              action: 'tenant.signup_completed',
              entityType: 'tenant',
              entityId: tenant.id,
              after: {
                status: status.toLowerCase(),
                planCode: choice.plan.code,
                verificationStatus: cur.verificationStatus,
                approvalPolicy: policy,
                flags,
              },
              ip: meta.ip ?? null,
            },
          });
          // spec/01 §2 ข้อ 7 — event ภายใน (ยังไม่มี subscription ของ webhook ใน tenant ใหม่ — ไม่ส่งออก)
          await tx.domainEvent.create({
            data: {
              tenantId: tenant.id,
              type: 'signup.completed',
              entityType: 'tenant',
              localId: tenant.id,
              snapshot: {
                tenantId: encodeId('tenant', tenant.id),
                status: status.toLowerCase(),
                verificationStatus: cur.verificationStatus,
                planCode: choice.plan.code,
              },
              actorId: user.id,
            },
          });

          const sub = await tx.subscription.findUnique({ where: { tenantId: tenant.id } });
          const trialEndsAt = sub?.trialEndsAt ?? null;
          await this.email.enqueue(tx, {
            tenantId: tenant.id,
            to: email,
            template: 'signup_completed',
            locale: cur.locale === 'en' ? 'en' : 'th',
            vars: {
              companyName: cur.legalName!,
              planName: planNameOf(choice.plan, cur.locale),
              trialEnds: trialEndsAt ? docDate(trialEndsAt, 'BE') : '—',
              pending: status !== 'TRIALING',
              link: `${webBaseUrl()}/login`,
            },
          });

          // รหัสผ่านย้ายไปที่ผู้ใช้แล้ว — ไม่เก็บซ้ำใน session · ข้อมูลอื่นลบตามรอบวันที่ 30 (signupMaintenance)
          // resumeTokenHash คงไว้ให้เรียกซ้ำได้ผลเดิม (สายหลุด) — ใช้ได้เฉพาะ `complete` (ไม่ออก code ใหม่) · ถูกล้างพร้อมข้อมูลอื่นวันที่ 30
          await tx.signupSession.update({
            where: { id: cur.id },
            data: {
              status: 'completed',
              createdTenantId: tenant.id,
              completedAt: new Date(now),
              planCode: choice.plan.code,
              passwordHash: null,
              otpHash: null,
              lastActivityAt: new Date(now),
            },
          });
          await this.checkpoint('before_commit');
          return { user, tenantId: tenant.id, trialEndsAt };
        },
        { maxWait: 5_000, timeout: 60_000 },
      );
    } catch (e) {
      // ไฟล์ไม่อยู่ในธุรกรรม — rollback แล้วลบไฟล์ที่เพิ่งเขียนในโฟลเดอร์ของ tenant ที่ไม่ถูกสร้าง
      // ไม่รู้ผล commit (สายหลุดตอน COMMIT) → ตรวจว่า tenant มีจริงไหมก่อน — มี = ไม่ลบ (stored_document อ้างไฟล์นี้)
      if (movedKey && createdId) {
        const committed = await this.db.tenant
          .findUnique({ where: { id: createdId }, select: { id: true } })
          .then((t) => !!t)
          .catch(() => true);
        if (!committed)
          await defaultFileStore()
            .remove(movedKey)
            .catch(() => undefined);
      }
      throw e;
    }

    // ไฟล์เดิมของ session: ลบหลัง commit แล้วค่อยล้าง key (ลบไม่ได้ = รอบวันที่ 30 ลบทั้งโฟลเดอร์)
    if (cert && s.certificateFileKey) {
      try {
        await defaultFileStore().removeNamespace(s.id);
        await this.db.signupSession.update({
          where: { id: s.id },
          data: { certificateFileKey: null },
        });
      } catch {
        /* ค้างให้ signupMaintenance */
      }
    }

    this.log.log({
      event: 'signup.completed',
      sessionId: s.id,
      tenantId: out.tenantId,
      verificationStatus: s.verificationStatus,
    });

    const signIn = status === 'TRIALING' ? await this.signIn(out.user, body.codeChallenge) : null;
    const u = await this.db.signupSession.findUniqueOrThrow({ where: { id: s.id } });
    return {
      session: viewOf(u, now),
      completion: {
        outcome: status === 'TRIALING' ? 'ready' : 'pending',
        tenantStatus: status === 'TRIALING' ? 'trialing' : 'pending_verification',
        companyName: s.legalName!,
        planCode: choice.plan.code,
        planName: planNameOf(choice.plan, s.locale),
        trialEndsAt: out.trialEndsAt?.toISOString() ?? null,
      },
      signIn,
    };
  }

  /** เข้าแอปทันทีหลังสมัคร — ขั้นเดียวกับ login: owner ต้องตั้ง 2FA (D-78) → challenge แทน code */
  private async signIn(user: AppUser, codeChallenge: string): Promise<SignupSignIn> {
    const need = await this.mfa.requirement(user);
    if (need !== 'none')
      return {
        kind: 'mfa',
        mfaToken: await this.mfa.createChallenge(user, need, codeChallenge),
        purpose: need,
      };
    const code = await this.auth.issueAuthCode(user, codeChallenge);
    return { kind: 'code', code, expiresIn: CODE_TTL_MS / 1000 };
  }

  /**
   * แพ็กเกจตกลงราคา → บันทึกคำขอนัด demo (ไม่สร้างบริษัท) — ฝ่ายขายติดต่อภายใน 1 วันทำการ
   * บันทึกถาวร (review M2): แถว platform_audit_log `signup.demo_requested` (lead ของฝ่ายขาย — ไม่ถูกลบพร้อม session วันที่ 30)
   * + อีเมลถึงทีม (outbox ในธุรกรรมเดียวกัน): `SIGNUP_SALES_EMAILS` (คั่นด้วย ,) — ไม่ตั้ง = ทีม Platform Console ที่ ACTIVE
   * บทบาท SUPER_ADMIN/SUPPORT (แบบเดียวกับ MONITOR_ALERT_EMAILS) · ไม่มีผู้รับ = มีแค่แถว audit · ขอซ้ำ = ไม่บันทึกซ้ำ
   * หน้าคิวของฝ่ายขาย = P1-ST2-T06 / P1-ST4
   */
  private async requestDemo(
    s: SignupSession,
    choice: SignupPlanChoice,
    now: number,
  ): Promise<SignupCompleteResult> {
    const recipients = await salesRecipients(this.db);
    const u = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM signup_session WHERE id = ${s.id}::uuid FOR UPDATE`;
      const cur = await tx.signupSession.findUniqueOrThrow({ where: { id: s.id } });
      if (cur.status !== 'company_submitted')
        throw new ProblemException('invalid_state_transition');
      const first = !cur.demoRequestedAt;
      const row = await tx.signupSession.update({
        where: { id: s.id },
        data: {
          planCode: choice.plan.code,
          demoRequestedAt: cur.demoRequestedAt ?? new Date(now),
          lastActivityAt: new Date(now),
        },
      });
      if (!first) return row;
      const lead = {
        planCode: choice.plan.code,
        companyName: cur.legalName,
        taxId: cur.taxId,
        branchCode: cur.branchCode,
        applicantName: cur.fullName,
        email: cur.email,
        mobile: cur.mobile,
        fleetSizeOwn: cur.fleetSizeOwn,
        fleetSizeSubcon: cur.fleetSizeSubcon,
        accountingSoftware: cur.accountingSoftware,
      };
      await tx.platformAuditLog.create({
        data: {
          action: 'signup.demo_requested',
          entityType: 'signup_session',
          entityId: cur.id,
          after: lead,
          reason: 'ผู้สมัครขอนัด demo (แพ็กเกจตกลงราคา)',
        },
      });
      if (recipients.length)
        await this.email.enqueueMany(
          tx,
          recipients.map((to) => ({
            tenantId: null,
            to,
            template: 'signup_demo_request' as const,
            locale: 'th',
            vars: {
              companyName: cur.legalName ?? '—',
              taxId: cur.taxId ?? '—',
              planName: choice.plan.nameTh,
              applicantName: cur.fullName ?? '—',
              email: cur.email ?? '—',
              mobile: cur.mobile ?? '—',
              vehicles: (cur.fleetSizeOwn ?? 0) + (cur.fleetSizeSubcon ?? 0),
            },
          })),
        );
      return row;
    });
    this.log.log({
      event: 'signup.demo_requested',
      sessionId: s.id,
      planCode: choice.plan.code,
      notified: recipients.length,
    });
    return {
      session: viewOf(u, now),
      completion: {
        outcome: 'demo',
        tenantStatus: null,
        companyName: s.legalName ?? '',
        planCode: choice.plan.code,
        planName: planNameOf(choice.plan, s.locale),
        trialEndsAt: null,
      },
      signIn: null,
    };
  }

  /** เรียกซ้ำหลังสร้างแล้ว (สายหลุด/รีเฟรช) — ตอบผลเดิม ไม่ออก code ใหม่ (เข้าสู่ระบบด้วยรหัสผ่าน) */
  private async replay(s: SignupSession, now: number): Promise<SignupCompleteResult> {
    const t = await this.db.tenant.findUniqueOrThrow({
      where: { id: s.createdTenantId! },
      include: { plan: true, subscription: true },
    });
    // สถานะจริง ณ ตอนนี้ (อาจถูกอนุมัติ/ระงับแล้ว) — pending_verification = หน้า "เราได้รับข้อมูลแล้ว"
    const pending = t.status === 'PENDING_VERIFICATION';
    return {
      session: viewOf(s, now),
      completion: {
        outcome: pending ? 'pending' : 'ready',
        tenantStatus: t.status.toLowerCase(),
        companyName: t.name,
        planCode: t.planCode,
        planName: planNameOf(t.plan, s.locale),
        trialEndsAt: t.subscription?.trialEndsAt?.toISOString() ?? null,
      },
      signIn: null,
    };
  }

  /** ข้อมูลผลการสมัครสำหรับ GET session (completed) */
  async completionOf(s: SignupSession): Promise<SignupCompletion | null> {
    if (s.status !== 'completed' || !s.createdTenantId) return null;
    return (await this.replay(s, Date.now())).completion;
  }
}

/** ผู้รับคำขอนัด demo: `SIGNUP_SALES_EMAILS` → ทีม Platform Console (SUPER_ADMIN/SUPPORT ที่ ACTIVE) */
export async function salesRecipients(
  db: Pick<PrismaService['platform'], 'platformUser'>,
  env = process.env,
): Promise<string[]> {
  const v = env.SIGNUP_SALES_EMAILS?.trim();
  if (v)
    return [
      ...new Set(
        v
          .split(',')
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
  const staff = await db.platformUser.findMany({
    where: { status: 'ACTIVE', role: { in: ['SUPER_ADMIN', 'SUPPORT'] } },
    select: { email: true },
    orderBy: { email: 'asc' },
  });
  return staff.map((x) => x.email);
}
