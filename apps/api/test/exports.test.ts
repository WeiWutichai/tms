import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { tryDecodeId } from '../src/common/ids';
import { JobQueue } from '../src/jobs/job-queue.service';
import { EXPORT_JOB_MAX_ROWS, ExportsService } from '../src/modules/exports/exports.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { addDays, bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST9-T10 ส่งออกตามตัวกรองเป็นงานเบื้องหลัง — เกณฑ์ตรวจรับ: export 50,000 แถวเป็น job แล้วได้ลิงก์ดาวน์โหลดทางแจ้งเตือน;
 * ไฟล์ตรงกับ filter · + สิทธิ์ (export:run + สิทธิ์อ่านรายการ, คอลัมน์ราคา), เฉพาะผู้สั่ง, ข้าม tenant, ตัวกรองผิด 422
 */
describe('exports (ST9-T10)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tA: string;
  let tB: string;
  let admin: string; // user id (tenant A)
  let viewer: string; // user id (tenant A) อีกคน
  let adminB: string;
  let seed = 0;
  const today = bangkokToday();
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };

  async function member(tenantId: string, email: string, role: string) {
    const roles = await ensureSystemRoles(db, tenantId);
    const u = await db.appUser.create({ data: { tenantId, email, name: email, status: 'ACTIVE' } });
    await db.userRole.create({ data: { tenantId, userId: u.id, roleId: roles[role]! } });
    return u.id;
  }
  const as = async (tenantId: string, userId: string, scope = '*') =>
    api(app, await tokenFor(tenantId, scope, userId));

  /** สั่งส่งออก → รัน job จนหมดคิว → สถานะ */
  async function exportNow(
    a: Awaited<ReturnType<typeof as>>,
    body: object,
  ): Promise<Record<string, any>> {
    const r = await a.post('/v1/exports').send(body).expect(202);
    expect(r.body).toMatchObject({ status: 'pending', statusUrl: `/v1/exports/${r.body.id}` });
    while (await app.get(JobQueue).runOnce()) {
      /* drain */
    }
    return (await a.get(r.body.statusUrl).expect(200)).body;
  }
  async function download(url: string): Promise<Buffer> {
    const u = new URL(url);
    const r = await request(app.getHttpServer())
      .get(u.pathname + u.search)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    return r.body as Buffer;
  }
  async function sheet(buf: Buffer): Promise<string[][]> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const out: string[][] = [];
    wb.worksheets[0]!.eachRow((row) =>
      out.push((row.values as unknown[]).slice(1).map((v) => (v == null ? '' : String(v)))),
    );
    return out;
  }

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tA = (await createTenantWithDefaults(db, { name: 'บริษัท ส่งออก เอ' })).id;
    tB = (await createTenantWithDefaults(db, { name: 'บริษัท ส่งออก บี' })).id;
    admin = await member(tA, 'admin@exp.test', 'admin');
    viewer = await member(tA, 'viewer@exp.test', 'admin');
    adminB = await member(tB, 'admin@exp-b.test', 'admin');
  }, 60_000);
  afterEach(() => {
    app.get(ExportsService).maxRows = EXPORT_JOB_MAX_ROWS;
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('50,000 แถวเป็น job → แจ้งเตือนพร้อมลิงก์ → ดาวน์โหลด CSV (UTF-8 BOM) ได้แถวตรงตัวกรองเท่านั้น', async () => {
    // tenant A: ลูกค้า 50,000 ใช้งาน + 7 ปิดใช้ · tenant B: 5 ราย (ต้องไม่อยู่ในไฟล์)
    const N = 50_000;
    for (let i = 0; i < N; i += 5000)
      await db.customer.createMany({
        data: Array.from({ length: 5000 }, (_, k) => ({
          tenantId: tA,
          code: `EX${String(i + k).padStart(6, '0')}`,
          legalName: `ลูกค้าส่งออก ${i + k}`,
        })),
      });
    await db.customer.createMany({
      data: Array.from({ length: 7 }, (_, k) => ({
        tenantId: tA,
        code: `OFF${k}`,
        legalName: `ปิดใช้ ${k}`,
        status: 'INACTIVE' as const,
      })),
    });
    await db.customer.createMany({
      data: Array.from({ length: 5 }, (_, k) => ({
        tenantId: tB,
        code: `EX${String(k).padStart(6, '0')}`,
        legalName: `ของบริษัทบี ${k}`,
      })),
    });
    const a = await as(tA, admin);
    const st = await exportNow(a, {
      resource: 'customers',
      format: 'csv',
      filter: { status: 'active', limit: '10', cursor: '' },
    });
    expect(st).toMatchObject({
      status: 'succeeded',
      resource: 'customers',
      format: 'csv',
      filter: { status: 'active' },
      rows: N,
      progress: 100,
      error: null,
    });
    expect(st.fileName).toMatch(/^customers-\d{8}-\d{4}\.csv$/);
    expect(st.downloadUrl).toContain('/v1/documents/doc_');
    expect(new Date(st.expiresAt).getTime() - new Date(st.finishedAt).getTime()).toBe(
      7 * 86_400_000,
    );

    // แจ้งเตือน in-app + อีเมลของผู้สั่ง พร้อมลิงก์ /exports/{jobId}
    const notes = await db.notification.findMany({
      where: { tenantId: tA, recipientId: admin, templateCode: 'export.ready' },
    });
    expect(notes.map((n) => n.channel).sort()).toEqual(['email', 'in_app']);
    expect(notes[0]!.link).toBe(`/exports/${st.id}`);
    expect(notes[0]!.body).toContain('50,000 รายการ');
    const inbox = await a.get('/v1/me/notifications?limit=5').expect(200);
    expect(inbox.body.data[0]).toMatchObject({
      link: expect.stringContaining(`/exports/${st.id}`),
    });

    const buf = await download(st.downloadUrl);
    expect(buf.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const lines = buf.toString('utf8').slice(1).trimEnd().split('\r\n');
    expect(lines).toHaveLength(N + 1);
    expect(lines[0]).toMatch(/^รหัส,ชื่อ,เลขผู้เสียภาษี/);
    expect(lines[1]).toMatch(/^EX000000,ลูกค้าส่งออก 0,/);
    expect(lines.at(-1)).toMatch(/^EX049999,/);
    expect(lines.some((l) => l.startsWith('OFF') || l.includes('บริษัทบี'))).toBe(false);
    expect(new Set(lines).size).toBe(N + 1); // ไม่มีแถวซ้ำข้ามหน้า

    // ผู้ใช้อื่นใน tenant เดียวกันดู/ดาวน์โหลดงานนี้ไม่ได้ (404) · tenant อื่น 404
    const other = await as(tA, viewer);
    await other.get(`/v1/exports/${st.id}`).expect(404);
    const job = await db.job.findUnique({ where: { id: tryDecodeId('job', st.id)! } });
    const docId = (job!.result as { documentId: string }).documentId;
    await other.get(`/v1/documents/${docId}`).expect(404);
    await a.get(`/v1/documents/${docId}`).expect(200);
    await (await as(tB, adminB)).get(`/v1/exports/${st.id}`).expect(404);

    // audit การสั่งส่งออก
    const audit = await db.auditLog.findFirst({
      where: { tenantId: tA, action: 'export.requested', entityId: job!.id },
    });
    expect(audit).toMatchObject({ actorId: admin });
  }, 180_000);

  it('.xlsx ตามตัวกรองค้นหา + เกินเพดาน → ล้ม แจ้งเหตุ too_many_rows', async () => {
    const a = await as(tA, admin);
    const st = await exportNow(a, { resource: 'customers', filter: { q: 'ปิดใช้' } });
    expect(st).toMatchObject({ status: 'succeeded', format: 'xlsx', rows: 7 });
    const rows = await sheet(await download(st.downloadUrl));
    expect(rows[0]!.slice(0, 2)).toEqual(['รหัส', 'ชื่อ']);
    expect(rows.slice(1).map((r) => r[0])).toEqual(Array.from({ length: 7 }, (_, k) => `OFF${k}`));

    app.get(ExportsService).maxRows = 6;
    const bad = await exportNow(a, { resource: 'customers', filter: { q: 'ปิดใช้' } });
    expect(bad).toMatchObject({
      status: 'failed',
      error: { code: 'too_many_rows' },
      rows: null,
      expiresAt: null,
    });
    expect(bad.downloadUrl).toBeUndefined();
    const n = await db.notification.findFirst({
      where: { tenantId: tA, recipientId: admin, templateCode: 'export.failed', channel: 'in_app' },
    });
    expect(n!.body).toContain('เกิน 6 รายการ');
  }, 60_000);

  it('ใบสั่งขนส่ง: ตัวกรองหน้าใบค้าง (held=true) · คอลัมน์ราคาขายเฉพาะผู้มี prices.sell:read', async () => {
    const tok = await tokenFor(tA, '*', admin);
    const A = api(app, tok);
    await db.company
      .create({
        data: { tenantId: tA, legalName: 'บริษัท ออกบิล', taxId: validTaxId(701) },
      })
      .then((c) =>
        db.branch.create({
          data: {
            tenantId: tA,
            companyId: c.id,
            branchCode: '00000',
            branchLabel: 'สำนักงานใหญ่',
            address: ADDR,
            isDefaultIssuer: true,
          },
        }),
      );
    const types = (await A.get('/v1/vehicle-types?limit=50').expect(200)).body.data;
    const vt6 = types.find((t: { code: string }) => t.code === '6W').id;
    const units = (await A.get('/v1/units?limit=50').expect(200)).body.data;
    const ton = units.find((u: { code: string }) => u.code === 'TON').id;
    const site = async () =>
      (
        await A.post('/v1/customer-sites')
          .send({ name: `จุด ${++seed}`, kind: 'DROPOFF', address: ADDR })
          .expect(201)
      ).body.id as string;
    const customer = (
      await A.post('/v1/customers')
        .send({ legalName: `ลูกค้า SO ${++seed}`, taxId: validTaxId(9500 + seed) })
        .expect(201)
    ).body.id as string;
    const [o, d, d2] = [await site(), await site(), await site()];
    const rate = (
      await A.post('/v1/rate-cards')
        .send({
          customerId: customer,
          originId: o,
          destinationId: d,
          vehicleTypeId: vt6,
          validFrom: addDays(today, -30),
          pricingModel: 'PER_TRIP',
          sellRate: '4500',
          includedStops: 2,
        })
        .expect(201)
    ).body;
    await A.post(`/v1/rate-cards/${rate.id}/approve`)
      .send({ reason: 'อนุมัติตามใบเสนอราคา' })
      .expect(200);
    const order = (dest: string, ref: string) =>
      A.post('/v1/orders')
        .send({
          customer: { id: customer },
          customerRef: ref,
          requestedDate: today,
          vehicleTypeId: vt6,
          stops: [
            { type: 'PICKUP', siteId: o },
            { type: 'DELIVERY', siteId: dest },
          ],
          lines: [{ description: 'ปูน', qty: '1', unitId: ton, weightKg: '12500' }],
        })
        .expect(201);
    const priced = (await order(d, 'PO-OK')).body;
    const held = (await order(d2, 'PO-HOLD')).body;
    expect(priced).toMatchObject({ status: 'received', sellTotal: '4500.00' });
    expect(held).toMatchObject({ status: 'on_hold', holdReason: { code: 'RATE_MISSING' } });

    const all = await exportNow(A, { resource: 'orders' });
    const withPrice = await sheet(await download(all.downloadUrl));
    const h = withPrice[0]!;
    expect(h.slice(0, 5)).toEqual(['เลข SO', 'รหัสลูกค้า', 'ลูกค้า', 'เส้นทาง', 'น้ำหนัก (กก.)']);
    const pi = h.indexOf('ยอดขาย (ก่อน VAT)');
    expect(pi).toBeGreaterThan(0);
    const byRef = (rows: string[][], ref: string) =>
      rows.find((r) => r[h.indexOf('เลขอ้างอิงลูกค้า')] === ref)!;
    expect(byRef(withPrice, 'PO-OK')[pi]).toBe('4500.00');
    expect(byRef(withPrice, 'PO-OK')[h.indexOf('น้ำหนัก (กก.)')]).toBe('12500');
    expect(byRef(withPrice, 'PO-HOLD')[h.indexOf('สถานะ')]).toBe('ค้าง');

    // หน้าใบค้าง: held=true → เฉพาะใบค้าง
    const hold = await exportNow(A, { resource: 'orders', filter: { held: 'true' } });
    expect(hold.rows).toBe(1);
    const holdRows = await sheet(await download(hold.downloadUrl));
    expect(holdRows.slice(1).map((r) => r[h.indexOf('เลขอ้างอิงลูกค้า')])).toEqual(['PO-HOLD']);

    // ไม่มีสิทธิ์ดูราคาขาย → ไม่มีคอลัมน์ราคา และไม่มีตัวเลขราคาในไฟล์
    const noPrice = await as(tA, admin, 'orders:read export:run');
    const np = await exportNow(noPrice, { resource: 'orders', format: 'csv' });
    const text = (await download(np.downloadUrl)).toString('utf8');
    expect(text).not.toContain('ยอดขาย');
    expect(text).not.toContain('4500');
    expect(np.rows).toBe(2);
  }, 60_000);

  it('สิทธิ์และตัวกรอง: ไม่มี export:run / สิทธิ์อ่านรายการ → 403 · ตัวกรองแปลก/ผิด → 422 · resource ไม่รู้จัก → 422', async () => {
    const noExport = await as(tA, admin, 'master:read orders:read');
    await noExport.post('/v1/exports').send({ resource: 'customers' }).expect(403);
    const noRead = await as(tA, admin, 'export:run master:read');
    const r = await noRead.post('/v1/exports').send({ resource: 'orders' }).expect(403);
    expect(r.body).toMatchObject({ code: 'permission_denied', required: ['orders:read'] });

    const a = await as(tA, admin);
    const unknown = await a
      .post('/v1/exports')
      .send({ resource: 'customers', filter: { foo: 'x' } })
      .expect(422);
    expect(unknown.body.errors[0]).toMatchObject({ field: 'filter.foo' });
    const badVal = await a
      .post('/v1/exports')
      .send({ resource: 'orders', filter: { requestedFrom: '2026-13-45' } })
      .expect(422);
    expect(badVal.body.code).toBe('validation_failed');
    await a.post('/v1/exports').send({ resource: 'invoices' }).expect(422);
    await a.post('/v1/exports').send({ resource: 'customers', format: 'pdf' }).expect(422);
    await a
      .post('/v1/exports')
      .send({ resource: 'customers', filter: { status: 1 } })
      .expect(422);
    // ไม่มีงานค้างจากคำขอที่ถูกปฏิเสธ
    expect(
      await db.job.count({ where: { tenantId: tA, status: 'PENDING', type: 'export.file' } }),
    ).toBe(0);
  });

  it('ถูกถอดสิทธิ์ระหว่างรอคิว (ผู้ใช้จริง) → งานล้ม permission_denied ไม่สร้างไฟล์', async () => {
    const roles = await ensureSystemRoles(db, tA);
    const u = await db.appUser.create({
      data: { tenantId: tA, email: 'demote@exp.test', name: 'demote', status: 'ACTIVE' },
    });
    await db.userRole.create({ data: { tenantId: tA, userId: u.id, roleId: roles.admin! } });
    // token ชนิดผู้ใช้จริง: จำลองโดยเขียน principalType ใน payload หลังสั่ง (token dev ใช้ scope ตอนสั่ง)
    const a = await as(tA, u.id);
    const r = await a.post('/v1/exports').send({ resource: 'customers' }).expect(202);
    const id = tryDecodeId('job', r.body.id)!;
    const j = await db.job.findUnique({ where: { id } });
    await db.job.update({
      where: { id },
      data: { payload: { ...(j!.payload as object), principalType: 'user' } },
    });
    await db.userRole.deleteMany({ where: { userId: u.id } });
    while (await app.get(JobQueue).runOnce()) {
      /* drain */
    }
    const st = (await a.get(r.body.statusUrl).expect(200)).body;
    expect(st).toMatchObject({ status: 'failed', error: { code: 'permission_denied' } });
    expect(await db.storedDocument.count({ where: { entityId: id, kind: 'EXPORT' } })).toBe(0);
  });
});
