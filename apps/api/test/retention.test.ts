import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signStepUpToken } from '../src/auth/tokens';
import { encodeId } from '../src/common/ids';
import { store } from '../src/modules/documents/documents.controller';
import { signDocumentUrl } from '../src/modules/documents/signed-url';
import { AUDIT_PROTECTED_ENTITY_TYPES } from '../src/modules/retention/retention-policy';
import { RetentionService } from '../src/modules/retention/retention.service';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';

const DAY = 864e5;
const YEAR = 365.25 * DAY;

/**
 * ST9-T14 Retention (docs/04 J): ตั้งค่าต่ำกว่าขั้นต่ำถูกปฏิเสธ · เลื่อนเวลาแล้ว log เกินอายุถูกลบ · เอกสารภาษีไม่ถูกแตะ
 */
describe('retention', () => {
  let app: NestExpressApplication;
  const db = platform();
  let retention: RetentionService;
  let a: string; // ค่าเริ่ม (= ขั้นต่ำ)
  let b: string; // ตั้งยาวกว่าขั้นต่ำ
  let adminA: string;

  beforeAll(async () => {
    process.env.FILES_ROOT = mkdtempSync(join(tmpdir(), 'tms-retention-'));
    await truncateAll();
    app = await bootApp();
    retention = app.get(RetentionService);
    a = (await createTenant(db, 'บริษัท เก็บสั้น')).id;
    b = (await createTenant(db, 'บริษัท เก็บยาว')).id;
    adminA = await tokenFor(a, 'settings:read settings:write');
    const adminB = await tokenFor(b, 'settings:read settings:write');
    await api(app, adminB)
      .patch('/v1/settings')
      .send({
        values: {
          'retention.auditLogYears': 7,
          'retention.loginLogMonths': 24,
          'retention.gpsLogDays': 180,
          'retention.podFileYears': 3,
          'retention.integrationLogMonths': 36,
        },
      })
      .expect(200);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  describe('ค่าตั้งต่อ tenant', () => {
    it('ค่าเริ่ม = ขั้นต่ำของ docs/04 J', async () => {
      const res = await api(app, adminA).get('/v1/settings').expect(200);
      const s = Object.fromEntries(
        (res.body.data as { key: string; value: unknown }[]).map((x) => [x.key, x.value]),
      );
      expect(s).toMatchObject({
        'retention.auditLogYears': 5,
        'retention.integrationLogMonths': 24,
        'retention.loginLogMonths': 12,
        'retention.podFileYears': 2,
        'retention.gpsLogDays': 90,
      });
    });

    it('ต่ำกว่าขั้นต่ำ → 422 below_minimum ทั้งก้อน (ไม่มีอะไรถูกบันทึก)', async () => {
      for (const [key, v] of [
        ['retention.auditLogYears', 4],
        ['retention.integrationLogMonths', 23],
        ['retention.loginLogMonths', 11],
        ['retention.podFileYears', 1],
        ['retention.gpsLogDays', 89],
      ] as const) {
        const res = await api(app, adminA)
          .patch('/v1/settings')
          .send({ values: { 'retention.gpsLogDays': 120, [key]: v } });
        expect(res.status, key).toBe(422);
        expect(res.body.errors, key).toContainEqual(
          expect.objectContaining({ field: `values.${key}`, code: 'below_minimum' }),
        );
      }
      // ทศนิยม / ข้อความ / เกินเพดาน = invalid_setting
      for (const v of [5.5, '5', 21]) {
        const res = await api(app, adminA)
          .patch('/v1/settings')
          .send({ values: { 'retention.auditLogYears': v } });
        expect(res.status).toBe(422);
        expect(res.body.errors[0].code).toBe('invalid_setting');
      }
      expect(await db.tenantSetting.count({ where: { tenantId: a } })).toBe(0);
    });

    it('ยืดระยะไม่ต้อง step-up; ลดระยะต้อง step-up (ข้อมูลถูกลบเร็วขึ้น ย้อนไม่ได้) + ลง audit', async () => {
      await api(app, adminA)
        .patch('/v1/settings')
        .send({ values: { 'retention.auditLogYears': 6 } })
        .expect(200);
      const down = await api(app, adminA)
        .patch('/v1/settings')
        .send({ values: { 'retention.auditLogYears': 5 } });
      expect(down.status).toBe(403);
      expect(down.body.code).toBe('step_up_required');
      await api(app, adminA)
        .patch('/v1/settings')
        .set('X-Step-Up', await signStepUpToken('user-test', a))
        .send({ values: { 'retention.auditLogYears': 5 } })
        .expect(200);
      const audits = await db.auditLog.findMany({
        where: { tenantId: a, entityType: 'tenant_setting', entityId: 'retention.auditLogYears' },
      });
      expect(audits.map((x) => x.after)).toEqual(
        expect.arrayContaining([
          { 'retention.auditLogYears': 6 },
          { 'retention.auditLogYears': 5 },
        ]),
      );
    });
  });

  describe('audit log (append-only — ลบผ่านฟังก์ชัน DB เท่านั้น)', () => {
    const ago = (years: number) => new Date(Date.now() - years * YEAR);
    const row = (tenantId: string, entityType: string, years: number) =>
      db.auditLog.create({
        data: {
          tenantId,
          action: 'test.event',
          entityType,
          entityId: randomUUID(),
          at: ago(years),
        },
      });

    it('เกินระยะเก็บถูกลบ (ต่อ tenant) · เหตุการณ์ภาษี/นิติบุคคล/ค่าตั้งไม่ถูกแตะ · ลงบันทึกการลบ', async () => {
      const aOld = await row(a, 'trip', 6);
      const aRecent = await row(a, 'trip', 4.9);
      const aCompany = await row(a, 'company', 9);
      const aSetting = await row(a, 'tenant_setting', 9);
      const aInvoice = await row(a, 'tax_invoice', 9);
      const bSix = await row(b, 'trip', 6); // B ตั้ง 7 ปี
      const bEight = await row(b, 'delivery_order', 8);

      expect(await retention.purgeAuditLog()).toBe(2);
      const left = new Set((await db.auditLog.findMany({ select: { id: true } })).map((x) => x.id));
      expect(left.has(aOld.id)).toBe(false);
      expect(left.has(bEight.id)).toBe(false);
      for (const kept of [aRecent, aCompany, aSetting, aInvoice, bSix])
        expect(left.has(kept.id), kept.entityType).toBe(true);

      const ev = await db.auditLog.findMany({
        where: { action: 'retention.purged', entityId: 'audit_log' },
        orderBy: { tenantId: 'asc' },
      });
      expect(
        ev.map((e) => [e.tenantId, (e.after as { count: number; years: number }).count]),
      ).toEqual(
        expect.arrayContaining([
          [a, 1],
          [b, 1],
        ]),
      );
      expect(ev.find((e) => e.tenantId === b)!.after).toMatchObject({ years: 7 });
      // รอบถัดไปไม่มีอะไรให้ลบ และไม่ลงบันทึกเปล่า
      expect(await retention.purgeAuditLog()).toBe(0);
      expect(
        await db.auditLog.count({ where: { action: 'retention.purged', entityId: 'audit_log' } }),
      ).toBe(2);
    });

    it('role platform ลบ/แก้ audit ตรงไม่ได้ แม้ตั้งธงเอง · role แอปเรียกฟังก์ชันไม่ได้ · ส่งค่าผิด = error', async () => {
      const r = await row(a, 'trip', 10);
      await expect(
        db.$transaction([
          db.$executeRaw`SELECT set_config('tms.audit_retention_purge', 'on', true)`,
          db.$executeRaw`DELETE FROM audit_log WHERE id = ${r.id}::uuid`,
        ]),
      ).rejects.toThrow(/append-only/);
      await expect(
        db.$executeRaw`UPDATE audit_log SET reason = 'x' WHERE id = ${r.id}::uuid`,
      ).rejects.toThrow(/append-only/);
      const appDb = new PrismaClient({
        datasources: { db: { url: process.env.APP_DATABASE_URL } },
      });
      try {
        await expect(
          appDb.$queryRaw`SELECT tms_audit_retention_purge(${a}::uuid, 10)`,
        ).rejects.toThrow(/permission denied/);
      } finally {
        await appDb.$disconnect();
      }
      await expect(db.$queryRaw`SELECT tms_audit_retention_purge(${a}::uuid, 0)`).rejects.toThrow(
        /invalid arguments/,
      );
      // ค่าตั้งในฐานต่ำกว่าขั้นต่ำ (ไม่ผ่าน API) → ฟังก์ชันยังใช้ 5 ปี
      await db.tenantSetting.update({
        where: { tenantId_key: { tenantId: a, key: 'retention.auditLogYears' } },
        data: { value: 1 },
      });
      const three = await row(a, 'trip', 3);
      await retention.purgeAuditLog();
      expect(await db.auditLog.findUnique({ where: { id: three.id } })).not.toBeNull();
      expect(await db.auditLog.findUnique({ where: { id: r.id } })).toBeNull();
      await db.tenantSetting.update({
        where: { tenantId_key: { tenantId: a, key: 'retention.auditLogYears' } },
        data: { value: 5 },
      });
    });

    it('รายการ entity ที่กันไว้ใน TS = ในฟังก์ชัน DB · entity ชื่อเกี่ยวกับภาษี/การเงินในโค้ดต้องอยู่ในรายการ', async () => {
      const [fn] = await db.$queryRaw<{ def: string }[]>`
        SELECT pg_get_functiondef('tms_audit_retention_purge(uuid, integer)'::regprocedure) AS def`;
      const m = /protected text\[\] := ARRAY\[([\s\S]*?)\];/.exec(fn!.def);
      const inDb = [...(m?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
      expect(inDb).toEqual([...AUDIT_PROTECTED_ENTITY_TYPES].sort());

      const used = new Set<string>();
      const walk = (dir: string) => {
        for (const f of readdirSync(dir)) {
          const p = join(dir, f);
          if (statSync(p).isDirectory()) walk(p);
          else if (p.endsWith('.ts'))
            for (const x of readFileSync(p, 'utf8').matchAll(/entityType: '([a-z_]+)'/g))
              used.add(x[1]!);
        }
      };
      walk(join(__dirname, '../src'));
      const taxy =
        /invoice|receipt|tax|wht|credit|debit|payment|settle|billing|sequence|series|company|branch|etax/;
      const missing = [...used].filter(
        (t) => taxy.test(t) && !(AUDIT_PROTECTED_ENTITY_TYPES as readonly string[]).includes(t),
      );
      expect(missing).toEqual([]);
    });
  });

  describe('เลื่อนเวลา: login / GPS / ไฟล์', () => {
    const later = (days: number) => new Date(Date.now() + days * DAY);

    it('ประวัติ login: เกิน 12 เดือนถูกลบ (แถวไม่รู้ tenant ด้วย) · tenant ที่ตั้ง 24 เดือนยังอยู่ · ลง audit ต่อ tenant', async () => {
      const mk = (tenantId: string | null) =>
        db.loginAttempt.create({
          data: { email: `${randomUUID()}@ret.test`, ip: '10.9.9.9', success: true, tenantId },
        });
      const [la, lb, ln] = [await mk(a), await mk(b), await mk(null)];
      expect(await retention.purgeLoginLog(later(360))).toBe(0);
      expect(await retention.purgeLoginLog(later(13 * 31))).toBe(2);
      const ids = new Set((await db.loginAttempt.findMany()).map((x) => x.id));
      expect([ids.has(la.id), ids.has(lb.id), ids.has(ln.id)]).toEqual([false, true, false]);
      expect(
        await db.auditLog.findFirst({
          where: { tenantId: a, action: 'retention.purged', entityId: 'login_log' },
        }),
      ).toMatchObject({ after: { count: 1 } });
      expect(await retention.purgeLoginLog(later(25 * 31))).toBe(1);
    });

    it('GPS: นับจากเวลาที่รับ — 90 วัน (ค่าเริ่ม) / 180 วัน (B)', async () => {
      const mk = (tenantId: string, occurredAt = new Date()) =>
        db.vehiclePosition.create({
          data: {
            tenantId,
            vehicleId: randomUUID(),
            source: 'TEST',
            lat: '13.7',
            lng: '100.5',
            occurredAt,
          },
        });
      // อุปกรณ์นาฬิกาผิด (เวลาเกิดย้อน 1 ปี) ไม่ทำให้ลบก่อนครบ 90 วันนับจากที่รับ
      const [pa, pSkew, pb] = [
        await mk(a),
        await mk(a, new Date(Date.now() - 400 * DAY)),
        await mk(b),
      ];
      expect(await retention.purgeGpsLog(later(89))).toBe(0);
      expect(await retention.purgeGpsLog(later(91))).toBe(2);
      const ids = new Set((await db.vehiclePosition.findMany()).map((x) => x.id));
      expect([ids.has(pa.id), ids.has(pSkew.id), ids.has(pb.id)]).toEqual([false, false, true]);
      expect(await retention.purgeGpsLog(later(181))).toBe(1);
    });

    it('ไฟล์ POD ครบ 2 ปีถูกลบ (แถวคงอยู่เป็น purged ดาวน์โหลดไม่ได้) · ไฟล์ที่แถวอื่นใช้ร่วมไม่ถูกลบ · PDF/เอกสารรถไม่ถูกแตะ', async () => {
      const files = store();
      const doc = async (
        tenantId: string,
        kind: string,
        data: Buffer,
        ext = 'png',
        mime = 'image/png',
      ) => {
        const f = await files.put(tenantId, data, ext);
        return db.storedDocument.create({
          data: {
            tenantId,
            kind,
            status: 'READY',
            mimeType: mime,
            sizeBytes: f.size,
            fileKey: f.key,
            sha256: f.sha256,
          },
        });
      };
      const path = (key: string) => join(process.env.FILES_ROOT!, key);
      const photo = await doc(a, 'POD_PHOTO', Buffer.from(`photo-${randomUUID()}`));
      const sig = await doc(a, 'POD_SIGNATURE', Buffer.from(`sig-${randomUUID()}`));
      const sharedBytes = Buffer.from(`shared-${randomUUID()}`);
      const sharedPod = await doc(a, 'POD_FILE', sharedBytes);
      const sharedOther = await doc(a, 'VEHICLE_DOC', sharedBytes);
      const pdf = await doc(
        a,
        'PDF',
        Buffer.from(`%PDF-tax-${randomUUID()}`),
        'pdf',
        'application/pdf',
      );
      const podB = await doc(b, 'POD_PHOTO', Buffer.from(`photo-b-${randomUUID()}`));

      expect(await retention.purgeFiles(later(700), 'pod')).toBe(0);
      expect(await retention.purgeFiles(later(2 * 366), 'pod')).toBe(3);

      const get = (id: string) => db.storedDocument.findUniqueOrThrow({ where: { id } });
      for (const d of [photo, sig, sharedPod]) {
        const now = await get(d.id);
        expect(now).toMatchObject({ status: 'PURGED', fileKey: null, sha256: d.sha256 });
        expect(now.purgedAt).not.toBeNull();
      }
      expect(existsSync(path(photo.fileKey!))).toBe(false);
      expect(existsSync(path(sig.fileKey!))).toBe(false);
      expect(existsSync(path(sharedPod.fileKey!))).toBe(true); // VEHICLE_DOC ยังใช้
      expect(await get(sharedOther.id)).toMatchObject({
        status: 'READY',
        fileKey: sharedOther.fileKey,
      });
      expect(await get(pdf.id)).toMatchObject({ status: 'READY', fileKey: pdf.fileKey });
      expect(existsSync(path(pdf.fileKey!))).toBe(true);
      expect(await get(podB.id)).toMatchObject({ status: 'READY' }); // B ตั้ง 3 ปี

      // ดาวน์โหลดไฟล์ที่ถูกลบ = 404 · GET เห็นสถานะ purged
      const token = await tokenFor(a, 'documents:read');
      const s = signDocumentUrl('download', a, photo.id, 60);
      const id = encodeId('document', photo.id);
      expect(
        (await request(app.getHttpServer()).get(`/v1/documents/${id}/content?${s.query}`)).status,
      ).toBe(404);
      expect((await api(app, token).get(`/v1/documents/${id}`)).body.status).toBe('purged');
      expect(
        await db.auditLog.findFirst({
          where: { tenantId: a, action: 'retention.purged', entityId: 'pod_file' },
        }),
      ).toMatchObject({ after: { count: 3 } });
      // DB บังคับ: purged ต้องไม่มี file_key
      await expect(
        db.$executeRaw`UPDATE stored_document SET status = 'PURGED' WHERE id = ${pdf.id}::uuid`,
      ).rejects.toThrow(/stored_document_purged_check/);
    });

    it('ไฟล์ส่งออก (ST9-T10) เกิน 7 วันถูกลบ', async () => {
      const f = await store().put(a, Buffer.from(`id,name\n${randomUUID()}\n`), 'csv');
      const d = await db.storedDocument.create({
        data: {
          tenantId: a,
          kind: 'EXPORT',
          status: 'READY',
          mimeType: 'text/csv',
          sizeBytes: f.size,
          fileKey: f.key,
          sha256: f.sha256,
        },
      });
      expect(await retention.purgeFiles(later(6), 'export')).toBe(0);
      expect(await retention.purgeFiles(later(8), 'export')).toBe(1);
      expect(await db.storedDocument.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({
        status: 'PURGED',
      });
      expect(existsSync(join(process.env.FILES_ROOT!, f.key))).toBe(false);
    });

    it('run() รวมทุกกลุ่ม', async () => {
      expect(await retention.run(later(1))).toEqual({
        auditLog: 0,
        loginLog: 0,
        gpsLog: 0,
        podFiles: 0,
        exportFiles: 0,
      });
    });
  });

  it('retention job แตะเฉพาะตาราง log/ไฟล์ — ไม่มีคำสั่ง DELETE/UPDATE บนตารางอื่น (เอกสารภาษีไม่ถูกแตะ)', () => {
    const src = readFileSync(
      join(__dirname, '../src/modules/retention/retention.service.ts'),
      'utf8',
    );
    const touched = [...src.matchAll(/(?:DELETE FROM|UPDATE)\s+([a-z_]+)/g)].map((x) => x[1]);
    expect(new Set(touched)).toEqual(
      new Set(['login_attempt', 'vehicle_position', 'stored_document']),
    );
  });
});
