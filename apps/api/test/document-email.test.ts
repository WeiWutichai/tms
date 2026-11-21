import type { NestExpressApplication } from '@nestjs/platform-express';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PDFDocument, PDFArray, PDFRawStream, PDFRef, type PDFPage } from 'pdf-lib';
import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { EmailDispatcher } from '../src/modules/email/email.service';
import { MemoryTransport } from '../src/modules/email/transport';
import { defaultRecipients } from '../src/modules/invoices/document-email.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import {
  api,
  bootApp,
  issuedTestFields,
  platform,
  tokenFor,
  truncateAll,
  validTaxId,
} from './helpers';

/**
 * ST5-T21 ส่งเอกสารถึงลูกค้า (docs/04 F3; spec/05 BIL-041) — เกณฑ์ตรวจรับ:
 * กดส่งแล้วลูกค้าทดสอบได้อีเมลพร้อมไฟล์รวม 1 ไฟล์เรียงตามลำดับ (ใบวางบิลก่อน แล้วใบแจ้งหนี้ตามลำดับในใบวางบิล)
 * ทางเลือก: ดาวน์โหลดไฟล์รวมแล้วส่งเอง · อีเมลออกผ่าน MemoryTransport เท่านั้น (ไม่ส่งจริง)
 */
describe('ส่งเอกสารทางอีเมล (ST5-T21)', { timeout: 600_000 }, () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherTenant: string;
  let companyId: string;
  let branchId: string;
  let customerId: string;
  let noMailCustomer: string;
  let admin: string;
  let drafter: string;
  let noPrice: string;
  let dispatcher: EmailDispatcher;
  let mail: MemoryTransport;
  let seq = 0;
  const today = bangkokToday();
  const addDays = (d: string, n: number) =>
    new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    dispatcher = app.get(EmailDispatcher);
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ส่งเอกสาร' })).id;
    otherTenant = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    companyId = (
      await db.company.create({
        data: { tenantId, legalName: 'บริษัท ผู้ส่งเอกสาร จำกัด', taxId: validTaxId(931) },
      })
    ).id;
    branchId = (
      await db.branch.create({
        data: {
          tenantId,
          companyId,
          branchCode: '00000',
          branchLabel: 'สำนักงานใหญ่',
          address: ADDR,
          isDefaultIssuer: true,
        },
      })
    ).id;
    customerId = (
      await db.customer.create({
        data: {
          tenantId,
          code: 'C-EM-1',
          legalName: 'บริษัท ลูกค้าทดสอบ จำกัด',
          taxId: validTaxId(932),
          branchCode: '00000',
          billingAddress: ADDR,
          contacts: [
            { name: 'คุณขาย', phone: '021234567', email: 'sales@cust.test' },
            { name: 'คุณบัญชี', email: 'ap@cust.test', isPrimary: true },
          ],
        },
      })
    ).id;
    noMailCustomer = (
      await db.customer.create({
        data: {
          tenantId,
          code: 'C-EM-2',
          legalName: 'ลูกค้าไม่มีอีเมล',
          taxId: validTaxId(933),
          contacts: [{ name: 'คุณโทร', phone: '021111111' }],
        },
      })
    ).id;
    admin = await tokenFor(tenantId);
    drafter = await tokenFor(tenantId, 'invoices:read invoices:draft prices.sell:read', 'u-d');
    noPrice = await tokenFor(tenantId, 'invoices:read invoices:finalize', 'u-np');
  });
  beforeEach(async () => {
    // อีเมลที่ค้างจาก test ก่อนหน้า → ส่งทิ้งก่อน (แต่ละ test นับเฉพาะของตัวเอง)
    dispatcher.use(new MemoryTransport());
    await dispatcher.drain();
    mail = new MemoryTransport();
    dispatcher.use(mail);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  async function issuedInvoice(
    total: string,
    o: { customer?: string; status?: 'ISSUED' | 'PAID' } = {},
  ) {
    const n = ++seq;
    const inv = await db.invoice.create({
      data: {
        tenantId,
        customerId: o.customer ?? customerId,
        issuingCompanyId: companyId,
        issuingBranchId: branchId,
        status: o.status ?? 'ISSUED',
        totalAmount: new Prisma.Decimal(total),
        subtotalExempt: new Prisma.Decimal(total),
        netExpectedAmount: new Prisma.Decimal(total),
        ...(o.status === 'PAID' ? { paidAmount: new Prisma.Decimal(total) } : {}),
        ...issuedTestFields(`INV-T21-${String(n).padStart(4, '0')}`),
      },
    });
    return encodeId('invoice', inv.id);
  }

  /** ใบวางบิลที่ออกแล้ว (ผ่าน API จริง — PDF ต้นฉบับเก็บตอนออก) */
  async function issuedNote(invoiceIds: string[], customer = customerId) {
    const r = await api(app, admin)
      .post('/v1/billing-notes')
      .send({
        customerId: encodeId('customer', customer),
        invoiceIds,
        collectionDate: addDays(today, 10),
      })
      .expect(201);
    const iss = await api(app, admin)
      .post(`/v1/billing-notes/${r.body.id}/finalize`)
      .set('If-Match', `"${r.body.version}"`)
      .expect(200);
    return iss.body as {
      id: string;
      billingNoteNo: string;
      version: number;
      invoices: { invoiceId: string; invoiceNo: string }[];
    };
  }

  const binary = (t: request.Test) =>
    t.buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

  /** ลายนิ้วมือเนื้อหาของแต่ละหน้า (content stream ดิบ — pdf-lib คัดลอกหน้าแบบไม่แตะเนื้อ) */
  async function pageFingerprints(pdf: Buffer): Promise<string[]> {
    const doc = await PDFDocument.load(pdf);
    const streamOf = (p: PDFPage) => {
      const c = p.node.Contents();
      const refs = c instanceof PDFArray ? c.asArray() : [c];
      const h = createHash('sha256');
      for (const r of refs) {
        const s = doc.context.lookup(r as PDFRef);
        if (s instanceof PDFRawStream) h.update(s.contents);
      }
      return h.digest('hex');
    };
    return doc.getPages().map(streamOf);
  }

  const emailRows = (entityId: string) =>
    db.documentEmail.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } });

  it('เกณฑ์ตรวจรับ: กดส่งใบวางบิล → ลูกค้าได้อีเมล 1 ฉบับ แนบไฟล์รวม 1 ไฟล์ เรียง ใบวางบิล → ใบแจ้งหนี้ตามลำดับในใบ', async () => {
    const a = await issuedInvoice('7000.00');
    const b = await issuedInvoice('3500.50');
    const c = await issuedInvoice('1200.00');
    const bn = await issuedNote([c, a, b]);
    // ลำดับในใบวางบิล (line_no) = ลำดับที่ไฟล์รวมต้องเรียง
    const order = bn.invoices.map((l) => l.invoiceId);
    expect([...order].sort()).toEqual([a, b, c].sort());
    const invNos = bn.invoices.map((l) => l.invoiceNo);

    const r = await api(app, admin).post(`/v1/billing-notes/${bn.id}/send`).send({}).expect(200);
    // ผู้รับตั้งต้น = ผู้ติดต่อหลักที่มีอีเมล
    expect(r.body.emails.map((e: { to: string }) => e.to)).toEqual(['ap@cust.test']);
    expect(r.body.emails[0]).toMatchObject({
      entityType: 'billing_note',
      entityId: bn.id,
      purpose: 'DOCUMENT',
      documentNo: bn.billingNoteNo,
      status: 'QUEUED',
      failedReason: null,
    });
    expect(r.body.attachment.contents).toEqual([bn.billingNoteNo, ...invNos]);
    expect(r.body.attachment.filename).toBe(`${bn.billingNoteNo}-ชุดเอกสาร.pdf`);

    // worker ส่ง → ลูกค้าทดสอบได้อีเมลพร้อมไฟล์แนบ 1 ไฟล์
    await dispatcher.drain();
    expect(mail.sent).toHaveLength(1);
    const m = mail.sent[0]!;
    expect(m.to).toBe('ap@cust.test');
    expect(m.subject).toContain(`ใบวางบิล ${bn.billingNoteNo}`);
    expect(m.text).toContain(invNos.join(', '));
    expect(m.attachments).toHaveLength(1);
    const att = m.attachments![0]!;
    expect(att.contentType).toBe('application/pdf');
    expect(att.filename).toBe(`${bn.billingNoteNo}-ชุดเอกสาร.pdf`);
    expect(createHash('sha256').update(att.content).digest('hex')).toBe(r.body.attachment.sha256);

    // ลำดับหน้า = ใบวางบิล (ต้นฉบับที่เก็บ) แล้วใบแจ้งหนี้ c, a, b (ต้นฉบับที่เก็บ) — ไม่ render ใหม่
    const bnPdf = await binary(api(app, admin).get(`/v1/billing-notes/${bn.id}/pdf`)).expect(200);
    const parts = [bnPdf.body as Buffer];
    for (const id of order)
      parts.push((await binary(api(app, admin).get(`/v1/invoices/${id}/pdf`)).expect(200)).body);
    const expected = (await Promise.all(parts.map(pageFingerprints))).flat();
    expect(await pageFingerprints(att.content)).toEqual(expected);

    // ดาวน์โหลดไฟล์รวม (ส่งเอง) = ไฟล์เดียวกับที่แนบ
    const dl = await binary(api(app, admin).get(`/v1/billing-notes/${bn.id}/pdf-bundle`)).expect(
      200,
    );
    expect(dl.headers['content-type']).toContain('application/pdf');
    expect(Buffer.compare(dl.body as Buffer, att.content)).toBe(0);
    expect(decodeURIComponent(dl.headers['x-bundle-contents']!).split(',')).toEqual([
      bn.billingNoteNo,
      ...invNos,
    ]);

    // สถานะการส่ง (แยกจากสถานะเอกสาร) + ประวัติ + audit
    const hist = await api(app, drafter).get(`/v1/billing-notes/${bn.id}/emails`).expect(200);
    expect(hist.body.data).toHaveLength(1);
    expect(hist.body.data[0]).toMatchObject({ status: 'SENT', to: 'ap@cust.test' });
    expect(hist.body.data[0].sentAt).toBeTruthy();
    const bnRow = await db.billingNote.findUniqueOrThrow({
      where: { id: tryDecodeId('billingNote', bn.id)! },
    });
    expect(bnRow.status).toBe('ISSUED');
    const audit = await db.auditLog.findFirstOrThrow({
      where: { tenantId, entityId: bnRow.id, action: 'billing_note.emailed' },
    });
    expect(audit.after).toMatchObject({ to: ['ap@cust.test'], documentNo: bn.billingNoteNo });
    // ใบแจ้งหนี้ได้ธง "ส่งลูกค้าแล้ว" ตั้งแต่ออกใบวางบิล (BILLING_NOTE) — ส่งอีเมลไม่เปลี่ยนช่องทาง
    const invRows = await db.invoice.findMany({
      where: { id: { in: [a, b, c].map((x) => tryDecodeId('invoice', x)!) } },
    });
    expect(invRows.map((x) => x.sentToCustomerChannel)).toEqual([
      'BILLING_NOTE',
      'BILLING_NOTE',
      'BILLING_NOTE',
    ]);
    // ไฟล์รวมเก็บเป็น stored_document · ส่งซ้ำได้ไฟล์เดิม (sha256 เดิม → แถวเดิม)
    const again = await api(app, admin)
      .post(`/v1/billing-notes/${bn.id}/send`)
      .send({ to: ['other@cust.test'] })
      .expect(200);
    expect(again.body.attachment.documentId).toBe(r.body.attachment.documentId);
  });

  it('ผู้รับหลายคน · กันกดส่งซ้ำระหว่างรอส่ง (409) · Idempotency-Key = ผลเดิม ไม่ส่งซ้ำ', async () => {
    const bn = await issuedNote([await issuedInvoice('500.00')]);
    const key = randomUUID();
    const send = (to: string[], k?: string) => {
      const t = api(app, admin).post(`/v1/billing-notes/${bn.id}/send`);
      return (k ? t.set('Idempotency-Key', k) : t).send({ to });
    };
    const r = await send(['x1@cust.test', 'x2@cust.test'], key).expect(200);
    expect(r.body.emails.map((e: { to: string }) => e.to)).toEqual([
      'x1@cust.test',
      'x2@cust.test',
    ]);
    const replay = await send(['x1@cust.test', 'x2@cust.test'], key).expect(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(await emailRows(tryDecodeId('billingNote', bn.id)!)).toHaveLength(2);
    const dup = await send(['X1@cust.test']).expect(409);
    expect(dup.body.code).toBe('document_email_pending');
    expect(dup.body.pending[0].to).toBe('x1@cust.test');
    await dispatcher.drain();
    expect(mail.sent.map((m) => m.to).sort()).toEqual(['x1@cust.test', 'x2@cust.test']);
    // ส่งออกไปแล้ว → ส่งซ้ำได้
    await send(['x1@cust.test']).expect(200);
  });

  it('ตรวจ: ร่าง/ยกเลิก 409 · ไม่มีอีเมลผู้ติดต่อ 422 · อีเมลผิด/ซ้ำ/เกิน 5 → 422 · ไฟล์ใหญ่เกิน 422 · สิทธิ์', async () => {
    const draft = await api(app, admin)
      .post('/v1/billing-notes')
      .send({
        customerId: encodeId('customer', customerId),
        invoiceIds: [await issuedInvoice('10.00')],
      })
      .expect(201);
    expect(
      (await api(app, admin).post(`/v1/billing-notes/${draft.body.id}/send`).send({}).expect(409))
        .body.code,
    ).toBe('invalid_state_transition');
    await api(app, admin).get(`/v1/billing-notes/${draft.body.id}/pdf-bundle`).expect(409);

    const nm = await issuedNote(
      [await issuedInvoice('20.00', { customer: noMailCustomer })],
      noMailCustomer,
    );
    const no = await api(app, admin).post(`/v1/billing-notes/${nm.id}/send`).send({}).expect(422);
    expect(no.body.code).toBe('document_email_no_recipient');
    // ระบุ to เองได้
    await api(app, admin)
      .post(`/v1/billing-notes/${nm.id}/send`)
      .send({ to: ['p@x.test'] })
      .expect(200);

    const bn = await issuedNote([await issuedInvoice('30.00')]);
    const url = `/v1/billing-notes/${bn.id}/send`;
    await api(app, admin)
      .post(url)
      .send({ to: ['not-an-email'] })
      .expect(422);
    await api(app, admin)
      .post(url)
      .send({ to: ['a@x.test', 'A@x.test'] })
      .expect(422);
    await api(app, admin).post(url).send({ to: [] }).expect(422);
    await api(app, admin)
      .post(url)
      .send({ to: ['1@x.test', '2@x.test', '3@x.test', '4@x.test', '5@x.test', '6@x.test'] })
      .expect(422);
    process.env.EMAIL_ATTACHMENT_MAX_BYTES = '1000';
    try {
      const big = await api(app, admin).post(url).send({}).expect(422);
      expect(big.body).toMatchObject({ code: 'email_attachment_too_large', maxBytes: 1000 });
    } finally {
      delete process.env.EMAIL_ATTACHMENT_MAX_BYTES;
    }
    // สิทธิ์: ไม่มี invoices:finalize → 403 · ไม่มี prices.sell:read → 403
    await api(app, drafter).post(url).send({}).expect(403);
    await api(app, noPrice).post(url).send({}).expect(403);
    await api(app, noPrice).get(`/v1/billing-notes/${bn.id}/pdf-bundle`).expect(403);
    // ข้าม tenant → 404
    const other = await tokenFor(otherTenant);
    await api(app, other).post(url).send({}).expect(404);
    await api(app, other).get(`/v1/billing-notes/${bn.id}/pdf-bundle`).expect(404);
    // ไม่มีการส่งใดเกิดจากคำขอที่ไม่ผ่าน
    expect(await emailRows(tryDecodeId('billingNote', bn.id)!)).toHaveLength(0);

    // ยกเลิกใบวางบิลแล้ว → ส่งไม่ได้
    await api(app, admin)
      .post(`/v1/billing-notes/${bn.id}/cancel`)
      .set('If-Match', `"${bn.version}"`)
      .send({ reason: 'ทดสอบยกเลิกก่อนส่ง' })
      .expect(200);
    await api(app, admin).post(url).send({}).expect(409);
  });

  it('ใบแจ้งหนี้รายใบ: แนบต้นฉบับที่เก็บ · ตั้งธง "ส่งลูกค้าแล้ว" ช่องทาง EMAIL · ใบแจ้งเตือนชำระเฉพาะใบที่ค้าง', async () => {
    const id = await issuedInvoice('4500.00');
    const raw = tryDecodeId('invoice', id)!;
    const r = await api(app, admin).post(`/v1/invoices/${id}/send`).send({}).expect(200);
    expect(r.body.emails[0]).toMatchObject({
      to: 'ap@cust.test',
      purpose: 'DOCUMENT',
      entityType: 'invoice',
    });
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: raw } });
    expect(inv.sentToCustomerChannel).toBe('EMAIL');
    expect(inv.sentToCustomerAt).not.toBeNull();
    // ไฟล์แนบ = ต้นฉบับที่เก็บ (sha256 เดียวกับ GET /pdf)
    const pdf = await api(app, admin).get(`/v1/invoices/${id}/pdf`).expect(200);
    expect(r.body.attachment.sha256).toBe(pdf.headers['x-content-sha256']);
    expect(r.body.attachment.documentId).toBe(encodeId('document', inv.pdfDocumentId!));
    await dispatcher.drain();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.subject).toContain(`ใบแจ้งหนี้ ${inv.invoiceNo}`);
    expect(mail.sent[0]!.attachments![0]!.filename).toBe(`${inv.invoiceNo}.pdf`);
    // ส่งแล้ว → ยกเลิกใบไม่ได้ (ST5-T18)
    const v = await api(app, admin)
      .post(`/v1/invoices/${id}/void`)
      .set('If-Match', `"${inv.version}"`)
      .send({ reason: 'ทดสอบยกเลิกหลังส่งอีเมล', reissue: false });
    expect(v.status).toBe(409);
    expect(v.body.code).toBe('invoice_sent_to_customer');

    // ใบแจ้งเตือนชำระ (ต้นแบบหน้า "รับชำระ")
    const rem = await api(app, admin)
      .post(`/v1/invoices/${id}/send`)
      .send({ purpose: 'PAYMENT_REMINDER', to: ['ap@cust.test'] })
      .expect(200);
    expect(rem.body.emails[0].purpose).toBe('PAYMENT_REMINDER');
    await dispatcher.drain();
    expect(mail.sent[1]!.subject).toContain(`แจ้งเตือนชำระ ใบแจ้งหนี้ ${inv.invoiceNo}`);
    const paid = await issuedInvoice('100.00', { status: 'PAID' });
    const nr = await api(app, admin)
      .post(`/v1/invoices/${paid}/send`)
      .send({ purpose: 'PAYMENT_REMINDER' })
      .expect(409);
    expect(nr.body).toMatchObject({ code: 'invalid_state_transition', reason: 'not_outstanding' });
    // ใบที่ชำระแล้วยังส่งเอกสารได้
    await api(app, admin).post(`/v1/invoices/${paid}/send`).send({}).expect(200);
    const hist = await api(app, admin).get(`/v1/invoices/${id}/emails`).expect(200);
    expect(hist.body.data.map((e: { purpose: string }) => e.purpose)).toEqual([
      'PAYMENT_REMINDER',
      'DOCUMENT',
    ]);
    const audit = await db.auditLog.count({ where: { entityId: raw, action: 'invoice.emailed' } });
    expect(audit).toBe(2);
  });

  it('สถานะการส่ง: ส่งไม่สำเร็จ → FAILED ไม่กระทบสถานะเอกสาร · sandbox ไม่ส่งออกจริง (sandbox_suppressed)', async () => {
    const id = await issuedInvoice('800.00');
    await api(app, admin)
      .post(`/v1/invoices/${id}/send`)
      .send({ to: ['fail@cust.test'] })
      .expect(200);
    const failing = { name: 'fail', send: async () => Promise.reject(new Error('smtp down')) };
    dispatcher.use(failing);
    // ลองครบ 5 ครั้ง (ข้าม backoff ด้วยการเลื่อน run_at)
    for (let i = 0; i < 5; i++) {
      await db.emailOutbox.updateMany({
        where: { tenantId, status: 'PENDING' },
        data: { runAt: new Date(0) },
      });
      await dispatcher.drain();
    }
    const [row] = await emailRows(tryDecodeId('invoice', id)!);
    expect(row).toMatchObject({ status: 'FAILED', failedReason: 'email_failed' });
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: tryDecodeId('invoice', id)! } });
    expect(inv.status).toBe('ISSUED');

    // sandbox: tenant mode=test → dispatcher ไม่ส่ง · document_email = FAILED sandbox_suppressed
    const sb = (
      await db.tenant.create({
        data: { name: 'บริษัท ส่งเอกสาร (Sandbox)', mode: 'test', liveTenantId: tenantId },
      })
    ).id;
    const outboxId = randomUUID();
    await db.emailOutbox.create({
      data: {
        id: outboxId,
        tenantId: sb,
        toAddress: 'customer@cust.test',
        template: 'customer_document',
        locale: 'th',
        subject: 's',
        textBody: 't',
        htmlBody: 'h',
        attachments: [
          { fileKey: `${sb}/x.pdf`, filename: 'x.pdf', contentType: 'application/pdf' },
        ],
      },
    });
    const de = await db.documentEmail.create({
      data: {
        tenantId: sb,
        entityType: 'invoice',
        entityId: randomUUID(),
        purpose: 'DOCUMENT',
        documentNo: 'TEST-INV-1',
        toAddress: 'customer@cust.test',
        attachmentDocumentId: randomUUID(),
        emailOutboxId: outboxId,
      },
    });
    mail = new MemoryTransport();
    dispatcher.use(mail);
    await dispatcher.drain();
    expect(mail.sent).toEqual([]);
    expect(await db.documentEmail.findUniqueOrThrow({ where: { id: de.id } })).toMatchObject({
      status: 'FAILED',
      failedReason: 'sandbox_suppressed',
    });
  });

  it('dispatcher ไม่แนบไฟล์นอก tenant ของอีเมล', async () => {
    const id = randomUUID();
    await db.emailOutbox.create({
      data: {
        id,
        tenantId,
        toAddress: 'x@cust.test',
        template: 'customer_document',
        locale: 'th',
        subject: 's',
        textBody: 't',
        htmlBody: 'h',
        maxAttempts: 1,
        attachments: [
          { fileKey: `${otherTenant}/abc.pdf`, filename: 'x.pdf', contentType: 'application/pdf' },
        ],
      },
    });
    await dispatcher.drain();
    expect(mail.sent).toEqual([]);
    expect(await db.emailOutbox.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'FAILED',
      error: 'attachment outside tenant',
    });
  });

  it('ผู้รับตั้งต้น: ผู้ติดต่อหลักที่มีอีเมล · ไม่มี → ทุกคนที่มีอีเมล (ไม่ซ้ำ สูงสุด 5)', () => {
    expect(
      defaultRecipients([
        { name: 'a', email: 'a@x.test' },
        { name: 'b', email: 'b@x.test', isPrimary: true },
      ]),
    ).toEqual(['b@x.test']);
    expect(
      defaultRecipients([
        { name: 'a', email: 'a@x.test' },
        { name: 'b', isPrimary: true },
        { name: 'c', email: 'A@x.test' },
        ...[1, 2, 3, 4, 5].map((n) => ({ name: `${n}`, email: `${n}@x.test` })),
      ]),
    ).toEqual(['a@x.test', '1@x.test', '2@x.test', '3@x.test', '4@x.test']);
    expect(defaultRecipients([])).toEqual([]);
    expect(defaultRecipients(null)).toEqual([]);
  });
});
