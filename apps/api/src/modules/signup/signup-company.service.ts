import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, SignupSession } from '@prisma/client';
import { ProblemException } from '../../common/problem';
import { PrismaService } from '../../db/prisma.service';
import { defaultFileStore, putFileLocked } from '../../pdf/file-store';
import { EXT, sniffMime } from '../documents/mime';
import { CompanyLookupService, type LookupOutcome } from './company-lookup/company-lookup.service';
import { ADDRESS_KEYS, type CompanyAddress, type RegistryCompany } from './company-lookup/types';
import type { CompanyLookupResultDto, JoinCompanyRequestDto, SubmitCompanyDto } from './signup.dto';
import { sessionByToken, viewOf, withJoinName, type SignupSessionView } from './signup.service';

/**
 * สมัครขั้น 2 "ข้อมูลบริษัท" (P1-ST2-T04; spec/01 §2 ขั้น 2, PLT-020–023; research/company-verification §7.1)
 *
 * - ค้นหา: checksum (DTO) → dedup (taxId, branchCode) → RD VAT → RD TIN (CompanyLookupService) · เรียกได้หลังยืนยัน OTP เท่านั้น
 * - ส่งขั้น 2: ตรวจซ้ำทุกอย่างฝั่ง server (เลขซ้ำ = 409 company_exists) → ผลตรวจ auto_vat / pending_manual / pending_verification
 *   → `company_submitted` (ขั้น 3 = T05 สร้าง tenant ตามผลนี้ + นโยบาย `signup.approvalPolicy`)
 * - pending_manual (PLT-021: มีเลขในฐาน RD แต่ไม่จด VAT) ต้องแนบหนังสือรับรองบริษัท (PDF/JPG/PNG ≤ 10 MB — ตรวจ magic bytes)
 *   เป็นสถานะย่อยของขั้นสมัคร — T05 แปลงเป็น tenant `pending_verification` (PLT-022) · ไม่พบเลขใน RD = pending_verification แนบได้ไม่บังคับ (spec §2 ข้อ 8)
 * - ค้นหา + ส่งขั้น 2 + คำขอเข้าร่วม นับรวม ≤ 20 ครั้ง/การสมัคร · ส่งขั้น 2/คำขอเข้าร่วมต้องใช้เลขที่ค้นล่าสุด
 * - ยอมรับข้อกำหนด + นโยบาย: เก็บเวอร์ชัน + เวลา + IP
 *
 * [DECISION — lead 27 พ.ย. 2569, ย้อนได้]
 * - ชื่อ "ตรง" (PLT-022) = เท่ากันหลังตัดช่องว่าง/จุด และคำนำหน้า-ท้ายนิติบุคคล (บริษัท, บจก., บมจ., ห้างหุ้นส่วนจำกัด/สามัญ, หจก., หสน., จำกัด, (มหาชน))
 * - RD ค้นไม่ได้ (ล่ม/ปิดวงจร/ปิดผู้ให้บริการ), ไม่พบ และบุคคลธรรมดา → pending_verification (ไม่บังคับหนังสือรับรอง — แนบได้)
 * - ที่อยู่: เลขที่ แขวง/ตำบล เขต/อำเภอ จังหวัด รหัสไปรษณีย์ บังคับ · หมู่ ซอย ถนน ว่างได้
 * - ย้อนกลับมาแก้ขั้น 2 ได้ระหว่าง `company_submitted` (ยังไม่สร้าง tenant)
 */
export const LOOKUPS_PER_SESSION = 20;
export const CERTIFICATE_MAX_BYTES = 10 * 1024 * 1024;
const CERT_MIME = ['application/pdf', 'image/jpeg', 'image/png'] as const;

/** เวอร์ชันข้อกำหนด/นโยบาย — **placeholder จนกว่าทนายส่งฉบับจริง (X-06)** ตั้งทับด้วย env ได้ */
export const TERMS_VERSION_PLACEHOLDER = 'draft-placeholder-2569-11-27';
export const termsVersion = () => process.env.SIGNUP_TERMS_VERSION || TERMS_VERSION_PLACEHOLDER;
export const privacyVersion = () => process.env.SIGNUP_PRIVACY_VERSION || TERMS_VERSION_PLACEHOLDER;

const EDITABLE: SignupSession['status'][] = ['account_verified', 'company_submitted'];

/** normalize ชื่อนิติบุคคลเพื่อเทียบกับผล RD */
export function normalizeCompanyName(v: string): string {
  return v
    .replace(/\s+/g, '')
    .replace(/[.,]/g, '')
    .replace(/^(บริษัท|บจก|บมจ|ห้างหุ้นส่วนจำกัด|ห้างหุ้นส่วนสามัญ|หจก|หสน)/, '')
    .replace(/(จำกัด\(มหาชน\)|\(มหาชน\)|จำกัด)$/, '')
    .replace(/(จำกัด)$/, '')
    .toLowerCase();
}

function verificationOf(
  o: LookupOutcome,
  legalName: string,
): {
  status: 'auto_vat' | 'pending_manual' | 'pending_verification';
  source: 'rd_vat' | 'rd_tin' | null;
  reason: string;
} {
  switch (o.result) {
    case 'vat_found':
      return normalizeCompanyName(o.company!.legalName) === normalizeCompanyName(legalName)
        ? { status: 'auto_vat', source: 'rd_vat', reason: 'rd_vat_found' }
        : { status: 'pending_verification', source: 'rd_vat', reason: 'name_mismatch' };
    case 'tin_exists':
      return { status: 'pending_manual', source: 'rd_tin', reason: 'rd_vat_not_found_tin_exists' };
    case 'not_found':
      // spec/01 §2 ข้อ 8 "ไม่พบเลขใน RD → ให้กรอกเอง + แจ้ง 'จะตรวจภายหลัง'" — หนังสือรับรองไม่บังคับ (แนบได้)
      return { status: 'pending_verification', source: 'rd_tin', reason: 'rd_not_found' };
    case 'individual':
      return { status: 'pending_verification', source: null, reason: 'individual' };
    default:
      return {
        status: 'pending_verification',
        source: null,
        reason: `rd_unavailable:${o.reason ?? 'unknown'}`,
      };
  }
}

const bad = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

@Injectable()
export class SignupCompanyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lookups: CompanyLookupService,
  ) {}

  private readonly log = new Logger('Signup');

  private get db() {
    return this.prisma.platform;
  }

  /**
   * นับเข้าเพดานต่อการสมัคร (ค้นหา + ส่งขั้น 2 + คำขอเข้าร่วม รวมกัน ≤ 20) — UPDATE แบบมีเงื่อนไข กันหลายแท็บพร้อมกันเกินเพดาน
   */
  private async countAttempt(
    id: string,
    now: number,
    extra: Prisma.SignupSessionUpdateManyMutationInput = {},
  ) {
    const n = await this.db.signupSession.updateMany({
      where: { id, lookupCount: { lt: LOOKUPS_PER_SESSION } },
      data: { lookupCount: { increment: 1 }, lastActivityAt: new Date(now), ...extra },
    });
    if (n.count === 0) throw new ProblemException('signup_lookup_limit');
  }

  /** ส่งขั้น 2 / คำขอเข้าร่วม ต้องใช้เลขที่กด "ค้นหา" ล่าสุด — submit ไม่ใช่ช่องค้นเลขใหม่ */
  private assertLookedUp(s: SignupSession, taxId: string) {
    if (s.lastLookupTaxId !== taxId)
      throw bad('taxId', 'lookup_required', 'press search for this tax ID first');
  }

  /** event ตาม spec/01 §2 ข้อ 7 — ตาราง domain_event ต้องมี tenant → ยังเป็น log โครงสร้าง (ตาราง event ระดับแพลตฟอร์ม = งานต่อ T05/P1-ST4-T01) */
  private event(
    type: 'signup.company_lookup' | 'signup.join_requested',
    data: Record<string, unknown>,
  ) {
    this.log.log({ event: type, ...data });
  }

  private async editable(token: string | undefined, now: number) {
    const s = await sessionByToken(this.db, token, now);
    if (!EDITABLE.includes(s.status)) throw new ProblemException('invalid_state_transition');
    return s;
  }

  /** ปุ่ม "ค้นหา" — dedup ก่อน (ไม่ส่งเลขออก) แล้วค่อยถามกรมสรรพากร */
  async lookup(
    token: string | undefined,
    input: { taxId: string; branchCode?: string },
  ): Promise<CompanyLookupResultDto> {
    const now = Date.now();
    const s = await this.editable(token, now);
    const branchCode = input.branchCode ?? '00000';
    // นับก่อนค้น + จำเลขที่ค้นล่าสุด (ส่งขั้น 2 / คำขอเข้าร่วมต้องใช้เลขนี้)
    await this.countAttempt(s.id, now, {
      lastLookupTaxId: input.taxId,
      lastLookupBranchCode: branchCode,
    });
    const base = {
      taxId: input.taxId,
      branchCode,
      company: null,
      duplicate: null,
      sameTaxOtherBranch: false,
      requiresCertificate: false,
      source: null,
    };
    const dup = await this.lookups.duplicate(input.taxId, branchCode);
    if (dup.duplicate) {
      this.event('signup.company_lookup', { sessionId: s.id, result: 'duplicate' });
      return {
        ...base,
        result: 'duplicate',
        duplicate: {
          companyName: dup.duplicate.companyName,
          branchLabel: dup.duplicate.branchLabel,
        },
      };
    }
    const o = await this.lookups.lookup(input.taxId, branchCode, { sessionId: s.id });
    this.event('signup.company_lookup', {
      sessionId: s.id,
      result: o.result,
      source: o.source,
      cached: o.cached,
    });
    return {
      ...base,
      result: o.result,
      source: o.source,
      company: o.result === 'vat_found' ? (o.company as RegistryCompany) : null,
      sameTaxOtherBranch: dup.sameTaxOtherBranch,
      // pending_manual (PLT-021): มีเลขในฐานสรรพากรแต่ไม่จด VAT → หนังสือรับรองบังคับ
      requiresCertificate: o.result === 'tin_exists',
    };
  }

  /** อัปโหลดหนังสือรับรองบริษัท (raw body) — แทนไฟล์เดิมได้ */
  async uploadCertificate(
    token: string | undefined,
    data: Buffer,
    filename: string | undefined,
  ): Promise<SignupSessionView> {
    const now = Date.now();
    const s = await this.editable(token, now);
    if (!data.length) throw bad('content', 'empty_file', 'file is empty');
    if (data.length > CERTIFICATE_MAX_BYTES) throw bad('content', 'file_too_large', 'max 10 MB');
    const mime = sniffMime(data);
    if (!mime || !(CERT_MIME as readonly string[]).includes(mime))
      throw bad('content', 'unsupported_type', 'PDF, JPG or PNG only');
    const name = (filename ?? '')
      .replace(/[\u0000-\u001f\u007f/\\]/g, '')
      .trim()
      .slice(0, 200);
    const u = await this.db.$transaction(async (tx) => {
      const f = await putFileLocked(tx, s.id, data, EXT[mime]);
      return tx.signupSession.update({
        where: { id: s.id },
        data: {
          certificateFileKey: f.key,
          certificateFilename: name || null,
          certificateMime: mime,
          certificateBytes: f.size,
          certificateUploadedAt: new Date(now),
          lastActivityAt: new Date(now),
        },
      });
    });
    // แทนไฟล์เดิม: ลบไฟล์เก่าหลัง commit แล้ว (ล้มเหลว = ค้างในโฟลเดอร์ของ session — ลบทั้งโฟลเดอร์วันที่ 30)
    if (s.certificateFileKey && s.certificateFileKey !== u.certificateFileKey)
      await defaultFileStore()
        .remove(s.certificateFileKey)
        .catch(() => undefined);
    return viewOf(u, now);
  }

  /** ส่งขั้น 2 → company_submitted */
  async submit(
    token: string | undefined,
    body: SubmitCompanyDto,
    meta: { ip?: string },
  ): Promise<SignupSessionView> {
    const now = Date.now();
    const s = await this.editable(token, now);
    const branchCode = body.branchType === 'hq' ? '00000' : body.branchCode!;
    this.assertLookedUp(s, body.taxId);
    await this.countAttempt(s.id, now);
    const dup = await this.lookups.duplicate(body.taxId, branchCode);
    if (dup.duplicate) throw new ProblemException('company_exists');
    // ใช้ผลค้นหาจาก cache (กด "ค้นหา" แล้ว) — ไม่มี/หมดอายุ/เปลี่ยนสาขา = ค้นใหม่ (ผ่าน breaker + log เดียวกัน)
    const o = await this.lookups.lookup(body.taxId, branchCode, { sessionId: s.id });
    const v = verificationOf(o, body.legalName);
    if (v.status === 'pending_manual' && !s.certificateFileKey)
      throw bad('certificateFile', 'certificate_required', 'company certificate is required');
    const address = Object.fromEntries(
      ADDRESS_KEYS.map((k) => [k, (body.address as unknown as CompanyAddress)[k] ?? '']),
    );
    const flags = dup.sameTaxOtherBranch ? ['same_tax_other_branch'] : [];
    const r = await this.db.signupSession.updateMany({
      where: { id: s.id, status: { in: EDITABLE } },
      data: {
        status: 'company_submitted',
        taxId: body.taxId,
        branchCode,
        legalName: body.legalName,
        address: address as Prisma.InputJsonValue,
        fleetSizeOwn: body.fleetSizeOwn,
        fleetSizeSubcon: body.fleetSizeSubcon,
        accountingSoftware: body.accountingSoftware,
        verificationStatus: v.status,
        verificationSource: v.source,
        verificationReason: v.reason,
        companyLookupId: o.lookupId,
        flags,
        termsVersion: termsVersion(),
        privacyVersion: privacyVersion(),
        termsAcceptedAt: new Date(now),
        termsAcceptedIp: meta.ip ?? null,
        marketingOptIn: body.marketingOptIn ?? false,
        companySubmittedAt: new Date(now),
        lastActivityAt: new Date(now),
      },
    });
    if (r.count !== 1) throw new ProblemException('invalid_state_transition');
    const u = await this.db.signupSession.findUniqueOrThrow({ where: { id: s.id } });
    return viewOf(u, now);
  }

  /** เลขซ้ำ tenant เดิม → "ส่งคำขอเข้าร่วมบริษัท" / "ติดต่อเรา" (ส่งถึงผู้ดูแลระบบ/คิวอนุมัติ = T06) */
  async joinRequest(
    token: string | undefined,
    body: JoinCompanyRequestDto,
  ): Promise<SignupSessionView> {
    const now = Date.now();
    const s = await this.editable(token, now);
    const branchCode = body.branchCode ?? '00000';
    this.assertLookedUp(s, body.taxId);
    await this.countAttempt(s.id, now);
    const dup = await this.lookups.duplicate(body.taxId, branchCode);
    if (!dup.duplicate)
      throw bad('taxId', 'not_existing_company', 'no existing company for this tax ID');
    const u = await this.db.signupSession.update({
      where: { id: s.id },
      data: {
        taxId: body.taxId,
        branchCode,
        joinRequestKind: body.kind,
        joinTenantId: dup.duplicate.tenantId,
        joinRequestedAt: new Date(now),
        lastActivityAt: new Date(now),
      },
    });
    this.event('signup.join_requested', {
      sessionId: s.id,
      kind: body.kind,
      tenantId: dup.duplicate.tenantId,
    });
    return withJoinName(this.db, u, viewOf(u, now));
  }
}
