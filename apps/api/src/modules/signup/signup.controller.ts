import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiBody,
  ApiConsumes,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators';
import {
  BotProtected,
  OtpSendLimit,
  SignupAttemptLimit,
  SignupCompleteLimit,
} from '../../http/public-entry/public-entry.guard';
import {
  CertificateQueryDto,
  CompanyLookupResultDto,
  CompleteSignupDto,
  SignupCompleteResultDto,
  SignupPlansDto,
  JoinCompanyRequestDto,
  LookupCompanyDto,
  SignupSessionDto,
  SignupStartResultDto,
  StartSignupDto,
  SubmitCompanyDto,
  VerifySignupOtpDto,
} from './signup.dto';
import { SignupCompanyService } from './signup-company.service';
import { SignupCompleteService } from './signup-complete.service';
import { PrismaService } from '../../db/prisma.service';
import { readPlatformSetting } from '../../platform/platform-settings.service';
import { sessionByToken } from './signup.service';
import { SignupService, type SignupSessionView } from './signup.service';

/** PUT หนังสือรับรอง = raw body (≤ 10 MB) — อ่าน body เฉพาะ path นี้ + มี header token รูปถูก (bootstrap.ts) */
export const SIGNUP_CERTIFICATE_PATH = '/v1/public/signup/session/company/certificate';
export function isSignupCertificateUpload(req: {
  url?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
}): boolean {
  if (req.method !== 'PUT') return false;
  const path = (req.url ?? '').split('?')[0];
  if (path !== SIGNUP_CERTIFICATE_PATH) return false;
  const t = req.headers?.['x-signup-token'];
  return typeof t === 'string' && /^[A-Za-z0-9_-]{20,200}$/.test(t);
}

const TOKEN_HEADER = {
  name: 'X-Signup-Token',
  required: true,
  description: 'token ทำต่อที่ได้จาก `POST /v1/public/signup` หรือจาก login (`signup_incomplete`)',
};
const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');

/**
 * สมัครใช้งานเอง ขั้น 1 "สร้างบัญชี" (P1-ST2-T03; spec/01 §2) — ไม่ login (`/v1/public/*` จำกัดต่อ IP)
 * ขั้น 2 "ข้อมูลบริษัท" (P1-ST2-T04) = `session/company*` · ขั้น 3 (แพ็กเกจ + สร้าง tenant, P1-ST2-T05) = `session/plans`, `session/complete`
 */
@ApiTags('public')
@Public()
@Controller('public/signup')
export class SignupController {
  constructor(
    private readonly signup: SignupService,
    private readonly company: SignupCompanyService,
    private readonly completer: SignupCompleteService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @HttpCode(201)
  @SignupAttemptLimit()
  @OtpSendLimit('email')
  @OtpSendLimit('mobile')
  @BotProtected('signup')
  @ApiOperation({
    summary: 'เริ่มสมัคร — ตรวจข้อมูลแล้วส่ง OTP 6 หลัก (อายุ 5 นาที)',
    description:
      'OTP ส่งทางอีเมลจนกว่าจะมีผู้ให้บริการ SMS (X-04) · อีเมลมีบัญชีแล้ว = 409 `account_exists` ("เข้าสู่ระบบเพื่อเพิ่มบริษัทใหม่") · อีเมลที่ยืนยันแล้วและสมัครค้าง = 409 `signup_in_progress` · การสมัครเดิมที่ยังรอ OTP ของอีเมลเดียวกันถูกแทนที่ (ตัวนับใส่รหัสผิดตามไปด้วย)',
  })
  @ApiCreatedResponse({ type: SignupStartResultDto })
  @ApiConflictResponse({ description: 'account_exists / signup_in_progress' })
  @ApiUnprocessableEntityResponse({
    description:
      'validation_failed — field `password` (password_too_short/password_breached), `mobile` (invalid_mobile)',
  })
  async start(
    @Body() body: StartSignupDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SignupStartResultDto> {
    noStore(res);
    return this.signup.start(body, { ip: req.ip });
  }

  @Get('session')
  @ApiHeader(TOKEN_HEADER)
  @ApiOperation({ summary: 'สถานะการสมัคร (ใช้กลับมาทำต่อจากขั้นที่ค้าง)' })
  @ApiOkResponse({ type: SignupSessionDto })
  @ApiUnauthorizedResponse({ description: 'signup_session_invalid — token ผิด/หมดอายุ/ถูกทิ้ง' })
  async get(
    @Headers('x-signup-token') token: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SignupSessionView> {
    noStore(res);
    return this.signup.get(token);
  }

  @Post('session/otp/resend')
  @HttpCode(200)
  @ApiHeader(TOKEN_HEADER)
  @ApiOperation({
    summary: 'ขอรหัสใหม่ — ได้หลัง 60 วินาที ไม่ระหว่างล็อก',
    description:
      'นับเพดาน OTP ต่อผู้รับ (≤ 5 ครั้ง/วัน ต่ออีเมลและต่อเบอร์ — ตัวนับเดียวกับขั้นเริ่มสมัคร) · รหัสเดิมใช้ไม่ได้ทันที',
  })
  @ApiOkResponse({ type: SignupSessionDto })
  @ApiUnauthorizedResponse({ description: 'signup_session_invalid' })
  @ApiConflictResponse({ description: 'invalid_state_transition — ยืนยันรหัสแล้ว' })
  @ApiTooManyRequestsResponse({
    description:
      'otp_resend_too_soon / otp_locked / rate_limited (`scope: recipient`) — มี header Retry-After',
  })
  async resend(
    @Headers('x-signup-token') token: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SignupSessionView> {
    noStore(res);
    return this.signup.resend(token, res);
  }

  @Post('session/otp/verify')
  @HttpCode(200)
  @ApiHeader(TOKEN_HEADER)
  @ApiOperation({
    summary: 'ยืนยันรหัส → account_verified',
    description: 'ผิดสะสม 5 ครั้ง → ล็อก 15 นาที และรหัสเดิมใช้ไม่ได้ (ปลดล็อกแล้วขอรหัสใหม่)',
  })
  @ApiOkResponse({ type: SignupSessionDto })
  @ApiUnauthorizedResponse({ description: 'signup_session_invalid' })
  @ApiUnprocessableEntityResponse({
    description: 'otp_invalid (มี `attemptsLeft`) / otp_expired / validation_failed',
  })
  @ApiTooManyRequestsResponse({ description: 'otp_locked — มี header Retry-After' })
  async verify(
    @Headers('x-signup-token') token: string | undefined,
    @Body() body: VerifySignupOtpDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SignupSessionView> {
    noStore(res);
    return this.signup.verify(token, body.code);
  }

  @Post('session/company/lookup')
  @HttpCode(200)
  @ApiHeader(TOKEN_HEADER)
  @ApiOperation({
    summary: 'ขั้น 2 ปุ่ม "ค้นหา" — เลขซ้ำ → RD VAT Service → RD TIN Service',
    description:
      'เรียกได้หลังยืนยัน OTP · checksum ผิด = 422 (ไม่ส่งเลขออก) · เลขซ้ำ tenant เดิม = `result: duplicate` (ไม่ค้น RD) · ' +
      'ผลค้นหาเก็บ cache 24 ชม. (พบ) / 1 ชม. (ไม่พบ) · ทุกการส่งเลขออกถูกบันทึก (PDPA) · RD ล้มเหลวติดกัน 5 ครั้ง → 5 นาทีถัดไปตอบ `unavailable` ทันที · ' +
      'เลขบุคคลธรรมดา (หลักแรก ≠ 0) ไม่ส่งออก (`individual`) · ค้นได้ ≤ 20 ครั้งต่อการสมัคร',
  })
  @ApiOkResponse({ type: CompanyLookupResultDto })
  @ApiUnauthorizedResponse({ description: 'signup_session_invalid' })
  @ApiConflictResponse({ description: 'invalid_state_transition — ยังไม่ยืนยัน OTP' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed — `taxId` (thai_tax_id)' })
  @ApiTooManyRequestsResponse({ description: 'signup_lookup_limit' })
  async lookup(
    @Headers('x-signup-token') token: string | undefined,
    @Body() body: LookupCompanyDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CompanyLookupResultDto> {
    noStore(res);
    return this.company.lookup(token, body);
  }

  @Put('session/company/certificate')
  @HttpCode(200)
  @ApiHeader(TOKEN_HEADER)
  @ApiConsumes('application/pdf', 'image/jpeg', 'image/png')
  @ApiBody({ description: 'เนื้อไฟล์ (raw) PDF/JPG/PNG ≤ 10 MB — ตรวจชนิดจากเนื้อไฟล์' })
  @ApiOperation({
    summary: 'ขั้น 2 แนบหนังสือรับรองบริษัท (จำเป็นเมื่อไม่พบผู้จด VAT — pending_manual)',
    description: 'อัปโหลดซ้ำ = แทนไฟล์เดิม',
  })
  @ApiOkResponse({ type: SignupSessionDto })
  @ApiUnauthorizedResponse({ description: 'signup_session_invalid' })
  @ApiUnprocessableEntityResponse({
    description: 'validation_failed — `content` (empty_file / file_too_large / unsupported_type)',
  })
  async certificate(
    @Headers('x-signup-token') token: string | undefined,
    @Query() q: CertificateQueryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SignupSessionView> {
    noStore(res);
    const data = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.alloc(0);
    return this.company.uploadCertificate(token, data, q.filename);
  }

  @Post('session/company')
  @HttpCode(200)
  @ApiHeader(TOKEN_HEADER)
  @ApiOperation({
    summary: 'ขั้น 2 ส่งข้อมูลบริษัท → company_submitted',
    description:
      'ตรวจซ้ำฝั่ง server: checksum, เลขซ้ำ (409 `company_exists`), ผลค้น RD (cache หรือค้นใหม่) → `verificationStatus` ' +
      'auto_vat (พบผู้จด VAT + ชื่อตรง) / pending_manual (ไม่จด VAT หรือไม่พบ — ต้องแนบหนังสือรับรอง) / pending_verification (ชื่อไม่ตรง, RD ค้นไม่ได้, บุคคลธรรมดา) · ' +
      'เก็บเวอร์ชันข้อกำหนด/นโยบาย + เวลา + IP · `accountingSoftware` เป็นข้อมูล lead ไม่เปิด connector · แก้ซ้ำได้จนกว่าขั้น 3 สร้างบริษัท',
  })
  @ApiOkResponse({ type: SignupSessionDto })
  @ApiUnauthorizedResponse({ description: 'signup_session_invalid' })
  @ApiConflictResponse({ description: 'company_exists / invalid_state_transition' })
  @ApiUnprocessableEntityResponse({
    description:
      'validation_failed — `taxId` (thai_tax_id), `certificateFile` (certificate_required), ฟิลด์อื่น',
  })
  async submitCompany(
    @Headers('x-signup-token') token: string | undefined,
    @Body() body: SubmitCompanyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SignupSessionView> {
    noStore(res);
    return this.company.submit(token, body, { ip: req.ip });
  }

  @Post('session/company/join-request')
  @HttpCode(200)
  @ApiHeader(TOKEN_HEADER)
  @ApiOperation({
    summary: 'ขั้น 2 เลขซ้ำ → "ส่งคำขอเข้าร่วมบริษัท" / "ติดต่อเรา"',
    description:
      'บันทึกคำขอใน session (ไม่สร้างบริษัท) · การส่งถึงผู้ดูแลระบบของบริษัทเดิม/คิวอนุมัติ = P1-ST2-T06 · เลขไม่ซ้ำ = 422',
  })
  @ApiOkResponse({ type: SignupSessionDto })
  @ApiUnauthorizedResponse({ description: 'signup_session_invalid' })
  @ApiUnprocessableEntityResponse({
    description: 'validation_failed — `taxId` (not_existing_company)',
  })
  async joinRequest(
    @Headers('x-signup-token') token: string | undefined,
    @Body() body: JoinCompanyRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SignupSessionView> {
    noStore(res);
    return this.company.joinRequest(token, body);
  }

  @Get('session/plans')
  @ApiHeader(TOKEN_HEADER)
  @ApiOperation({
    summary: 'ขั้น 3 แพ็กเกจที่เลือกได้ (ทดลองใช้ / นัด demo)',
    description:
      'แพ็กเกจ active + แสดงบนเว็บ ที่มีเวอร์ชันที่มีผล · ราคา (ก่อน VAT) แสดงเมื่อเปิดราคาสาธารณะ (`pricing.publicVisible`) เท่านั้น — ปิดอยู่ = ราคาเป็น null',
  })
  @ApiOkResponse({ type: SignupPlansDto })
  @ApiUnauthorizedResponse({ description: 'signup_session_invalid' })
  async plans(
    @Headers('x-signup-token') token: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SignupPlansDto> {
    noStore(res);
    await sessionByToken(this.prisma.platform, token, Date.now());
    const db = this.prisma.platform;
    const [choices, trialDays, visible] = await Promise.all([
      this.completer.choices(),
      readPlatformSetting<number>(db, 'trial.days'),
      readPlatformSetting<boolean>(db, 'pricing.publicVisible'),
    ]);
    const money = (v: { toFixed(n: number): string } | null) => (v === null ? null : v.toFixed(2));
    return {
      trialDays,
      pricesVisible: !!visible,
      plans: choices.map(({ plan, version: v }) => ({
        code: plan.code,
        nameTh: plan.nameTh,
        nameEn: plan.nameEn,
        badge: plan.badge,
        isContactSales: plan.isContactSales,
        pricePerVehicleMonthly: visible ? money(v.pricePerVehicleMonthly) : null,
        minimumMonthly: visible ? money(v.minimumMonthly) : null,
        // ยังไม่เปิดราคา (D-40) = ไม่เผยโครงราคาใด ๆ (ส่วนลด/ช่วง tier) — review L6
        annualDiscountPct: visible ? v.annualDiscountPct.toFixed(2) : null,
        volumeTiers: visible
          ? ((v.volumeTiers as unknown as { fromVehicle: number; discountPct: string }[]) ?? [])
          : [],
        vehicleMin: visible ? v.vehicleMin : null,
        vehicleMax: visible ? v.vehicleMax : null,
      })),
    };
  }

  @Post('session/complete')
  @HttpCode(200)
  @SignupCompleteLimit()
  @ApiHeader(TOKEN_HEADER)
  @ApiOperation({
    summary: 'ขั้น 3 "เริ่มใช้งาน" — สร้างบริษัทในธุรกรรมเดียว (หรือขอนัด demo)',
    description:
      'สร้าง Tenant + ค่าเริ่มต้นไทย + Subscription (ทดลองใช้ `trial.days` วัน) + นิติบุคคล/สาขาจากขั้น 2 + ผู้ใช้ owner + checklist ตั้งค่า + sandbox ' +
      'ในธุรกรรมเดียว (ล้มกลางทาง = ไม่มีอะไรถูกสร้าง) · ตรวจเลขซ้ำอีกครั้งในธุรกรรม (409 `company_exists`) · ' +
      'สถานะ: `signup.approvalPolicy` = auto_when_verified และผลตรวจ auto_vat → `trialing` (`signIn` = code/2FA เพื่อเข้าแอปทันที) · ' +
      'อื่น ๆ → `pending_verification` (ทีมงานตรวจภายใน 1 วันทำการ) · แพ็กเกจตกลงราคา → บันทึกคำขอนัด demo ไม่สร้างบริษัท · ' +
      'เรียกซ้ำหลังสร้างแล้ว = ผลเดิม (`signIn` = null)',
  })
  @ApiOkResponse({ type: SignupCompleteResultDto })
  @ApiUnauthorizedResponse({ description: 'signup_session_invalid' })
  @ApiConflictResponse({
    description: 'company_exists / account_exists / invalid_state_transition (ยังไม่ส่งขั้น 2)',
  })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed — `planCode` (unknown_plan)' })
  async complete(
    @Headers('x-signup-token') token: string | undefined,
    @Body() body: CompleteSignupDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SignupCompleteResultDto> {
    noStore(res);
    return this.completer.complete(token, body, { ip: req.ip }) as Promise<SignupCompleteResultDto>;
  }
}
