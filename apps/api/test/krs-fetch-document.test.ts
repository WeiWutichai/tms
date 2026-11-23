import { type MockKrs, startMockKrs } from '@tms/mock-krs';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { KrsAdapter } from '../src/erp-adapters/krs/krs.adapter';
import { krsDocumentsFromSyncLog } from '../src/erp-adapters/krs/krs-fetch';
import {
  adapterShapeProblems,
  type CanonicalDocument,
  ErpAdapterError,
  type ErpContext,
  type ErpHttpCall,
  type ExternalRef,
  type LoggedHttpCall,
} from '../src/modules/erp/erp-adapter';

/**
 * ST8-T10 `fetchDocument` ของ KRS (docs/01 A.1–A.2, A.5; §6.5) — ไม่แตะฐานข้อมูล · ส่งจริง/อ่านจริงกับ mock KRS (ST8-T01)
 * เกณฑ์ตรวจรับ (plan/01 ST8-T10): push แล้ว fetch กลับได้ canonical เท่าต้นฉบับ (round-trip) — รวมใบที่แยกหลายเอกสาร (D-69)
 * + จับคู่รายการด้วย `flowNo` (= เลข DO) · 404 = NOT_FOUND · ชื่อคนขับไม่อยู่ใน sync log
 */

const KEY = 'krs-fetch-test-key-91be0d';
const DRIVER = 'สมศักดิ์ คนขับทดสอบ';
const CARRIER = 'บริษัท รถร่วมทดสอบ จำกัด';

function context(mock: MockKrs, calls: ErpHttpCall[] = []): ErpContext {
  return {
    tenantId: '00000000-0000-4000-8000-0000000000c1',
    connectorId: '00000000-0000-4000-8000-0000000000c2',
    companyId: null,
    erpCompanyCode: null,
    config: Object.freeze({ baseUrl: mock.apiBaseUrl, apiKey: KEY, salePerson: 'S001' }),
    onHttpCall: (c) => calls.push(c),
    masterCodes: {
      CUSTOMER: new Map([['c001', { code: 'C001', name: null }]]),
      UNIT: new Map([['เที่ยว', { code: 'เที่ยว', name: 'เที่ยว', fromCatalogue: true }]]),
      SALESPERSON: new Map([['s001', { code: 'S001', name: 'พนักงานขาย', fromCatalogue: true }]]),
      ITEM: new Map([
        ['item-frt', { code: 'ITEM-FRT', name: null, fromCatalogue: true }],
        ['item-lift', { code: 'ITEM-LIFT', name: null, fromCatalogue: true }],
      ]),
    },
  };
}

type Line = {
  lineNo: number;
  doNo: string;
  vat: 'EXEMPT_TRANSPORT' | 'VAT_7';
  qty: string;
  price: string;
  driver?: string | null;
};
/** canonical invoice (docs/01 §7.1–7.2) — ค่าเงินเป็นสตริงทศนิยม */
function invoice(lines: Line[]): CanonicalDocument {
  const id = randomUUID();
  return {
    id,
    kind: 'invoice',
    number: `INV-T10-${id.slice(0, 8)}`,
    issueDate: '2026-11-20',
    dueDate: '2026-12-20',
    issuer: {
      companyId: 'c',
      branchId: 'b',
      branchCode: '00000',
      legalName: 'x',
      taxId: null,
      address: null,
    },
    customer: {
      id: 'cu',
      code: 'C-1',
      externalId: 'C001',
      legalName: 'บริษัท ลูกค้า ทดสอบ จำกัด',
      taxId: null,
      branchCode: null,
      billingAddress: '9 ถ.ตัวอย่าง ระยอง 21000',
      paymentTermDays: 30,
    },
    customerPoNo: null,
    references: { customerRef: [] },
    totals: {
      subtotalVatable: '0.00',
      subtotalExempt: '0.00',
      subtotalZeroRated: '0.00',
      vatAmount: '0.00',
      total: '0.00',
      whtExpected: '0.00',
    },
    taxEstimated: true,
    lines: lines.map((l) => ({
      lineNo: l.lineNo,
      deliveryOrder: { id: randomUUID(), number: l.doNo, date: '2026-11-19' },
      salesOrder: null,
      trip: {
        number: 'TRP-1',
        vehiclePlate: '70-1234',
        driverName: l.driver === undefined ? DRIVER : l.driver,
        carrierName: l.driver === null ? CARRIER : null,
      },
      route: { originName: 'คลัง ก', destinationName: 'คลัง ข' },
      serviceItem: {
        id: randomUUID(),
        code: l.vat === 'VAT_7' ? 'LIFT' : 'FRT',
        externalId: l.vat === 'VAT_7' ? 'ITEM-LIFT' : 'ITEM-FRT',
      },
      description: l.vat === 'VAT_7' ? 'ค่ายกขน' : 'ค่าขนส่ง',
      quantity: l.qty,
      unitLabel: 'เที่ยว',
      unitPrice: l.price,
      discount: '0.00',
      amount: l.price,
      vatType: l.vat,
      vatAmount: '0.00',
      whtRate: '1.00',
      accountCode: null,
    })),
  };
}

const refOf = (
  doc: CanonicalDocument,
  externalId: string | null,
  documents?: ExternalRef['documents'],
): ExternalRef => ({
  entityType: 'invoice',
  localId: doc.id,
  number: String(doc.number),
  externalId,
  ...(documents ? { documents } : {}),
});
const strip = (d: CanonicalDocument | null) => {
  const { externalId: _e, externalDocNo: _n, ...rest } = (d ?? {}) as Record<string, unknown>;
  return rest;
};

describe('KRS fetchDocument (ST8-T10) — กับ mock KRS ไม่แตะฐานข้อมูล', () => {
  let mock: MockKrs;
  const krs = new KrsAdapter({ allowPrivate: true });
  beforeAll(async () => {
    mock = await startMockKrs({ apiKey: KEY });
  });
  afterEach(() => mock.clearFaults());
  afterAll(async () => {
    await mock.stop();
  });

  it('รูปของ adapter: fetchDocument ไม่ pending แล้ว (ค้าง replaceDocument) · ค้นด้วยเลขของเราไม่ได้ (fetchNeedsExternalId)', () => {
    expect(adapterShapeProblems(krs)).toEqual([]);
    expect(krs.pendingCapabilities).toEqual(['replaceDocument']);
    expect(krs.fetchNeedsExternalId).toBe(true);
  });

  it('เกณฑ์ตรวจรับ: push แล้ว fetch กลับ = canonical เท่าต้นฉบับ (ใบเดียว)', async () => {
    const doc = invoice([
      { lineNo: 1, doNo: 'DO-A1', vat: 'EXEMPT_TRANSPORT', qty: '1.000', price: '1500.00' },
      {
        lineNo: 2,
        doNo: 'DO-A2',
        vat: 'EXEMPT_TRANSPORT',
        qty: '2',
        price: '725.50',
        driver: null,
      },
    ]);
    const ctx = context(mock);
    const r = await krs.pushInvoice(ctx, doc);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const got = await krs.fetchDocument(ctx, refOf(doc, r.externalId), doc);
    expect(got).toMatchObject({ externalId: r.externalId, externalDocNo: r.externalDocNo });
    // ส่วนที่ KRS เก็บได้ของต้นฉบับ (payload ชุดเดียวกับที่ POST แปลงกลับ) = ผลที่อ่านกลับทุกช่อง
    expect(strip(got)).toEqual(krs.comparableDocument(ctx, doc));
    // และค่าตรงกับต้นฉบับ (ตัวเลขเทียบแบบทศนิยม — KRS เก็บเป็น JSON number)
    expect(got).toMatchObject({
      id: doc.id,
      number: doc.number,
      issueDate: doc.issueDate,
      dueDate: doc.dueDate,
      customer: {
        externalId: 'C001',
        legalName: 'บริษัท ลูกค้า ทดสอบ จำกัด',
        billingAddress: '9 ถ.ตัวอย่าง ระยอง 21000',
        paymentTermDays: 30,
      },
    });
    const src = doc.lines as Record<string, any>[];
    const back = got!.lines as Record<string, any>[];
    expect(back).toHaveLength(src.length);
    back.forEach((l, i) => {
      const o = src[i]!;
      expect(l).toMatchObject({
        lineNo: o.lineNo,
        deliveryOrder: { number: o.deliveryOrder.number, date: o.deliveryOrder.date },
        trip: { vehiclePlate: o.trip.vehiclePlate },
        route: o.route,
        serviceItem: { externalId: o.serviceItem.externalId },
        description: o.description,
        unitLabel: o.unitLabel,
      });
      expect(Number(l.quantity)).toBe(Number(o.quantity));
      expect(l.unitPrice).toBe(String(Number(o.unitPrice)));
    });
    // D-64: เที่ยวรถร่วมไม่มีชื่อคนขับ — KRS เก็บชื่อบริษัทรถร่วม (ค่าที่ส่งจริง)
    expect(back.map((l) => l.trip.driverName)).toEqual([DRIVER, CARRIER]);
  });

  it('เกณฑ์ตรวจรับ (ใบที่แยก — D-69): 2 เอกสาร KRS → อ่านทุกใบแล้วรวมเป็น canonical เดียว เท่าต้นฉบับ · DO เดียวหลายบรรทัด', async () => {
    const doc = invoice([
      { lineNo: 1, doNo: 'DO-B1', vat: 'VAT_7', qty: '1', price: '500.00' },
      { lineNo: 2, doNo: 'DO-B1', vat: 'EXEMPT_TRANSPORT', qty: '1', price: '2000.00' },
      { lineNo: 3, doNo: 'DO-B2', vat: 'EXEMPT_TRANSPORT', qty: '1', price: '1800.00' },
      { lineNo: 4, doNo: 'DO-B2', vat: 'EXEMPT_TRANSPORT', qty: '1', price: '300.00' },
    ]);
    const ctx = context(mock);
    const r = await krs.pushInvoice(ctx, doc);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.documents?.map((p) => p.ref)).toEqual([doc.number, `${doc.number}-V7`]);
    const got = await krs.fetchDocument(ctx, refOf(doc, r.externalId, r.documents), doc);
    expect(strip(got)).toEqual(krs.comparableDocument(ctx, doc));
    expect(got!.number).toBe(doc.number);
    expect(got!.externalId).toBe(r.externalId);
    expect((got!.lines as { lineNo: number }[]).map((l) => l.lineNo)).toEqual([1, 2, 3, 4]);
    expect(got!.partHeaderDiffs).toBeUndefined();
    // หัวใบของใบที่ 2 ถูกแก้ใน KRS → ต่างจากต้นฉบับ (บันทึกว่าใบใด/ช่องใด)
    const v7 = mock.getInvoiceByTmsVoucherNo(`${doc.number}-V7`)!;
    await fetch(`${mock.apiBaseUrl}/invoice/${v7.transactionNo}`, {
      method: 'PUT',
      headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...v7.data, dueDate: '2027-01-31' }),
    });
    const edited = await krs.fetchDocument(ctx, refOf(doc, r.externalId, r.documents), doc);
    expect(edited!.partHeaderDiffs).toEqual([{ ref: `${doc.number}-V7`, dueDate: '2027-01-31' }]);
    expect(strip(edited)).not.toEqual(krs.comparableDocument(ctx, doc));
  });

  it('จับคู่รายการด้วย flowNo: KRS เขียนรายการใหม่และเรียงเลขบรรทัดใหม่ (A.1) → ยังได้ lineNo ของ TMS · รายการหาย = ต่างจากต้นฉบับ', async () => {
    const doc = invoice([
      { lineNo: 3, doNo: 'DO-C1', vat: 'EXEMPT_TRANSPORT', qty: '1', price: '100.00' },
      { lineNo: 7, doNo: 'DO-C2', vat: 'EXEMPT_TRANSPORT', qty: '1', price: '200.00' },
      { lineNo: 9, doNo: 'DO-C3', vat: 'EXEMPT_TRANSPORT', qty: '1', price: '300.00' },
    ]);
    const ctx = context(mock);
    const r = await krs.pushInvoice(ctx, doc);
    if (!r.ok) throw new Error(JSON.stringify(r));
    mock.overwriteInvoice(r.externalId, { keepLines: null, renumberLineIds: true });
    expect(mock.getInvoice(r.externalId)!.data.lines.map((l) => l.lineId)).toEqual([1, 2, 3]);
    const got = await krs.fetchDocument(ctx, refOf(doc, r.externalId), doc);
    expect((got!.lines as { lineNo: number }[]).map((l) => l.lineNo)).toEqual([3, 7, 9]);
    expect(strip(got)).toEqual(krs.comparableDocument(ctx, doc));
    // ไม่มี hint = ใช้ lineId ของ KRS ตรง ๆ
    const raw = await krs.fetchDocument(ctx, refOf(doc, r.externalId));
    expect((raw!.lines as { lineNo: number }[]).map((l) => l.lineNo)).toEqual([1, 2, 3]);
    // บัญชีกดบันทึกแล้วรายการหาย (เคส 79 → 30 รายการ) — ค่าที่อ่านกลับไม่เท่าต้นฉบับ
    mock.overwriteInvoice(r.externalId, {
      keepLines: null,
      dropFlowNos: ['DO-C2'],
      blankFields: ['carId'],
    });
    const lost = await krs.fetchDocument(ctx, refOf(doc, r.externalId), doc);
    const lines = lost!.lines as Record<string, any>[];
    expect(lines.map((l) => [l.lineNo, l.trip.vehiclePlate])).toEqual([
      [3, ''],
      [9, ''],
    ]);
    expect(strip(lost)).not.toEqual(krs.comparableDocument(ctx, doc));
  });

  it('404 = NOT_FOUND (A.5) · ใบที่แยกหายบางใบ = NOT_FOUND ทั้งเอกสาร · 401 = AUTH · 503 = TRANSIENT · ไม่มีเลข KRS = VALIDATION', async () => {
    const doc = invoice([
      { lineNo: 1, doNo: 'DO-D1', vat: 'VAT_7', qty: '1', price: '50.00' },
      { lineNo: 2, doNo: 'DO-D2', vat: 'EXEMPT_TRANSPORT', qty: '1', price: '60.00' },
    ]);
    const ctx = context(mock);
    const err = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        expect(e).toBeInstanceOf(ErpAdapterError);
        return { errorClass: (e as ErpAdapterError).errorClass, ...(e as ErpAdapterError).problem };
      }
      throw new Error('expected ErpAdapterError');
    };
    expect(await err(krs.fetchDocument(ctx, refOf(doc, '99999999')))).toMatchObject({
      errorClass: 'NOT_FOUND',
      code: 'krs_not_found',
    });
    const r = await krs.pushInvoice(ctx, doc);
    if (!r.ok) throw new Error(JSON.stringify(r));
    const parts = r.documents!.map((p, i) => (i === 1 ? { ...p, externalId: '99999998' } : p));
    expect(await err(krs.fetchDocument(ctx, refOf(doc, r.externalId, parts), doc))).toMatchObject({
      errorClass: 'NOT_FOUND',
      code: 'krs_not_found',
      message: expect.stringContaining('99999998'),
    });
    const bad = { ...ctx, config: { ...ctx.config, apiKey: 'wrong-key' } };
    expect(await err(krs.fetchDocument(bad, refOf(doc, r.externalId)))).toMatchObject({
      errorClass: 'AUTH',
      code: 'unauthorized',
    });
    mock.injectFault({ kind: 'status', status: 503, method: 'GET', times: 1 });
    expect(await err(krs.fetchDocument(ctx, refOf(doc, r.externalId)))).toMatchObject({
      errorClass: 'TRANSIENT',
      code: 'service_unavailable',
    });
    expect(await err(krs.fetchDocument(ctx, refOf(doc, null)))).toMatchObject({
      errorClass: 'VALIDATION',
      code: 'krs_transaction_no_required',
    });
  });

  it('sync log: ทุก GET รายงาน onHttpCall — ไม่มี API key · ชื่อคนขับ (carPerson) ใน response ถูกปิด', async () => {
    const doc = invoice([
      { lineNo: 1, doNo: 'DO-E1', vat: 'EXEMPT_TRANSPORT', qty: '1', price: '90.00' },
    ]);
    const calls: ErpHttpCall[] = [];
    const ctx = context(mock, calls);
    const r = await krs.pushInvoice(ctx, doc);
    if (!r.ok) throw new Error(JSON.stringify(r));
    calls.length = 0;
    const got = await krs.fetchDocument(ctx, refOf(doc, r.externalId), doc);
    expect((got!.lines as Record<string, any>[])[0]!.trip.driverName).toBe(DRIVER);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `${mock.apiBaseUrl}/invoice/${r.externalId}`,
      status: 200,
      errorCode: null,
    });
    const text = JSON.stringify(calls);
    expect(text).not.toContain(DRIVER);
    expect(text).not.toContain(KEY);
    expect(String(calls[0]!.responseBody)).toContain('"carPerson":"***"');
    calls.length = 0;
    await krs.fetchDocument(ctx, refOf(doc, '88888888')).catch(() => null);
    expect(calls[0]).toMatchObject({ method: 'GET', status: 404, errorCode: 'http_404' });
  });

  it('review H1: ทุกใบมาจาก priorDocuments (ไม่ได้ POST เลย) → applied: false (ไม่ยืนยันเนื้อหา)', async () => {
    const doc = invoice([
      { lineNo: 1, doNo: 'DO-G1', vat: 'VAT_7', qty: '1', price: '11.00' },
      { lineNo: 2, doNo: 'DO-G2', vat: 'EXEMPT_TRANSPORT', qty: '1', price: '22.00' },
    ]);
    const ctx = context(mock);
    const r = await krs.pushInvoice(ctx, doc);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.applied).toBe(true);
    const posts = mock.requests().filter((q) => q.method === 'POST').length;
    const again = await krs.pushInvoice({ ...ctx, priorDocuments: r.documents }, doc);
    expect(mock.requests().filter((q) => q.method === 'POST').length).toBe(posts);
    expect(again).toMatchObject({ ok: true, externalId: r.externalId, applied: false });
  });

  it('documentsFromSyncLog: เลข KRS จาก POST 201 ใน sync log · body ถูกตัดท้ายยังได้ ref (lineNos ว่าง) · ไม่ใช่ 201 = ข้าม', async () => {
    const doc = invoice([
      { lineNo: 1, doNo: 'DO-F1', vat: 'VAT_7', qty: '1', price: '10.00' },
      { lineNo: 2, doNo: 'DO-F2', vat: 'EXEMPT_TRANSPORT', qty: '1', price: '20.00' },
    ]);
    const calls: ErpHttpCall[] = [];
    const r = await krs.pushInvoice(context(mock, calls), doc);
    if (!r.ok) throw new Error(JSON.stringify(r));
    const logged: LoggedHttpCall[] = calls.map((c) => ({
      method: c.method,
      url: c.url,
      status: c.status,
      requestBody: JSON.stringify(c.requestBody),
      responseBody: typeof c.responseBody === 'string' ? c.responseBody : null,
    }));
    expect(krsDocumentsFromSyncLog(logged)).toEqual(
      r.documents!.map((p) => ({ ...p, group: null })),
    );
    const cut = logged.map((c) => ({ ...c, requestBody: c.requestBody!.slice(0, 60) }));
    expect(krsDocumentsFromSyncLog(cut).map((p) => [p.ref, p.externalId, p.lineNos])).toEqual(
      r.documents!.map((p) => [p.ref, p.externalId, []]),
    );
    expect(
      krsDocumentsFromSyncLog(logged.map((c) => ({ ...c, status: 504, responseBody: null }))),
    ).toEqual([]);
  });
});
