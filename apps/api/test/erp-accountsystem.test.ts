import {
  type MockAccountSystem,
  signAccountSystemWebhook,
  startMockAccountSystem,
} from '@tms/mock-accountsystem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ERP_ADAPTER_FACTORIES } from '../src/erp-adapters';
import { AccountSystemAdapter } from '../src/erp-adapters/accountsystem/accountsystem.adapter';
import { accountSystemInbound } from '../src/erp-adapters/accountsystem/accountsystem-inbound';
import {
  invoiceDraft,
  settlementDraft,
} from '../src/erp-adapters/accountsystem/accountsystem-payload';
import {
  type CanonicalInvoicePayload,
  type CanonicalSettlementPayload,
  withSyncHash,
} from '../src/modules/erp/canonical';
import { adapterShapeProblems, type ErpContext } from '../src/modules/erp/erp-adapter';
import { describeErpAdapterContract } from './erp-adapter-contract';

/**
 * ST8-T16 AccountSystemAdapter — ระดับ adapter (ไม่แตะฐานข้อมูล) กับ mock จาก contract (`@tms/mock-accountsystem`)
 * ไม่เรียกระบบจริงใด ๆ
 */
const KEY = 'inn_tms_testkey_4b1e9c0d2f7a';
const SECRET = 'whsec_test_secret_8c2f1a';

export const sampleInvoice = (n = 1): CanonicalInvoicePayload =>
  withSyncHash({
    kind: 'invoice',
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    number: `INV-00000-2611-${String(n).padStart(4, '0')}`,
    issueDate: '2026-11-21',
    dueDate: '2026-12-21',
    issuer: {
      companyId: 'c',
      branchId: 'b',
      branchCode: '00000',
      legalName: 'บริษัท ผู้ออกบิล จำกัด',
      taxId: '0105555000009',
      address: '9 ถนนตัวอย่าง กรุงเทพฯ 10110',
    },
    customer: {
      id: 'cus',
      code: 'C-0001',
      legalName: 'บริษัท ลูกค้า จำกัด',
      taxId: '0105555000001',
      branchCode: '00000',
      externalId: null,
      billingAddress: '1 ถนนตัวอย่าง ชลบุรี 20000',
      paymentTermDays: 30,
    },
    customerPoNo: null,
    references: { customerRef: [] },
    totals: {
      subtotalVatable: '350.00',
      subtotalExempt: '1750.00',
      subtotalZeroRated: '0.00',
      vatAmount: '24.50',
      total: '2124.50',
      whtExpected: '21.00',
    },
    taxEstimated: true,
    lines: [
      {
        lineNo: 1,
        deliveryOrder: { id: 'do1', number: 'DO-2611-0001', date: '2026-11-20' },
        salesOrder: { number: 'SO-2611-0001', externalId: null },
        trip: {
          number: 'TR-2611-0001',
          vehiclePlate: '70-1234',
          driverName: 'สมชาย ตัวอย่าง',
          carrierName: null,
        },
        route: { originName: 'ชลบุรี', destinationName: 'ระยอง' },
        serviceItem: { id: 'si1', code: 'FREIGHT', externalId: 'FRT' },
        description: 'ค่าขนส่ง ชลบุรี → ระยอง',
        quantity: '5.000',
        unitLabel: 'ตัน',
        unitPrice: '350.0000',
        discount: '0.00',
        amount: '1750.00',
        vatType: 'EXEMPT_TRANSPORT',
        vatAmount: '0.00',
        whtRate: '1.00',
        accountCode: null,
      },
      {
        lineNo: 2,
        deliveryOrder: null,
        salesOrder: null,
        trip: null,
        route: null,
        serviceItem: { id: 'si2', code: 'LIFT', externalId: null },
        description: 'ค่ายกขน',
        quantity: '1',
        unitLabel: 'งาน',
        unitPrice: '400.123456',
        discount: '50.00',
        amount: '350.00',
        vatType: 'VAT_7',
        vatAmount: '24.50',
        whtRate: '3.00',
        accountCode: null,
      },
    ],
  });

export const sampleSettlement = (n = 1): CanonicalSettlementPayload =>
  withSyncHash({
    kind: 'settlement',
    id: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`,
    number: `SA-2026-${String(n).padStart(4, '0')}`,
    paidDate: '2026-11-21',
    payingCompanyId: null,
    period: { from: '2026-11-01', to: '2026-11-15' },
    carrierInvoiceNumber: 'CV-889',
    carrier: {
      id: 'car',
      code: 'SUB-0001',
      legalName: 'นายรถร่วม ใจดี',
      taxId: null,
      branchCode: null,
      entityType: 'INDIVIDUAL',
    },
    payment: { method: 'TRANSFER', reference: 'KBANK-1', bank: 'กสิกรไทย' },
    totals: {
      gross: '9000.00',
      deduction: '2000.00',
      net: '7000.00',
      wht: '90.00',
      netAfterWht: '6910.00',
    },
    whtEstimate: {
      pndForm: 'PND3',
      byRate: [{ whtRate: '1.00', base: '9000.00', amount: '90.00' }],
      reviewedByAccountant: false,
    },
    taxEstimated: true,
    lines: [
      {
        lineNo: 1,
        lineType: 'FREIGHT',
        trip: { number: 'TRP-0001' },
        deliveryOrders: [{ number: 'DO-0001' }, { number: 'DO-0002' }],
        description: 'ค่าจ้างรถ',
        amount: '9000.00',
        vatType: 'EXEMPT_TRANSPORT',
        whtRate: '1.00',
        whtAmount: '90.00',
      },
      {
        lineNo: 2,
        lineType: 'DEDUCTION',
        trip: null,
        deliveryOrders: [],
        description: 'เงินเบิกล่วงหน้า',
        amount: '-2000.00',
        vatType: null,
        whtRate: null,
        whtAmount: null,
      },
    ],
  });

const ctxOf = (config: Record<string, string>, extra: Partial<ErpContext> = {}): ErpContext => ({
  tenantId: '00000000-0000-4000-8000-0000000000a1',
  connectorId: '00000000-0000-4000-8000-0000000000a2',
  companyId: null,
  erpCompanyCode: null,
  config: Object.freeze({ ...config }),
  ...extra,
});

const contractMock: { m?: MockAccountSystem } = {};
const good: Record<string, string> = { baseUrl: '', apiKey: KEY, webhookSecret: SECRET };
const bad: Record<string, string> = { baseUrl: '', apiKey: 'inn_wrong_key' };
beforeAll(async () => {
  contractMock.m = await startMockAccountSystem({
    apiKey: KEY,
    webhookSecret: SECRET,
    contacts: [{ code: 'C-0001', tax_id: '0105555000001', branch_code: '00000', kind: 'customer' }],
  });
  good.baseUrl = bad.baseUrl = contractMock.m.url;
});
afterAll(async () => {
  await contractMock.m?.stop();
});

describeErpAdapterContract('accountsystem (AccountSystemAdapter)', {
  make: () => new AccountSystemAdapter({ allowPrivate: true }),
  config: good,
  badConfig: bad,
  samples: { invoice: sampleInvoice(90), settlement: sampleSettlement(90) },
});

describe('AccountSystemAdapter (ST8-T16) — กับ mock จาก contract', () => {
  let m: MockAccountSystem;
  const as = new AccountSystemAdapter({ allowPrivate: true });
  const cfg = () => ({ baseUrl: m.url, apiKey: KEY, webhookSecret: SECRET });
  beforeAll(() => {
    m = contractMock.m!;
  });
  beforeEach(() => {
    m.reset();
    m.setScopes(['documents:read', 'documents:draft', 'contacts:draft']);
  });

  it('ลงทะเบียนผ่าน composition root · capabilities = pushInvoice + pushSettlement · inbound · เจ้าของเอกสารภาษี ERP ตายตัว (D-55)', () => {
    const a = ERP_ADAPTER_FACTORIES.map((f) => f()).find((x) => x.key === 'accountsystem');
    expect(a).toBeInstanceOf(AccountSystemAdapter);
    expect(adapterShapeProblems(a!)).toEqual([]);
    expect([...a!.capabilities()].sort()).toEqual(['pushInvoice', 'pushSettlement']);
    expect(a!.fixedSystemOfRecord).toEqual({ taxDocumentOwner: 'ERP' });
    expect(a!.inbound).toBeDefined();
    expect(a!.configFields.filter((f) => f.secret).map((f) => f.key)).toEqual([
      'apiKey',
      'webhookSecret',
    ]);
    expect(a!.localOnly).toBeFalsy();
  });

  it('payload IV: whitelist ฟิลด์ตาม contract · amount หลังส่วนลด · vat_rate ตามประเภท (ยกเว้น = ไม่ส่ง) · qty > 4 ตำแหน่งไม่ส่ง · เลข DO ในคำอธิบาย', () => {
    const d = invoiceDraft({ erpCompanyCode: null }, sampleInvoice(), 'C-0001');
    expect(Object.keys(d).sort()).toEqual(
      [
        'branch_code',
        'contact_code',
        'doc_type',
        'due_date',
        'external_ref',
        'external_source',
        'issue_date',
        'lines',
        'price_incl_vat',
      ].sort(),
    );
    expect(d).toMatchObject({
      doc_type: 'IV',
      external_source: 'tms.invoice',
      external_ref: 'INV-00000-2611-0001',
      branch_code: '00000',
      price_incl_vat: false,
    });
    expect(d.lines[0]).toEqual({
      line_type: 'item',
      product_code: 'FRT',
      description: 'ค่าขนส่ง ชลบุรี → ระยอง (DO-2611-0001)',
      qty: '5',
      unit_price: '350',
      amount: '1750.00',
    });
    expect(d.lines[1]).toEqual({
      line_type: 'item',
      description: 'ค่ายกขน',
      amount: '350.00',
      vat_rate: '7',
    });
    // branch map ของ connector ชนะสาขาของเอกสาร
    expect(invoiceDraft({ erpCompanyCode: '00002' }, sampleInvoice(), 'X').branch_code).toBe(
      '00002',
    );
  });

  it('payload AP: บรรทัดหักส่งยอดติดลบตามจริง · WHT ประมาณการ + ภ.ง.ด.3 เป็นบรรทัดหมายเหตุ (AccountSystem ไม่มี WHT รายบรรทัด)', () => {
    const d = settlementDraft({ erpCompanyCode: null }, sampleSettlement(), 'EXT-0001');
    expect(d).toMatchObject({
      doc_type: 'AP',
      issue_date: '2026-11-21',
      external_source: 'tms.settlement',
      external_ref: 'SA-2026-0001',
    });
    expect(d.lines[0]).toMatchObject({
      amount: '9000.00',
      description: 'ค่าจ้างรถ (TRP-0001 · DO-0001, DO-0002)', // D68-81 เลข DO ต่อบรรทัด
    });
    expect(d.lines[1]).toMatchObject({ amount: '-2000.00' });
    const notes = d.lines.filter((l) => l.line_type === 'note').map((l) => l.description);
    expect(notes[0]).toContain(
      'หัก ณ ที่จ่ายประมาณการ 1.00% ฐาน 9000.00 บาท = 90.00 บาท (ภ.ง.ด.3)',
    );
    expect(notes[0]).toContain('ยังไม่ผ่านนักบัญชี');
    expect(notes[1]).toContain('6910.00');
  });

  it('pushInvoice → IV ร่าง 1 ใบ (จับคู่ลูกค้าด้วยเลขภาษี+สาขา) · ส่งซ้ำได้ id เดิม ไม่เกิดใบซ้ำ · vat_rate ถูกทิ้งฝั่งปลายทาง', async () => {
    const ctx = ctxOf(cfg());
    const r1 = await as.pushInvoice(ctx, sampleInvoice(1));
    expect(r1.ok, JSON.stringify(r1)).toBe(true);
    const r2 = await as.pushInvoice(ctx, sampleInvoice(1));
    expect(r2).toMatchObject({ ok: true, externalId: (r1 as { externalId: string }).externalId });
    const docs = m.byRef('INV-00000-2611-0001', 'tms.invoice');
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ doc_type: 'IV', status: 'draft', contact_code: 'C-0001' });
    expect(docs[0]!.lines.map((l) => l.vat_rate)).toEqual([null, null]);
    expect(m.requests.find((q) => q.method === 'PUT')!.body).toEqual([
      {
        tax_id: '0105555000001',
        branch_code: '00000',
        external_source: 'tms.customer',
        external_ref: 'C-0001',
        name: 'บริษัท ลูกค้า จำกัด',
        kind: 'customer',
      },
    ]);
    // Bearer ใน header เท่านั้น
    for (const q of m.requests) {
      expect(q.authorization).toBe(`Bearer ${KEY}`);
      expect(q.path).not.toContain(KEY);
    }
  });

  it('pushSettlement → AP ร่าง · รถร่วมบุคคลไม่ส่งเลขบัตร → จับคู่ด้วยรหัส TMS (สร้าง EXT-####)', async () => {
    const r = await as.pushSettlement(ctxOf(cfg()), sampleSettlement(2));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const put = m.requests.find((q) => q.method === 'PUT')!.body as Record<string, unknown>[];
    expect(put[0]).toEqual({
      external_source: 'tms.carrier',
      external_ref: 'SUB-0001',
      name: 'นายรถร่วม ใจดี',
      kind: 'vendor',
    });
    const [d] = m.byRef('SA-2026-0002', 'tms.settlement');
    expect(d).toMatchObject({ doc_type: 'AP', contact_code: expect.stringMatching(/^EXT-/) });
    expect(d!.lines.some((l) => l.line_type === 'note' && l.description.includes('90.00'))).toBe(
      true,
    );
  });

  it('รหัสลูกค้าฝั่ง ERP ที่ map ไว้ (ST8-T05 customerErpCode → customer.externalId) ใช้ก่อน ไม่เรียก contacts', async () => {
    const inv = sampleInvoice(5);
    inv.customer.externalId = 'C-0001';
    const r = await as.pushInvoice(ctxOf(cfg()), inv);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(m.requests.some((q) => q.method === 'PUT')).toBe(false);
    expect(m.byRef(inv.number)[0]!.contact_code).toBe('C-0001');
  });

  it('contactMatch=tmsCode ใช้รหัส TMS ตรง (ไม่เรียก contacts) · ไม่พบคู่ค้า = 422 → VALIDATION contact_not_found', async () => {
    const ctx = ctxOf({ ...cfg(), contactMatch: 'tmsCode' });
    const inv = sampleInvoice(3);
    inv.customer.code = 'NOPE';
    const r = await as.pushInvoice(ctx, inv);
    expect(r).toMatchObject({
      ok: false,
      errorClass: 'VALIDATION',
      retryable: false,
      problem: { code: 'contact_not_found' },
    });
    expect(m.requests.some((q) => q.method === 'PUT')).toBe(false);
  });

  it('ErrorClass: 401 = AUTH · 403 (ไม่มี scope) = AUTH · 5xx/ตัดการเชื่อมต่อ = TRANSIENT (ส่งซ้ำได้เพราะกันซ้ำด้วย external_ref)', async () => {
    expect(
      await as.pushInvoice(ctxOf({ ...cfg(), apiKey: 'inn_bad' }), sampleInvoice(4)),
    ).toMatchObject({
      ok: false,
      errorClass: 'AUTH',
      problem: { code: 'unauthorized' },
    });
    m.setScopes(['documents:read']);
    expect(await as.pushInvoice(ctxOf(cfg()), sampleInvoice(4))).toMatchObject({
      ok: false,
      errorClass: 'AUTH',
      problem: { code: 'scope_missing' },
    });
    m.setScopes(['documents:read', 'documents:draft', 'contacts:draft']);
    m.failNext(503);
    expect(await as.pushInvoice(ctxOf(cfg()), sampleInvoice(4))).toMatchObject({
      ok: false,
      errorClass: 'TRANSIENT',
      retryable: true,
    });
    m.failNext('reset');
    expect(await as.pushInvoice(ctxOf(cfg()), sampleInvoice(4))).toMatchObject({
      ok: false,
      errorClass: 'TRANSIENT',
    });
    expect((await as.pushInvoice(ctxOf(cfg()), sampleInvoice(4))).ok).toBe(true);
    expect(m.byRef('INV-00000-2611-0004')).toHaveLength(1);
  });

  it('healthCheck: ผ่าน · key ผิด = AUTH · ไม่มี scope contacts:draft (โหมดเลขภาษี) = AUTH · ไม่ throw', async () => {
    expect(await as.healthCheck(ctxOf(cfg()))).toMatchObject({ ok: true });
    expect(await as.healthCheck(ctxOf({ ...cfg(), apiKey: 'inn_x' }))).toMatchObject({
      ok: false,
      errorClass: 'AUTH',
    });
    m.setScopes(['documents:read', 'documents:draft']);
    expect(await as.healthCheck(ctxOf(cfg()))).toMatchObject({
      ok: false,
      errorClass: 'AUTH',
      problem: { code: 'scope_missing' },
    });
    expect(await as.healthCheck(ctxOf({ ...cfg(), contactMatch: 'tmsCode' }))).toMatchObject({
      ok: true,
    });
    // ไม่ยอมปลายทางภายในเมื่อไม่เปิด allowPrivate (SSRF)
    expect(
      await new AccountSystemAdapter({ allowPrivate: false }).healthCheck(ctxOf(cfg())),
    ).toMatchObject({ ok: false, errorClass: 'VALIDATION', problem: { code: 'url_not_allowed' } });
  });

  describe('webhook ขาเข้า', () => {
    const req = (w: { headers: Record<string, string>; body: string }, at = new Date()) => ({
      headers: w.headers,
      rawBody: Buffer.from(w.body),
      receivedAt: at,
    });
    const ctx = () => ctxOf(cfg());

    it('verify: ลายเซ็นถูก = ผ่าน · secret ผิด / body ถูกแก้ / timestamp เก่า > 5 นาที / ไม่มี secret = ไม่ผ่าน', () => {
      const w = m.webhook('document.posted', { id: 'x' });
      expect(accountSystemInbound.verify(ctx(), req(w))).toBe(true);
      expect(
        accountSystemInbound.verify(
          ctx(),
          req(m.webhook('document.posted', {}, new Date(), { secret: 'whsec_other' })),
        ),
      ).toBe(false);
      expect(
        accountSystemInbound.verify(ctx(), { ...req(w), rawBody: Buffer.from(`${w.body} `) }),
      ).toBe(false);
      const old = String(Math.floor(Date.now() / 1000) - 400);
      expect(
        accountSystemInbound.verify(
          ctx(),
          req(m.webhook('document.posted', {}, new Date(), { timestamp: old })),
        ),
      ).toBe(false);
      expect(accountSystemInbound.verify(ctxOf({ ...cfg(), webhookSecret: '' }), req(w))).toBe(
        false,
      );
      // ลายเซ็นตามสูตรตัวจริง
      const ts = w.headers['x-innovera-timestamp']!;
      expect(w.headers['x-innovera-signature']).toBe(
        `sha256=${signAccountSystemWebhook(SECRET, ts, w.body)}`,
      );
    });

    it('parse: eventKey = id ของ event · ชนิด · เวลา', () => {
      const w = m.webhook('payment.received', {});
      expect(accountSystemInbound.parse(ctx(), req(w))).toEqual({
        eventKey: w.event.id,
        type: 'payment.received',
        occurredAt: w.event.occurred_at,
      });
      expect(
        accountSystemInbound.parse(ctx(), { ...req(w), rawBody: Buffer.from('nope') }),
      ).toBeNull();
    });

    it('handle: document.posted/voided ของ TMS → externalDocument · เอกสารที่ไม่ได้มาจาก TMS = ไม่มีผล', async () => {
      const posted = m.webhook('document.posted', {
        id: 'd1',
        doc_type: 'IV',
        doc_no: 'IV2611-0001',
        external_source: 'tms.invoice',
        external_ref: 'INV-1',
        grand_total: '2124.50',
      });
      const r = await accountSystemInbound.handle(
        ctx(),
        accountSystemInbound.parse(ctx(), req(posted))!,
        req(posted),
      );
      expect(r).toMatchObject({
        ok: true,
        effects: [
          {
            kind: 'externalDocument',
            entityType: 'invoice',
            externalId: 'd1',
            localNumber: 'INV-1',
            externalDocNo: 'IV2611-0001',
            status: 'POSTED',
            externalTotal: '2124.50',
          },
        ],
      });
      const other = m.webhook('document.posted', { id: 'd2', external_source: 'pos' });
      const r2 = await accountSystemInbound.handle(
        ctx(),
        accountSystemInbound.parse(ctx(), req(other))!,
        req(other),
      );
      expect(r2).toEqual({ ok: true, summary: { skipped: 'not_from_tms' } });
      // review M2: ยกเลิกเอกสารที่ไม่มีที่มา (เช่น ใบรับเงิน) → ส่ง id ให้ core หา (entityType null)
      const rvVoid = m.webhook('document.voided', {
        id: 'rv1',
        doc_type: 'RV',
        doc_no: 'RV-1',
        external_source: null,
      });
      expect(
        await accountSystemInbound.handle(
          ctx(),
          accountSystemInbound.parse(ctx(), req(rvVoid))!,
          req(rvVoid),
        ),
      ).toMatchObject({
        ok: true,
        effects: [
          { kind: 'externalDocument', entityType: null, externalId: 'rv1', status: 'VOIDED' },
        ],
      });
    });

    it('handle: payment.received → ยอดตัดหนี้ = applied + wht (สตริง ไม่ใช้ float) · วันที่ตามเวลาไทย', async () => {
      const w = m.webhook(
        'payment.received',
        {
          id: 'rv1',
          doc_no: 'RV-0001',
          applications: [
            {
              document_id: 'd1',
              doc_no: 'IV-1',
              external_ref: 'INV-1',
              applied: '0.29',
              wht: '0.01',
            },
          ],
        },
        new Date('2026-11-20T18:30:00Z'),
      );
      const r = await accountSystemInbound.handle(
        ctx(),
        accountSystemInbound.parse(ctx(), req(w))!,
        req(w),
      );
      expect(r).toMatchObject({
        ok: true,
        effects: [
          {
            kind: 'paymentReceived',
            externalId: 'rv1',
            externalDocNo: 'RV-0001',
            receivedDate: '2026-11-21',
            allocations: [
              { externalId: 'd1', localNumber: 'INV-1', amount: '0.30', whtAmount: '0.01' },
            ],
          },
        ],
      });
      const bad = m.webhook('payment.received', {
        id: 'rv2',
        applications: [{ document_id: 'd', applied: 1.5 }],
      });
      expect(
        await accountSystemInbound.handle(
          ctx(),
          accountSystemInbound.parse(ctx(), req(bad))!,
          req(bad),
        ),
      ).toMatchObject({ ok: false, retryable: false });
    });

    it('handle: payment.paid → paymentMade + เลข 50 ทวิ · period.closed = รับไว้ไม่มีผล', async () => {
      const w = m.webhook('payment.paid', {
        id: 'pv1',
        doc_no: 'PV-0001',
        certificates: ['WHT-0001'],
        bills: [{ document_id: 'ap1', applied: '6910.00', wht: '90.00' }],
      });
      expect(
        await accountSystemInbound.handle(
          ctx(),
          accountSystemInbound.parse(ctx(), req(w))!,
          req(w),
        ),
      ).toMatchObject({
        ok: true,
        effects: [
          {
            kind: 'paymentMade',
            externalId: 'pv1',
            certificates: ['WHT-0001'],
            allocations: [{ externalId: 'ap1', amount: '7000.00', whtAmount: '90.00' }],
          },
        ],
      });
      const p = m.webhook('period.closed', { fiscal_year: 2569 });
      expect(
        await accountSystemInbound.handle(
          ctx(),
          accountSystemInbound.parse(ctx(), req(p))!,
          req(p),
        ),
      ).toMatchObject({ ok: true, summary: { skipped: 'event_not_used' } });
    });
  });
});
