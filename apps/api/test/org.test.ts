import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/db/prisma.service';
import {
  ensureDefaultSeries,
  formatNumber,
  issueNumber,
  periodKey,
} from '../src/modules/sequences/sequences.service';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll, validTaxId } from './helpers';

const ADDR = {
  line1: '1/1 ถนนตัวอย่าง',
  subdistrict: 'ตัวอย่าง',
  district: 'เมืองตัวอย่าง',
  province: 'กรุงเทพมหานคร',
  postcode: '10000',
};

/** ST1-T14 นิติบุคคล/สาขา · ST1-T15 เลขเอกสาร · ST1-T22 audit log */
describe('องค์กร: นิติบุคคล สาขา เลขเอกสาร audit', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let admin: string;
  let tax = 9000;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenant(db)).id;
    await ensureDefaultSeries(db, tenantId);
    admin = await tokenFor(tenantId, 'settings:read settings:write companies:read audit:read');
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const newCompany = async (name: string) =>
    (
      await api(app, admin)
        .post('/v1/companies')
        .send({ legalName: name, taxId: validTaxId(++tax) })
        .expect(201)
    ).body;
  const newBranch = (companyId: string, branchCode: string, extra: object = {}) =>
    api(app, admin)
      .post('/v1/branches')
      .send({ companyId, branchCode, address: ADDR, ...extra });

  describe('T14 นิติบุคคลและสาขา', () => {
    it('เลขผู้เสียภาษีผิด checksum → 422', async () => {
      const bad = validTaxId(1).slice(0, 12) + String((Number(validTaxId(1)[12]) + 1) % 10);
      const res = await api(app, admin)
        .post('/v1/companies')
        .send({ legalName: 'บริษัท ผิด จำกัด', taxId: bad });
      expect(res.status).toBe(422);
      expect(res.body.errors[0].field).toBe('taxId');
    });

    it('สร้าง 2 นิติบุคคล + สาขา 00000/00001 ได้; สาขาแรกเป็น default', async () => {
      const a = await newCompany('บริษัท เอ จำกัด');
      const b = await newCompany('บริษัท บี จำกัด');
      const hq = (await newBranch(a.id, '00000').expect(201)).body;
      const br1 = (await newBranch(a.id, '00001').expect(201)).body;
      const hqB = (await newBranch(b.id, '00000').expect(201)).body;
      expect(hq).toMatchObject({
        branchLabel: 'สำนักงานใหญ่',
        isDefaultIssuer: true,
        issuesTaxInvoice: true,
      });
      expect(br1).toMatchObject({ branchLabel: 'สาขาที่ 00001', isDefaultIssuer: false });
      expect(hqB.isDefaultIssuer).toBe(true);
      const list = await api(app, admin).get(`/v1/branches?companyId=${a.id}`).expect(200);
      expect(list.body.data.map((x: { branchCode: string }) => x.branchCode).sort()).toEqual([
        '00000',
        '00001',
      ]);
    });

    it('รหัสสาขาซ้ำในนิติบุคคลเดียวกัน → 409; รหัสไม่ใช่ 5 หลัก → 422', async () => {
      const a = await newCompany('บริษัท ซี จำกัด');
      await newBranch(a.id, '00000').expect(201);
      expect((await newBranch(a.id, '00000')).status).toBe(409);
      expect((await newBranch(a.id, '0001')).status).toBe(422);
    });

    it('ตั้ง default ใหม่ → ตัวเดิมถูกปลด (1 ต่อนิติบุคคล); สำนักงานใหญ่ปิดการออกใบกำกับไม่ได้', async () => {
      const a = await newCompany('บริษัท ดี จำกัด');
      const hq = (await newBranch(a.id, '00000').expect(201)).body;
      const off = (await newBranch(a.id, '00003', { issuesTaxInvoice: false }).expect(201)).body;
      expect(off.issuesTaxInvoice).toBe(false);
      const br = (await newBranch(a.id, '00002').expect(201)).body;
      await api(app, admin)
        .patch(`/v1/branches/${br.id}`)
        .send({ isDefaultIssuer: true })
        .expect(200);
      const hq2 = (await api(app, admin).get(`/v1/branches/${hq.id}`).expect(200)).body;
      expect(hq2.isDefaultIssuer).toBe(false);
      const res = await api(app, admin)
        .patch(`/v1/branches/${hq.id}`)
        .send({ issuesTaxInvoice: false });
      expect(res.status).toBe(422);
      // If-Match เก่า → 412
      const stale = await api(app, admin)
        .patch(`/v1/branches/${hq.id}`)
        .set('If-Match', '"1"')
        .send({ branchLabel: 'สนญ.' });
      expect(stale.status).toBe(412);
    });

    it('ตั้ง default พร้อมกัน 2 สาขา → เหลือ default 1 สาขา', async () => {
      const a = await newCompany('บริษัท พร้อมกัน จำกัด');
      await newBranch(a.id, '00000').expect(201);
      const b1 = (await newBranch(a.id, '00001').expect(201)).body;
      const b2 = (await newBranch(a.id, '00002').expect(201)).body;
      const res = await Promise.all(
        [b1, b2].map((b) =>
          api(app, admin).patch(`/v1/branches/${b.id}`).send({ isDefaultIssuer: true }),
        ),
      );
      expect(res.map((r) => r.status).every((s) => s === 200 || s === 409 || s === 412)).toBe(true);
      const list = await api(app, admin).get(`/v1/branches?companyId=${a.id}`).expect(200);
      expect(
        list.body.data.filter((x: { isDefaultIssuer: boolean }) => x.isDefaultIssuer),
      ).toHaveLength(1);
    });

    it('สาขา default ต้องออกใบกำกับเอง', async () => {
      const a = await newCompany('บริษัท ดีฟอลต์ จำกัด');
      await newBranch(a.id, '00000').expect(201);
      const bad = await newBranch(a.id, '00001', {
        isDefaultIssuer: true,
        issuesTaxInvoice: false,
      });
      expect(bad.status).toBe(422);
      expect(bad.body.errors[0].code).toBe('default_must_issue');
      const br = (await newBranch(a.id, '00002', { isDefaultIssuer: true }).expect(201)).body;
      const off = await api(app, admin)
        .patch(`/v1/branches/${br.id}`)
        .send({ issuesTaxInvoice: false });
      expect(off.status).toBe(422);
    });

    it('อ่านได้ด้วย companies:read แต่แก้ไม่ได้', async () => {
      const ro = await tokenFor(tenantId, 'companies:read');
      expect((await api(app, ro).get('/v1/branches')).status).toBe(200);
      const a = await newCompany('บริษัท อี จำกัด');
      expect(
        (
          await api(app, ro)
            .post('/v1/branches')
            .send({ companyId: a.id, branchCode: '00000', address: ADDR })
        ).status,
      ).toBe(403);
    });
  });

  describe('T15 เลขเอกสาร', () => {
    const prisma = new PrismaService();
    const at = new Date('2026-11-10T03:00:00Z');
    afterAll(() => prisma.onModuleDestroy?.());

    const inTenant = <T>(fn: (tx: any) => Promise<T>) =>
      prisma.app.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
          return fn(tx);
        },
        // 50 transaction พร้อมกันเกิน pool (CPU×2+1) → ต่อคิวรอ connection ได้นานกว่าค่าเริ่ม 2 วินาที
        { maxWait: 30_000, timeout: 30_000 },
      );

    it('งวดและรูปแบบเลขตามปี พ.ศ. เวลาไทย', () => {
      // 31 ต.ค. 2569 20:00 UTC = 1 พ.ย. 03:00 เวลาไทย → งวด 2611
      const edge = new Date('2026-10-31T20:00:00Z');
      expect(periodKey('MONTHLY', edge, 'BE')).toBe('6911'); // พ.ศ. 2569 → 69
      expect(periodKey('YEARLY', edge, 'CE')).toBe('2026');
      expect(
        formatNumber(
          { prefix: 'INV-{BR}-', resetPolicy: 'MONTHLY', padding: 4 },
          42,
          edge,
          'BE',
          '00000',
        ),
      ).toBe('INV-00000-6911-0042');
    });

    it('ออกเลขพร้อมกัน 50 request ได้เลขเรียงไม่ซ้ำไม่ข้าม', async () => {
      const nums = await Promise.all(
        Array.from({ length: 50 }, () =>
          inTenant((tx) => issueNumber(tx, tenantId, { docType: 'SO', at })),
        ),
      );
      const seq = nums.map((n) => Number(n.split('-').pop())).sort((a, b) => a - b);
      expect(seq).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
      expect(nums[0]).toMatch(/^SO-6911-\d{4}$/);
    }, 60_000);

    it('rollback แล้วเลขไม่ถูกใช้', async () => {
      await expect(
        inTenant(async (tx) => {
          await issueNumber(tx, tenantId, { docType: 'DO', at });
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await inTenant((tx) => issueNumber(tx, tenantId, { docType: 'DO', at }))).toBe(
        'DO-6911-0001',
      );
    });

    it('เอกสารภาษีนับแยกต่อสาขา และต้องระบุสาขา', async () => {
      const a = await newCompany('บริษัท เลข จำกัด');
      const hq = (await newBranch(a.id, '00000').expect(201)).body;
      const br = (await newBranch(a.id, '00001').expect(201)).body;
      const id = (x: string) =>
        x.replace('brn_', '').replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');
      const n1 = await inTenant((tx) =>
        issueNumber(tx, tenantId, { docType: 'INV', branchId: id(hq.id), at }),
      );
      const n2 = await inTenant((tx) =>
        issueNumber(tx, tenantId, { docType: 'INV', branchId: id(br.id), at }),
      );
      expect(n1).toBe('INV-00000-6911-0001');
      expect(n2).toBe('INV-00001-6911-0001');
      await expect(
        inTenant((tx) => issueNumber(tx, tenantId, { docType: 'INV', at })),
      ).rejects.toThrow('requires branchId');
    });

    it('หน้าตั้งค่า: list + แก้ prefix/รีเซ็ต; เอกสารภาษีต้องมี {BR}; แก้แล้วลง audit', async () => {
      const list = (await api(app, admin).get('/v1/document-sequences').expect(200)).body.data;
      expect(list.map((s: { docType: string }) => s.docType)).toEqual([
        'SO',
        'TRIP',
        'DO',
        'BN',
        'INV',
        'TXINV',
        'RCP',
        'CN',
        'DN',
        'STL',
        'WHT',
      ]);
      const so = list[0];
      expect(so.pattern).toBe('{YYMM}-{NNNN}');
      expect(so.nextNumber).toMatch(/^SO-\d{4}-\d{4}$/);
      const inv = list.find((s: { docType: string }) => s.docType === 'INV');
      const bad = await api(app, admin)
        .patch(`/v1/document-sequences/${inv.id}`)
        .send({ prefix: 'INV-' });
      expect(bad.status).toBe(422);
      const ok = await api(app, admin)
        .patch(`/v1/document-sequences/${so.id}`)
        .send({ prefix: 'TMS-SO-', resetPolicy: 'yearly' })
        .expect(200);
      expect(ok.body).toMatchObject({
        prefix: 'TMS-SO-',
        resetPolicy: 'yearly',
        pattern: '{YY}-{NNNN}',
      });
      const audit = await api(app, admin)
        .get(`/v1/audit-logs?entityType=document_series&entityId=${so.id}`)
        .expect(200);
      expect(audit.body.data[0]).toMatchObject({
        action: 'document_series.updated',
        before: { prefix: 'SO-', resetPolicy: 'MONTHLY' },
        after: { prefix: 'TMS-SO-', resetPolicy: 'YEARLY' },
      });
    });

    it('เอกสารภาษีที่งวดนี้ออกเลขแล้ว เปลี่ยนรอบรีเซ็ต/prefix ไม่ได้; เอกสารทั่วไปเปลี่ยนได้', async () => {
      const a = await newCompany('บริษัท งวด จำกัด');
      const hq = (await newBranch(a.id, '00000').expect(201)).body;
      const uuid = hq.id.replace('brn_', '').replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');
      await inTenant((tx) => issueNumber(tx, tenantId, { docType: 'CN', branchId: uuid }));
      const list = (await api(app, admin).get('/v1/document-sequences').expect(200)).body.data;
      const cn = list.find((s: { docType: string }) => s.docType === 'CN');
      const r = await api(app, admin)
        .patch(`/v1/document-sequences/${cn.id}`)
        .send({ resetPolicy: 'monthly' });
      expect(r.status).toBe(422);
      expect(r.body.errors[0].code).toBe('series_in_use');
      const p = await api(app, admin)
        .patch(`/v1/document-sequences/${cn.id}`)
        .send({ prefix: 'CR-{BR}-' });
      expect(p.status).toBe(422);
      const dn = list.find((s: { docType: string }) => s.docType === 'DN');
      await api(app, admin)
        .patch(`/v1/document-sequences/${dn.id}`)
        .send({ resetPolicy: 'monthly' })
        .expect(200);
    });

    it('แอปลบตัวนับไม่ได้', async () => {
      await expect(inTenant((tx) => tx.$executeRaw`DELETE FROM document_sequence`)).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  describe('T22 audit log', () => {
    it('แก้ record แล้วมี diff เฉพาะ field ที่เปลี่ยน พร้อมผู้ทำ IP และ requestId', async () => {
      const c = await newCompany('บริษัท ออดิท จำกัด');
      await api(app, admin)
        .patch(`/v1/companies/${c.id}`)
        .set('X-Request-Id', 'req-audit-0001')
        .send({ legalName: 'บริษัท ออดิทใหม่ จำกัด' })
        .expect(200);
      await api(app, admin)
        .post(`/v1/companies/${c.id}/deactivate`)
        .send({ reason: 'ปิดบริษัท' })
        .expect(200);
      const res = await api(app, admin)
        .get(`/v1/audit-logs?entityType=company&entityId=${c.id}`)
        .expect(200);
      const [deact, upd, created] = res.body.data;
      expect(created.action).toBe('company.created');
      expect(upd).toMatchObject({
        action: 'company.updated',
        before: { legalName: 'บริษัท ออดิท จำกัด' },
        after: { legalName: 'บริษัท ออดิทใหม่ จำกัด' },
        requestId: 'req-audit-0001',
        entityId: c.id,
      });
      expect(upd.ip).toBeTruthy();
      expect(upd.actor.id).toBe('user-test');
      expect(deact).toMatchObject({ action: 'company.deactivated', reason: 'ปิดบริษัท' });
    });

    it('แบ่งหน้าไม่ข้ามแถว แม้หลายแถวเขียนใน request เดียว (at เท่ากัน)', async () => {
      const a = await newCompany('บริษัท หน้า จำกัด');
      await newBranch(a.id, '00000').expect(201);
      // ตั้ง default ใหม่ = 2 แถว audit ใน transaction เดียว (ปลดตัวเดิม + แก้ตัวใหม่)
      const br = (await newBranch(a.id, '00001').expect(201)).body;
      await api(app, admin)
        .patch(`/v1/branches/${br.id}`)
        .send({ isDefaultIssuer: true })
        .expect(200);
      const all = (await api(app, admin).get('/v1/audit-logs?limit=200').expect(200)).body.data;
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { body: { data: { id: string }[]; nextCursor: string | null } } = await api(
          app,
          admin,
        )
          .get(`/v1/audit-logs?limit=1${cursor ? `&cursor=${cursor}` : ''}`)
          .expect(200);
        seen.push(...page.body.data.map((x) => x.id));
        cursor = page.body.nextCursor;
      } while (cursor);
      expect(seen).toEqual(all.map((x: { id: string }) => x.id));
    }, 60_000);

    it('UPDATE/DELETE บนตาราง audit ถูก DB ปฏิเสธ (ทั้ง role แอปและเจ้าของฐาน)', async () => {
      const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
      await expect(owner.$executeRaw`UPDATE audit_log SET reason = 'x'`).rejects.toThrow(
        /append-only/,
      );
      await expect(owner.$executeRaw`DELETE FROM audit_log`).rejects.toThrow(/append-only/);
      await owner.$disconnect();
      const prisma = new PrismaService();
      await expect(
        prisma.app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
          await tx.$executeRaw`DELETE FROM audit_log`;
        }),
      ).rejects.toThrow(/permission denied/);
    });

    it('สิทธิ์: viewer อ่านไม่ได้; บัญชีอ่านได้เฉพาะ entity ฝั่งบัญชี', async () => {
      const viewer = await tokenFor(tenantId, 'companies:read');
      expect((await api(app, viewer).get('/v1/audit-logs')).status).toBe(403);
      const acc = await tokenFor(tenantId, 'audit.accounting:read');
      expect((await api(app, acc).get('/v1/audit-logs?entityType=company')).status).toBe(200);
      expect((await api(app, acc).get('/v1/audit-logs?entityType=user')).status).toBe(403);
    });
  });
});
