import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { JobQueue } from '../src/jobs/job-queue.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SAMPLES = resolve(__dirname, 'fixtures/imports');
const sample = (name: string) => readFileSync(resolve(SAMPLES, name));

async function xlsxOf(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('a');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
/** ไฟล์ตัวอย่าง .csv → .xlsx (ทดสอบทั้งสองรูปแบบ) */
async function csvToXlsx(buf: Buffer): Promise<Buffer> {
  const rows = buf
    .toString('utf8')
    .trim()
    .split('\n')
    .map((l) =>
      l.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '')),
    );
  return xlsxOf(rows.map((r) => r.slice(0, -1)));
}

const binary = (t: request.Test) =>
  t.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

type Api = ReturnType<typeof api>;
interface Issue {
  row: number;
  column?: string;
  value?: string;
  code: string;
  message: string;
  severity: string;
}

/** ST2-T23: นำเข้า Excel ทุก master บน framework ST1-T19 — ใช้กฎเดียวกับ API (service ตัวเดียวกัน) */
describe('นำเข้าข้อมูลหลัก (ST2-T23)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tA: string;
  let tB: string;
  let a: Api;
  let b: Api;

  async function upload(x: Api, data: Buffer, mime = XLSX, filename = 'file.xlsx') {
    const r = await x
      .post('/v1/documents')
      .send({ kind: 'IMPORT', mime, bytes: data.length, filename })
      .expect(201);
    const u = new URL(r.body.uploadUrl);
    await request(app.getHttpServer())
      .put(u.pathname + u.search)
      .set('Content-Type', 'application/octet-stream')
      .send(data)
      .expect(200);
    return r.body.id as string;
  }
  /** อัปโหลด + dry-run */
  async function dry(
    x: Api,
    kind: string,
    data: Buffer,
    opts: { mime?: string; mode?: string; errorPolicy?: string; status?: number } = {},
  ) {
    const mime = opts.mime ?? XLSX;
    const doc = await upload(x, data, mime, mime === XLSX ? `${kind}.xlsx` : `${kind}.csv`);
    const r = await x.post('/v1/imports').send({
      kind,
      documentId: doc,
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.errorPolicy ? { errorPolicy: opts.errorPolicy } : {}),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(opts.status ?? 201);
    return r.body;
  }
  const csv = (kind: string, file: string, opts: { mode?: string } = {}) =>
    dry(a, kind, sample(file), { mime: 'text/csv', ...opts });
  async function commit(x: Api, id: string) {
    const r = await x.post(`/v1/imports/${id}/commit`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  }
  const errorsOf = (r: { issues: Issue[] }) => r.issues.filter((i) => i.severity === 'error');
  const rowIssues = (r: { issues: Issue[] }, row: number) => r.issues.filter((i) => i.row === row);

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tA = (await createTenantWithDefaults(db, { name: 'บริษัท เอ ขนส่ง' })).id;
    tB = (await createTenantWithDefaults(db, { name: 'บริษัท บี ขนส่ง' })).id;
    a = api(app, await tokenFor(tA));
    b = api(app, await tokenFor(tB));
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('รายการชนิดที่นำเข้าได้ครบทุก master + template มีหัวไทย ตัวอย่าง และรายการให้เลือก', async () => {
    const kinds = (await a.get('/v1/imports/kinds').expect(200)).body.map(
      (k: { kind: string }) => k.kind,
    );
    expect(kinds).toEqual(
      expect.arrayContaining([
        'customer',
        'customer_site',
        'carrier',
        'vehicle',
        'driver',
        'route',
        'product',
        'service_item',
        'rate_card_sell',
        'rate_card_buy',
      ]),
    );
    for (const k of kinds.filter((x: string) => x !== 'sample')) {
      const t = await binary(a.get(`/v1/imports/kinds/${k}/template`)).expect(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(t.body);
      expect(wb.worksheets[0]!.actualRowCount, k).toBe(1); // sheet ที่ระบบอ่านมีแต่หัวคอลัมน์
      const head = (wb.worksheets[0]!.getRow(1).values as string[]).slice(1);
      for (const h of head) expect(h, k).toMatch(/[฀-๿]|LINE ID|VAT/);
      expect(wb.getWorksheet('ตัวอย่าง')!.actualRowCount, k).toBe(2);
      expect(wb.getWorksheet('คำอธิบาย')).toBeTruthy();
    }
    const t = await binary(a.get('/v1/imports/kinds/customer/template')).expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(t.body);
    const head = wb.worksheets[0]!.getRow(1).values as string[];
    expect(head.slice(1, 6)).toEqual(['รหัส', 'ชื่อ', 'เลขผู้เสียภาษี', 'สาขา', 'เครดิต']);
    expect(wb.getWorksheet('ตัวอย่าง')!.getRow(2).getCell(2).value).toBe('บจก. ตัวอย่างพลาสติก');
    const cycle = head.indexOf('รอบวางบิล');
    expect(wb.worksheets[0]!.getCell(2, cycle).dataValidation).toMatchObject({ type: 'list' });
  });

  // ลำดับ = ข้อมูลที่ถูกอ้างก่อน (ลูกค้า → สถานที่ → ผู้รับเหมา → รถ → คนขับ → เส้นทาง → สินค้า → ค่าบริการ → rate)
  const FLOW: [string, string, () => Promise<number>, boolean][] = [
    ['customer', 'customers.csv', () => db.customer.count({ where: { tenantId: tA } }), false],
    ['customer_site', 'sites.csv', () => db.customerSite.count({ where: { tenantId: tA } }), true],
    ['carrier', 'carriers.csv', () => db.carrier.count({ where: { tenantId: tA } }), false],
    ['vehicle', 'vehicles.csv', () => db.vehicle.count({ where: { tenantId: tA } }), true],
    ['driver', 'drivers.csv', () => db.driver.count({ where: { tenantId: tA } }), false],
    ['route', 'routes.csv', () => db.route.count({ where: { tenantId: tA } }), true],
    ['product', 'products.csv', () => db.product.count({ where: { tenantId: tA } }), false],
    [
      'service_item',
      'service-items.csv',
      () => db.serviceItem.count({ where: { tenantId: tA, systemKey: null } }),
      true,
    ],
    [
      'rate_card_sell',
      'rate-cards-sell.csv',
      () => db.rateCard.count({ where: { tenantId: tA, side: 'SELL' } }),
      false,
    ],
    [
      'rate_card_buy',
      'rate-cards-buy.csv',
      () => db.rateCard.count({ where: { tenantId: tA, side: 'BUY' } }),
      true,
    ],
  ];
  for (const [kind, file, count, asXlsx] of FLOW)
    it(`${kind}: ไฟล์ตัวอย่าง ${file} ผ่าน dry-run (ไม่เขียน) แล้วยืนยันสร้างครบ${asXlsx ? ' (.xlsx)' : ''}`, async () => {
      const before = await count();
      const audits = await db.auditLog.count({ where: { tenantId: tA } });
      const r = asXlsx ? await dry(a, kind, await csvToXlsx(sample(file))) : await csv(kind, file);
      expect(errorsOf(r)).toEqual([]);
      expect(r).toMatchObject({ status: 'validated', errorRows: 0 });
      expect(r.totalRows).toBeGreaterThanOrEqual(2);
      // dry-run: ไม่มีแถวใหม่และไม่มี audit ของ entity (service ทำงานใน savepoint แล้วย้อนทิ้ง)
      expect(await count()).toBe(before);
      expect(await db.auditLog.count({ where: { tenantId: tA } })).toBe(audits);
      const c = await commit(a, r.id);
      expect(c).toMatchObject({ status: 'completed', importedRows: r.totalRows });
      expect(await count()).toBe(before + r.totalRows);
    });

  it('ค่าที่นำเข้าถูกแปลงตามกฎ API: ที่อยู่/ผู้ติดต่อ, ทะเบียน+จังหวัดในช่องเดียว, ปี พ.ศ., ราคา rate เป็นร่าง', async () => {
    const cus = await db.customer.findFirst({ where: { tenantId: tA, code: 'CUS-0102' } });
    expect(cus).toMatchObject({ branchCode: '00001', billingCycle: 'WEEKLY', vatRegistered: true });
    expect(cus!.contacts).toEqual([
      expect.objectContaining({ name: 'คุณสมหญิง ตัวอย่าง', isPrimary: true }),
    ]);
    const site = await db.customerSite.findFirst({ where: { tenantId: tA, code: 'LOC-0102' } });
    expect(site!.customerId).toBe(cus!.id); // อ้างด้วยชื่อที่ตรงตัว
    const v = await db.vehicle.findFirst({ where: { tenantId: tA, plate: '82-4410' } });
    expect(v).toMatchObject({ plateProvince: 'TH-20' });
    const v1 = await db.vehicle.findFirst({ where: { tenantId: tA, plate: '70-7781' } });
    expect(v1).toMatchObject({ plateProvince: 'TH-10', year: 2022, fuelType: 'DIESEL' });
    const rc = await db.rateCard.findMany({ where: { tenantId: tA, side: 'SELL' } });
    expect(rc.every((x) => x.status === 'DRAFT')).toBe(true); // MD-285 นำเข้าเป็นร่างเสมอ
    expect(rc.map((x) => x.unitPrice?.toString()).sort()).toEqual(['12.5', '430', '6700']);
    const route = await db.route.findFirst({ where: { tenantId: tA, code: 'RT-0103' } });
    expect(route!.tollAmount?.toString()).toBe('1000.5');
  });

  it('ข้อมูลอ่อนไหว: เลขบัตร/เลขบัญชีเข้ารหัสเหมือน API · รายงาน/ตัวอย่าง/ไฟล์แถวผิดเห็นแค่ 4 หลักท้าย', async () => {
    const c = await db.carrier.findFirst({ where: { tenantId: tA, code: 'SUB-0101' } });
    expect(c).toMatchObject({ taxId: null, taxIdLast4: '3016', bankAccountLast4: '7890' });
    expect(c!.taxIdEnc).toBeTruthy();
    expect(c!.bankAccountEnc).toBeTruthy();
    const d = await db.driver.findFirst({ where: { tenantId: tA, code: 'DRV-0101' } });
    expect(d).toMatchObject({ nationalIdLast4: '3024' });
    // นำเข้าซ้ำ = เลขบัตรซ้ำ → แถวผิด แต่ไม่มีเลขเต็มในผลตรวจ/ตัวอย่าง/ไฟล์แถวผิด
    const r = await csv('carrier', 'carriers.csv');
    const json = JSON.stringify(r);
    expect(json).not.toContain('1050000003016');
    expect(json).not.toContain('1234567890');
    expect(r.sample[0].values.taxId).toBe('•••• 3016');
    expect(r.sample[0].values.bankAccountNo).toBe('•••• 7890');
    const stored = await db.importJob.findFirst({
      where: { tenantId: tA, id: { not: undefined } },
      orderBy: { createdAt: 'desc' },
    });
    expect(JSON.stringify(stored)).not.toContain('1050000003016');
    const rep = await binary(a.get(`/v1/imports/${r.id}/errors`)).expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(rep.body);
    const cells = JSON.stringify(wb.worksheets[0]!.getSheetValues());
    expect(cells).not.toContain('1050000003016');
    expect(cells).not.toContain('1234567890');
    expect(cells).toContain('•••• 3016');
  });

  it('บัญชีธนาคารต้องมีสิทธิ์ settlements:pay (กฎเดียวกับ API) — ไม่มีสิทธิ์ = แถวผิดพร้อมเหตุผล', async () => {
    const x = api(
      app,
      await tokenFor(tA, 'master:write master:read documents:write documents:read'),
    );
    const r = await dry(
      x,
      'carrier',
      await xlsxOf([
        ['ชื่อ', 'เลขผู้เสียภาษี', 'ประเภท', 'ธนาคาร', 'เลขบัญชี', 'ชื่อบัญชี'],
        [
          'นายไม่มีสิทธิ์ บัญชี',
          validTaxId(9101),
          'บุคคลธรรมดา',
          'SCB',
          '1112223334',
          'นายไม่มีสิทธิ์',
        ],
        ['นายไม่มีบัญชี ทดสอบ', validTaxId(9102), 'บุคคลธรรมดา', '', '', ''],
      ]),
    );
    expect(r.errorRows).toBe(1);
    expect(rowIssues(r, 2)[0]).toMatchObject({ code: 'permission_denied', column: 'ธนาคาร' });
    expect(rowIssues(r, 2)[0]!.message).toContain('settlements:pay');
  });

  it('แถวผิดได้เหตุผลภาษาไทย: ลูกค้า (checksum, ซ้ำในไฟล์/ระบบ, รายการผิด, 12 หลักเติม 0)', async () => {
    const good = validTaxId(77);
    const bad = good.slice(0, 12) + String((Number(good[12]) + 1) % 10);
    const r = await dry(
      a,
      'customer',
      await xlsxOf([
        ['รหัส', 'ชื่อ', 'เลขผู้เสียภาษี', 'รอบวางบิล', 'เครดิต'],
        ['C-1', 'บจก. หนึ่ง', bad, 'รายเดือน', ''],
        ['C-2', 'บจก. สอง', good, 'ทุกวัน', ''],
        ['C-2', 'บจก. สาม', '', '', ''],
        ['CUS-0101', 'บจก. ซ้ำ', '', '', ''],
        ['C-4', 'บจก. สี่', '055600001045', '', ''],
        ['C-5', 'บจก. ห้า', '', '', '400'],
      ]),
    );
    expect(rowIssues(r, 2)[0]).toMatchObject({ column: 'เลขผู้เสียภาษี', code: 'thai_tax_id' });
    expect(rowIssues(r, 3)[0]).toMatchObject({ column: 'รอบวางบิล', code: 'invalid_format' });
    expect(rowIssues(r, 3)[0]!.message).toContain('รายเดือน');
    expect(rowIssues(r, 4)[0]).toMatchObject({ column: 'รหัส', code: 'duplicate_in_file' });
    expect(rowIssues(r, 5)[0]).toMatchObject({ column: 'รหัส', code: 'duplicate_in_db' });
    expect(rowIssues(r, 6)[0]).toMatchObject({
      code: 'leading_zero_restored',
      severity: 'warning',
    });
    expect(rowIssues(r, 7)[0]).toMatchObject({ column: 'เครดิต', code: 'max' });
    expect(rowIssues(r, 7)[0]!.message).toBe('ต้องไม่เกิน 365');
    expect(r.errorRows).toBe(5);
    for (const i of r.issues) expect(i.message).toMatch(/[฀-๿]/);
  });

  it('แถวผิด: สถานที่/ผู้รับเหมา/รถ/คนขับ/เส้นทาง/สินค้า/ค่าบริการ/rate — เหตุผลจากกฎของ service', async () => {
    const site = await dry(
      a,
      'customer_site',
      await xlsxOf([
        ['ชื่อสถานที่', 'ลูกค้า', 'ที่อยู่', 'เวลาเปิด', 'เวลาปิด'],
        ['จุด ก', 'CUS-9999', '1 ถ.ทดสอบ', '', ''],
        ['จุด ข', '', '', '', ''],
        ['จุด ค', '', '2 ถ.ทดสอบ', '08:00', '08:00'],
      ]),
    );
    expect(rowIssues(site, 2)[0]).toMatchObject({ column: 'ลูกค้า', code: 'reference_not_found' });
    expect(rowIssues(site, 2)[0]!.message).toContain('CUS-9999');
    expect(rowIssues(site, 3)[0]).toMatchObject({ column: 'ที่อยู่', code: 'required' });
    expect(rowIssues(site, 4)[0]).toMatchObject({ code: 'same_time' });

    const car = await dry(
      a,
      'carrier',
      await xlsxOf([
        ['ชื่อ', 'เลขผู้เสียภาษี', 'ประเภท', 'สาขา'],
        ['บจก. นิติ', validTaxId(9201), 'นิติบุคคล', ''],
        ['นายบุคคล สาขา', validTaxId(9202), 'บุคคลธรรมดา', '00001'],
      ]),
    );
    expect(rowIssues(car, 2)[0]).toMatchObject({ code: 'juristic_prefix' });
    expect(rowIssues(car, 3)[0]).toMatchObject({ code: 'individual' });

    const veh = await dry(
      a,
      'vehicle',
      await xlsxOf([
        ['ทะเบียน', 'ประเภทรถ', 'เจ้าของ', 'จังหวัด'],
        ['70-7781', '6W', 'บริษัท', 'กทม.'],
        ['ABC', '6W', 'บริษัท', 'กทม.'],
        ['71-1111', 'รถถัง', 'บริษัท', 'กทม.'],
        ['71-2222', '6W', 'รถร่วม', 'กทม.'],
        ['71-3333', '6W', 'บริษัท', 'ดาวอังคาร'],
      ]),
    );
    expect(rowIssues(veh, 2)[0]).toMatchObject({ column: 'ทะเบียน', code: 'duplicate_in_db' });
    expect(rowIssues(veh, 3)[0]).toMatchObject({ code: 'plate_format' });
    expect(rowIssues(veh, 4)[0]).toMatchObject({ column: 'ประเภทรถ', code: 'reference_not_found' });
    expect(rowIssues(veh, 5)[0]).toMatchObject({ column: 'ผู้รับเหมา', code: 'required' });
    expect(rowIssues(veh, 6)[0]).toMatchObject({ column: 'จังหวัด', code: 'invalid_format' });

    const drv = await dry(
      a,
      'driver',
      await xlsxOf([
        ['ชื่อ', 'เบอร์', 'ประเภท', 'ใบขับขี่', 'หมดอายุ', 'เลขบัตรประชาชน'],
        ['นายเบอร์ซ้ำ', '0891234567', 'รายเที่ยว', 'ท.2', '31/12/2570', ''],
        ['นายวันผิด', '0899999999', 'รายเที่ยว', 'ท.2', '31/02/2570', ''],
        ['นายรถร่วม', '0899999998', 'รถร่วม', 'ท.2', '31/12/2570', ''],
        ['นายบัตรผิด', '0899999997', 'รายเที่ยว', 'ท.9', '31/12/2570', '1234567890123'],
      ]),
    );
    expect(rowIssues(drv, 2)[0]).toMatchObject({ code: 'duplicate_in_db' });
    expect(rowIssues(drv, 3)[0]).toMatchObject({ column: 'หมดอายุ', code: 'invalid_format' });
    expect(rowIssues(drv, 4)[0]).toMatchObject({ column: 'ผู้รับเหมา', code: 'carrier_required' });
    expect(rowIssues(drv, 5).map((i) => i.column)).toContain('ใบขับขี่');
    expect(JSON.stringify(drv)).not.toContain('1234567890123');

    const rte = await dry(
      a,
      'route',
      await xlsxOf([
        ['ต้นทาง', 'ปลายทาง', 'ระยะทาง (กม.)'],
        ['LOC-0101', 'LOC-0102', '90'],
        ['LOC-0102', 'LOC-0102', '10'],
        ['LOC-0103', 'LOC-0101', 'ไกล'],
        ['LOC-0103', 'LOC-0101', '55'],
        ['LOC-0103', 'LOC-0101', '56'],
      ]),
    );
    expect(rowIssues(rte, 2)[0]).toMatchObject({ code: 'duplicate_in_db' }); // คู่ OD เดิม
    expect(rowIssues(rte, 3)[0]).toMatchObject({ code: 'same_site' });
    expect(rowIssues(rte, 4)[0]).toMatchObject({ column: 'ระยะทาง (กม.)', code: 'invalid_format' });
    expect(rowIssues(rte, 5)).toEqual([]);
    expect(rowIssues(rte, 6)[0]).toMatchObject({ code: 'duplicate_in_db' }); // ซ้ำกับแถว 5 ในไฟล์

    const prd = await dry(
      a,
      'product',
      await xlsxOf([
        ['ชื่อสินค้า', 'หน่วยหลัก', 'น้ำหนักต่อหน่วย (กก.)', 'เลข UN'],
        ['สินค้า ก', 'หน่วยแปลก', '1', ''],
        ['สินค้า ข', 'BAG', '', ''],
        ['สินค้า ค', 'BAG', '2', '1993'],
      ]),
    );
    expect(rowIssues(prd, 2)[0]).toMatchObject({
      column: 'หน่วยหลัก',
      code: 'reference_not_found',
    });
    expect(rowIssues(prd, 3)[0]).toMatchObject({ code: 'required' });
    expect(rowIssues(prd, 4)[0]).toMatchObject({ code: 'not_hazardous' });

    const svc = await dry(
      a,
      'service_item',
      await xlsxOf([
        ['รหัส', 'ชื่อรายการ', 'หน่วยคิด', 'VAT', 'หัก ณ ที่จ่าย', 'ราคาตั้งต้น'],
        ['FREIGHT', 'ค่าขนส่งปลอม', 'ต่อเที่ยว', 'VAT 7%', '1%', '10'],
        ['AX-9', 'ค่าตามจริง', 'ตามจริง', 'VAT 7%', '3%', '10'],
        ['AX-8', 'ค่าเปอร์เซ็นต์', '%', 'VAT 7%', '3%', '120'],
        ['AX-7', 'ค่าภาษีแปลก', 'ต่อเที่ยว', 'VAT 10%', '3%', '1'],
      ]),
    );
    expect(rowIssues(svc, 2)[0]).toMatchObject({ column: 'รหัส' });
    expect(['reserved_code', 'duplicate_in_db']).toContain(rowIssues(svc, 2)[0]!.code);
    expect(rowIssues(svc, 3)[0]).toMatchObject({ code: 'actual_no_price' });
    expect(rowIssues(svc, 4)[0]).toMatchObject({ code: 'percent_max' });
    expect(rowIssues(svc, 5)[0]).toMatchObject({ column: 'VAT', code: 'invalid_format' });

    const rc = await dry(
      a,
      'rate_card_sell',
      await xlsxOf([
        ['ลูกค้า', 'เส้นทาง', 'ประเภทรถ', 'สูตร', 'ราคา', 'มีผลตั้งแต่', 'ถึง'],
        ['CUS-0101', 'RT-0102', '6W', 'เหมาเที่ยว', '7000', '01/06/2570', ''],
        ['CUS-0101', 'RT-0101', 'รถกระบะ', 'เหมาเที่ยว', '3900', '01/01/2570', ''],
        ['CUS-0101', '', '6W', 'เหมาเที่ยว', '3900', '01/01/2570', ''],
        ['CUS-0101', 'RT-0102', '10W', 'เหมาเที่ยว', '-5', '01/01/2570', ''],
        ['CUS-0101', 'RT-0102', '10W', 'เหมาเที่ยว', '5', '01/01/2570', '01/01/2569'],
      ]),
    );
    expect(rowIssues(rc, 2)[0]).toMatchObject({ code: 'overlap' }); // ทับ rate จากไฟล์ตัวอย่าง (422 overlap)
    expect(rowIssues(rc, 3)[0]).toMatchObject({ column: 'ประเภทรถ', code: 'reference_not_found' });
    expect(rowIssues(rc, 3)[0]!.message).toBe('ไม่พบประเภทรถ "รถกระบะ" ในข้อมูลหลัก');
    expect(rowIssues(rc, 4)[0]).toMatchObject({ column: 'เส้นทาง', code: 'required' });
    expect(rowIssues(rc, 5)[0]).toMatchObject({ column: 'ราคา' });
    expect(rowIssues(rc, 6)[0]).toMatchObject({ column: 'ถึง', code: 'before_start' });
    for (const x of [site, car, veh, drv, rte, prd, svc, rc])
      for (const i of x.issues) expect(i.message).toMatch(/[฀-๿]/);
  });

  it('นำเข้าซ้ำ: create_only = ซ้ำทุกแถว (ไม่สร้างเพิ่ม) · upsert_by_code = แก้แถวเดิม ไม่เพิ่ม version เมื่อค่าเดิม', async () => {
    for (const [kind, file] of [
      ['customer', 'customers.csv'],
      ['vehicle', 'vehicles.csv'],
      ['route', 'routes.csv'],
      ['rate_card_buy', 'rate-cards-buy.csv'],
    ] as const) {
      const again = await csv(kind, file);
      expect(again.errorRows, kind).toBe(again.totalRows);
    }
    const before = await db.customer.count({ where: { tenantId: tA } });
    const up = await csv('customer', 'customers.csv', { mode: 'upsert_by_code' });
    expect(errorsOf(up)).toEqual([]);
    const v0 = await db.customer.findFirst({ where: { tenantId: tA, code: 'CUS-0101' } });
    await commit(a, up.id);
    const v1 = await db.customer.findFirst({ where: { tenantId: tA, code: 'CUS-0101' } });
    expect(v1!.version).toBe(v0!.version);
    expect(await db.customer.count({ where: { tenantId: tA } })).toBe(before);
    // upsert แก้เฉพาะคอลัมน์ที่มีค่า · __CLEAR__ = ล้างค่า (MD-284)
    const edit = await dry(
      a,
      'customer',
      await xlsxOf([
        ['รหัส', 'ชื่อ', 'เครดิต', 'วงเงินเครดิต'],
        ['CUS-0101', '', '60', '__CLEAR__'],
        ['CUS-0999', 'บจก. ใหม่จากการแก้', '', ''],
      ]),
      { mode: 'upsert_by_code' },
    );
    expect(errorsOf(edit)).toEqual([]);
    await commit(a, edit.id);
    const v2 = await db.customer.findFirst({ where: { tenantId: tA, code: 'CUS-0101' } });
    expect(v2).toMatchObject({
      legalName: 'บจก. ตัวอย่างพลาสติก',
      paymentTermDays: 60,
      creditLimit: null,
    });
    expect(v2!.version).toBe(v1!.version + 1);
    // update_only: รหัสที่ไม่มี = แถวผิด (ไม่สร้าง)
    const only = await dry(
      a,
      'customer',
      await xlsxOf([
        ['รหัส', 'ชื่อ'],
        ['CUS-7777', 'บจก. ไม่มี'],
      ]),
      { mode: 'update_only' },
    );
    expect(rowIssues(only, 2)[0]).toMatchObject({ column: 'รหัส', code: 'reference_not_found' });
    // rate card นำเข้าได้แบบสร้างใหม่เท่านั้น (MD-285 ฉบับแก้ไขทำในหน้าจอ)
    await dry(a, 'rate_card_sell', sample('rate-cards-sell.csv'), {
      mime: 'text/csv',
      mode: 'upsert_by_code',
      status: 422,
    });
  });

  it('ยืนยันแล้วตรวจซ้ำ: ข้อมูลถูกสร้างระหว่างรอ (all_or_nothing) = ไม่เขียนสักแถว · skip เขียนเฉพาะแถวที่ยังผ่าน', async () => {
    const file = await xlsxOf([
      ['รหัส', 'ชื่อ'],
      ['RACE-1', 'บจก. แข่ง หนึ่ง'],
      ['RACE-2', 'บจก. แข่ง สอง'],
      ['RACE-3', 'บจก. แข่ง สาม'],
    ]);
    const r = await dry(a, 'customer', file);
    expect(r.errorRows).toBe(0);
    await a.post('/v1/customers').send({ code: 'RACE-2', legalName: 'บจก. มาก่อน' }).expect(201);
    const c = await commit(a, r.id);
    expect(c).toMatchObject({ status: 'validated', errorRows: 1, importedRows: 0 });
    expect(rowIssues(c, 3)[0]).toMatchObject({ code: 'duplicate_in_db' });
    expect(
      await db.customer.count({ where: { tenantId: tA, code: { in: ['RACE-1', 'RACE-3'] } } }),
    ).toBe(0);
    await a.patch(`/v1/imports/${r.id}`).send({ errorPolicy: 'skip_invalid_rows' }).expect(200);
    const s = await commit(a, r.id);
    expect(s).toMatchObject({ status: 'completed_with_errors', importedRows: 2 });
    expect(
      await db.customer.count({ where: { tenantId: tA, code: { in: ['RACE-1', 'RACE-3'] } } }),
    ).toBe(2);
    expect(
      await db.auditLog.count({
        where: { tenantId: tA, action: 'import.completed', entityId: tryDecodeId('import', r.id)! },
      }),
    ).toBe(1);
  });

  it('สิทธิ์: ต้องมี scope เดียวกับการสร้างผ่าน API — ไม่มี = 404 · rate ขาขาย/ขาซื้อแยกสิทธิ์', async () => {
    const viewer = api(app, await tokenFor(tA, 'master:read documents:write documents:read'));
    const kinds = (await viewer.get('/v1/imports/kinds').expect(200)).body;
    expect(kinds).toEqual([]);
    await viewer.get('/v1/imports/kinds/customer/template').expect(404);
    await dry(viewer, 'customer', sample('customers.csv'), { mime: 'text/csv', status: 404 });
    const sellOnly = api(
      app,
      await tokenFor(tA, 'prices.sell:write documents:write documents:read'),
    );
    const k2 = (await sellOnly.get('/v1/imports/kinds').expect(200)).body.map(
      (k: { kind: string }) => k.kind,
    );
    expect(k2).toEqual(['rate_card_sell']);
    await dry(sellOnly, 'rate_card_buy', sample('rate-cards-buy.csv'), {
      mime: 'text/csv',
      status: 404,
    });
  });

  it('แยก tenant: อ้างอิงข้อมูลของ tenant อื่นไม่ได้ และงานนำเข้าของ tenant อื่น = 404', async () => {
    const r = await dry(
      b,
      'customer_site',
      await xlsxOf([
        ['ชื่อสถานที่', 'ลูกค้า', 'ที่อยู่'],
        ['จุดของบี', 'CUS-0101', '1 ถ.บี'],
      ]),
    );
    expect(rowIssues(r, 2)[0]).toMatchObject({ column: 'ลูกค้า', code: 'reference_not_found' });
    const mine = await csv('customer', 'customers.csv');
    await b.get(`/v1/imports/${mine.id}`).expect(404);
    await b.post(`/v1/imports/${mine.id}/commit`).expect(404);
    // tenant บีนำเข้าไฟล์เดียวกันได้ (รหัสซ้ำข้าม tenant ไม่ชน)
    const own = await csv('customer', 'customers.csv').then(() =>
      dry(b, 'customer', sample('customers.csv'), { mime: 'text/csv' }),
    );
    expect(own.errorRows).toBe(0);
    await commit(b, own.id);
    expect(await db.customer.count({ where: { tenantId: tB } })).toBe(own.totalRows);
  });

  it('สูตร/formula injection: เก็บเป็นข้อความตามตัว · สูตร Excel ใช้ค่าที่คำนวณแล้ว · ไฟล์แถวผิดไม่มีสูตร', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('a');
    ws.addRow(['รหัส', 'ชื่อ', 'เครดิต']);
    ws.addRow(['F-1', '=HYPERLINK("http://evil.example","คลิก")', '15']);
    ws.addRow(['F-2', '+cmd|"/c calc"!A1', '15']);
    ws.addRow(['F-3', { formula: 'CONCAT("บจก. ","สูตร")', result: 'บจก. สูตร' }, '15']);
    ws.addRow(['F-4', '@SUM(1+1)', 'abc']);
    const r = await dry(a, 'customer', Buffer.from(await wb.xlsx.writeBuffer()), {
      errorPolicy: 'skip_invalid_rows',
    });
    expect(r.errorRows).toBe(1);
    await commit(a, r.id);
    const names = (
      await db.customer.findMany({
        where: { tenantId: tA, code: { in: ['F-1', 'F-2', 'F-3'] } },
        orderBy: { code: 'asc' },
      })
    ).map((c) => c.legalName);
    expect(names).toEqual([
      '=HYPERLINK("http://evil.example","คลิก")',
      '+cmd|"/c calc"!A1',
      'บจก. สูตร',
    ]);
    const rep = await binary(a.get(`/v1/imports/${r.id}/errors`)).expect(200);
    const out = new ExcelJS.Workbook();
    await out.xlsx.load(rep.body);
    const cell = out.worksheets[0]!.getRow(2).getCell(2);
    expect(cell.type).toBe(ExcelJS.ValueType.String);
    expect(cell.value).toBe('@SUM(1+1)');
    // ส่งออก CSV กันสูตร (export.ts) — ข้อความที่นำเข้าไม่กลายเป็นสูตรเมื่อเปิดใน Excel
    const exp = await a.get('/v1/customers/export?format=csv').expect(200);
    expect(exp.text).toContain(`'=HYPERLINK`);
  });

  it('ไฟล์ใหญ่: เกิน 200 แถว = ตรวจ/นำเข้าเป็น job (กฎ API ทีละแถว) · โควตารถเกิน = ปฏิเสธทั้งไฟล์', async () => {
    const rows: unknown[][] = [['ชื่อ', 'เครดิต']];
    for (let i = 1; i <= 201; i++) rows.push([`บจก. ไฟล์ใหญ่ ${i}`, '30']);
    const r = await dry(a, 'customer', await xlsxOf(rows));
    expect(r).toMatchObject({ status: 'validating' });
    expect(r.jobId).toMatch(/^job_/);
    const queue = app.get(JobQueue);
    while (await queue.runOnce()) {
      /* วนจนหมดคิว */
    }
    const v = (await a.get(`/v1/imports/${r.id}`).expect(200)).body;
    expect(v).toMatchObject({ status: 'validated', totalRows: 201, errorRows: 0 });
    const c = (await a.post(`/v1/imports/${r.id}/commit`).expect(200)).body;
    expect(c.status).toBe('importing');
    while (await queue.runOnce()) {
      /* วนจนหมดคิว */
    }
    const done = (await a.get(`/v1/imports/${r.id}`).expect(200)).body;
    expect(done).toMatchObject({ status: 'completed', importedRows: 201 });

    await db.tenant.update({ where: { id: tA }, data: { vehicleQuota: 4 } });
    const q = await dry(
      a,
      'vehicle',
      await xlsxOf([
        ['ทะเบียน', 'ประเภทรถ', 'เจ้าของ', 'จังหวัด'],
        ['75-0001', '6W', 'บริษัท', 'กทม.'],
        ['75-0002', '6W', 'บริษัท', 'กทม.'],
      ]),
    );
    expect(q.status).toBe('failed');
    expect(q.fileError).toContain('โควตา');
    await db.tenant.update({ where: { id: tA }, data: { vehicleQuota: null } });
  });
});
