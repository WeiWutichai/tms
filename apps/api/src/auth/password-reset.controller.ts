import { Body, Controller, HttpCode, Injectable, Post, Req, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiNoContentResponse,
  ApiProperty,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { AppUser } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { ProblemException } from '../common/problem';
import { requestContext } from '../common/request-context';
import { PrismaService } from '../db/prisma.service';
import { EmailService } from '../modules/email/email.service';
import { Public } from '../common/decorators';
import { hashPassword } from './password';
import { PasswordPolicy } from './password-policy';
import { isLocalEnv, newOpaqueToken, sha256 } from './tokens';

/** PLT-032: ลิงก์อายุ 30 นาที ใช้ครั้งเดียว */
export const RESET_TTL_MS = 30 * 60 * 1000;
/** ขอได้ 3 ครั้ง/15 นาทีต่ออีเมล และ 10 ครั้ง/15 นาทีต่อ IP (นับทุกคำขอ ไม่ว่าอีเมลมีในระบบหรือไม่ — ไม่เผยข้อมูล) */
export const RESET_WINDOW_MS = 15 * 60 * 1000;
export const RESET_MAX_PER_EMAIL = 3;
export const RESET_MAX_PER_IP = 10;

const lower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class ForgotPasswordDto {
  @ApiProperty({ example: 'name@company.co.th' })
  @Transform(lower)
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'token จากลิงก์ในอีเมล' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  token!: string;

  @ApiProperty({
    format: 'password',
    description: '≥ 12 ตัว, ไม่อยู่ในรายการรหัสที่รั่ว, ไม่ซ้ำ 5 ครั้งล่าสุด (ST1-T02)',
  })
  @IsString()
  @MaxLength(1024)
  newPassword!: string;
}

/** ฐาน URL ของเว็บสำหรับลิงก์ในอีเมล — ห้ามเอาจาก Host header (ผู้โจมตีปลอม host ให้ลิงก์ชี้ไปเว็บตัวเองได้) */
export function webBaseUrl(env = process.env): string {
  const base = env.PUBLIC_WEB_BASE_URL ?? (isLocalEnv() ? 'http://localhost:4420' : undefined);
  if (!base) throw new Error('PUBLIC_WEB_BASE_URL is required outside development/test');
  return base.replace(/\/+$/, '');
}

@Injectable()
export class PasswordResetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly policy: PasswordPolicy,
  ) {}

  /** ผู้ใช้ที่ตั้งรหัสใหม่ได้: ACTIVE ในบริษัทที่ยังใช้งานได้ (อีเมลเดียว = ตัวตนเดียวข้ามบริษัท — spec/01 §3) */
  private async usersOf(email: string): Promise<AppUser[]> {
    const db = this.prisma.platform;
    const users = await db.appUser.findMany({ where: { email, status: 'ACTIVE' } });
    if (!users.length) return [];
    const ok = await db.tenant.findMany({
      where: { id: { in: users.map((u) => u.tenantId) }, status: { in: ['TRIAL', 'ACTIVE'] } },
      select: { id: true },
    });
    return users.filter((u) => ok.some((t) => t.id === u.tenantId));
  }

  /**
   * ขอลิงก์ — ตอบเหมือนกันเสมอไม่ว่ามีอีเมลหรือไม่ (A1) · สร้างแถว token ทุกครั้ง (งานเท่ากันทั้งสองกรณี)
   * คืนวินาทีที่ต้องรอถ้าเกินเพดาน (0 = รับคำขอ)
   */
  async forgot(email: string, ip: string): Promise<number> {
    const now = Date.now();
    const since = new Date(now - RESET_WINDOW_MS);
    return this.prisma.platform.$transaction(async (tx) => {
      // ล็อกต่ออีเมลและต่อ IP — คำขอพร้อมกันนับเพดานถูก
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(4, hashtext(${email}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(5, hashtext(${ip}))`;
      const [byEmail, byIp] = await Promise.all([
        tx.passwordResetToken.findMany({
          where: { email, createdAt: { gte: since } },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
        tx.passwordResetToken.findMany({
          where: { ip, createdAt: { gte: since } },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
      ]);
      const wait = (rows: { createdAt: Date }[], max: number) =>
        rows.length >= max
          ? Math.max(
              1,
              Math.ceil(
                (rows[rows.length - max]!.createdAt.getTime() + RESET_WINDOW_MS - now) / 1000,
              ),
            )
          : 0;
      const retry = Math.max(wait(byEmail, RESET_MAX_PER_EMAIL), wait(byIp, RESET_MAX_PER_IP));
      if (retry > 0) return retry;
      const { token, hash } = newOpaqueToken();
      await tx.passwordResetToken.create({
        data: { tokenHash: hash, email, ip, expiresAt: new Date(now + RESET_TTL_MS) },
      });
      const users = await this.usersOf(email);
      if (users.length) {
        const latest = [...users].sort(
          (a, b) => (b.lastLoginAt?.getTime() ?? 0) - (a.lastLoginAt?.getTime() ?? 0),
        )[0]!;
        await this.email.enqueue(tx, {
          tenantId: null,
          to: email,
          template: 'password_reset',
          locale: latest.locale,
          vars: {
            link: `${webBaseUrl()}/reset-password#token=${token}`,
            minutes: RESET_TTL_MS / 60_000,
          },
        });
      }
      return 0;
    });
  }

  /** ตั้งรหัสใหม่ด้วย token — ใช้ครั้งเดียว; รหัสไม่ผ่านนโยบาย → 422 โดย token ยังใช้ต่อได้ */
  async reset(token: string, password: string, meta: { ip?: string; requestId?: string }) {
    const db = this.prisma.platform;
    const invalid = () => new ProblemException('reset_link_invalid');
    const row = await db.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) throw invalid();
    const users = await this.usersOf(row.email);
    if (!users.length) throw invalid();
    // ตรวจนโยบายกับทุกบัญชีของอีเมลนี้ (ประวัติรหัสแยกต่อบริษัท) ก่อนใช้ token
    for (const u of users) await this.policy.validate(password, u);
    const hash = await hashPassword(password);
    await db.$transaction(async (tx) => {
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) throw invalid();
      for (const u of users) await this.policy.apply(tx, u, hash, 'auth.password_reset', meta);
      // ลิงก์อื่นที่ยังไม่ใช้ของอีเมลนี้ใช้ไม่ได้อีก
      await tx.passwordResetToken.updateMany({
        where: { email: row.email, usedAt: null },
        data: { usedAt: new Date() },
      });
    });
  }
}

/** ลืมรหัสผ่าน (ST1-T03; docs/04 A1; spec/01 PLT-032) — ไม่ต้อง login */
@ApiTags('auth')
@Public()
@Controller('auth/password')
export class PasswordResetController {
  constructor(private readonly svc: PasswordResetService) {}

  @Post('forgot')
  @HttpCode(202)
  @ApiAcceptedResponse({
    description:
      'รับคำขอแล้ว — ตอบแบบเดียวกันเสมอไม่ว่าอีเมลมีในระบบหรือไม่ ถ้ามีจะได้อีเมลลิงก์อายุ 30 นาที',
  })
  @ApiTooManyRequestsResponse({ description: 'rate_limited — ขอถี่เกินไป มี header Retry-After' })
  async forgot(
    @Body() body: ForgotPasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const retry = await this.svc.forgot(body.email, req.ip ?? 'unknown');
    res.setHeader('Cache-Control', 'no-store');
    if (retry > 0)
      throw new ProblemException('rate_limited', undefined, undefined, { retryAfter: retry });
  }

  @Post('reset')
  @HttpCode(204)
  @ApiNoContentResponse({
    description: 'ตั้งรหัสใหม่แล้ว — ทุก session ของทุกบริษัทที่ใช้อีเมลนี้หลุด ต้องเข้าระบบใหม่',
  })
  @ApiBadRequestResponse({ description: 'reset_link_invalid — ลิงก์ผิด หมดอายุ หรือใช้ไปแล้ว' })
  async reset(@Body() body: ResetPasswordDto, @Req() req: Request): Promise<void> {
    const ctx = requestContext.get();
    await this.svc.reset(body.token, body.newPassword, {
      ip: req.ip ?? undefined,
      requestId: ctx?.requestId,
    });
  }
}
