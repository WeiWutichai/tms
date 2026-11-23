import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { OutboxStatus, ReconcileOutcome, ReconcileSeverity } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { encodeId } from '../src/common/ids';
import { JobQueue } from '../src/jobs/job-queue.service';
import { bangkokMonthBounds } from '../src/modules/erp/period-close-report.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { api, bootApp, platform, tokenFor, truncateAll } from './helpers';

type Row = Record<string, any>;

/**
 * ST8-T14 รายงานปิดงวด (docs/02 §7 เกณฑ์ผ่าน (ก) "KRS ปิดงวด 2 เดือนติด MISMATCH ค้าง = 0"; docs/01 §6.5)
 * เกณฑ์ตรวจรับ (plan/01 ST8-T14): รายงานของเดือนทดสอบแสดง 0 ค้างเมื่อปิดครบ และ export ได้
 * + ความหมาย "ณ สิ้นเดือน": พบหลังสิ้นเดือนไม่นับ · ปิด/ยอมรับหลังสิ้นเดือนยังนับเป็นค้าง · ค้างจากเดือนก่อนนับ
 * + เอกสารที่ยังไม่ส่ง (แท็บรอคิว/ล้มเหลวของคิว ST7-T19) · สิทธิ์ + ราคา · แยก tenant · ส่งออก xlsx / pdf
 */
describe('รายงานปิดงวด (ST8-T14)', { timeout: 600_000 }, () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let conUuid: string;
  let conId: string;
  let otherConId: string;
  let admin: string;
  let readOnly: string;
  let noRead: string;
  let other: string;
  let ackUser: string;
  let seq = 0;
  const JUNE = '2025-06';
  const AUG = '2025-08';
  const at = (s: string) => new Date(s);

  async function result(o: {
    created: string;
    resolved?: string;
    acked?: string;
    result?: ReconcileOutcome;
    severity?: ReconcileSeverity;
    diff?: object;
    reason?: string;
    tenant?: string;
    connector?: string;
  }) {
    const n = ++seq;
    const r = await db.reconcileResult.create({
      data: {
        tenantId: o.tenant ?? tenantId,
        connectorId: o.connector ?? conUuid,
        entityType: 'INVOICE',
        localId: randomUUID(),
        localNumber: `INV-T14-${String(n).padStart(3, '0')}`,
        runAt: at(o.created),
        source: 'NIGHTLY',
        localSnapshot: {},
        remoteSnapshot: {},
        diff: o.diff ?? { check: 'DOCUMENT', code: 'content_mismatch' },
        diffHash: String(n).padStart(64, '0'),
        result: o.result ?? 'MISMATCH',
        severity: o.severity ?? 'MONEY',
        lastSeenAt: at(o.created),
        createdAt: at(o.created),
        ...(o.resolved ? { resolvedAt: at(o.resolved), resolution: 'NEXT_RUN_MATCHED' } : {}),
        ...(o.acked
          ? {
              acknowledgedAt: at(o.acked),
              acknowledgedBy: ackUser,
              ackReason: o.reason ?? 'ฝ่ายบัญชียืนยันส่วนต่างแล้ว',
            }
          : {}),
      },
    });
    return encodeId('reconcileResult', r.id);
  }

  async function command(o: {
    status: OutboxStatus;
    entity?: 'invoice' | 'settlement';
    date: string;
    localId?: string;
    number?: string;
  }) {
    const entity = o.entity ?? 'invoice';
    const localId = o.localId ?? randomUUID();
    const number = o.number ?? `${entity === 'invoice' ? 'INV' : 'STL'}-T14-${++seq}`;
    const document =
      entity === 'invoice'
        ? {
            kind: 'invoice',
            id: localId,
            number,
            issueDate: o.date,
            customer: { legalName: 'บริษัท ลูกค้าปิดงวด จำกัด' },
            totals: { total: '1070.00' },
          }
        : {
            kind: 'settlement',
            id: localId,
            number,
            paidDate: o.date,
            carrier: { legalName: 'รถร่วมปิดงวด' },
            totals: { net: '500.00' },
          };
    const failed = o.status === 'FAILED_FINAL';
    const r = await db.integrationOutbox.create({
      data: {
        tenantId,
        kind: 'ADAPTER',
        sink: 'erp',
        targetId: conUuid,
        operation: entity === 'invoice' ? 'PUSH_INVOICE' : 'PUSH_SETTLEMENT',
        entityType: entity,
        localId,
        serializeKey: `erp:${conUuid}:${entity}:${localId}`,
        idempotencyKey: `t14-${randomUUID()}`,
        payload: { document },
        status: o.status,
        ...(failed
          ? {
              errorClass: 'PERIOD_CLOSED',
              lastError: { code: 'period_closed', message: 'x' },
              doneAt: new Date(),
            }
          : o.status === 'DONE'
            ? { doneAt: new Date() }
            : {}),
      },
    });
    return { id: encodeId('outboxCommand', r.id), raw: r.id, localId, number };
  }

  const report = async (month: string, token = admin, connector = conId) =>
    (
      await api(app, token)
        .get(`/v1/reconcile-reports/period-close?connectorId=${connector}&month=${month}`)
        .expect(200)
    ).body as Row;

  const ids: Record<string, string> = {};
  const docs: Record<string, { id: string; number: string }> = {};

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ปิดงวด' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    await db.tenant.updateMany({ data: { planCode: 'ent' } });
    const roles = await ensureSystemRoles(db, tenantId);
    const u = await db.appUser.create({
      data: { tenantId, email: 'acc@t14.test', name: 'สมหญิง บัญชีดี', status: 'ACTIVE' },
    });
    await db.userRole.create({ data: { tenantId, userId: u.id, roleId: roles.admin! } });
    ackUser = u.id;
    const c = await db.connector.create({
      data: { tenantId, adapterKey: 'demo', capabilitiesEnabled: [], credentialKeys: [] },
    });
    conUuid = c.id;
    conId = encodeId('connector', c.id);
    const oc = await db.connector.create({
      data: { tenantId: otherId, adapterKey: 'demo', capabilitiesEnabled: [], credentialKeys: [] },
    });
    otherConId = encodeId('connector', oc.id);
    admin = await tokenFor(tenantId, '*', ackUser);
    readOnly = await tokenFor(tenantId, 'integrations:read', 'u-read');
    noRead = await tokenFor(tenantId, 'invoices:read', 'u-none');
    other = await tokenFor(otherId);

    // มิถุนายน 2568 (สิ้นเดือน = 2025-06-30T17:00Z)
    ids.closedInMonth = await result({
      created: '2025-06-10T03:00:00Z',
      resolved: '2025-06-20T03:00:00Z',
    });
    ids.ackInMonth = await result({
      created: '2025-06-15T03:00:00Z',
      acked: '2025-06-25T03:00:00Z',
      severity: 'FIELD',
      reason: 'ลูกค้าขอแก้ชื่อในระบบบัญชีเอง ยอมรับความต่าง',
    });
    ids.closedAfter = await result({
      created: '2025-06-28T03:00:00Z',
      resolved: '2025-07-02T03:00:00Z',
      diff: { check: 'PAYMENT_STATUS', code: 'remote_less_than_tms', difference: '-100.00' },
    });
    // 23:30 น. 30 มิ.ย. เวลาไทย = ยังอยู่ในเดือน
    ids.lastMinute = await result({
      created: '2025-06-30T16:30:00Z',
      resolved: '2025-07-01T01:00:00Z',
      severity: 'FIELD',
    });
    // 00:10 น. 1 ก.ค. เวลาไทย = หลังสิ้นเดือน
    ids.foundAfter = await result({
      created: '2025-06-30T17:10:00Z',
      resolved: '2025-07-20T03:00:00Z',
    });
    ids.info = await result({
      created: '2025-06-29T03:00:00Z',
      result: 'ERP_UNREACHABLE',
      severity: 'INFO',
      diff: { check: 'DOCUMENT', code: 'erp_unreachable' },
    });
    ids.ackAfter = await result({ created: '2025-06-05T03:00:00Z', acked: '2025-07-03T03:00:00Z' });
    ids.carryOver = await result({
      created: '2025-05-10T03:00:00Z',
      resolved: '2025-07-15T03:00:00Z',
    });
    ids.remoteMissing = await result({
      created: '2025-06-12T03:00:00Z',
      result: 'REMOTE_MISSING',
      diff: { check: 'DOCUMENT', code: 'remote_missing' },
      resolved: '2025-06-14T03:00:00Z',
    });
    // สิงหาคม 2568 — ปิดครบ
    ids.augClosed = await result({
      created: '2025-08-03T03:00:00Z',
      resolved: '2025-08-10T03:00:00Z',
    });
    ids.augAck = await result({
      created: '2025-08-05T03:00:00Z',
      acked: '2025-08-12T03:00:00Z',
      reason: 'ยอดต่างจากการปัดเศษในระบบบัญชี ยอมรับแล้ว',
      diff: {
        check: 'DOCUMENT',
        code: 'content_mismatch',
        total: [{ field: 'totals.total', local: '1070.00', remote: '1069.99' }],
      },
    });
    // tenant อื่น (ห้ามรั่ว)
    await result({
      created: '2025-06-10T03:00:00Z',
      tenant: otherId,
      connector: oc.id,
    });

    // เอกสารที่ยังไม่ส่ง
    const f = await command({ status: 'FAILED_FINAL', date: '2025-06-20' });
    docs.failed = { id: f.id, number: f.number };
    const q = await command({ status: 'PENDING', entity: 'settlement', date: '2025-06-30' });
    docs.queued = { id: q.id, number: q.number };
    await command({ status: 'DONE', date: '2025-06-10' });
    const later = await command({ status: 'FAILED_FINAL', date: '2025-07-05' });
    docs.julyFailed = { id: later.id, number: later.number };
    // ล้มแล้วส่งใหม่สำเร็จ (คำสั่งหลังกว่า DONE) = ไม่ค้าง
    const old = await command({ status: 'FAILED_FINAL', date: '2025-06-11' });
    await command({ status: 'DONE', date: '2025-06-11', localId: old.localId, number: old.number });
    // ล้มแล้วคนข้ามพร้อมเหตุผล = ไม่ค้าง
    const skipped = await command({ status: 'FAILED_FINAL', date: '2025-06-12' });
    await db.connectorQueueResolution.create({
      data: {
        tenantId,
        connectorId: conUuid,
        outboxId: skipped.raw,
        kind: 'SKIPPED',
        reason: 'บันทึกในระบบบัญชีเองแล้ว',
        resolvedBy: ackUser,
      },
    });
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('ขอบเขตเดือนเวลาไทย', () => {
    expect(bangkokMonthBounds('2025-06')).toEqual({
      start: new Date('2025-05-31T17:00:00Z'),
      end: new Date('2025-06-30T17:00:00Z'),
    });
    expect(bangkokMonthBounds('2025-12').end).toEqual(new Date('2025-12-31T17:00:00Z'));
  });

  it('มิถุนายน: ค้าง ณ สิ้นเดือน = พบก่อนสิ้นเดือนและยังไม่ปิด/ยอมรับ ณ สิ้นเดือน (ปิดทีหลังยังนับ · พบทีหลังไม่นับ · INFO แยก)', async () => {
    const r = await report(JUNE);
    expect(r).toMatchObject({
      connector: { id: conId, adapterKey: 'demo' },
      month: JUNE,
      periodStart: '2025-06-01',
      periodEnd: '2025-06-30',
      asOf: '2025-06-30T17:00:00.000Z',
      monthEnded: true,
      passed: false,
    });
    expect(r.outstanding.map((x: Row) => x.id).sort()).toEqual(
      [ids.closedAfter, ids.lastMinute, ids.ackAfter, ids.carryOver].sort(),
    );
    expect(r.summary).toMatchObject({
      outstanding: 4,
      outstandingMoney: 3,
      outstandingField: 1,
      unverified: 1,
      acknowledged: 1,
      notSent: 2,
      notSentQueued: 1,
      notSentFailed: 1,
    });
    const after = r.outstanding.find((x: Row) => x.id === ids.closedAfter);
    expect(after).toMatchObject({
      check: 'PAYMENT_STATUS',
      currentStatus: 'RESOLVED',
      closedAt: '2025-07-02T03:00:00.000Z',
      sellDifferenceAmount: '-100.00',
    });
    expect(r.outstanding.find((x: Row) => x.id === ids.ackAfter)).toMatchObject({
      currentStatus: 'ACKNOWLEDGED',
      closedAt: '2025-07-03T03:00:00.000Z',
    });
    // (2) ยอมรับในเดือน + ผู้ยอมรับ + เหตุผล (ยอมรับหลังสิ้นเดือนไม่อยู่ในส่วนนี้ของมิถุนายน)
    expect(r.acknowledged).toHaveLength(1);
    expect(r.acknowledged[0]).toMatchObject({
      id: ids.ackInMonth,
      severity: 'FIELD',
      acknowledgedAt: '2025-06-25T03:00:00.000Z',
      acknowledgedBy: ackUser,
      acknowledgedByName: 'สมหญิง บัญชีดี',
      ackReason: 'ลูกค้าขอแก้ชื่อในระบบบัญชีเอง ยอมรับความต่าง',
    });
    // (3) ยังไม่ส่ง: วันที่เอกสาร ≤ สิ้นเดือน · DONE / ส่งใหม่สำเร็จ / คนข้ามแล้ว = ไม่ค้าง · เอกสารเดือนถัดไปไม่นับ
    expect(r.notSent.map((x: Row) => [x.commandId, x.queueTab])).toEqual([
      [docs.failed!.id, 'failed'],
      [docs.queued!.id, 'queued'],
    ]);
    expect(r.notSent[0]).toMatchObject({
      entityType: 'invoice',
      documentNo: docs.failed!.number,
      documentDate: '2025-06-20',
      counterpartyName: 'บริษัท ลูกค้าปิดงวด จำกัด',
      status: 'FAILED_FINAL',
      errorClass: 'PERIOD_CLOSED',
      errorCode: 'period_closed',
      sellTotalAmount: '1070.00',
    });
    expect(r.notSent[1]).toMatchObject({
      entityType: 'settlement',
      counterpartyName: 'รถร่วมปิดงวด',
      buyNetAmount: '500.00',
    });
    expect(r.truncated).toBe(false);
  });

  it('เกณฑ์ตรวจรับ: สิงหาคม ปิดครบ = ค้าง 0 · passed · รายการที่ยอมรับมีผู้ทำ + เหตุผล', async () => {
    const r = await report(AUG);
    expect(r.summary.outstanding).toBe(0);
    expect(r.outstanding).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.acknowledged.map((x: Row) => [x.id, x.ackReason, x.acknowledgedByName])).toEqual([
      [ids.augAck, 'ยอดต่างจากการปัดเศษในระบบบัญชี ยอมรับแล้ว', 'สมหญิง บัญชีดี'],
    ]);
    expect(r.acknowledged[0].sellDifferenceAmount).toBe('-0.01');
    // เอกสารที่ยังไม่ส่งแสดงประกอบ (ไม่ตัดสินผล) — วันที่ ≤ สิ้นเดือนทุกเดือนก่อนหน้า
    expect(r.notSent.map((x: Row) => x.commandId)).toEqual([
      docs.failed!.id,
      docs.queued!.id,
      docs.julyFailed!.id,
    ]);
  });

  it('เดือนปัจจุบันยังไม่จบ: ตัด ณ ตอนนี้ · passed = false แม้ไม่มีค้าง', async () => {
    const now = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
    const r = await report(now);
    expect(r.monthEnded).toBe(false);
    expect(r.passed).toBe(false);
    expect(new Date(r.asOf).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('สิทธิ์: integrations:read เห็นรายงานไม่เห็นยอดเงิน · ไม่มีสิทธิ์ = 403 · ตัวกรองผิด = 422', async () => {
    const r = await report(JUNE, readOnly);
    expect(r.summary.outstanding).toBe(4);
    for (const x of [...r.outstanding, ...r.acknowledged])
      expect(x).not.toHaveProperty('sellDifferenceAmount');
    for (const x of r.notSent) {
      expect(x).not.toHaveProperty('sellTotalAmount');
      expect(x).not.toHaveProperty('buyNetAmount');
    }
    await api(app, noRead)
      .get(`/v1/reconcile-reports/period-close?connectorId=${conId}&month=${JUNE}`)
      .expect(403);
    for (const q of [
      `connectorId=${conId}&month=2025-13`,
      `connectorId=${conId}`,
      `month=${JUNE}`,
      `connectorId=${conId}&month=2025-6`,
    ])
      await api(app, admin).get(`/v1/reconcile-reports/period-close?${q}`).expect(422);
  });

  it('แยก tenant: connector ของ tenant อื่น / id ผิด = 404 · tenant อื่นไม่เห็นข้อมูลของเรา', async () => {
    await api(app, admin)
      .get(`/v1/reconcile-reports/period-close?connectorId=${otherConId}&month=${JUNE}`)
      .expect(404);
    await api(app, other)
      .get(`/v1/reconcile-reports/period-close?connectorId=${conId}&month=${JUNE}`)
      .expect(404);
    await api(app, admin)
      .get(`/v1/reconcile-reports/period-close?connectorId=con_nope&month=${JUNE}`)
      .expect(404);
    const r = await report(JUNE, other, otherConId);
    expect(r.summary.outstanding).toBe(1);
    expect(r.notSent).toEqual([]);
    expect(r.acknowledged).toEqual([]);
  });

  describe('ส่งออก (POST /v1/exports resource reconcile-period-close)', () => {
    const exportNow = async (body: object, scope = '*') => {
      const a = api(app, await tokenFor(tenantId, scope, ackUser));
      const r = await a.post('/v1/exports').send(body).expect(202);
      while (await app.get(JobQueue).runOnce()) {
        /* drain */
      }
      return (await a.get(r.body.statusUrl).expect(200)).body as Row;
    };
    const download = async (url: string): Promise<Buffer> => {
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
    };
    const sheet = async (buf: Buffer) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
      const out: string[][] = [];
      wb.worksheets[0]!.eachRow((row) =>
        out.push((row.values as unknown[]).slice(1).map((v) => (v == null ? '' : String(v)))),
      );
      return out;
    };

    it('xlsx สิงหาคม: แถวสรุป "ค้าง 0 · ผ่าน" + ยอมรับ (ผู้ทำ/เหตุผล) + ยังไม่ส่ง · ผู้ไม่มีสิทธิ์ราคาไม่มีคอลัมน์เงิน', async () => {
      const st = await exportNow({
        resource: 'reconcile-period-close',
        format: 'xlsx',
        filter: { connectorId: conId, month: AUG },
      });
      expect(st).toMatchObject({
        status: 'succeeded',
        resource: 'reconcile-period-close',
        rows: 4,
      });
      expect(st.fileName).toBe('รายงานปิดงวด_2025-08.xlsx');
      const out = await sheet(await download(st.downloadUrl));
      expect(out[0]).toEqual([
        'ส่วน',
        'เลขเอกสาร',
        'ประเภท',
        'รายละเอียด',
        'สถานะ',
        'วันที่พบ / วันที่เอกสาร',
        'ปิด / ยอมรับเมื่อ',
        'ผู้ยอมรับ',
        'เหตุผล',
        'ส่วนต่าง / ยอดใบแจ้งหนี้',
        'ยอดใบสำคัญจ่าย',
      ]);
      expect(out[1]![0]).toBe('สรุป');
      expect(out[1]![3]).toContain('MISMATCH ค้าง ณ สิ้นเดือน 0 รายการ');
      expect(out[1]![4]).toBe('ผ่าน');
      expect(out[2]!.slice(0, 1).concat(out[2]!.slice(7, 10))).toEqual([
        'ยอมรับความต่าง',
        'สมหญิง บัญชีดี',
        'ยอดต่างจากการปัดเศษในระบบบัญชี ยอมรับแล้ว',
        '-0.01',
      ]);
      expect(out.slice(3).map((x) => [x[0], x[1], x[4]])).toEqual([
        ['ยังไม่ถูกส่ง', docs.failed!.number, 'ล้มเหลว ต้องมีคนทำ'],
        ['ยังไม่ถูกส่ง', docs.queued!.number, 'รอคิว'],
        ['ยังไม่ถูกส่ง', docs.julyFailed!.number, 'ล้มเหลว ต้องมีคนทำ'],
      ]);

      const ns = await exportNow(
        {
          resource: 'reconcile-period-close',
          format: 'csv',
          filter: { connectorId: conId, month: JUNE },
        },
        'integrations:read export:run',
      );
      const csv = (await download(ns.downloadUrl)).toString('utf8');
      expect(csv).toContain('MISMATCH ค้าง ณ สิ้นเดือน 4 รายการ');
      expect(csv).not.toContain('ส่วนต่าง / ยอดใบแจ้งหนี้');
      expect(csv).not.toContain('1070');
      expect(csv).not.toContain('-100');
    });

    it('pdf: ไฟล์ PDF จริง · connector ของ tenant อื่น = 404 ตอนสั่ง', async () => {
      const st = await exportNow({
        resource: 'reconcile-period-close',
        format: 'pdf',
        filter: { connectorId: conId, month: JUNE },
      });
      expect(st).toMatchObject({ status: 'succeeded', format: 'pdf' });
      const buf = await download(st.downloadUrl);
      expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      await api(app, admin)
        .post('/v1/exports')
        .send({
          resource: 'reconcile-period-close',
          format: 'xlsx',
          filter: { connectorId: otherConId, month: JUNE },
        })
        .expect(404);
      await api(app, admin)
        .post('/v1/exports')
        .send({ resource: 'reconcile-period-close', format: 'xlsx', filter: { month: JUNE } })
        .expect(422);
    });
  });
});
