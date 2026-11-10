import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { ProblemException } from '../common/problem';
import { requestContext } from '../common/request-context';
import { PrismaService } from '../db/prisma.service';
import { verifyPassword } from './password';
import { PASSWORD_MAX, PasswordPolicy } from './password-policy';

export class ChangePasswordDto {
  @ApiProperty({ format: 'password' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX)
  currentPassword!: string;

  @ApiProperty({
    format: 'password',
    description: '≥ 12 ตัว, ไม่อยู่ในรายการรหัสที่รั่ว, ไม่ซ้ำ 5 ครั้งล่าสุด (ST1-T02)',
  })
  @IsString()
  @MaxLength(PASSWORD_MAX)
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

  /** เปลี่ยนรหัสผ่านเอง — ต้องรู้รหัสเดิม; session อื่นของผู้ใช้หลุด (refresh ถูกเพิกถอน) */
  @Post('password')
  @HttpCode(204)
  @ApiNoContentResponse()
  async change(@Body() body: ChangePasswordDto, @Req() req: Request): Promise<void> {
    const ctx = requestContext.require();
    const user = await this.prisma.platform.appUser.findFirst({
      where: { id: ctx.actorId, tenantId: ctx.tenantId, status: 'ACTIVE' },
    });
    if (!user?.passwordHash) throw new ProblemException('unauthorized');
    if (!(await verifyPassword(user.passwordHash, body.currentPassword)))
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'currentPassword',
          code: 'password_incorrect',
          message: 'current password is incorrect',
        },
      ]);
    await this.policy.setPassword(user, body.newPassword);
    await this.prisma.platform.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorId: user.id,
        action: 'security.password_changed',
        entityType: 'user',
        entityId: user.id,
        ip: req.ip ?? null,
        requestId: ctx.requestId,
      },
    });
  }
}
