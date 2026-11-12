import { ROLE_CODES } from '@tms/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrapSteps,
  bootstrapTenant,
  createTenantWithDefaults,
} from '../src/modules/tenants/bootstrap';
import { readSettings } from '../src/modules/settings/settings.service';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { platform, createTenant, truncateAll } from './helpers';
import { testEnv } from './env';

/** ST1-T20: สร้าง tenant ใหม่แล้วมีชุดเลขและค่าภาษี default ครบโดยไม่ต้องตั้ง (+ ประเภทรถ ST2-T04) */
describe('tenant bootstrap', () => {
  const db = platform();
  beforeAll(() => truncateAll());
  afterAll(() => db.$disconnect());

  it('tenant ใหม่: role ระบบครบ, ชุดเลข 11 ประเภท, ค่าภาษี/วางบิลเป็นแถวจริง', async () => {
    const t = await createTenantWithDefaults(db, { name: 'บริษัท ใหม่' });
    const roles = await db.role.findMany({ where: { tenantId: t.id } });
    expect(roles.map((r) => r.code).sort()).toEqual([...ROLE_CODES].sort());
    const series = await db.documentSeries.findMany({ where: { tenantId: t.id } });
    expect(series.map((s) => s.docType).sort()).toEqual(
      ['BN', 'CN', 'DN', 'DO', 'INV', 'RCP', 'SO', 'STL', 'TRIP', 'TXINV', 'WHT'].sort(),
    );
    const rows = await db.tenantSetting.findMany({ where: { tenantId: t.id } });
    expect(rows.map((r) => r.key)).toEqual(
      expect.arrayContaining([
        'tax.vatDefault',
        'tax.invoiceModePolicy',
        'tax.wht1Enabled',
        'tax.wht3Enabled',
        'billing.cycleDefault',
      ]),
    );
    const v = await readSettings(db, t.id, ['tax.vatDefault', 'tax.invoiceModePolicy']);
    expect(v).toEqual({ 'tax.vatDefault': 'VAT_7', 'tax.invoiceModePolicy': 'PER_CUSTOMER' });
    // ST2-T04: ประเภทรถภาษาไทยพร้อมใช้
    const types = await db.vehicleType.findMany({ where: { tenantId: t.id } });
    expect(types.map((x) => x.code).sort()).toEqual(['10W', '4W', '6W', 'REF6', 'TRC', 'TRL']);
  });

  it('รันซ้ำไม่ทับค่าที่ tenant แก้แล้ว', async () => {
    const t = await createTenantWithDefaults(db, { name: 'บริษัท แก้แล้ว' });
    await db.tenantSetting.update({
      where: { tenantId_key: { tenantId: t.id, key: 'tax.wht3Enabled' } },
      data: { value: false },
    });
    await db.documentSeries.update({
      where: { tenantId_docType: { tenantId: t.id, docType: 'SO' } },
      data: { prefix: 'MY-SO-' },
    });
    await bootstrapTenant(db, t.id);
    expect((await readSettings(db, t.id, ['tax.wht3Enabled']))['tax.wht3Enabled']).toBe(false);
    expect(
      (
        await db.documentSeries.findUniqueOrThrow({
          where: { tenantId_docType: { tenantId: t.id, docType: 'SO' } },
        })
      ).prefix,
    ).toBe('MY-SO-');
  });

  it('ขั้นไหนล้ม = ไม่มี tenant ครึ่ง ๆ (rollback ทั้งก้อน)', async () => {
    const steps = [
      ...bootstrapSteps(),
      { name: 'test-fail', run: async () => Promise.reject(new Error('boom')) },
    ];
    await expect(createTenantWithDefaults(db, { name: 'บริษัท ล้ม' }, steps)).rejects.toThrow(
      'boom',
    );
    expect(await db.tenant.count({ where: { name: 'บริษัท ล้ม' } })).toBe(0);
  });

  it('รายการขั้นครบและเรียงตามที่ตั้งใจ (เพิ่มขั้นใหม่ = แก้ test นี้ด้วย)', () => {
    expect(bootstrapSteps().map((s) => s.name)).toEqual([
      'system-roles',
      'document-series',
      'tax-billing-defaults',
      'vehicle-types',
      'units',
      'service-items',
    ]);
  });
  it('สคริปต์ tenants:bootstrap บนฐาน tms_test: tenant เดิม 2 รายได้ค่าเริ่มต้น + audit/event, รันซ้ำไม่เปลี่ยน', async () => {
    const a = (await createTenant(db)).id; // tenant เก่า (ก่อนมีขั้นใหม่)
    const b = (await createTenant(db)).id;
    const run = () =>
      execSync('pnpm -s tenants:bootstrap', {
        cwd: resolve(__dirname, '..'),
        env: { ...process.env, ...testEnv() },
        encoding: 'utf8',
      });
    expect(run()).toMatch(/tenant OK \([^:]+:\d+\/tms_test\)/);
    for (const t of [a, b]) {
      expect(await db.vehicleType.count({ where: { tenantId: t } })).toBe(6);
      expect(
        await db.tenantDefault.count({
          where: { tenantId: t, outcome: 'INSERTED', key: { startsWith: 'vehicle_type:' } },
        }),
      ).toBe(6);
      // ST2-T10: หน่วยนับ 9 หน่วย (ระบบ) + audit
      expect(await db.unit.count({ where: { tenantId: t, systemKey: { not: null } } })).toBe(9);
      expect(
        await db.auditLog.count({ where: { tenantId: t, action: 'unit.created', actorId: null } }),
      ).toBe(9);
      // ST2-T11: ค่าบริการเสริม 8 รายการ (ระบบ) + audit
      expect(await db.serviceItem.count({ where: { tenantId: t, systemKey: { not: null } } })).toBe(
        8,
      );
      expect(
        await db.auditLog.count({
          where: { tenantId: t, action: 'service_item.created', actorId: null },
        }),
      ).toBe(8);
      expect(
        await db.auditLog.count({
          where: { tenantId: t, action: 'vehicle_type.created', actorId: null },
        }),
      ).toBe(6);
      expect(
        await db.domainEvent.count({ where: { tenantId: t, type: 'vehicle_type.created' } }),
      ).toBe(6);
      expect(await db.role.count({ where: { tenantId: t, isSystem: true } })).toBe(
        ROLE_CODES.length,
      );
    }
    run();
    expect(await db.vehicleType.count({ where: { tenantId: a } })).toBe(6);
    expect(await db.serviceItem.count({ where: { tenantId: a } })).toBe(8);
    expect(
      await db.auditLog.count({ where: { tenantId: a, action: 'vehicle_type.created' } }),
    ).toBe(6);
  });

  it('ค่าเริ่มต้นที่เคยข้าม (ชนชื่อ) ไม่ถูกใส่ภายหลังแม้ต่อมาไม่ชนแล้ว (บันทึก SKIPPED)', async () => {
    const t = (await createTenant(db)).id;
    const mine = await db.vehicleType.create({
      data: { tenantId: t, code: 'MY6', nameTh: '6 ล้อ', vehicleClass: '6W' },
    });
    await bootstrapTenant(db, t);
    expect(
      await db.tenantDefault.findUnique({
        where: { tenantId_key: { tenantId: t, key: 'vehicle_type:th.6w' } },
      }),
    ).toMatchObject({ outcome: 'SKIPPED', detail: 'code_or_name_taken' });
    await db.vehicleType.update({ where: { id: mine.id }, data: { nameTh: 'หกล้อของเรา' } });
    await bootstrapTenant(db, t);
    expect(await db.vehicleType.count({ where: { tenantId: t, systemKey: 'th.6w' } })).toBe(0);
  });

  it('role กำหนดเองที่ใช้รหัสของ role ระบบ ไม่ถูกยึดมาทับ', async () => {
    const t = (await createTenant(db)).id;
    await db.role.create({
      data: {
        tenantId: t,
        code: 'viewer',
        nameTh: 'ผู้ดูของเรา',
        permissions: [],
        isSystem: false,
      },
    });
    const ids = await ensureSystemRoles(db, t);
    expect(ids.viewer).toBeUndefined();
    const r = await db.role.findUniqueOrThrow({
      where: { tenantId_code: { tenantId: t, code: 'viewer' } },
    });
    expect([r.nameTh, r.isSystem, r.permissions]).toEqual(['ผู้ดูของเรา', false, []]);
  });
});
