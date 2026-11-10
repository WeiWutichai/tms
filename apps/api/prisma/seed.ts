/**
 * Seed/demo (ST0-T16) — รันซ้ำได้ ข้อมูลเท่าเดิม (upsert ด้วย id คงที่)
 * - tenant DEMO_A: บริษัทขนส่งตัวอย่าง (ใช้เดโม/พัฒนา UI)
 * - tenant DEMO_B: tenant ที่สอง ใช้ทดสอบการแยกข้อมูลด้วยมือ
 * ข้อมูลสมมติทั้งหมด: ชื่อขึ้นต้น "ตัวอย่าง" และเลขผู้เสียภาษีขึ้นต้น 0000000000 (ไม่ใช่เลขที่กรมสรรพากรออกจริง)
 * stage ถัดไปเพิ่ม seed ของตัวเองในไฟล์ prisma/seed/*.ts แล้วเรียกจากที่นี่
 */
import { PrismaClient } from '@prisma/client';
import { ROLE_CODES, type RoleCode } from '@tms/domain';
import { signDevToken } from '../src/auth/auth.guard';
import { hashPassword } from '../src/auth/password';
import { isLocalEnv } from '../src/auth/tokens';
import { FORCED_2FA_ROLES } from '../src/auth/mfa.service';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { sha256 } from '../src/auth/tokens';
import { FieldCipher } from '../src/common/crypto';
import { ensureDefaultSeries } from '../src/modules/sequences/sequences.service';

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

/** สาขาเดโม (ST1-T14) — ที่อยู่สมมติ */
const ADDR = (line1: string) => ({
  line1,
  subdistrict: 'ตัวอย่าง',
  district: 'เมืองตัวอย่าง',
  province: 'กรุงเทพมหานคร',
  postcode: '10000',
});
const BRANCHES = [
  {
    id: '00000000-0000-4000-8000-0000000b0a01',
    tenantId: DEMO_A,
    companyId: '00000000-0000-4000-8000-0000000c0a01',
    branchCode: '00000',
    branchLabel: 'สำนักงานใหญ่',
    address: ADDR('1/1 ถนนตัวอย่าง'),
    isDefaultIssuer: true,
  },
  {
    id: '00000000-0000-4000-8000-0000000b0a02',
    tenantId: DEMO_A,
    companyId: '00000000-0000-4000-8000-0000000c0a01',
    branchCode: '00001',
    branchLabel: 'สาขาที่ 00001',
    address: ADDR('2/2 ถนนตัวอย่าง'),
    isDefaultIssuer: false,
  },
  {
    id: '00000000-0000-4000-8000-0000000b0a03',
    tenantId: DEMO_A,
    companyId: '00000000-0000-4000-8000-0000000c0a02',
    branchCode: '00000',
    branchLabel: 'สำนักงานใหญ่',
    address: ADDR('3/3 ถนนตัวอย่าง'),
    isDefaultIssuer: true,
  },
  {
    id: '00000000-0000-4000-8000-0000000b0b01',
    tenantId: DEMO_B,
    companyId: '00000000-0000-4000-8000-0000000c0b01',
    branchCode: '00000',
    branchLabel: 'สำนักงานใหญ่',
    address: ADDR('4/4 ถนนตัวอย่าง'),
    isDefaultIssuer: true,
  },
];

/**
 * ผู้ใช้เดโม (ST1-T01, T12) — ใช้ login ในเครื่อง dev/e2e เท่านั้น; production ไม่รัน seed นี้
 * demo-a มีผู้ใช้ 1 คนต่อ role มาตรฐาน (`<role>@demo-a.test`) ไว้ลองสิทธิ์ตามตาราง A3
 * ทุกคนใช้รหัส DEMO_PASSWORD · id คงที่: ...0e0a0N (N = ลำดับ role)
 */
export const DEMO_PASSWORD = 'demo-password-2569';
/**
 * 2FA ของผู้ใช้เดโมที่ role บังคับ (owner, admin, accounting — ST1-T05): เพิ่ม secret นี้ในแอป Authenticator
 * (พิมพ์เอง: JBSW Y3DP EHPK 3PXP) เพื่อ login ด้วยมือ · E2E ใช้ cookie อุปกรณ์ที่จำไว้ DEMO_TRUSTED_DEVICE ข้ามขั้นนี้
 * ข้อมูลเดโมเท่านั้น — production ไม่รัน seed
 */
export const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
export const DEMO_TRUSTED_DEVICE = 'demo-trusted-device-e2e-only-0000000000000';
const DEMO_NAMES: Record<RoleCode, string> = {
  owner: 'เจ้าของ ตัวอย่าง',
  admin: 'ผู้ดูแล ตัวอย่าง',
  manager: 'ผู้จัดการ ตัวอย่าง',
  planner: 'วางแผน ตัวอย่าง',
  dispatcher: 'จ่ายงาน ตัวอย่าง',
  invoicer: 'วางบิล ตัวอย่าง',
  accounting: 'บัญชี ตัวอย่าง',
  approver: 'อนุมัติ ตัวอย่าง',
  viewer: 'ดูอย่างเดียว ตัวอย่าง',
};
const USERS: Array<{ id: string; tenantId: string; email: string; name: string; role: RoleCode }> =
  [
    ...ROLE_CODES.map((role, i) => ({
      id: `00000000-0000-4000-8000-0000000e0a${String(i + 1).padStart(2, '0')}`,
      tenantId: DEMO_A,
      email: `${role}@demo-a.test`,
      name: DEMO_NAMES[role],
      role,
    })),
    {
      id: '00000000-0000-4000-8000-0000000e0b01',
      tenantId: DEMO_B,
      email: 'owner@demo-b.test',
      name: 'เจ้าของ ตัวอย่างบี',
      role: 'owner',
    },
  ];

async function main() {
  // seed มีรหัสผ่าน/secret 2FA/อุปกรณ์ที่จำไว้ของผู้ใช้เดโม — ห้ามรันนอกเครื่อง dev/test เด็ดขาด (review T05 S3)
  if (!isLocalEnv()) throw new Error('seed runs only with NODE_ENV=development or test');
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
  for (const b of BRANCHES) {
    const { id, ...data } = b;
    await db.branch.upsert({ where: { id }, create: b, update: data });
  }
  for (const t of [DEMO_A, DEMO_B]) await ensureDefaultSeries(db, t);
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const cipher = new FieldCipher();
  const roleIds: Record<string, Record<string, string>> = {};
  for (const t of [DEMO_A, DEMO_B]) roleIds[t] = await ensureSystemRoles(db, t);
  for (const u of USERS) {
    const { role, ...data } = u;
    const roleId = roleIds[u.tenantId]![role]!;
    await db.appUser.upsert({
      where: { id: u.id },
      create: { ...data, status: 'ACTIVE', passwordHash },
      update: { email: u.email, name: u.name, status: 'ACTIVE', passwordHash },
    });
    // ผู้ใช้เดโมถือ role เดียวตามชื่ออีเมล (ล้าง role อื่นที่ test อาจเพิ่มไว้)
    await db.userRole.deleteMany({
      where: { tenantId: u.tenantId, userId: u.id, roleId: { not: roleId } },
    });
    const link = await db.userRole.findFirst({
      where: { tenantId: u.tenantId, userId: u.id, roleId },
    });
    if (!link) await db.userRole.create({ data: { tenantId: u.tenantId, userId: u.id, roleId } });
    if (FORCED_2FA_ROLES.includes(role)) {
      const cur = await db.appUser.update({
        where: { id: u.id },
        data: {
          totpSecret: cipher.encrypt(DEMO_TOTP_SECRET),
          totpEnabledAt: new Date('2026-11-10T00:00:00Z'),
          totpLastStep: null,
        },
      });
      const tokenHash = sha256(`${DEMO_TRUSTED_DEVICE}:${u.id}`);
      await db.trustedDevice.upsert({
        where: { tokenHash },
        create: {
          tokenHash,
          tenantId: u.tenantId,
          userId: u.id,
          tokenVersion: cur.tokenVersion,
          expiresAt: new Date('2099-01-01T00:00:00Z'),
          userAgent: 'seed',
        },
        update: { tokenVersion: cur.tokenVersion, revokedAt: null },
      });
    }
  }
  const counts = {
    tenants: await db.tenant.count({ where: { id: { in: [DEMO_A, DEMO_B] } } }),
    companies: await db.company.count({ where: { tenantId: { in: [DEMO_A, DEMO_B] } } }),
  };
  await db.$disconnect();
  console.log('seed ok', counts);
  if (isLocalEnv() && process.env.AUTH_DEV_SECRET) {
    console.log('dev token A:', await signDevToken({ sub: 'demo-admin', tid: DEMO_A }, '12h'));
    console.log('dev token B:', await signDevToken({ sub: 'demo-admin', tid: DEMO_B }, '12h'));
  }
}

void main();
