/**
 * Seed/demo (ST0-T16) — รันซ้ำได้ ข้อมูลเท่าเดิม (upsert ด้วย id คงที่)
 * - tenant DEMO_A: บริษัทขนส่งตัวอย่าง (ใช้เดโม/พัฒนา UI)
 * - tenant DEMO_B: tenant ที่สอง ใช้ทดสอบการแยกข้อมูลด้วยมือ
 * ข้อมูลสมมติทั้งหมด: ชื่อขึ้นต้น "ตัวอย่าง" และเลขผู้เสียภาษีขึ้นต้น 0000000000 (ไม่ใช่เลขที่กรมสรรพากรออกจริง)
 * stage ถัดไปเพิ่ม seed ของตัวเองในไฟล์ prisma/seed/*.ts แล้วเรียกจากที่นี่
 */
import { PrismaClient } from '@prisma/client';
import { signDevToken } from '../src/auth/auth.guard';

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
