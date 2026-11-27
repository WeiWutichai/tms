import { Body, Controller, Get, Headers, HttpCode, Post, Req, Res } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
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
} from '../../http/public-entry/public-entry.guard';
import {
  SignupSessionDto,
  SignupStartResultDto,
  StartSignupDto,
  VerifySignupOtpDto,
} from './signup.dto';
import { SignupService, type SignupSessionView } from './signup.service';

const TOKEN_HEADER = {
  name: 'X-Signup-Token',
  required: true,
  description: 'token ทำต่อที่ได้จาก `POST /v1/public/signup` หรือจาก login (`signup_incomplete`)',
};
const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');

/**
 * สมัครใช้งานเอง ขั้น 1 "สร้างบัญชี" (P1-ST2-T03; spec/01 §2) — ไม่ login (`/v1/public/*` จำกัดต่อ IP)
 * ขั้น 2–3 (ข้อมูลบริษัท / แพ็กเกจ) = P1-ST2-T04/T05
 */
@ApiTags('public')
@Public()
@Controller('public/signup')
export class SignupController {
  constructor(private readonly signup: SignupService) {}

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
}
