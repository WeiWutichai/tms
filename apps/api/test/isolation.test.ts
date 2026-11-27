import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { store } from '../src/modules/documents/documents.controller';
import { signStepUpToken } from '../src/auth/tokens';
import {
  api,
  bootApp,
  createTenant,
  issuedTestFields,
  platform,
  tokenFor,
  truncateAll,
  validTaxId,
} from './helpers';
import { collectRoutes } from './route-inventory';

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
    // ST7-T21 ผลกระทบยอดกับระบบภายนอก (reconcile_result)
    reconcileResult: async (db, tenantId, n) => {
      const c = await db.connector.create({
        data: {
          tenantId,
          adapterKey: `iso-rec-${n}`,
          capabilitiesEnabled: [],
          credentialKeys: [],
          status: 'DISCONNECTED',
          disconnectedAt: new Date(),
        },
      });
      const at = new Date();
      return encodeId(
        'reconcileResult',
        (
          await db.reconcileResult.create({
            data: {
              tenantId,
              connectorId: c.id,
              entityType: 'INVOICE',
              localId: randomUUID(),
              localNumber: `INV-ISO-${n}`,
              runAt: at,
              source: 'NIGHTLY',
              localSnapshot: {},
              remoteSnapshot: {},
              diff: { check: 'PAYMENT_STATUS', code: 'remote_less_than_tms' },
              diffHash: String(n).padStart(64, '0'),
              result: 'MISMATCH',
              severity: 'MONEY',
              lastSeenAt: at,
            },
          })
        ).id,
      );
    },
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
    // ST5-T07 ร่างใบแจ้งหนี้ (/invoices/:id, /proforma, /delivery-orders(/remove|/move), /lines(/merge|/split|/:lineId|/:lineId/remove), /cancel)
    invoice: async (db, tenantId, n) => {
      const c = await db.company.create({
        data: { tenantId, legalName: `Co inv ${n}`, taxId: validTaxId(1500 + n) },
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
      const cus = await db.customer.create({
        data: {
          tenantId,
          code: `ISO-INV-${n}`,
          legalName: `Cust inv ${n}`,
          taxId: validTaxId(1700 + n),
        },
      });
      const inv = await db.invoice.create({
        data: { tenantId, customerId: cus.id, issuingCompanyId: c.id, issuingBranchId: b.id },
      });
      return encodeId('invoice', inv.id);
    },
    // ST5-T09 ใบแจ้งหนี้ที่ออกแล้ว (/invoices/:id/pdf — ร่าง = 409) — ข้อมูล ณ วันออกครบตาม CHECK 0140
    issuedInvoice: async (db, tenantId, n) => {
      const id = tryDecodeId('invoice', await FIXTURES.invoice!(db, tenantId, n + 500))!;
      await db.invoice.update({
        where: { id },
        data: { status: 'ISSUED', ...issuedTestFields(`INV-ISO-${n}`) },
      });
      return encodeId('invoice', id);
    },
    // ST5-T13 การรับชำระ (/payments/:id, /reverse, /bounce, /clear) — เช็ครอเคลียร์ ตัดใบที่ออกแล้วเต็มยอด
    payment: async (db, tenantId, n) => {
      const invoiceId = tryDecodeId('invoice', await FIXTURES.invoice!(db, tenantId, n + 900))!;
      const inv = await db.invoice.update({
        where: { id: invoiceId },
        data: {
          totalAmount: '100.00',
          subtotalExempt: '100.00',
          status: 'ISSUED',
          ...issuedTestFields(`INV-ISO-PAY-${n}`),
        },
      });
      const p = await db.payment.create({
        data: {
          tenantId,
          paymentNo: `PAY-ISO-${n}`,
          customerId: inv.customerId,
          receivedDate: new Date('2026-11-20'),
          method: 'CHEQUE',
          chequeNo: `CHQ-${n}`,
          chequeBank: 'ธนาคารทดสอบ',
          chequeDate: new Date('2026-11-25'),
          chequeStatus: 'PENDING',
          amountReceived: '100.00',
        },
      });
      await db.paymentAllocation.create({
        data: { tenantId, paymentId: p.id, invoiceId, amount: '100.00' },
      });
      return encodeId('payment', p.id);
    },
    // ST5-T11 ใบวางบิล (/billing-notes/:id, PATCH, /finalize, /acknowledge, /collect, /cancel, /proforma)
    billingNote: async (db, tenantId, n) => {
      const inv = await db.invoice.findUniqueOrThrow({
        where: { id: tryDecodeId('invoice', await FIXTURES.invoice!(db, tenantId, n + 700))! },
      });
      const bn = await db.billingNote.create({
        data: {
          tenantId,
          customerId: inv.customerId,
          issuingCompanyId: inv.issuingCompanyId,
          issuingBranchId: inv.issuingBranchId,
        },
      });
      return encodeId('billingNote', bn.id);
    },
    // ST5-T11 ใบวางบิลที่ออกแล้ว (/billing-notes/:id/pdf — ร่าง = 409)
    issuedBillingNote: async (db, tenantId, n) => {
      const id = tryDecodeId('billingNote', await FIXTURES.billingNote!(db, tenantId, n + 500))!;
      await db.billingNote.update({
        where: { id },
        data: {
          status: 'ISSUED',
          billingNoteNo: `BN-ISO-${n}`,
          billingDate: new Date('2026-11-20T00:00:00.000Z'),
          collectionDate: new Date('2026-12-05T00:00:00.000Z'),
          issuedAt: new Date(),
          issuedBy: 'test',
          customerSnapshot: { name: 'x', taxId: null, branchCode: null, address: '' },
          issuerSnapshot: { name: 'x', taxId: null, branchCode: '00000', address: '' },
          printOptions: { yearStyle: 'BE', templateVersion: 1 },
        },
      });
      return encodeId('billingNote', id);
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
  // ST5-T11 ผู้รับวางบิล
  acknowledge: { receivedBy: 'isolation', receivedOn: '2026-11-20' },
  resolve: { decision: 'IGNORE', reason: 'isolation test reason' },
  deactivate: { reason: 'isolation test reason' },
  activate: { reason: 'isolation test' },
  roles: { roles: ['viewer'], reason: 'isolation test' },
  suspend: { reason: 'isolation test' },
  'reset-2fa': { reason: 'isolation test' }, // #81
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
  approve: { reason: 'isolation test reason' }, // ST2-T13 /rate-cards/:id/approve (+ ST8-T12 overwrite-request/approve)

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
  // PO 24 พ.ย. 2569 ไฟล์แนบคนขับ/ผู้รับเหมา (body ผ่าน validation → ไปถึงการตรวจ tenant)
  '/v1/drivers/:id/attachments': {
    documentId: 'doc_00000000000040008000000000000001',
    attachType: 'LICENCE',
  },
  '/v1/drivers/:id/attachments/remove': {
    documentId: 'doc_00000000000040008000000000000001',
    reason: 'isolation test reason',
  },
  '/v1/carriers/:id/attachments': {
    documentId: 'doc_00000000000040008000000000000001',
    attachType: 'CONTRACT',
  },
  '/v1/carriers/:id/attachments/remove': {
    documentId: 'doc_00000000000040008000000000000001',
    reason: 'isolation test reason',
  },
  // ST5-T01 เพิ่มบรรทัดรายได้เอง (body ผ่าน validation → ไปถึงการตรวจ tenant)
  '/v1/orders/:id/revenue-lines': {
    serviceItemId: 'svc_00000000000040008000000000000001',
    sellUnitPrice: '100.00',
    reason: 'isolation test reason',
  },
  '/v1/revenue-lines/:id/void': { reason: 'isolation test reason' }, // ST5-T01
  '/v1/invoices/:id/void': { reason: 'isolation test reason' }, // ST5-T10
  // ST8-T12 ปิดรายการไม่ตรง (approve/reject ใช้ BODY_FOR_SUFFIX)
  '/v1/reconcile-results/:id/acknowledge': { reason: 'isolation test reason' },
  '/v1/reconcile-results/:id/resolve-in-tms': { reason: 'isolation test reason' },
  '/v1/reconcile-results/:id/overwrite-request': { reason: 'isolation test reason' },
  '/v1/reconcile-results/:id/resend': { reason: 'isolation test reason' },
  '/v1/invoices/:id/unmark-sent': { reason: 'isolation test reason' }, // ST5-T18
  '/v1/payments/:id/reverse': { reason: 'isolation test reason' }, // ST5-T13
  '/v1/payments/:id/bounce': { reason: 'isolation test reason' }, // ST5-T13
  '/v1/settlements/:id/lines/:lineId/remove': { reason: 'isolation test reason' }, // ST6-T03
  // ST5-T07 ร่างใบแจ้งหนี้
  '/v1/invoices/:id/delivery-orders': { deliveryOrderIds: [`do_${'0'.repeat(32)}`] },
  '/v1/invoices/:id/delivery-orders/remove': {
    deliveryOrderIds: [`do_${'0'.repeat(32)}`],
    reason: 'isolation test reason',
  },
  '/v1/invoices/:id/delivery-orders/move': {
    deliveryOrderIds: [`do_${'0'.repeat(32)}`],
    targetInvoiceId: `ivc_${'0'.repeat(32)}`,
  },
  '/v1/invoices/:id/lines': {
    serviceItemId: `svc_${'0'.repeat(32)}`,
    quantity: '1',
    sellUnitPrice: '1.00',
    reason: 'isolation test reason',
  },
  '/v1/invoices/:id/lines/merge': { lineIds: [`ivl_${'0'.repeat(32)}`] },
  '/v1/invoices/:id/lines/split': { lineIds: [`ivl_${'0'.repeat(32)}`] },
  '/v1/invoices/:id/lines/:lineId/remove': { reason: 'isolation test reason' },
  '/v1/settlements/:id/recall': { reason: 'isolation test reason' }, // ST6-T05
  '/v1/settlements/:id/lines/:lineId/dispute': { reason: 'isolation test reason' }, // ST6-T06
  '/v1/settlements/:id/lines/:lineId/resolve': { reason: 'isolation test reason' }, // ST6-T06
  '/v1/settlements/:id/mark-paid': { paidDate: '2026-01-05', method: 'CASH' }, // ST6-T09
  '/v1/api-keys/:id/rotate': { reason: 'isolation test reason' }, // ST7-T01
  '/v1/webhooks/:id/disable': { reason: 'isolation test reason' }, // ST7-T04
  '/v1/connectors/:id/credentials': { credentials: { apiKey: 'isolation' } }, // ST7-T13
  '/v1/connectors/:id/disconnect': { reason: 'isolation test reason' }, // ST7-T13
  '/v1/connectors/:id/system-of-record': {
    taxDocumentOwner: 'TMS',
    reason: 'isolation test reason',
  }, // ST7-T17
  '/v1/connectors/:id/inbound-token/rotate': { reason: 'isolation test reason' }, // ST7-T22
  '/v1/connectors/:id/inbound-token/revoke': { reason: 'isolation test reason' }, // ST7-T22
  '/v1/connectors/:id/mappings/:serviceItemId': { itemCode: null }, // ST7-T18
  '/v1/connectors/:id/queue/:commandId/skip': { reason: 'isolation test reason' }, // ST7-T19
  '/v1/connectors/:id/queue/:commandId/external-id': {
    externalId: 'ISO-1',
    reason: 'isolation test reason',
  }, // ST7-T19
  '/v1/customers/:id/erp-codes/:connectorId': { externalId: null }, // ST8-T05
  '/v1/carriers/:id/erp-codes/:connectorId': { externalId: null }, // ST7-T15
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

  /**
   * (1b) plan/13 §1.1 DoR: ตารางระดับแพลตฟอร์ม (ไม่มี tenant_id) ต้องลงทะเบียนที่นี่พร้อมเหตุผล — ตารางใหม่ที่ลืม tenant_id จะไม่ผ่าน
   * เข้าถึงผ่าน role platform / route `/v1/platform/*` (หรือเป็นตารางระบบที่ไม่มีข้อมูลลูกค้า)
   */
  const PLATFORM_TABLES: Record<string, string> = {
    _prisma_migrations: 'ประวัติ migration ของ Prisma',
    availability_probe: 'ผล health check ของระบบ (ST9-T19) — ไม่มีข้อมูลลูกค้า',
    http_request_minute: 'ตัวนับคำขอรวมต่อนาทีสำหรับ monitoring — ไม่มีข้อมูลลูกค้า',
    message_recipient_counter:
      'ตัวนับต่อผู้รับข้ามบริษัท (ST3-T21) — role แอปเข้าผ่านฟังก์ชัน SECURITY DEFINER เท่านั้น',
    monitor_alert: 'alert ถึงทีม Innovera (Console เท่านั้น)',
    monitor_check: 'ผลตรวจสุขภาพระบบ (Console เท่านั้น)',
    password_reset_token:
      'token รีเซ็ตรหัสผ่าน (ค้นด้วย hash ก่อนรู้ tenant) — ใช้ผ่าน role platform',
    plan: 'แคตตาล็อกแพ็กเกจกลาง — แก้จาก Console เท่านั้น (แอปอ่านอย่างเดียว)',
    plan_entitlement: 'เซลล์ feature matrix ของ PlanVersion (P1-ST1-T01) — แคตตาล็อกกลาง',
    plan_version:
      'เวอร์ชันราคา/สิทธิ์ของแพ็กเกจ (P1-ST1-T01) — แคตตาล็อกกลาง แก้จาก /v1/platform/* เท่านั้น',
    feature: 'แคตตาล็อกฟีเจอร์ (P1-ST1-T01) — เพิ่มโดย migration เท่านั้น',
    platform_audit_log: 'audit การกระทำระดับแพลตฟอร์ม (P1-ST1-T01/T04) — role แอปเข้าไม่ได้',
    platform_setting: 'ค่าตั้งของแพลตฟอร์ม (P1-ST1-T04) — role แอปเข้าไม่ได้',
    platform_user: 'ทีม Innovera (Console)',
    rate_limit_bucket: 'ถัง rate limit (key เป็น hash ของ tenant/key/user)',
    tenant: 'ตาราง tenant เอง — RLS ด้วยคอลัมน์ id (ตรวจใน (1))',
    worker_heartbeat: 'สถานะ worker — ไม่มีข้อมูลลูกค้า',
  };
  it('(1b) ตารางที่ไม่มี tenant_id อยู่ในรายการยกเว้นพร้อมเหตุผล · role แอปเขียนตารางระดับแพลตฟอร์มใหม่ไม่ได้', async () => {
    const rows = await plat.$queryRaw<{ table: string }[]>`
      SELECT c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns col
                          WHERE col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'tenant_id')`;
    const missing = rows.map((r) => r.table).filter((t) => !(t in PLATFORM_TABLES));
    expect(missing, `ตารางไม่มี tenant_id ที่ยังไม่ลงทะเบียนเหตุผล: ${missing.join(', ')}`).toEqual(
      [],
    );
    const priv = await plat.$queryRaw<{ table: string; ins: boolean; upd: boolean }[]>`
      SELECT t AS table, has_table_privilege('tms_app', t, 'INSERT') AS ins, has_table_privilege('tms_app', t, 'UPDATE') AS upd
        FROM unnest(ARRAY['plan_version', 'plan_entitlement', 'feature', 'platform_audit_log', 'platform_setting', 'subscription', 'tenant_status_history']) AS t`;
    expect(priv.filter((p) => p.ins || p.upd).map((p) => p.table)).toEqual([]);
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

  /**
   * (4) ST9-T13 (NFR-204 "list endpoint ต้องไม่มีแถวของ tenant อื่น"): ทุก GET ที่ไม่มี path param (list/summary/รายงาน/export)
   * เรียกด้วย token ของ B หลัง (3) สร้างข้อมูลทุกชนิดใน A แล้ว → คำตอบต้องไม่มี id ใด ๆ ของแถวใน A (รูป uuid หรือ id ภายนอก `xxx_<hex>`)
   */
  it('(4) ทุก GET ที่ไม่มี path param: token ของ B ไม่เห็น id ของแถวใดใน tenant A', async () => {
    const tables = await plat.$queryRaw<{ table: string }[]>`
      SELECT t.table_name AS table FROM information_schema.columns t
        JOIN information_schema.columns i
          ON i.table_schema = t.table_schema AND i.table_name = t.table_name
         AND i.column_name = 'id' AND i.data_type = 'uuid'
       WHERE t.table_schema = 'public' AND t.column_name = 'tenant_id'`;
    const ids = new Set<string>();
    for (const { table } of tables) {
      const rows = await plat.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id::text AS id FROM "${table}" WHERE tenant_id = $1::uuid`,
        tenantA,
      );
      for (const r of rows) ids.add(r.id.replace(/-/g, ''));
    }
    expect(ids.size).toBeGreaterThan(200);
    const hex = [...ids];
    const leakIn = (text: string) => {
      const flat = text.toLowerCase().replace(/-/g, '');
      return hex.find((h) => flat.includes(h));
    };
    // ตัวควบคุม: เจ้าของเห็น id ของตัวเองในรายการ (ตัวตรวจจับทำงานจริง)
    expect(leakIn((await api(app, tokenA).get('/v1/companies')).text)).toBeTruthy();

    const routes = collectRoutes(app).filter(
      (r) => r.method === 'GET' && r.params.length === 0 && !r.isPublic && !r.linkAction,
    );
    expect(routes.length).toBeGreaterThan(80);
    const problems: string[] = [];
    for (const r of routes) {
      const url = r.path.replace(/\\:/g, ':');
      const res = await api(app, tokenB).get(url);
      if (res.status >= 500) problems.push(`${url} → ${res.status}`);
      const hit = leakIn(res.text ?? '');
      if (hit) problems.push(`${url} → มี id ของ tenant A (${hit})`);
    }
    expect(problems).toEqual([]);
  });

  it('list ของ tenant B ไม่มีข้อมูลของ A', async () => {
    const res = await api(app, tokenB).get('/v1/companies');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  /**
   * (5) ตาราง platform ที่ **ไม่มี tenant_id** (ข้อมูลก่อนมีบริษัท — ไม่มี RLS ให้กั้น) ต้องไม่ให้ role แอป (tms_app) แตะเลย
   * เพิ่มตารางแบบนี้ = เพิ่มในรายการพร้อมเหตุผล (CLAUDE.md "test แยกข้อมูลของตารางใหม่")
   */
  const PLATFORM_ONLY_TABLES: Record<string, string> = {
    password_reset_token: 'ST1-T03 ลิงก์ลืมรหัสผ่าน — ก่อนรู้บริษัท (อีเมลเดียวข้ามบริษัท)',
    signup_session:
      'P1-ST2-T03 การสมัครเอง — ยังไม่มีบริษัท; ข้อมูลส่วนบุคคลผู้สมัคร + hash OTP/รหัสผ่าน (เข้าผ่าน client platform เท่านั้น)',
    company_lookup:
      'P1-ST2-T04 cache ผลค้นข้อมูลบริษัทจากกรมสรรพากร — ข้อมูลสาธารณะของนิติบุคคล ใช้ร่วมทุกการสมัคร (ก่อนมีบริษัท); key = (taxId, branchCode)',
    company_lookup_log:
      'P1-ST2-T04 log การส่งเลขผู้เสียภาษีออกไปหน่วยงานภายนอก (PDPA) + ตัวนับ circuit breaker — ระดับแพลตฟอร์ม ไม่ผูกบริษัท; append-only',
  };
  it('(5) ตาราง platform ที่ไม่มี tenant_id: tms_app ไม่มีสิทธิ์ใด ๆ', async () => {
    const rows = await plat.$queryRaw<{ table: string; priv: string }[]>`
      SELECT table_name AS table, privilege_type AS priv FROM information_schema.role_table_grants
       WHERE grantee = 'tms_app' AND table_schema = 'public' AND table_name = ANY(${Object.keys(PLATFORM_ONLY_TABLES)})`;
    const cols = await plat.$queryRaw<{ table: string }[]>`
      SELECT table_name AS table FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'tenant_id' AND table_name = ANY(${Object.keys(PLATFORM_ONLY_TABLES)})`;
    expect(cols, 'ตารางในรายการ platform-only ต้องไม่มี tenant_id (ถ้ามี = ใช้ RLS แทน)').toEqual(
      [],
    );
    expect(rows.map((r) => `${r.table}:${r.priv}`)).toEqual([]);
  });
});
