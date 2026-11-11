import { Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import { ProblemException } from '../common/problem';
import { requestContext } from '../common/request-context';
import { PrismaService } from '../db/prisma.service';

/**
 * ออกจากการเข้าใช้งานแทน (ST1-T24; spec/01 §11 ปุ่ม "ออก" บนแถบส้ม) — เรียกด้วย token ที่สวมอยู่
 * เป็น POST เดียวที่ token อ่านอย่างเดียวทำได้ (AuthGuard ยกเว้น path นี้)
 */
export const END_IMPERSONATION_PATH = '/v1/me/impersonation/end';

@ApiTags('platform')
@ApiBearerAuth()
@Controller('me/impersonation')
export class ImpersonationController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('end')
  @HttpCode(204)
  @ApiNoContentResponse()
  async end(): Promise<void> {
    const ctx = requestContext.require();
    if (!ctx.impersonationSessionId) throw new ProblemException('not_found');
    await this.prisma.platform.$transaction(async (tx) => {
      const r = await tx.impersonationSession.updateMany({
        where: { id: ctx.impersonationSessionId, endedAt: null },
        data: { endedAt: new Date(), endReason: 'manual' },
      });
      if (r.count === 1)
        await tx.auditLog.create({
          data: {
            tenantId: ctx.tenantId!,
            actorId: ctx.actorId ?? null,
            actAs: ctx.actAs ?? null,
            action: 'impersonation.ended',
            entityType: 'impersonation_session',
            entityId: ctx.impersonationSessionId,
            requestId: ctx.requestId,
            ip: ctx.ip ?? null,
          },
        });
    });
  }
}
