import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { ProblemException } from '../common/problem';
import { requestContext } from '../common/request-context';
import { PrismaService } from '../db/prisma.service';
import { verifyPassword } from './password';
import { PasswordPolicy } from './password-policy';
import { lockSeconds, recordAttempt } from './throttle';

export class ChangePasswordDto {
  @ApiProperty({ format: 'password' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  currentPassword!: string;

  @ApiProperty({
    format: 'password',
    description: '≥ 12 ตัว, ไม่อยู่ในรายการรหัสที่รั่ว, ไม่ซ้ำ 5 ครั้งล่าสุด (ST1-T02)',
  })
  @IsString()
  @MaxLength(1024) // เพดานจริง (256) ตรวจใน PasswordPolicy → code password_too_long
  newPassword!: string;
}

@ApiTags('auth')
@ApiBearerAuth()
@Controller('me')
export class PasswordController {
  constructor(
    private readonly policy: PasswordPolicy,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * เปลี่ยนรหัสผ่านเอง — ต้องรู้รหัสเดิม (นับรวมกับเพดานผิด 5 ครั้ง/15 นาทีของ login — กันเดารหัสด้วย token ที่ขโมยมา)
   * สำเร็จ → bump tokenVersion: ทุก session (รวมเครื่องนี้และอุปกรณ์ที่จำไว้) หลุด ต้องเข้าระบบใหม่
   */
  @Post('password')
  @HttpCode(204)
  @ApiNoContentResponse()
  async change(@Body() body: ChangePasswordDto, @Req() req: Request): Promise<void> {
    const ctx = requestContext.require();
    const db = this.prisma.platform;
    const user = await db.appUser.findFirst({
      where: { id: ctx.actorId, tenantId: ctx.tenantId, status: 'ACTIVE' },
    });
    if (!user?.passwordHash) throw new ProblemException('unauthorized');
    const email = user.email.toLowerCase();
    const client = { ip: req.ip ?? 'unknown', userAgent: req.header('user-agent') ?? undefined };
    const locked = await lockSeconds(db, email, client.ip, Date.now());
    if (locked > 0)
      throw new ProblemException('account_locked', undefined, undefined, { retryAfter: locked });
    // จองความพยายามก่อนตรวจ (เหมือน login) — สำเร็จแล้วค่อยหักด้วยแถว password_ok
    const who = { tenantId: user.tenantId, userId: user.id };
    await recordAttempt(db, email, client, { success: false, reason: 'attempt', ...who });
    if (!(await verifyPassword(user.passwordHash, body.currentPassword))) {
      await recordAttempt(db, email, client, {
        success: false,
        reason: 'password_change_failed',
        ...who,
      });
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'currentPassword',
          code: 'password_incorrect',
          message: 'current password is incorrect',
        },
      ]);
    }
    await recordAttempt(db, email, client, { success: true, reason: 'password_ok', ...who });
    await this.policy.setPassword(user, body.newPassword, {
      ip: client.ip,
      requestId: ctx.requestId,
    });
  }
}
