import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { tenantExtension } from './tenant-extension';

function createAppClient(url: string) {
  return new PrismaClient({ datasources: { db: { url } } }).$extends(tenantExtension);
}
export type AppClient = ReturnType<typeof createAppClient>;

/**
 * 2 connection:
 * - app: role `tms_app` (ไม่มี BYPASSRLS) — ทุก request ของ tenant
 * - platform: role `tms_platform` (BYPASSRLS) — worker หยิบงานข้าม tenant, admin portal, seed
 * ห้ามใช้ platform ใน controller ของ tenant
 */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly app: AppClient;
  readonly platform: PrismaClient;

  constructor() {
    const appUrl = process.env.APP_DATABASE_URL;
    const platformUrl = process.env.PLATFORM_DATABASE_URL;
    if (!appUrl || !platformUrl)
      throw new Error('APP_DATABASE_URL / PLATFORM_DATABASE_URL required');
    this.app = createAppClient(appUrl);
    this.platform = new PrismaClient({ datasources: { db: { url: platformUrl } } });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.app.$disconnect(), this.platform.$disconnect()]);
  }
}
