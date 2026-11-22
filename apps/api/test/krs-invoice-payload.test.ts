import { Prisma } from '@prisma/client';
import { type ErpMasterCodeKind, resolveErpMasterCode } from '@tms/domain';
import { type MockKrs, startMockKrs } from '@tms/mock-krs';
import Ajv2020 from 'ajv/dist/2020';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildKrsInvoicePayload,
  isKrsDate,
  KRS_INVOICE_HEADER_FIELDS,
  KRS_INVOICE_LINE_FIELDS,
  KRS_MAX_PAYLOAD_BYTES,
  KRS_PAYLOAD_DEFAULTS,
  KRS_PAYLOAD_INVALID,
  type KrsInvoiceDocument,
  type KrsPayloadOptions,
  type KrsPayloadResult,
  krsNonWhitelistedKeys,
  krsNumber,
} from '../src/erp-adapters/krs/krs-invoice-payload';
import { AccountSystemAdapter } from '../src/erp-adapters/accountsystem/accountsystem.adapter';
import { DemoAdapter } from '../src/erp-adapters/demo/demo.adapter';
import { krsMasterCodeRefs } from '../src/erp-adapters/krs/krs-master-codes';
import { KrsAdapter } from '../src/erp-adapters/krs/krs.adapter';
import {
  type CanonicalInvoiceLine,
  type CanonicalInvoicePayload,
  canonicalInvoice,
  type InvoiceForCanonical,
  withSyncHash,
} from '../src/modules/erp/canonical';
import type {
  ErpAdapter,
  ErpContext,
  MasterCodeRefKind,
  ResolvedMasterCode,
  ResolvedMasterCodes,
} from '../src/modules/erp/erp-adapter';

/**
 * ST8-T07 payload builder ของ KRS (docs/01 A.3, §7.4) — เทียบ JSON schema ของ contract (`packages/contracts/krs`)
 * เกณฑ์ตรวจรับ: ใบ 446 รายการสร้าง payload ผ่าน schema · ใส่ field นอก whitelist แล้ว test แดง
 * ไม่แตะฐานข้อมูล (ฟังก์ชันบริสุทธิ์) — mock KRS รัน in-process บน 127.0.0.1 เท่านั้น
 */

const SCHEMA = JSON.parse(
  readFileSync(
    join(__dirname, '../../../packages/contracts/krs/invoice-request.schema.json'),
    'utf8',
  ),
) as {
  required: string[];
  properties: Record<string, unknown> & {
    lines: { items: { required: string[]; properties: Record<string, unknown> } };
  };
};
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(SCHEMA);

type Catalogue = Partial<Record<ErpMasterCodeKind, { code: string; name: string | null }[]>>;
const CATALOGUE: Catalogue = {
  UNIT: [
    { code: 'เที่ยว', name: 'เที่ยว' },
    { code: 'TON', name: 'ตัน' },
    { code: 'กม.', name: 'กม.' },
  ],
  SALESPERSON: [{ code: 'S01', name: 'ฝ่ายขาย ตัวอย่าง' }],
};
const CONFIG = { salePerson: 's01' };

/** จำลองประตูผังรหัสของ core (ST8-T06 `checkMasterCodeRefs`) แบบไม่แตะฐาน: ค่าที่ผ่าน → `ctx.masterCodes` · ไม่ผ่าน = ไม่อยู่ในผล */
function gate(
  doc: CanonicalInvoicePayload,
  config: Record<string, string> = CONFIG,
  catalogue: Catalogue = CATALOGUE,
): Pick<ErpContext, 'config' | 'masterCodes'> {
  const out: Partial<Record<MasterCodeRefKind, Map<string, ResolvedMasterCode>>> = {};
  const put = (kind: MasterCodeRefKind, value: string, hit: ResolvedMasterCode) =>
    (out[kind] ??= new Map()).set(value.toLowerCase(), hit);
  for (const ref of krsMasterCodeRefs({ config }, 'PUSH_INVOICE', doc)) {
    if (!ref.value) continue;
    if (ref.kind === 'CUSTOMER' || ref.kind === 'CARRIER') {
      put(ref.kind, ref.value, { code: ref.value, name: null });
      continue;
    }
    const options = catalogue[ref.kind];
    if (!ref.strict && !options) {
      put(ref.kind, ref.value, { code: ref.value, name: null });
      continue;
    }
    const r = resolveErpMasterCode(ref.value, options ?? [], { matchByName: !!ref.matchByName });
    if (r.status === 'FOUND')
      put(ref.kind, ref.value, { code: r.code, name: r.name, fromCatalogue: true });
  }
  return { config, masterCodes: out as ResolvedMasterCodes };
}

const UNITS = ['เที่ยว', 'ตัน', 'กม.'];
const ROUTES = [
  ['คลังบางนา', 'ท่าเรือแหลมฉบัง'],
  ['โรงงานตัวอย่าง ระยอง', 'ศูนย์กระจายสินค้าวังน้อย'],
  ['ICD ลาดกระบัง', 'นิคมอมตะซิตี้ ชลบุรี'],
  ['คลังสินค้าตัวอย่าง ขอนแก่น', 'ท่าเรือกรุงเทพ'],
] as const;
const DRIVERS = ['สมชาย ตัวอย่าง', 'สมหญิง ตัวอย่าง', 'วิชัย ตัวอย่าง', 'A. Driver'];
const pad = (n: number) => String(n).padStart(5, '0');
/**
 * รายการตัวอย่างแบบผสม (ข้อมูลปลอม): หลายเส้นทาง/คนขับ · ทุก 7 รายการเป็นเที่ยวรถร่วม (มีชื่อคนขับ + ชื่อรถร่วม)
 * · รายการที่ 5, 10, … เป็นค่าบริการเสริมของ DO เดียวกับรายการก่อนหน้า (`flowNo` ซ้ำในใบ)
 */
function line(n: number, extra: Partial<CanonicalInvoiceLine> = {}): CanonicalInvoiceLine {
  const surcharge = n > 1 && n % 5 === 0;
  const doNo = surcharge ? n - 1 : n; // ค่าบริการเสริมใช้ DO ของรายการก่อนหน้า
  const qty = surcharge ? '2.0000' : n % 3 === 1 ? '12.5000' : '1.0000';
  const price = surcharge ? '250.00' : n % 3 === 1 ? '350.00' : '6500.00';
  const [originName, destinationName] = ROUTES[doNo % ROUTES.length]!;
  const carrier = doNo % 7 === 0;
  return {
    lineNo: n,
    deliveryOrder: {
      id: `00000000-0000-4000-8000-${String(doNo).padStart(12, '0')}`,
      number: `DO-2611-${pad(doNo)}`,
      date: `2026-11-${String(1 + (doNo % 28)).padStart(2, '0')}`,
    },
    salesOrder: { number: `SO-2611-${pad(doNo)}`, externalId: null },
    trip: {
      number: `TR-2611-${pad(doNo)}`,
      vehiclePlate: `70-${String(1000 + (doNo % 9000))}`,
      driverName: DRIVERS[doNo % DRIVERS.length]!,
      carrierName: carrier ? 'หจก. ตัวอย่างรถร่วม' : null,
    },
    route: { originName, destinationName },
    serviceItem: surcharge
      ? { id: 'si-wait', code: 'WAIT', externalId: 'IT-WAIT' }
      : { id: 'si-freight', code: 'FREIGHT', externalId: 'IT-FRT' },
    description: surcharge ? `ค่ารอ (${n})` : `ค่าขนส่ง ${originName} – ${destinationName} (${n})`,
    quantity: qty,
    unitLabel: surcharge ? 'เที่ยว' : UNITS[n % 3]!,
    unitPrice: price,
    discount: '0.00',
    amount: new Prisma.Decimal(qty).mul(price).toFixed(2),
    vatType: surcharge ? 'VAT_7' : 'EXEMPT_TRANSPORT',
    vatAmount: '0.00',
    whtRate: surcharge ? '3.00' : '1.00',
    accountCode: null,
    ...extra,
  };
}

function invoice(
  lines: CanonicalInvoiceLine[],
  extra: Partial<CanonicalInvoicePayload> = {},
): CanonicalInvoicePayload {
  const total = lines.reduce((s, l) => s.plus(l.amount), new Prisma.Decimal(0)).toFixed(2);
  return withSyncHash({
    kind: 'invoice',
    id: '00000000-0000-4000-8000-00000000abcd',
    number: 'INV-00000-2611-0001',
    issueDate: '2026-11-30',
    dueDate: '2026-12-30',
    issuer: {
      companyId: 'c',
      branchId: 'b',
      branchCode: '00000',
      legalName: 'บริษัท ตัวอย่างผู้ออกบิล จำกัด',
      taxId: '0105555000009',
      address: '9 ถนนตัวอย่าง กรุงเทพฯ 10110',
    },
    customer: {
      id: 'cus',
      code: 'C-0001',
      legalName: 'บริษัท ตัวอย่างลูกค้า จำกัด',
      taxId: '0105555000001',
      branchCode: '00000',
      externalId: 'PP-C0001',
      billingAddress: '1 ถนนตัวอย่าง\nแขวงตัวอย่าง กรุงเทพฯ 10110',
      paymentTermDays: 30,
    },
    customerPoNo: null,
    references: { customerRef: [] },
    totals: {
      subtotalVatable: '0.00',
      subtotalExempt: total,
      subtotalZeroRated: '0.00',
      vatAmount: '0.00',
      total,
      whtExpected: '0.00',
    },
    taxEstimated: true,
    lines,
    ...extra,
  } as CanonicalInvoicePayload);
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const build = (doc: CanonicalInvoicePayload, options: Partial<KrsPayloadOptions> = {}) =>
  buildKrsInvoicePayload(gate(doc), doc, options);
function docs(r: KrsPayloadResult): KrsInvoiceDocument[] {
  if (!r.ok) throw new Error(`คาดว่าสร้างได้: ${JSON.stringify(r.problem)}`);
  return r.documents;
}
function failure(r: KrsPayloadResult) {
  if (r.ok) throw new Error('คาดว่าสร้างไม่ได้');
  return r;
}
const codes = (r: KrsPayloadResult) =>
  failure(r).problem.fields!.map((f) => `${f.field}:${f.code}`);
const schemaOk = (body: unknown) => {
  const ok = validate(body);
  return ok ? true : JSON.stringify(validate.errors);
};

describe('KRS payload builder — whitelist ตรงกับ contract', () => {
  it('รายการฟิลด์ของ builder = properties ของ schema (contract เปลี่ยนแล้ว test แดง)', () => {
    expect([...KRS_INVOICE_HEADER_FIELDS].sort()).toEqual(Object.keys(SCHEMA.properties).sort());
    expect([...KRS_INVOICE_LINE_FIELDS].sort()).toEqual(
      Object.keys(SCHEMA.properties.lines.items.properties).sort(),
    );
  });

  it('ใส่ field นอก whitelist → schema ไม่ผ่าน และตัวตรวจ whitelist บอกชื่อฟิลด์', () => {
    const body = docs(build(invoice([line(1), line(2)])))[0]!.body;
    expect(schemaOk(body)).toBe(true);
    expect(krsNonWhitelistedKeys(body)).toEqual([]);

    const extraHead = { ...body, voucherNo: 'SA-S6911-0001' };
    expect(validate(extraHead)).toBe(false);
    expect(krsNonWhitelistedKeys(extraHead)).toEqual(['voucherNo']);

    const extraLine = { ...body, lines: [body.lines[0], { ...body.lines[1], vatType: 'VAT_7' }] };
    expect(validate(extraLine)).toBe(false);
    expect(krsNonWhitelistedKeys(extraLine)).toEqual(['lines[1].vatType']);
  });

  it('ไม่ส่งช่องของ canonical ที่อยู่นอกสัญญา (ยอดเงิน / ส่วนลด / VAT / WHT / เลขที่ KRS ออกเอง)', () => {
    const body = docs(build(invoice([line(1)])))[0]!.body;
    const json = JSON.stringify(body);
    for (const k of [
      'amount',
      'discount',
      'vatType',
      'vatAmount',
      'whtRate',
      'totals',
      'sync',
      'voucherNo',
      'transactionNo',
      'taxEstimated',
    ])
      expect(json).not.toContain(`"${k}"`);
  });

  it('property: เอกสารสุ่ม 200 ใบ — ทุก key อยู่ใน whitelist, ผ่าน schema, ตัวเลขไม่เพี้ยน', () => {
    let seed = 20261122;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const head = new Set<string>(KRS_INVOICE_HEADER_FIELDS);
    const lineKeys = new Set<string>(KRS_INVOICE_LINE_FIELDS);
    for (let k = 0; k < 200; k++) {
      const n = 1 + Math.floor(rnd() * 12);
      const lines = range(n).map((i) => {
        const quantity = pick(['1', '1.0000', '0.5', '12.3456', '1000', '99999.9999', '-1']);
        const unitPrice = pick(['0.00', '350.00', '6500.00', '0.01', '123456789.99', '1999.50']);
        return line(i, {
          quantity,
          unitPrice,
          amount: new Prisma.Decimal(quantity).mul(unitPrice).toFixed(2),
          description: pick(['', 'ค่าขนส่ง', 'รอบ "พิเศษ"\nบรรทัดสอง', '🚚 ด่วน']),
          accountCode: pick([null, '4100-01']),
          serviceItem: { id: 's', code: 'FREIGHT', externalId: pick([null, 'IT-FRT', undefined]) },
          trip: {
            number: null,
            vehiclePlate: pick(['70-1234', '1กข 1234']),
            driverName: pick(['สมชาย', 'A. Driver']),
            carrierName: pick([null, 'หจก. ตัวอย่างรถร่วม']),
          },
        });
      });
      const doc = invoice(lines, { dueDate: pick(['2026-12-30', '2027-02-28']) });
      for (const d of docs(build(doc))) {
        expect(schemaOk(d.body)).toBe(true);
        for (const key of Object.keys(d.body)) expect(head.has(key), key).toBe(true);
        const wire = JSON.parse(JSON.stringify(d.body)) as typeof d.body;
        d.body.lines.forEach((l, i) => {
          for (const key of Object.keys(l)) expect(lineKeys.has(key), key).toBe(true);
          const src = lines.find((x) => x.lineNo === l.lineId)!;
          // เงิน/จำนวน: ค่าที่ KRS อ่านจาก JSON = ค่าใน canonical ทุกหลัก (ไม่มี float drift)
          expect(new Prisma.Decimal(String(wire.lines[i]!.mainQuantity)).eq(src.quantity)).toBe(
            true,
          );
          expect(new Prisma.Decimal(String(wire.lines[i]!.unitPrice)).eq(src.unitPrice)).toBe(true);
          expect(Number.isInteger(l.lineId)).toBe(true);
        });
      }
    }
  });
});

describe('KRS payload builder — ใบ 446 รายการ (เกณฑ์ตรวจรับ)', () => {
  let mock: MockKrs;
  beforeAll(async () => {
    mock = await startMockKrs({ apiKey: 'k' });
  });
  afterAll(async () => {
    await mock.stop();
  });
  const post = (body: unknown) =>
    fetch(`${mock.apiBaseUrl}/invoice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'k' },
      body: JSON.stringify(body),
    });

  it('สร้าง payload ใบเดียว ผ่าน schema ของ contract และ mock KRS รับ (201)', async () => {
    const doc = invoice(range(446).map((n) => line(n)));
    const out = docs(build(doc));
    expect(out).toHaveLength(1);
    const d = out[0]!;
    expect(schemaOk(d.body)).toBe(true);
    expect(d).toMatchObject({ part: 1, parts: 1, tmsVoucherNo: 'INV-00000-2611-0001' });
    expect(d.body.lines).toHaveLength(446);
    expect(d.lineNos).toEqual(range(446));
    expect(d.bytes).toBe(Buffer.byteLength(JSON.stringify(d.body), 'utf8'));
    expect(d.bytes).toBeLessThan(KRS_MAX_PAYLOAD_BYTES);
    expect(d.expectedAmount).toBe(doc.totals.total);
    // หัวเอกสารตาม A.3
    expect(d.body).toMatchObject({
      tmsVoucherNo: doc.number,
      voucherDate: '2026-11-30',
      dueDate: '2026-12-30',
      paymentInDay: 30,
      custOrSuppCode: 'PP-C0001',
      custOrSuppName: 'บริษัท ตัวอย่างลูกค้า จำกัด',
      address: '1 ถนนตัวอย่าง แขวงตัวอย่าง กรุงเทพฯ 10110', // บรรทัดเดียว
      deliveryAddress: '1 ถนนตัวอย่าง แขวงตัวอย่าง กรุงเทพฯ 10110',
      salePerson: 'S01', // รหัสตามผัง (ค่าตั้งพิมพ์เล็ก)
      saleName: 'ฝ่ายขาย ตัวอย่าง',
      entryBy: 'TMS',
    });
    // รายการ: 1 รายการ = 1 DO · หน่วยเป็นรหัสตามผัง (ตัน → TON หาด้วยชื่อ)
    expect(d.body.lines[0]).toEqual({
      lineId: 1,
      mainQuantity: 12.5,
      mainUnits: 'TON',
      unitPrice: 350,
      flowNo: 'DO-2611-00001',
      flowDate: '2026-11-02',
      carId: '70-1001',
      carPerson: 'สมหญิง ตัวอย่าง',
      frWay: 'โรงงานตัวอย่าง ระยอง',
      toWay: 'ศูนย์กระจายสินค้าวังน้อย',
      itemCode: 'IT-FRT',
      description: 'ค่าขนส่ง โรงงานตัวอย่าง ระยอง – ศูนย์กระจายสินค้าวังน้อย (1)',
    });
    // ใบผสม: หลายเส้นทาง/คนขับ · ค่าบริการเสริมใช้ DO เดียวกับรายการก่อนหน้า → `flowNo` ซ้ำในใบ (ไม่รวมรายการ)
    const flowNos = d.body.lines.map((l) => l.flowNo);
    expect(new Set(flowNos).size).toBeLessThan(flowNos.length);
    expect(d.body.lines[4]).toMatchObject({
      lineId: 5,
      flowNo: 'DO-2611-00004',
      itemCode: 'IT-WAIT',
    });
    expect(new Set(d.body.lines.map((l) => l.frWay)).size).toBe(4);
    expect(new Set(d.body.lines.map((l) => l.carPerson)).size).toBe(4);
    // ยอดต่อรายการที่เก็บไว้เทียบ (ST8-T10 จับคู่ด้วย lineId + flowNo เพราะ flowNo ซ้ำได้) — ไม่อยู่ใน body
    expect(d.expectedLines).toHaveLength(446);
    expect(d.expectedLines.slice(3, 5)).toEqual([
      { lineId: 4, flowNo: 'DO-2611-00004', amount: '4375.00' },
      { lineId: 5, flowNo: 'DO-2611-00004', amount: '500.00' },
    ]);
    expect(
      d.expectedLines.reduce((t, l) => t.plus(l.amount), new Prisma.Decimal(0)).toFixed(2),
    ).toBe(d.expectedAmount);

    const res = await post(d.body);
    expect(res.status).toBe(201);
    // field นอก whitelist → KRS (mock) ตอบ 400
    expect((await post({ ...d.body, tmsVoucherNo: 'X-2', totalAmount: 1 })).status).toBe(400);
  });

  it('สร้างซ้ำได้ผลเดิมทุกไบต์ (deterministic)', () => {
    const doc = invoice(range(446).map((n) => line(n)));
    expect(JSON.stringify(docs(build(doc)))).toBe(JSON.stringify(docs(build(doc))));
  });
});

describe('KRS payload builder — รูปแบบค่า', () => {
  it('วันที่ต้องเป็น YYYY-MM-DD ที่มีจริง · ไม่มีวันครบกำหนด = สร้างไม่ได้', () => {
    expect(isKrsDate('2026-11-30')).toBe(true);
    expect(isKrsDate('2028-02-29')).toBe(true);
    for (const v of ['2026-02-30', '2026-13-01', '30/11/2026', '2026-11-30T00:00:00Z', '', null])
      expect(isKrsDate(v), String(v)).toBe(false);

    expect(codes(build(invoice([line(1)], { issueDate: '2026-02-30' })))).toEqual([
      'voucherDate:invalid_format',
    ]);
    expect(codes(build(invoice([line(1)], { dueDate: null })))).toEqual(['dueDate:required']);
    const badDo = line(1, { deliveryOrder: { id: 'd', number: 'DO-1', date: '3 พ.ย. 2569' } });
    expect(codes(build(invoice([badDo])))).toEqual(['lines[0].flowDate:invalid_format']);
  });

  it('lineId เป็น int จาก lineNo · เลขบรรทัดไม่ใช่จำนวนเต็ม/ซ้ำ = สร้างไม่ได้', () => {
    const out = docs(build(invoice([line(7), line(9)])));
    expect(out[0]!.body.lines.map((l) => l.lineId)).toEqual([7, 9]);
    expect(codes(build(invoice([line(1, { lineNo: 1.5 })])))).toEqual([
      'lines[0].lineId:invalid_format',
    ]);
    expect(codes(build(invoice([line(2), line(2)])))).toEqual(['lines[1].lineId:duplicate']);
  });

  it('ตัวเลข: แปลงจากสตริงทศนิยมแบบไม่เพี้ยน — เพี้ยน/ผิดรูป = ไม่ส่ง (ไม่ปัด)', () => {
    expect(krsNumber('350.0000')).toBe(350);
    expect(krsNumber('0.10')).toBe(0.1);
    expect(krsNumber('-0.00')).toBe(0);
    expect(krsNumber('0012.50')).toBe(12.5);
    expect(krsNumber('999999999999.99')).toBe(999999999999.99); // numeric(14,2) สูงสุด
    expect(krsNumber('99999999999999.9999')).toBeNull(); // 18 หลัก — เกิน double
    expect(krsNumber('0.1234567890123456789')).toBeNull();
    for (const v of ['1e3', '1,000', 'abc', '', ' 1', 1 as unknown, null])
      expect(krsNumber(v)).toBeNull();
    // ค่าที่ผ่าน: JSON → Decimal ได้ค่าเดิม
    for (const v of ['0.1', '0.3', '1.005', '123456789012.3456', '6500.00', '0.0001'])
      expect(new Prisma.Decimal(JSON.stringify(krsNumber(v))).eq(v), v).toBe(true);

    expect(codes(build(invoice([line(1, { quantity: '99999999999999.9999' })])))).toEqual([
      'lines[0].mainQuantity:number_not_exact',
    ]);
    expect(codes(build(invoice([line(1, { unitPrice: '12,000.00' })])))).toEqual([
      'lines[0].unitPrice:invalid_format',
    ]);
  });

  it('ช่องบังคับของ KRS ที่ canonical ไม่มีค่า → บอกทุกช่อง ไม่แต่งค่า', () => {
    const l = line(1, {
      trip: { number: 'T', vehiclePlate: null, driverName: ' ', carrierName: 'รถร่วม ก' },
      route: { originName: '', destinationName: 'ปลายทาง' },
    });
    const r = failure(build(invoice([l], { number: '' })));
    expect(r.problem.code).toBe(KRS_PAYLOAD_INVALID);
    expect(codes(r)).toEqual([
      'tmsVoucherNo:required',
      'lines[0].carId:required',
      'lines[0].carPerson:required',
      'lines[0].frWay:required',
    ]);
    expect(codes(build(invoice([])))).toEqual(['lines:required']);
    const noTerm = invoice([line(1)]);
    (noTerm.customer as { paymentTermDays: unknown }).paymentTermDays = '30';
    expect(codes(build(noTerm))).toEqual(['paymentInDay:invalid_format']);
  });

  it('ช่องไม่บังคับ (itemCode / description / accountCode) ไม่มีค่า = ไม่มี key', () => {
    const l = line(1, {
      serviceItem: { id: 's', code: 'FREIGHT', externalId: null },
      description: '  ',
      accountCode: null,
    });
    const body = docs(build(invoice([l])))[0]!.body;
    expect(Object.keys(body.lines[0]!).sort()).toEqual(
      [...SCHEMA.properties.lines.items.required].sort().concat('lineId').sort(),
    );
    expect(schemaOk(body)).toBe(true);
    // accountCode ที่ยังไม่ได้ตรวจกับผัง ACCOUNT (ยังไม่นำเข้าผัง) = ไม่ส่ง key — ให้ KRS ใช้ค่าตั้งต้น (A.3)
    const acc = invoice([line(1, { accountCode: '4100-01' })]);
    const noCatalogue = docs(build(acc))[0]!.body;
    expect('accountCode' in noCatalogue.lines[0]!).toBe(false);
    expect(schemaOk(noCatalogue)).toBe(true);
    // นำเข้าผัง ACCOUNT แล้วและค่าอยู่ในผัง = ส่งรหัสตามผัง
    const withCatalogue = { ...CATALOGUE, ACCOUNT: [{ code: '4100-01', name: 'รายได้ค่าขนส่ง' }] };
    expect(
      docs(buildKrsInvoicePayload(gate(acc, CONFIG, withCatalogue), acc))[0]!.body.lines[0]!
        .accountCode,
    ).toBe('4100-01');
  });
});

describe('KRS payload builder — รหัส master (ST8-T06 → builder)', () => {
  it('ค่าที่ไม่ผ่านผังรหัส → สร้างไม่ได้ พร้อมรายการรหัสที่ขาด (รวมค่าเดียวกันหลายบรรทัด)', () => {
    const doc = invoice([
      line(1, { unitLabel: 'ชั่วโมง' }),
      line(2, { unitLabel: 'ชั่วโมง' }),
      line(3, { unitLabel: 'พาเลท' }),
      line(4),
    ]);
    doc.customer.externalId = null;
    const r = failure(buildKrsInvoicePayload(gate(doc, {}), doc));
    expect(r.missingMasterCodes).toEqual([
      { kind: 'CUSTOMER', value: null, fields: ['custOrSuppCode'] },
      { kind: 'SALESPERSON', value: null, fields: ['salePerson'] },
      { kind: 'UNIT', value: 'ชั่วโมง', fields: ['lines[0].mainUnits', 'lines[1].mainUnits'] },
      { kind: 'UNIT', value: 'พาเลท', fields: ['lines[2].mainUnits'] },
    ]);
    expect(codes(r)).toEqual([
      'custOrSuppCode:master_code_unresolved',
      'salePerson:master_code_unresolved',
      'lines[0].mainUnits:master_code_unresolved',
      'lines[2].mainUnits:master_code_unresolved',
    ]);
    expect(r.problem.fields![2]!.message).toContain('ชั่วโมง');
  });

  it('itemCode / accountCode: มีผังแล้วค่าไม่อยู่ในผัง = ขาด · ยังไม่มีผัง: itemCode ส่งค่าจาก mapping, accountCode ไม่ส่ง', () => {
    const doc = invoice([line(1, { accountCode: '9999' })]);
    const strict: Catalogue = {
      ...CATALOGUE,
      ITEM: [{ code: 'IT-OTHER', name: null }],
      ACCOUNT: [{ code: '4100-01', name: null }],
    };
    const r = failure(buildKrsInvoicePayload(gate(doc, CONFIG, strict), doc));
    expect(r.missingMasterCodes).toEqual([
      { kind: 'ITEM', value: 'IT-FRT', fields: ['lines[0].itemCode'] },
      { kind: 'ACCOUNT', value: '9999', fields: ['lines[0].accountCode'] },
    ]);
    const raw = docs(build(doc))[0]!.body.lines[0]!;
    expect(raw.itemCode).toBe('IT-FRT');
    expect('accountCode' in raw).toBe(false);
  });

  it('ไม่มีผลตรวจจาก core เลย (ctx.masterCodes ว่าง) = ไม่ส่งรหัสที่ไม่ได้ตรวจ', () => {
    const doc = invoice([line(1)]);
    const r = failure(buildKrsInvoicePayload({ config: CONFIG }, doc));
    expect(r.missingMasterCodes.map((m) => m.kind)).toEqual([
      'CUSTOMER',
      'SALESPERSON',
      'UNIT',
      'ITEM',
    ]);
  });
});

describe('KRS payload builder — แบ่งใบเมื่อเกินเพดานขนาด', () => {
  const many = (n: number) => invoice(range(n).map((i) => line(i)));
  const flat = (out: KrsInvoiceDocument[]) => out.flatMap((d) => d.lineNos);

  it('จุดตัดคงที่ + รายการต่อเนื่อง ไม่ซ้ำ ไม่หาย · ทุกใบผ่าน schema และไม่เกินเพดาน', () => {
    const doc = many(446);
    const maxBytes = 20_000;
    const out = docs(build(doc, { maxBytes }));
    expect(out.length).toBeGreaterThan(5);
    expect(flat(out)).toEqual(range(446));
    expect(JSON.stringify(docs(build(doc, { maxBytes })))).toBe(JSON.stringify(out));
    const one = docs(build(doc))[0]!;
    out.forEach((d, i) => {
      expect(schemaOk(d.body)).toBe(true);
      expect(d.bytes).toBe(Buffer.byteLength(JSON.stringify(d.body), 'utf8'));
      expect(d.bytes).toBeLessThanOrEqual(maxBytes);
      expect(d).toMatchObject({ part: i + 1, parts: out.length });
      expect(d.body.lines.map((l) => l.lineId)).toEqual(d.lineNos); // lineId = เลขบรรทัดเดิม
      // หัวเอกสารซ้ำทุกใบ ต่างแค่เลข
      expect({ ...d.body, lines: [], tmsVoucherNo: '' }).toEqual({
        ...one.body,
        lines: [],
        tmsVoucherNo: '',
      });
      // เติมเต็มที่: รายการแรกของใบถัดไปใส่ใบนี้ไม่ได้แล้ว
      const next = out[i + 1]?.body.lines[0];
      if (next)
        expect(
          Buffer.byteLength(JSON.stringify({ ...d.body, lines: [...d.body.lines, next] }), 'utf8'),
        ).toBeGreaterThan(maxBytes);
    });
    // เลขเอกสาร: ใบแรก = เลขเดิม · ใบถัดไปต่อท้ายลำดับใบ (ไม่ซ้ำ — KRS 409 ถ้าซ้ำ)
    expect(out.slice(0, 3).map((d) => d.tmsVoucherNo)).toEqual([
      'INV-00000-2611-0001',
      'INV-00000-2611-0001-P2',
      'INV-00000-2611-0001-P3',
    ]);
    // ผลรวมยอดที่เก็บไว้เทียบ = ยอดทั้งใบ
    expect(out.reduce((s, d) => s.plus(d.expectedAmount), new Prisma.Decimal(0)).toFixed(2)).toBe(
      doc.totals.total,
    );
  });

  it('เพิ่มรายการท้ายใบ: ใบก่อนหน้าคงเดิม (เลขเอกสาร + รายการ)', () => {
    const maxBytes = 20_000;
    const a = docs(build(many(300), { maxBytes }));
    const b = docs(build(many(446), { maxBytes }));
    const strip = (d: KrsInvoiceDocument) => ({ no: d.tmsVoucherNo, body: d.body });
    expect(b.slice(0, a.length - 1).map(strip)).toEqual(a.slice(0, -1).map(strip));
  });

  it('ตัวเลือก renumber: lineId เริ่ม 1 ใหม่ทุกใบ และยังไม่เกินเพดาน · เลขเอกสารกำหนดเองได้', () => {
    const maxBytes = 20_000;
    const out = docs(
      build(many(446), {
        maxBytes,
        splitLineId: 'renumber',
        splitVoucherNo: (no, part) => `${no}/${part}`,
      }),
    );
    expect(flat(out)).toEqual(range(446));
    for (const d of out) {
      expect(d.body.lines.map((l) => l.lineId)).toEqual(range(d.body.lines.length));
      expect(d.bytes).toBeLessThanOrEqual(maxBytes);
      expect(schemaOk(d.body)).toBe(true);
    }
    expect(out[1]!.tmsVoucherNo).toBe('INV-00000-2611-0001/2');
    // เลขของใบที่แบ่งซ้ำกัน = ไม่ส่ง
    expect(codes(build(many(446), { maxBytes, splitVoucherNo: (no) => no }))).toEqual([
      'tmsVoucherNo:duplicate',
    ]);
  });

  it('รายการเดียวใหญ่เกินเพดาน = สร้างไม่ได้ (ไม่ตัดข้อความ)', () => {
    const big = line(2, { description: 'ก'.repeat(5000) });
    expect(codes(build(invoice([line(1), big]), { maxBytes: 4000 }))).toEqual([
      'lines[1]:krs_payload_too_large',
    ]);
  });

  it('เกิน 50 MB จริง (ค่าเริ่มต้น) → 2 ใบ แต่ละใบ ≤ เพดาน', () => {
    expect(KRS_PAYLOAD_DEFAULTS.maxBytes).toBe(50_000_000);
    const text = 'x'.repeat(100_000);
    const doc = invoice(range(600).map((i) => line(i, { description: text })));
    const out = docs(build(doc));
    expect(out).toHaveLength(2);
    expect(flat(out)).toEqual(range(600));
    for (const d of out) expect(d.bytes).toBeLessThanOrEqual(KRS_MAX_PAYLOAD_BYTES);
    expect(out[0]!.bytes + 100_000).toBeGreaterThan(KRS_MAX_PAYLOAD_BYTES);
    expect(out.map((d) => d.tmsVoucherNo)).toEqual([doc.number, `${doc.number}-P2`]);
  });
});

describe('KRS payload builder — จุดที่สัญญาไม่กำหนด [OPEN — KRS] (ค่าเริ่ม = ทางระมัดระวัง, ตั้งค่าได้)', () => {
  const noDo = () => line(2, { deliveryOrder: null, salesOrder: null, trip: null, route: null });

  it('รายการไม่ผูก DO: ค่าเริ่ม = ไม่สร้าง · placeholder = ใส่ค่าที่ตั้งไว้', () => {
    const doc = invoice([line(1), noDo()]);
    expect(codes(build(doc))).toEqual(['lines[1].flowNo:krs_line_without_do']);
    const body = docs(build(doc, { lineWithoutDo: 'placeholder', placeholderText: 'N/A' }))[0]!
      .body;
    expect(schemaOk(body)).toBe(true);
    expect(body.lines[1]).toMatchObject({
      flowNo: 'N/A',
      flowDate: '2026-11-30',
      carId: 'N/A',
      carPerson: 'N/A',
      frWay: 'N/A',
      toWay: 'N/A',
    });
  });

  it('ส่วนลด: ค่าเริ่ม = ไม่สร้าง · net-unit-price = ราคาหลังส่วนลดเฉพาะเมื่อหารลงตัว', () => {
    const disc = line(1, {
      quantity: '4',
      unitPrice: '100.00',
      discount: '40.00',
      amount: '360.00',
    });
    expect(codes(build(invoice([disc])))).toEqual(['lines[0].discount:krs_discount_unsupported']);
    const net = docs(build(invoice([disc]), { discount: 'net-unit-price' }))[0]!;
    expect(net.body.lines[0]).toMatchObject({ mainQuantity: 4, unitPrice: 90 });
    expect(net.expectedAmount).toBe('360.00');
    // หารไม่ลงตัว (100 ÷ 3) → ไม่สร้าง ไม่ปัด
    const odd = line(1, { quantity: '3', unitPrice: '40.00', discount: '20.00', amount: '100.00' });
    expect(codes(build(invoice([odd]), { discount: 'net-unit-price' }))).toEqual([
      'lines[0].discount:krs_discount_unsupported',
    ]);
  });

  it('คนขับว่าง (รถร่วม): ค่าเริ่ม = ไม่สร้าง · carrierName = ใช้ชื่อรถร่วม', () => {
    const l = line(1, {
      trip: { number: 'T', vehiclePlate: '70-1', driverName: null, carrierName: 'หจก. รถร่วม ก' },
    });
    expect(codes(build(invoice([l])))).toEqual(['lines[0].carPerson:required']);
    expect(
      docs(build(invoice([l]), { carPersonFallback: 'carrierName' }))[0]!.body.lines[0]!.carPerson,
    ).toBe('หจก. รถร่วม ก');
  });

  it('ทะเบียนรถว่าง (รถร่วมยังไม่ระบุรถ): ค่าเริ่ม = ไม่สร้าง · placeholder = ใส่ค่าที่ตั้งไว้', () => {
    const l = line(1, {
      trip: { number: 'T', vehiclePlate: null, driverName: 'สมชาย', carrierName: 'หจก. รถร่วม ก' },
    });
    expect(codes(build(invoice([l])))).toEqual(['lines[0].carId:required']);
    const body = docs(build(invoice([l]), { carIdFallback: 'placeholder' }))[0]!.body;
    expect(body.lines[0]!.carId).toBe('-');
    expect(schemaOk(body)).toBe(true);
  });

  it('deliveryAddress / entryBy / tmsVoucherNo ตั้งค่าได้ · ไม่มีที่อยู่ = สตริงว่าง (contract รับ)', () => {
    const doc = invoice([line(1)]);
    const body = docs(
      build(doc, { deliveryAddress: 'empty', entryBy: 'acc01', tmsVoucherNo: 'INV-1-EX' }),
    )[0]!.body;
    expect(body).toMatchObject({ deliveryAddress: '', entryBy: 'acc01', tmsVoucherNo: 'INV-1-EX' });
    doc.customer.billingAddress = null;
    const none = docs(build(doc))[0]!.body;
    expect(none).toMatchObject({ address: '', deliveryAddress: '' });
    expect(schemaOk(none)).toBe(true);
    expect(codes(build(doc, { entryBy: ' ' }))).toEqual(['entryBy:required']);
  });

  it('ไม่แยกใบตาม vat_type ที่ builder (งานของ ST8-T08) — รายการต่าง vat_type อยู่ใบเดียว', () => {
    const doc = invoice([line(1), line(2, { vatType: 'VAT_7', vatAmount: '455.00' })]);
    const out = docs(build(doc));
    expect(out).toHaveLength(1);
    expect(out[0]!.lineNos).toEqual([1, 2]);
  });
});

describe('canonical invoice — ช่องที่เพิ่มใน ST8-T07 (docs/01 §7.1–7.2)', () => {
  const D = (v: string) => new Prisma.Decimal(v);
  const row = (): InvoiceForCanonical =>
    ({
      id: 'inv-1',
      tenantId: 't',
      invoiceNo: 'INV-00000-2611-0009',
      issueDate: new Date('2026-11-30T00:00:00.000Z'),
      dueDate: new Date('2026-12-30T00:00:00.000Z'),
      issuingCompanyId: 'co',
      issuingBranchId: 'br',
      customerId: 'cus',
      creditTermDays: 30,
      customerPoNo: 'PO-1',
      customerSnapshot: {
        code: 'C-1',
        name: 'บริษัท ตัวอย่างลูกค้า จำกัด',
        taxId: '0105555000001',
        branchCode: '00000',
        address: '1 ถนนตัวอย่าง กรุงเทพฯ',
      },
      issuerSnapshot: {
        name: 'บริษัท ตัวอย่างผู้ออกบิล จำกัด (ณ วันออก)',
        taxId: '0105555000009',
        branchCode: '00000',
        address: '9 ถนนตัวอย่าง กรุงเทพฯ',
      },
      subtotalVatable: D('0'),
      subtotalExempt: D('6500'),
      subtotalZeroRated: D('0'),
      vatAmount: D('0'),
      totalAmount: D('6500'),
      whtExpectedAmount: D('65'),
      customer: { code: 'C-1', legalName: 'ชื่อปัจจุบัน' },
      issuingBranch: { branchCode: '00000' },
      issuingCompany: { legalName: 'ชื่อบริษัทปัจจุบัน', taxId: '0105555000009' },
      lines: [
        {
          lineNo: 1,
          serviceItemId: 'si',
          serviceItem: { code: 'FREIGHT' },
          description: 'ค่าขนส่ง',
          quantity: D('1'),
          unitLabel: 'เที่ยว',
          unitPrice: D('6500'),
          discount: D('0'),
          amount: D('6500'),
          vatType: 'EXEMPT_TRANSPORT',
          vatAmount: D('0'),
          whtRate: D('1'),
          accountCode: '4100-01',
          deliveryOrder: {
            id: 'do-1',
            doNo: 'DO-2611-00042',
            doDate: new Date('2026-11-03T00:00:00.000Z'),
            customerRef: 'REF-A',
            salesOrder: { soNo: 'SO-2611-00007', externalId: 'KRS-NSF-SO1' },
            trip: {
              tripNo: 'TR-2611-00003',
              vehiclePlateSnapshot: '70-1234',
              driverNameSnapshot: 'สมชาย ตัวอย่าง',
              carrierNameSnapshot: null,
            },
            originSite: { name: 'คลังบางนา' },
            destSite: { name: 'ท่าเรือแหลมฉบัง' },
          },
        },
        {
          lineNo: 2,
          serviceItemId: 'si2',
          serviceItem: { code: 'WAIT' },
          description: 'ค่ารอ',
          quantity: D('2'),
          unitLabel: 'ชั่วโมง',
          unitPrice: D('0'),
          discount: D('0'),
          amount: D('0'),
          vatType: 'VAT_7',
          vatAmount: D('0'),
          whtRate: D('3'),
          accountCode: null,
          deliveryOrder: null,
        },
      ],
    }) as unknown as InvoiceForCanonical;

  it('issuer / ลูกค้า / references / DO / SO / เที่ยว / เส้นทาง / รหัสค่าบริการ / รหัสบัญชี', () => {
    const c = canonicalInvoice(row(), 'PP-C1', ['trip.driverName']);
    expect(c.issuer).toEqual({
      companyId: 'co',
      branchId: 'br',
      branchCode: '00000',
      legalName: 'บริษัท ตัวอย่างผู้ออกบิล จำกัด (ณ วันออก)', // snapshot ณ วันออก ไม่ใช่ชื่อปัจจุบัน
      taxId: '0105555000009',
      address: '9 ถนนตัวอย่าง กรุงเทพฯ',
    });
    expect(c.customer).toMatchObject({
      externalId: 'PP-C1',
      billingAddress: '1 ถนนตัวอย่าง กรุงเทพฯ',
      paymentTermDays: 30,
    });
    expect(c.references).toEqual({ customerRef: ['REF-A'] });
    expect(c.lines[0]).toMatchObject({
      deliveryOrder: { id: 'do-1', number: 'DO-2611-00042', date: '2026-11-03' },
      salesOrder: { number: 'SO-2611-00007', externalId: 'KRS-NSF-SO1' },
      trip: {
        number: 'TR-2611-00003',
        vehiclePlate: '70-1234',
        driverName: 'สมชาย ตัวอย่าง',
        carrierName: null,
      },
      route: { originName: 'คลังบางนา', destinationName: 'ท่าเรือแหลมฉบัง' },
      serviceItem: { id: 'si', code: 'FREIGHT' },
      accountCode: '4100-01',
    });
    expect(c.lines[1]).toMatchObject({
      deliveryOrder: null,
      salesOrder: null,
      trip: null,
      route: null,
      accountCode: null,
    });
  });

  it('PDPA: ชื่อคนขับลง canonical เฉพาะเมื่อ adapter ประกาศว่าต้องใช้ (KRS ประกาศ — สัญญาบังคับ carPerson)', () => {
    const plain = canonicalInvoice(row(), 'PP-C1');
    expect(plain.lines[0]!.trip).toEqual({
      number: 'TR-2611-00003',
      vehiclePlate: '70-1234',
      driverName: null,
      carrierName: null,
    });
    expect(JSON.stringify(plain)).not.toContain('สมชาย');
    const krs = new KrsAdapter();
    expect(krs.personalDataNeeds).toEqual(['trip.driverName']);
    expect(canonicalInvoice(row(), 'PP-C1', krs.personalDataNeeds).lines[0]!.trip!.driverName).toBe(
      'สมชาย ตัวอย่าง',
    );
    const others: ErpAdapter[] = [new AccountSystemAdapter(), new DemoAdapter()];
    for (const o of others) expect(o.personalDataNeeds).toBeUndefined();
  });

  it('ช่องใหม่อยู่ใน sync.hash (ค่าเปลี่ยน = hash เปลี่ยน) และ canonical → payload KRS ได้ตรง A.3', () => {
    const need = ['trip.driverName'] as const;
    const a = canonicalInvoice(row(), 'PP-C1', need);
    const changed = row();
    (
      changed.lines[0]!.deliveryOrder as { trip: { vehiclePlateSnapshot: string } }
    ).trip.vehiclePlateSnapshot = '70-9999';
    expect(canonicalInvoice(changed, 'PP-C1', need).sync!.hash).not.toBe(a.sync!.hash);
    expect(canonicalInvoice(row(), 'PP-C1', need).sync!.hash).toBe(a.sync!.hash);

    const one = { ...a, lines: [a.lines[0]!] } as CanonicalInvoicePayload;
    const body = docs(buildKrsInvoicePayload(gate(one), one))[0]!.body;
    expect(schemaOk(body)).toBe(true);
    expect(body).toMatchObject({
      tmsVoucherNo: 'INV-00000-2611-0009',
      voucherDate: '2026-11-30',
      dueDate: '2026-12-30',
      paymentInDay: 30,
      custOrSuppCode: 'PP-C1',
      address: '1 ถนนตัวอย่าง กรุงเทพฯ',
    });
    expect(body.lines[0]).toEqual({
      lineId: 1,
      mainQuantity: 1,
      mainUnits: 'เที่ยว',
      unitPrice: 6500,
      flowNo: 'DO-2611-00042',
      flowDate: '2026-11-03',
      carId: '70-1234',
      carPerson: 'สมชาย ตัวอย่าง',
      frWay: 'คลังบางนา',
      toWay: 'ท่าเรือแหลมฉบัง',
      description: 'ค่าขนส่ง',
    });
  });
});
