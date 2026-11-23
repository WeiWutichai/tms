import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient, VatType } from '@prisma/client';
import { SYSTEM_ROLES } from '@tms/domain';
import { type MockKrs, startMockKrs } from '@tms/mock-krs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { KrsAdapter } from '../src/erp-adapters/krs/krs.adapter';
import type { CanonicalDocument } from '../src/modules/erp/erp-adapter';
import { ErpAdapterRegistry } from '../src/modules/erp/erp-adapter.registry';
import {
  DocumentReconcileService,
  lastBusinessDay,
  RECONCILE_JOB,
} from '../src/modules/erp/document-reconcile.service';
import { compareDocuments, TOTAL_SKIP_NO_AMOUNTS } from '../src/modules/erp/reconcile-compare';
import { OutboxDispatcher } from '../src/modules/integration/outbox.dispatcher';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST8-T11 Reconcile engine (docs/01 §6.5, §4.4; docs/04 G3 — K12) — ไม่ผูก ERP ใด · ทดสอบครบวงจรกับ KRS adapter ตัวจริง + mock KRS
 * เกณฑ์ตรวจรับ (plan/01 ST8-T11): จำลองเขียนทับใน mock (79 → 30 รายการ) → รอบถัดไปขึ้น MISMATCH ระบุรายการที่หาย; รันซ้ำไม่แจ้งซ้ำ
 */

describe('compareDocuments (ST8-T11) — ไม่แตะฐานข้อมูล', () => {
  const line = (n: number, extra: Record<string, unknown> = {}) => ({
    lineNo: n,
    deliveryOrder: { number: `DO-${n}`, date: '2026-11-01' },
    trip: { vehiclePlate: '70-1', driverName: 'สมชาย' },
    route: { originName: 'A', destinationName: 'B' },
    quantity: '1',
    unitPrice: '100',
    ...extra,
  });
  const doc = (lines: unknown[], extra: Record<string, unknown> = {}): CanonicalDocument => ({
    id: 'x',
    number: 'INV-1',
    issueDate: '2026-11-01',
    dueDate: '2026-12-01',
    customer: { externalId: 'C1' },
    lines,
    ...extra,
  });

  it('ตรงกัน = MATCH · ตัวเลขเทียบค่า (1 = 1.00) · ว่าง/null/ไม่มีช่อง = เท่ากัน · ไม่มียอดฝั่ง ERP = ข้าม TOTAL พร้อมเหตุผล', () => {
    const a = doc([line(1), line(2, { description: null })], { totals: { total: '200.00' } });
    const b = doc([line(2, { quantity: '1.00', description: '' }), line(1)]);
    const r = compareDocuments(a, b);
    expect(r).toMatchObject({ matched: true, severity: null, levels: [] });
    expect(r.totalSkipped).toBe(TOTAL_SKIP_NO_AMOUNTS);
  });

  it('จับคู่ด้วยเลข DO ไม่ใช่ลำดับ: รายการหาย (LINE_COUNT + missingLines) · ช่องว่าง (LINE_FIELD) · เกิน (EXTRA_LINE) · หัว (HEADER)', () => {
    const a = doc([line(1), line(2), line(3)]);
    const b = doc(
      [
        line(3, { lineNo: 1 }),
        line(1, { lineNo: 2, trip: { vehiclePlate: '', driverName: 'สมชาย' } }),
        line(9),
      ],
      { dueDate: '2026-12-31' },
    );
    const r = compareDocuments(a, b);
    expect(r.matched).toBe(false);
    expect(r.levels).toEqual(['HEADER', 'LINE_COUNT', 'LINE_FIELD', 'EXTRA_LINE']);
    expect(r.severity).toBe('MONEY');
    expect(r.diff.missingLines).toEqual([{ lineNo: 2, deliveryOrderNumber: 'DO-2' }]);
    expect(r.diff.extraLines).toEqual([{ lineNo: 9, deliveryOrderNumber: 'DO-9' }]);
    expect(r.diff.header).toEqual([
      { field: 'dueDate', local: '2026-12-01', remote: '2026-12-31' },
    ]);
    expect(r.diff.lineFields).toEqual([
      {
        lineNo: 1,
        deliveryOrderNumber: 'DO-1',
        field: 'trip.vehiclePlate',
        local: '70-1',
        remote: null,
      },
    ]);
    // ส่วนต่างเดิม = hash เดิม (ไม่ขึ้นกับลำดับรายการฝั่ง ERP) · ต่างไป = hash ใหม่
    const again = compareDocuments(
      a,
      doc([...(b.lines as unknown[])].reverse(), { dueDate: '2026-12-31' }),
    );
    expect(again.diffHash).toBe(r.diffHash);
    expect(compareDocuments(a, doc([line(1)])).diffHash).not.toBe(r.diffHash);
  });

  it('เฉพาะช่อง/หัว = FIELD · ชื่อคนขับเก็บเป็น *** · DO เดียวหลายรายการจับด้วย lineNo', () => {
    const a = doc([
      line(1),
      line(2, { deliveryOrder: { number: 'DO-1', date: '2026-11-01' }, unitPrice: '50' }),
    ]);
    const b = doc([
      line(2, { deliveryOrder: { number: 'DO-1', date: '2026-11-01' }, unitPrice: '50' }),
      line(1, { trip: { vehiclePlate: '70-1', driverName: 'คนอื่น' } }),
    ]);
    const r = compareDocuments(a, b);
    expect(r).toMatchObject({ matched: false, severity: 'FIELD', levels: ['LINE_FIELD'] });
    expect(r.diff.lineFields).toEqual([
      {
        lineNo: 1,
        deliveryOrderNumber: 'DO-1',
        field: 'trip.driverName',
        local: '***',
        remote: '***',
      },
    ]);
  });

  it('TOTAL เมื่อ ERP คืนยอด: tolerance 0.01 + ยอด VAT · หัวของใบที่ ERP แยกเก็บต่างกัน = HEADER', () => {
    const t = (total: string, vatAmount: string) => ({ totals: { total, vatAmount } });
    expect(
      compareDocuments(doc([line(1)], t('107.00', '7.00')), doc([line(1)], t('107.01', '7.00')))
        .matched,
    ).toBe(true);
    const r = compareDocuments(
      doc([line(1)], t('107.00', '7.00')),
      doc([line(1)], t('107.02', '7.50')),
    );
    expect(r).toMatchObject({ severity: 'MONEY', levels: ['TOTAL'], totalSkipped: null });
    expect(r.diff.total.map((x) => x.field)).toEqual(['totals.total', 'totals.vatAmount']);
    const p = compareDocuments(
      doc([line(1)]),
      doc([line(1)], { partHeaderDiffs: [{ ref: 'INV-1-V7', dueDate: '2027-01-01' }] }),
    );
    expect(p.diff.header).toEqual([
      { field: 'parts[INV-1-V7].dueDate', local: null, remote: '2027-01-01' },
    ]);
  });

  it('วันทำการสุดท้ายของเดือน (จันทร์–ศุกร์)', () => {
    expect(lastBusinessDay('2026-11-05')).toBe('2026-11-30'); // จันทร์
    expect(lastBusinessDay('2027-02-10')).toBe('2027-02-26'); // 28 = อาทิตย์ → ศุกร์ 26
    expect(lastBusinessDay('2026-10-01')).toBe('2026-10-30'); // 31 = เสาร์
  });
});

const KEY = 'krs-reconcile-test-key-7d21';

describe('Reconcile engine ครบวงจร (ST8-T11)', { timeout: 900_000 }, () => {
  let app: NestExpressApplication;
  const plat: PrismaClient = platform();
  let dispatcher: OutboxDispatcher;
  let engine: DocumentReconcileService;
  let mock: MockKrs;
  let tenantId: string;
  let ppCompany: string;
  let ppBranch: string;
  let customerId: string;
  let freight: string;
  let service: string;
  let admin: string;
  let accounting: string;
  let conId: string;
  let conUuid: string;
  let seq = 0;
  const today = bangkokToday();
  const prevPrivate = process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
  const CARRIER = 'บริษัท รถร่วมตัวอย่าง จำกัด';
  const DRIVER = 'สมชาย คนขับทดสอบ';

  const drain = async () => {
    await plat.$executeRaw`UPDATE integration_outbox SET next_run_at = now() - interval '1 second'
                            WHERE status IN ('PENDING', 'FAILED_RETRYABLE')`;
    await dispatcher.drain();
  };
  const later = (min: number) => new Date(Date.now() + min * 60_000);
  const fetches = (localId: string) =>
    plat.integrationOutbox.findMany({
      where: { tenantId, sink: 'erp', localId, operation: 'FETCH_DOCUMENT' },
      orderBy: { seq: 'asc' },
    });
  const results = (localId: string) =>
    plat.reconcileResult.findMany({ where: { tenantId, localId }, orderBy: { createdAt: 'asc' } });
  const mapping = (localId: string) =>
    plat.externalMapping.findFirstOrThrow({ where: { tenantId, entityType: 'INVOICE', localId } });
  const noti = (channel: 'in_app' | 'email' = 'in_app') =>
    plat.notification.findMany({
      where: { tenantId, templateCode: 'reconcile.document_mismatch_found', channel },
    });

  /** DO n ใบ (ใช้ SO/สถานที่ร่วมกัน) — รถบริษัท (มีชื่อคนขับ) หรือรถร่วม (ไม่มีชื่อคนขับ — D-64) */
  async function deliveryOrders(n: number, kind: 'own' | 'subcon' = 'own') {
    const tag = `R${++seq}`;
    const site = (k: string) =>
      plat.customerSite.create({
        data: { tenantId, code: `S${k}-${tag}`, name: `คลัง ${k} ${tag}`, address: { line1: 'x' } },
      });
    const [a, b] = [await site('A'), await site('B')];
    const so = await plat.salesOrder.create({
      data: {
        tenantId,
        soNo: `SO-${tag}`,
        externalId: `KRS-NSF-SAMPLE-SO-${tag}`,
        source: 'MANUAL',
        customerId,
        billingCompanyId: ppCompany,
        requestedDate: new Date(`${today}T00:00:00Z`),
        status: 'RECEIVED',
      },
    });
    const out: string[] = [];
    for (let i = 1; i <= n; i += 1) {
      const trip = await plat.trip.create({
        data: {
          tenantId,
          tripNo: `TRP-${tag}-${i}`,
          tripDate: new Date(`${today}T00:00:00Z`),
          vehiclePlateSnapshot: kind === 'own' ? '70-1234' : '71-9999',
          ...(kind === 'own' ? { driverNameSnapshot: DRIVER } : { carrierNameSnapshot: CARRIER }),
        },
      });
      const d = await plat.deliveryOrder.create({
        data: {
          tenantId,
          doNo: `DO-${tag}-${String(i).padStart(3, '0')}`,
          doDate: new Date(`${today}T00:00:00Z`),
          salesOrderId: so.id,
          customerId,
          tripId: trip.id,
          originSiteId: a.id,
          destSiteId: b.id,
          originStopSeq: 1,
          destStopSeq: 2,
        },
      });
      out.push(d.id);
    }
    return out;
  }

  /** ออกใบแจ้งหนี้ (1 รายการต่อ DO) แล้วส่งเข้า mock KRS */
  async function issued(doIds: string[], vat: (i: number) => VatType = () => 'EXEMPT_TRANSPORT') {
    const inv = await plat.invoice.create({
      data: {
        tenantId,
        customerId,
        issuingCompanyId: ppCompany,
        issuingBranchId: ppBranch,
        status: 'DRAFT',
        creditTermDays: 30,
        createdBy: 'u-prep',
        lines: {
          create: doIds.map((doId, i) => {
            const v = vat(i);
            return {
              tenantId,
              lineNo: i + 1,
              serviceItemId: v === 'VAT_7' ? service : freight,
              description: v === 'VAT_7' ? 'ค่ายกขน' : 'ค่าขนส่ง',
              quantity: '1',
              unitLabel: 'เที่ยว',
              unitPrice: '1000.00',
              amount: '1000.00',
              vatType: v,
              vatAmount: v === 'VAT_7' ? '70.00' : '0',
              whtRate: v === 'VAT_7' ? '3.00' : '1.00',
              deliveryOrderId: doId,
              doAnchor: true,
            };
          }),
        },
      },
    });
    const id = encodeId('invoice', inv.id);
    const r = await api(app, accounting)
      .post(`/v1/invoices/${id}/finalize`)
      .set('If-Match', `"${inv.version}"`)
      .send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await drain();
    const m = await mapping(inv.id);
    expect(m.status, JSON.stringify(m.lastError)).toBe('SYNCED');
    return {
      uuid: inv.id,
      id,
      invoiceNo: r.body.invoiceNo as string,
      transactionNo: m.externalId!,
    };
  }

  beforeAll(async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = '1';
    await truncateAll();
    app = await bootApp();
    dispatcher = app.get(OutboxDispatcher);
    engine = app.get(DocumentReconcileService);
    app.get(ErpAdapterRegistry).replace(new KrsAdapter({ allowPrivate: true }));
    mock = await startMockKrs({ apiKey: KEY });
    tenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท ขนส่ง กระทบยอด ทดสอบ จำกัด' }))
      .id;
    await plat.tenant.update({ where: { id: tenantId }, data: { planCode: 'ent' } });
    const c = await plat.company.create({
      data: { tenantId, legalName: 'บริษัท พีพี ตัวอย่าง จำกัด', taxId: validTaxId(8201) },
    });
    ppCompany = c.id;
    ppBranch = (
      await plat.branch.create({
        data: {
          tenantId,
          companyId: c.id,
          branchCode: '00000',
          branchLabel: 'สำนักงานใหญ่',
          isDefaultIssuer: true,
          address: { line1: '1', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' },
        },
      })
    ).id;
    customerId = (
      await plat.customer.create({
        data: {
          tenantId,
          code: 'C-REC1',
          legalName: 'บริษัท ลูกค้า กระทบยอด ตัวอย่าง จำกัด',
          taxId: validTaxId(8203),
          branchCode: '00000',
          billingAddress: { line1: '9 ถ.ตัวอย่าง', province: 'ระยอง', postcode: '21000' },
        },
      })
    ).id;
    const item = (code: string, vatType: VatType, whtRate: string) =>
      plat.serviceItem.create({
        data: {
          tenantId,
          code,
          nameTh: code,
          vatType,
          whtRate,
          calcUnit: 'PER_TRIP',
          unitLabel: 'เที่ยว',
          side: 'SELL',
        },
      });
    freight = (await item('T11-FRT', 'EXEMPT_TRANSPORT', '1.00')).id;
    service = (await item('T11-LIFT', 'VAT_7', '3.00')).id;
    admin = await tokenFor(tenantId);
    accounting = await tokenFor(tenantId, SYSTEM_ROLES.accounting.permissions.join(' '), 'u-acc');
    // หัวหน้าบัญชี (payments:record) = ผู้รับแจ้ง MISMATCH
    const role = await plat.role.findFirstOrThrow({ where: { tenantId, code: 'accounting' } });
    const acc = await plat.appUser.create({
      data: {
        tenantId,
        email: 'rec-acc@t11.test',
        name: 'หัวหน้าบัญชี',
        status: 'ACTIVE',
        locale: 'th',
      },
    });
    await plat.userRole.create({ data: { tenantId, userId: acc.id, roleId: role.id } });

    const r = await api(app, admin)
      .post('/v1/connectors')
      .send({
        taxDocumentOwner: 'TMS',
        adapterKey: 'krs',
        companyId: encodeId('company', ppCompany),
        settings: { baseUrl: mock.apiBaseUrl, salePerson: 'S01' },
        credentials: { apiKey: KEY },
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    conId = r.body.id;
    conUuid = tryDecodeId('connector', conId)!;
    for (const [kind, code] of [
      ['UNIT', 'เที่ยว'],
      ['SALESPERSON', 'S01'],
    ] as const)
      await plat.erpMasterCode.create({
        data: {
          tenantId,
          connectorId: conUuid,
          kind,
          code,
          name: `${code} (ตัวอย่าง)`,
          source: 'IMPORT',
        },
      });
    for (const [serviceItemId, itemCode] of [
      [freight, 'SAMPLE-ITEM-FRT'],
      [service, 'SAMPLE-ITEM-LIFT'],
    ] as const)
      await plat.erpCodeMapping.create({
        data: { tenantId, connectorId: conUuid, serviceItemId, itemCode },
      });
    await api(app, admin)
      .put(`/v1/customers/${encodeId('customer', customerId)}/erp-codes/${conId}`)
      .send({ externalId: 'PP-C001' })
      .expect(200);
    await api(app, admin).post(`/v1/connectors/${conId}/resume`).send({}).expect(200);
    await api(app, admin)
      .patch(`/v1/connectors/${conId}`)
      .send({
        capabilitiesEnabled: ['pullOrders', 'pushInvoice', 'ownsDocumentNumber', 'fetchDocument'],
      })
      .expect(200);
  });
  beforeEach(() => {
    mock.clearFaults();
    mock.setOverwrite(false);
  });
  afterAll(async () => {
    if (prevPrivate === undefined) delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
    else process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = prevPrivate;
    await mock?.stop();
    await app?.close();
    await plat.$disconnect();
  });

  it('เกณฑ์ตรวจรับ: AFTER_PUSH ตรง → ACCEPTED · เขียนทับ 79 → 30 → รอบถัดไป MISMATCH ระบุ 49 รายการที่หาย · รันซ้ำไม่แจ้งซ้ำ', async () => {
    const dos = await deliveryOrders(79);
    const inv = await issued(dos);
    expect(mock.getInvoice(inv.transactionNo)!.data.lines).toHaveLength(79);
    // ก่อนเทียบ = SENT
    expect(
      (await api(app, admin).get(`/v1/invoices/${inv.id}`).expect(200)).body.sync,
    ).toMatchObject({
      state: 'SYNCED',
      reconcileState: 'SENT',
    });

    // AFTER_PUSH ทันที (ผ่านคิว FETCH_DOCUMENT ของ connector — ไม่เรียก ERP ตรง)
    expect(await engine.scheduleAfterPush()).toBe(1);
    expect(await engine.scheduleAfterPush()).toBe(0); // ตั้งซ้ำไม่ได้คำสั่งเพิ่ม
    const gets0 = mock.requests().filter((q) => q.method === 'GET').length;
    await drain();
    expect(mock.requests().filter((q) => q.method === 'GET').length).toBe(gets0 + 1);
    const [f0] = await fetches(inv.uuid);
    expect(f0).toMatchObject({ status: 'DONE' });
    expect((f0!.payload as { reconcile: unknown }).reconcile).toMatchObject({
      source: 'AFTER_PUSH',
    });
    expect((f0!.result as { reconcile: unknown }).reconcile).toMatchObject({
      outcome: 'MATCH',
      state: 'ACCEPTED',
      totalSkipped: 'remote_has_no_amounts',
    });
    // ผลของคำสั่งไม่เก็บเอกสารทั้งก้อน (ชื่อคนขับ)
    expect(JSON.stringify(f0!.result)).not.toContain(DRIVER);
    expect(await mapping(inv.uuid)).toMatchObject({ status: 'SYNCED', reconcileState: 'ACCEPTED' });
    expect(await results(inv.uuid)).toHaveLength(0);

    // บัญชีกดบันทึกใน KRS → โปรแกรมเขียนรายการใหม่เหลือ 30 รายการ
    mock.overwriteInvoice(inv.transactionNo, { keepLines: 30, renumberLineIds: true });
    // รอบ AFTER_PUSH +60 นาที
    expect(await engine.scheduleAfterPush(later(61))).toBe(1);
    await drain();
    const rows = await results(inv.uuid);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      result: 'MISMATCH',
      severity: 'MONEY',
      source: 'AFTER_PUSH',
      resolvedAt: null,
    });
    const diff = row.diff as {
      levels: string[];
      lineCount: { local: number; remote: number };
      missingLines: { lineNo: number; deliveryOrderNumber: string }[];
      lineFields: unknown[];
      extraLines: unknown[];
    };
    expect(diff.levels).toEqual(['LINE_COUNT']);
    expect(diff.lineCount).toEqual({ local: 79, remote: 30 });
    expect(diff.missingLines).toHaveLength(49);
    expect(diff.missingLines[0]).toMatchObject({ lineNo: 31 });
    expect(diff.missingLines.map((m) => m.deliveryOrderNumber)).toContain(
      (await plat.deliveryOrder.findUniqueOrThrow({ where: { id: dos[78]! } })).doNo,
    );
    expect(diff.lineFields).toEqual([]); // จับคู่ด้วยเลข DO — เลขบรรทัดใหม่ของ KRS ไม่ทำให้ต่าง
    expect(diff.extraLines).toEqual([]);
    expect(await mapping(inv.uuid)).toMatchObject({
      status: 'MISMATCH',
      reconcileState: 'MISMATCH',
    });
    // API: ใบ + รายการ MISMATCH ระบุรายการที่หาย
    expect(
      (await api(app, admin).get(`/v1/invoices/${inv.id}`).expect(200)).body.sync,
    ).toMatchObject({
      reconcileState: 'MISMATCH',
    });
    const list = await api(app, admin).get(`/v1/reconcile-results?invoiceId=${inv.id}`).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      check: 'DOCUMENT',
      code: 'content_mismatch',
      result: 'MISMATCH',
    });
    expect(list.body.data[0].documentDiff).toMatchObject({
      levels: ['LINE_COUNT'],
      lineCount: { local: 79, remote: 30 },
      // KRS ไม่คืนยอดเงิน — ไม่เทียบยอด (ไม่คำนวณแทน)
      totalSkipped: 'remote_has_no_amounts',
    });
    expect(list.body.data[0].documentDiff.missingLines).toHaveLength(49);
    // แจ้งหัวหน้าบัญชีทันที (MONEY = ในระบบ + อีเมล) · audit
    expect(await noti()).toHaveLength(1);
    expect(await noti('email')).toHaveLength(1);
    expect(
      await plat.auditLog.count({
        where: { tenantId, action: 'reconcile.mismatch_found', entityId: row.id },
      }),
    ).toBe(1);

    // รันซ้ำ (NIGHTLY + สั่งเอง) — ส่วนต่างเดิม: ไม่สร้างแถว/ไม่แจ้ง/ไม่ลง audit ซ้ำ
    const r1 = await engine.runRound(tenantId, conUuid, 'NIGHTLY', today);
    expect(r1.queued).toBeGreaterThanOrEqual(1);
    expect((await engine.runRound(tenantId, conUuid, 'NIGHTLY', today)).queued).toBe(0);
    await drain();
    // สั่งเอง = คน + settings:write (แบบเดียวกับการจัดการ connector — ST7-T21)
    const manual = await api(app, admin)
      .post('/v1/reconcile-runs')
      .send({
        connectorId: conId,
        check: 'DOCUMENT',
        invoiceIds: [inv.id],
        reason: 'บัญชีแจ้งว่าแก้ใน KRS แล้ว ขอตรวจซ้ำ',
      });
    expect(manual.status, JSON.stringify(manual.body)).toBe(202);
    expect(manual.body).toMatchObject({ status: 'QUEUED', queued: 1, notInErp: [] });
    await drain();
    const again = await results(inv.uuid);
    expect(again).toHaveLength(1);
    expect(again[0]!.lastSeenAt.getTime()).toBeGreaterThan(row.lastSeenAt.getTime());
    expect(await noti()).toHaveLength(1);
    expect(
      await plat.auditLog.count({ where: { tenantId, action: 'reconcile.mismatch_found' } }),
    ).toBe(1);
    expect(
      await plat.auditLog.findFirst({ where: { tenantId, action: 'reconcile.run_requested' } }),
    ).toMatchObject({ reason: 'บัญชีแจ้งว่าแก้ใน KRS แล้ว ขอตรวจซ้ำ' });
    const sources = (await fetches(inv.uuid)).map(
      (f) => (f.payload as { reconcile: { source: string } }).reconcile.source,
    );
    expect(sources).toEqual(['AFTER_PUSH', 'AFTER_PUSH', 'NIGHTLY', 'MANUAL']);
  });

  it('ใบที่ KRS แยกตาม vat_type (2 เอกสาร) อ่านรวมแล้วตรง · ใบหนึ่งถูกเขียนทับ → MISMATCH ระบุ DO ที่หาย', async () => {
    const dos = await deliveryOrders(4);
    const inv = await issued(dos, (i) => (i % 2 ? 'VAT_7' : 'EXEMPT_TRANSPORT'));
    const docs = ((await mapping(inv.uuid)).detail as { documents: { externalId: string }[] })
      .documents;
    expect(docs).toHaveLength(2);
    await engine.scheduleAfterPush();
    await drain();
    expect(await mapping(inv.uuid)).toMatchObject({ reconcileState: 'ACCEPTED' });
    // ใบที่ 2 (VAT 7%) เหลือรายการแรกรายการเดียว
    mock.overwriteInvoice(docs[1]!.externalId, { keepLines: 1 });
    await engine.runRound(tenantId, conUuid, 'NIGHTLY', today);
    await drain();
    const [row] = await results(inv.uuid);
    expect(row).toMatchObject({ result: 'MISMATCH', source: 'NIGHTLY', severity: 'MONEY' });
    const lost = (await plat.deliveryOrder.findUniqueOrThrow({ where: { id: dos[3]! } })).doNo;
    expect((row!.diff as { missingLines: unknown[] }).missingLines).toEqual([
      { lineNo: 4, deliveryOrderNumber: lost },
    ]);
  });

  it('D-64: เที่ยวรถร่วมไม่มีชื่อคนขับ — KRS เก็บชื่อบริษัทรถร่วม = ไม่ถือว่าต่าง · ช่องรถถูกล้าง = LINE_FIELD (FIELD, ในระบบเท่านั้น)', async () => {
    const inv = await issued(await deliveryOrders(2, 'subcon'));
    const stored = mock.getInvoice(inv.transactionNo)!.data.lines;
    expect(stored.map((l) => l.carPerson)).toEqual([CARRIER, CARRIER]);
    await engine.scheduleAfterPush();
    await drain();
    expect(await mapping(inv.uuid)).toMatchObject({ reconcileState: 'ACCEPTED' });
    expect(await results(inv.uuid)).toHaveLength(0);

    const before = { inApp: (await noti()).length, email: (await noti('email')).length };
    mock.overwriteInvoice(inv.transactionNo, { keepLines: null, blankFields: ['carId'] });
    await engine.runRound(tenantId, conUuid, 'NIGHTLY', addDay(today, 1));
    await drain();
    const [row] = await results(inv.uuid);
    expect(row).toMatchObject({ result: 'MISMATCH', severity: 'FIELD' });
    const d = row!.diff as {
      levels: string[];
      lineFields: { field: string; local: string; remote: null }[];
    };
    expect(d.levels).toEqual(['LINE_FIELD']);
    expect(d.lineFields.map((f) => [f.field, f.local, f.remote])).toEqual([
      ['trip.vehiclePlate', '71-9999', null],
      ['trip.vehiclePlate', '71-9999', null],
    ]);
    // FIELD = ในระบบ (รวมกลุ่มกับแจ้งเตือนที่ยังไม่อ่านของ connector เดียวกันได้) · ไม่ส่งอีเมล
    expect((await noti('email')).length).toBe(before.email);
    expect((await noti()).length).toBeGreaterThanOrEqual(Math.max(1, before.inApp));
  });

  it('REMOTE_MISSING: KRS ตอบ 404 → reconcile_result REMOTE_MISSING (MONEY) + MISMATCH · รอบถัดไปพบอีก → ปิด + ACCEPTED', async () => {
    const inv = await issued(await deliveryOrders(1));
    mock.injectFault({ kind: 'status', status: 404, method: 'GET', times: 0 });
    await engine.scheduleAfterPush();
    await drain();
    const [row] = await results(inv.uuid);
    expect(row).toMatchObject({
      result: 'REMOTE_MISSING',
      severity: 'MONEY',
      source: 'AFTER_PUSH',
    });
    expect((row!.diff as { code: string }).code).toBe('remote_missing');
    expect(await mapping(inv.uuid)).toMatchObject({
      status: 'MISMATCH',
      reconcileState: 'MISMATCH',
    });
    const [f] = await fetches(inv.uuid);
    expect(f).toMatchObject({ status: 'DONE' });
    // ซ้ำ = ไม่สร้างแถวใหม่
    await engine.runRound(tenantId, conUuid, 'NIGHTLY', addDay(today, 2));
    await drain();
    expect(await results(inv.uuid)).toHaveLength(1);
    mock.clearFaults();
    await engine.runRound(tenantId, conUuid, 'NIGHTLY', addDay(today, 3));
    await drain();
    const [closed] = await results(inv.uuid);
    expect(closed!.resolvedAt).not.toBeNull();
    expect(await mapping(inv.uuid)).toMatchObject({ status: 'SYNCED', reconcileState: 'ACCEPTED' });
  });

  it('ERP_UNREACHABLE (ลองครบแล้วยังล่ม) = INFO ไม่เปลี่ยนผลกระทบยอด · รอบที่ 2 ติดกัน = repeated', async () => {
    const inv = await issued(await deliveryOrders(1));
    const cmd = {
      id: '00000000-0000-4000-8000-0000000000f1',
      tenantId,
      sink: 'erp',
      targetId: conUuid,
      operation: 'FETCH_DOCUMENT',
      entityType: 'invoice',
      localId: inv.uuid,
      payload: { ref: { number: inv.invoiceNo }, reconcile: { source: 'NIGHTLY', run: 'x' } },
      status: 'FAILED_FINAL' as const,
      errorClass: 'TRANSIENT',
      code: 'unreachable',
    };
    await engine.onSettled(cmd);
    await engine.onSettled(cmd);
    const rows = await results(inv.uuid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: 'ERP_UNREACHABLE', severity: 'INFO' });
    expect((await mapping(inv.uuid)).reconcileState).toBeNull();
    // SKIPPED / ไม่ใช่ปลายทางล่ม = ไม่บันทึก
    await engine.onSettled({ ...cmd, status: 'SKIPPED', errorClass: 'CAPABILITY' });
    expect(await results(inv.uuid)).toHaveLength(1);
  });

  it('สั่งเอง: เหตุผล < 10 = 422 · ไม่เลือกใบ = 422 · ใบที่ไม่อยู่ใน ERP = notInErp · tenant อื่น = 404', async () => {
    // ไม่มี settings:write (role บัญชี) = 403
    const acc = await api(app, accounting)
      .post('/v1/reconcile-runs')
      .send({
        connectorId: conId,
        check: 'DOCUMENT',
        invoiceIds: ['ivc_x'],
        reason: 'ตรวจซ้ำหลังแก้ในระบบบัญชี',
      });
    expect(acc.status).toBe(403);
    const bad = await api(app, admin)
      .post('/v1/reconcile-runs')
      .send({ connectorId: conId, check: 'DOCUMENT', invoiceIds: ['ivc_x'], reason: 'สั้น' });
    expect(bad.status).toBe(422);
    const none = await api(app, admin)
      .post('/v1/reconcile-runs')
      .send({ connectorId: conId, check: 'DOCUMENT', reason: 'ตรวจซ้ำหลังแก้ในระบบบัญชี' });
    expect(none.status).toBe(422);
    const draftOnly = await plat.invoice.create({
      data: {
        tenantId,
        customerId,
        issuingCompanyId: ppCompany,
        issuingBranchId: ppBranch,
        status: 'DRAFT',
        creditTermDays: 30,
        createdBy: 'u-prep',
      },
    });
    const r = await api(app, admin)
      .post('/v1/reconcile-runs')
      .send({
        connectorId: conId,
        check: 'DOCUMENT',
        invoiceIds: [encodeId('invoice', draftOnly.id), 'not-an-id'],
        reason: 'ตรวจซ้ำหลังแก้ในระบบบัญชี',
      });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body).toMatchObject({ queued: 0 });
    expect(r.body.notInErp).toEqual(['not-an-id', encodeId('invoice', draftOnly.id)]);
    // tenant อื่นเห็น connector/ใบของ tenant นี้ไม่ได้
    const other = (await createTenantWithDefaults(plat, { name: 'บริษัท อื่น จำกัด' })).id;
    await plat.tenant.update({ where: { id: other }, data: { planCode: 'ent' } });
    const x = await api(app, await tokenFor(other))
      .post('/v1/reconcile-runs')
      .send({
        connectorId: conId,
        check: 'DOCUMENT',
        invoiceIds: [encodeId('invoice', draftOnly.id)],
        reason: 'ตรวจซ้ำหลังแก้ในระบบบัญชี',
      });
    expect(x.status).toBe(404);
  });

  it('ตั้งรอบตามเวลาไทย: NIGHTLY ตั้งแต่ 02:00 (01:59 ยังไม่) · 1 job ต่อ connector ต่อวัน · PRE_CLOSE วันทำการสุดท้ายของเดือน 17:00', async () => {
    const jobs = () => plat.job.findMany({ where: { tenantId, type: RECONCILE_JOB } });
    await plat.job.deleteMany({ where: { tenantId, type: RECONCILE_JOB } });
    // 2026-11-24 01:59 เวลาไทย = 2026-11-23T18:59Z
    expect(await engine.scheduleRounds(new Date('2026-11-23T18:59:00Z'))).toBe(0);
    expect(await engine.scheduleRounds(new Date('2026-11-23T19:00:00Z'))).toBe(1);
    expect(await engine.scheduleRounds(new Date('2026-11-23T19:10:00Z'))).toBe(0);
    expect((await jobs()).map((j) => j.payload)).toEqual([
      { connectorId: conUuid, source: 'NIGHTLY', day: '2026-11-24' },
    ]);
    // 2026-11-30 (จันทร์ — วันทำการสุดท้าย) 16:59 ไทย = NIGHTLY เท่านั้น · 17:00 = PRE_CLOSE
    expect(await engine.scheduleRounds(new Date('2026-11-30T09:59:00Z'))).toBe(1);
    expect(await engine.scheduleRounds(new Date('2026-11-30T10:00:00Z'))).toBe(1);
    expect(await engine.scheduleRounds(new Date('2026-11-30T12:00:00Z'))).toBe(0);
    expect((await jobs()).map((j) => (j.payload as { source: string }).source).sort()).toEqual([
      'NIGHTLY',
      'NIGHTLY',
      'PRE_CLOSE',
    ]);
    // 2026-11-27 (ศุกร์ ไม่ใช่วันทำการสุดท้าย) 18:00 ไทย = ไม่มี PRE_CLOSE
    await plat.job.deleteMany({ where: { tenantId, type: RECONCILE_JOB } });
    expect(await engine.scheduleRounds(new Date('2026-11-27T11:00:00Z'))).toBe(1);
    expect((await jobs()).map((j) => (j.payload as { source: string }).source)).toEqual([
      'NIGHTLY',
    ]);
    await plat.job.deleteMany({ where: { tenantId, type: RECONCILE_JOB } });
  });
});

function addDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
