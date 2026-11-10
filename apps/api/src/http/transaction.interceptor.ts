import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, lastValueFrom, Observable } from 'rxjs';
import { IS_PUBLIC } from '../common/decorators';
import { requestContext } from '../common/request-context';
import { PrismaService } from '../db/prisma.service';

/**
 * 1 request = 1 transaction ที่ตั้ง `app.tenant_id` ก่อน query แรก (RLS ใช้ค่านี้)
 * ผลข้างเคียงทั้งหมดของ handler (ข้อมูล + history + event + outbox) commit หรือ rollback พร้อมกัน
 */
@Injectable()
export class TransactionInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    const ctx = requestContext.get();
    if (isPublic || !ctx?.tenantId) return next.handle();
    const tenantId = ctx.tenantId;
    return from(
      this.prisma.app.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
          ctx.tx = tx as any;
          try {
            return await lastValueFrom(next.handle(), { defaultValue: undefined });
          } finally {
            ctx.tx = undefined;
          }
        },
        { timeout: 15_000 },
      ),
    );
  }
}
