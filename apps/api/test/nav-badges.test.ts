import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { EntitlementService } from '../src/modules/entitlements/entitlement.service';
import { OrderIntakeService } from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * D-81 · D68-89 badge งานค้างบน sidebar (docs/03 §1/§4; ต้นแบบ TMS v4 `counts()`) — `GET /v1/me/badges`
 * นับตามนิยามแท็บ/การ์ดของหน้า · เฉพาะเมนูที่ผู้เรียกมีสิทธิ์ + ฟีเจอร์แพ็กเกจเปิด · แยกบริษัท (RLS)
 */
describe('nav badges (D68-89)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tA: string;
  let tB: string;
  let adminA: string;
  let adminB: string;
  const today = bangkokToday();
  const day = (n: number) =>
    new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tA = (await createTenantWithDefaults(db, { name: 'บริษัท ก' })).id;
    tB = (await createTenantWithDefaults(db, { name: 'บริษัท ข' })).id;
    await db.tenant.updateMany({ where: { id: { in: [tA, tB] } }, data: { planCode: 'std' } });
    // นิติบุคคลผู้ออกเอกสาร (routing ของ SO ต้องมี)
    const c = await db.company.create({
      data: { tenantId: tA, legalName: 'บริษัท ก จำกัด', taxId: validTaxId(8001) },
    });
    await db.branch.create({
      data: {
        tenantId: tA,
        companyId: c.id,
        branchCode: '00000',
        branchLabel: 'สำนักงานใหญ่',
        address: ADDR,
        isDefaultIssuer: true,
      },
    });
    adminA = await tokenFor(tA);
    adminB = await tokenFor(tB);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const badges = async (token: string) =>
    Object.fromEntries(
      (
        (await api(app, token).get('/v1/me/badges').expect(200)).body.data as {
          key: string;
          count: number;
        }[]
      ).map((b) => [b.key, b.count]),
    );

  it('ผู้ดูแล: ทุกเมนูที่มี badge (เริ่มต้น 0) · นับ SO ค้าง / Rate card รออนุมัติ / เอกสารรถใกล้หมด · บริษัทอื่นไม่เห็น', async () => {
    expect(await badges(adminA)).toEqual({
      plan: 0,
      exc: 0,
      so: 0,
      bill: 0,
      pay: 0,
      settle: 0,
      erp: 0,
      fdoc: 0,
      rate: 0,
    });

    // SO จากต้นทางที่ยังไม่จับคู่ลูกค้า → ค้าง CUSTOMER_UNMAPPED (แท็บ "ยังไม่จับคู่ลูกค้า")
    await app.get(DbService).withTenant(tA, (tx: Tx) =>
      requestContext.run(
        { requestId: randomUUID(), tenantId: tA, actorId: 'user-test', locale: 'th', tx },
        () =>
          app.get(OrderIntakeService).upsertOrder(
            {
              source: 'API',
              externalId: 'EXT-SO-1',
              customer: { externalId: 'NO-SUCH-CUST', text: 'ร้านไม่รู้จัก' },
              requestedDate: today,
              stops: [
                { type: 'PICKUP', siteText: 'คลังต้นทาง' },
                { type: 'DELIVERY', siteText: 'ปลายทาง' },
              ],
            },
            tx,
          ),
      ),
    );

    // Rate card ร่าง (รออนุมัติ)
    const site = async (name: string) =>
      (
        await api(app, adminA)
          .post('/v1/customer-sites')
          .send({ name, kind: 'DROPOFF', address: ADDR })
          .expect(201)
      ).body.id as string;
    const [a, b] = [await site('ต้นทาง ก'), await site('ปลายทาง ก')];
    const cust = (
      await api(app, adminA)
        .post('/v1/customers')
        .send({ legalName: 'บจก. ลูกค้า ก', taxId: validTaxId(8101) })
        .expect(201)
    ).body.id as string;
    const vt = (
      (await api(app, adminA).get('/v1/vehicle-types?limit=50').expect(200)).body.data as {
        id: string;
        code: string;
      }[]
    ).find((x) => x.code === '6W')!.id;
    await api(app, adminA)
      .post('/v1/rate-cards')
      .send({
        customerId: cust,
        originId: a,
        destinationId: b,
        vehicleTypeId: vt,
        validFrom: day(-1),
        pricingModel: 'PER_TRIP',
        sellRate: '5000',
      })
      .expect(201);

    // เอกสารรถ: หมดใน 10 วัน (นับ) · หมดใน 90 วัน (ไม่นับ)
    const v = (
      await api(app, adminA)
        .post('/v1/vehicles')
        .send({ plate: '70-1234', plateProvince: 'TH-20', vehicleTypeId: vt, ownership: 'OWN' })
        .expect(201)
    ).body.id as string;
    for (const [docType, n] of [
      ['INSURANCE', 10],
      ['COMPULSORY_ACT', 90],
    ] as const)
      await db.vehicleDocument.create({
        data: {
          tenantId: tA,
          vehicleId: tryDecodeId('vehicle', v)!,
          docType,
          startsOn: new Date(`${day(-300)}T00:00:00Z`),
          expiresOn: new Date(`${day(n)}T00:00:00Z`),
        },
      });

    // ST8-T12 คิวเชื่อมระบบบัญชี: นับเฉพาะเนื้อหาเอกสารไม่ตรงที่ยังเปิด (MONEY/FIELD) — ไม่นับที่ยอมรับแล้ว / INFO / ยอดรับชำระ
    const con = await db.connector.create({
      data: { tenantId: tA, adapterKey: 'demo', status: 'PAUSED', taxDocumentOwner: 'TMS' },
    });
    const rec = (diff: object, severity: 'MONEY' | 'FIELD' | 'INFO', ack = false) =>
      db.reconcileResult.create({
        data: {
          tenantId: tA,
          connectorId: con.id,
          entityType: 'INVOICE',
          localId: randomUUID(),
          runAt: new Date(),
          source: 'NIGHTLY',
          localSnapshot: {},
          remoteSnapshot: {},
          diff,
          diffHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
          result: severity === 'INFO' ? 'ERP_UNREACHABLE' : 'MISMATCH',
          severity,
          lastSeenAt: new Date(),
          ...(ack
            ? { acknowledgedAt: new Date(), acknowledgedBy: 'u', ackReason: 'ยอมรับแล้วทดสอบ' }
            : {}),
        },
      });
    await rec({ check: 'DOCUMENT', code: 'content_mismatch' }, 'MONEY');
    await rec({ check: 'DOCUMENT', code: 'content_mismatch' }, 'FIELD', true);
    await rec({ check: 'DOCUMENT', code: 'erp_unreachable' }, 'INFO');
    await rec({ check: 'PAYMENT_STATUS', code: 'remote_less_than_tms' }, 'MONEY');

    const got = await badges(adminA);
    expect(got).toMatchObject({ so: 1, rate: 1, fdoc: 1, exc: 0, pay: 0, erp: 1 });
    // ใบเดียวมีทั้งสองเหตุ (ลูกค้า + สถานที่) → แท็บ SO นับทั้งสองแท็บ แต่ badge นับใบเดียว
    const sum = (await api(app, adminA).get('/v1/orders/summary').expect(200)).body;
    expect([sum.locationUnmapped, sum.customerUnmapped]).toEqual([1, 1]);
    // บริษัทอื่นไม่เห็น (RLS)
    expect(await badges(adminB)).toMatchObject({ so: 0, rate: 0, fdoc: 0, erp: 0 });
  });

  it('เฉพาะเมนูที่มีสิทธิ์: orders:read → so อย่างเดียว · master:read → fdoc + rate · ไม่มีสิทธิ์ใดเลย = ว่าง', async () => {
    expect(Object.keys(await badges(await tokenFor(tA, 'orders:read', 'u-o')))).toEqual(['so']);
    expect(Object.keys(await badges(await tokenFor(tA, 'master:read', 'u-m')))).toEqual([
      'fdoc',
      'rate',
    ]);
    expect(
      Object.keys(await badges(await tokenFor(tA, 'invoices:read settlements:read', 'u-i'))),
    ).toEqual(['bill', 'pay', 'settle']);
    expect(Object.keys(await badges(await tokenFor(tA, 'integrations:read', 'u-n')))).toEqual([
      'erp',
    ]);
    expect(await badges(await tokenFor(tA, 'reports.ops:read', 'u-r'))).toEqual({});
  });

  it('ฟีเจอร์แพ็กเกจปิด (เริ่มต้น: ไม่มี settle / fleet) → ไม่มี badge ของเมนูนั้น · ไม่ login → 401', async () => {
    await db.tenant.update({ where: { id: tB }, data: { planCode: 'start' } });
    app.get(EntitlementService).invalidate(tB);
    const keys = Object.keys(await badges(adminB));
    expect(keys).not.toContain('settle');
    expect(keys).not.toContain('fdoc');
    expect(keys).toContain('so');
    await api(app).get('/v1/me/badges').expect(401);
  });
});
