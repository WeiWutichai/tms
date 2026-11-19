import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { lineAmountSatang, satangToNumber } from './decimal';
import { MockKrs, startMockKrs, type KrsInvoiceLine, type KrsInvoiceRequest } from './mock-krs';

/**
 * ST8-T01 contract test: mock ตอบตรงตาราง docs/01 A.1 ทุก error code + สวิตช์เขียนทับ (เกณฑ์ตรวจรับ plan/01)
 * ทุก test เรียกผ่าน HTTP จริง (port สุ่มบน 127.0.0.1) — ไม่มีการเรียกนอกเครื่อง
 */

const KEY = 'test-key';
let mock: MockKrs;
let api: string;

function line(i: number, over: Partial<KrsInvoiceLine> = {}): KrsInvoiceLine {
  return {
    lineId: i,
    mainQuantity: 1,
    mainUnits: 'เที่ยว',
    unitPrice: 26000,
    flowNo: `DO-2611-${String(i).padStart(5, '0')}`,
    flowDate: '2026-11-03',
    carId: '70-1234',
    carPerson: 'สมชาย',
    frWay: 'บางนา',
    toWay: 'แหลมฉบัง',
    ...over,
  };
}

function invoice(no = 'INV-00000-2611-0001', lines = [line(1)]): KrsInvoiceRequest {
  return {
    tmsVoucherNo: no,
    voucherDate: '2026-11-30',
    dueDate: '2026-12-30',
    paymentInDay: 30,
    custOrSuppCode: 'C0001',
    custOrSuppName: 'บจก. ตัวอย่างลูกค้า',
    address: '1 ถนนตัวอย่าง กรุงเทพฯ 10110',
    deliveryAddress: '1 ถนนตัวอย่าง กรุงเทพฯ 10110',
    salePerson: 'S01',
    saleName: 'ฝ่ายขาย',
    entryBy: 'TMS',
    lines,
  };
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(api + path, {
    method,
    headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

const post = (b: unknown, h?: Record<string, string>) => call('POST', '/invoice', b, h);

async function control(method: string, path: string, body?: unknown) {
  const res = await fetch(`${mock.url}/__mock${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  mock = await startMockKrs({ apiKey: KEY, timeoutMs: 150 });
  api = mock.apiBaseUrl;
});
afterAll(async () => {
  await mock.stop();
});
beforeEach(async () => {
  expect((await control('POST', '/reset')).status).toBe(200);
});

describe('A.1 สำเร็จ: POST 201 / PUT 200 / GET 200', () => {
  it('POST /invoice → 201 + transactionNo และ voucherNo SA-S{YYMM}-{NNNN} ที่ KRS ออกเอง (deterministic)', async () => {
    const a = await post(invoice('INV-1'));
    const b = await post(invoice('INV-2'));
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({
      transactionNo: '100001',
      voucherNo: 'SA-S2611-0001',
      tmsVoucherNo: 'INV-1',
    });
    expect(b.body).toMatchObject({ transactionNo: '100002', voucherNo: 'SA-S2611-0002' });
    expect(mock.isValidResponse(a.body)).toBe(true);
    expect(mock.isValidResponse(b.body)).toBe(true);
  });

  it('voucherNo เดินเลขต่อเดือนของ voucherDate · reset แล้วเลขเริ่มใหม่', async () => {
    await post(invoice('INV-1'));
    const dec = await post({ ...invoice('INV-2'), voucherDate: '2026-12-01' });
    expect(dec.body.voucherNo).toBe('SA-S2612-0001');
    await control('POST', '/reset');
    expect((await post(invoice('INV-1'))).body).toMatchObject({
      transactionNo: '100001',
      voucherNo: 'SA-S2611-0001',
    });
  });

  it('GET /invoice/{transactionNo} → 200 ข้อมูลใบ + ยอดที่ KRS คำนวณ (ทศนิยมแม่นยำ)', async () => {
    const lines = [line(1, { mainQuantity: 2.5, unitPrice: 1234.57 }), line(2)];
    const { body: created } = await post(invoice('INV-1', lines));
    const got = await call('GET', `/invoice/${created.transactionNo}`);
    expect(got.status).toBe(200);
    expect(mock.isValidResponse(got.body)).toBe(true);
    expect(got.body.lines).toHaveLength(2);
    expect(got.body.lines[0]).toMatchObject({ flowNo: 'DO-2611-00001', amount: 3086.43 });
    expect(got.body.totalAmount).toBe(29086.43);
    expect(got.body.custOrSuppName).toBe('บจก. ตัวอย่างลูกค้า');
  });

  it('PUT /invoice/{transactionNo} → 200 แทนที่ทั้งใบ (เลขเดิม, รายการชุดใหม่ทั้งหมด)', async () => {
    const { body: created } = await post(invoice('INV-1', [line(1), line(2), line(3)]));
    const put = await call(
      'PUT',
      `/invoice/${created.transactionNo}`,
      invoice('INV-1', [line(9, { unitPrice: 100 })]),
    );
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({
      transactionNo: created.transactionNo,
      voucherNo: created.voucherNo,
      tmsVoucherNo: 'INV-1',
    });
    expect(mock.isValidResponse(put.body)).toBe(true);
    const got = await call('GET', `/invoice/${created.transactionNo}`);
    expect(got.body.lines.map((l: KrsInvoiceLine) => l.lineId)).toEqual([9]);
    expect(mock.getInvoice(created.transactionNo)?.revision).toBe(2);
  });
});

describe('A.1 400 payload ผิด / ฟิลด์นอก whitelist / ส่งเลข KRS มาเอง', () => {
  const cases: Array<[string, unknown]> = [
    ['ส่ง voucherNo มาเอง', { ...invoice(), voucherNo: 'SA-S2611-0001' }],
    ['ส่ง transactionNo มาเอง', { ...invoice(), transactionNo: '1' }],
    ['ฟิลด์เกินที่หัวเอกสาร', { ...invoice(), vatType: 'VAT_7' }],
    ['ฟิลด์เกินในรายการ', invoice('X', [{ ...line(1), vatType: 'EXEMPT' } as KrsInvoiceLine])],
    ['ยอดเงินในรายการ (ไม่ส่ง — KRS คำนวณ)', invoice('X', [{ ...line(1), amount: 1 } as never])],
    ['วันที่ไม่ใช่ YYYY-MM-DD', { ...invoice(), voucherDate: '30/11/2026' }],
    ['flowDate ผิดรูป', invoice('X', [line(1, { flowDate: '2026-11-3' })])],
    ['lineId ไม่ใช่ int', invoice('X', [line(1, { lineId: 1.5 })])],
    ['ไม่มีรายการ', invoice('X', [])],
    ['ขาดฟิลด์บังคับ', (({ entryBy: _e, ...rest }) => rest)(invoice())],
    ['ขาดฟิลด์บังคับของรายการ', invoice('X', [(({ carId: _c, ...r }) => r)(line(1)) as never])],
    ['paymentInDay ติดลบ', { ...invoice(), paymentInDay: -1 }],
    ['body ไม่ใช่ JSON', '{not json'],
    ['body เป็น array', [invoice()]],
  ];
  it.each(cases)('%s → 400 พร้อมรายละเอียด', async (_name, body) => {
    const r = await post(body);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ status: 400, error: 'BAD_REQUEST' });
    expect(mock.listInvoices()).toHaveLength(0);
  });

  it('ฟิลด์เกินบอกชื่อฟิลด์ใน errors (A.5: เก็บ response ตัวเต็มขึ้น error queue)', async () => {
    const r = await post({ ...invoice(), voucherNo: 'SA-S2611-0001' });
    expect(r.body.errors).toContainEqual(
      expect.objectContaining({
        keyword: 'additionalProperties',
        params: { additionalProperty: 'voucherNo' },
      }),
    );
  });

  it('PUT ที่ body ผิดก็ได้ 400 และใบเดิมไม่เปลี่ยน', async () => {
    const { body: c } = await post(invoice('INV-1'));
    const r = await call('PUT', `/invoice/${c.transactionNo}`, { ...invoice('INV-1'), extra: 1 });
    expect(r.status).toBe(400);
    expect(mock.getInvoice(c.transactionNo)?.revision).toBe(1);
  });

  it('body เกินขนาดสูงสุด (A.1 50 MB — ตั้งค่าได้) → 400', async () => {
    const small = await startMockKrs({ apiKey: KEY, maxBodyBytes: 2048 });
    try {
      const big = invoice(
        'INV-BIG',
        Array.from({ length: 40 }, (_, i) => line(i + 1)),
      );
      const res = await fetch(`${small.apiBaseUrl}/invoice`, {
        method: 'POST',
        headers: { 'X-API-Key': KEY },
        body: JSON.stringify(big),
      });
      expect(res.status).toBe(400);
      expect(small.listInvoices()).toHaveLength(0);
    } finally {
      await small.stop();
    }
  });

  it('รับใบใหญ่ 446 รายการ (เคยมีใบจริง — A.1)', async () => {
    const r = await post(
      invoice(
        'INV-446',
        Array.from({ length: 446 }, (_, i) => line(i + 1)),
      ),
    );
    expect(r.status).toBe(201);
    expect(r.body.lines).toHaveLength(446);
  });
});

describe('A.1 401 key ผิด', () => {
  it.each([
    ['ไม่มี X-API-Key', { 'X-API-Key': '' }],
    ['key ผิด', { 'X-API-Key': 'wrong' }],
    ['key ยาวต่างกัน', { 'X-API-Key': `${KEY}x` }],
  ])('%s → 401 ทุก endpoint และไม่บันทึกอะไร', async (_n, h) => {
    expect((await post(invoice(), h)).status).toBe(401);
    expect((await call('GET', '/invoice/100001', undefined, h)).status).toBe(401);
    expect((await call('PUT', '/invoice/100001', invoice(), h)).status).toBe(401);
    expect(mock.listInvoices()).toHaveLength(0);
  });

  it('401 ตรวจก่อน validate (payload ผิด + key ผิด = 401)', async () => {
    expect((await post({ bad: true }, { 'X-API-Key': 'wrong' })).status).toBe(401);
  });
});

describe('A.1 404 ไม่พบ', () => {
  it('GET / PUT transactionNo ที่ไม่มี → 404', async () => {
    expect((await call('GET', '/invoice/999999')).status).toBe(404);
    const put = await call('PUT', '/invoice/999999', invoice());
    expect(put.status).toBe(404);
    expect(put.body.error).toBe('NOT_FOUND');
  });

  it('ไม่มี DELETE /invoice และ endpoint ค้นด้วย tmsVoucherNo (A.1 สิ่งที่ไม่มี)', async () => {
    const { body: c } = await post(invoice('INV-1'));
    expect((await call('DELETE', `/invoice/${c.transactionNo}`)).status).toBe(405);
    expect((await call('GET', '/invoice')).status).toBe(405);
    expect((await call('GET', '/deliveryorder')).status).toBe(404);
    expect((await call('POST', '/creditnote', {})).status).toBe(404);
    expect(mock.listInvoices()).toHaveLength(1);
  });

  it('putCheckOrder = lookup-first: PUT ใบที่ไม่มี + body ผิด → 404', async () => {
    const m = await startMockKrs({ apiKey: KEY, putCheckOrder: 'lookup-first' });
    try {
      const res = await fetch(`${m.apiBaseUrl}/invoice/1`, {
        method: 'PUT',
        headers: { 'X-API-Key': KEY },
        body: '{}',
      });
      expect(res.status).toBe(404);
    } finally {
      await m.stop();
    }
  });
});

describe('A.1 409 tmsVoucherNo ซ้ำ', () => {
  it('POST ซ้ำเลขเดิม → 409 ไม่ออกเลขใหม่ (ไม่บอก transactionNo — A.5)', async () => {
    await post(invoice('INV-1'));
    const dup = await post(invoice('INV-1'));
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ status: 409, error: 'CONFLICT' });
    expect(dup.body.transactionNo).toBeUndefined();
    expect(mock.listInvoices()).toHaveLength(1);
    expect((await post(invoice('INV-2'))).body.transactionNo).toBe('100002');
  });

  it('PUT ด้วย tmsVoucherNo ของใบอื่น → 409', async () => {
    await post(invoice('INV-1'));
    const { body: b } = await post(invoice('INV-2'));
    expect((await call('PUT', `/invoice/${b.transactionNo}`, invoice('INV-1'))).status).toBe(409);
  });

  it('PUT เปลี่ยน tmsVoucherNo: ค่าเริ่มยอม / reject400 ปฏิเสธ', async () => {
    const { body: a } = await post(invoice('INV-1'));
    expect((await call('PUT', `/invoice/${a.transactionNo}`, invoice('INV-1B'))).status).toBe(200);
    expect((await post(invoice('INV-1'))).status).toBe(201); // เลขเดิมว่างแล้ว
    const strict = await startMockKrs({ apiKey: KEY, putTmsVoucherNoChange: 'reject400' });
    try {
      const h = { 'X-API-Key': KEY };
      const c = await fetch(`${strict.apiBaseUrl}/invoice`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify(invoice('A')),
      });
      const { transactionNo } = (await c.json()) as { transactionNo: string };
      const r = await fetch(`${strict.apiBaseUrl}/invoice/${transactionNo}`, {
        method: 'PUT',
        headers: h,
        body: JSON.stringify(invoice('B')),
      });
      expect(r.status).toBe(400);
    } finally {
      await strict.stop();
    }
  });
});

describe('A.1 503 DB KRS ล่ม + timeout / connection reset (A.5)', () => {
  it('สวิตช์ 503 ผ่าน control endpoint: ตอบ 503 ตามจำนวนครั้ง แล้วกลับปกติ ไม่บันทึกใบ', async () => {
    expect((await control('POST', '/faults', { status: 503, times: 2 })).status).toBe(200);
    const r1 = await post(invoice('INV-1'));
    expect(r1.status).toBe(503);
    expect(r1.body.error).toBe('SERVICE_UNAVAILABLE');
    expect(r1.headers.get('retry-after')).toBe('60');
    expect((await call('GET', '/invoice/100001')).status).toBe(503);
    expect(mock.listInvoices()).toHaveLength(0);
    expect((await post(invoice('INV-1'))).status).toBe(201);
  });

  it('times = 0 → 503 ทุกคำขอจนกว่าจะล้างสวิตช์ (healthCheck ไม่ผ่าน)', async () => {
    await control('POST', '/faults', { status: 503, times: 0 });
    for (let i = 0; i < 3; i++) expect((await post(invoice(`INV-${i}`))).status).toBe(503);
    await control('DELETE', '/faults');
    expect((await post(invoice('INV-9'))).status).toBe(201);
  });

  it('fault เฉพาะ method: 503 เฉพาะ PUT', async () => {
    const { body: c } = await post(invoice('INV-1'));
    await control('POST', '/faults', { status: 503, method: 'PUT' });
    expect((await call('GET', `/invoice/${c.transactionNo}`)).status).toBe(200);
    expect((await call('PUT', `/invoice/${c.transactionNo}`, invoice('INV-1'))).status).toBe(503);
  });

  it('header X-Mock-Fault สั่ง 503 / 401 / 404 / 409 / 400 ต่อคำขอได้ (ทุก code ใน A.1)', async () => {
    for (const s of [400, 401, 404, 409, 503]) {
      const r = await post(invoice(`INV-${s}`), { 'X-Mock-Fault': String(s) });
      expect(r.status).toBe(s);
      expect(r.body.status).toBe(s);
    }
    expect(mock.listInvoices()).toHaveLength(0);
  });

  it('timeout: ค้างแล้วตัดการเชื่อมต่อ ไม่บันทึกใบ', async () => {
    await expect(post(invoice('INV-1'), { 'X-Mock-Fault': 'timeout' })).rejects.toThrow();
    expect(mock.listInvoices()).toHaveLength(0);
    expect(mock.requests().at(-1)?.status).toBe('timeout');
  });

  it('connection reset ก่อนบันทึก → ไม่มีใบ · POST ใหม่ได้ 201', async () => {
    await control('POST', '/faults', { kind: 'reset' });
    await expect(post(invoice('INV-1'))).rejects.toThrow();
    expect(mock.listInvoices()).toHaveLength(0);
    expect((await post(invoice('INV-1'))).status).toBe(201);
  });

  it('POST สำเร็จแต่ response หาย (reset/timeout-after-commit) → POST ใหม่ได้ 409 (A.5 AMBIGUOUS)', async () => {
    for (const kind of ['reset-after-commit', 'timeout-after-commit'] as const) {
      await control('POST', '/reset');
      await control('POST', '/faults', { kind });
      await expect(post(invoice('INV-1'))).rejects.toThrow();
      expect(mock.listInvoices()).toHaveLength(1);
      expect((await post(invoice('INV-1'))).status).toBe(409);
    }
  });

  it('สวิตช์ผิดรูป → 400 ที่ control', async () => {
    expect((await control('POST', '/faults', { kind: 'boom' })).status).toBe(400);
    expect((await control('POST', '/faults', { status: 200 })).status).toBe(400);
    expect((await control('POST', '/faults', { times: -1 })).status).toBe(400);
  });
});

describe('สวิตช์ "บัญชีกดบันทึกแล้วรายการถูกเขียนใหม่" (A.1 พฤติกรรม ERP → ST8-T11)', () => {
  const lines79 = () => Array.from({ length: 79 }, (_, i) => line(i + 1, { unitPrice: 26000 }));

  it('เปิดสวิตช์เขียนทับแล้ว GET ได้รายการที่เปลี่ยน: 79 → 30 รายการ (2,054,000 → 780,000)', async () => {
    const { body: c } = await post(invoice('INV-79', lines79()));
    expect(c.lines).toHaveLength(79);
    expect(c.totalAmount).toBe(2054000);
    const sw = await control('PUT', '/overwrite', { enabled: true });
    expect(sw.status).toBe(200);
    const got = await call('GET', `/invoice/${c.transactionNo}`);
    expect(got.status).toBe(200);
    expect(got.body.lines).toHaveLength(30);
    expect(got.body.totalAmount).toBe(780000);
    expect(got.body).toMatchObject({ transactionNo: c.transactionNo, voucherNo: c.voucherNo });
    expect(mock.isValidResponse(got.body)).toBe(true);
    expect(mock.getInvoice(c.transactionNo)?.overwriteCount).toBe(1);
  });

  it('สวิตช์เปิดค้าง: ใบที่ POST หลังจากนั้นตอบตามที่ส่ง แต่ GET ได้รายการที่ถูกเขียนใหม่ + ฟิลด์รถ/เส้นทางว่าง', async () => {
    await control('PUT', '/overwrite', {
      enabled: true,
      rule: { keepLines: null, blankFields: ['carId', 'carPerson', 'frWay', 'toWay'] },
    });
    const { status, body: c } = await post(invoice('INV-1', [line(1), line(2)]));
    expect(status).toBe(201);
    expect(c.lines[0].carId).toBe('70-1234');
    const got = await call('GET', `/invoice/${c.transactionNo}`);
    expect(got.body.lines).toHaveLength(2);
    expect(got.body.lines[0]).toMatchObject({ carId: '', carPerson: '', frWay: '', toWay: '' });
    expect(got.body.lines[0].flowNo).toBe('DO-2611-00001');
  });

  it('PUT หลังถูกเขียนทับ = แทนที่ทั้งใบกลับเป็นข้อมูล TMS (สวิตช์ปิดแล้ว)', async () => {
    const { body: c } = await post(invoice('INV-79', lines79()));
    await control('PUT', '/overwrite', { enabled: true });
    await control('PUT', '/overwrite', { enabled: false });
    expect((await call('GET', `/invoice/${c.transactionNo}`)).body.lines).toHaveLength(30);
    await call('PUT', `/invoice/${c.transactionNo}`, invoice('INV-79', lines79()));
    expect((await call('GET', `/invoice/${c.transactionNo}`)).body.lines).toHaveLength(79);
  });

  it('เขียนทับใบเดียว: ตัดตาม flowNo + เรียง lineId ใหม่ + ค่าว่างเป็น null', async () => {
    const { body: a } = await post(invoice('INV-1', [line(1), line(2), line(3)]));
    const { body: b } = await post(invoice('INV-2', [line(1)]));
    const r = await control('POST', `/invoices/${a.transactionNo}/overwrite`, {
      keepLines: null,
      dropFlowNos: ['DO-2611-00001'],
      blankFields: ['carId'],
      blankValue: null,
      renumberLineIds: true,
    });
    expect(r.status).toBe(200);
    const got = await call('GET', `/invoice/${a.transactionNo}`);
    expect(got.body.lines.map((l: KrsInvoiceLine) => [l.lineId, l.flowNo, l.carId])).toEqual([
      [1, 'DO-2611-00002', null],
      [2, 'DO-2611-00003', null],
    ]);
    expect((await call('GET', `/invoice/${b.transactionNo}`)).body.lines).toHaveLength(1);
    expect((await control('POST', '/invoices/999/overwrite', {})).status).toBe(404);
    expect(
      (await control('POST', `/invoices/${a.transactionNo}/overwrite`, { blankFields: ['x'] }))
        .status,
    ).toBe(400);
  });

  it('GET /__mock/state แสดงใบ สวิตช์ และ log คำขอ · reset ปิดสวิตช์ทั้งหมด', async () => {
    await post(invoice('INV-1'));
    await control('PUT', '/overwrite', { enabled: true, rule: { keepLines: 0 } });
    await control('POST', '/faults', { status: 503, times: 0 });
    const s = await control('GET', '/state');
    expect(s.body.invoices).toHaveLength(1);
    expect(s.body.overwrite.enabled).toBe(true);
    expect(s.body.faults).toHaveLength(1);
    expect(s.body.requests[0]).toMatchObject({ method: 'POST', path: '/api/invoice', status: 201 });
    await control('POST', '/reset');
    const after = await control('GET', '/state');
    expect(after.body).toMatchObject({ invoices: [], faults: [], overwrite: { enabled: false } });
  });
});

describe('[OPEN — KRS] พฤติกรรมที่ contract ไม่ระบุ — ตั้งค่าได้', () => {
  async function withMock<T>(
    opts: Parameters<typeof startMockKrs>[0],
    fn: (m: MockKrs) => Promise<T>,
  ) {
    const m = await startMockKrs({ apiKey: KEY, ...opts });
    try {
      return await fn(m);
    } finally {
      await m.stop();
    }
  }
  const req = (
    m: MockKrs,
    method: string,
    path: string,
    body?: unknown,
    h: Record<string, string> = {},
  ) =>
    fetch(m.apiBaseUrl + path, {
      method,
      headers: { 'X-API-Key': KEY, ...h },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it('method อื่นบน /invoice: ค่าเริ่ม 405 + Allow · unsupportedMethodStatus 404', async () => {
    const r = await call('DELETE', '/invoice/1');
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('GET, PUT');
    await withMock({ unsupportedMethodStatus: 404 }, async (m) => {
      expect((await req(m, 'DELETE', '/invoice/1')).status).toBe(404);
      expect((await req(m, 'GET', '/invoice')).status).toBe(404);
    });
  });

  it('Retry-After ของ 503: ค่าเริ่ม 60 · ตั้งเป็นตัวเลขอื่น · null = ไม่มี header', async () => {
    await withMock({ retryAfterSeconds: 5 }, async (m) => {
      const r = await req(m, 'GET', '/invoice/1', undefined, { 'X-Mock-Fault': '503' });
      expect(r.headers.get('retry-after')).toBe('5');
    });
    await withMock({ retryAfterSeconds: null }, async (m) => {
      const r = await req(m, 'GET', '/invoice/1', undefined, { 'X-Mock-Fault': '503' });
      expect(r.status).toBe(503);
      expect(r.headers.get('retry-after')).toBeNull();
    });
  });

  it('วิธีปัดยอด: line-half-up (ค่าเริ่ม) / total-half-up / line-half-even', async () => {
    const lines = [line(1, { unitPrice: 0.125 }), line(2, { unitPrice: 0.125 })];
    const total = async (amountRounding?: 'line-half-up' | 'total-half-up' | 'line-half-even') =>
      withMock(amountRounding ? { amountRounding } : {}, async (m) => {
        const r = (await (await req(m, 'POST', '/invoice', invoice('R', lines))).json()) as any;
        return [r.lines.map((l: any) => l.amount), r.totalAmount];
      });
    expect(await total()).toEqual([[0.13, 0.13], 0.26]);
    expect(await total('total-half-up')).toEqual([[0.13, 0.13], 0.25]);
    expect(await total('line-half-even')).toEqual([[0.12, 0.12], 0.24]);
  });

  it('contract ตรวจแค่รูปแบบวันที่: 2026-13-45 ผ่าน schema (KRS จะรับหรือไม่ยังไม่รู้)', async () => {
    expect((await post({ ...invoice(), voucherDate: '2026-13-45' })).status).toBe(201);
  });
});

describe('control และ header ต้องไม่ทำให้ mock ล้ม', () => {
  it('blankFields เป็นฟิลด์ตัวเลข/ไม่ใช่ array → 400 · GET หลังเขียนทับไม่ 500', async () => {
    const { body: c } = await post(invoice('INV-1'));
    for (const rule of [
      { blankFields: ['unitPrice'] },
      { blankFields: ['mainQuantity'] },
      { blankFields: 5 },
    ])
      expect((await control('POST', `/invoices/${c.transactionNo}/overwrite`, rule)).status).toBe(
        400,
      );
    expect(
      (await control('PUT', '/overwrite', { enabled: true, rule: { blankFields: 'carId' } }))
        .status,
    ).toBe(400);
    expect((await call('GET', `/invoice/${c.transactionNo}`)).status).toBe(200);
  });

  it('body ของ /__mock/faults ผิดรูป → 400 และไม่ใส่คิวบางส่วน', async () => {
    for (const body of [[1], [null], { method: 'DELETE' }, { status: '503' }, { times: 'x' }])
      expect((await control('POST', '/faults', body)).status).toBe(400);
    expect((await control('POST', '/faults', [{ status: 503 }, { kind: 'boom' }])).status).toBe(
      400,
    );
    expect((await control('GET', '/state')).body.faults).toHaveLength(0);
    const bad = await fetch(`${mock.url}/__mock/faults`, { method: 'POST', body: '{oops' });
    expect(bad.status).toBe(400);
  });

  it('URI encode ผิด → 404 ทั้ง API และ control', async () => {
    expect((await call('GET', '/invoice/%E0%A4%A')).status).toBe(404);
    expect((await control('POST', '/invoices/%E0%A4%A/overwrite', {})).status).toBe(404);
    expect((await control('GET', '/state')).status).toBe(200);
  });

  it('X-Mock-Fault รับเฉพาะ 400–599 และชนิดที่กำหนด — อื่น ๆ = 400', async () => {
    for (const h of ['200', '302', '600', 'bogus']) {
      const r = await post(invoice('INV-H'), { 'X-Mock-Fault': h });
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/X-Mock-Fault/);
    }
    expect(mock.listInvoices()).toHaveLength(0);
  });
});

describe('วงจรชีวิตและยอดเงิน', () => {
  it('start/stop ได้หลายตัวพร้อมกันบนพอร์ตสุ่ม · stop ตัดคำขอที่ค้าง', async () => {
    const m = new MockKrs({ timeoutMs: 60_000 });
    await m.start();
    const pending = fetch(`${m.apiBaseUrl}/invoice`, {
      method: 'POST',
      headers: { 'X-API-Key': m.apiKey, 'X-Mock-Fault': 'timeout' },
      body: '{}',
    });
    await new Promise((r) => setTimeout(r, 50));
    await m.stop();
    await expect(pending).rejects.toThrow();
    expect(() => m.url).toThrow();
  });

  it('ยอดต่อรายการคำนวณแบบทศนิยม ไม่ใช้ float (ปัดครึ่งขึ้น 2 ตำแหน่ง)', () => {
    expect(satangToNumber(lineAmountSatang(0.1, 0.2))).toBe(0.02);
    expect(satangToNumber(lineAmountSatang(3, 0.1))).toBe(0.3);
    expect(satangToNumber(lineAmountSatang(1.005, 1))).toBe(1.01);
    expect(satangToNumber(lineAmountSatang(-1.005, 1))).toBe(-1.01);
    expect(satangToNumber(lineAmountSatang(79, 26000))).toBe(2054000);
    expect(satangToNumber(lineAmountSatang(1e-7, 1))).toBe(0);
  });

  it('validate() ใช้ตรวจ payload builder ได้โดยไม่ต้องเปิด server', () => {
    const m = new MockKrs();
    expect(m.validate(invoice())).toBeNull();
    expect(m.validate({ ...invoice(), voucherNo: 'x' })?.[0]?.keyword).toBe('additionalProperties');
  });
});
