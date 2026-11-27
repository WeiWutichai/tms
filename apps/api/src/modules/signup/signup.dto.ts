import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsThaiTaxId } from '../../common/thai-tax-id';

const trimLower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** ขั้น 1 "สร้างบัญชี" (P1-ST2-T03; spec/01 §2 ขั้น 1) */
export class StartSignupDto {
  @ApiProperty({
    example: 'สมชาย ใจดี',
    description: 'ชื่อ-นามสกุล (ช่องเดียวตามต้นแบบ — ตรงกับ `name` ของผู้ใช้)',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiProperty({ example: 'name@company.co.th' })
  @Transform(trimLower)
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({
    example: '+66812345678',
    description:
      'เบอร์มือถือไทย E.164 (+66 ตามด้วย 9 หลัก) — รับ 08x / +66 8x ได้ ระบบ normalize ให้',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  mobile!: string;

  @ApiProperty({
    format: 'password',
    description: '≥ 12 ตัว ไม่อยู่ในรายการรหัสที่รั่ว (นโยบาย ST1-T02)',
  })
  @IsString()
  @MaxLength(1024)
  password!: string;

  @ApiPropertyOptional({ enum: ['th', 'en'], description: 'ภาษาของข้อความ OTP (ค่าเริ่ม th)' })
  @IsOptional()
  @IsIn(['th', 'en'])
  locale?: string;
}

export class VerifySignupOtpDto {
  @ApiProperty({ example: '123456', description: 'รหัส 6 หลัก' })
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}

export class SignupOtpStateDto {
  @ApiProperty({ enum: ['email', 'sms'], description: 'ช่องทางที่ส่งรหัส (อีเมลจนกว่า X-04)' })
  channel!: string;
  @ApiProperty({ description: 'ปลายทางที่ส่งรหัสไป (อีเมลหรือเบอร์ของผู้สมัคร)' })
  sentTo!: string;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'รหัสหมดอายุ (5 นาทีหลังส่ง) · null = ไม่มีรหัสที่ใช้ได้ (ต้องขอใหม่)',
  })
  expiresAt!: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'ขอรหัสใหม่ได้ตั้งแต่เวลานี้ (60 วินาทีหลังส่ง)',
  })
  resendAvailableAt!: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'ล็อกถึง (ผิด 5 ครั้ง → 15 นาที)',
  })
  lockedUntil!: string | null;
  @ApiProperty({ description: 'ใส่ผิดได้อีกกี่ครั้งก่อนล็อก' })
  attemptsLeft!: number;
}

export class SignupSessionDto {
  @ApiProperty({
    enum: [
      'account_pending_otp',
      'account_verified',
      'company_submitted',
      'completed',
      'abandoned',
    ],
  })
  status!: string;
  @ApiProperty({ description: 'ขั้นของ stepper: 1 บัญชี · 2 บริษัท · 3 แพ็กเกจ' })
  step!: number;
  @ApiProperty()
  name!: string;
  @ApiProperty()
  email!: string;
  @ApiProperty({ example: '+66812345678' })
  mobile!: string;
  @ApiProperty({
    type: SignupOtpStateDto,
    nullable: true,
    description: 'สถานะ OTP — มีเฉพาะ account_pending_otp',
  })
  otp!: SignupOtpStateDto | null;
  @ApiProperty({
    type: () => SignupCompanyStateDto,
    nullable: true,
    description:
      'ข้อมูลบริษัทที่ส่งแล้ว (ขั้น 2) — ใช้ prefill เมื่อย้อนกลับมาแก้ · null = ยังไม่ส่ง',
  })
  company!: SignupCompanyStateDto | null;
  @ApiProperty({
    type: () => SignupCertificateDto,
    nullable: true,
    description: 'หนังสือรับรองบริษัทที่แนบแล้ว (ขั้น 2)',
  })
  certificate!: SignupCertificateDto | null;
  @ApiProperty({
    type: () => SignupJoinRequestDto,
    nullable: true,
    description: 'คำขอเข้าร่วมบริษัทเดิม / ติดต่อเรา (เลขซ้ำ tenant เดิม)',
  })
  joinRequest!: SignupJoinRequestDto | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'std',
    description: 'แพ็กเกจที่เลือกในขั้น 3 (P1-ST2-T05)',
  })
  planCode!: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'ขอนัด demo แล้ว (แพ็กเกจตกลงราคา — ไม่สร้างบริษัท)',
  })
  demoRequestedAt!: string | null;
}

export class SignupStartResultDto {
  @ApiProperty({
    description:
      'token ทำต่อ — ส่งใน header `X-Signup-Token` ของคำขอถัดไป · แสดงครั้งเดียว (ระบบเก็บแค่ hash) · login ด้วยอีเมล/รหัสของการสมัครได้ token ใหม่',
  })
  token!: string;
  @ApiProperty({ type: SignupSessionDto })
  session!: SignupSessionDto;
}

// ───────── P1-ST2-T04 ขั้น 2 "ข้อมูลบริษัท" (spec/01 §2 ขั้น 2, PLT-020–023) ─────────

const digits = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replace(/[\s-]/g, '') : value;
const cleanText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value;

/**
 * โปรแกรมบัญชีที่ใช้ — ข้อมูล lead เท่านั้น ไม่เปิด connector (ตัวเลือก "ไม่มี" ก่อน แล้วตามตัวอักษร — spec/01 §2)
 * ค่าตรงกับรหัสรูปแบบส่งออกเดิม (`flowaccount` ใน AccountantExportDialog) — **เป็น enum ของ lead ไม่ใช่ key ของ ErpAdapter**
 * (ถ้าภายหลังมีโฟลเดอร์ adapter ชื่อเดียวกันแล้ว lint-adapters กฎ 4 เตือน ให้ยกเว้นเฉพาะไฟล์นี้)
 */
export const ACCOUNTING_SOFTWARE = [
  'none',
  'express',
  'flowaccount',
  'krs',
  'peak',
  'sap_b1',
  'other',
] as const;

export class LookupCompanyDto {
  @ApiProperty({
    example: '0105567153766',
    description:
      'เลขผู้เสียภาษี 13 หลัก — checksum ผิด = 422 `thai_tax_id` (ไม่ส่งเลขออกไปหน่วยงานใด)',
  })
  @Transform(digits)
  @IsString()
  @IsThaiTaxId()
  taxId!: string;

  @ApiPropertyOptional({
    example: '00000',
    description: 'รหัสสาขา 5 หลัก (ค่าเริ่ม 00000 = สำนักงานใหญ่)',
  })
  @IsOptional()
  @Transform(digits)
  @Matches(/^\d{5}$/)
  branchCode?: string;
}

export class CompanyAddressDto {
  @ApiProperty({ example: '99/1', description: 'เลขที่ (รวมอาคาร/ชั้น/ห้อง ถ้ามี)' })
  @Transform(cleanText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  houseNo!: string;
  @ApiProperty({ example: '4', description: 'หมู่ (ว่างได้)' })
  @Transform(cleanText)
  @IsString()
  @MaxLength(20)
  moo!: string;
  @ApiProperty({ example: '', description: 'ซอย (ว่างได้)' })
  @Transform(cleanText)
  @IsString()
  @MaxLength(100)
  soi!: string;
  @ApiProperty({ example: 'พระราม 2', description: 'ถนน (ว่างได้)' })
  @Transform(cleanText)
  @IsString()
  @MaxLength(100)
  street!: string;
  @ApiProperty({ example: 'แสมดำ', description: 'แขวง/ตำบล' })
  @Transform(cleanText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  subDistrict!: string;
  @ApiProperty({ example: 'บางขุนเทียน', description: 'เขต/อำเภอ' })
  @Transform(cleanText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  district!: string;
  @ApiProperty({ example: 'กรุงเทพมหานคร' })
  @Transform(cleanText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  province!: string;
  @ApiProperty({ example: '10150', description: 'รหัสไปรษณีย์ 5 หลัก' })
  @Transform(digits)
  @Matches(/^\d{5}$/)
  postalCode!: string;
}

export class SubmitCompanyDto {
  @ApiProperty({
    example: '0105567153766',
    description: 'ต้องเป็นเลขที่กด "ค้นหา" ล่าสุด (ไม่งั้น 422 `lookup_required`)',
  })
  @Transform(digits)
  @IsString()
  @IsThaiTaxId()
  taxId!: string;

  @ApiProperty({ enum: ['hq', 'branch'], description: 'hq ⇒ รหัสสาขา 00000' })
  @IsIn(['hq', 'branch'])
  branchType!: 'hq' | 'branch';

  @ApiPropertyOptional({
    example: '00001',
    description: 'รหัสสาขา 5 หลัก (บังคับเมื่อ branch, ไม่ใช่ 00000)',
  })
  @ValidateIf((o: SubmitCompanyDto) => o.branchType === 'branch')
  @Transform(digits)
  @Matches(/^(?!00000)\d{5}$/)
  branchCode?: string;

  @ApiProperty({
    example: 'บริษัท ตัวอย่างขนส่ง จำกัด',
    description: 'ชื่อนิติบุคคล (prefill จาก RD แก้ได้)',
  })
  @Transform(cleanText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  legalName!: string;

  @ApiProperty({ type: CompanyAddressDto, description: 'ที่อยู่ออกใบกำกับภาษี แยกฟิลด์' })
  @ValidateNested()
  @Type(() => CompanyAddressDto)
  address!: CompanyAddressDto;

  @ApiProperty({ example: 20, minimum: 0, maximum: 5000, description: 'รถบริษัท (โดยประมาณ)' })
  @IsInt()
  @Min(0)
  @Max(5000)
  fleetSizeOwn!: number;

  @ApiProperty({ example: 8, minimum: 0, maximum: 5000, description: 'รถร่วม (โดยประมาณ)' })
  @IsInt()
  @Min(0)
  @Max(5000)
  fleetSizeSubcon!: number;

  @ApiProperty({
    enum: ACCOUNTING_SOFTWARE,
    description: 'โปรแกรมบัญชีที่ใช้ — ข้อมูล lead เท่านั้น ไม่เปิด connector ใด ๆ',
  })
  @IsIn(ACCOUNTING_SOFTWARE)
  accountingSoftware!: (typeof ACCOUNTING_SOFTWARE)[number];

  @ApiProperty({ example: true, description: 'ยอมรับเงื่อนไขการใช้บริการ (ต้องเป็น true)' })
  @Equals(true)
  acceptTerms!: boolean;

  @ApiProperty({
    example: true,
    description: 'ยอมรับนโยบายความเป็นส่วนตัว (ต้องเป็น true) — เก็บเวอร์ชัน + เวลา + IP',
  })
  @Equals(true)
  acceptPrivacy!: boolean;

  @ApiPropertyOptional({ example: false, description: 'รับข่าวสาร (ไม่บังคับ)' })
  @IsOptional()
  @IsBoolean()
  marketingOptIn?: boolean;
}

export class CertificateQueryDto {
  @ApiPropertyOptional({ example: 'หนังสือรับรอง.pdf', description: 'ชื่อไฟล์เดิม (แสดงผล)' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  filename?: string;
}

export class JoinCompanyRequestDto {
  @ApiProperty({ example: '0105567153766' })
  @Transform(digits)
  @IsString()
  @IsThaiTaxId()
  taxId!: string;

  @ApiPropertyOptional({ example: '00000' })
  @IsOptional()
  @Transform(digits)
  @Matches(/^\d{5}$/)
  branchCode?: string;

  @ApiProperty({
    enum: ['join', 'contact'],
    description:
      'join = ส่งคำขอเข้าร่วมบริษัท (ถึงผู้ดูแลระบบของบริษัทเดิม) · contact = ติดต่อเรา (เข้าคิวทีมงาน)',
  })
  @IsIn(['join', 'contact'])
  kind!: 'join' | 'contact';
}

export class CompanyAddressViewDto {
  @ApiProperty() houseNo!: string;
  @ApiProperty() moo!: string;
  @ApiProperty() soi!: string;
  @ApiProperty() street!: string;
  @ApiProperty() subDistrict!: string;
  @ApiProperty() district!: string;
  @ApiProperty() province!: string;
  @ApiProperty() postalCode!: string;
}

export class RegistryCompanyDto {
  @ApiProperty({ example: 'บริษัท ตัวอย่างขนส่ง จำกัด' }) legalName!: string;
  @ApiProperty({ example: 0 }) branchNumber!: number;
  @ApiProperty({ type: String, nullable: true, example: 'สำนักงานใหญ่' }) branchName!:
    string | null;
  @ApiProperty({ type: CompanyAddressViewDto }) address!: CompanyAddressViewDto;
  @ApiProperty({
    type: String,
    nullable: true,
    example: '2024-05-02',
    description: 'วันที่อนุมัติเป็นผู้จด VAT',
  })
  vatRegisteredSince!: string | null;
}

export class DuplicateCompanyDto {
  @ApiProperty({ example: 'บริษัท ศรีไทยขนส่ง จำกัด' }) companyName!: string;
  @ApiProperty({ type: String, nullable: true, example: 'สำนักงานใหญ่' }) branchLabel!:
    string | null;
}

export class CompanyLookupResultDto {
  @ApiProperty({ example: '0105567153766' }) taxId!: string;
  @ApiProperty({ example: '00000' }) branchCode!: string;
  @ApiProperty({
    enum: ['duplicate', 'vat_found', 'tin_exists', 'not_found', 'unavailable', 'individual'],
    description:
      'duplicate = เลขนี้ใช้ TMS อยู่แล้ว (ไม่มีปุ่มสร้างบริษัท) · vat_found = พบผู้จด VAT (prefill) · tin_exists = มีเลขในฐานสรรพากรแต่ไม่จด VAT · not_found = ไม่พบ · unavailable = ค้นไม่ได้ตอนนี้ (RD ล่ม/ปิดวงจร) · individual = บุคคลธรรมดา (ไม่ส่งเลขออก)',
  })
  result!: string;
  @ApiProperty({
    enum: ['rd_vat', 'rd_tin'],
    nullable: true,
    description: 'แหล่งข้อมูลจริง — ใช้แสดงป้าย "ข้อมูลจากกรมสรรพากร"',
  })
  source!: string | null;
  @ApiProperty({ type: RegistryCompanyDto, nullable: true }) company!: RegistryCompanyDto | null;
  @ApiProperty({ type: DuplicateCompanyDto, nullable: true })
  duplicate!: DuplicateCompanyDto | null;
  @ApiProperty({ description: 'เลขเดียวกันมีใน TMS แต่สาขาต่าง — สร้างได้ ทีมขายจะดู' })
  sameTaxOtherBranch!: boolean;
  @ApiProperty({ description: 'ต้องแนบหนังสือรับรองบริษัท (pending_manual)' })
  requiresCertificate!: boolean;
}

export class SignupCertificateDto {
  @ApiProperty({ type: String, nullable: true, example: 'หนังสือรับรอง.pdf' }) filename!:
    string | null;
  @ApiProperty({ example: 'application/pdf' }) mime!: string;
  @ApiProperty({ example: 120345 }) bytes!: number;
}

export class SignupCompanyStateDto {
  @ApiProperty({ example: '0105567153766' }) taxId!: string;
  @ApiProperty({ example: '00000' }) branchCode!: string;
  @ApiProperty({ type: String, nullable: true }) legalName!: string | null;
  @ApiProperty({ type: CompanyAddressViewDto, nullable: true })
  address!: CompanyAddressViewDto | null;
  @ApiProperty({ type: Number, nullable: true }) fleetSizeOwn!: number | null;
  @ApiProperty({ type: Number, nullable: true }) fleetSizeSubcon!: number | null;
  @ApiProperty({ enum: ACCOUNTING_SOFTWARE, nullable: true }) accountingSoftware!: string | null;
  @ApiProperty({
    enum: ['auto_vat', 'pending_manual', 'pending_verification'],
    nullable: true,
    description: 'ผลตรวจตอนส่งขั้น 2 — auto_vat = พบผู้จด VAT และชื่อตรง',
  })
  verificationStatus!: string | null;
  @ApiProperty({ enum: ['rd_vat', 'rd_tin'], nullable: true }) verificationSource!: string | null;
  @ApiProperty() marketingOptIn!: boolean;
  @ApiProperty({ type: SignupCertificateDto, nullable: true })
  certificate!: SignupCertificateDto | null;
  @ApiProperty({ type: String, format: 'date-time' }) submittedAt!: string;
}

export class SignupJoinRequestDto {
  @ApiProperty({ enum: ['join', 'contact'] }) kind!: string;
  @ApiProperty({ example: 'บริษัท ศรีไทยขนส่ง จำกัด', type: String, nullable: true })
  companyName!: string | null;
  @ApiProperty({ example: '0105567153766' }) taxId!: string;
  @ApiProperty({ type: String, format: 'date-time' }) requestedAt!: string;
}

// ── P1-ST2-T05 ขั้น 3 "เลือกแพ็กเกจ" ──

/** PKCE S256 (เหมือน `POST /v1/auth/login`) */
const PKCE_CHALLENGE = /^[A-Za-z0-9\-._~]{43,128}$/;

export class CompleteSignupDto {
  @ApiProperty({ example: 'std', description: 'รหัสแพ็กเกจจาก `GET …/session/plans`' })
  @IsString()
  @Matches(/^[a-z0-9_-]{1,32}$/)
  planCode!: string;

  @ApiProperty({
    description:
      'PKCE S256: BASE64URL(SHA256(code_verifier)) — ใช้ออก authorization code ให้เข้าแอปทันทีเมื่อสถานะ `trialing`',
  })
  @Matches(PKCE_CHALLENGE)
  codeChallenge!: string;
}

export class SignupPlanChoiceDto {
  @ApiProperty({ example: 'std' }) code!: string;
  @ApiProperty({ example: 'Growth' }) nameTh!: string;
  @ApiProperty({ nullable: true, type: String }) nameEn!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'นิยม' }) badge!: string | null;
  @ApiProperty({ description: 'ตกลงราคากับฝ่ายขาย → "นัด demo" (ไม่สร้างบริษัท)' })
  isContactSales!: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '280.00',
    description:
      'บาท/รถ active/เดือน ก่อน VAT — null = ตกลงราคา หรือยังไม่เปิดราคาสาธารณะ (`pricing.publicVisible = false`)',
  })
  pricePerVehicleMonthly!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ก่อน VAT (null เมื่อไม่เปิดราคา)' })
  minimumMonthly!: string | null;
  @ApiProperty({ example: '15.00' }) annualDiscountPct!: string;
  @ApiProperty({
    type: 'array',
    items: {
      type: 'object',
      properties: { fromVehicle: { type: 'integer' }, discountPct: { type: 'string' } },
    },
    description: 'ส่วนลดตามจำนวนรถ (ว่างเมื่อไม่เปิดราคา)',
  })
  volumeTiers!: { fromVehicle: number; discountPct: string }[];
  @ApiProperty({ example: 16 }) vehicleMin!: number;
  @ApiProperty({ nullable: true, type: Number, example: 60 }) vehicleMax!: number | null;
}

export class SignupPlansDto {
  @ApiProperty({ example: 30, description: 'จำนวนวันทดลองใช้ของบริษัทใหม่ (`trial.days`)' })
  trialDays!: number;
  @ApiProperty({
    description: 'เปิดราคาสาธารณะแล้ว (`pricing.publicVisible`) — false = ไม่แสดงราคา/ประมาณการ',
  })
  pricesVisible!: boolean;
  @ApiProperty({ type: [SignupPlanChoiceDto], description: 'เรียงตาม sortOrder' })
  plans!: SignupPlanChoiceDto[];
}

export class SignupCompletionDto {
  @ApiProperty({
    enum: ['ready', 'pending', 'demo'],
    description:
      'ready = บริษัทสถานะ trialing ("พร้อมใช้งานแล้ว") · pending = pending_verification ("เราได้รับข้อมูลแล้ว") · demo = ขอนัด demo (ไม่สร้างบริษัท)',
  })
  outcome!: string;
  @ApiProperty({ enum: ['trialing', 'pending_verification'], nullable: true, type: String })
  tenantStatus!: string | null;
  @ApiProperty() companyName!: string;
  @ApiProperty({ example: 'std' }) planCode!: string;
  @ApiProperty({ example: 'Growth' }) planName!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) trialEndsAt!: string | null;
}

export class SignupSignInDto {
  @ApiProperty({
    enum: ['code', 'mfa'],
    description:
      'code = authorization code (แลกที่ `POST /v1/oauth/token` ด้วย code_verifier) · mfa = ต้องผ่าน 2FA ก่อน (เหมือน login: `/v1/auth/2fa/*`)',
  })
  kind!: string;
  @ApiPropertyOptional() code?: string;
  @ApiPropertyOptional({ example: 60 }) expiresIn?: number;
  @ApiPropertyOptional() mfaToken?: string;
  @ApiPropertyOptional({ enum: ['verify', 'enroll'] }) purpose?: string;
}

export class SignupCompleteResultDto {
  @ApiProperty({ type: SignupSessionDto }) session!: SignupSessionDto;
  @ApiProperty({ type: SignupCompletionDto }) completion!: SignupCompletionDto;
  @ApiProperty({
    type: SignupSignInDto,
    nullable: true,
    description: 'มีเฉพาะ outcome = ready ครั้งแรก (เรียกซ้ำ = null — เข้าสู่ระบบด้วยรหัสผ่าน)',
  })
  signIn!: SignupSignInDto | null;
}
