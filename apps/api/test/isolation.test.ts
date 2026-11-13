import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IS_PUBLIC, PLATFORM_ROLES, TENANT_RESOURCE } from '../src/common/decorators';
import { encodeId } from '../src/common/ids';
import { store } from '../src/modules/documents/documents.controller';
import { signStepUpToken } from '../src/auth/tokens';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * Harness แยก tenant (ST0-T05) — CI แดงเมื่อ:
 * (1) มีตารางที่มีคอลัมน์ tenant_id แต่ไม่เปิด RLS / ไม่ FORCE / ไม่มี policy
 * (2) มี route ที่มี `:id` แต่ไม่ประกาศ @TenantResource หรือไม่มี fixture ในไฟล์นี้
 * (3) เรียก resource ของ tenant A ด้วย token ของ tenant B แล้วไม่ได้ 404
 *
 * เพิ่ม resource ใหม่ = เพิ่ม fixture ใน FIXTURES (สร้างข้อมูลใน tenant A แล้วคืน id ที่ API ใช้)
 */
const FIXTURES: Record<string, (db: PrismaClient, tenantId: string, n: number) => Promise<string>> =
  {
    company: async (db, tenantId, n) =>
      encodeId(
        'company',
        (
          await db.company.create({
            data: { tenantId, legalName: `Co ${n}`, taxId: validTaxId(500 + n) },
          })
        ).id,
      ),
    branch: async (db, tenantId, n) => {
      const c = await db.company.create({
        data: { tenantId, legalName: `Co b${n}`, taxId: validTaxId(700 + n) },
      });
      const b = await db.branch.create({
        data: {
          tenantId,
          companyId: c.id,
          branchCode: '00000',
          branchLabel: 'HQ',
          address: {
            line1: 'x',
            subdistrict: 'x',
            district: 'x',
            province: 'x',
            postcode: '10000',
          },
        },
      });
      return encodeId('branch', b.id);
    },
    customer: async (db, tenantId, n) =>
      encodeId(
        'customer',
        (
          await db.customer.create({
            data: {
              tenantId,
              code: `ISO-${n}`,
              legalName: `Cust ${n}`,
              taxId: validTaxId(900 + n),
            },
          })
        ).id,
      ),
    site: async (db, tenantId, n) =>
      encodeId(
        'site',
        (
          await db.customerSite.create({
            data: { tenantId, code: `ISO-${n}`, name: `Site ${n}`, address: { line1: 'x' } },
          })
        ).id,
      ),
    route: async (db, tenantId, n) => {
      const site = (k: string) =>
        db.customerSite.create({
          data: { tenantId, code: `ISO-R${k}${n}`, name: `Site ${k}${n}`, address: { line1: 'x' } },
        });
      const [a, b] = [await site('A'), await site('B')];
      return encodeId(
        'route',
        (
          await db.route.create({
            data: {
              tenantId,
              code: `ISO-${n}`,
              originSiteId: a.id,
              destSiteId: b.id,
              distanceKm: 10,
            },
          })
        ).id,
      );
    },
    unit: async (db, tenantId, n) =>
      encodeId(
        'unit',
        (
          await db.unit.create({
            data: { tenantId, code: `ISO${n}`, nameTh: `หน่วย ${n}`, kind: 'COUNT' },
          })
        ).id,
      ),
    product: async (db, tenantId, n) => {
      const u = await db.unit.create({
        data: { tenantId, code: `ISP${n}`, nameTh: `หน่วยสินค้า ${n}`, kind: 'COUNT' },
      });
      return encodeId(
        'product',
        (
          await db.product.create({
            data: {
              tenantId,
              code: `ISO-${n}`,
              nameTh: `Product ${n}`,
              baseUnitId: u.id,
              weightPerUnitKg: 1,
            },
          })
        ).id,
      );
    },
    serviceItem: async (db, tenantId, n) =>
      encodeId(
        'serviceItem',
        (
          await db.serviceItem.create({
            data: {
              tenantId,
              code: `ISO-${n}`,
              nameTh: `Service ${n}`,
              vatType: 'VAT_7',
              whtRate: '3.00',
              calcUnit: 'PER_TRIP',
              unitLabel: 'เที่ยว',
            },
          })
        ).id,
      ),
    // ST2-T13 rate card ขาขาย — ลูกค้า + สถานที่ 2 จุด + ประเภทรถ + ค่าขนส่ง
    rateCard: async (db, tenantId, n) => {
      const cus = await db.customer.create({
        data: {
          tenantId,
          code: `ISO-RC${n}`,
          legalName: `Cust RC ${n}`,
          taxId: validTaxId(1300 + n),
        },
      });
      const site = (k: string) =>
        db.customerSite.create({
          data: {
            tenantId,
            code: `ISO-RC${k}${n}`,
            name: `Site RC${k}${n}`,
            address: { line1: 'x' },
          },
        });
      const [a, b] = [await site('A'), await site('B')];
      const vt = await db.vehicleType.create({
        data: { tenantId, code: `ISO-RC${n}`, nameTh: `Type RC ${n}`, vehicleClass: '6W' },
      });
      const si = await db.serviceItem.create({
        data: {
          tenantId,
          code: `ISO-RC${n}`,
          nameTh: `Freight RC ${n}`,
          vatType: 'EXEMPT_TRANSPORT',
          whtRate: '1.00',
          calcUnit: 'PER_TRIP',
          unitLabel: 'เที่ยว',
        },
      });
      return encodeId(
        'rateCard',
        (
          await db.rateCard.create({
            data: {
              tenantId,
              side: 'SELL',
              code: `RC-S-ISO${n}`,
              customerId: cus.id,
              originSiteId: a.id,
              destSiteId: b.id,
              vehicleTypeId: vt.id,
              pricingModel: 'PER_TRIP',
              unitPrice: '6500.00',
              serviceItemId: si.id,
              validFrom: new Date('2026-01-01'),
            },
          })
        ).id,
      );
    },
    // ST3-T03 /orders/:id — ร่าง (ไม่ต้องมีเลข SO / reason code)
    salesOrder: async (db, tenantId, n) => {
      const c = await db.company.create({
        data: { tenantId, legalName: `Co so${n}`, taxId: validTaxId(1500 + n) },
      });
      const o = await db.salesOrder.create({
        data: {
          tenantId,
          source: 'API',
          externalId: `ISO-SO-${n}`,
          billingCompanyId: c.id,
          requestedDate: new Date('2026-11-12T00:00:00Z'),
          status: 'DRAFT',
        },
      });
      return encodeId('salesOrder', o.id);
    },
    // ST3-T02 /order-templates/:id
    orderTemplate: async (db, tenantId, n) =>
      encodeId(
        'orderTemplate',
        (
          await db.orderTemplate.create({
            data: {
              tenantId,
              name: `ISO-TPL-${n}`,
              payload: { requestedDate: '2026-11-12', stops: [] },
            },
          })
        ).id,
      ),
    reasonCode: async (db, tenantId, n) =>
      encodeId(
        'reasonCode',
        (
          await db.reasonCode.create({
            data: {
              tenantId,
              category: 'DELIVERY_FAILED',
              code: `ISO-${n}`,
              labelTh: `Reason ${n}`,
            },
          })
        ).id,
      ),
    vehicleType: async (db, tenantId, n) =>
      encodeId(
        'vehicleType',
        (
          await db.vehicleType.create({
            data: { tenantId, code: `ISO-${n}`, nameTh: `Type ${n}`, vehicleClass: '6W' },
          })
        ).id,
      ),
    carrier: async (db, tenantId, n) =>
      encodeId(
        'carrier',
        (
          await db.carrier.create({
            data: {
              tenantId,
              code: `ISO-${n}`,
              legalName: `Carrier ${n}`,
              entityType: 'JURISTIC',
              taxId: validTaxId(700 + n),
              taxIdLast4: validTaxId(700 + n).slice(-4),
              branchCode: '00000',
            },
          })
        ).id,
      ),
    vehicle: async (db, tenantId, n) => {
      const vt = await db.vehicleType.create({
        data: { tenantId, code: `ISOV-${n}`, nameTh: `Type v${n}`, vehicleClass: '6W' },
      });
      const v = await db.vehicle.create({
        data: {
          tenantId,
          plate: `70-${1000 + n}`,
          plateProvince: 'TH-10',
          plateKey: `70${1000 + n}|TH-10`,
          plateNorm: `70${1000 + n}`,
          vehicleTypeId: vt.id,
          ownership: 'OWN',
        },
      });
      return encodeId('vehicle', v.id);
    },
    driver: async (db, tenantId, n) =>
      encodeId(
        'driver',
        (
          await db.driver.create({
            data: {
              tenantId,
              code: `ISO-${n}`,
              name: `Driver ${n}`,
              phone: `08${String(10_000_000 + n).padStart(8, '0')}`,
              phoneNorm: `08${String(10_000_000 + n).padStart(8, '0')}`,
              employmentType: 'EMPLOYEE_SALARIED',
            },
          })
        ).id,
      ),
    vehicleDocument: async (db, tenantId, n) => {
      const vt = await db.vehicleType.create({
        data: { tenantId, code: `ISOD-${n}`, nameTh: `Type d${n}`, vehicleClass: '6W' },
      });
      const v = await db.vehicle.create({
        data: {
          tenantId,
          plate: `71-${1000 + n}`,
          plateProvince: 'TH-10',
          plateKey: `71${1000 + n}|TH-10`,
          plateNorm: `71${1000 + n}`,
          vehicleTypeId: vt.id,
          ownership: 'OWN',
        },
      });
      const d = await db.vehicleDocument.create({
        data: {
          tenantId,
          vehicleId: v.id,
          docType: 'ANNUAL_TAX',
          refNo: `TAX-${n}`,
          startsOn: new Date('2026-01-01'),
          expiresOn: new Date('2027-01-01'),
        },
      });
      return encodeId('vehicleDocument', d.id);
    },
    // ST2-T21 ลิงก์อัปโหลดเอกสารของรถร่วม (magic_link purpose carrier_docs)
    magicLink: async (db, tenantId, n) => {
      const c = await db.carrier.create({
        data: {
          tenantId,
          code: `ISOL-${n}`,
          legalName: `Carrier l${n}`,
          entityType: 'JURISTIC',
          taxId: validTaxId(1700 + n),
          taxIdLast4: validTaxId(1700 + n).slice(-4),
          branchCode: '00000',
        },
      });
      const l = await db.magicLink.create({
        data: {
          tenantId,
          purpose: 'carrier_docs',
          entityType: 'carrier',
          entityId: c.id,
          actions: ['docs.view', 'docs.upload'],
          scopes: [],
          expiresAt: new Date(Date.now() + 86400_000),
        },
      });
      return encodeId('magicLink', l.id);
    },
    // ST3-T21 บันทึกการส่งลิงก์ทาง LINE/SMS
    messageDelivery: async (db, tenantId, n) => {
      const m = await db.messageDelivery.create({
        data: {
          tenantId,
          channel: 'LINE',
          template: 'carrier_docs_link',
          recipientMasked: 'U0a•••2c3d',
          recipientHash: `iso-${n}`,
          status: 'SENT',
        },
      });
      return encodeId('messageDelivery', m.id);
    },
    // ST2-T21 เอกสารที่รถร่วมส่งผ่านลิงก์ (รอตรวจ)
    carrierDocSubmission: async (db, tenantId, n) => {
      const c = await db.carrier.create({
        data: {
          tenantId,
          code: `ISOS-${n}`,
          legalName: `Carrier s${n}`,
          entityType: 'JURISTIC',
          taxId: validTaxId(1800 + n),
          taxIdLast4: validTaxId(1800 + n).slice(-4),
          branchCode: '00000',
        },
      });
      const vt = await db.vehicleType.create({
        data: { tenantId, code: `ISOS-${n}`, nameTh: `Type s${n}`, vehicleClass: '6W' },
      });
      const v = await db.vehicle.create({
        data: {
          tenantId,
          plate: `72-${1000 + n}`,
          plateProvince: 'TH-10',
          plateKey: `72${1000 + n}|TH-10`,
          plateNorm: `72${1000 + n}`,
          vehicleTypeId: vt.id,
          ownership: 'SUBCONTRACT',
          carrierId: c.id,
        },
      });
      const f = await db.storedDocument.create({
        data: {
          tenantId,
          kind: 'VEHICLE_DOC',
          mimeType: 'application/pdf',
          sizeBytes: 10,
          status: 'PENDING',
        },
      });
      const s = await db.carrierDocSubmission.create({
        data: {
          tenantId,
          carrierId: c.id,
          vehicleId: v.id,
          docType: 'INSURANCE',
          docNo: `POL-${n}`,
          startsOn: new Date('2026-01-01'),
          expiresOn: new Date('2027-01-01'),
          fileDocumentIds: [f.id],
        },
      });
      return encodeId('carrierDocSubmission', s.id);
    },
    sequence: async (db, tenantId) => {
      const s = await db.documentSeries.upsert({
        where: { tenantId_docType: { tenantId, docType: 'SO' } },
        create: { tenantId, docType: 'SO', prefix: 'SO-' },
        update: {},
      });
      return encodeId('sequence', s.id);
    },
    user: async (db, tenantId, n) =>
      encodeId(
        'user',
        (
          await db.appUser.create({
            data: { tenantId, email: `iso${n}@iso.test`, name: `iso ${n}`, status: 'ACTIVE' },
          })
        ).id,
      ),
    document: async (db, tenantId) =>
      encodeId(
        'document',
        (
          await db.storedDocument.create({
            data: {
              tenantId,
              status: 'PENDING',
              kind: 'OTHER',
              mimeType: 'application/pdf',
              sizeBytes: 10,
            },
          })
        ).id,
      ),
    invitation: async (db, tenantId, n) => {
      const u = await db.appUser.create({
        data: { tenantId, email: `inv${n}@iso.test`, name: `inv ${n}`, status: 'INVITED' },
      });
      const i = await db.userInvitation.create({
        data: {
          tenantId,
          userId: u.id,
          email: u.email,
          tokenHash: `iso-${tenantId}-${n}`,
          expiresAt: new Date(Date.now() + 86400_000),
        },
      });
      return encodeId('invitation', i.id);
    },
    notification: async (db, tenantId, n) => {
      const u = await db.appUser.create({
        data: { tenantId, email: `ntf${n}@iso.test`, name: `ntf ${n}`, status: 'ACTIVE' },
      });
      const x = await db.notification.create({
        data: {
          tenantId,
          recipientId: u.id,
          channel: 'in_app',
          templateCode: 'job.succeeded',
          locale: 'th',
          title: 'iso',
          body: 'iso',
          status: 'SENT',
        },
      });
      return encodeId('notification', x.id);
    },
    import: async (db, tenantId) => {
      const f = await store().put(tenantId, Buffer.from('a,b\n1,2\n'), 'csv');
      const d = await db.storedDocument.create({
        data: {
          tenantId,
          status: 'READY',
          kind: 'IMPORT',
          mimeType: 'text/csv',
          sizeBytes: f.size,
          fileKey: f.key,
          sha256: f.sha256,
        },
      });
      const i = await db.importJob.create({
        data: {
          tenantId,
          kind: 'sample',
          documentId: d.id,
          status: 'VALIDATED',
          expiresAt: new Date(Date.now() + 86400_000),
        },
      });
      return encodeId('import', i.id);
    },
    job: async (db, tenantId) =>
      encodeId('job', (await db.job.create({ data: { tenantId, type: 'noop' } })).id),
    // ST3-T09 ใบส่งของ — นิติบุคคล + ลูกค้า + สถานที่ 2 จุด + SO (1 บรรทัด) + DO ร่าง 1 ใบ
    deliveryOrder: async (db, tenantId, n) => {
      const co = await db.company.create({
        data: { tenantId, legalName: `Co DO ${n}`, taxId: validTaxId(1700 + n) },
      });
      const cus = await db.customer.create({
        data: {
          tenantId,
          code: `ISO-DO${n}`,
          legalName: `Cust DO ${n}`,
          taxId: validTaxId(1800 + n),
        },
      });
      const site = (k: string) =>
        db.customerSite.create({
          data: {
            tenantId,
            code: `ISO-DO${k}${n}`,
            name: `Site DO${k}${n}`,
            address: { line1: 'x' },
          },
        });
      const [a, b] = [await site('A'), await site('B')];
      const so = await db.salesOrder.create({
        data: {
          tenantId,
          soNo: `SO-ISO-${n}`,
          source: 'MANUAL',
          customerId: cus.id,
          billingCompanyId: co.id,
          requestedDate: new Date('2026-11-12'),
          status: 'RECEIVED',
          stops: {
            create: [
              { tenantId, sequence: 1, type: 'PICKUP', siteId: a.id, siteText: 'A' },
              { tenantId, sequence: 2, type: 'DELIVERY', siteId: b.id, siteText: 'B' },
            ],
          },
          lines: {
            create: [{ tenantId, lineNo: 1, description: 'x', qtyOrdered: '2', unit: 'TON' }],
          },
        },
        include: { lines: true },
      });
      const d = await db.deliveryOrder.create({
        data: {
          tenantId,
          doNo: `DO-ISO-${n}`,
          doDate: new Date('2026-11-12'),
          salesOrderId: so.id,
          customerId: cus.id,
          originSiteId: a.id,
          destSiteId: b.id,
          originStopSeq: 1,
          destStopSeq: 2,
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
      return encodeId('deliveryOrder', d.id);
    },
    // ST3-T11 เที่ยวรถ (PLANNING ว่าง)
    trip: async (db, tenantId, n) =>
      encodeId(
        'trip',
        (
          await db.trip.create({
            data: { tenantId, tripNo: `TRP-ISO-${n}`, tripDate: new Date('2026-11-13') },
          })
        ).id,
      ),
  };

/** body ขั้นต่ำที่ผ่าน validation ของ action แต่ละแบบ (ให้ไปถึง handler แล้วได้ 404 จริง) */
const BODY_FOR_SUFFIX: Record<string, object> = {
  deactivate: { reason: 'isolation test reason' },
  activate: { reason: 'isolation test' },
  roles: { roles: ['viewer'], reason: 'isolation test' },
  suspend: { reason: 'isolation test' },
  delete: { reason: 'isolation test reason' },
  revoke: { reason: 'isolation test' },
  cancel: { reason: 'isolation test' },
  // ST3-T09 /delivery-orders/:id/split และ /merge
  split: {
    parts: [{ lines: [{ soLineNo: 1, qty: '1' }] }, { lines: [{ soLineNo: 1, qty: '1' }] }],
  },
  merge: { deliveryOrderIds: [`do_${'0'.repeat(32)}`] },
  // ST3-T11 /trips/:id/attach|detach|assign|offer (dispatch/complete ไม่มี body)
  attach: { deliveryOrderIds: [`do_${'0'.repeat(32)}`] },
  detach: { deliveryOrderIds: [`do_${'0'.repeat(32)}`] },
  assign: { vehicleId: `veh_${'0'.repeat(32)}` },
  offer: { carrierId: `car_${'0'.repeat(32)}` },
  approve: { reason: 'isolation test reason' }, // ST2-T13 /rate-cards/:id/approve
  reject: { reason: 'isolation test reason' }, // ST2-T03 /customer-sites/:id/geocode/reject
  reveal: { field: 'bankAccountNo', reason: 'isolation test reason' }, // ST2-T05 /carriers/:id/reveal
  status: { status: 'parked', reason: 'isolation test reason' }, // ST2-T06 /vehicles/:id/status
  odometer: { readingKm: 1 }, // ST2-T06 /vehicles/:id/odometer
  correct: { readingKm: 1, reasonType: 'TYPO', note: 'isolation test reason' }, // ST2-T06 odometer/correct
  // ST2-T17 POST /vehicles/:id/documents และ /vehicle-documents/:id/renew
  documents: {
    docType: 'ANNUAL_TAX',
    docNo: 'ISO-1',
    startsOn: '2026-01-01',
    expiresOn: '2027-01-01',
    fileDocumentIds: [`doc_${'0'.repeat(32)}`],
  },
  renew: {
    docNo: 'ISO-2',
    startsOn: '2027-01-01',
    expiresOn: '2028-01-01',
    fileDocumentIds: [`doc_${'0'.repeat(32)}`],
  },
};

/** body เฉพาะ route (suffix เดียวกันแต่ validation ต่างกัน) — มาก่อน BODY_FOR_SUFFIX */
const BODY_FOR_PATH: Record<string, object> = {
  '/v1/drivers/:id/status': { status: 'on_leave', reason: 'isolation test reason' }, // ST2-T08
  '/v1/drivers/:id/reveal': { reason: 'isolation test reason' }, // ST2-T08
  // ST3-T06 จับคู่ด้วยมือ (`:sequence` ไม่ถูกแทน — ใบของ tenant อื่นต้อง 404 ก่อนตรวจลำดับจุด)
  '/v1/orders/:id/stops/:sequence/map-site': { siteId: `loc_${'0'.repeat(32)}` },
  '/v1/orders/:id/map-customer': { customerId: `cus_${'0'.repeat(32)}` },
};

interface RouteInfo {
  method: string;
  path: string;
  resource?: string;
  isPublic: boolean;
}

function collectRoutes(app: NestExpressApplication): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const mod of app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const cls = wrapper.metatype as any;
      if (!cls) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, cls) ?? '');
      const proto = cls.prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const sub = Reflect.getMetadata(PATH_METADATA, handler);
        const m = Reflect.getMetadata(METHOD_METADATA, handler);
        if (sub === undefined || m === undefined) continue;
        routes.push({
          method: RequestMethod[m as number]!,
          path: `/v1/${[base, String(sub)].filter((s) => s && s !== '/').join('/')}`.replace(
            /\/+/g,
            '/',
          ),
          resource:
            Reflect.getMetadata(TENANT_RESOURCE, handler) ??
            Reflect.getMetadata(TENANT_RESOURCE, cls),
          // route ของ Platform Console ไม่รับ token ลูกค้าเลย (ทดสอบใน platform.test.ts) — นับเหมือน public
          isPublic: Boolean(
            Reflect.getMetadata(IS_PUBLIC, handler) ??
            Reflect.getMetadata(IS_PUBLIC, cls) ??
            Reflect.getMetadata(PLATFORM_ROLES, handler) ??
            Reflect.getMetadata(PLATFORM_ROLES, cls),
          ),
        });
      }
    }
  }
  return routes;
}

describe('tenant isolation harness', () => {
  let app: NestExpressApplication;
  const plat = platform();
  let tenantA: string;
  let tokenB: string;
  let stepUpB: string;
  let tokenA: string;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantA = (await createTenant(plat, 'A')).id;
    const tenantB = (await createTenant(plat, 'B')).id;
    tokenA = await tokenFor(tenantA);
    tokenB = await tokenFor(tenantB);
    stepUpB = await signStepUpToken('user-test', tenantB);
  });
  afterAll(async () => {
    await app.close();
    await plat.$disconnect();
  });

  it('(1) ทุกตารางที่มี tenant_id เปิด RLS + FORCE + มี policy', async () => {
    const rows = await plat.$queryRaw<
      { table: string; rls: boolean; forced: boolean; policies: number }[]
    >`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname) AS policies
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND (EXISTS (SELECT 1 FROM information_schema.columns col
                       WHERE col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'tenant_id')
              OR c.relname = 'tenant')`;
    expect(rows.length).toBeGreaterThan(0);
    const bad = rows.filter((r) => !r.rls || !r.forced || r.policies === 0).map((r) => r.table);
    expect(bad, `ตารางที่ไม่มี RLS ครบ: ${bad.join(', ')}`).toEqual([]);
  });

  it('(2) ทุก route ที่มี :id ประกาศ @TenantResource และมี fixture', () => {
    const missing = collectRoutes(app)
      .filter((r) => r.path.includes(':id') && !r.isPublic)
      .filter((r) => !r.resource || !FIXTURES[r.resource])
      .map((r) => `${r.method} ${r.path} (resource=${r.resource ?? 'ไม่ประกาศ'})`);
    expect(missing, `route ที่ยังไม่ถูกทดสอบแยก tenant:\n${missing.join('\n')}`).toEqual([]);
  });

  it('(3) token ของ tenant B เรียก resource ของ tenant A → 404 problem+json ทุก route', async () => {
    const routes = collectRoutes(app).filter((r) => r.path.includes(':id') && !r.isPublic);
    expect(routes.length).toBeGreaterThan(0);
    let n = 0;
    for (const r of routes) {
      const id = await FIXTURES[r.resource!]!(plat, tenantA, n++);
      const url = r.path.replace(':id', id);
      const suffix = r.path.split('/').pop()!;
      // route ที่ต้อง step-up: ส่ง step-up ที่ถูกต้องของ tenant B ไปด้วย ให้ไปถึงการหา resource จริง
      const call = api(app, tokenB)
        [r.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete'](url)
        .set('X-Step-Up', stepUpB);
      const res = await (['POST', 'PATCH', 'PUT'].includes(r.method)
        ? call.send(BODY_FOR_PATH[r.path] ?? BODY_FOR_SUFFIX[suffix] ?? {})
        : call);
      expect(res.status, `${r.method} ${r.path}`).toBe(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.code).toBe('not_found');

      // sanity: เจ้าของเรียกได้ (GET) — กันกรณี route พังจนคืน 404 ให้ทุกคน
      if (r.method === 'GET')
        expect((await api(app, tokenA).get(url)).status, `owner ${r.path}`).toBe(200);
    }
  });

  it('list ของ tenant B ไม่มีข้อมูลของ A', async () => {
    const res = await api(app, tokenB).get('/v1/companies');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
