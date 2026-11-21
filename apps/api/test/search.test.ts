import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import { SYSTEM_ROLES } from '@tms/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId } from '../src/common/ids';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import {
  api,
  bootApp,
  issuedTestFields,
  platform,
  tokenFor,
  truncateAll,
  validTaxId,
} from './helpers';

type Hit = {
  type: string;
  id: string;
  label: string | null;
  matchedOn: string;
  status: string | null;
  customerName: string | null;
  customerRef: string | null;
  plate: string | null;
  orderId: string | null;
  tripId: string | null;
  overdue: boolean;
  [k: string]: unknown;
};

const ADDR = { line1: 'x', subdistrict: 'x', district: 'x', province: 'x', postcode: '10000' };

/** ชุดข้อมูลต่อ tenant: ลูกค้า, SO + DO (PO), เที่ยว, ใบแจ้งหนี้ที่ออกแล้ว (PO), ใบวางบิล, รถ + คนขับประจำ */
async function seed(db: PrismaClient, tenantId: string, tag: string, n: number) {
  const co = await db.company.create({
    data: { tenantId, legalName: `Co ${tag}`, taxId: validTaxId(3100 + n) },
  });
  const br = await db.branch.create({
    data: { tenantId, companyId: co.id, branchCode: '00000', branchLabel: 'HQ', address: ADDR },
  });
  const cus = await db.customer.create({
    data: {
      tenantId,
      code: `C-${tag}`,
      legalName: `บริษัท สยามค้นหา ${tag} จำกัด`,
      taxId: validTaxId(3200 + n),
    },
  });
  const site = (k: string) =>
    db.customerSite.create({
      data: { tenantId, code: `S${k}-${tag}`, name: `Site ${k}`, address: { line1: 'x' } },
    });
  const [a, b] = [await site('A'), await site('B')];
  const so = await db.salesOrder.create({
    data: {
      tenantId,
      soNo: `SO-${tag}-2611-0042`,
      source: 'MANUAL',
      customerId: cus.id,
      billingCompanyId: co.id,
      customerRef: `PO-${tag}-7788`,
      requestedDate: new Date('2026-11-12'),
      status: 'RECEIVED',
      stops: {
        create: [
          { tenantId, sequence: 1, type: 'PICKUP', siteId: a.id, siteText: 'A' },
          { tenantId, sequence: 2, type: 'DELIVERY', siteId: b.id, siteText: 'B' },
        ],
      },
      lines: { create: [{ tenantId, lineNo: 1, description: 'x', qtyOrdered: '2', unit: 'TON' }] },
    },
    include: { lines: true },
  });
  const trip = await db.trip.create({
    data: {
      tenantId,
      tripNo: `TRP-${tag}-2611-0007`,
      tripDate: new Date('2026-11-12'),
      vehiclePlateSnapshot: '70-1234',
    },
  });
  const d = await db.deliveryOrder.create({
    data: {
      tenantId,
      doNo: `DO-${tag}-2611-0042`,
      doDate: new Date('2026-11-12'),
      salesOrderId: so.id,
      customerId: cus.id,
      tripId: trip.id,
      originSiteId: a.id,
      destSiteId: b.id,
      originStopSeq: 1,
      destStopSeq: 2,
      customerRef: `PO-${tag}-7788`,
      lines: {
        create: [
          {
            tenantId,
            lineNo: 1,
            salesOrderLineId: so.lines[0]!.id,
            soLineNo: 1,
            description: 'x',
            qtyPlanned: '2',
            unit: 'TON',
          },
        ],
      },
    },
  });
  const inv = await db.invoice.create({
    data: {
      tenantId,
      customerId: cus.id,
      issuingCompanyId: co.id,
      issuingBranchId: br.id,
      customerPoNo: `PO-${tag}-9911`,
      totalAmount: '1070.00',
      status: 'ISSUED',
      ...issuedTestFields(`INV-${tag}-2611-0003`),
    },
  });
  const bn = await db.billingNote.create({
    data: {
      tenantId,
      customerId: cus.id,
      issuingCompanyId: co.id,
      issuingBranchId: br.id,
      status: 'ISSUED',
      billingNoteNo: `BN-${tag}-2611-0001`,
      billingDate: new Date('2026-11-20T00:00:00.000Z'),
      collectionDate: new Date('2026-12-05T00:00:00.000Z'),
      issuedAt: new Date(),
      issuedBy: 'test',
      customerSnapshot: { name: 'x', taxId: null, branchCode: null, address: '' },
      issuerSnapshot: { name: 'x', taxId: null, branchCode: '00000', address: '' },
      printOptions: { yearStyle: 'BE', templateVersion: 1 },
    },
  });
  const vt = await db.vehicleType.create({
    data: { tenantId, code: `VT-${tag}`, nameTh: `หกล้อ ${tag}`, vehicleClass: '6W' },
  });
  const veh = await db.vehicle.create({
    data: {
      tenantId,
      plate: `7${n}-5566`,
      plateProvince: 'TH-10',
      plateKey: `7${n}5566|TH-10`,
      plateNorm: `7${n}5566`,
      vehicleTypeId: vt.id,
      ownership: 'OWN',
    },
  });
  await db.driver.create({
    data: {
      tenantId,
      code: `D-${tag}`,
      name: `สมชาย ${tag}`,
      phone: `081000000${n}`,
      phoneNorm: `081000000${n}`,
      employmentType: 'EMPLOYEE_SALARIED',
      defaultVehicleId: veh.id,
    },
  });
  return { cus, so, d, trip, inv, bn, veh };
}

describe('ค้นหา global ⌘K (ST9-T09)', { timeout: 300_000 }, () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantA: string;
  let tenantB: string;
  let sandboxA: string;
  let A: Awaited<ReturnType<typeof seed>>;
  let admin: string;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantA = (await createTenantWithDefaults(db, { name: 'บริษัท ค้นหา A' })).id;
    tenantB = (await createTenantWithDefaults(db, { name: 'บริษัท ค้นหา B' })).id;
    sandboxA = (
      await db.tenant.create({ data: { name: 'sbx', mode: 'test', liveTenantId: tenantA } })
    ).id;
    A = await seed(db, tenantA, 'AAA', 1);
    await seed(db, tenantB, 'BBB', 2);
    admin = await tokenFor(tenantA, '*', 'u-admin');
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
  });

  const find = async (token: string, q: string, extra = '') => {
    const r = await api(app, token).get(`/v1/search?q=${encodeURIComponent(q)}${extra}`);
    return r;
  };
  const hits = async (token: string, q: string) => {
    const r = await find(token, q);
    expect(r.status).toBe(200);
    return r.body as { q: string; searched: string[]; data: Hit[] };
  };

  it('พิมพ์เลข DO บางส่วน → เจอ DO พร้อม id ของ SO/เที่ยว (ไว้เปิดเอกสาร)', async () => {
    const r = await hits(admin, '  aaa-2611-004 ');
    expect(r.q).toBe('aaa-2611-004');
    const doHit = r.data.find((h) => h.type === 'deliveryOrder');
    expect(doHit).toMatchObject({
      id: encodeId('deliveryOrder', A.d.id),
      label: 'DO-AAA-2611-0042',
      matchedOn: 'number',
      status: 'DRAFT',
      customerName: 'บริษัท สยามค้นหา AAA จำกัด',
      orderId: encodeId('salesOrder', A.so.id),
      tripId: encodeId('trip', A.trip.id),
    });
    expect(r.data.find((h) => h.type === 'order')?.label).toBe('SO-AAA-2611-0042');
    // ไม่มียอดเงินในผลเลย
    expect(JSON.stringify(r)).not.toMatch(/1070|amount|price/i);
  });

  it('ค้นได้ทุกชนิด: เที่ยว / ใบแจ้งหนี้ / ใบวางบิล / PO / ลูกค้า / ทะเบียน (normalize)', async () => {
    const t = await hits(admin, 'TRP-AAA');
    expect(t.data).toEqual([
      expect.objectContaining({ type: 'trip', label: 'TRP-AAA-2611-0007', plate: '70-1234' }),
    ]);
    const inv = await hits(admin, 'inv-aaa');
    expect(inv.data).toEqual([
      expect.objectContaining({ type: 'invoice', label: 'INV-AAA-2611-0003', status: 'ISSUED' }),
    ]);
    const bn = await hits(admin, 'BN-AAA');
    expect(bn.data).toEqual([
      expect.objectContaining({ type: 'billingNote', label: 'BN-AAA-2611-0001' }),
    ]);
    // PO ลูกค้า: SO + DO (customerRef) และใบแจ้งหนี้ (customerPoNo)
    const po = await hits(admin, 'PO-AAA');
    expect(po.data.map((h) => [h.type, h.matchedOn]).sort()).toEqual(
      [
        ['deliveryOrder', 'po'],
        ['invoice', 'po'],
        ['order', 'po'],
      ].sort(),
    );
    const cust = await hits(admin, 'สยามค้นหา');
    expect(cust.data).toEqual([
      expect.objectContaining({
        type: 'customer',
        label: 'บริษัท สยามค้นหา AAA จำกัด',
        code: 'C-AAA',
      }),
    ]);
    // ทะเบียน: พิมพ์เลขไทย/มีขีด/ช่องว่าง ก็เจอ (สูตรเดียวกับหน้าทะเบียนรถ)
    const veh = await hits(admin, '๗๑ 55');
    expect(veh.data).toEqual([
      expect.objectContaining({
        type: 'vehicle',
        id: encodeId('vehicle', A.veh.id),
        label: '71-5566',
        vehicleType: 'หกล้อ AAA',
        driverName: 'สมชาย AAA',
      }),
    ]);
  });

  it('ไม่เห็นผลของ tenant อื่น (และ sandbox ไม่เห็นข้อมูลจริง)', async () => {
    const r = await hits(admin, 'BBB');
    expect(r.data).toEqual([]);
    const b = await hits(await tokenFor(tenantB, '*', 'u-b'), '2611');
    expect(b.data.length).toBeGreaterThan(0);
    expect(b.data.every((h) => !String(h.label).includes('AAA'))).toBe(true);
    const sbx = await hits(await tokenFor(sandboxA, '*', 'u-admin'), '2611');
    expect(sbx.data).toEqual([]);
  });

  it('ตามสิทธิ์: ค้นเฉพาะชนิดที่อ่านได้ · ไม่มีสิทธิ์อ่านเลย = 403', async () => {
    const acct = await tokenFor(tenantA, 'invoices:read', 'u-acct');
    const r = await hits(acct, 'AAA');
    expect(r.searched).toEqual(['invoice', 'billingNote']);
    expect(new Set(r.data.map((h) => h.type))).toEqual(new Set(['invoice', 'billingNote']));
    const viewer = await tokenFor(tenantA, SYSTEM_ROLES.viewer.permissions.join(' '), 'u-view');
    const v = await hits(viewer, 'AAA');
    for (const h of v.data) expect(v.searched).toContain(h.type);
    const none = await find(await tokenFor(tenantA, 'settings:read', 'u-x'), 'AAA');
    expect(none.status).toBe(403);
    expect(none.body.code).toBe('permission_denied');
  });

  it('ขอบเขตคำค้น: < 2 หรือ > 64 ตัว = 422 · % และ _ เป็นตัวอักษรธรรมดา · limit ต่อชนิด', async () => {
    expect((await find(admin, ' a ')).status).toBe(422);
    expect((await find(admin, 'x'.repeat(65))).status).toBe(422);
    expect((await find(admin, 'AAA', '&limit=11')).status).toBe(422);
    expect((await hits(admin, '%%')).data).toEqual([]);
    expect((await hits(admin, '__')).data).toEqual([]);
    // backslash เป็นตัวอักษรธรรมดา (ไม่ใช่ escape ของ LIKE) — ไม่ error และไม่ตรงอะไร
    expect((await hits(admin, 'AAA\\2611')).data).toEqual([]);
    expect((await hits(admin, '\\\\')).data).toEqual([]);
    // เลขไทยในเลขเอกสาร → อารบิก
    expect((await hits(admin, 'TRP-AAA-๒๖๑๑')).data.map((h) => h.label)).toEqual([
      'TRP-AAA-2611-0007',
    ]);
    const one = await find(admin, 'AAA', '&limit=1');
    expect(one.status).toBe(200);
    const per = new Map<string, number>();
    for (const h of one.body.data as Hit[]) per.set(h.type, (per.get(h.type) ?? 0) + 1);
    expect(Math.max(...per.values())).toBe(1);
  });

  it('เรียงตรงทั้งคำ → ขึ้นต้นด้วย → มีอยู่', async () => {
    const vt = await db.vehicleType.findFirstOrThrow({ where: { tenantId: tenantA } });
    for (const [p, k] of [
      ['1-7155', '17155'],
      ['7155', '7155'],
    ] as const)
      await db.vehicle.create({
        data: {
          tenantId: tenantA,
          plate: p,
          plateProvince: 'TH-20',
          plateKey: `${k}|TH-20`,
          plateNorm: k,
          vehicleTypeId: vt.id,
          ownership: 'OWN',
        },
      });
    const r = await hits(admin, '7155');
    expect(r.data.filter((h) => h.type === 'vehicle').map((h) => h.label)).toEqual([
      '7155',
      '71-5566',
      '1-7155',
    ]);
  });

  it('ไม่ต้อง login = 401', async () => {
    expect((await api(app).get('/v1/search?q=AAA')).status).toBe(401);
  });
});
