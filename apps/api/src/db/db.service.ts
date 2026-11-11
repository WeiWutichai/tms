import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { requestContext } from '../common/request-context';
import { PrismaService } from './prisma.service';

export type Tx = Prisma.TransactionClient;

@Injectable()
export class DbService {
  constructor(private readonly prisma: PrismaService) {}

  /** client ของ transaction ปัจจุบัน (1 request = 1 transaction ที่ตั้ง app.tenant_id แล้ว) */
  get tx(): Tx {
    const tx = requestContext.get()?.tx;
    if (!tx)
      throw new Error('no transaction in context — route must run under TransactionInterceptor');
    return tx;
  }

  /** เปิด transaction ใหม่ภายใต้ tenant ที่ระบุ (ใช้นอก HTTP เช่น worker, test, seed) */
  async withTenant<T>(
    tenantId: string,
    fn: (tx: Tx) => Promise<T>,
    timeoutMs = 15_000,
  ): Promise<T> {
    return this.prisma.app.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return fn(tx as unknown as Tx);
      },
      { timeout: timeoutMs },
    );
  }
}
