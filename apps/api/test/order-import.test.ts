import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { JobQueue } from '../src/jobs/job-queue.service';
import { OrderIntakeService } from '../src/modules/orders/order-intake.service';
import { ProblemException } from '../src/common/problem';
import { parseImportDate } from '../src/modules/imports/import-spec';
import { issuesFromError } from '../src/modules/imports/reasons';
import { parseWindow } from '../src/modules/orders/order.import';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { addDays, bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const HEAD = [
  'เลขอ้างอิงใบสั่ง',
  'ลูกค้า',
  'วันรับสินค้า',
  'ประเภทรถ',
  'เลข PO ลูกค้า',
  'จุดรับ',
  'เวลารับ ตั้งแต่',
  'เวลารับ ถึง',
  'จุดส่ง',
  'เวลาส่ง ตั้งแต่',
  'เวลาส่ง ถึง',
  'จุดคืนสินค้า',
  'รหัสสินค้า',
  'รายละเอียดสินค้า',
  'จำนวน',
  'หน่วย',
  'น้ำหนัก (กก.)',
  'ปริมาตร (คิว)',
];
type Row = Partial<Record<(typeof HEAD)[number], string>>;

async function xlsxOf(rows: Row[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('ใบสั่งขนส่ง');
  ws.addRow(HEAD);
  for (const r of rows) ws.addRow(HEAD.map((h) => r[h] ?? ''));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const binary = (t: request.Test) =>
  t.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

interface Issue {
  row: number;
  column?: string;
  code: string;
  message: string;
  severity: string;
}
type Api = ReturnType<typeof api>;

/**
 * ST3-T04 นำเข้า order จาก Excel (template + dry-run + รายงานแถวผิด) เรียก `upsertOrder()`
 * เกณฑ์ตรวจรับ: ไฟล์ 200 แถวมีผิด 2 แถว → dry-run ชี้ 2 แถว, ยืนยันได้ 198 order
 */
describe('นำเข้าใบสั่งขนส่งจาก Excel (ST3-T04)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tA: string;
  let tB: string;
  let a: Api;
  let b: Api;
  let seed = 0;
  const today = bangkokToday();
  const [y, m, d] = today.split('-');
  const todayTh = `${d}/${m}/${Number(y) + 543}`;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };

  async function company(tid: string) {
    const c = await db.company.create({
      data: { tenantId: tid, legalName: `บริษัท ออกบิล ${++seed}`, taxId: validTaxId(800 + seed) },
    });
    await db.branch.create({
      data: {
        tenantId: tid,
        companyId: c.id,
        branchCode: '00000',
        branchLabel: 'สำนักงานใหญ่',
        address: ADDR,
        isDefaultIssuer: true,
      },
    });
  }

  async function upload(x: Api, data: Buffer) {
    const r = await x
      .post('/v1/documents')
      .send({ kind: 'IMPORT', mime: XLSX, bytes: data.length, filename: 'orders.xlsx' })
      .expect(201);
    const u = new URL(r.body.uploadUrl);
    await request(app.getHttpServer())
      .put(u.pathname + u.search)
      .set('Content-Type', 'application/octet-stream')
      .send(data)
      .expect(200);
    return r.body.id as string;
  }
  async function dry(
    x: Api,
    rows: Row[],
    opts: { mode?: string; errorPolicy?: string; status?: number } = {},
  ) {
    const doc = await upload(x, await xlsxOf(rows));
    const r = await x.post('/v1/imports').send({
      kind: 'order',
      documentId: doc,
      errorPolicy: opts.errorPolicy ?? 'skip_invalid_rows',
      ...(opts.mode ? { mode: opts.mode } : {}),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(opts.status ?? 201);
    return settle(x, r.body);
  }
  /** ไฟล์เกิน syncMax (30 แถว) = job — รันคิวจนเสร็จแล้วอ่านผล */
  async function settle(x: Api, body: { id: string; status: string }) {
    if (body.status !== 'validating' && body.status !== 'importing') return body;
    const queue = app.get(JobQueue);
    while (await queue.runOnce());
    return (await x.get(`/v1/imports/${body.id}`).expect(200)).body;
  }
  async function commit(x: Api, id: string) {
    const r = await x.post(`/v1/imports/${id}/commit`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return settle(x, r.body);
  }
  const errorsOf = (r: { issues: Issue[] }) => r.issues.filter((i) => i.severity === 'error');
  const at = (r: { issues: Issue[] }, row: number) => r.issues.filter((i) => i.row === row);
  const orders = (where: object = {}) =>
    db.salesOrder.findMany({
      where: { tenantId: tA, ...where },
      include: { stops: { orderBy: { sequence: 'asc' } }, lines: { orderBy: { lineNo: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
  /** ทุกอย่างที่ upsertOrder เขียน — dry-run ต้องไม่เปลี่ยนค่าใดเลย */
  const footprint = async () => ({
    so: await db.salesOrder.count({ where: { tenantId: tA } }),
    do: await db.deliveryOrder.count({ where: { tenantId: tA } }),
    audit: await db.auditLog.count({ where: { tenantId: tA, entityType: 'sales_order' } }),
    events: await db.domainEvent.count({
      where: { tenantId: tA, entityType: { in: ['sales_order', 'delivery_order'] } },
    }),
    history: await db.docStatusHistory.count({ where: { tenantId: tA } }),
    seq: (
      await db.documentSequence.findMany({
        where: { tenantId: tA },
        select: { docType: true, nextValue: true },
        orderBy: { docType: 'asc' },
      })
    ).map((s) => `${s.docType}:${s.nextValue}`),
  });

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tA = (await createTenantWithDefaults(db, { name: 'บริษัท ขนส่ง เอ' })).id;
    tB = (await createTenantWithDefaults(db, { name: 'บริษัท ขนส่ง บี' })).id;
    await company(tA);
    await company(tB);
    a = api(app, await tokenFor(tA));
    b = api(app, await tokenFor(tB));
    const cus = (
      await a
        .post('/v1/customers')
        .send({ code: 'C-0001', legalName: 'บจก. ลูกค้าทดสอบ', taxId: validTaxId(9001) })
        .expect(201)
    ).body.id;
    await a
      .post('/v1/customers')
      .send({ code: 'C-0002', legalName: 'บจก. ลูกค้ารายอื่น', taxId: validTaxId(9002) })
      .expect(201);
    const site = async (code: string, customerId: string | null = cus) =>
      (
        await a
          .post('/v1/customer-sites')
          .send({
            code,
            name: `จุด ${code}`,
            kind: 'DROPOFF',
            address: ADDR,
            ...(customerId ? { customerId } : {}),
          })
          .expect(201)
      ).body.id as string;
    const origin = await site('L-0001', null);
    const dest = await site('L-0002');
    await site('L-0003');
    const types = (await a.get('/v1/vehicle-types?limit=50').expect(200)).body.data;
    const vt6 = types.find((t: { code: string }) => t.code === '6W').id;
    const us = (await a.get('/v1/units?limit=50').expect(200)).body.data;
    const bag = us.find((u: { code: string }) => u.code === 'BAG').id;
    await a
      .post('/v1/products')
      .send({ code: 'P-0001', name: 'ปูนซีเมนต์ถุง', unitId: bag, weightPerUnitKg: 50 })
      .expect(201);
    const rate = (
      await a
        .post('/v1/rate-cards')
        .send({
          customerId: cus,
          originId: origin,
          destinationId: dest,
          vehicleTypeId: vt6,
          validFrom: addDays(today, -30),
          pricingModel: 'PER_TRIP',
          sellRate: '4500',
          includedStops: 2,
        })
        .expect(201)
    ).body;
    await a
      .post(`/v1/rate-cards/${rate.id}/approve`)
      .send({ reason: 'อนุมัติตามใบเสนอราคา' })
      .expect(200);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  /** ใบ 1 แถว: L-0001 → L-0002 ปูน 400 ถุง (มี rate → RECEIVED) */
  const one = (ref: string, extra: Row = {}): Row => ({
    เลขอ้างอิงใบสั่ง: ref,
    ลูกค้า: 'C-0001',
    วันรับสินค้า: todayTh,
    ประเภทรถ: '6W',
    'เลข PO ลูกค้า': `PO-${ref}`,
    จุดรับ: 'L-0001',
    'เวลารับ ตั้งแต่': '08:00',
    จุดส่ง: 'L-0002',
    'เวลาส่ง ถึง': '17:00',
    รหัสสินค้า: 'P-0001',
    จำนวน: '400',
    ...extra,
  });

  it('kinds + template: หัวคอลัมน์ไทย, ตัวอย่างหลายแถว (ใบหลายจุด), คำอธิบายวิธีจัดกลุ่ม, ไม่มีคอลัมน์ราคา', async () => {
    const k = (await a.get('/v1/imports/kinds').expect(200)).body.find(
      (x: { kind: string }) => x.kind === 'order',
    );
    expect(k).toMatchObject({
      label: 'ใบสั่งขนส่ง',
      modes: ['upsert_by_code', 'create_only'],
      defaultMode: 'upsert_by_code',
      maxRows: 500,
    });
    const t = await binary(a.get('/v1/imports/kinds/order/template')).expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(t.body);
    expect(wb.worksheets[0]!.actualRowCount).toBe(1);
    expect((wb.worksheets[0]!.getRow(1).values as string[]).slice(1)).toEqual(HEAD);
    for (const h of HEAD) expect(h).not.toMatch(/ราคา|price/i);
    const sample = wb.getWorksheet('ตัวอย่าง')!;
    expect(sample.actualRowCount).toBe(4);
    expect(sample.getRow(3).getCell(1).value).toBe('ORD-0002');
    expect(sample.getRow(4).getCell(1).value).toBe('ORD-0002');
    const help = wb.getWorksheet('คำอธิบาย')!;
    const text: string[] = [];
    help.eachRow((r) => text.push(String(r.getCell(1).value ?? '')));
    expect(text.join('\n')).toMatch(/เลขอ้างอิงใบสั่ง" เดียวกัน/);
    expect(text.join('\n')).toMatch(/ราคาไม่ต้องกรอก/);
  });

  it('เกณฑ์ตรวจรับ: 200 แถวผิด 2 แถว (job) → dry-run ชี้ 2 แถว (เหตุผลไทย) ไม่เขียนอะไรเลย · ยืนยันได้ 198 order ที่มา EXCEL', async () => {
    const rows: Row[] = [];
    for (let i = 1; i <= 200; i++) rows.push(one(`AC-${String(i).padStart(4, '0')}`));
    rows[49] = one('AC-0050', { จุดส่ง: 'L-9999' }); // แถว 51 ในไฟล์
    rows[149] = one('AC-0150', { จำนวน: '0' }); // แถว 151
    const before = await footprint();
    const r = await dry(a, rows);
    expect(r).toMatchObject({ status: 'validated', totalRows: 200, errorRows: 2, okEntities: 198 });
    expect(errorsOf(r)).toEqual([
      expect.objectContaining({
        row: 51,
        column: 'จุดส่ง',
        code: 'reference_not_found',
        message: 'ไม่พบสถานที่ "L-9999" ในข้อมูลหลัก',
      }),
      expect.objectContaining({ row: 151, column: 'จำนวน', message: 'ต้องมากกว่า 0' }),
    ]);
    // dry-run: ไม่มี SO/DO/เลขเอกสาร/audit/event/ประวัติสถานะ
    expect(await footprint()).toEqual(before);

    const c = await commit(a, r.id);
    expect(c).toMatchObject({
      status: 'completed_with_errors',
      importedRows: 198,
      importedEntities: 198,
      mode: 'upsert_by_code',
    });
    const so = await orders({ externalId: { startsWith: 'AC-' } });
    expect(so).toHaveLength(198);
    expect(new Set(so.map((o) => o.source))).toEqual(new Set(['IMPORT']));
    expect(so.filter((o) => o.status === 'RECEIVED')).toHaveLength(198);
    expect(so.every((o) => o.priceTotal?.toFixed(2) === '4500.00')).toBe(true);
    // เลข SO ไม่ถูกใช้ตอน dry-run: ใบแรกได้เลข 1
    expect(so[0]!.soNo).toMatch(/0001$/);
    expect(so[0]!.stops.map((s) => [s.type, s.windowStart?.toISOString()])).toEqual([
      ['PICKUP', new Date(`${today}T08:00:00+07:00`).toISOString()],
      ['DELIVERY', undefined],
    ]);
    expect(so[0]!.stops[1]!.windowEnd!.toISOString()).toBe(
      new Date(`${today}T17:00:00+07:00`).toISOString(),
    );
    expect(so[0]!.lines[0]).toMatchObject({ description: 'ปูนซีเมนต์ถุง', unit: 'BAG' });
    // API แสดงที่มา EXCEL + audit ย้อนหาไฟล์ได้ (requestId import:imp_…)
    const dto = (await a.get('/v1/orders/ext:AC-0001').expect(200)).body;
    expect(dto).toMatchObject({
      source: 'EXCEL',
      externalId: 'AC-0001',
      customerRef: 'PO-AC-0001',
    });
    const audit = await db.auditLog.findFirst({
      where: { tenantId: tA, entityType: 'sales_order', entityId: so[0]!.id },
    });
    expect(audit).toMatchObject({ action: 'sales_order.created', requestId: `import:${r.id}` });
    expect(await db.deliveryOrder.count({ where: { tenantId: tA } })).toBe(198);
  }, 300_000);

  it('หลายแถวต่อใบ: จัดกลุ่มด้วยเลขอ้างอิง (หลายจุด + หลายสินค้า) · ใบที่มีแถวผิด = ไม่นำเข้าทั้งใบ · หัวใบไม่ตรงกัน = ผิด', async () => {
    const r = await dry(a, [
      one('G-1'),
      {
        เลขอ้างอิงใบสั่ง: 'G-2',
        จุดส่ง: 'L-0003',
        รายละเอียดสินค้า: 'เหล็ก',
        จำนวน: '5',
        หน่วย: 'TON',
      },
      one('G-2', { 'เลข PO ลูกค้า': '' }),
      { เลขอ้างอิงใบสั่ง: 'G-1', จุดส่ง: 'L-0003', 'เวลาส่ง ถึง': `${todayTh} 18:30` },
      {
        เลขอ้างอิงใบสั่ง: 'G-1',
        จุดคืนสินค้า: 'L-0001',
        รายละเอียดสินค้า: 'พาเลทเปล่า',
        จำนวน: '10',
        หน่วย: 'พาเลท',
      },
      one('G-3'),
      {
        เลขอ้างอิงใบสั่ง: 'G-3',
        จุดส่ง: 'L-0003',
        รายละเอียดสินค้า: 'ทราย',
        จำนวน: '3',
        หน่วย: 'XX',
      },
      one('G-4'),
      { เลขอ้างอิงใบสั่ง: 'G-4', ลูกค้า: 'C-0002', จุดส่ง: 'L-0003' },
      { เลขอ้างอิงใบสั่ง: 'G-4' },
      one('G-5'),
      // หัวใบเขียนต่างรูปแต่ค่าเดียวกัน (ชื่อลูกค้าแทนรหัส, วันที่ ค.ศ.) = ไม่ถือว่าไม่ตรง
      {
        เลขอ้างอิงใบสั่ง: 'G-5',
        ลูกค้า: 'บจก. ลูกค้าทดสอบ',
        วันรับสินค้า: today,
        จุดส่ง: 'L-0003',
      },
    ]);
    // G-1, G-2 ผ่าน (แถว 2,3,4,5,6) · G-3 แถว 8 หน่วยผิด → แถว 7 ผิดตาม · G-4 ลูกค้าไม่ตรง + แถวว่าง
    expect(r).toMatchObject({ totalRows: 12, errorRows: 5, okEntities: 3 });
    expect(at(r, 8)).toEqual([
      expect.objectContaining({ column: 'หน่วย', code: 'reference_not_found' }),
    ]);
    expect(at(r, 7)).toEqual([
      expect.objectContaining({
        code: 'group_has_errors',
        message: 'ใบสั่งเดียวกับแถว 8 ที่ผิด — ไม่นำเข้าทั้งใบ',
      }),
    ]);
    expect(at(r, 10)).toEqual([
      expect.objectContaining({
        column: 'ลูกค้า',
        code: 'group_mismatch',
        message: expect.stringContaining('ไม่ตรงกับแถว 9 ของใบสั่งเดียวกัน'),
      }),
    ]);
    expect(at(r, 11)[0]).toMatchObject({ code: 'required' });
    expect(at(r, 9)[0]).toMatchObject({ code: 'group_has_errors' });
    const c = await commit(a, r.id);
    expect(c).toMatchObject({
      status: 'completed_with_errors',
      importedRows: 7,
      importedEntities: 3,
    });
    const [g1] = await orders({ externalId: 'G-1' });
    expect(g1!.stops.map((s) => s.type)).toEqual(['PICKUP', 'DELIVERY', 'DELIVERY', 'RETURN']);
    expect(g1!.stops[2]!.windowEnd!.toISOString()).toBe(
      new Date(`${today}T18:30:00+07:00`).toISOString(),
    );
    expect(g1!.lines.map((l) => [l.description, l.qtyOrdered.toFixed(), l.unit])).toEqual([
      ['ปูนซีเมนต์ถุง', '400', 'BAG'],
      ['พาเลทเปล่า', '10', 'PLT'],
    ]);
    // แถวต่อขึ้นก่อนแถวแรก: หัวใบมาจากแถวที่มีค่า, ลำดับจุดตามแถว
    const [g2] = await orders({ externalId: 'G-2' });
    expect(g2!.stops.map((s) => s.type)).toEqual(['DELIVERY', 'PICKUP', 'DELIVERY']);
    expect(g2!.customerRef).toBeNull();
    expect(await orders({ externalId: { in: ['G-3', 'G-4'] } })).toEqual([]);
  });

  it('นำเข้าซ้ำ: ไฟล์เดิม = ไม่เกิดใบใหม่/ไม่เปลี่ยน version · แก้ค่า = อัปเดตใบเดิม · create_only = แถวผิด', async () => {
    const file = [one('RE-1'), one('RE-2')];
    await commit(a, (await dry(a, file)).id);
    const v1 = (await orders({ externalId: { in: ['RE-1', 'RE-2'] } })).map((o) => o.version);
    const auditBefore = await db.auditLog.count({
      where: { tenantId: tA, entityType: 'sales_order' },
    });
    const again = await dry(a, file);
    expect(errorsOf(again)).toEqual([]);
    expect(again.issues).toEqual([
      expect.objectContaining({ row: 2, code: 'order_unchanged', severity: 'warning' }),
      expect.objectContaining({ row: 3, code: 'order_unchanged', severity: 'warning' }),
    ]);
    await commit(a, again.id);
    const after = await orders({ externalId: { in: ['RE-1', 'RE-2'] } });
    expect(after).toHaveLength(2);
    expect(after.map((o) => o.version)).toEqual(v1);
    expect(await db.auditLog.count({ where: { tenantId: tA, entityType: 'sales_order' } })).toBe(
      auditBefore,
    );
    // แก้จำนวน → อัปเดตใบเดิม (version +1)
    const upd = await dry(a, [one('RE-1', { จำนวน: '450' })]);
    expect(upd.issues).toEqual([
      expect.objectContaining({
        code: 'order_updated',
        message: expect.stringMatching(/^อัปเดตใบสั่งเดิม SO/),
      }),
    ]);
    await commit(a, upd.id);
    const [re1] = await orders({ externalId: 'RE-1' });
    expect(re1!.version).toBe(v1[0]! + 1);
    expect(re1!.lines[0]!.qtyOrdered.toFixed()).toBe('450');
    // create_only: เลขอ้างอิงที่มีแล้ว = แถวผิด
    const co = await dry(a, [one('RE-2'), one('RE-3')], { mode: 'create_only' });
    expect(errorsOf(co)).toEqual([
      expect.objectContaining({ row: 2, column: 'เลขอ้างอิงใบสั่ง', code: 'duplicate_in_db' }),
    ]);
  });

  it('กฎเดียวกับ API: externalId ของช่องทางอื่น → external_id_conflict · ใบที่วางแผนแล้วแก้สินค้า → ช่องที่ล็อก · ไม่มี rate = เตือนใบค้าง', async () => {
    const api1 = (
      await a
        .put('/v1/orders/external/X-API-1')
        .send({
          requestedDate: today,
          stops: [{ type: 'PICKUP', siteText: 'คลังลูกค้า' }],
        })
        .expect(201)
    ).body;
    expect(api1.source).toBe('API');
    await commit(a, (await dry(a, [one('LOCK-1')])).id);
    const [lk] = await orders({ externalId: 'LOCK-1' });
    await db.salesOrder.update({ where: { id: lk!.id }, data: { status: 'PLANNED' } });
    const r = await dry(a, [
      one('X-API-1'),
      one('LOCK-1', { จำนวน: '999' }),
      one('HOLD-1', { ประเภทรถ: '', 'เวลาส่ง ถึง': '25:00' }),
      one('HOLD-2', { ประเภทรถ: '' }),
      one('', {}),
      one('WIN-1', { 'เวลาส่ง ตั้งแต่': '18:00', 'เวลาส่ง ถึง': '08:00' }),
    ]);
    expect(at(r, 7)).toEqual([
      expect.objectContaining({
        column: 'เวลาส่ง ถึง',
        code: 'window_order',
        message: expect.stringContaining('ข้ามวันให้ใส่วันที่ด้วย (DD/MM/YYYY HH:mm)'),
      }),
    ]);
    expect(at(r, 2)).toEqual([
      expect.objectContaining({
        column: 'เลขอ้างอิงใบสั่ง',
        code: 'external_id_conflict',
        message: expect.stringContaining('ช่องทางอื่น'),
      }),
    ]);
    expect(at(r, 3)).toEqual([
      expect.objectContaining({
        column: 'จำนวน',
        code: 'locked',
        message: 'ใบสั่งนี้วางแผน/ออกรถแล้ว แก้ช่องนี้ไม่ได้',
      }),
    ]);
    expect(at(r, 4)).toEqual([
      expect.objectContaining({ column: 'เวลาส่ง ถึง', code: 'invalid_format' }),
    ]);
    expect(at(r, 5)).toEqual([
      expect.objectContaining({
        code: 'order_on_hold',
        severity: 'warning',
        message: expect.stringMatching(/^ใบสั่งจะเข้าระบบเป็นใบค้าง/),
      }),
    ]);
    expect(at(r, 6)).toEqual([
      expect.objectContaining({ code: 'no_external_id', severity: 'warning' }),
    ]);
    // ไฟล์แถวผิด .xlsx มีคอลัมน์ผลตรวจ
    const e = await binary(a.get(`/v1/imports/${r.id}/errors`)).expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(e.body);
    expect(wb.worksheets[0]!.actualRowCount).toBeGreaterThanOrEqual(4);
  });

  it('สิทธิ์ orders:write + แยก tenant: ไม่มีสิทธิ์ = ไม่เห็นชนิด/404 · tenant อื่นอ้างรหัสของเราไม่ได้และเห็นงานนำเข้าเราไม่ได้', async () => {
    const reader = api(app, await tokenFor(tA, 'orders:read documents:write documents:read'));
    const kinds = (await reader.get('/v1/imports/kinds').expect(200)).body;
    expect(kinds.map((k: { kind: string }) => k.kind)).not.toContain('order');
    await reader.get('/v1/imports/kinds/order/template').expect(404);
    const doc = await upload(reader, await xlsxOf([one('P-1')]));
    await reader.post('/v1/imports').send({ kind: 'order', documentId: doc }).expect(404);
    const writer = api(app, await tokenFor(tA, 'orders:write documents:write documents:read'));
    expect(
      (await writer.get('/v1/imports/kinds').expect(200)).body.map((k: { kind: string }) => k.kind),
    ).toContain('order');

    const mine = await dry(a, [one('ISO-1')]);
    await b.get(`/v1/imports/${mine.id}`).expect(404);
    await b.post(`/v1/imports/${mine.id}/commit`).expect(404);
    const theirs = await dry(b, [one('ISO-1')]);
    expect(theirs.errorRows).toBe(1);
    // ประเภทรถ 6W เป็นค่าเริ่มต้นของทุก tenant — ที่เหลือเป็นข้อมูลของ tenant A
    expect(errorsOf(theirs).map((x) => [x.column, x.code])).toEqual([
      ['ลูกค้า', 'reference_not_found'],
      ['จุดรับ', 'reference_not_found'],
      ['จุดส่ง', 'reference_not_found'],
      ['รหัสสินค้า', 'reference_not_found'],
    ]);
    expect(await db.salesOrder.count({ where: { tenantId: tB } })).toBe(0);
  });

  it('call path: ยืนยันนำเข้าเขียนผ่าน OrderIntakeService.upsertOrder (ที่มา EXCEL) · dry-run ก็เรียกแต่ย้อนทิ้ง', async () => {
    const intake = app.get(OrderIntakeService);
    const spy = vi.spyOn(intake, 'upsertOrder');
    try {
      const r = await dry(a, [one('CP-1'), one('CP-2')]);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(
        await db.salesOrder.count({ where: { tenantId: tA, externalId: { startsWith: 'CP-' } } }),
      ).toBe(0);
      spy.mockClear();
      await commit(a, r.id);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls.map((c) => [c[0].source, c[0].externalId])).toEqual([
        ['EXCEL', 'CP-1'],
        ['EXCEL', 'CP-2'],
      ]);
      const so = await orders({ externalId: { startsWith: 'CP-' } });
      expect(so.map((o) => tryDecodeId('salesOrder', `ord_${o.id.replace(/-/g, '')}`))).toEqual(
        so.map((o) => o.id),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('เพดาน 500 แถวต่อไฟล์: เกิน = ปฏิเสธทั้งไฟล์พร้อมเหตุผลไทย (ไม่สร้าง job)', async () => {
    const rows: Row[] = [];
    for (let i = 1; i <= 501; i++) rows.push(one(`MAX-${i}`));
    const r = await dry(a, rows);
    expect(r).toMatchObject({
      status: 'failed',
      fileErrorCode: 'too_many_rows',
      fileError: 'ไฟล์ใบสั่งขนส่งมี 501 แถว เกินกำหนด 500 แถวต่อไฟล์ — แบ่งเป็นหลายไฟล์',
      jobId: null,
    });
    expect(
      await db.salesOrder.count({ where: { tenantId: tA, externalId: { startsWith: 'MAX-' } } }),
    ).toBe(0);
  });

  it('parseWindow: HH:mm (วันรับสินค้า), HH.mm, วันที่ พ.ศ. + เวลา, ผิดรูป', () => {
    expect(parseWindow('08:00', '2026-11-15')).toBe('2026-11-15T08:00:00+07:00');
    expect(parseWindow('8.30', '2026-11-15')).toBe('2026-11-15T08:30:00+07:00');
    expect(parseWindow('16/11/2569 17:00', '2026-11-15')).toBe('2026-11-16T17:00:00+07:00');
    expect(parseWindow('2026-11-16 07:05', undefined)).toBe('2026-11-16T07:05:00+07:00');
    expect(parseWindow('08:00', undefined)).toBe('no_base');
    expect(parseWindow('25:00', '2026-11-15')).toBeNull();
    expect(parseWindow('พรุ่งนี้', '2026-11-15')).toBeNull();
    // เซลล์ตัวเลข (General) ของ Excel: เศษของวัน และ serial วันเวลา (ระบบ 1900)
    expect(parseWindow('0.333333333333333', '2026-11-15')).toBe('2026-11-15T08:00:00+07:00');
    expect(parseWindow('46341.75', undefined)).toBe('2026-11-15T18:00:00+07:00');
    expect(parseWindow('0.5', '2026-11-15')).toBeNull();
    // บริษัทหลายนิติบุคคลยังไม่ตั้งค่าออกบิล (routing ST1-T16) → เหตุผลไทยที่บอกวิธีแก้
    const e = new ProblemException('validation_failed', undefined, [
      { field: 'companyId', code: 'routing_not_configured', message: 'several legal entities' },
    ]);
    expect(issuesFromError(e, () => undefined)![0]!.message).toMatch(/นิติบุคคลออกบิลตั้งต้น/);
    // เซลล์วันเวลาของ Excel ในคอลัมน์วันที่ (เช่น วันรับสินค้า) = ใช้เฉพาะวันที่
    expect(parseImportDate('2026-11-16 08:00')).toBe('2026-11-16');
    expect(parseImportDate('16/11/2569 8.30')).toBe('2026-11-16');
  });
});
