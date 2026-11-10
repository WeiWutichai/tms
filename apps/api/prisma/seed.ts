/**
 * Seed/demo (ST0-T16) — รันซ้ำได้ ข้อมูลเท่าเดิม (upsert ด้วย id คงที่)
 * - tenant DEMO_A: บริษัทขนส่งตัวอย่าง (ใช้เดโม/พัฒนา UI)
 * - tenant DEMO_B: tenant ที่สอง ใช้ทดสอบการแยกข้อมูลด้วยมือ
 * ข้อมูลสมมติทั้งหมด: ชื่อขึ้นต้น "ตัวอย่าง" และเลขผู้เสียภาษีขึ้นต้น 0000000000 (ไม่ใช่เลขที่กรมสรรพากรออกจริง)
 * stage ถัดไปเพิ่ม seed ของตัวเองในไฟล์ prisma/seed/*.ts แล้วเรียกจากที่นี่
 */
import { PrismaClient } from '@prisma/client';
import { signDevToken } from '../src/auth/auth.guard';
import { hashPassword } from '../src/auth/password';

export const DEMO_A = '00000000-0000-4000-8000-00000000000a';
export const DEMO_B = '00000000-0000-4000-8000-00000000000b';

function demoTaxId(n: number): string {
  const base = `0000000000${String(n).padStart(2, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

const COMPANIES = [
  {
    id: '00000000-0000-4000-8000-0000000c0a01',
    tenantId: DEMO_A,
    legalName: 'บริษัท ตัวอย่างขนส่ง จำกัด',
    legalNameEn: 'Example Transport Co., Ltd.',
    taxId: demoTaxId(1),
    externalId: 'DEMO-CMP-1',
  },
  {
    id: '00000000-0000-4000-8000-0000000c0a02',
    tenantId: DEMO_A,
    legalName: 'บริษัท ตัวอย่างโลจิสติกส์ จำกัด',
    legalNameEn: 'Example Logistics Co., Ltd.',
    taxId: demoTaxId(2),
    externalId: 'DEMO-CMP-2',
  },
  {
    id: '00000000-0000-4000-8000-0000000c0b01',
    tenantId: DEMO_B,
    legalName: 'บริษัท ตัวอย่างบีขนส่ง จำกัด',
    legalNameEn: 'Example B Transport Co., Ltd.',
    taxId: demoTaxId(3),
    externalId: null,
  },
];

/**
 * ผู้ใช้เดโม (ST1-T01) — ใช้ login ในเครื่อง dev/e2e เท่านั้น; production ไม่รัน seed นี้
 * role `owner` ชั่วคราวได้ทุกสิทธิ์ ('*') จนกว่า ST1-T12 จะ seed ตาราง A3 ครบ
 */
export const DEMO_PASSWORD = 'demo-password-2569';
const USERS = [
  {
    id: '00000000-0000-4000-8000-0000000e0a01',
    tenantId: DEMO_A,
    email: 'owner@demo-a.test',
    name: 'เจ้าของ ตัวอย่าง',
  },
  {
    id: '00000000-0000-4000-8000-0000000e0b01',
    tenantId: DEMO_B,
    email: 'owner@demo-b.test',
    name: 'เจ้าของ ตัวอย่างบี',
  },
];

async function main() {
  const db = new PrismaClient({ datasources: { db: { url: process.env.PLATFORM_DATABASE_URL } } });
  for (const t of [
    { id: DEMO_A, name: 'ตัวอย่างขนส่ง (DEMO)' },
    { id: DEMO_B, name: 'ตัวอย่างบี (DEMO)' },
  ]) {
    await db.tenant.upsert({
      where: { id: t.id },
      create: { ...t, status: 'ACTIVE' },
      update: { name: t.name },
    });
  }
  for (const c of COMPANIES) {
    const { id, ...data } = c;
    await db.company.upsert({ where: { id }, create: c, update: data });
  }
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  for (const u of USERS) {
    const role = await db.role.upsert({
      where: { tenantId_code: { tenantId: u.tenantId, code: 'owner' } },
      create: {
        tenantId: u.tenantId,
        code: 'owner',
        nameTh: 'เจ้าของ',
        nameEn: 'Owner',
        permissions: ['*'],
        isSystem: true,
      },
      update: {},
    });
    await db.appUser.upsert({
      where: { id: u.id },
      create: { ...u, status: 'ACTIVE', passwordHash },
      update: { email: u.email, name: u.name, status: 'ACTIVE', passwordHash },
    });
    const link = await db.userRole.findFirst({
      where: { tenantId: u.tenantId, userId: u.id, roleId: role.id },
    });
    if (!link)
      await db.userRole.create({ data: { tenantId: u.tenantId, userId: u.id, roleId: role.id } });
  }
  const counts = {
    tenants: await db.tenant.count({ where: { id: { in: [DEMO_A, DEMO_B] } } }),
    companies: await db.company.count({ where: { tenantId: { in: [DEMO_A, DEMO_B] } } }),
  };
  await db.$disconnect();
  console.log('seed ok', counts);
  if (process.env.NODE_ENV !== 'production' && process.env.AUTH_DEV_SECRET) {
    console.log('dev token A:', await signDevToken({ sub: 'demo-admin', tid: DEMO_A }, '12h'));
    console.log('dev token B:', await signDevToken({ sub: 'demo-admin', tid: DEMO_B }, '12h'));
  }
}

void main();
