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
import { putFileLocked, store } from '../src/modules/documents/documents.controller';
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

    it('เกินระยะเก็บถูกลบ (ต่อ tenant) · เหตุการณ์ภาษี/ฐานการเงิน/ค่าตั้งไม่ถูกแตะ (ไม่สนตัวพิมพ์) · ลงบันทึกการลบ', async () => {
      const aOld = await row(a, 'user', 6);
      const aRecent = await row(a, 'user', 4.9);
      const aKept = [];
      for (const t of [
        'company',
        'tenant_setting',
        'tax_invoice',
        'INVOICE',
        'Trip',
        'rate_card',
        'RATE_CARD',
        'sales_order',
        'trip_cost',
        'vehicle_cost',
        'customer',
        'carrier',
        'tenant',
        'delivery_order',
      ])
        aKept.push(await row(a, t, 9));
      const bSix = await row(b, 'api_key', 6); // B ตั้ง 7 ปี
      const bEight = await row(b, 'webhook_endpoint', 8);

      expect(await retention.purgeAuditLog()).toBe(2);
      const left = new Set((await db.auditLog.findMany({ select: { id: true } })).map((x) => x.id));
      expect(left.has(aOld.id)).toBe(false);
      expect(left.has(bEight.id)).toBe(false);
      for (const kept of [aRecent, ...aKept, bSix])
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
      const r = await row(a, 'user', 10);
      await expect(
        db.$transaction([
          db.$executeRaw`SELECT set_config('tms.audit_retention_purge', 'on', true)`,
          db.$executeRaw`DELETE FROM audit_log WHERE id = ${r.id}::uuid`,
        ]),
      ).rejects.toThrow(/append-only|permission denied/);
      await expect(
        db.$executeRaw`UPDATE audit_log SET reason = 'x' WHERE id = ${r.id}::uuid`,
      ).rejects.toThrow(/append-only|permission denied/);
      // review: temp view ชื่อ pg_tables หลอกเจ้าของตาราง → ยังลบไม่ได้ (catalog ระบุ schema + REVOKE DELETE)
      await expect(
        db.$transaction([
          db.$executeRaw`CREATE TEMP VIEW pg_tables AS SELECT 'public'::name AS schemaname, 'audit_log'::name AS tablename, current_user::name AS tableowner`,
          db.$executeRaw`SELECT set_config('search_path', 'pg_temp, public', true)`,
          db.$executeRaw`SELECT set_config('tms.audit_retention_purge', 'on', true)`,
          db.$executeRaw`DELETE FROM public.audit_log WHERE id = ${r.id}::uuid`,
        ]),
      ).rejects.toThrow(/append-only|permission denied/);
      // ฟังก์ชันไม่หลงตาม temp table ของผู้เรียก (search_path คงที่)
      await db.$transaction([
        db.$executeRaw`CREATE TEMP TABLE tenant_setting (tenant_id uuid, key text, value jsonb) ON COMMIT DROP`,
        db.$executeRaw`INSERT INTO pg_temp.tenant_setting VALUES (${a}::uuid, 'retention.auditLogYears', '20'::jsonb)`,
        db.$executeRaw`SELECT set_config('search_path', 'pg_temp, public', true)`,
        db.$queryRaw`SELECT tms_audit_retention_purge(${a}::uuid, 1)`,
      ]);
      expect(await db.auditLog.findUnique({ where: { id: r.id } })).toBeNull();
      const r2 = await row(a, 'user', 10);
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
      const three = await row(a, 'user', 3);
      await retention.purgeAuditLog();
      expect(await db.auditLog.findUnique({ where: { id: three.id } })).not.toBeNull();
      expect(await db.auditLog.findUnique({ where: { id: r2.id } })).toBeNull();
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
        /invoice|receipt|tax|wht|credit|debit|payment|settle|billing|sequence|series|company|branch|etax|legal|rate_card|sales_order|delivery_order|charge|cost|surcharge|customer|carrier|^tenant$|^trip|subcon|pric|stop_event|^vehicle$|depreciation|advance|^cod$|expense/i;
      const missing = [...used].filter(
        (t) =>
          taxy.test(t) &&
          !(AUDIT_PROTECTED_ENTITY_TYPES as readonly string[]).includes(t.toLowerCase()),
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

    const files = () => store();
    const path = (key: string) => join(process.env.FILES_ROOT!, key);
    const doc = async (
      tenantId: string,
      kind: string,
      data: Buffer,
      ext = 'png',
      mime = 'image/png',
    ) => {
      const f = await files().put(tenantId, data, ext);
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
    const get = (id: string) => db.storedDocument.findUniqueOrThrow({ where: { id } });

    it('ไฟล์ POD: พักการลบไว้ (รอตรวจ ม.87/3) — เกิน 2 ปีก็ไม่ถูกแตะ', async () => {
      const photo = await doc(a, 'POD_PHOTO', Buffer.from(`photo-${randomUUID()}`));
      const sig = await doc(a, 'POD_SIGNATURE', Buffer.from(`sig-${randomUUID()}`));
      expect(await retention.purgeFiles(later(10 * 366), 'pod')).toBe(0);
      for (const d of [photo, sig]) {
        expect(await get(d.id)).toMatchObject({ status: 'READY', fileKey: d.fileKey });
        expect(existsSync(path(d.fileKey!))).toBe(true);
      }
    });

    it('ไฟล์ส่งออก (ST9-T10) เกิน 7 วัน: แถว PURGED (ไม่มีลิงก์/ดาวน์โหลด 404) → ลบไฟล์ · ไฟล์ที่แถวอื่นใช้ร่วม/PDF ไม่ถูกลบ', async () => {
      const exp = await doc(a, 'EXPORT', Buffer.from(`id\n${randomUUID()}\n`), 'csv', 'text/csv');
      const sharedBytes = Buffer.from(`shared-${randomUUID()}`);
      const sharedExp = await doc(a, 'EXPORT', sharedBytes, 'csv', 'text/csv');
      const sharedOther = await doc(a, 'IMPORT', sharedBytes, 'csv', 'text/csv');
      const pdf = await doc(
        a,
        'PDF',
        Buffer.from(`%PDF-tax-${randomUUID()}`),
        'pdf',
        'application/pdf',
      );
      expect(await retention.purgeFiles(later(6), 'export')).toBe(0);
      expect(await retention.purgeFiles(later(8), 'export')).toBe(2);
      for (const d of [exp, sharedExp]) {
        const now = await get(d.id);
        expect(now).toMatchObject({ status: 'PURGED', sha256: d.sha256, fileKey: d.fileKey });
        expect(now.purgedAt).not.toBeNull();
        expect(now.fileRemovedAt).not.toBeNull();
      }
      expect(existsSync(path(exp.fileKey!))).toBe(false);
      expect(existsSync(path(sharedExp.fileKey!))).toBe(true); // IMPORT ยังใช้
      expect(await get(sharedOther.id)).toMatchObject({ status: 'READY' });
      expect(await get(pdf.id)).toMatchObject({ status: 'READY' });
      expect(existsSync(path(pdf.fileKey!))).toBe(true);

      const s = signDocumentUrl('download', a, exp.id, 60);
      const id = encodeId('document', exp.id);
      expect(
        (await request(app.getHttpServer()).get(`/v1/documents/${id}/content?${s.query}`)).status,
      ).toBe(404);
      expect(
        await db.auditLog.findFirst({
          where: { tenantId: a, action: 'retention.purged', entityId: 'export_file' },
        }),
      ).toMatchObject({ after: { count: 2 } });
      // DB บังคับ: PURGED ต้องมี purged_at
      await expect(
        db.$executeRaw`UPDATE stored_document SET status = 'PURGED' WHERE id = ${pdf.id}::uuid`,
      ).rejects.toThrow(/stored_document_purged_check/);
    });

    it('ลบไฟล์ไม่สำเร็จ → ค้างไว้ทำรอบหน้า · ระหว่างนั้นมีแถวใหม่ใช้เนื้อเดียวกัน (putFileLocked) → ไฟล์ไม่หาย', async () => {
      const bytes = Buffer.from(`race-${randomUUID()}`);
      const exp = await doc(a, 'EXPORT', bytes, 'csv', 'text/csv');
      const proto = Object.getPrototypeOf(files()) as { remove: (k: string) => Promise<void> };
      const orig = proto.remove;
      proto.remove = () => Promise.reject(new Error('disk busy'));
      try {
        expect(await retention.purgeFiles(later(8), 'export')).toBe(1);
      } finally {
        proto.remove = orig;
      }
      expect(await get(exp.id)).toMatchObject({ status: 'PURGED', fileRemovedAt: null });
      expect(existsSync(path(exp.fileKey!))).toBe(true);
      // อัปโหลดใหม่เนื้อเดียวกัน (ผ่านล็อก key) ก่อนรอบหน้า → รอบหน้าไม่ลบไฟล์ แต่ปิดงานของแถวเดิม
      const again = await db.$transaction(async (tx) => {
        const f = await putFileLocked(tx, a, bytes, 'csv');
        return tx.storedDocument.create({
          data: {
            tenantId: a,
            kind: 'IMPORT',
            status: 'READY',
            mimeType: 'text/csv',
            sizeBytes: f.size,
            fileKey: f.key,
            sha256: f.sha256,
          },
        });
      });
      expect(await retention.removePurgedFiles(['EXPORT'])).toBe(0);
      expect(existsSync(path(again.fileKey!))).toBe(true);
      expect((await get(exp.id)).fileRemovedAt).not.toBeNull();
    });

    it('run() รวมทุกกลุ่ม · worker 2 ตัวพร้อมกัน → ตัวหนึ่งข้าม (null)', async () => {
      // worker อื่นถือล็อกอยู่ → ข้าม
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      const holder = db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(${0x7e7e}::int, 0)::text`;
          locked();
          await held;
        },
        { timeout: 30_000 },
      );
      await isLocked;
      expect(await retention.run(later(1))).toBeNull();
      release();
      await holder;
      expect(await retention.run(later(1))).toEqual({
        auditLog: 0,
        loginLog: 0,
        gpsLog: 0,
        podFiles: 0,
        exportFiles: 0,
        failed: [],
      });
    });

    it('run(): กลุ่มหนึ่ง error ไม่หยุดกลุ่มอื่น', async () => {
      const orig = retention.purgeLoginLog.bind(retention);
      retention.purgeLoginLog = () => Promise.reject(new Error('boom'));
      try {
        const r = await retention.run(later(1));
        expect(r).toMatchObject({ failed: ['loginLog'], exportFiles: 0 });
      } finally {
        retention.purgeLoginLog = orig;
      }
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
