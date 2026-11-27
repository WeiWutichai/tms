import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService } from '../src/db/db.service';
import { InvoicePdfService } from '../src/modules/invoices/invoice-pdf.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);
const EVIL_SVG = Buffer.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="alert(1)" viewBox="0 0 10 10"><script>alert(document.cookie)</script><foreignObject><iframe src="https://evil.example"/></foreignObject><image xlink:href="https://evil.example/t.png"/><rect width="10" height="10" fill="#13213F" onclick="x()"/></svg>',
);

/**
 * P1-ST6-T04 โลโก้องค์กร: อัปโหลด PNG/SVG ≤ 2 MB (kind LOGO) · SVG ถูกล้าง · ค่าตั้ง `org.logoDocumentId` (ref ไฟล์ของบริษัทนี้เท่านั้น)
 * · ใบแจ้งหนี้ตรึงโลโก้ ณ วันออก · หน้าติดตามสาธารณะได้ URL โลโก้ (D68-93) · แยก tenant
 */
describe('โลโก้องค์กร (P1-ST6-T04)', { timeout: 300_000 }, () => {
  let app: NestExpressApplication;
  const plat = platform();
  let tenantId: string;
  let otherTenantId: string;
  let admin: string;
  let other: string;
  let accounting: string;

  const path = (url: string) => new URL(url).pathname + new URL(url).search;
  const put = (url: string, data: Buffer) =>
    request(app.getHttpServer())
      .put(path(url))
      .set('Content-Type', 'application/octet-stream')
      .send(data);
  const upload = async (tok: string, mime: string, data: Buffer, kind = 'LOGO') => {
    const r = await api(app, tok)
      .post('/v1/documents')
      .send({ kind, mime, bytes: data.length, filename: 'logo' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const up = await put(r.body.uploadUrl, data);
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    return r.body.id as string;
  };
  const content = async (tok: string, id: string) => {
    const meta = await api(app, tok).get(`/v1/documents/${id}`).expect(200);
    return request(app.getHttpServer())
      .get(path(meta.body.downloadUrl))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
  };
  const setLogo = (tok: string, value: string | null) =>
    api(app, tok)
      .patch('/v1/settings')
      .send({ values: { 'org.logoDocumentId': value } });

  beforeAll(async () => {
    process.env.FILES_ROOT = mkdtempSync(join(tmpdir(), 'tms-logo-'));
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(plat, { name: 'ศรีไทยขนส่ง' })).id;
    otherTenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท อื่น' })).id;
    admin = await tokenFor(tenantId);
    other = await tokenFor(otherTenantId);
    accounting = await tokenFor(tenantId, SYSTEM_ROLES.accounting.permissions.join(' '), 'u-acc');
  });
  afterAll(async () => {
    await app.close();
    await plat.$disconnect();
  });

  it('ขนาด/ชนิด: LOGO รับ PNG/SVG ≤ 2 MB เท่านั้น · SVG ใช้กับ kind อื่นไม่ได้ · HTML ปลอมเป็น SVG = mime_mismatch', async () => {
    const reserve = (body: object) => api(app, admin).post('/v1/documents').send(body);
    const jpeg = await reserve({ kind: 'LOGO', mime: 'image/jpeg', bytes: 100 });
    expect(jpeg.status).toBe(422);
    expect(jpeg.body.errors[0]).toMatchObject({ field: 'mime', code: 'mime_not_allowed' });
    const big = await reserve({ kind: 'LOGO', mime: 'image/png', bytes: 2 * 1024 * 1024 + 1 });
    expect(big.status).toBe(422);
    expect(big.body.errors[0]).toMatchObject({ field: 'bytes', code: 'file_too_large' });
    await reserve({ kind: 'LOGO', mime: 'image/png', bytes: 2 * 1024 * 1024 }).expect(201);
    const svgOther = await reserve({ kind: 'OTHER', mime: 'image/svg+xml', bytes: 100 });
    expect(svgOther.status).toBe(422);
    expect(svgOther.body.errors[0].code).toBe('mime_not_allowed');
    const html = Buffer.from('<html><body><script>alert(1)</script></body></html>');
    const r = await reserve({ kind: 'LOGO', mime: 'image/svg+xml', bytes: html.length });
    const bad = await put(r.body.uploadUrl, html);
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0].code).toBe('mime_mismatch');
  });

  it('SVG ที่มี script / event handler / อ้างภายนอก / foreignObject → เก็บฉบับที่ล้างแล้ว · ดาวน์โหลดมี CSP sandbox', async () => {
    const id = await upload(admin, 'image/svg+xml', EVIL_SVG);
    const dl = await content(admin, id);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toMatch(/^image\/svg\+xml/);
    expect(dl.headers['content-security-policy']).toMatch(/sandbox/);
    const body = (dl.body as Buffer).toString('utf8');
    expect(body).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(body).not.toMatch(
      /script|alert|onload|onclick|foreignObject|iframe|evil\.example|<image/i,
    );
    expect(body).toContain('<rect width="10" height="10" fill="#13213F"/>');
    // sha256 ของไฟล์ที่เก็บ = ฉบับที่ล้างแล้ว (ไม่ใช่ของที่อัปโหลด)
    const row = await plat.storedDocument.findUniqueOrThrow({
      where: { id: tryDecodeId('document', id)! },
    });
    expect(row.sizeBytes).toBe(Buffer.byteLength(body));
  });

  it('ค่าตั้ง org.logoDocumentId: ต้องเป็นโลโก้ที่พร้อมของบริษัทนี้ (kind อื่น / ยังไม่อัปโหลด / ของ tenant อื่น = 422) · ตั้ง/ล้างได้ + audit', async () => {
    const pdfDoc = await upload(admin, 'application/pdf', Buffer.from('%PDF-1.4\n%%EOF\n'), 'PDF');
    expect((await setLogo(admin, pdfDoc)).status).toBe(422);
    const pending = await api(app, admin)
      .post('/v1/documents')
      .send({ kind: 'LOGO', mime: 'image/png', bytes: PNG.length });
    expect((await setLogo(admin, pending.body.id)).status).toBe(422);
    expect((await setLogo(admin, 'cmp_0123456789abcdef0123456789abcdef')).status).toBe(422);
    // แยก tenant: โลโก้ของบริษัทอื่น (RLS มองไม่เห็น) = 422 เหมือนไม่มี
    const theirs = await upload(other, 'image/png', PNG);
    const cross = await setLogo(admin, theirs);
    expect(cross.status).toBe(422);
    expect(cross.body.errors[0]).toMatchObject({
      field: 'values.org.logoDocumentId',
      code: 'invalid_setting',
    });
    const mine = await upload(admin, 'image/png', PNG);
    const ok = await setLogo(admin, mine);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(
      (ok.body.data as { key: string; value: unknown }[]).find(
        (s) => s.key === 'org.logoDocumentId',
      )?.value,
    ).toBe(mine);
    const audit = await plat.auditLog.findFirst({
      where: { tenantId, action: 'tenant_setting.updated', entityId: 'org.logoDocumentId' },
    });
    expect(audit?.after).toEqual({ 'org.logoDocumentId': mine });
    // tenant อื่นไม่เห็นค่าตั้ง/ไฟล์ของบริษัทนี้
    const theirSettings = await api(app, other).get('/v1/settings').expect(200);
    expect(JSON.stringify(theirSettings.body)).not.toContain(mine);
    await api(app, other).get(`/v1/documents/${mine}`).expect(404);
    expect((await setLogo(admin, null)).status).toBe(200);
  });

  it('ใบแจ้งหนี้ตรึงโลโก้ ณ วันออก (print_options) — เปลี่ยนโลโก้ภายหลังไม่กระทบใบที่ออกแล้ว · ใบที่ออกตอนไม่มีโลโก้ = ไม่มีโลโก้ตลอด', async () => {
    const company = await plat.company.create({
      data: { tenantId, legalName: 'บริษัท ศรีไทยขนส่ง จำกัด', taxId: validTaxId(8101) },
    });
    const branch = await plat.branch.create({
      data: {
        tenantId,
        companyId: company.id,
        branchCode: '00000',
        branchLabel: 'สำนักงานใหญ่',
        isDefaultIssuer: true,
        address: { line1: '1', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' },
      },
    });
    const customer = await plat.customer.create({
      data: {
        tenantId,
        code: 'C-LOGO',
        legalName: 'บริษัท ลูกค้า จำกัด',
        taxId: validTaxId(8102),
        branchCode: '00000',
      },
    });
    const serviceItemId = (
      await plat.serviceItem.findFirstOrThrow({
        where: { tenantId, vatType: 'EXEMPT_TRANSPORT', status: 'ACTIVE', deletedAt: null },
      })
    ).id;
    const issue = async () => {
      const inv = await plat.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          issuingCompanyId: company.id,
          issuingBranchId: branch.id,
          status: 'DRAFT',
          creditTermDays: 30,
          createdBy: 'u-prep',
          lines: {
            create: {
              tenantId,
              lineNo: 1,
              serviceItemId,
              description: 'ค่าขนส่ง',
              quantity: '1',
              unitLabel: 'เที่ยว',
              unitPrice: '1000.00',
              amount: '1000.00',
              vatType: 'EXEMPT_TRANSPORT',
              vatAmount: '0',
              whtRate: '1.00',
              isUserAdded: true,
            },
          },
        },
      });
      const r = await api(app, accounting)
        .post(`/v1/invoices/${encodeId('invoice', inv.id)}/finalize`)
        .set('If-Match', `"${inv.version}"`)
        .send({});
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return plat.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    };
    const model = (inv: { id: string; issueDate: Date | null; dueDate: Date | null }) =>
      requestContext.run({ requestId: 'logo-test', tenantId, actorId: 'test', locale: 'th' }, () =>
        app.get(DbService).withTenant(tenantId, async (tx) => {
          const ctx = requestContext.require();
          ctx.tx = tx as never;
          return (
            await app.get(InvoicePdfService).loadModel(tx, inv.id, {
              issueDate: inv.issueDate!.toISOString().slice(0, 10),
              dueDate: inv.dueDate!.toISOString().slice(0, 10),
              copy: 'COPY',
            })
          ).model;
        }),
      );
    // ไม่มีโลโก้ตอนออก
    const before = await issue();
    expect((before.printOptions as Record<string, unknown>).logoDocumentId).toBeUndefined();
    const a = await upload(admin, 'image/png', PNG);
    await setLogo(admin, a).expect(200);
    const withA = await issue();
    expect((withA.printOptions as Record<string, unknown>).logoDocumentId).toBe(
      tryDecodeId('document', a),
    );
    // เปลี่ยนเป็นโลโก้ B
    const b = await upload(admin, 'image/svg+xml', EVIL_SVG);
    await setLogo(admin, b).expect(200);
    expect((await model(before)).logo ?? null).toBeNull();
    expect((await model(withA)).logo).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
  });

  it('หน้าติดตามสาธารณะ (D68-93): company.logoUrl ลายเซ็นอายุสั้น → รูป (inline, nosniff, CSP sandbox) · แก้ลายเซ็น = 404 · ไม่ตั้ง = null', async () => {
    const svg = await upload(admin, 'image/svg+xml', EVIL_SVG);
    await setLogo(admin, svg).expect(200);
    const cust = await plat.customer.create({
      data: { tenantId, code: 'C-TRK', legalName: 'บริษัท ผู้รับ จำกัด', taxId: validTaxId(8103) },
    });
    const link = await api(app, admin)
      .post(`/v1/customers/${encodeId('customer', cust.id)}/tracking-link`)
      .send({ reason: 'ออกลิงก์ใหม่สำหรับทดสอบ' });
    expect(link.status, JSON.stringify(link.body)).toBe(201);
    const token = new URL(link.body.url).pathname.split('/').pop()!;
    const v = await request(app.getHttpServer()).get(`/v1/public/tracking/${token}`).expect(200);
    const url = v.body.company.logoUrl as string;
    expect(url).toMatch(/\/v1\/public\/tracking\/logo\/doc_[0-9a-f]{32}\?t=.+&exp=\d+&sig=/);
    const img = await request(app.getHttpServer())
      .get(path(url))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toMatch(/^image\/svg\+xml/);
    expect(img.headers['content-disposition']).toBe('inline');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(img.headers['content-security-policy']).toMatch(/sandbox/);
    expect((img.body as Buffer).toString('utf8')).not.toMatch(/script|onload/i);
    await request(app.getHttpServer())
      .get(path(url).replace(/sig=[^&]+/, 'sig=AAAA'))
      .expect(404);
    // URL ของไฟล์อื่น (ไม่ใช่ LOGO) ที่ลายเซ็นถูกก็ไม่ได้ผ่านทางนี้
    const pdf = await upload(admin, 'application/pdf', Buffer.from('%PDF-1.4\n%%EOF\n'), 'PDF');
    const { signDocumentUrl } = await import('../src/modules/documents/signed-url');
    const s = signDocumentUrl('preview', tenantId, tryDecodeId('document', pdf)!, 60);
    await request(app.getHttpServer())
      .get(`/v1/public/tracking/logo/${pdf}?${s.query}`)
      .expect(404);
    await setLogo(admin, null).expect(200);
    const none = await request(app.getHttpServer()).get(`/v1/public/tracking/${token}`).expect(200);
    expect(none.body.company.logoUrl).toBeNull();
  });
});
