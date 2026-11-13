import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import type { CookieOptions, Request, Response } from 'express';
import { Public, RequireStepUp } from '../common/decorators';
import { ProblemException } from '../common/problem';
import { ApiServiceBusyResponse } from './auth-tx';
import { requestContext } from '../common/request-context';
import { PrismaService } from '../db/prisma.service';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { isLocalEnv, signStepUpToken, STEP_UP_TTL_SECONDS } from './tokens';

export const TRUSTED_COOKIE = 'tms_td';
const CODE_TTL = 60;

function trustedCookie(expires?: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: !isLocalEnv(),
    sameSite: 'strict',
    path: '/v1/auth',
    ...(expires ? { expires } : {}),
  };
}

export class MfaTokenDto {
  @ApiProperty({ description: 'mfaToken จาก problem mfa_required / mfa_enrollment_required' })
  @IsString()
  @MaxLength(100)
  mfaToken!: string;
}

export class MfaVerifyDto extends MfaTokenDto {
  @ApiPropertyOptional({ example: '123456', description: 'รหัส 6 หลักจากแอป' })
  @IsOptional()
  @Matches(/^\d{6}$/)
  otp?: string;

  @ApiPropertyOptional({
    example: 'abcd-efgh',
    description: 'backup code (ใช้แทน otp ได้ครั้งเดียว)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  backupCode?: string;

  @ApiPropertyOptional({
    default: false,
    description: 'จำอุปกรณ์นี้ 30 วัน (cookie httpOnly `tms_td`)',
  })
  @IsOptional()
  @IsBoolean()
  rememberDevice?: boolean;
}

export class MfaEnrollConfirmDto extends MfaTokenDto {
  @ApiProperty({ example: '123456' })
  @Matches(/^\d{6}$/)
  otp!: string;
}

export class SecondFactorDto {
  @ApiPropertyOptional({ example: '123456' })
  @IsOptional()
  @Matches(/^\d{6}$/)
  otp?: string;

  @ApiPropertyOptional({ example: 'abcd-efgh' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  backupCode?: string;
}

export class AuthCodeDto {
  @ApiProperty() code!: string;
  @ApiProperty({ example: 60 }) expiresIn!: number;
}
export class EnrollStartDto {
  @ApiProperty({ description: 'secret base32 (ให้พิมพ์เองถ้าสแกน QR ไม่ได้)' }) secret!: string;
  @ApiProperty({ example: 'otpauth://totp/TMS:me@example.co.th?secret=…' }) otpauthUri!: string;
}
export class EnrollDoneDto extends AuthCodeDto {
  @ApiProperty({ type: [String], description: 'backup code 10 ชุด — แสดงครั้งเดียว' })
  backupCodes!: string[];
}
export class StepUpDto {
  @ApiProperty({ description: 'ส่งใน header X-Step-Up ของ request ที่ต้อง step-up' })
  stepUpToken!: string;
  @ApiProperty({ example: 300 }) expiresIn!: number;
}
export class BackupCodesDto {
  @ApiProperty({ type: [String] }) backupCodes!: string[];
}
export class TwoFactorStatusDto {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ description: 'role/องค์กรบังคับให้ใช้' }) required!: boolean;
  @ApiProperty() backupCodesRemaining!: number;
}

/**
 * 2FA TOTP (ST1-T05; docs/04 A1) — ขั้นที่ 2 ของ login + step-up
 * login → 401 mfa_required {mfaToken} → POST /auth/2fa/verify → code → /oauth/token ตามเดิม
 * login → 401 mfa_enrollment_required {mfaToken} → /auth/2fa/enroll → /auth/2fa/enroll/confirm → code + backup codes
 */
@ApiTags('auth')
@Controller()
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Post('auth/2fa/verify')
  @ApiServiceBusyResponse()
  @HttpCode(200)
  @ApiOkResponse({ type: AuthCodeDto })
  async verify(
    @Body() body: MfaVerifyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthCodeDto> {
    if (!body.otp && !body.backupCode) throw new ProblemException('invalid_otp');
    const client = clientOf(req);
    const { row, user } = await this.mfa.challenge(body.mfaToken, 'verify');
    const pass = await this.mfa.serialized(user, async (db) => {
      if (await this.isLocked(user, db)) return 'locked' as const;
      const ok = await this.mfa.checkSecondFactor(user, body, db);
      if (!ok) await this.mfa.recordOtpFailure(user, client, db);
      return ok;
    });
    await this.rethrowLocked(pass, user);
    if (!pass) throw new ProblemException('invalid_otp');
    if (!(await this.mfa.consume(row.id))) throw new ProblemException('mfa_expired');
    await this.mfa.recordOtpSuccess(user, client, body.backupCode ? 'mfa_backup_ok' : 'mfa_ok');
    if (body.backupCode)
      await this.mfa.audit(user, 'security.backup_code_used', client.ip, {
        remaining: await this.mfa.remainingBackupCodes(user),
      });
    if (body.rememberDevice) {
      const d = await this.mfa.trustDevice(user, client);
      res.cookie(TRUSTED_COOKIE, d.token, trustedCookie(d.expiresAt));
      await this.mfa.audit(user, 'security.device_trusted', client.ip, { expiresAt: d.expiresAt });
    }
    return { code: await this.auth.issueAuthCode(user, row.codeChallenge), expiresIn: CODE_TTL };
  }

  @Public()
  @Post('auth/2fa/enroll')
  @HttpCode(200)
  @ApiOkResponse({ type: EnrollStartDto })
  async enrollStart(@Body() body: MfaTokenDto): Promise<EnrollStartDto> {
    const { row, user } = await this.mfa.challenge(body.mfaToken, 'enroll', false);
    return this.mfa.startEnroll(row.id, user);
  }

  @Public()
  @Post('auth/2fa/enroll/confirm')
  @ApiServiceBusyResponse()
  @HttpCode(200)
  @ApiOkResponse({ type: EnrollDoneDto })
  async enrollConfirm(
    @Body() body: MfaEnrollConfirmDto,
    @Req() req: Request,
  ): Promise<EnrollDoneDto> {
    const client = clientOf(req);
    const { row, user } = await this.mfa.challenge(body.mfaToken, 'enroll');
    const codes = await this.mfa.serialized(user, async (db) => {
      if (await this.isLocked(user, db)) return 'locked' as const;
      const c = await this.mfa.confirmEnroll(row.pendingSecret, user, body.otp, db);
      if (!c) await this.mfa.recordOtpFailure(user, client, db);
      return c;
    });
    await this.rethrowLocked(codes, user);
    if (!codes || codes === 'locked') throw new ProblemException('invalid_otp');
    if (!(await this.mfa.consume(row.id))) throw new ProblemException('mfa_expired');
    await this.mfa.recordOtpSuccess(user, client, 'mfa_enrolled');
    await this.mfa.audit(user, 'security.2fa_enabled', client.ip);
    return {
      code: await this.auth.issueAuthCode(user, row.codeChallenge),
      expiresIn: CODE_TTL,
      backupCodes: codes,
    };
  }

  /** step-up: ยืนยัน 2FA ซ้ำก่อนทำรายการเสี่ยง (เปลี่ยน role ฯลฯ) — ใช้ซ้ำได้ทุก endpoint ด้วย @RequireStepUp() */
  @Post('auth/step-up')
  @ApiServiceBusyResponse()
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOkResponse({ type: StepUpDto })
  async stepUp(@Body() body: SecondFactorDto, @Req() req: Request): Promise<StepUpDto> {
    const client = clientOf(req);
    const user = await this.currentUser();
    if (!user.totpEnabledAt) throw new ProblemException('two_factor_not_enabled');
    if (!(body.otp || body.backupCode)) throw new ProblemException('invalid_otp');
    // ทีละ request ต่อผู้ใช้ + เพดานเดียวกับ login — กันเดารหัสด้วย access token ที่ขโมยมา (review T05 B3)
    const ok = await this.mfa.serialized(user, async (db) => {
      if (await this.isLocked(user, db)) return 'locked' as const;
      const pass = await this.mfa.checkSecondFactor(user, body, db);
      if (!pass) await this.mfa.recordOtpFailure(user, client, db);
      return pass;
    });
    await this.rethrowLocked(ok, user);
    if (!ok) throw new ProblemException('invalid_otp');
    await this.mfa.audit(user, 'security.step_up', client.ip);
    return {
      stepUpToken: await signStepUpToken(user.id, user.tenantId),
      expiresIn: STEP_UP_TTL_SECONDS,
    };
  }

  @Get('me/2fa')
  @ApiBearerAuth()
  @ApiOkResponse({ type: TwoFactorStatusDto })
  async status(): Promise<TwoFactorStatusDto> {
    const user = await this.currentUser();
    const need = await this.mfa.requirement(user);
    return {
      enabled: !!user.totpEnabledAt,
      required: need !== 'none',
      backupCodesRemaining: user.totpEnabledAt ? await this.mfa.remainingBackupCodes(user) : 0,
    };
  }

  /** ออก backup code ชุดใหม่ (ชุดเดิมใช้ไม่ได้ทันที) — ต้อง step-up */
  @Post('me/2fa/backup-codes')
  @HttpCode(200)
  @RequireStepUp()
  @ApiBearerAuth()
  @ApiOkResponse({ type: BackupCodesDto })
  async regenerate(@Req() req: Request): Promise<BackupCodesDto> {
    const user = await this.currentUser();
    const backupCodes = await this.mfa.replaceBackupCodes(user);
    await this.mfa.audit(user, 'security.backup_codes_regenerated', clientOf(req).ip);
    return { backupCodes };
  }

  /**
   * ตรวจล็อกภายใน transaction — คืนค่าแทนการ throw เพื่อให้แถวครั้งผิดที่เขียนใน transaction เดียวกัน commit ได้
   * (throw ใน transaction = rollback)
   */
  private async isLocked(
    user: Parameters<MfaService['lockedFor']>[0],
    db: Parameters<MfaService['lockedFor']>[1],
  ) {
    return (await this.mfa.lockedFor(user, db)) > 0;
  }

  private async rethrowLocked(result: unknown, user: Parameters<MfaService['lockedFor']>[0]) {
    if (result !== 'locked') return;
    const locked = await this.mfa.lockedFor(user);
    throw new ProblemException('account_locked', undefined, undefined, {
      retryAfter: Math.max(1, locked),
    });
  }

  private async currentUser() {
    const ctx = requestContext.require();
    const user = await this.prisma.platform.appUser.findFirst({
      where: { id: ctx.actorId, tenantId: ctx.tenantId, status: 'ACTIVE' },
    });
    if (!user) throw new ProblemException('unauthorized');
    return user;
  }
}

function clientOf(req: Request) {
  return { ip: req.ip ?? 'unknown', userAgent: req.header('user-agent') ?? undefined };
}
