import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, Matches, MaxLength } from 'class-validator';
import { dummyHash, verifyPassword } from '../auth/password';
import {
  PLATFORM_TTL_SECONDS,
  signPlatformChallenge,
  signPlatformToken,
  verifyPlatformChallenge,
} from '../auth/tokens';
import { verifyTotp } from '../auth/totp';
import { FieldCipher } from '../common/crypto';
import { PlatformAuth, Public } from '../common/decorators';
import { ProblemException } from '../common/problem';
import { requestContext } from '../common/request-context';
import { PrismaService } from '../db/prisma.service';

/** ผิด 5 ครั้งติด → ล็อก 15 นาที (เหมือนผู้ใช้ลูกค้า — docs/04 A1) */
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60_000;

export class PlatformLoginDto {
  @ApiProperty({ example: 'admin@innovera.test' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(254)
  email!: string;
  @ApiProperty() @IsString() @MaxLength(256) password!: string;
}
export class PlatformChallengeDto {
  @ApiProperty({ description: 'ส่งต่อไป POST /v1/platform/auth/mfa (อายุ 5 นาที)' })
  challenge!: string;
}
export class PlatformMfaDto {
  @ApiProperty() @IsString() @MaxLength(2000) challenge!: string;
  @ApiProperty({ example: '123456' }) @Matches(/^\d{6}$/) code!: string;
}
export class PlatformTokenDto {
  @ApiProperty() accessToken!: string;
  @ApiProperty({ example: PLATFORM_TTL_SECONDS }) expiresIn!: number;
}
export class PlatformMeDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['SUPER_ADMIN', 'SUPPORT', 'BILLING'] }) role!: string;
}

/**
 * login ของ Platform Console (ST1-T24; docs/04 A6) — แยกจากลูกค้าทั้งตารางและ token, บังคับ 2FA ทุกคน
 * รหัสผ่านถูก → challenge (5 นาที) → TOTP ถูก → token Console 8 ชม. · ตอบเหมือนกันเมื่อไม่พบอีเมล/รหัสผิด
 */
@ApiTags('platform-console')
@Controller('platform/auth')
export class PlatformAuthController {
  private cipher?: FieldCipher;
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOkResponse({ type: PlatformChallengeDto })
  async login(@Body() body: PlatformLoginDto): Promise<PlatformChallengeDto> {
    const db = this.prisma.platform;
    const u = await db.platformUser.findUnique({ where: { email: body.email } });
    if (!u) {
      await verifyPassword(await dummyHash(), body.password); // เวลาตอบเท่ากัน
      throw new ProblemException('invalid_credentials');
    }
    if (u.lockedUntil && u.lockedUntil > new Date()) throw new ProblemException('account_locked');
    const ok = await verifyPassword(u.passwordHash, body.password);
    if (!ok || u.status !== 'ACTIVE') {
      await this.fail(u.id);
      throw new ProblemException('invalid_credentials');
    }
    return { challenge: await signPlatformChallenge(u.id) };
  }

  @Public()
  @Post('mfa')
  @HttpCode(200)
  @ApiOkResponse({ type: PlatformTokenDto })
  async mfa(@Body() body: PlatformMfaDto): Promise<PlatformTokenDto> {
    const db = this.prisma.platform;
    const id = await verifyPlatformChallenge(body.challenge);
    if (!id) throw new ProblemException('mfa_expired');
    const u = await db.platformUser.findUnique({ where: { id } });
    if (!u || u.status !== 'ACTIVE') throw new ProblemException('mfa_expired');
    if (u.lockedUntil && u.lockedUntil > new Date()) throw new ProblemException('account_locked');
    const secret = (this.cipher ??= new FieldCipher()).decrypt(u.totpSecret);
    const last = u.totpLastStep === null ? null : Number(u.totpLastStep);
    const step = verifyTotp(secret, body.code, last);
    if (step === null) {
      await this.fail(u.id);
      throw new ProblemException('invalid_otp');
    }
    // บันทึก step ที่ใช้แล้ว (กันใช้รหัสเดิมซ้ำ) แบบมีเงื่อนไข — สอง request พร้อมกันผ่านได้ครั้งเดียว
    const claimed = await db.platformUser.updateMany({
      where: {
        id: u.id,
        OR: [{ totpLastStep: null }, { totpLastStep: { lt: BigInt(step) } }],
      },
      data: {
        totpLastStep: BigInt(step),
        failedLogins: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      },
    });
    if (claimed.count !== 1) throw new ProblemException('invalid_otp');
    return {
      accessToken: await signPlatformToken({ sub: u.id, role: u.role, tv: u.tokenVersion }),
      expiresIn: PLATFORM_TTL_SECONDS,
    };
  }

  @PlatformAuth()
  @Get('me')
  @ApiBearerAuth()
  @ApiOkResponse({ type: PlatformMeDto })
  async me(): Promise<PlatformMeDto> {
    const id = requestContext.require().platformUser!.id;
    const u = await this.prisma.platform.platformUser.findUniqueOrThrow({ where: { id } });
    return { id: u.id, email: u.email, name: u.name, role: u.role };
  }

  /** ออกจากระบบทุกเครื่อง: bump tokenVersion (token เดิมใช้ไม่ได้ทันที) */
  @PlatformAuth()
  @Post('logout')
  @HttpCode(204)
  @ApiBearerAuth()
  async logout(): Promise<void> {
    const id = requestContext.require().platformUser!.id;
    await this.prisma.platform.platformUser.update({
      where: { id },
      data: { tokenVersion: { increment: 1 } },
    });
  }

  private async fail(id: string) {
    await this.prisma.platform.$executeRaw`
      UPDATE platform_user
         SET failed_logins = failed_logins + 1,
             locked_until = CASE WHEN failed_logins + 1 >= ${MAX_FAILED}
                                 THEN now() + (${LOCK_MS}::int * interval '1 millisecond') ELSE locked_until END,
             updated_at = now()
       WHERE id = ${id}::uuid`;
  }
}
