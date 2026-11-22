import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { DbService } from '../src/db/db.service';
import { DemoAdapter } from '../src/erp-adapters/demo/demo.adapter';
import { JobQueue } from '../src/jobs/job-queue.service';
import { ErpAdapterRegistry } from '../src/modules/erp/erp-adapter.registry';
import { ErpInboundEffects } from '../src/modules/erp/erp-inbound-effects';
import {
  PAYMENT_STATUS_PULL_JOB,
  PaymentStatusPullService,
} from '../src/modules/erp/payment-status-pull.service';
import { OutboxDispatcher } from '../src/modules/integration/outbox.dispatcher';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST7-T21 Payment status pull (docs/04 G3 "Payment status pull", F5 "Payment status จาก ERP"; docs/01 §6.1 `fetchPaymentStatus`)
 * เกณฑ์ตรวจรับ (plan/01): DemoProvider แจ้งว่าใบ X จ่ายแล้ว → เกิด payment ใน TMS · ยอดต่าง → ขึ้น MISMATCH
 * + ดึงซ้ำไม่สร้างซ้ำ · รับชำระที่คนบันทึกเองแล้วยอดตรง = ไม่สร้างซ้ำ · ไม่มี capability = ไม่มีรอบดึง · แยก tenant · sandbox ไม่ดึง
 */
describe('Payment status pull (ST7-T21)', { timeout: 600_000 }, () => {
  let app: NestExpressApplication;
  const plat = platform();
  let db: DbService;
  let dispatcher: OutboxDispatcher;
  let queue: JobQueue;
  let pull: PaymentStatusPullService;
  let demo: DemoAdapter;
  let tenantId: string;
  let otherTenantId: string;
  let companyId: string;
  let branchId: string;
  let customerId: string;
  let serviceItemId: string;
  let admin: string;
  let accounting: string;
  let conId: string;
  let conUuid: string;
  let seq = 0;
  const today = bangkokToday();
  /** วันนี้ 07:30 น. เวลาไทย (หลังเวลาเริ่มรอบ 06:00) */
  const at0730 = new Date(`${today}T00:30:00.000Z`);

  const drainOutbox = async () => {
    await plat.$executeRaw`UPDATE integration_outbox SET next_run_at = now() - interval '1 second'
                            WHERE status IN ('PENDING', 'FAILED_RETRYABLE')`;
    await dispatcher.drain();
  };
  const drainJobs = async () => {
    await plat.$executeRaw`UPDATE job SET run_at = now() - interval '1 second' WHERE status = 'PENDING'`;
    for (let i = 0; i < 30 && (await queue.runOnce()); i++);
  };
  const pullJobs = () =>
    plat.job.findMany({
      where: { tenantId, type: PAYMENT_STATUS_PULL_JOB },
      orderBy: { createdAt: 'asc' },
    });
  const paymentsOf = (invoiceUuid: string) =>
    plat.payment.findMany({
      where: { tenantId, allocations: { some: { invoiceId: invoiceUuid } } },
      include: { allocations: true },
      orderBy: { createdAt: 'asc' },
    });
  const mismatches = (invoiceUuid: string) =>
    plat.reconcileResult.findMany({
      where: { tenantId, localId: invoiceUuid },
      orderBy: { createdAt: 'asc' },
    });
  const getInv = async (id: string) =>
    (await api(app, admin).get(`/v1/invoices/${id}`).expect(200)).body as Record<string, any>;
  const run = () => pull.pullConnector(tenantId, conUuid, { source: 'MANUAL' });

  /** ร่างใบแจ้งหนี้ 1 บรรทัด → finalize ผ่าน API → ส่งถึง ERP จำลอง (outbox) */
  const pushedInvoice = async (amount = '1000.00') => {
    const n = ++seq;
    const inv = await plat.invoice.create({
      data: {
        tenantId,
        customerId,
        issuingCompanyId: companyId,
        issuingBranchId: branchId,
        status: 'DRAFT',
        creditTermDays: 30,
        createdBy: 'u-prep',
        lines: {
          create: {
            tenantId,
            lineNo: 1,
            serviceItemId,
            description: `ค่าขนส่ง เที่ยวที่ ${n}`,
            quantity: '1',
            unitLabel: 'เที่ยว',
            unitPrice: amount,
            amount,
            vatType: 'EXEMPT_TRANSPORT',
            vatAmount: '0',
            whtRate: '1.00',
            isUserAdded: true,
          },
        },
      },
    });
    const id = encodeId('invoice', inv.id);
    const r = await api(app, accounting)
      .post(`/v1/invoices/${id}/finalize`)
      .set('If-Match', `"${inv.version}"`)
      .send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await drainOutbox();
    const m = await plat.externalMapping.findFirst({
      where: { tenantId, entityType: 'INVOICE', localId: inv.id },
    });
    const cmds = await plat.integrationOutbox.findMany({ where: { tenantId, localId: inv.id } });
    expect(
      m,
      `ใบต้องถึง ERP จำลอง (external_mapping) — ${JSON.stringify(cmds.map((c) => [c.operation, c.status, c.lastError]))}`,
    ).toMatchObject({ status: 'SYNCED' });
    return { id, uuid: inv.id, invoiceNo: r.body.invoiceNo as string };
  };
  const manualPayment = async (invoiceId: string, amount: string) => {
    const r = await api(app, accounting)
      .post('/v1/payments')
      .send({
        receivedDate: today,
        method: 'TRANSFER',
        amountReceived: amount,
        allocations: [{ invoiceId, amount }],
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { id: string; version: number };
  };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    db = app.get(DbService);
    dispatcher = app.get(OutboxDispatcher);
    queue = app.get(JobQueue);
    pull = app.get(PaymentStatusPullService);
    demo = app.get(ErpAdapterRegistry).get('demo') as DemoAdapter;
    demo.reset();
    tenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท ดึงสถานะรับชำระ จำกัด' })).id;
    otherTenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท อื่น จำกัด' })).id;
    await plat.tenant.updateMany({ data: { planCode: 'ent' } });
    companyId = (
      await plat.company.create({
        data: { tenantId, legalName: 'บริษัท ผู้ออกบิล จำกัด', taxId: validTaxId(7101) },
      })
    ).id;
    branchId = (
      await plat.branch.create({
        data: {
          tenantId,
          companyId,
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
          code: 'C-PS1',
          legalName: 'บริษัท ลูกค้ารับชำระ จำกัด',
          taxId: validTaxId(7102),
          branchCode: '00000',
        },
      })
    ).id;
    serviceItemId = (
      await plat.serviceItem.findFirstOrThrow({
        where: { tenantId, vatType: 'EXEMPT_TRANSPORT', status: 'ACTIVE', deletedAt: null },
      })
    ).id;
    admin = await tokenFor(tenantId);
    accounting = await tokenFor(tenantId, SYSTEM_ROLES.accounting.permissions.join(' '), 'u-acc');
    const r = await api(app, admin)
      .post('/v1/connectors')
      .send({
        adapterKey: 'demo',
        taxDocumentOwner: 'TMS',
        credentials: { apiKey: 'demo-key-0001' },
        capabilitiesEnabled: ['pushInvoice', 'fetchPaymentStatus'],
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    conId = r.body.id;
    conUuid = tryDecodeId('connector', conId)!;
    await api(app, admin).post(`/v1/connectors/${conId}/resume`).send({}).expect(200);
    // จับคู่รหัสสินค้า (ST7-T18) ก่อนส่งใบเข้า ERP จำลอง
    await plat.erpCodeMapping.create({
      data: { tenantId, connectorId: conUuid, serviceItemId, itemCode: 'FREIGHT' },
    });
  }, 300_000);
  beforeEach(async () => {
    await plat.$executeRaw`UPDATE job SET status = 'SKIPPED' WHERE status IN ('PENDING', 'RUNNING')`;
  });
  afterAll(async () => {
    demo.reset();
    await app.close();
    await plat.$disconnect();
  });

  it('เกณฑ์ตรวจรับ: ERP จำลองแจ้งว่าใบ X จ่ายแล้ว → scheduler รายวันสร้าง job → เกิด payment (source CONNECTOR) ใบเป็น PAID · audit + event · รอบซ้ำวันเดียวกันไม่สร้าง job/payment ซ้ำ', async () => {
    const x = await pushedInvoice('1000.00');
    demo.setPaymentStatus(tenantId, conUuid, x.invoiceNo, {
      status: 'PAID',
      paidAmount: '1000.00',
      whtAmount: '10.00',
      paidAt: `${today}T03:00:00.000Z`,
    });
    // ก่อน 06:00 น. เวลาไทย ยังไม่ถึงรอบ
    expect(await pull.scheduleDue(new Date(`${today}T22:59:00.000Z`))).toBe(0); // 05:59 น.
    expect(await pull.scheduleDue(at0730)).toBe(1);
    expect(await pull.scheduleDue(at0730)).toBe(0); // วันเดียวกัน connector เดิม = ไม่สร้างซ้ำ
    const jobs = await pullJobs();
    expect(jobs.filter((j) => (j.payload as any).day === today)).toHaveLength(1);
    await drainJobs();
    const job = (await pullJobs()).find((j) => (j.payload as any).day === today)!;
    expect(job.status, JSON.stringify(job.error)).toBe('SUCCEEDED');
    expect(job.result).toMatchObject({
      connector: 'demo',
      source: 'NIGHTLY',
      counts: { checked: 1, created: 1, mismatched: 0, errors: 0 },
    });

    const pays = await paymentsOf(x.uuid);
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ source: 'CONNECTOR', status: 'RECORDED', method: 'TRANSFER' });
    expect(pays[0]!.amountReceived.toFixed(2)).toBe('990.00');
    expect(pays[0]!.whtAmount.toFixed(2)).toBe('10.00');
    expect(pays[0]!.receivedDate.toISOString().slice(0, 10)).toBe(today);
    expect(pays[0]!.allocations[0]!.amount.toFixed(2)).toBe('1000.00');
    expect(pays[0]!.createdBy).toBe('connector:demo');
    const inv = await getInv(x.id);
    expect(inv.status).toBe('PAID');
    // กันซ้ำ: external_mapping PAYMENT ผูกกับยอดสะสมของใบ
    const pm = await plat.externalMapping.findFirst({
      where: { tenantId, entityType: 'PAYMENT', localId: pays[0]!.id },
    });
    expect(pm).toMatchObject({
      connectorId: conUuid,
      externalId: `paystatus:${x.uuid}:1000.00`,
      localNumber: pays[0]!.paymentNo,
    });
    // audit (ผู้กระทำ = connector) + event payment.recorded / invoice.paid ผ่านทางเดียวกับการรับชำระปกติ
    const audit = await plat.auditLog.findMany({
      where: { tenantId, action: 'payment.recorded', entityId: pays[0]!.id },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: 'connector:demo' });
    expect((audit[0]!.after as any).source).toBe('CONNECTOR');
    const events = await plat.domainEvent.findMany({
      where: { tenantId, type: { in: ['payment.recorded', 'invoice.paid'] } },
    });
    expect(events.map((e) => e.type).sort()).toEqual(['invoice.paid', 'payment.recorded']);
    expect(await mismatches(x.uuid)).toHaveLength(0);
    // API: รายการรับชำระเห็น source CONNECTOR
    const list = await api(app, accounting).get(`/v1/payments?invoiceId=${x.id}`).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ source: 'CONNECTOR' });

    // ดึงซ้ำ (รอบสั่งเอง) — ใบชำระครบแล้ว ไม่อยู่ในรอบ ไม่มี payment ใหม่
    const again = await run();
    expect(again.counts).toMatchObject({ checked: 0, created: 0 });
    expect(await paymentsOf(x.uuid)).toHaveLength(1);
  });

  it('ชำระบางส่วนหลายงวด: ดึงซ้ำยอดเดิมไม่สร้างซ้ำ · ยอดสะสมเพิ่ม → payment ใหม่เท่าส่วนเพิ่ม · WHT สะสมแตกเป็นงวด', async () => {
    const b = await pushedInvoice('1000.00');
    demo.setPaymentStatus(tenantId, conUuid, b.invoiceNo, {
      status: 'PARTIALLY_PAID',
      paidAmount: '400.00',
      whtAmount: '4.00',
      paidAt: null,
    });
    expect((await run()).counts).toMatchObject({ checked: 1, created: 1, matched: 0 });
    expect((await getInv(b.id)).status).toBe('PARTIALLY_PAID');
    // ดึงซ้ำ 2 รอบ (รวม 2 รอบพร้อมกัน) — ยอดสะสมเท่าเดิม = ตรง ไม่มี payment ใหม่
    const [r1, r2] = await Promise.all([run(), run()]);
    expect(r1.counts.created + r2.counts.created).toBe(0);
    expect(r1.counts.matched + r2.counts.matched).toBe(2);
    let pays = await paymentsOf(b.uuid);
    expect(pays).toHaveLength(1);
    expect(pays[0]!.allocations[0]!.amount.toFixed(2)).toBe('400.00');
    expect(pays[0]!.whtAmount.toFixed(2)).toBe('4.00');
    // ไม่มีวันที่จาก ERP → วันที่รับ = วันที่ดึง
    expect(pays[0]!.receivedDate.toISOString().slice(0, 10)).toBe(today);

    demo.setPaymentStatus(tenantId, conUuid, b.invoiceNo, {
      status: 'PAID',
      paidAmount: '1000.00',
      whtAmount: '10.00',
      paidAt: `${today}T02:00:00.000Z`,
    });
    expect((await run()).counts).toMatchObject({ checked: 1, created: 1 });
    pays = await paymentsOf(b.uuid);
    expect(pays).toHaveLength(2);
    expect(pays[1]!.allocations[0]!.amount.toFixed(2)).toBe('600.00');
    expect(pays[1]!.whtAmount.toFixed(2)).toBe('6.00');
    expect((await getInv(b.id)).status).toBe('PAID');
    expect(await mismatches(b.uuid)).toHaveLength(0);
  });

  it('รับชำระที่คนบันทึกเองแล้ว: ยอดตรงกับ ERP = ไม่สร้างซ้ำ · เกณฑ์ตรวจรับ: ยอดต่าง → MISMATCH (ไม่ปรับเงินเอง) · ส่วนต่างเดิมไม่แจ้งซ้ำ · ยอดตรงแล้วปิดเอง', async () => {
    const c = await pushedInvoice('1000.00');
    await manualPayment(c.id, '300.00');
    // ERP รายงานยอดเดียวกับที่คนบันทึกไว้ → ตรง ไม่สร้าง payment ซ้ำ
    demo.setPaymentStatus(tenantId, conUuid, c.invoiceNo, {
      status: 'PARTIALLY_PAID',
      paidAmount: '300.00',
      paidAt: null,
    });
    expect((await run()).counts).toMatchObject({
      checked: 1,
      matched: 1,
      created: 0,
      mismatched: 0,
    });
    expect(await paymentsOf(c.uuid)).toHaveLength(1);
    expect(await mismatches(c.uuid)).toHaveLength(0);

    // ERP ว่าชำระครบ 1,000 แต่ TMS มี 300 ที่คนบันทึกเอง → MISMATCH ไม่สร้าง payment 700 ให้เอง
    demo.setPaymentStatus(tenantId, conUuid, c.invoiceNo, {
      status: 'PAID',
      paidAmount: '1000.00',
      paidAt: `${today}T02:00:00.000Z`,
    });
    const r = await run();
    expect(r.counts).toMatchObject({ checked: 1, created: 0, mismatched: 1, newMismatches: 1 });
    expect(await paymentsOf(c.uuid)).toHaveLength(1);
    expect((await getInv(c.id)).status).toBe('PARTIALLY_PAID');
    let rows = await mismatches(c.uuid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connectorId: conUuid,
      entityType: 'INVOICE',
      result: 'MISMATCH',
      severity: 'MONEY',
      source: 'MANUAL',
      localNumber: c.invoiceNo,
      resolvedAt: null,
    });
    expect(rows[0]!.diff).toMatchObject({
      check: 'PAYMENT_STATUS',
      code: 'tms_has_other_payments',
      localPaid: '300.00',
      remotePaid: '1000.00',
      difference: '700.00',
    });
    const found = await plat.auditLog.findMany({
      where: { tenantId, action: 'reconcile.mismatch_found', entityId: rows[0]!.id },
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.actorId).toBe('connector:demo');

    // API (API-first): รายการ MISMATCH ที่ยังเปิด + รายตัว · ยอดเงินตามสิทธิ์ราคาขาย
    const list = await api(app, accounting)
      .get(`/v1/reconcile-results?status=OPEN&invoiceId=${c.id}`)
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      id: encodeId('reconcileResult', rows[0]!.id),
      connector: { id: conId, adapterKey: 'demo' },
      invoiceId: c.id,
      localNumber: c.invoiceNo,
      result: 'MISMATCH',
      severity: 'MONEY',
      status: 'OPEN',
      check: 'PAYMENT_STATUS',
      code: 'tms_has_other_payments',
      localStatus: 'PARTIALLY_PAID',
      remoteStatus: 'PAID',
      sellLocalPaidAmount: '300.00',
      sellRemotePaidAmount: '1000.00',
      sellDifferenceAmount: '700.00',
    });
    const one = await api(app, accounting)
      .get(`/v1/reconcile-results/${list.body.data[0].id}`)
      .expect(200);
    expect(one.body.code).toBe('tms_has_other_payments');
    const noPrice = await tokenFor(tenantId, 'integrations:read', 'u-ops');
    const hidden = await api(app, noPrice).get('/v1/reconcile-results').expect(200);
    expect(hidden.body.data[0].code).toBeTruthy();
    expect(hidden.body.data[0]).not.toHaveProperty('sellRemotePaidAmount');
    await api(app, await tokenFor(tenantId, 'payments:record', 'u-x'))
      .get('/v1/reconcile-results')
      .expect(403);

    // ดึงซ้ำ ส่วนต่างเดิม → ไม่มีแถว/ audit ใหม่ (lastSeenAt ขยับ)
    const again = await run();
    expect(again.counts).toMatchObject({ mismatched: 1, newMismatches: 0, created: 0 });
    rows = await mismatches(c.uuid);
    expect(rows).toHaveLength(1);
    expect(
      await plat.auditLog.count({ where: { tenantId, action: 'reconcile.mismatch_found' } }),
    ).toBe(1);

    // คนบันทึกรับส่วนที่เหลือเองใน TMS → ใบ PAID · รอบถัดไปยอดตรง → ระบบปิด MISMATCH (ไม่มี payment จาก connector)
    await manualPayment(c.id, '700.00');
    expect((await getInv(c.id)).status).toBe('PAID');
    expect((await run()).counts).toMatchObject({ checked: 1, matched: 1, created: 0 });
    rows = await mismatches(c.uuid);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resolvedAt).not.toBeNull();
    expect((await paymentsOf(c.uuid)).every((p) => p.source === 'MANUAL')).toBe(true);
    const resolved = await api(app, accounting)
      .get(`/v1/reconcile-results?status=RESOLVED&invoiceId=${c.id}`)
      .expect(200);
    expect(resolved.body.data).toHaveLength(1);
    // ปิดแล้ว ใบ PAID ไม่ถูกถามอีก
    expect((await run()).counts.checked).toBe(0);
  });

  it('ส่วนต่างแบบอื่น → MISMATCH ทุกกรณี ไม่มี payment ใหม่: ERP น้อยกว่า TMS · ERP ว่าครบแต่ยอดไม่ถึง · เกินยอดใบ · รายการที่ระบบสร้างถูกกลับรายการแล้ว ERP ยังรายงานยอดเดิม', async () => {
    // (ก) TMS บันทึกรับเอง 300 แต่ ERP ยังไม่รู้ (UNPAID)
    const a = await pushedInvoice('1000.00');
    await manualPayment(a.id, '300.00');
    demo.setPaymentStatus(tenantId, conUuid, a.invoiceNo, {
      status: 'UNPAID',
      paidAmount: '0.00',
      paidAt: null,
    });
    // (ข) ERP ว่า PAID แต่ตัดหนี้ 990 จาก 1,000 (ไม่บอก WHT) → ไม่เดา
    const b = await pushedInvoice('1000.00');
    demo.setPaymentStatus(tenantId, conUuid, b.invoiceNo, {
      status: 'PAID',
      paidAmount: '990.00',
      paidAt: null,
    });
    // (ค) ERP ตัดหนี้เกินยอดใบ
    const c = await pushedInvoice('1000.00');
    demo.setPaymentStatus(tenantId, conUuid, c.invoiceNo, {
      status: 'PAID',
      paidAmount: '1200.00',
      paidAt: null,
    });
    // (ง) ระบบสร้าง payment 500 จาก ERP แล้วคนกลับรายการใน TMS — ERP ยังรายงาน 500
    const d = await pushedInvoice('1000.00');
    demo.setPaymentStatus(tenantId, conUuid, d.invoiceNo, {
      status: 'PARTIALLY_PAID',
      paidAmount: '500.00',
      paidAt: null,
    });
    const first = await run();
    expect(first.counts).toMatchObject({ checked: 4, created: 1, mismatched: 3, newMismatches: 3 });
    const code = async (uuid: string) =>
      (await mismatches(uuid)).filter((r) => !r.resolvedAt).map((r) => (r.diff as any).code);
    expect(await code(a.uuid)).toEqual(['remote_less_than_tms']);
    expect(await code(b.uuid)).toEqual(['remote_paid_amount_short']);
    expect(await code(c.uuid)).toEqual(['remote_exceeds_total']);
    expect(await paymentsOf(a.uuid)).toHaveLength(1);
    expect(await paymentsOf(b.uuid)).toHaveLength(0);
    expect(await paymentsOf(c.uuid)).toHaveLength(0);
    expect((await getInv(b.id)).status).toBe('ISSUED');

    const made = await paymentsOf(d.uuid);
    expect(made).toHaveLength(1);
    const pid = encodeId('payment', made[0]!.id);
    const rev = await api(app, admin)
      .post(`/v1/payments/${pid}/reverse`)
      .set('If-Match', `"${made[0]!.version}"`)
      .send({ reason: 'ลูกค้าแจ้งว่ายังไม่ได้โอน ตรวจกับธนาคารแล้ว' });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    const second = await run();
    expect(second.counts).toMatchObject({ created: 0, mismatched: 4, newMismatches: 1 });
    expect(await code(d.uuid)).toEqual(['connector_payment_reversed']);
    expect(await paymentsOf(d.uuid)).toHaveLength(1); // ไม่สร้างใหม่แทนรายการที่กลับ
    expect((await getInv(d.id)).status).toBe('ISSUED');

    // (ก) ERP ตามทัน (300) → ตรง ปิดเอง
    demo.setPaymentStatus(tenantId, conUuid, a.invoiceNo, {
      status: 'PARTIALLY_PAID',
      paidAmount: '300.00',
      paidAt: null,
    });
    await run();
    expect(await code(a.uuid)).toEqual([]);
    // ส่วนต่างเปลี่ยน (ERP 990 → 995) = ปิดแถวเดิม เปิดแถวใหม่ (เปิดอยู่แถวเดียว)
    demo.setPaymentStatus(tenantId, conUuid, b.invoiceNo, {
      status: 'PAID',
      paidAmount: '995.00',
      paidAt: null,
    });
    await run();
    const rowsB = await mismatches(b.uuid);
    expect(rowsB).toHaveLength(2);
    expect(rowsB.filter((r) => !r.resolvedAt)).toHaveLength(1);
    // เก็บกวาด: ไม่ให้ใบชุดนี้กระทบ test ถัดไป
    for (const i of [a, b, c, d]) demo.setPaymentStatus(tenantId, conUuid, i.invoiceNo, null);
    await plat.externalMapping.updateMany({
      where: { tenantId, entityType: 'INVOICE', localId: { in: [a, b, c, d].map((i) => i.uuid) } },
      data: { externalStatus: 'VOIDED' },
    });
  });

  it('ไม่มี capability = ไม่มีรอบดึง: tenant ปิด fetchPaymentStatus → scheduler ไม่สร้าง job / รอบดึงข้าม / สั่งเอง 409 · Standalone ไม่มี job · syncFromDate กันใบก่อนวันเริ่ม · ERP ตอบผิดรูป/ล่ม ไม่แตะเงิน', async () => {
    const e = await pushedInvoice('1000.00');
    demo.setPaymentStatus(tenantId, conUuid, e.invoiceNo, {
      status: 'PAID',
      paidAmount: '1000.00',
      paidAt: null,
    });
    const patch = async (body: object) => {
      const r = await api(app, admin).patch(`/v1/connectors/${conId}`).send(body);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    };
    await plat.job.updateMany({
      where: { tenantId, type: PAYMENT_STATUS_PULL_JOB },
      data: { payload: { connectorId: conUuid, day: '2000-01-01' } },
    });
    // ปิด capability (KRS ไม่มี capability นี้ตั้งแต่ต้น — เปิดไม่ได้)
    await patch({ capabilitiesEnabled: ['pushInvoice'] });
    expect(await pull.scheduleDue(at0730)).toBe(0);
    expect(await run()).toMatchObject({
      skipped: 'capability_not_enabled',
      counts: { checked: 0 },
    });
    const refused = await api(app, admin)
      .post('/v1/reconcile-runs')
      .send({ connectorId: conId, check: 'PAYMENT_STATUS' });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.reason).toBe('capability_not_enabled');
    expect(await paymentsOf(e.uuid)).toHaveLength(0);
    // tenant ที่ไม่มี connector (Standalone) ไม่มี job
    expect(await plat.job.count({ where: { tenantId: otherTenantId } })).toBe(0);

    await patch({ capabilitiesEnabled: ['pushInvoice', 'fetchPaymentStatus'] });
    // syncFromDate หลังวันออกใบ → ใบนี้ไม่ถูกถาม (API ไม่รับวันอนาคต — ตั้งตรงในฐานเพื่อจำลอง "ใบออกก่อนวันเริ่มซิงก์")
    await plat.connector.update({
      where: { id: conUuid },
      data: { syncFromDate: new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000) },
    });
    expect((await run()).counts.checked).toBe(0);
    await plat.connector.update({ where: { id: conUuid }, data: { syncFromDate: null } });
    // connector หยุด → ข้าม
    await api(app, admin)
      .post(`/v1/connectors/${conId}/pause`)
      .send({ reason: 'หยุดชั่วคราวเพื่อทดสอบรอบดึง' });
    expect((await run()).skipped).toBe('connector_not_active');
    expect(await pull.scheduleDue(at0730)).toBe(0);
    await api(app, admin).post(`/v1/connectors/${conId}/resume`).send({}).expect(200);
    // ERP ตอบผิดรูป (float) → นับ error ไม่มี payment
    demo.setPaymentStatus(tenantId, conUuid, e.invoiceNo, {
      status: 'PAID',
      paidAmount: 1000 as unknown as string,
      paidAt: null,
    });
    expect((await run()).counts).toMatchObject({ checked: 1, errors: 1, created: 0 });
    expect(await paymentsOf(e.uuid)).toHaveLength(0);

    // สั่งเอง: 202 QUEUED → ซ้ำ = ALREADY_QUEUED → worker ทำ → payment เดียว (source MANUAL ของรอบ)
    demo.setPaymentStatus(tenantId, conUuid, e.invoiceNo, {
      status: 'PAID',
      paidAmount: '1000.00',
      paidAt: null,
    });
    const q1 = await api(app, admin)
      .post('/v1/reconcile-runs')
      .send({ connectorId: conId, check: 'PAYMENT_STATUS' });
    expect(q1.status, JSON.stringify(q1.body)).toBe(202);
    expect(q1.body).toMatchObject({
      status: 'QUEUED',
      check: 'PAYMENT_STATUS',
      connectorId: conId,
    });
    const q2 = await api(app, admin)
      .post('/v1/reconcile-runs')
      .send({ connectorId: conId, check: 'PAYMENT_STATUS' });
    expect(q2.body.status).toBe('ALREADY_QUEUED');
    // API key / ผู้ไม่มีสิทธิ์ตั้งค่า สั่งไม่ได้
    await api(app, accounting)
      .post('/v1/reconcile-runs')
      .send({ connectorId: conId, check: 'PAYMENT_STATUS' })
      .expect(403);
    await drainJobs();
    expect(await paymentsOf(e.uuid)).toHaveLength(1);
    expect((await getInv(e.id)).status).toBe('PAID');
    // scheduler ของวันนี้ยังสร้างได้ 1 job (รอบสั่งเองไม่นับเป็นรอบรายวัน) แล้วไม่ซ้ำ
    expect(await pull.scheduleDue(at0730)).toBe(1);
    expect(await pull.scheduleDue(at0730)).toBe(0);
  });

  it('แยก tenant: MISMATCH ของ tenant อื่นมองไม่เห็น (รายการว่าง / รายตัว 404 / สั่งรอบกับ connector ของ tenant อื่น 404) · sandbox ไม่ดึง', async () => {
    const mine = await plat.reconcileResult.findFirstOrThrow({ where: { tenantId } });
    const other = await tokenFor(otherTenantId);
    const list = await api(app, other).get('/v1/reconcile-results').expect(200);
    expect(list.body.data).toEqual([]);
    await api(app, other)
      .get(`/v1/reconcile-results/${encodeId('reconcileResult', mine.id)}`)
      .expect(404);
    await api(app, other)
      .post('/v1/reconcile-runs')
      .send({ connectorId: conId, check: 'PAYMENT_STATUS' })
      .expect(404);
    // RLS: role แอปภายใต้ tenant อื่นไม่เห็นแถว
    const seen = await db.withTenant(otherTenantId, (tx) => tx.reconcileResult.count());
    expect(seen).toBe(0);
    // sandbox (mode test): connector สร้างใน sandbox ไม่ได้ (@LiveOnly) — จำลองแถวที่หลุดเข้ามา: รอบดึงข้าม + scheduler ไม่สร้าง job
    const sandbox = await plat.tenant.create({
      data: {
        name: 'sandbox ดึงสถานะรับชำระ',
        mode: 'test',
        liveTenantId: tenantId,
        planCode: 'ent',
      },
    });
    const live = await plat.connector.findUniqueOrThrow({ where: { id: conUuid } });
    const sbCon = await plat.connector.create({
      data: {
        tenantId: sandbox.id,
        adapterKey: 'demo',
        capabilitiesEnabled: ['fetchPaymentStatus'],
        credentialKeys: live.credentialKeys,
        credentialsEnc: live.credentialsEnc,
        status: 'ACTIVE',
      },
    });
    expect((await pull.pullConnector(sandbox.id, sbCon.id)).skipped).toBe('sandbox');
    await plat.job.updateMany({
      where: { tenantId, type: PAYMENT_STATUS_PULL_JOB },
      data: { payload: { connectorId: conUuid, day: '2000-01-01' } },
    });
    expect(await pull.scheduleDue(at0730)).toBe(1); // เฉพาะ connector ของบริษัทจริง
    expect(await plat.job.count({ where: { tenantId: sandbox.id } })).toBe(0);
    const sbApi = await api(app, await tokenFor(sandbox.id)).get('/v1/reconcile-results');
    expect(sbApi.status).toBe(403);
  });

  it('รับชำระเข้าได้ทางเดียวต่อ connector: เปิด fetchPaymentStatus แล้ว webhook รับชำระ (paymentReceived) ไม่ถูกบันทึก → คิวตรวจ payment_channel_conflict', async () => {
    const con = await plat.connector.findUniqueOrThrow({ where: { id: conUuid } });
    const before = await plat.payment.count({ where: { tenantId } });
    const r = await db.withTenant(tenantId, (tx) =>
      app.get(ErpInboundEffects).apply(tx, con, [
        {
          kind: 'paymentReceived',
          externalId: 'RV-1',
          externalDocNo: 'RV-0001',
          receivedDate: today,
          allocations: [
            { externalId: 'x', localNumber: 'INV-X', amount: '10.00', whtAmount: '0.00' },
          ],
        } as any,
      ]),
    );
    expect(r.review).toMatchObject({ code: 'payment_channel_conflict' });
    expect(await plat.payment.count({ where: { tenantId } })).toBe(before);
  });
});
