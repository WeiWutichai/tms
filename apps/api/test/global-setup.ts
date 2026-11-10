import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { testEnv } from './env';

/** สร้างฐานข้อมูล tms_test (ถ้ายังไม่มี) แล้ว migrate ให้ล่าสุด */
export default async function setup() {
  const env = testEnv();
  const admin = new PrismaClient({
    datasources: { db: { url: env.DATABASE_URL!.replace('/tms_test?', '/postgres?') } },
  });
  const exists = await admin.$queryRaw<
    unknown[]
  >`SELECT 1 FROM pg_database WHERE datname = 'tms_test'`;
  if (exists.length === 0) await admin.$executeRawUnsafe('CREATE DATABASE tms_test');
  await admin.$disconnect();
  execSync('npx prisma migrate deploy', { env: { ...process.env, ...env }, stdio: 'pipe' });
}
