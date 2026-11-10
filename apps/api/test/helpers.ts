import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { signDevToken } from '../src/auth/auth.guard';
import { createApp } from '../src/bootstrap';

export const platform = () =>
  new PrismaClient({ datasources: { db: { url: process.env.PLATFORM_DATABASE_URL } } });

/** ลบข้อมูลทุกตาราง business (ใช้ role owner เพื่อ TRUNCATE ได้) */
export async function truncateAll(): Promise<void> {
  const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const tables = await owner.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length) {
    await owner.$executeRawUnsafe(
      `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`,
    );
  }
  await owner.$disconnect();
}

export async function createTenant(db: PrismaClient, name = `tenant-${randomUUID().slice(0, 8)}`) {
  return db.tenant.create({ data: { name } });
}

export async function tokenFor(tenantId: string, scope = '*', sub = 'user-test') {
  return signDevToken({ sub, tid: tenantId, scope });
}

export async function bootApp(): Promise<NestExpressApplication> {
  return createApp();
}

/** สร้างเลขผู้เสียภาษีที่ checksum ถูกต้องจาก seed ตัวเลข */
export function validTaxId(seed: number): string {
  const base = String(1_000_000_000_00 + seed)
    .padStart(12, '0')
    .slice(-12);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

export function api(app: NestExpressApplication, token?: string) {
  const server = app.getHttpServer();
  const withAuth = (t: request.Test) => (token ? t.set('Authorization', `Bearer ${token}`) : t);
  return {
    get: (url: string) => withAuth(request(server).get(url)),
    post: (url: string) => withAuth(request(server).post(url)),
    patch: (url: string) => withAuth(request(server).patch(url)),
    put: (url: string) => withAuth(request(server).put(url)),
    delete: (url: string) => withAuth(request(server).delete(url)),
  };
}
