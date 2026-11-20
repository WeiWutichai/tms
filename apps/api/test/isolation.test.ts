import { randomUUID } from 'node:crypto';
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
/** ผู้ใช้จริงของ token A — resource ส่วนตัว (saved view) ผูกกับผู้ใช้ที่ login */
const OWNER_A = '0000a11c-0000-4000-8000-0000000000a1';

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
    // ST9-T11 /saved-views/:id — มุมมองส่วนตัวของผู้ใช้เจ้าของ token A (ของผู้ใช้อื่นมองไม่เห็นอยู่แล้ว)
    savedView: async (db, tenantId, n) =>
      encodeId(
        'savedView',
        (
          await db.savedView.create({
            data: { tenantId, userId: OWNER_A, page: 'orders', name: `ISO-VIEW-${n}`, state: {} },
          })
        ).id,
      ),
    apiKey: async (db, tenantId, n) =>
      encodeId(
        'apiKey',
        (
          await db.apiKey.create({
            data: {
              tenantId,
              name: `ISO key ${n}`,
              mode: 'live',
              prefix: 'tk_live_0000',
              secretHash: `iso-${tenantId}-${n}`,
              scopes: ['orders:read'],
              ipAllowlist: [],
            },
          })
        ).id,
      ),
    webhookEndpoint: async (db, tenantId, n) =>
      encodeId(
        'webhookEndpoint',
        (
          await db.webhookEndpoint.create({
            data: {
              tenantId,
              url: `https://iso-${n}.example.com/hook`,
              events: ['order.created'],
              extraHeaderNames: [],
              secretEnc: 'v1.k1.x.x.x',
            },
          })
        ).id,
      ),
    // ST7-T13 การตั้งค่า ErpAdapter ต่อ tenant
    connector: async (db, tenantId, n) =>
      encodeId(
        'connector',
        (
          await db.connector.create({
            data: {
              tenantId,
              adapterKey: `iso-${n}`,
              capabilitiesEnabled: [],
              credentialKeys: [],
              // หลายแถวต่อ tenant (1 ต่อ route) — ขอบเขตเดียวกันมีตัวที่ยังไม่ยกเลิกได้ตัวเดียว
              status: 'DISCONNECTED',
              disconnectedAt: new Date(),
            },
          })
        ).id,
      ),
    // ST7-T05 บันทึกการส่ง webhook + event (redeliver)
    webhookDelivery: async (db, tenantId, n) => {
      const e = await db.webhookEndpoint.create({
        data: {
          tenantId,
          url: `https://iso-d${n}.example.com/hook`,
          events: ['order.created'],
          extraHeaderNames: [],
          secretEnc: 'v1.k1.x.x.x',
        },
      });
      const ev = await db.domainEvent.create({
        data: {
          tenantId,
          type: 'order.created',
          entityType: 'order',
          localId: randomUUID(),
          snapshot: {},
        },
      });
      const d = await db.webhookDelivery.create({
        data: {
          tenantId,
          endpointId: e.id,
          eventId: ev.id,
          envelopeId: encodeId('event', ev.id),
          eventType: 'order.created',
          attempt: 1,
          status: 'EXHAUSTED',
          requestUrl: e.url,
          requestHeaders: {},
          requestBody: '{}',
          durationMs: 1,
          sentAt: new Date(),
        },
      });
      return encodeId('webhookDelivery', d.id);
    },
    event: async (db, tenantId) =>
      encodeId(
        'event',
        (
          await db.domainEvent.create({
            data: {
              tenantId,
              type: 'order.created',
              entityType: 'order',
              localId: randomUUID(),
              snapshot: {},
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
    // ST3-T19 ตารางรถ/คนขับรายวัน (วันลาคนขับ)
    scheduleEntry: async (db, tenantId, n) => {
      const d = await db.driver.create({
        data: {
          tenantId,
          code: `DRV-S${n}`,
          name: `Driver s${n}`,
          phone: `08${String(20_000_000 + n).padStart(8, '0')}`,
          phoneNorm: `08${String(20_000_000 + n).padStart(8, '0')}`,
          employmentType: 'EMPLOYEE_SALARIED',
        },
      });
      const e = await db.scheduleEntry.create({
        data: {
          tenantId,
          kind: 'LEAVE',
          driverId: d.id,
          startsOn: new Date('2026-12-01'),
          endsOn: new Date('2026-12-02'),
          note: 'ลา',
        },
      });
      return encodeId('scheduleEntry', e.id);
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
    // ST9-T10 งานส่งออก — ผู้สั่ง = OWNER_A (sub ของ tokenA — เจ้าของเห็นได้ 200, tenant B 404)
    export: async (db, tenantId) =>
      encodeId(
        'job',
        (
          await db.job.create({
            data: {
              tenantId,
              type: 'export.file',
              payload: {
                resource: 'customers',
                format: 'xlsx',
                filter: {},
                actorId: OWNER_A,
                scopes: ['*'],
                principalType: 'dev',
              },
            },
          })
        ).id,
      ),
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
    // ST4-T13 ค่าใช้จ่ายหน้างานฝั่งขาย (/do-surcharges/:id/confirm|reject|cancel)
    doSurcharge: async (db, tenantId, n) => {
      const doId = (await FIXTURES.deliveryOrder!(db, tenantId, 9000 + n)).replace(/^do_/, '');
      const id = doId.replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');
      const svc = await db.serviceItem.create({
        data: {
          tenantId,
          code: `ISO-DSC${n}`,
          nameTh: `ค่ารอ ${n}`,
          vatType: 'VAT_7',
          whtRate: '3.00',
          calcUnit: 'PER_TRIP',
          unitLabel: 'เที่ยว',
          isSurcharge: true,
        },
      });
      const s = await db.doSurcharge.create({
        data: {
          tenantId,
          deliveryOrderId: id,
          serviceItemId: svc.id,
          vatType: 'VAT_7',
          whtRate: '3.00',
          qty: '1',
          unitPrice: '100',
          amount: '100',
        },
      });
      return encodeId('doSurcharge', s.id);
    },
    // ST5-T01 บรรทัดรายได้ที่คนเพิ่ม (/revenue-lines/:id/void)
    revenueLine: async (db, tenantId, n) => {
      const soId = (await FIXTURES.salesOrder!(db, tenantId, 9500 + n)).replace(/^ord_/, '');
      const id = soId.replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');
      const svc = await db.serviceItem.create({
        data: {
          tenantId,
          code: `ISO-RVL${n}`,
          nameTh: `ค่ายกของ ${n}`,
          vatType: 'VAT_7',
          whtRate: '3.00',
          calcUnit: 'PER_TRIP',
          unitLabel: 'เที่ยว',
        },
      });
      const l = await db.revenueLine.create({
        data: {
          tenantId,
          salesOrderId: id,
          lineNo: 1,
          sourceType: 'MANUAL',
          isUserAdded: true,
          kind: 'ACCESSORIAL',
          serviceItemId: svc.id,
          description: 'ค่ายกของ',
          qty: '1',
          unitPrice: '100',
          amount: '100',
          vatType: 'VAT_7',
          whtRate: '3.00',
        },
      });
      return encodeId('revenueLine', l.id);
    },
    // ST4-T13 ค่าใช้จ่ายหน้างานฝั่งซื้อ (/trip-costs/:id/confirm|reject|cancel)
    tripCost: async (db, tenantId, n) => {
      const t = await db.trip.create({
        data: { tenantId, tripNo: `TRP-ISO-C${n}`, tripDate: new Date('2026-11-17') },
      });
      const c = await db.tripCost.create({
        data: {
          tenantId,
          tripId: t.id,
          costType: 'TOLL',
          amount: '50',
          source: 'MANUAL',
          sourceType: 'FIELD',
          status: 'PENDING_CONFIRM',
        },
      });
      return encodeId('tripCost', c.id);
    },
    // ST6-T03 ใบสำคัญจ่ายรถร่วม (ร่าง — /settlements/:id, /lines, /lines/:lineId/remove, /cancel · ST6-T05 /send-to-carrier, /review-link, /recall)
    settlement: async (db, tenantId, n) => {
      const c = await db.carrier.create({
        data: {
          tenantId,
          code: `ISO-STL-${n}`,
          legalName: `Carrier stl ${n}`,
          entityType: 'JURISTIC',
        },
      });
      const s = await db.carrierSettlement.create({
        data: {
          tenantId,
          carrierId: c.id,
          carrierSnapshot: { code: c.code, legalName: c.legalName, entityType: 'JURISTIC' },
          periodFrom: new Date('2026-11-01'),
          periodTo: new Date('2026-11-15'),
        },
      });
      return encodeId('settlement', s.id);
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
    // ST4-T01 จุดแวะ (action หน้างาน /stops/:id/arrive|depart|complete|fail)
    tripStop: async (db, tenantId, n) => {
      const site = await db.customerSite.create({
        data: { tenantId, code: `ISO-S${n}`, name: `Stop site ${n}`, address: { line1: 'x' } },
      });
      const t = await db.trip.create({
        data: { tenantId, tripNo: `TRP-ISO-S${n}`, tripDate: new Date('2026-11-17') },
      });
      const s = await db.tripStop.create({
        data: { tenantId, tripId: t.id, sequence: 1, type: 'DELIVERY', siteId: site.id },
      });
      return encodeId('tripStop', s.id);
    },
    // ST4-T02 ธงของ stop event (/stop-event-flags/:id/resolve) — event ขัดลำดับ (ปิดงานก่อนถึงจุด)
    stopEvent: async (db, tenantId, n) => {
      const site = await db.customerSite.create({
        data: { tenantId, code: `ISO-E${n}`, name: `Event site ${n}`, address: { line1: 'x' } },
      });
      const t = await db.trip.create({
        data: { tenantId, tripNo: `TRP-ISO-E${n}`, tripDate: new Date('2026-11-17') },
      });
      const s = await db.tripStop.create({
        data: { tenantId, tripId: t.id, sequence: 1, type: 'DELIVERY', siteId: site.id },
      });
      const e = await db.stopEvent.create({
        data: {
          tenantId,
          tripId: t.id,
          tripStopId: s.id,
          type: 'COMPLETE',
          outcome: 'DELIVERED',
          clientEventId: randomUUID(),
          source: 'WEB',
          occurredAt: new Date(),
          sequenceConflict: true,
        },
      });
      return encodeId('event', e.id);
    },
  };

/** body ขั้นต่ำที่ผ่าน validation ของ action แต่ละแบบ (ให้ไปถึง handler แล้วได้ 404 จริง) */
const BODY_FOR_SUFFIX: Record<string, object> = {
  resolve: { decision: 'IGNORE', reason: 'isolation test reason' },
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
  // ST4-T11 /delivery-orders/:id/redeliver และ /return
  redeliver: { reasonCodeId: `rsn_${'0'.repeat(32)}` },
  return: { reasonCodeId: `rsn_${'0'.repeat(32)}` },
  'revert-delivery': { reason: 'isolation test reason' }, // ST5-T06 /delivery-orders/:id/revert-delivery
  unrelease: { reason: 'isolation test reason' }, // ST5-T06 /delivery-orders/:id/unrelease
  // ST3-T11 /trips/:id/attach|detach|assign|offer (dispatch/complete ไม่มี body)
  attach: { deliveryOrderIds: [`do_${'0'.repeat(32)}`] },
  detach: { deliveryOrderIds: [`do_${'0'.repeat(32)}`] },
  assign: { vehicleId: `veh_${'0'.repeat(32)}` },
  offer: { carrierId: `car_${'0'.repeat(32)}` },
  schedule: { plannedStartAt: '2026-11-13T08:00:00+07:00' }, // ST3-T12 /trips/:id/schedule
  'confirm-rules': { ruleKeys: ['x'], overrideReason: 'isolation test reason' }, // ST3-T14 /trips/:id/confirm-rules
  'reorder-stops': { stopIds: [`stp_${'0'.repeat(32)}`] }, // ST3-T16 /trips/:id/reorder-stops
  // ST4-T01 /stops/:id/arrive|depart|fail (complete อยู่ใน BODY_FOR_PATH — ชื่อซ้ำกับ /trips/:id/complete)
  arrive: {
    clientEventId: '00000000-0000-4000-8000-00000000a001',
    occurredAt: '2026-11-17T09:00:00+07:00',
  },
  depart: {
    clientEventId: '00000000-0000-4000-8000-00000000a002',
    occurredAt: '2026-11-17T09:00:00+07:00',
  },
  fail: {
    clientEventId: '00000000-0000-4000-8000-00000000a003',
    occurredAt: '2026-11-17T09:00:00+07:00',
  },
  approve: { reason: 'isolation test reason' }, // ST2-T13 /rate-cards/:id/approve
  confirm: { reason: 'isolation test reason' }, // ST4-T13 /do-surcharges|trip-costs/:id/confirm
  'field-charges': {
    side: 'BUY',
    serviceItemId: `svc_${'0'.repeat(32)}`,
    costAmount: '1.00',
    evidenceDocumentId: `doc_${'0'.repeat(32)}`,
  }, // ST4-T13
  reject: { reason: 'isolation test reason' }, // ST2-T03 /customer-sites/:id/geocode/reject + ST3-T10 source-changes
  accept: { reason: 'isolation test reason' }, // ST3-T10 /orders/:id/source-changes/:changeId/accept
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
  // ST5-T01 เพิ่มบรรทัดรายได้เอง (body ผ่าน validation → ไปถึงการตรวจ tenant)
  '/v1/orders/:id/revenue-lines': {
    serviceItemId: 'svc_00000000000040008000000000000001',
    sellUnitPrice: '100.00',
    reason: 'isolation test reason',
  },
  '/v1/revenue-lines/:id/void': { reason: 'isolation test reason' }, // ST5-T01
  '/v1/settlements/:id/lines/:lineId/remove': { reason: 'isolation test reason' }, // ST6-T03
  '/v1/settlements/:id/recall': { reason: 'isolation test reason' }, // ST6-T05
  '/v1/api-keys/:id/rotate': { reason: 'isolation test reason' }, // ST7-T01
  '/v1/webhooks/:id/disable': { reason: 'isolation test reason' }, // ST7-T04
  '/v1/connectors/:id/credentials': { credentials: { apiKey: 'isolation' } }, // ST7-T13
  '/v1/connectors/:id/disconnect': { reason: 'isolation test reason' }, // ST7-T13
  '/v1/connectors/:id/inbound-token/rotate': { reason: 'isolation test reason' }, // ST7-T22
  '/v1/connectors/:id/inbound-token/revoke': { reason: 'isolation test reason' }, // ST7-T22
  '/v1/connectors/:id/mappings/:serviceItemId': { itemCode: null }, // ST7-T18
  // DELETE ที่มี body (เหตุผลบังคับ) — key `DELETE <path>`
  'DELETE /v1/webhooks/:id': { reason: 'isolation test reason' }, // ST7-T04
  '/v1/drivers/:id/status': { status: 'on_leave', reason: 'isolation test reason' }, // ST2-T08
  '/v1/drivers/:id/reveal': { reason: 'isolation test reason' }, // ST2-T08
  // ST3-T06 จับคู่ด้วยมือ (`:sequence` ไม่ถูกแทน — ใบของ tenant อื่นต้อง 404 ก่อนตรวจลำดับจุด)
  '/v1/orders/:id/stops/:sequence/map-site': { siteId: `loc_${'0'.repeat(32)}` },
  '/v1/orders/:id/map-customer': { customerId: `cus_${'0'.repeat(32)}` },
  '/v1/orders/:id/resolve-source-error': { reason: 'isolation test reason' }, // ST3-T07
  '/v1/orders/:id/manual-price': { sellAmount: '1000.00', reason: 'isolation test reason' }, // ST3-T07
  '/v1/stops/:id/complete': {
    clientEventId: '00000000-0000-4000-8000-00000000a004',
    occurredAt: '2026-11-17T09:00:00+07:00',
    outcome: 'DELIVERED',
  }, // ST4-T01
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
    await plat.appUser.create({
      data: {
        id: OWNER_A,
        tenantId: tenantA,
        email: 'owner-a@iso.test',
        name: 'A',
        status: 'ACTIVE',
      },
    });
    tokenA = await tokenFor(tenantA, '*', OWNER_A);
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
        : BODY_FOR_PATH[`${r.method} ${r.path}`]
          ? call.send(BODY_FOR_PATH[`${r.method} ${r.path}`]!)
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
