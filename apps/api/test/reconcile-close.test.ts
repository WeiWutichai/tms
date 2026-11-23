import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type PrismaClient, type VatType } from '@prisma/client';
import { SYSTEM_ROLES } from '@tms/domain';
import { type MockKrs, startMockKrs } from '@tms/mock-krs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { KrsAdapter } from '../src/erp-adapters/krs/krs.adapter';
import { ErpAdapterRegistry } from '../src/modules/erp/erp-adapter.registry';
import { DocumentReconcileService } from '../src/modules/erp/document-reconcile.service';
import { OutboxDispatcher } from '../src/modules/integration/outbox.dispatcher';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST8-T12 หน้า MISMATCH — ปิดรายการไม่ตรง 3 ทาง (docs/01 §6.5) · ทดสอบกับ KRS adapter ตัวจริง + mock KRS (MISMATCH จริงจากรอบเทียบ ST8-T11)
 * เกณฑ์ตรวจรับ (plan/01 ST8-T12): MISMATCH ตัวอย่างปิดได้ครบ 3 ทาง และแต่ละทางมีบันทึกผู้ทำ/เหตุผลใน audit
 * - (1) แก้ที่ TMS: D-54 ระหว่างรอ = ยกเลิกใบ + ออกใหม่ (ST5-T10) แล้วปิด `resolve-in-tms`
 * - (2) ส่งทับด้วยค่า TMS: ส่งซ้ำตรง (ประตูอนุมัติของ ST8-T13) หรือขออนุมัติ → ผู้อนุมัติคนละคน → PUT จริงของ KRS (ST8-T13) → รอบเทียบตรง = ปิด
 * - (3) ยอมรับความต่าง: ack + `reconcile_state` ACCEPTED · รอบถัดไปไม่แจ้งซ้ำ
 */
const KEY = 'krs-reconcile-close-key-5c11';

describe('ปิดรายการไม่ตรง 3 ทาง (ST8-T12)', { timeout: 900_000 }, () => {
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
  let approver: string;
  let viewer: string;
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
  async function issued(
    doIds: string[],
    vat: (i: number) => VatType = () => 'EXEMPT_TRANSPORT',
    force = true,
  ) {
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
    // force = ปลุกคำสั่งรอลองใหม่ทั้งหมดด้วย · false = ส่งเฉพาะที่ถึงเวลา (คำสั่งอ่านที่รอลองใหม่ยังรอ)
    if (force) await drain();
    else await dispatcher.drain();
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
      data: { tenantId, legalName: 'บริษัท พีพี ตัวอย่าง จำกัด', taxId: validTaxId(8211) },
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
          code: 'C-REC12',
          legalName: 'บริษัท ลูกค้า กระทบยอด ตัวอย่าง จำกัด',
          taxId: validTaxId(8213),
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
    freight = (await item('T12-FRT', 'EXEMPT_TRANSPORT', '1.00')).id;
    service = (await item('T12-LIFT', 'VAT_7', '3.00')).id;
    admin = await tokenFor(tenantId);
    accounting = await tokenFor(tenantId, SYSTEM_ROLES.accounting.permissions.join(' '), 'u-acc');
    approver = await tokenFor(tenantId, SYSTEM_ROLES.approver.permissions.join(' '), 'u-appr');
    viewer = await tokenFor(tenantId, SYSTEM_ROLES.viewer.permissions.join(' '), 'u-view');
    // หัวหน้าบัญชี (payments:record) = ผู้รับแจ้ง MISMATCH
    const role = await plat.role.findFirstOrThrow({ where: { tenantId, code: 'accounting' } });
    const acc = await plat.appUser.create({
      data: {
        tenantId,
        email: 'rec-acc@t12.test',
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
        capabilitiesEnabled: [
          'pullOrders',
          'pushInvoice',
          'ownsDocumentNumber',
          'fetchDocument',
          'replaceDocument',
        ],
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

  /** ใบ 3 รายการที่ส่งแล้ว → บัญชีเขียนทับใน KRS เหลือ 1 → สั่งเทียบเอง → แถว MISMATCH (MONEY) */
  async function mismatch() {
    const inv = await issued(await deliveryOrders(3));
    mock.overwriteInvoice(inv.transactionNo, { keepLines: 1, renumberLineIds: true });
    const run = await api(app, accounting)
      .post('/v1/reconcile-runs')
      .send({
        connectorId: conId,
        check: 'DOCUMENT',
        invoiceIds: [inv.id],
        reason: 'ตรวจซ้ำหลังบัญชีแก้ใน KRS',
      });
    expect(run.status, JSON.stringify(run.body)).toBe(202);
    await drain();
    const [row] = await results(inv.uuid);
    expect(row).toMatchObject({ result: 'MISMATCH', severity: 'MONEY', resolvedAt: null });
    return { ...inv, recId: encodeId('reconcileResult', row!.id), recUuid: row!.id };
  }
  const audits = (entityId: string) =>
    plat.auditLog.findMany({
      where: { tenantId, entityType: 'reconcile_result', entityId },
      orderBy: { seq: 'asc' },
    });
  const reason = 'ยืนยันกับบัญชีแล้ว ค่าใน KRS ถูกต้อง';

  it('ทางที่ 3 ยอมรับความต่าง: สิทธิ์ / คนเท่านั้น / เหตุผล ≥ 10 · ACKNOWLEDGED + reconcile_state ACCEPTED · audit ผู้ทำ+เหตุผล · รอบถัดไปไม่แจ้งซ้ำ · Idempotency-Key', async () => {
    const m = await mismatch();
    const url = `/v1/reconcile-results/${m.recId}/acknowledge`;
    // อ่านอย่างเดียว (viewer) → 403 · เหตุผลสั้น → 422
    await api(app, viewer).post(url).send({ reason }).expect(403);
    const short = await api(app, accounting).post(url).send({ reason: 'สั้นไป' });
    expect(short.status).toBe(422);
    // API key ปิดรายการไม่ได้ (คนเท่านั้น)
    const u = await plat.appUser.create({
      data: {
        tenantId,
        email: `key-${randomUUID()}@t12.test`,
        name: 'เจ้าของ key',
        status: 'ACTIVE',
      },
    });
    const k = await api(app, await tokenFor(tenantId, '*', u.id))
      .post('/v1/api-keys')
      .send({ name: 'recon', scopes: ['integrations:read', 'integrations:retry'] });
    expect(k.status, JSON.stringify(k.body)).toBe(201);
    await api(app, k.body.secret as string)
      .post(url)
      .send({ reason })
      .expect(403);

    const idem = randomUUID();
    const ok = await api(app, accounting).post(url).set('Idempotency-Key', idem).send({ reason });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'ACKNOWLEDGED', ackReason: reason, resolution: null });
    // ส่งซ้ำด้วย key เดิม = ผลเดิม (ไม่ลง audit ซ้ำ) · ไม่มี key = 409
    const replay = await api(app, accounting)
      .post(url)
      .set('Idempotency-Key', idem)
      .send({ reason });
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(ok.body.id);
    const again = await api(app, accounting).post(url).send({ reason });
    expect(again.status).toBe(409);
    expect(again.body.reason).toBe('already_acknowledged');
    expect(await mapping(m.uuid)).toMatchObject({ reconcileState: 'ACCEPTED', status: 'SYNCED' });
    const a = (await audits(m.recUuid)).filter(
      (x) => x.action === 'reconcile.mismatch_acknowledged',
    );
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actorId: 'u-acc', reason });

    // รอบถัดไปเห็นส่วนต่างเดิม = ไม่สร้างแถว/ไม่แจ้ง · ใบยังยอมรับอยู่
    const before = (await noti()).length;
    await api(app, accounting)
      .post('/v1/reconcile-runs')
      .send({ connectorId: conId, check: 'DOCUMENT', invoiceIds: [m.id], reason: 'ตรวจซ้ำรอบสอง' })
      .expect(202);
    await drain();
    expect(await results(m.uuid)).toHaveLength(1);
    expect((await noti()).length).toBe(before);
    expect(await mapping(m.uuid)).toMatchObject({ reconcileState: 'ACCEPTED' });
  });

  it('ทางที่ 1 แก้ที่ TMS (D-54 ยกเลิก + ออกใหม่): ใบยังไม่ยกเลิก = 409 · ยกเลิกแล้ว = RESOLVED FIXED_IN_TMS + ใบที่ออกแทน · audit ผู้ทำ+เหตุผล', async () => {
    const m = await mismatch();
    const url = `/v1/reconcile-results/${m.recId}/resolve-in-tms`;
    const early = await api(app, accounting).post(url).send({ reason });
    expect(early.status).toBe(409);
    expect(early.body.reason).toBe('invoice_not_voided');
    // ST5-T10 ยกเลิก + ออกใหม่ (owner/admin — step-up แนบโดย helper)
    const inv = await api(app, admin).get(`/v1/invoices/${m.id}`).expect(200);
    const v = await api(app, admin)
      .post(`/v1/invoices/${m.id}/void`)
      .set('If-Match', `"${inv.body.version}"`)
      .send({ reason: 'ข้อมูลใน KRS ถูกต้อง ออกใบใหม่ให้ตรง', reissue: false });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    const ok = await api(app, accounting)
      .post(url)
      .send({ reason: 'ยกเลิกใบเดิมและออกใบใหม่แล้ว' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({
      status: 'RESOLVED',
      resolution: 'FIXED_IN_TMS',
      resolutionReason: 'ยกเลิกใบเดิมและออกใบใหม่แล้ว',
      invoiceStatus: 'CANCELLED',
    });
    // ออกใบใหม่แทน (`reissue`) = กฎของ ST5-T10 (DO ต้องพร้อมวางบิล) — ที่นี่ยกเลิกอย่างเดียว
    expect(ok.body.replacedByInvoice).toBeNull();
    const a = (await audits(m.recUuid)).filter((x) => x.action === 'reconcile.mismatch_closed');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actorId: 'u-acc', reason: 'ยกเลิกใบเดิมและออกใบใหม่แล้ว' });
    expect(a[0]!.after).toMatchObject({ resolution: 'FIXED_IN_TMS' });
    // ปิดแล้ว = ทำซ้ำ/ทางอื่นไม่ได้
    const dup = await api(app, accounting)
      .post(`/v1/reconcile-results/${m.recId}/acknowledge`)
      .send({ reason });
    expect(dup.status).toBe(409);
    expect(dup.body.reason).toBe('already_resolved');
  });

  const rerun = async (id: string) => {
    await api(app, accounting)
      .post('/v1/reconcile-runs')
      .send({
        connectorId: conId,
        check: 'DOCUMENT',
        invoiceIds: [id],
        reason: 'ตรวจซ้ำหลังส่งทับ',
      })
      .expect(202);
    await drain();
  };
  const cmd = (obx: string) =>
    plat.integrationOutbox.findUniqueOrThrow({ where: { id: tryDecodeId('outboxCommand', obx)! } });

  it('ทางที่ 2 ขออนุมัติแก้ (ลงบัญชีแล้ว): ผู้ขอ A → ผู้อนุมัติ B · ผู้ขอ/ผู้ออกใบอนุมัติไม่ได้ · PUT จริงผ่านประตูอนุมัติ ST8-T13 → DONE → รอบเทียบตรง = ปิด ERP_OVERWRITTEN', async () => {
    const m = await mismatch();
    const base = `/v1/reconcile-results/${m.recId}/overwrite-request`;
    // ยังไม่ขอ = อนุมัติไม่ได้
    const none = await api(app, approver).post(`${base}/approve`).send({ reason });
    expect(none.status).toBe(409);
    expect(none.body.reason).toBe('overwrite_not_requested');
    // ฝ่ายบัญชีกด "ลงบัญชีแล้ว" ใน KRS → แทนที่ต้องอนุมัติ (approvalGate ของ ST8-T13)
    await plat.externalMapping.updateMany({
      where: { tenantId, entityType: 'INVOICE', localId: m.uuid },
      data: { postedAt: new Date(), postedBy: 'u-acc' },
    });
    const req = await api(app, accounting)
      .post(base)
      .send({ reason: 'ค่าใน TMS ถูกต้อง ให้ส่งทับ KRS' });
    expect(req.status, JSON.stringify(req.body)).toBe(200);
    expect(req.body.overwrite).toMatchObject({
      status: 'REQUESTED',
      requestedByMe: true,
      commandId: null,
    });
    // ขอซ้ำ / ยอมรับความต่าง / ส่งซ้ำตรง ระหว่างรออนุมัติ = 409
    expect((await api(app, accounting).post(base).send({ reason })).body.reason).toBe(
      'overwrite_in_progress',
    );
    for (const p of ['acknowledge', 'resend'])
      expect(
        (await api(app, accounting).post(`/v1/reconcile-results/${m.recId}/${p}`).send({ reason }))
          .body.reason,
      ).toBe('overwrite_in_progress');
    // รายการ "รออนุมัติ"
    const list = await api(app, approver)
      .get('/v1/reconcile-results?check=DOCUMENT&actionable=true&overwriteStatus=REQUESTED')
      .expect(200);
    const mine = list.body.data.find((x: { id: string }) => x.id === m.recId);
    expect(mine).toMatchObject({
      overwrite: { status: 'REQUESTED', requestedByMe: false },
      customer: { name: 'บริษัท ลูกค้า กระทบยอด ตัวอย่าง จำกัด' },
      connector: { adapterKey: 'krs' },
    });
    expect(mine.sends.count).toBeGreaterThanOrEqual(1);
    // บัญชีไม่มี credit-notes:approve → 403 · ผู้ขอ (= ผู้ออกใบด้วย) ที่มีสิทธิ์ → 403 erp_replace_self_approval
    await api(app, accounting).post(`${base}/approve`).send({ reason }).expect(403);
    const self = await api(app, await tokenFor(tenantId, '*', 'u-acc'))
      .post(`${base}/approve`)
      .send({ reason });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('erp_replace_self_approval');
    const ok = await api(app, approver)
      .post(`${base}/approve`)
      .send({ reason: 'ตรวจแล้ว ค่า TMS ถูกต้อง อนุมัติส่งทับ' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'OPEN', overwrite: { status: 'APPROVED' } });
    const c = await cmd(ok.body.overwrite.commandId);
    expect(c.operation).toBe('REPLACE_DOCUMENT');
    const pl = c.payload as { approval: Record<string, unknown>; requestedBy: string[] };
    expect(pl.approval).toMatchObject({
      approvedBy: 'u-appr',
      reason: 'ตรวจแล้ว ค่า TMS ถูกต้อง อนุมัติส่งทับ',
      reconcileResultId: m.recId,
    });
    expect(typeof pl.approval.approvedAt).toBe('string');
    expect(pl.requestedBy).toContain('u-acc');
    expect(pl.requestedBy).not.toContain('u-appr');
    // อนุมัติซ้ำ = 409
    expect((await api(app, approver).post(`${base}/approve`).send({ reason })).status).toBe(409);
    // PUT จริง (KRS replaceDocument — ST8-T13) → DONE · mock กลับมา 3 รายการ
    const puts0 = mock.requests().filter((q) => q.method === 'PUT').length;
    await drain();
    expect((await cmd(ok.body.overwrite.commandId)).status).toBe('DONE');
    expect(mock.requests().filter((q) => q.method === 'PUT').length).toBeGreaterThan(puts0);
    expect(mock.getInvoice(m.transactionNo)!.data.lines).toHaveLength(3);
    // ส่งแล้วรอรอบเทียบ = ยังปิดทางอื่นไม่ได้
    expect(
      (
        await api(app, accounting)
          .post(`/v1/reconcile-results/${m.recId}/acknowledge`)
          .send({ reason })
      ).body.reason,
    ).toBe('overwrite_in_progress');
    await rerun(m.id);
    const done = await api(app, accounting).get(`/v1/reconcile-results/${m.recId}`).expect(200);
    expect(done.body).toMatchObject({ status: 'RESOLVED', resolution: 'ERP_OVERWRITTEN' });
    expect(await mapping(m.uuid)).toMatchObject({ reconcileState: 'ACCEPTED' });
    const acts = (await audits(m.recUuid)).map((x) => [x.action, x.actorId, x.reason]);
    expect(acts).toEqual(
      expect.arrayContaining([
        ['reconcile.overwrite_requested', 'u-acc', 'ค่าใน TMS ถูกต้อง ให้ส่งทับ KRS'],
        ['reconcile.overwrite_approved', 'u-appr', 'ตรวจแล้ว ค่า TMS ถูกต้อง อนุมัติส่งทับ'],
      ]),
    );
  });

  it('ใช้ค่า TMS ส่งซ้ำ (ตรง): ยังไม่ลงบัญชี → PUT → ปิด ERP_OVERWRITTEN · ลงบัญชีแล้ว → SKIPPED replace_requires_approval แล้วปิดทางอื่นได้ · รับชำระแล้ว 409 paid_locked', async () => {
    const m = await mismatch();
    const url = `/v1/reconcile-results/${m.recId}/resend`;
    await api(app, viewer).post(url).send({ reason }).expect(403);
    const r = await api(app, accounting).post(url).send({ reason: 'ค่าใน TMS ถูกต้องตามใบส่งของ' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.overwrite).toMatchObject({ status: 'SENT', requestedByMe: true });
    await drain();
    expect((await cmd(r.body.overwrite.commandId)).status).toBe('DONE');
    await rerun(m.id);
    expect(
      (await api(app, accounting).get(`/v1/reconcile-results/${m.recId}`).expect(200)).body,
    ).toMatchObject({ status: 'RESOLVED', resolution: 'ERP_OVERWRITTEN' });

    // ลงบัญชีแล้ว → ประตูของ ST8-T13 ข้ามคำสั่ง (ต้องขออนุมัติแก้) → คำสั่งจบไม่สำเร็จ = ยอมรับความต่างได้
    const p = await mismatch();
    await plat.externalMapping.updateMany({
      where: { tenantId, entityType: 'INVOICE', localId: p.uuid },
      data: { externalStatus: 'POSTED' },
    });
    const s2 = await api(app, accounting)
      .post(`/v1/reconcile-results/${p.recId}/resend`)
      .send({ reason: 'ค่าใน TMS ถูกต้องตามใบส่งของ' });
    expect(s2.status, JSON.stringify(s2.body)).toBe(200);
    await drain();
    const after = await api(app, accounting).get(`/v1/reconcile-results/${p.recId}`).expect(200);
    expect(after.body.overwrite).toMatchObject({
      status: 'SENT',
      commandStatus: 'SKIPPED',
      commandErrorCode: 'replace_requires_approval',
    });
    await api(app, accounting)
      .post(`/v1/reconcile-results/${p.recId}/acknowledge`)
      .send({ reason })
      .expect(200);

    // รับชำระแล้ว = ส่งทับไม่ได้ (กฎ "แก้ได้จนรับชำระ")
    const q = await mismatch();
    await plat.$executeRaw`UPDATE invoice SET status = 'PAID' WHERE id = ${q.uuid}::uuid`;
    for (const path of ['resend', 'overwrite-request']) {
      const x = await api(app, accounting)
        .post(`/v1/reconcile-results/${q.recId}/${path}`)
        .send({ reason });
      expect(x.status).toBe(409);
      expect(x.body.reason).toBe('paid_locked');
    }
  });

  it('M1 มีคำสั่งของเอกสารค้าง → อนุมัติ 409 command_in_progress (ไม่ทิ้งการอนุมัติเงียบ ๆ) · adapter ยังไม่ทำ replaceDocument → 409 capability_not_implemented', async () => {
    const m = await mismatch();
    const base = `/v1/reconcile-results/${m.recId}/overwrite-request`;
    await api(app, accounting)
      .post(base)
      .send({ reason: 'ค่าใน TMS ถูกต้อง ขอส่งทับ' })
      .expect(200);
    const src = await plat.integrationOutbox.findFirstOrThrow({
      where: { tenantId, localId: m.uuid, operation: 'PUSH_INVOICE' },
    });
    const open = await plat.integrationOutbox.create({
      data: {
        tenantId,
        kind: src.kind,
        sink: src.sink,
        targetId: src.targetId,
        operation: 'PUSH_INVOICE',
        entityType: src.entityType,
        localId: src.localId,
        serializeKey: src.serializeKey,
        idempotencyKey: `${src.idempotencyKey}:open-t12`,
        payload: src.payload as object,
        status: 'PENDING',
        nextRunAt: new Date(Date.now() + 3600_000),
      },
    });
    const busy = await api(app, approver).post(`${base}/approve`).send({ reason });
    expect(busy.status).toBe(409);
    expect(busy.body.reason).toBe('command_in_progress');
    expect(
      (await api(app, approver).get(`/v1/reconcile-results/${m.recId}`)).body.overwrite.status,
    ).toBe('REQUESTED');
    await plat.integrationOutbox.update({ where: { id: open.id }, data: { status: 'SKIPPED' } });
    // adapter ประกาศ replaceDocument แต่ยังไม่ได้ทำ → ไม่เก็บการอนุมัติ (ไม่พัก)
    const reg = app.get(ErpAdapterRegistry);
    const pending = new KrsAdapter({ allowPrivate: true });
    Object.defineProperty(pending, 'pendingCapabilities', { value: ['replaceDocument'] });
    reg.replace(pending);
    try {
      const nope = await api(app, approver).post(`${base}/approve`).send({ reason });
      expect(nope.status).toBe(409);
      expect(nope.body.reason).toBe('capability_not_implemented');
    } finally {
      reg.replace(new KrsAdapter({ allowPrivate: true }));
    }
  });

  it('ไม่อนุมัติ: ผู้อนุมัติปฏิเสธพร้อมเหตุผล → กลับเป็นไม่ตรง (ขอใหม่ได้) · tenant อื่น = 404', async () => {
    const m = await mismatch();
    const base = `/v1/reconcile-results/${m.recId}/overwrite-request`;
    await api(app, accounting).post(base).send({ reason: 'ขอส่งทับด้วยค่า TMS' }).expect(200);
    const rej = await api(app, approver)
      .post(`${base}/reject`)
      .send({ reason: 'ต้องตรวจกับลูกค้าก่อน' });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(rej.body).toMatchObject({ status: 'OPEN', overwrite: { status: 'REJECTED' } });
    const none = await api(app, accounting)
      .get('/v1/reconcile-results?check=DOCUMENT&overwriteStatus=NONE&status=OPEN')
      .expect(200);
    expect(none.body.data.map((x: { id: string }) => x.id)).toContain(m.recId);
    await api(app, accounting).post(base).send({ reason: 'ตรวจกับลูกค้าแล้ว ขอใหม่' }).expect(200);
    // tenant อื่นเห็นเป็น 404
    const other = (await createTenantWithDefaults(plat, { name: 'บริษัท อื่น ทดสอบ T12 จำกัด' }))
      .id;
    await plat.tenant.update({ where: { id: other }, data: { planCode: 'ent' } });
    const t2 = await tokenFor(other);
    await api(app, t2)
      .post(`/v1/reconcile-results/${m.recId}/acknowledge`)
      .send({ reason })
      .expect(404);
    await api(app, t2).post(`${base}/approve`).send({ reason }).expect(404);
  });
});
