import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId } from '../src/common/ids';
import { PrismaService } from '../src/db/prisma.service';
import { resolveDocumentEntity } from '../src/modules/routing/document-routing';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll, validTaxId } from './helpers';

const ADDR = { line1: 'x', subdistrict: 'x', district: 'x', province: 'x', postcode: '10000' };

/** ST1-T16: resolver "ออกบิลในนาม" / "จ้างในนาม" ตามลำดับ override → ลูกค้า/รถร่วม → tenant → นิติบุคคลเดียว */
describe('document routing', () => {
  let app: NestExpressApplication;
  const db = platform();
  const prisma = new PrismaService();
  let tenantId: string;
  let admin: string;
  const co: Record<string, string> = {};
  const br: Record<string, string> = {};
  let n = 5000;

  const run = <T>(fn: (tx: any) => Promise<T>) =>
    prisma.app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    });
  const resolve = (input: Parameters<typeof resolveDocumentEntity>[2]) =>
    run((tx) => resolveDocumentEntity(tx, tenantId, input));
  async function company(name: string) {
    const c = await db.company.create({
      data: { tenantId, legalName: name, taxId: validTaxId(++n) },
    });
    const hq = await db.branch.create({
      data: {
        tenantId,
        companyId: c.id,
        branchCode: '00000',
        branchLabel: 'HQ',
        address: ADDR,
        isDefaultIssuer: true,
      },
    });
    return { c, hq };
  }

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenant(db)).id;
    admin = await tokenFor(tenantId, 'settings:read settings:write');
  });
  afterAll(async () => {
    await app.close();
    await prisma.onModuleDestroy();
    await db.$disconnect();
  });

  it('นิติบุคคลเดียว: ไม่ต้องตั้งค่า ใช้ตัวนั้นและสาขา default', async () => {
    const a = await company('บริษัท เอ จำกัด');
    co.a = a.c.id;
    br.a = a.hq.id;
    const r = await resolve({ kind: 'invoice' });
    expect(r).toMatchObject({ source: 'only', company: { id: co.a }, branch: { id: br.a } });
  });

  it('หลายนิติบุคคลแต่ไม่ได้ตั้งค่า → 422 routing_not_configured', async () => {
    const b = await company('บริษัท บี จำกัด');
    co.b = b.c.id;
    br.b = b.hq.id;
    await expect(resolve({ kind: 'invoice' })).rejects.toMatchObject({
      errors: [expect.objectContaining({ code: 'routing_not_configured' })],
    });
  });

  it('ค่าเริ่มต้นของ tenant (แยก invoice / tender)', async () => {
    await api(app, admin)
      .patch('/v1/settings')
      .send({
        values: {
          'routing.invoiceAsCompanyId': encodeId('company', co.a!),
          'routing.tenderAsCompanyId': encodeId('company', co.b!),
        },
      })
      .expect(200);
    expect((await resolve({ kind: 'invoice' })).company.id).toBe(co.a);
    expect(await resolve({ kind: 'tender' })).toMatchObject({
      source: 'tenant',
      company: { id: co.b },
    });
  });

  it('ค่าของลูกค้า/รถร่วมชนะค่าของ tenant; override ของเอกสารชนะทุกอย่าง', async () => {
    expect(await resolve({ kind: 'invoice', partyCompanyId: co.b })).toMatchObject({
      source: 'party',
      company: { id: co.b },
    });
    expect(await resolve({ kind: 'invoice', partyCompanyId: co.b, companyId: co.a })).toMatchObject(
      {
        source: 'override',
        company: { id: co.a },
      },
    );
  });

  it('สาขาที่ให้สำนักงานใหญ่ออกแทน → taxBranch = สำนักงานใหญ่; สาขาของนิติบุคคลอื่น → 422', async () => {
    const s1 = await db.branch.create({
      data: {
        tenantId,
        companyId: co.a!,
        branchCode: '00001',
        branchLabel: 'S1',
        address: ADDR,
        hqPrintsForAll: true,
      },
    });
    const r = await resolve({ kind: 'invoice', companyId: co.a, branchId: s1.id });
    expect(r.branch.id).toBe(s1.id);
    expect(r.taxBranch.id).toBe(br.a);
    await expect(
      resolve({ kind: 'invoice', companyId: co.a, branchId: br.b }),
    ).rejects.toMatchObject({
      errors: [expect.objectContaining({ code: 'branch_unavailable' })],
    });
  });

  it('ตั้งค่า routing ด้วยนิติบุคคลที่ไม่มี/ปิดใช้ → 422', async () => {
    const bad = await api(app, admin)
      .patch('/v1/settings')
      .send({ values: { 'routing.invoiceAsCompanyId': 'cmp_00000000000000000000000000000000' } });
    expect(bad.status).toBe(422);
    await db.company.update({ where: { id: co.b! }, data: { status: 'INACTIVE' } });
    const inactive = await api(app, admin)
      .patch('/v1/settings')
      .send({ values: { 'routing.invoiceAsCompanyId': encodeId('company', co.b!) } });
    expect(inactive.status).toBe(422);
    await expect(resolve({ kind: 'tender' })).rejects.toMatchObject({
      errors: [expect.objectContaining({ code: 'company_unavailable' })],
    });
  });
});
